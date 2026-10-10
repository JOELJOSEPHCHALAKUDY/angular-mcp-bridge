import type { CallToolResult, Tool } from '@modelcontextprotocol/client';

/** Experimental WebMCP surface; intentionally separate from the MCP Apps iframe bridge. */
export type WebMcpToolResult = Pick<CallToolResult, 'content' | 'structuredContent' | 'isError'>;
export interface WebMcpToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations?: { readOnlyHint: boolean; debugging: true };
  execute(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<WebMcpToolResult>;
}
export interface WebMcpModelContext {
  registerTool(tool: WebMcpToolDescriptor, options: { signal: AbortSignal }): Promise<void> | void;
}
export interface WebMcpOptions {
  /** Registration is disabled until the user explicitly opts in. */
  enabled?: boolean;
  tools: readonly Tool[];
  callTool(name: string, input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<CallToolResult>;
  /** Supply an adapter for tests. null explicitly represents an unsupported browser. */
  modelContext?: WebMcpModelContext | null;
  /** The owning Angular component/session can cancel registration and in-flight calls. */
  signal?: AbortSignal;
}
export interface WebMcpRegistration {
  supported: boolean;
  readonly registered: readonly string[];
  /** Aborting the registration signal removes only this session's tools. */
  close(): void;
}

function browserModelContext(): WebMcpModelContext | undefined {
  if (typeof document === 'undefined') return undefined;
  try {
    const context = (document as Document & { modelContext?: WebMcpModelContext }).modelContext;
    return typeof context?.registerTool === 'function' ? context : undefined;
  } catch { return undefined; }
}
export function webMcpSupported(): boolean { return !!browserModelContext(); }

function publicTool(tool: Tool): boolean {
  const visibility = (tool._meta?.['ui'] as { visibility?: unknown } | undefined)?.visibility;
  return !Array.isArray(visibility) || visibility.includes('model');
}
function aborted(signal: AbortSignal): void { signal.throwIfAborted(); }
/** Stop waiting when registration is cancelled, even if a browser adapter never settles. */
function withCancellation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/**
 * Opt-in browser-agent access to model-visible server tools. The proposed
 * document.modelContext API owns discovery; the connected MCP client still
 * owns server validation and authorization. See https://webmachinelearning.github.io/webmcp/.
 */
export async function registerWebMcpTools(options: WebMcpOptions): Promise<WebMcpRegistration> {
  const modelContext = options.modelContext === undefined ? browserModelContext() : options.modelContext ?? undefined;
  const controller = new AbortController();
  const registered: string[] = [];
  const close = () => {
    controller.abort(new DOMException('WebMCP registration closed.', 'AbortError'));
    options.signal?.removeEventListener('abort', close);
  };
  const registration: WebMcpRegistration = { supported: !!modelContext, get registered() { return registered.slice(); }, close };
  if (!options.enabled || !modelContext) return registration;
  if (options.signal?.aborted) { close(); return registration; }
  options.signal?.addEventListener('abort', close, { once: true });
  const tools = options.tools.filter(publicTool);
  const names = new Set<string>();
  try {
    // Validate the complete set before registering, so duplicates do not leave a partial set.
    for (const tool of tools) {
      if (!tool.name.trim() || names.has(tool.name)) throw new Error(`Duplicate or empty WebMCP tool name: ${tool.name}`);
      names.add(tool.name);
    }
    for (const tool of tools) {
      aborted(controller.signal);
      const descriptor: WebMcpToolDescriptor = {
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description?.trim() || tool.title?.trim() || `Run ${tool.name} in the Angular MCP workbench.`,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.annotations?.readOnlyHint ?? false, debugging: true },
        async execute(input, execution = {}) {
          const signal = execution.signal ? AbortSignal.any([controller.signal, execution.signal]) : controller.signal;
          aborted(signal);
          const result = await withCancellation(options.callTool(tool.name, input, { signal }), signal);
          aborted(signal);
          // Private UI metadata must never be returned to a browser agent/model.
          return { content: result.content, ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }), ...(result.isError === undefined ? {} : { isError: result.isError }) };
        },
      };
      await withCancellation(Promise.resolve(modelContext.registerTool(descriptor, { signal: controller.signal })), controller.signal);
      aborted(controller.signal);
      registered.push(tool.name);
    }
    return registration;
  } catch (error) {
    close();
    throw error;
  }
}
