import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';
import type { ChatGptExtensions } from './extensions.js';
import type { BridgeTransport, DisplayMode, HostCapabilities, HostContext, ModelContextParams, ToolResult } from './transport.js';

/** The older Apps SDK host surface is independent of the standard postMessage handshake. */
export interface LegacyAppsSdkHost extends ChatGptExtensions {
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  requestDisplayMode?: (args: { mode: DisplayMode }) => Promise<{ mode: DisplayMode }>;
  theme?: unknown; locale?: unknown; displayMode?: unknown; maxHeight?: unknown;
  userAgent?: unknown; safeArea?: unknown; toolInput?: unknown; toolOutput?: unknown; toolResponseMetadata?: unknown;
}
export function isLegacyAppsSdkHost(value: unknown = typeof window === 'undefined' ? undefined : (window as Window & { openai?: unknown }).openai): value is LegacyAppsSdkHost {
  return !!value && typeof value === 'object' && typeof (value as { callTool?: unknown }).callTool === 'function';
}
export class LegacyTransportError extends Error {
  constructor(message: string, readonly code: 'closed' | 'unsupported' | 'invalid-host-data' | 'aborted' | 'timeout', options?: ErrorOptions) {
    super(message, options); this.name = 'LegacyTransportError';
  }
}
const record = z.record(z.string(), z.unknown());
const modeSchema = z.enum(['inline', 'fullscreen', 'pip']);
const globalsSchema = z.object({
  theme: z.enum(['light', 'dark']).optional(), locale: z.string().min(1).max(256).optional(),
  displayMode: z.enum(['inline', 'fullscreen', 'pip', 'modal']).optional(), maxHeight: z.number().finite().nonnegative().optional(),
  userAgent: z.object({ device: z.object({ type: z.enum(['desktop', 'mobile', 'tablet', 'unknown']) }).optional(), capabilities: z.object({ hover: z.boolean().optional(), touch: z.boolean().optional() }).optional() }).optional(),
  safeArea: z.object({ insets: z.object({ top: z.number().finite().nonnegative(), bottom: z.number().finite().nonnegative(), left: z.number().finite().nonnegative(), right: z.number().finite().nonnegative() }) }).optional(),
  toolInput: record.nullable().optional(), toolOutput: record.nullable().optional(), toolResponseMetadata: record.nullable().optional(),
});
type Globals = z.infer<typeof globalsSchema>;
interface WidgetCoordinator { observed: unknown; value: Record<string, unknown>; writes: Promise<void> }
const widgetCoordinators = new WeakMap<ChatGptExtensions, WidgetCoordinator>();
function widgetCoordinator(host: ChatGptExtensions): WidgetCoordinator {
  let coordinator = widgetCoordinators.get(host);
  if (!coordinator) {
    coordinator = { observed: host.widgetState, value: record.safeParse(host.widgetState).data ?? {}, writes: Promise.resolve() };
    widgetCoordinators.set(host, coordinator);
  }
  if (coordinator.observed !== host.widgetState) { coordinator.observed = host.widgetState; coordinator.value = record.safeParse(host.widgetState).data ?? {}; }
  return coordinator;
}
/** Shared with Angular's private state/file writes when host globals acknowledgements are delayed. */
export function readLegacyWidgetState(host: ChatGptExtensions): Record<string, unknown> { return widgetCoordinator(host).value; }
export function updateLegacyWidgetState(host: ChatGptExtensions, updater: (previous: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  if (!host.setWidgetState) return Promise.reject(new LegacyTransportError('The Apps SDK host does not provide widget-state persistence.', 'unsupported'));
  const coordinator = widgetCoordinator(host);
  const pending = coordinator.writes.catch(() => {}).then(async () => {
    const next = record.parse(updater(readLegacyWidgetState(host))); await host.setWidgetState!(next);
    coordinator.observed = host.widgetState; coordinator.value = next;
  });
  coordinator.writes = pending; return pending;
}

/** Angular owns this adapter's lifetime; it advertises only methods the host actually supplies. */
export class LegacyAppsSdkTransport implements BridgeTransport {
  ontoolinput: BridgeTransport['ontoolinput']; ontoolinputpartial: BridgeTransport['ontoolinputpartial']; ontoolresult: BridgeTransport['ontoolresult'];
  ontoolcancelled: BridgeTransport['ontoolcancelled']; onhostcontextchanged: BridgeTransport['onhostcontextchanged'];
  onteardown: BridgeTransport['onteardown']; onerror: BridgeTransport['onerror']; onclose: BridgeTransport['onclose'];
  readonly requestTeardown?: BridgeTransport['requestTeardown'];
  private connected = false;
  private closed = false;
  private globals: Globals = {};
  private readonly operations = new Set<AbortController>();
  private readonly globalsListener = (event: Event) => {
    if (!this.connected || this.closed) return;
    const detail = (event as CustomEvent<{ globals?: unknown }>).detail;
    if (detail && detail.globals !== undefined) this.acceptGlobals(detail.globals);
  };
  constructor(private readonly host: LegacyAppsSdkHost, private readonly events: Pick<Window, 'addEventListener' | 'removeEventListener'> = window) {
    if (!isLegacyAppsSdkHost(host)) throw new LegacyTransportError('A usable Apps SDK callTool host is required.', 'unsupported');
    if (host.requestClose) this.requestTeardown = async () => { await this.operation(() => host.requestClose!()); };
  }
  async connect(): Promise<void> {
    if (this.closed) throw new LegacyTransportError('The Apps SDK transport has been closed.', 'closed');
    if (this.connected) return;
    this.connected = true; this.events.addEventListener('openai:set_globals', this.globalsListener);
    const initial = Object.fromEntries(Object.keys(globalsSchema.shape).filter(key => (this.host as unknown as Record<string, unknown>)[key] !== undefined).map(key => [key, (this.host as unknown as Record<string, unknown>)[key]]));
    this.acceptGlobals(initial);
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.connected = false;
    this.events.removeEventListener('openai:set_globals', this.globalsListener);
    for (const controller of this.operations) controller.abort(new LegacyTransportError('The Apps SDK transport was closed.', 'closed'));
    this.operations.clear(); this.onclose?.();
  }
  getHostVersion() { return { name: 'chatgpt', version: 'apps-sdk' }; }
  getHostCapabilities(): HostCapabilities {
    return { serverTools: {}, ...(this.host.sendFollowUpMessage ? { message: { text: {} } } : {}), ...(this.host.setWidgetState ? { updateModelContext: {} } : {}), ...(this.host.openExternal ? { openLinks: {} } : {}) };
  }
  getHostContext(): HostContext {
    const globals = this.globals;
    return { theme: globals.theme ?? 'light', locale: globals.locale ?? 'en-US', displayMode: globals.displayMode === 'modal' ? 'inline' : globals.displayMode ?? 'inline',
      availableDisplayModes: this.host.requestDisplayMode ? ['inline', 'fullscreen', 'pip'] : ['inline'],
      platform: globals.userAgent?.device?.type === 'mobile' || globals.userAgent?.device?.type === 'tablet' ? 'mobile' : 'web',
      ...(globals.userAgent?.capabilities ? { deviceCapabilities: globals.userAgent.capabilities } : {}),
      ...(globals.safeArea ? { safeAreaInsets: globals.safeArea.insets } : {}), ...(globals.maxHeight !== undefined ? { containerDimensions: { maxHeight: globals.maxHeight } } : {}) };
  }
  private acceptGlobals(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { this.onerror?.(new LegacyTransportError('The Apps SDK host sent invalid globals.', 'invalid-host-data')); return; }
    const changes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(globalsSchema.shape)) {
      if (!Object.hasOwn(value, name)) continue;
      const parsed = schema.safeParse((value as Record<string, unknown>)[name]);
      if (parsed.success) changes[name] = parsed.data;
      else this.onerror?.(new LegacyTransportError(`The Apps SDK host sent invalid ${name}.`, 'invalid-host-data'));
    }
    this.globals = { ...this.globals, ...changes };
    this.onhostcontextchanged?.(this.getHostContext());
    if (Object.hasOwn(changes, 'toolInput')) this.ontoolinput?.({ arguments: this.globals.toolInput ?? {} });
    else if (changes['toolOutput'] === null) this.ontoolinput?.({ arguments: this.globals.toolInput ?? {} });
    if ((Object.hasOwn(changes, 'toolOutput') || Object.hasOwn(changes, 'toolResponseMetadata')) && this.globals.toolOutput) {
      this.ontoolresult?.({ content: [], structuredContent: this.globals.toolOutput, ...(this.globals.toolResponseMetadata ? { _meta: this.globals.toolResponseMetadata } : {}) });
    }
  }
  callServerTool: BridgeTransport['callServerTool'] = async (params, options) => {
    const response = await this.operation(() => this.host.callTool(params.name, params.arguments ?? {}), options);
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new LegacyTransportError('The Apps SDK host returned an invalid tool result.', 'invalid-host-data');
    const raw = response as Record<string, unknown>;
    const parsed = CallToolResultSchema.safeParse({ content: [], ...raw, ...(raw['_meta'] === undefined && raw['meta'] !== undefined ? { _meta: raw['meta'] } : {}) });
    if (!parsed.success) throw new LegacyTransportError('The Apps SDK host returned an invalid tool result.', 'invalid-host-data', { cause: parsed.error });
    return parsed.data as ToolResult;
  };
  sendMessage: BridgeTransport['sendMessage'] = async (params, options) => {
    const meta = (params as typeof params & { _meta?: Record<string, unknown> })._meta;
    if (!this.host.sendFollowUpMessage || params.role !== 'user' || params.content.some(item => item.type !== 'text') || meta?.['openai/message']) throw new LegacyTransportError('The Apps SDK host supports text follow-up messages in the current conversation only.', 'unsupported');
    await this.operation(() => this.host.sendFollowUpMessage!({ prompt: params.content.map(item => item.type === 'text' ? item.text : '').join('\n') }), options); return {};
  };
  updateModelContext: BridgeTransport['updateModelContext'] = async (params: ModelContextParams, options) => {
    await this.operation(() => updateLegacyWidgetState(this.host, previous => ({ ...previous, modelContent: { ...(params.structuredContent ? { structuredContent: params.structuredContent } : {}), ...(params.content ? { content: params.content } : {}) } })), options); return {};
  };
  requestDisplayMode: BridgeTransport['requestDisplayMode'] = async (params, options) => {
    if (!this.host.requestDisplayMode) throw new LegacyTransportError('The Apps SDK host does not provide display-mode requests.', 'unsupported');
    const response = await this.operation(() => this.host.requestDisplayMode!(params), options); const parsed = z.object({ mode: modeSchema }).safeParse(response);
    if (!parsed.success) throw new LegacyTransportError('The Apps SDK host returned an invalid display mode.', 'invalid-host-data');
    this.globals.displayMode = parsed.data.mode; this.onhostcontextchanged?.(this.getHostContext()); return parsed.data;
  };
  openLink: BridgeTransport['openLink'] = async (params, options) => {
    if (!this.host.openExternal) throw new LegacyTransportError('The Apps SDK host does not provide external links.', 'unsupported');
    const url = new URL(params.url); if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('Only HTTP(S) links are supported.');
    await this.operation(async () => { this.host.openExternal!({ href: url.href }); }, options); return {};
  };
  private async operation<T>(run: () => Promise<T>, options?: Parameters<BridgeTransport['callServerTool']>[1]): Promise<T> {
    if (this.closed || !this.connected) throw new LegacyTransportError('The Apps SDK transport is disconnected.', 'closed');
    if (options?.signal?.aborted) throw new LegacyTransportError('The Apps SDK request was aborted.', 'aborted', { cause: options.signal.reason });
    if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) throw new RangeError('timeout must be positive and finite.');
    const controller = new AbortController(); this.operations.add(controller);
    const abort = () => controller.abort(new LegacyTransportError('The Apps SDK request was aborted.', 'aborted', { cause: options?.signal?.reason }));
    options?.signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_, reject) => { controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }); });
    if (options?.timeout !== undefined) timer = setTimeout(() => controller.abort(new LegacyTransportError('The Apps SDK request timed out.', 'timeout')), options.timeout);
    try { return await Promise.race([Promise.resolve().then(() => { if (controller.signal.aborted) throw controller.signal.reason; return run(); }), cancelled]); }
    finally { clearTimeout(timer); options?.signal?.removeEventListener('abort', abort); this.operations.delete(controller); }
  }
}
