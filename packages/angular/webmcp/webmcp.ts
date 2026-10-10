import { isPlatformBrowser } from '@angular/common';
import { declareExperimentalWebMcpTool, DestroyRef, inject, Injector, makeEnvironmentProviders, PLATFORM_ID, provideEnvironmentInitializer, runInInjectionContext, signal, type EnvironmentProviders, type Signal, type WebMcpClient } from '@angular/core';
import { z } from 'zod';
import type { ToolDefinition, ToolInput, ToolOutput, ToolParsedInput, ToolRegistry } from '@angular-mcp-bridge/contracts';
import { McpBridge, type ToolResult } from '@angular-mcp-bridge/angular';

export type WebMcpStatus = 'disabled' | 'unsupported' | 'registering' | 'ready' | 'error' | 'closed';
export interface WebMcpOptions {
  /** No tools are registered without explicit enabled: true. */
  enabled?: boolean;
  untrustedContentHint?: boolean;
  onError?: (error: Error) => void;
}
export interface WebMcpRegistration {
  readonly status: Signal<WebMcpStatus>;
  readonly error: Signal<Error | null>;
  /** Resolves false for disabled/unsupported/failed/destroyed registration. */
  readonly ready: Promise<boolean>;
  dispose(): void;
}
export type WebMcpHandler<T extends ToolDefinition> = (input: ToolParsedInput<T>, client: WebMcpClient) => ToolOutput<T> | Promise<ToolOutput<T>>;
export type WebMcpHandlers<T extends ToolRegistry> = { [K in keyof T]: WebMcpHandler<T[K]> };

/** Browser-agent WebMCP support. This does not describe the iframe MCP Apps host. */
export function isWebMcpAvailable(): boolean {
  const context = (typeof document === 'undefined' ? undefined : (document as Document & { modelContext?: { registerTool?: unknown } }).modelContext)
    ?? (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { modelContext?: { registerTool?: unknown } }).modelContext);
  return typeof context?.registerTool === 'function';
}
type NativeTool = Parameters<typeof declareExperimentalWebMcpTool>[0];
type VisibleResult = Pick<ToolResult, 'content' | 'structuredContent'>;
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', stop); }
}
function registration<T extends ToolDefinition>(name: string, definition: T,
  execute: (wire: ToolInput<T>, parsed: ToolParsedInput<T>, client: WebMcpClient) => Promise<VisibleResult>, options: WebMcpOptions): WebMcpRegistration {
  const parent = inject(Injector), destroyRef = inject(DestroyRef), browser = isPlatformBrowser(inject(PLATFORM_ID));
  const state = signal<WebMcpStatus>(!options.enabled ? 'disabled' : !browser || !isWebMcpAvailable() ? 'unsupported' : 'registering');
  const error = signal<Error | null>(null);
  const lifetime = new AbortController();
  let scope: ReturnType<typeof Injector.create> | undefined, disposed = false;
  const destroyScope = () => { const current = scope; scope = undefined; current?.destroy(); };
  const dispose = () => {
    if (disposed) return;
    disposed = true; lifetime.abort(new DOMException('WebMCP registration closed.', 'AbortError'));
    destroyScope(); state.set('closed');
  };
  destroyRef.onDestroy(dispose);
  const ready = (async () => {
    if (state() !== 'registering') return false;
    try {
      if (!name.trim()) throw new Error('A WebMCP tool needs a non-empty name.');
      if (definition.visibility && !definition.visibility.includes('model')) throw new Error('An app-only MCP tool cannot be exposed to a browser agent.');
      // Input JSON Schema preserves Zod transforms/defaults as wire contracts.
      const inputSchema = z.toJSONSchema(definition.input, { io: 'input' }) as NativeTool['inputSchema'];
      scope = Injector.create({ providers: [], parent });
      await abortable(declareExperimentalWebMcpTool({
        name, description: definition.description, inputSchema,
        annotations: { readOnlyHint: definition.annotations.readOnlyHint,
          consequentialHint: !definition.annotations.readOnlyHint, ...(options.untrustedContentHint === undefined ? {} : { untrustedContentHint: options.untrustedContentHint }) },
        execute: async (args, client) => {
          client.signal.throwIfAborted();
          const wire = structuredClone(args) as ToolInput<T>;
          const parsed = await abortable(definition.input.parseAsync(wire), client.signal) as ToolParsedInput<T>;
          client.signal.throwIfAborted();
          // Schema validation is async, so re-enter DI before invoking user code.
          const response = await abortable(runInInjectionContext(scope!, () => execute(wire, parsed, client)), client.signal);
          client.signal.throwIfAborted();
          return response;
        },
      }, scope), lifetime.signal);
      if (disposed) return false;
      state.set('ready'); return true;
    } catch (cause) {
      if (disposed) return false;
      destroyScope();
      const failure = cause instanceof Error ? cause : new Error(String(cause)); error.set(failure); state.set('error');
      try { options.onError?.(failure); } catch { /* Reporting cannot break Angular initialization. */ }
      return false;
    }
  })();
  return { status: state.asReadonly(), error: error.asReadonly(), ready, dispose };
}

/** Validate a shared contract and execute a local browser tool in Angular's native DI context. */
export function declareWebMcpTool<T extends ToolDefinition>(name: string, definition: T, handler: WebMcpHandler<T>, options: WebMcpOptions = {}): WebMcpRegistration {
  return registration(name, definition, async (_wire, parsed, client) => {
    const data = await definition.output.parseAsync(await handler(parsed, client)) as ToolOutput<T>;
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  }, options);
}
/** Expose a server tool to the browser agent while retaining server authorization and wire input. */
export function injectWebMcpTool<T extends ToolDefinition>(name: string, definition: T, options: WebMcpOptions & { timeoutMs?: number } = {}): WebMcpRegistration {
  const bridge = inject(McpBridge);
  return registration(name, definition, async (wire, _parsed, client) => {
    const result = await bridge.callTool(name, wire as Record<string, unknown>, { signal: client.signal, timeoutMs: options.timeoutMs });
    if (result.isError) throw new Error('The server rejected the WebMCP tool call.');
    const data = await definition.output.parseAsync(result.structuredContent) as ToolOutput<T>;
    // Widget-private metadata must not become browser-agent output.
    return { content: result.content, structuredContent: data };
  }, options);
}
/** Register an explicitly selected local contract registry for an application/route injector. */
export function provideWebMcpTools<const T extends ToolRegistry>(tools: T, handlers: WebMcpHandlers<T>, options: WebMcpOptions = {}): EnvironmentProviders {
  return makeEnvironmentProviders([provideEnvironmentInitializer(() => {
    for (const [name, definition] of Object.entries(tools)) {
      declareWebMcpTool(name, definition, handlers[name], options);
    }
  })]);
}
