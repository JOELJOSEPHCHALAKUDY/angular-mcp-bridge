import {
  computed, DestroyRef, EnvironmentProviders, inject, Injectable, InjectionToken,
  makeEnvironmentProviders, PLATFORM_ID, provideAppInitializer, signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ResultSchema, ContentBlockSchema, ToolAnnotationsSchema, ListResourceTemplatesResultSchema } from '@modelcontextprotocol/core';
import type { AppToolCallback, AppToolResult } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import { BridgeOptions, BridgeTransport, createTransport, DisplayMode, HostCapabilities, HostContext, ToolResult, MessageContent, ModelContextParams, DownloadParams, SizeParams } from './transport.js';
import { CHATGPT_EXTENSIONS, LOCAL_MODAL_ENABLED, type ChatGptExtensions, type FileMetadata, type UploadFileOptions, type FollowUpOptions, type OpenExternalOptions, type ModalOptions, type FileResource, type FileResourceContent, type FileWriteResult, type ResourceRepresentation } from './extensions.js';
import { McpViewContext, VIEW_CONTEXT_BRIDGE } from './data-llm.js';
import { isLegacyAppsSdkHost, readLegacyWidgetState, updateLegacyWidgetState } from './legacy-transport.js';
import { checkContextBudget, CONTEXT_WARNING_DEFAULTS, type ContextDiagnosticsOptions, type ContextWarning } from './context-budget.js';
import { createReadCacheKey } from './read-cache.js';

interface ContextVersion<T> { value: T; previous?: ContextVersion<T>; failed?: boolean; }
interface ContextWaiter { resolve: (id: string | undefined) => void; reject: (error: unknown) => void; }

const writeResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.enum(['saved', 'conflict']), etag: z.string() }),
  z.object({ outcome: z.literal('too-large'), maxBytes: z.number().nonnegative() }),
]);
const modelContextSchema = z.object({ updateId: z.string(), content: z.array(ContentBlockSchema).optional(), structuredContent: z.record(z.string(), z.unknown()).optional() }).nullable();
const hostNames: Record<string, string> = { chatgpt: 'chatgpt', Claude: 'claude', Cursor: 'cursor', 'MCP-UI Host': 'goose', 'Le Chat': 'mistral-vibe' };
export interface ViewToolConfig<I extends z.ZodType, O extends z.ZodType | undefined = undefined> {
  inputSchema: I; outputSchema?: O; title?: string; description?: string; annotations?: z.infer<typeof ToolAnnotationsSchema>;
}
export interface ViewToolHandle { remove(): void; enable(): void; disable(): void; }

export interface McpBridgeOptions extends BridgeOptions, ContextDiagnosticsOptions {}
export const BRIDGE_OPTIONS = new InjectionToken<McpBridgeOptions>('Angular MCP Bridge options');
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'closed';
export class BridgeError extends Error {
  constructor(message: string, public readonly code: 'not-connected' | 'unsupported' | 'tool-error' | 'timeout', options?: ErrorOptions) {
    super(message, options); this.name = 'BridgeError';
  }
}

@Injectable()
export class McpBridge {
  private readonly options = inject(BRIDGE_OPTIONS);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly extensions = inject(CHATGPT_EXTENSIONS, { optional: true }) ?? (typeof window === 'undefined' ? {} : (window as Window & { openai?: ChatGptExtensions }).openai ?? {});
  private readonly localModalEnabled = inject(LOCAL_MODAL_ENABLED, { optional: true }) ?? false;
  private readonly destroyRef = inject(DestroyRef);
  private transport?: BridgeTransport;
  private connection?: Promise<void>;
  private closed = false;
  private connectionGeneration = 0;
  private readonly connectionEpochState = signal(0);
  /** Changes whenever a transport is replaced; cache entries must never cross this boundary. */
  readonly connectionEpoch = this.connectionEpochState.asReadonly();
  private readonly hostVersionState = signal<{ name: string; version: string } | undefined>(undefined);
  private readonly modalState = signal<ModalOptions | null>(null);
  private readonly hostViewState = signal(this.extensions.view);
  private readonly resourceListeners = new Map<string, Set<() => void>>();
  private readonly resourceSubscriptions = new Map<string, Promise<void>>();
  private resourceNotificationTransport?: BridgeTransport;
  private baseModelContext: ModelContextParams = {};
  private baseContextVersion: ContextVersion<ModelContextParams> = { value: {} };
  private readonly contextContributions = new Map<string, ModelContextParams>();
  private readonly contributionVersions = new Map<string, ContextVersion<ModelContextParams | null>>();
  private contributionSequence = 0;
  private contextWaiters: ContextWaiter[] = [];
  private contextInFlight: ContextWaiter[] = [];
  private contextFlushing = false;
  private contextFlushGeneration = 0;
  private contextAcknowledgment?: { epoch: number; key: string; updateId?: string };
  private widgetStateWrites = Promise.resolve();
  private readonly widgetStateSnapshots = new WeakMap<ChatGptExtensions, { observed: unknown; value: Record<string, unknown> }>();
  private readonly statusState = signal<ConnectionStatus>('idle');
  private readonly errorState = signal<Error | null>(null);
  private readonly contextState = signal<HostContext>({ theme: 'light', locale: 'en-US', displayMode: 'inline' });
  private readonly capabilitiesState = signal<HostCapabilities>({});
  private readonly inputState = signal<Record<string, unknown> | null>(null);
  private readonly resultState = signal<ToolResult | null>(null);
  private readonly cancelledState = signal<string | null>(null);

