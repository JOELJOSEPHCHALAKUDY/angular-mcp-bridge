import { generateText, isStepCount, jsonSchema, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { createBridgeServer, type BridgeServerOptions, type BridgeRequestContext, type ToolHandlers, type ToolResponse } from '@angular-mcp-bridge/server';
import type { ToolInput, ToolParsedInput, ToolOutput, ToolRegistry } from '@angular-mcp-bridge/contracts';
import { publicResult } from './transcript.js';
export { chatMatchers, assertChat } from './matchers.js';
export type { MatcherResult, Judgment, JudgmentOptions, Verdict, ChatAssertions, ChatAssertion } from './matchers.js';
export { createEvaluationSuite } from './suite.js';
export type { EvaluationDefaults, EvaluationSuiteAdapter } from './suite.js';

export type ToolStubs<T extends ToolRegistry> = {
  [K in keyof T]?: ToolResponse<ToolOutput<T[K]>> | ((input: ToolParsedInput<T[K]>, context: BridgeRequestContext) => ToolResponse<ToolOutput<T[K]>> | undefined | Promise<ToolResponse<ToolOutput<T[K]>> | undefined>);
};

export interface EvaluationCall {
  name: string;
  input: Record<string, unknown>;
  result: CallToolResult;
  durationMs: number;
  callId: string;
  status: 'pending' | 'accepted' | 'failed';
  source: 'server' | 'stub' | 'override' | 'model-validation' | 'transport';
  failure?: string;
}
export interface EvaluationOptions<T extends ToolRegistry> {
  app: BridgeServerOptions<T>;
  /** Any AI SDK provider model, including a company gateway or local model. */
  model: LanguageModel;
  instructions?: string;
  maxSteps?: number;
  timeoutMs?: number;
  temperature?: number;
  /** Verified identity injection for in-process tests; does not test JWT verification. */
  context?: Parameters<typeof createBridgeServer>[1];
  /** Run inside the real server after authorization/input parsing and before output validation. */
  stubs?: ToolStubs<T>;
  /** Replace selected handlers; stubs returning undefined fall through to these replacements. */
  handlerOverrides?: Partial<ToolHandlers<T>>;
}
export interface EvaluationChat<T extends ToolRegistry> {
  readonly calls: readonly EvaluationCall[];
  readonly messages: readonly ModelMessage[];
  /** Every completed model step containing speech, including intermediate steps. */
  readonly assistantTurns: readonly string[];
  /** Final text for each successfully completed send(). */
  readonly replies: readonly string[];
  readonly acceptedCalls: readonly EvaluationCall[];
  readonly failedCalls: readonly EvaluationCall[];
  readonly toolContracts: T;
  send(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
  called<K extends keyof T & string>(name: K, input?: ToolInput<T[K]>): boolean;
  exportTranscript(): string;
  close(): Promise<void>;
}

/** Exercise real MCP tool registration and validation, with model-selected calls. */
export async function start<T extends ToolRegistry>(options: EvaluationOptions<T>): Promise<EvaluationChat<T>> {
  const maxSteps = options.maxSteps ?? 6;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new RangeError('maxSteps must be an integer between 1 and 100.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive and finite.');
  for (const name of [...Object.keys(options.stubs ?? {}), ...Object.keys(options.handlerOverrides ?? {})]) {
    if (!Object.hasOwn(options.app.tools, name)) throw new Error(`The evaluation app has no tool named ${name}.`);
  }
  const activeCalls = new Map<string, EvaluationCall>();
  const handlers = { ...options.app.handlers } as ToolHandlers<T>;
  for (const name of Object.keys(options.app.tools) as (keyof T & string)[]) {
    const original = options.handlerOverrides?.[name] ?? options.app.handlers[name];
    const stub = options.stubs?.[name];
    if (!original || (stub === undefined && !options.handlerOverrides?.[name])) continue;
    handlers[name] = async (input, context) => {
      const token = context.meta['angular-mcp-evaluation/call'];
      const call = typeof token === 'string' ? activeCalls.get(token) : undefined;
      if (stub !== undefined) {
        if (call) call.source = 'stub';
        // TypeScript cannot narrow a mapped generic union at its indexed key.
        const replacement = typeof stub === 'function'
          ? await (stub as (args: ToolParsedInput<T[typeof name]>, context: BridgeRequestContext) => ToolResponse<ToolOutput<T[typeof name]>> | undefined | Promise<ToolResponse<ToolOutput<T[typeof name]>> | undefined>)(input, context)
          : stub as ToolResponse<ToolOutput<T[typeof name]>>;
        if (replacement !== undefined) return replacement;
        if (call) call.source = 'server';
      }
      if (call && options.handlerOverrides?.[name]) call.source = 'override';
      return original(input, context);
    };
  }
  const server = await createBridgeServer({ ...options.app, handlers }, options.context);
  const client = new Client({ name: 'angular-mcp-evaluation', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try { await server.connect(serverTransport); await client.connect(clientTransport); }
  catch (error) { await client.close(); await server.close(); throw error; }
  const calls: EvaluationCall[] = [];
  const messages: ModelMessage[] = [];
  const replies: string[] = [];
  const assistantTurns: string[] = [];
  const controller = new AbortController();
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let turnSequence = 0;
  let turnCalls = new Map<string, EvaluationCall>();
  let turnStart = 0;
  let orderedIds: string[] = [];
  const failureResult = (reason: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: reason }] });
  const modelTools: ToolSet = {};
  let descriptors: Awaited<ReturnType<typeof client.listTools>>;
  try { descriptors = await client.listTools(); }
  catch (error) { await client.close(); await server.close(); throw error; }
  for (const descriptor of descriptors.tools) {
    const visibility = (descriptor._meta?.['ui'] as { visibility?: string[] } | undefined)?.visibility;
    if (visibility && !visibility.includes('model')) continue;
    modelTools[descriptor.name] = tool({
      description: descriptor.description,
      inputSchema: jsonSchema<Record<string, unknown>>(descriptor.inputSchema),
      execute: async (input, execution) => {
        const began = performance.now();
        const token = `${turnSequence}:${execution.toolCallId}`;
        const call: EvaluationCall = { name: descriptor.name, input, result: { content: [] }, durationMs: 0, callId: token, status: 'pending', source: 'server' };
        calls.push(call); turnCalls.set(execution.toolCallId, call); activeCalls.set(token, call);
        let result: CallToolResult;
        try {
          result = await client.callTool({ name: descriptor.name, arguments: input, _meta: { 'angular-mcp-evaluation/call': token } }, { signal: execution.abortSignal }) as CallToolResult;
          call.result = result;
          call.status = result.isError ? 'failed' : 'accepted';
          if (result.isError) call.failure = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'The tool returned an error.';
        } catch (error) {
          call.status = 'failed'; call.source = 'transport'; call.failure = error instanceof Error ? error.message : String(error);
          call.result = failureResult(call.failure); throw error;
        } finally { call.durationMs = performance.now() - began; activeCalls.delete(token); }
        // _meta is private UI data. It must never enter the model transcript.
        return publicResult(result);
      },
    });
  }
  return {
    get calls() { return calls.slice(); }, get messages() { return messages.slice(); }, get replies() { return replies.slice(); },
    get assistantTurns() { return assistantTurns.slice(); },
    get acceptedCalls() { return calls.filter(call => call.status === 'accepted'); },
    get failedCalls() { return calls.filter(call => call.status === 'failed'); },
    toolContracts: options.app.tools,
    send(prompt, sendOptions) {
      const run = async () => {
        if (closed) throw new Error('The evaluation session is closed.');
        if (!prompt.trim()) throw new Error('An evaluation prompt is required.');
        turnSequence++; turnCalls = new Map(); turnStart = calls.length; orderedIds = [];
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(sendOptions?.signal ? [sendOptions.signal] : [])]);
        const candidate: ModelMessage[] = [...messages, { role: 'user', content: prompt }];
        const result = await generateText({ model: options.model, messages: candidate, instructions: options.instructions,
          tools: modelTools, stopWhen: isStepCount(maxSteps), abortSignal: signal, maxRetries: 0,
          onStepEnd(step) {
            if (step.text) assistantTurns.push(step.text);
            for (const requested of step.toolCalls) {
              const id = requested.toolCallId;
              if (!turnCalls.has(id)) {
                const reason = requested.invalid ? String(requested.error instanceof Error ? requested.error.message : requested.error ?? 'The model call failed validation.') : 'The model call did not execute against MCP.';
                const input = requested.input && typeof requested.input === 'object' && !Array.isArray(requested.input) ? requested.input as Record<string, unknown> : { invalidInput: requested.input };
                const rejected: EvaluationCall = { name: requested.toolName, input, result: failureResult(reason), durationMs: 0, callId: `${turnSequence}:${id}`, status: 'failed', source: 'model-validation', failure: reason };
                turnCalls.set(id, rejected);
              }
              if (!orderedIds.includes(id)) orderedIds.push(id);
            }
            // Invocation order, including invalid calls, is independent of parallel completion times.
            calls.splice(turnStart, calls.length - turnStart, ...orderedIds.map(id => turnCalls.get(id)!));
          },
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        });
        messages.push({ role: 'user', content: prompt }, ...result.response.messages);
        replies.push(result.text);
        return result.text;
      };
      const task = queue.then(run, run); queue = task.catch(() => {}); return task;
    },
    called(name, input) { return calls.some(call => call.status === 'accepted' && call.name === name && (input === undefined || matches(call.input, input))); },
    exportTranscript() {
      return JSON.stringify({ version: 2, replies, assistantTurns, messages, calls: calls.map(({ name, input, result, durationMs, callId, status, source, failure }) => ({ name, input, durationMs, callId, status, source, failure,
        result: publicResult(result),
      })) }, null, 2);
    },
    async close() { if (closed) return; closed = true; controller.abort(); await queue; await client.close(); await server.close(); },
  };
}

function matches(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) => matches(actual[i], value));
  if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value));
  return false;
}
