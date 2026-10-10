import { fromJsonSchema, inputRequired, type ElicitResult, type InputRequiredResult, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

export interface FormField {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string; description?: string;
  [key: string]: unknown;
}
export interface OpenAIForm { type: 'object'; properties: Record<string, FormField>; required?: string[]; additionalProperties?: boolean }
export interface FormInputOptions<S extends z.ZodObject> {
  key: string; message: string; schema: S; requestState?: string;
}
export interface OpenAIFormInputOptions {
  key: string; message: string; requestedSchema: OpenAIForm; requestState?: string; meta?: Record<string, unknown>;
}
export type FormAnswer<T> = { action: 'accept'; content: T } | { action: 'cancel' | 'decline' };
function answer(ctx: Pick<ServerContext, 'mcpReq'>, key: string): unknown {
  if (!key.trim()) throw new Error('A stable non-empty form key is required.');
  return Object.hasOwn(ctx.mcpReq.inputResponses ?? {}, key) ? ctx.mcpReq.inputResponses![key] : undefined;
}
function readAnswer<T>(raw: unknown, validate: (value: unknown) => T): FormAnswer<T> {
  if (!raw || typeof raw !== 'object' || !('action' in raw)) throw new Error('Form response has no valid action.');
  if (raw.action === 'cancel' || raw.action === 'decline') return { action: raw.action };
  if (raw.action !== 'accept' || !('content' in raw)) throw new Error('Form response has no valid action.');
  return { action: 'accept', content: validate(raw.content) };
}
/** Standard MCP form elicitation. One implementation works through the SDK's legacy shim and modern retry flow. */
export function requestFormInput<S extends z.ZodObject>(ctx: Pick<ServerContext, 'mcpReq'>, options: FormInputOptions<S>): InputRequiredResult | FormAnswer<z.output<S>> {
  const raw = answer(ctx, options.key);
  if (raw !== undefined) return readAnswer(raw, value => options.schema.parse(value));
  return inputRequired({ inputRequests: { [options.key]: inputRequired.elicit({ message: options.message, requestedSchema: options.schema }) }, ...(options.requestState ? { requestState: options.requestState } : {}) });
}
/** Rich OpenAI forms are feature gated, and echoed responses are validated before use. */
export async function requestOpenAIFormInput(ctx: Pick<ServerContext, 'mcpReq'>, options: OpenAIFormInputOptions): Promise<InputRequiredResult | FormAnswer<Record<string, unknown>>> {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.['io.modelcontextprotocol/clientCapabilities'] as { elicitation?: { form?: object }; extensions?: { 'openai/elicitation'?: { form?: object } } } | undefined;
  if (typeof envelope?.['io.modelcontextprotocol/protocolVersion'] !== 'string' || envelope['io.modelcontextprotocol/protocolVersion'] < '2026-07-28' || !capabilities?.elicitation?.form || !capabilities.extensions?.['openai/elicitation']?.form) throw new Error('The client does not advertise OpenAI form elicitation support.');
  const raw = answer(ctx, options.key);
  if (raw !== undefined) {
    const base = readAnswer(raw, value => value);
    if (base.action !== 'accept') return base;
    const validated = await fromJsonSchema<Record<string, unknown>>(options.requestedSchema)['~standard'].validate(base.content);
    if (validated.issues) throw new Error('The form response does not match the requested schema.');
    for (const [name, field] of Object.entries(options.requestedSchema.properties)) {
      const input = field['x-openai-input'] as { selection?: string; userOptions?: unknown; options?: { uri: string }[] } | undefined;
      if (input && input.selection !== 'implicit' && input.userOptions === undefined && validated.value[name] !== undefined) {
        if (![validated.value[name]].flat().every(uri => input.options?.some(option => option.uri === uri))) throw new Error('The form selected a resource that was not offered.');
      }
    }
    return { action: 'accept', content: validated.value };
  }
  return inputRequired({ inputRequests: { [options.key]: { method: 'elicitation/create', params: { mode: 'form', message: options.message,
    requestedSchema: { type: 'object', properties: {} }, _meta: { ...options.meta, 'openai/elicitation': { requestedSchema: options.requestedSchema } } } } }, ...(options.requestState ? { requestState: options.requestState } : {}) });
}
export type { ElicitResult };