  readonly status = this.statusState.asReadonly();
  readonly error = this.errorState.asReadonly();
  readonly hostContext = this.contextState.asReadonly();
  readonly capabilities = this.capabilitiesState.asReadonly();
  readonly toolInput = this.inputState.asReadonly();
  readonly toolResult = this.resultState.asReadonly();
  readonly toolOutput = computed(() => this.toolResult()?.structuredContent ?? null);
  readonly toolMetadata = computed(() => this.toolResult()?._meta ?? null);
  readonly theme = computed(() => this.hostContext().theme ?? 'light');
  readonly locale = computed(() => this.hostContext().locale ?? 'en-US');
  readonly displayMode = computed(() => this.hostContext().displayMode ?? 'inline');
  readonly cancelled = this.cancelledState.asReadonly();
  readonly connected = computed(() => this.status() === 'connected');
  readonly hostInfo = computed(() => {
    const version = this.hostVersionState();
    return { name: version ? hostNames[version.name] ?? version.name : undefined, version: version?.version, capabilities: this.capabilities(),
      openaiCapabilities: { resource: this.supportsExtension('resource'), modelContext: this.supportsExtension('modelContext'), message: this.supportsExtension('message'), files: this.supportsExtension('files') } };
  });
  readonly user = computed(() => {
    const context = this.hostContext(); let locale = 'en-US';
    try { locale = new Intl.Locale((context.locale ?? 'en-US').replace(/_/g, '-')).toString(); } catch { /* Invalid host locale uses the standard fallback. */ }
    return { theme: this.theme(), locale, device: { type: context.platform === 'web' ? 'desktop' : context.platform ?? 'unknown' }, capabilities: { hover: context.deviceCapabilities?.hover ?? false, touch: context.deviceCapabilities?.touch ?? false } };
  });
  readonly viewport = computed(() => {
    const context = this.hostContext(); const dimensions = context.containerDimensions;
    return { dimensions, maxHeight: dimensions && 'maxHeight' in dimensions ? dimensions.maxHeight : undefined, safeArea: { insets: context.safeAreaInsets ?? { top: 0, right: 0, bottom: 0, left: 0 } } };
  });
  readonly deepLink = computed(() => {
    const value = (this.hostContext() as HostContext & Record<string, unknown>)['openai/deepLink'];
    const url = value && typeof value === 'object' && 'url' in value ? value.url : undefined;
    return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\') && !url.includes('#') ? url : undefined;
  });
  readonly modelContext = computed(() => {
    const parsed = modelContextSchema.safeParse((this.hostContext() as HostContext & Record<string, unknown>)['openai/modelContext']);
    return parsed.success ? parsed.data : undefined;
  });
  /** Local modal state is rendered only when the application explicitly installs an outlet. */
  readonly modal = this.modalState.asReadonly();
  readonly display = computed(() => this.modal() ? { mode: 'modal' as const, params: this.modal()?.params } : this.hostViewState() ?? { mode: this.displayMode() });

