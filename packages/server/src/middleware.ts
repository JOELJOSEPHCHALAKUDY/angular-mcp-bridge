import type { JSONRPCRequest, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface MiddlewareRequest { method: string; params: Record<string, unknown>; notification: boolean }
export type McpMiddleware = (request: MiddlewareRequest, context: ServerContext | undefined, next: () => Promise<unknown>) => unknown | Promise<unknown>;
export interface MiddlewareEntry { filter?: string | string[]; handle: McpMiddleware }
export interface TelemetryEvent { method: string; durationMs: number; status: 'succeeded' | 'failed'; toolName?: string; error?: unknown }
export type TelemetryObserver = (event: TelemetryEvent) => void;
const caughtErrors = new WeakMap<ServerContext, unknown>();
export const getToolError = (context: ServerContext | undefined): unknown => context && caughtErrors.get(context);
export function captureToolError(context: ServerContext, error: unknown): void { caughtErrors.set(context, error); }
export function matchesMiddleware(method: string, filter: string | string[] | undefined, notification = false): boolean {
  return filter === undefined || [filter].flat().some(pattern => pattern === '*' || pattern === (notification ? 'notification' : 'request') || pattern === method || pattern.endsWith('/*') && method.startsWith(pattern.slice(0, -1)));
}
export async function runMiddleware(entries: readonly MiddlewareEntry[], request: MiddlewareRequest, context: ServerContext | undefined, terminal: () => Promise<unknown>): Promise<unknown> {
  const chain = entries.filter(entry => matchesMiddleware(request.method, entry.filter, request.notification));
  const invoke = async (index: number): Promise<unknown> => {
    const entry = chain[index]; if (!entry) return terminal();
    let invoked = false;
    return entry.handle(request, context, () => { if (invoked) throw new Error('Middleware next() may only be called once.'); invoked = true; return invoke(index + 1); });
  };
  return invoke(0);
}
/** Wrap public registration APIs, avoiding SDK private handler maps. Install before registering application handlers. */
export function installMiddleware(server: McpServer, entries: readonly MiddlewareEntry[] = [], observer?: TelemetryObserver): void {
  if (!entries.length && !observer) return;
  const protocol = server.server;
  const observe = async (request: MiddlewareRequest, context: ServerContext | undefined, terminal: () => Promise<unknown>) => {
    const started = performance.now(); let failure: unknown, errorResult = false;
    try { const result = await runMiddleware(entries, request, context, terminal); errorResult = !!(result && typeof result === 'object' && 'isError' in result && result.isError); return result; } catch (error) { failure = error; throw error; }
    finally {
      failure ??= getToolError(context);
      const event: TelemetryEvent = { method: request.method, durationMs: performance.now() - started, status: failure || errorResult ? 'failed' : 'succeeded', ...(typeof request.params['name'] === 'string' ? { toolName: request.params['name'] } : {}), ...(failure ? { error: failure } : {}) };
      try { observer?.(event); } catch { /* Instrumentation cannot break a protocol response. */ }
    }
  };
  const register = protocol.setRequestHandler.bind(protocol);
  // Both official overloads remain available to callers. Custom-method handlers receive parsed params.
  protocol.setRequestHandler = ((method: string, ...args: unknown[]) => {
    const custom = args.length === 2;
    const handler = args[custom ? 1 : 0] as (request: unknown, context: ServerContext) => unknown;
    const wrapped = async (incoming: JSONRPCRequest | Record<string, unknown>, context: ServerContext) => {
      const params = custom ? incoming as Record<string, unknown> : (incoming as JSONRPCRequest).params ?? {};
      const request = { method, params, notification: false };
      return observe(request, context, async () => handler(custom ? request.params : { ...incoming, params: request.params }, context));
    };
    if (custom) (register as Function)(method, args[0], wrapped); else (register as Function)(method, wrapped);
  }) as typeof protocol.setRequestHandler;
  const registerNotification = protocol.setNotificationHandler.bind(protocol);
  protocol.setNotificationHandler = ((method: string, ...args: unknown[]) => {
    const custom = args.length === 2;
    const handler = args[custom ? 1 : 0] as (notification: unknown, rawNotification?: unknown) => unknown;
    const wrapped = (incoming: { params?: Record<string, unknown> } | Record<string, unknown>, rawNotification?: unknown) => {
      const request = { method, params: custom ? incoming as Record<string, unknown> : (incoming as { params?: Record<string, unknown> }).params ?? {}, notification: true };
      return observe(request, undefined, async () => handler(custom ? request.params : { ...incoming, params: request.params }, rawNotification));
    };
    if (custom) (registerNotification as Function)(method, args[0], wrapped); else (registerNotification as Function)(method, wrapped);
  }) as typeof protocol.setNotificationHandler;
}