  constructor() {
    if (this.options.onContextWarning) {
      checkContextBudget(undefined, { budgetTokens: this.options.contextBudget?.toolResultTokens ?? CONTEXT_WARNING_DEFAULTS.toolResultTokens, bytesPerToken: this.options.contextBudget?.bytesPerToken });
      checkContextBudget(undefined, { budgetTokens: this.options.contextBudget?.modelContextTokens ?? CONTEXT_WARNING_DEFAULTS.modelContextTokens, bytesPerToken: this.options.contextBudget?.bytesPerToken });
    }
    if (this.browser && typeof window !== 'undefined') {
      const listener = (event: Event) => {
        const detail = (event as CustomEvent<{ globals?: { view?: ChatGptExtensions['view']; widgetState?: unknown } }>).detail;
        if (detail?.globals?.view) this.hostViewState.set(detail.globals.view);
        if (detail?.globals && 'widgetState' in detail.globals) this.widgetStateSnapshots.delete(this.extensions);
      };
      window.addEventListener('openai:set_globals', listener);
      this.destroyRef.onDestroy(() => window.removeEventListener('openai:set_globals', listener));
    }
    this.destroyRef.onDestroy(() => { void this.close(); });
  }
  supportsExtension(name: 'resource' | 'modelContext' | 'message' | 'files'): boolean {
    return Boolean(this.capabilities().experimental?.[`openai/${name}`]);
  }

  /** Idempotent, bounded handshake. Standalone pages never pretend to be a host. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new BridgeError('This bridge has been closed.', 'not-connected'));
    if (this.connection) return this.connection;
    if (!this.browser) return Promise.resolve();
    if (!this.options.transportFactory && window.parent === window && !(this.options.transportMode !== 'mcp' && isLegacyAppsSdkHost())) {
      const error = new BridgeError('Open this view inside an MCP Apps host or the local workbench.', 'not-connected');
      this.errorState.set(error); this.statusState.set('error');
      return Promise.reject(error);
    }
    this.statusState.set('connecting'); this.errorState.set(null);
    const generation = ++this.connectionGeneration;
    this.connectionEpochState.set(generation);
    const transport = this.transport = (this.options.transportFactory ?? createTransport)(this.options);
    const current = () => generation === this.connectionGeneration && !this.closed;
    transport.ontoolinput = ({ arguments: args }) => {
      if (!current()) return;
      this.inputState.set(args ?? {}); this.cancelledState.set(null); this.resultState.set(null);
    };
    transport.ontoolinputpartial = ({ arguments: args }) => { if (current()) { this.inputState.set(args ?? {}); this.resultState.set(null); this.cancelledState.set(null); } };
    transport.ontoolresult = result => {
      if (current()) { this.resultState.set(result); this.inspectContext(result, 'tool-result', 'toolResult'); }
    };
    transport.ontoolcancelled = ({ reason }) => { if (current()) this.cancelledState.set(reason ?? 'Tool execution cancelled.'); };
    transport.onhostcontextchanged = context => { if (current()) this.contextState.update(previous => ({ ...previous, ...context })); };
    transport.onteardown = async () => { setTimeout(() => { if (current()) void this.close(); }, 0); return {}; };
    transport.onerror = error => { if (current()) this.errorState.set(error); };
    transport.onclose = () => { if (generation === this.connectionGeneration) { this.statusState.set('closed'); this.cancelContextWrites(); } };
    const timeout = this.options.connectTimeoutMs ?? 10000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      this.statusState.set('error');
      return Promise.reject(new RangeError('connectTimeoutMs must be positive and finite.'));
    }
    this.connection = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          transport.connect(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BridgeError('MCP host handshake timed out.', 'timeout')), timeout); }),
        ]);
        if (this.closed || generation !== this.connectionGeneration) return;
        this.contextState.update(context => ({ ...context, ...transport.getHostContext() }));
        this.capabilitiesState.set(transport.getHostCapabilities() ?? {});
        this.hostVersionState.set(transport.getHostVersion());
        this.statusState.set('connected');
      } catch (cause) {
        if (!this.closed && generation === this.connectionGeneration) {
          this.errorState.set(cause instanceof Error ? cause : new Error(String(cause)));
          await transport.close().catch(() => {});
          this.statusState.set('error');
        }
        throw cause;
      } finally { clearTimeout(timer); }
    })();
    return this.connection;
  }

  private async ready(): Promise<BridgeTransport> {
    await this.connect();
    if (!this.transport || !this.connected()) throw new BridgeError('The MCP host is disconnected.', 'not-connected');
    return this.transport;
  }
  async callTool(name: string, args: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ToolResult> {
    const app = await this.ready();
    if (!this.capabilities().serverTools) throw new BridgeError('The host does not support server tool calls.', 'unsupported');
    if (options?.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new RangeError('timeoutMs must be positive and finite.');
    const result = await app.callServerTool({ name, arguments: args }, { timeout: options?.timeoutMs, signal: options?.signal });
    this.inspectContext(result, 'tool-result', 'callTool', name);
    if (result.isError) {
      const message = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      throw new BridgeError(message || `Tool ${name} failed.`, 'tool-error');
    }
    return result;
  }
  async sendMessage(message: string | MessageContent, options: FollowUpOptions = {}): Promise<void> {
    const app = await this.ready();
    if (options.target === 'new' && !this.supportsExtension('message')) throw new BridgeError('The host does not support starting a new conversation.', 'unsupported');
    if (options.scrollToBottom !== undefined) {
      if (typeof message !== 'string' || options.target === 'new' || !this.extensions.sendFollowUpMessage) throw new BridgeError('Scroll control requires the ChatGPT text-message extension.', 'unsupported');
      await this.extensions.sendFollowUpMessage({ prompt: message, scrollToBottom: options.scrollToBottom }); return;
    }
    if (!this.capabilities().message && typeof message === 'string' && options.target !== 'new' && this.extensions.sendFollowUpMessage) {
      await this.extensions.sendFollowUpMessage({ prompt: message }); return;
    }
    if (!this.capabilities().message) throw new BridgeError('The host does not support follow-up messages.', 'unsupported');
    const result = await app.sendMessage({ role: 'user', content: typeof message === 'string' ? [{ type: 'text', text: message }] : message,
      ...(options.target === 'new' ? { _meta: { 'openai/message': { target: 'new' } } } : {}) });
    if (result.isError) throw new BridgeError('The host rejected the message.', 'tool-error');
  }
  async updateModelContext(structuredContent: Record<string, unknown>): Promise<void> {
    await this.setModelContext({ structuredContent });
  }
  /** Full standard payload: text/image/resource blocks plus structured data and host metadata. */
  async setModelContext(params: ModelContextParams): Promise<string | undefined> {
    const version: ContextVersion<ModelContextParams> = { value: params, previous: this.baseContextVersion };
    this.baseContextVersion = version;
    this.baseModelContext = params;
    try { const id = await this.sendModelContext(); version.previous = undefined; return id; }
    catch (error) {
      version.failed = true;
      if (this.baseContextVersion === version) {
        let previous = version.previous; while (previous?.failed) previous = previous.previous;
        this.baseContextVersion = previous ?? { value: {} }; this.baseModelContext = this.baseContextVersion.value;
      }
      throw error;
    }
  }
  /** Namespaced Angular directive/state contributions are merged with explicit application context. */
  async setModelContextContribution(key: string, params: ModelContextParams | null): Promise<string | undefined> {
    if (!key) throw new TypeError('A model context contribution key is required.');
    const version: ContextVersion<ModelContextParams | null> = { value: params, previous: this.contributionVersions.get(key) };
    this.contributionVersions.set(key, version);
    if (params === null) this.contextContributions.delete(key); else this.contextContributions.set(key, params);
    try { const id = await this.sendModelContext(); version.previous = undefined; return id; }
    catch (error) {
      version.failed = true;
      if (this.contributionVersions.get(key) === version) {
        let previous = version.previous; while (previous?.failed) previous = previous.previous;
        if (previous) this.contributionVersions.set(key, previous); else this.contributionVersions.delete(key);
        if (previous?.value) this.contextContributions.set(key, previous.value); else this.contextContributions.delete(key);
      }
      throw error;
    }
  }
  /** Allocates an injector-local owner id. The payload's keys remain an explicit schema choice. */
  createModelContextContributionKey(prefix = 'angular:context'): string { return `${prefix}:${++this.contributionSequence}`; }
  /** Lifecycle removal is permanent even when the host is disconnected. */
  async removeModelContextContribution(key: string): Promise<string | undefined> {
    const hadContribution = this.contextContributions.delete(key);
    this.contributionVersions.delete(key);
    return hadContribution && this.connected() ? this.sendModelContext() : undefined;
  }
  private sendModelContext(): Promise<string | undefined> {
    const request = new Promise<string | undefined>((resolve, reject) => this.contextWaiters.push({ resolve, reject }));
    if (!this.contextFlushing) {
      this.contextFlushing = true;
      const generation = this.contextFlushGeneration;
      queueMicrotask(() => { void this.flushModelContext(generation); });
    }
    return request;
  }
  private async flushModelContext(generation: number): Promise<void> {
    while (generation === this.contextFlushGeneration && this.contextWaiters.length) {
      const batch = this.contextWaiters.splice(0); this.contextInFlight = batch;
      try {
        const id = await this.dispatchModelContext();
        if (generation !== this.contextFlushGeneration) return;
        for (const waiter of batch) waiter.resolve(id);
      } catch (error) {
        if (generation !== this.contextFlushGeneration) return;
        for (const waiter of batch) waiter.reject(error);
      }
      this.contextInFlight = [];
      // Promise handlers may restore failed versions before the next composed snapshot.
      await Promise.resolve();
    }
    if (generation === this.contextFlushGeneration) this.contextFlushing = false;
  }
  private cancelContextWrites(): void {
    this.contextFlushGeneration++; this.contextFlushing = false; this.contextAcknowledgment = undefined;
    const error = new BridgeError('The host disconnected before acknowledging model context.', 'not-connected');
    for (const waiter of [...this.contextInFlight, ...this.contextWaiters]) waiter.reject(error);
    this.contextInFlight = []; this.contextWaiters = [];
  }
  private async dispatchModelContext(): Promise<string | undefined> {
    const app = await this.ready();
    const epoch = this.connectionGeneration;
    if (!this.capabilities().updateModelContext && !this.supportsExtension('modelContext')) throw new BridgeError('The host does not support model context updates.', 'unsupported');
    const entries = [this.baseModelContext, ...this.contextContributions.values()];
    const structuredContent = Object.assign({}, ...entries.map(entry => entry.structuredContent ?? {})) as Record<string, unknown>;
    const content = entries.flatMap(entry => entry.content ?? []);
    const params: ModelContextParams = { ...this.baseModelContext,
      ...(Object.keys(structuredContent).length ? { structuredContent } : {}), ...(content.length ? { content } : {}) };
    const key = createReadCacheKey(params);
    if (key !== undefined && this.contextAcknowledgment?.epoch === epoch && this.contextAcknowledgment.key === key) return this.contextAcknowledgment.updateId;
    this.inspectContext(params, 'model-context', 'setModelContext');
    const result = await app.updateModelContext(params);
    if (epoch !== this.connectionGeneration || app !== this.transport || !this.connected()) throw new BridgeError('The host disconnected before acknowledging model context.', 'not-connected');
    const metadata = result._meta?.['openai/modelContext'];
    const updateId = metadata && typeof metadata === 'object' && 'updateId' in metadata && typeof metadata.updateId === 'string' ? metadata.updateId : undefined;
    if (key !== undefined) this.contextAcknowledgment = { epoch, key, updateId };
    return updateId;
  }
  private inspectContext(value: unknown, kind: ContextWarning['kind'], source: ContextWarning['source'], toolName?: string): void {
    const observer = this.options.onContextWarning;
    if (!observer) return;
    const defaults = CONTEXT_WARNING_DEFAULTS;
    const budgetTokens = kind === 'tool-result' ? this.options.contextBudget?.toolResultTokens ?? defaults.toolResultTokens : this.options.contextBudget?.modelContextTokens ?? defaults.modelContextTokens;
    const check = checkContextBudget(value, { budgetTokens, bytesPerToken: this.options.contextBudget?.bytesPerToken });
    if (check.exceeded) {
      // Diagnostics remain observational, even when a consumer callback fails.
      try { void Promise.resolve(observer({ ...check, kind, source, ...(toolName ? { toolName } : {}) })).catch(() => {}); }
      catch { /* Observer isolation. */ }
    }
  }
  async requestDisplayMode(mode: DisplayMode): Promise<void> {
    const app = await this.ready();
    if (!this.hostContext().availableDisplayModes?.includes(mode)) throw new BridgeError(`The host does not support ${mode} mode.`, 'unsupported');
    const result = await app.requestDisplayMode({ mode });
    this.contextState.update(context => ({ ...context, displayMode: result.mode }));
  }
  async openLink(url: string): Promise<void> {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new TypeError('Only HTTP(S) links are supported.');
    const app = await this.ready();
    if (!this.capabilities().openLinks) throw new BridgeError('The host does not support external links.', 'unsupported');
    await app.openLink({ url: parsed.href });
  }
  async openExternal(url: string, options: OpenExternalOptions = {}): Promise<void> {
    if (options.redirectUrl === undefined) return this.openLink(url);
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('Only HTTP(S) links are supported.');
    await this.ready();
    if (!this.extensions.openExternal) throw new BridgeError('Redirect control requires the ChatGPT external-link extension.', 'unsupported');
    this.extensions.openExternal({ href: parsed.href, ...options });
  }
  async requestSize(size: SizeParams): Promise<void> {
    for (const value of [size.width, size.height]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError('View dimensions must be nonnegative finite pixels.');
    const app = await this.ready();
    if (!app.sendSizeChanged) throw new BridgeError('The transport does not support size notifications.', 'unsupported');
    await app.sendSizeChanged(size);
  }
  /** Requests host dismissal. This is distinct from disconnecting the protocol transport. */
  async requestClose(): Promise<void> {
    const app = await this.ready();
    if (this.extensions.requestClose) { await this.extensions.requestClose(); return; }
    if (!app.requestTeardown) throw new BridgeError('The transport does not support dismissal requests.', 'unsupported');
    await app.requestTeardown();
  }
  async download(params: DownloadParams) {
    const app = await this.ready();
    if (!this.capabilities().downloadFile || !app.downloadFile) throw new BridgeError('The host does not support file downloads.', 'unsupported');
    return app.downloadFile(params);
  }
  async registerViewTool<I extends z.ZodType, O extends z.ZodType | undefined = undefined>(
    name: string, config: ViewToolConfig<I, O>, handler: (input: z.output<I>, signal: AbortSignal) => ToolResult | Promise<ToolResult>,
  ): Promise<ViewToolHandle> {
    const app = await this.ready();
    if (!app.registerTool) throw new BridgeError('The transport does not support app-provided tools.', 'unsupported');
    const callback = async (input: unknown, context: Parameters<AppToolCallback<z.ZodType>>[1]) => {
      // The official SDK validates/transforms input and output exactly once.
      const result = await handler(input as z.output<I>, context.mcpReq.signal);
      return result as AppToolResult<O>;
    };
    const registered = app.registerTool<O, I>(name, config, callback as AppToolCallback<I, O>);
    let removed = false;
    const handle = { remove: () => { if (!removed) { removed = true; registered.remove(); } }, enable: () => { if (!removed) registered.enable(); }, disable: () => { if (!removed) registered.disable(); } };
    if (this.destroyRef.destroyed) handle.remove(); else this.destroyRef.onDestroy(handle.remove);
    return handle;
  }
  async readResource(uri: string, representation?: ResourceRepresentation, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<FileResource> {
    const app = await this.ready();
    if (!this.capabilities().serverResources || !app.readServerResource) throw new BridgeError('The host does not support resource reads.', 'unsupported');
    const { contents } = await app.readServerResource({ uri, ...(representation ? { _meta: { 'openai/resource': { representation } } } : {}) }, options ? { signal: options.signal, timeout: options.timeoutMs } : undefined);
    const item = contents.find(item => item.uri === uri) ?? contents[0];
    if (!item) throw new BridgeError(`No resource contents were returned for ${uri}.`, 'tool-error');
    const meta = z.object({ writable: z.boolean().optional(), etag: z.string().optional() }).safeParse(item._meta?.['openai/resource']);
    return { ...('text' in item ? { text: item.text } : { blob: item.blob }), mimeType: item.mimeType, writable: meta.success ? meta.data.writable ?? false : false, etag: meta.success ? meta.data.etag : undefined };
  }
  async listResources(params?: Parameters<NonNullable<BridgeTransport['listServerResources']>>[0]) {
    const app = await this.ready();
    if (!this.capabilities().serverResources || !app.listServerResources) throw new BridgeError('The host does not support resource discovery.', 'unsupported');
    return app.listServerResources(params);
  }
  async listResourceTemplates(params?: { cursor?: string }) {
    const app = await this.ready();
    if (!this.capabilities().serverResources || !app.request) throw new BridgeError('The host does not support resource template discovery.', 'unsupported');
    return app.request({ method: 'resources/templates/list', params }, ListResourceTemplatesResultSchema);
  }
  /** Subscription/write forwarding is an advertised host extension, rather than assumed from read support. */
  async watchResource(uri: string, listener: () => void): Promise<() => Promise<void>> {
    const app = await this.ready();
    if (!this.supportsExtension('resource') || !app.request || !app.setNotificationHandler) throw new BridgeError('The host does not advertise resource subscriptions.', 'unsupported');
    if (this.resourceNotificationTransport !== app) {
      const generation = this.connectionGeneration;
      app.setNotificationHandler('notifications/resources/updated', ({ params }) => { if (generation === this.connectionGeneration && this.transport === app && this.connected()) this.resourceListeners.get(params.uri)?.forEach(callback => callback()); });
      this.resourceNotificationTransport = app;
    }
    const listeners = this.resourceListeners.get(uri) ?? new Set<() => void>();
    this.resourceListeners.set(uri, listeners); listeners.add(listener);
    let subscription = this.resourceSubscriptions.get(uri);
    if (!subscription) {
      subscription = app.request({ method: 'resources/subscribe', params: { uri } }, ResultSchema).then(() => {});
      this.resourceSubscriptions.set(uri, subscription);
    }
    try { await subscription; }
    catch (error) { listeners.delete(listener); if (!listeners.size && this.resourceListeners.get(uri) === listeners) { this.resourceListeners.delete(uri); this.resourceSubscriptions.delete(uri); } throw error; }
    let disposed = false;
    const dispose = async () => {
      if (disposed) return; disposed = true;
      listeners.delete(listener);
      if (this.resourceListeners.get(uri) !== listeners) return;
      if (!listeners.size) {
        this.resourceListeners.delete(uri); this.resourceSubscriptions.delete(uri);
        if (this.transport === app && this.connected()) await app.request!({ method: 'resources/unsubscribe', params: { uri } }, ResultSchema);
      }
    };
    if (this.destroyRef.destroyed) await dispose(); else this.destroyRef.onDestroy(() => { void dispose().catch(() => {}); });
    return dispose;
  }
  async writeResource(uri: string, content: FileResourceContent, ifMatch?: string): Promise<FileWriteResult> {
    const app = await this.ready();
    if (!this.supportsExtension('resource') || !app.request) throw new BridgeError('The host does not advertise resource writes.', 'unsupported');
    return app.request({ method: 'openai/resources/write', params: { uri, ...content, ...(ifMatch !== undefined ? { ifMatch } : {}) } }, writeResultSchema);
  }
  async openFile(path: string): Promise<void> {
    if (!path.trim()) throw new TypeError('A file path is required.');
    const app = await this.ready();
    if (!this.supportsExtension('files') || !app.request) throw new BridgeError('The host does not advertise file opening.', 'unsupported');
    await app.request({ method: 'openai/files/open', params: { path } }, ResultSchema);
  }
  async uploadFile(file: File, options?: UploadFileOptions): Promise<FileMetadata> {
    await this.ready();
    if (!this.extensions.uploadFile) throw new BridgeError('The host does not provide file upload.', 'unsupported');
    const metadata = await this.extensions.uploadFile(file, options);
    if ((metadata.mimeType ?? file.type).startsWith('image/')) await this.trackImageFiles([metadata.fileId]);
    return metadata;
  }
  async selectFiles(): Promise<FileMetadata[]> {
    await this.ready();
    if (!this.extensions.selectFiles) throw new BridgeError('The host does not provide a file picker.', 'unsupported');
    const files = await this.extensions.selectFiles();
    await this.trackImageFiles(files.filter(file => file.mimeType?.startsWith('image/')).map(file => file.fileId));
    return files;
  }
  async getFileDownloadUrl(file: FileMetadata): Promise<{ downloadUrl: string }> {
    await this.ready();
    if (!this.extensions.getFileDownloadUrl) throw new BridgeError('The host does not provide uploaded-file download URLs.', 'unsupported');
    return this.extensions.getFileDownloadUrl(file);
  }
  /** Read the latest bridge-owned write even when the host's globals update is delayed. */
  getWidgetState(adapter: ChatGptExtensions = this.extensions): Record<string, unknown> {
    if (isLegacyAppsSdkHost(adapter)) return readLegacyWidgetState(adapter);
    const snapshot = this.widgetStateSnapshots.get(adapter);
    return snapshot && snapshot.observed === adapter.widgetState ? snapshot.value : adapter.widgetState ?? {};
  }
  /** One read-modify-write queue per bridge protects independent state and file operations. */
  updateWidgetState(updater: (previous: Record<string, unknown>) => Record<string, unknown>, adapter: ChatGptExtensions = this.extensions): Promise<void> {
    if (isLegacyAppsSdkHost(adapter)) return updateLegacyWidgetState(adapter, updater);
    if (!adapter.setWidgetState) return Promise.reject(new BridgeError('The host does not provide widget-state persistence.', 'unsupported'));
    const pending = this.widgetStateWrites.catch(() => {}).then(async () => {
      const next = updater(this.getWidgetState(adapter));
      await adapter.setWidgetState!(next);
      this.widgetStateSnapshots.set(adapter, { observed: adapter.widgetState, value: next });
    });
    this.widgetStateWrites = pending; return pending;
  }
  private trackImageFiles(ids: string[]): Promise<void> {
    if (!ids.length || !this.extensions.setWidgetState) return Promise.resolve();
    return this.updateWidgetState(previous => {
      const existing = Array.isArray(previous['imageIds']) ? previous['imageIds'].filter((id): id is string => typeof id === 'string') : [];
      return { modelContent: {}, privateContent: {}, ...previous, imageIds: [...new Set([...existing, ...ids])] };
    });
  }
  async openModal(options: ModalOptions = {}): Promise<void> {
    await this.ready();
    if (this.extensions.requestModal) { await this.extensions.requestModal(options); return; }
    if (!this.localModalEnabled) throw new BridgeError('The host does not provide modals. Install provideLocalMcpModal and McpModalOutlet for an iframe-local dialog.', 'unsupported');
    if (options.template || options.anchor) throw new BridgeError('Local modals render Angular content; host templates and anchors require the host extension.', 'unsupported');
    this.modalState.set(options);
  }
  closeModal(): void {
    if (this.modal()) { this.modalState.set(null); return; }
    if (this.hostViewState()?.mode === 'modal') throw new BridgeError('The host owns this modal lifecycle.', 'unsupported');
  }
  async setOpenInAppUrl(href: string): Promise<void> {
    const parsed = new URL(href);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new TypeError('Only HTTP(S) links are supported.');
    await this.ready();
    if (!this.extensions.setOpenInAppUrl) throw new BridgeError('The host does not provide an open-in-app URL.', 'unsupported');
    await this.extensions.setOpenInAppUrl({ href: parsed.href });
  }
  /** Disconnect is recoverable. DestroyRef/close dispose the bridge permanently. */
  async disconnect(): Promise<void> {
    const generation = ++this.connectionGeneration;
    this.connectionEpochState.set(generation);
    this.cancelContextWrites();
    const app = this.transport; this.transport = undefined; this.connection = undefined;
    if (this.resourceNotificationTransport === app) app?.removeNotificationHandler?.('notifications/resources/updated');
    this.resourceListeners.clear(); this.resourceSubscriptions.clear(); this.resourceNotificationTransport = undefined;
    this.capabilitiesState.set({}); this.hostVersionState.set(undefined);
    this.statusState.set('closed');
    this.contextState.set({ theme: 'light', locale: 'en-US', displayMode: 'inline' });
    this.inputState.set(null); this.resultState.set(null); this.cancelledState.set(null);
    await app?.close().catch(() => {});
    if (generation === this.connectionGeneration) this.statusState.set('closed');
  }
  async reconnect(): Promise<void> { await this.disconnect(); return this.connect(); }
  async retryConnect(): Promise<void> { return this.reconnect(); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.disconnect();
  }
}

/** Connect without blocking Angular bootstrap: the host handshake needs a rendered iframe. */
export function provideMcpBridge(options: McpBridgeOptions): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: BRIDGE_OPTIONS, useValue: options }, McpBridge, McpViewContext,
    { provide: VIEW_CONTEXT_BRIDGE, useExisting: McpBridge },
    provideAppInitializer(() => { void inject(McpBridge).connect().catch(() => {}); }),
  ]);
}
