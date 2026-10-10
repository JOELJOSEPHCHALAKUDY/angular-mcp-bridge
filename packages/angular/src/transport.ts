import { App } from '@modelcontextprotocol/ext-apps';
import { isLegacyAppsSdkHost, LegacyAppsSdkTransport } from './legacy-transport.js';

/** Narrow adapter boundary: the official SDK owns protocol validation and messaging. */
export type BridgeTransport = Pick<App,
  'connect' | 'close' | 'getHostContext' | 'getHostCapabilities' | 'getHostVersion' |
  'callServerTool' | 'sendMessage' | 'updateModelContext' | 'requestDisplayMode' |
  'openLink' | 'ontoolinput' | 'ontoolinputpartial' | 'ontoolresult' |
  'ontoolcancelled' | 'onhostcontextchanged' | 'onteardown' | 'onerror' | 'onclose'> & Partial<Pick<App,
  'downloadFile' | 'sendSizeChanged' | 'requestTeardown' | 'registerTool' |
  'readServerResource' | 'listServerResources' |
  'request' | 'setNotificationHandler' | 'removeNotificationHandler'>>;
export type HostContext = NonNullable<ReturnType<App['getHostContext']>>;
export type HostCapabilities = NonNullable<ReturnType<App['getHostCapabilities']>>;
export type ToolResult = Awaited<ReturnType<App['callServerTool']>>;
export type DisplayMode = Parameters<App['requestDisplayMode']>[0]['mode'];
export type MessageParams = Parameters<App['sendMessage']>[0];
export type MessageContent = MessageParams['content'];
export type ModelContextParams = Parameters<App['updateModelContext']>[0];
export type DownloadParams = Parameters<App['downloadFile']>[0];
export type DownloadResult = Awaited<ReturnType<App['downloadFile']>>;
export type SizeParams = Parameters<App['sendSizeChanged']>[0];
export interface BridgeOptions {
  name: string;
  version?: string;
  connectTimeoutMs?: number;
  /** Auto prefers MCP Apps and probes before falling back to a usable older Apps SDK host. */
  transportMode?: 'auto' | 'mcp' | 'legacy';
  /** Auto-mode handshake probe, default 1000ms and always shorter than connectTimeoutMs. */
  legacyProbeTimeoutMs?: number;
  /** Injectable adapter for tests or an alternative standards-compliant transport. */
  transportFactory?: (options: BridgeOptions) => BridgeTransport;
}
/** Resize work belongs to the same connection lifetime as the Angular bridge. */
class AngularAppTransport extends App {
  private stopResize?: () => void;
  private connectionGeneration = 0;
  private externalOnClose?: App['onclose'];
  private readonly closeListener = () => { this.cleanupResize(); this.externalOnClose?.(); };

  override async connect(...args: Parameters<App['connect']>): Promise<void> {
    const generation = ++this.connectionGeneration;
    if (this.onclose !== this.closeListener) this.externalOnClose = this.onclose;
    this.onclose = this.closeListener;
    await super.connect(...args);
    // A handshake can resolve after Angular destroys the injector or requests close.
    if (generation === this.connectionGeneration) this.startResize();
  }
  override async close(): Promise<void> {
    this.cleanupResize();
    await super.close();
  }
  private cleanupResize(): void {
    ++this.connectionGeneration;
    this.stopResize?.();
    this.stopResize = undefined;
  }
  private startResize(): void {
    if (typeof document === 'undefined' || typeof window === 'undefined' || typeof ResizeObserver === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
    this.stopResize?.();
    let disposed = false, frame: number | undefined, width = -1, height = -1;
    const reportError = (cause: unknown) => {
      if (!disposed) this.onerror?.(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const schedule = () => {
      if (disposed || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (disposed) return;
        try {
          const root = document.documentElement, previousHeight = root.style.height;
          let nextHeight: number;
          try { root.style.height = 'max-content'; nextHeight = Math.ceil(root.getBoundingClientRect().height); }
          finally { root.style.height = previousHeight; }
          const nextWidth = Math.ceil(window.innerWidth);
          if (nextWidth !== width || nextHeight !== height) {
            width = nextWidth; height = nextHeight;
            // SDK notification promises can reject when a close races with the send.
            void this.sendSizeChanged({ width, height }).catch(reportError);
          }
        } catch (cause) { reportError(cause); }
      });
    };
    const observer = new ResizeObserver(schedule);
    this.stopResize = () => {
      disposed = true;
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    };
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    schedule();
  }
}
export function createTransport(options: BridgeOptions): BridgeTransport {
  const legacyHost = typeof window === 'undefined' ? undefined : (window as Window & { openai?: unknown }).openai;
  const mode = options.transportMode ?? 'auto';
  if (mode === 'legacy') {
    if (!isLegacyAppsSdkHost(legacyHost)) throw new Error('Legacy mode requires a usable window.openai.callTool host.');
    return new LegacyAppsSdkTransport(legacyHost);
  }
  if (mode === 'auto' && isLegacyAppsSdkHost(legacyHost) && window.parent === window) return new LegacyAppsSdkTransport(legacyHost);
  // The SDK's autoResize helper does not retain its observer/RAF cleanup. Own that lifetime here.
  const app = new AngularAppTransport({ name: options.name, version: options.version ?? '0.1.0' }, { tools: { listChanged: true } }, { autoResize: false });
  // Hosts may discover app tools before Angular has registered its first component tool.
  app.setRequestHandler('tools/list', async () => ({ tools: [] }));
  if (mode !== 'auto' || !isLegacyAppsSdkHost(legacyHost)) return app;
  const outerTimeout = options.connectTimeoutMs ?? 10000;
  const probeTimeout = options.legacyProbeTimeoutMs ?? Math.min(1000, outerTimeout / 2);
  if (!Number.isFinite(probeTimeout) || probeTimeout <= 0 || probeTimeout >= outerTimeout) throw new RangeError('legacyProbeTimeoutMs must be positive and shorter than connectTimeoutMs.');
  return preferStandardTransport(app, new LegacyAppsSdkTransport(legacyHost), probeTimeout);
}

/** A modern ChatGPT host can expose both protocols. Only lack of a handshake response permits fallback. */
function preferStandardTransport(standard: BridgeTransport, legacy: BridgeTransport, probeTimeout: number): BridgeTransport {
  let active = standard, closed = false;
  let connecting: Promise<void> | undefined;
  let cancelProbe: ((reason: Error) => void) | undefined;
  const probeExpired = new Error('Legacy transport probe elapsed.');
  const callbacks = ['ontoolinput', 'ontoolinputpartial', 'ontoolresult', 'ontoolcancelled', 'onhostcontextchanged', 'onteardown', 'onerror', 'onclose'];
  const connect = (...args: Parameters<BridgeTransport['connect']>): Promise<void> => {
    if (closed) return Promise.reject(new Error('The bridge transport has been closed.'));
    if (connecting) return connecting;
    connecting = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const probe = new Promise<never>((_, reject) => { cancelProbe = reject; timer = setTimeout(() => reject(probeExpired), probeTimeout); });
      try { await Promise.race([standard.connect(...args), probe]); }
      catch (error) {
        if (closed || error !== probeExpired) throw error;
        // Detach callbacks before retiring the standard attempt so it cannot overwrite legacy state.
        for (const name of callbacks) Reflect.set(standard, name, undefined);
        await standard.close();
        if (closed) throw new Error('The bridge transport has been closed.');
        active = legacy; await legacy.connect();
      } finally { clearTimeout(timer); cancelProbe = undefined; }
    })();
    return connecting;
  };
  const close = async () => {
    if (closed) return; closed = true; cancelProbe?.(new Error('The bridge transport was closed during its handshake.'));
    // Only the active surface dispatches onclose; the unused adapter has no connected listeners.
    if (active === standard) Reflect.set(legacy, 'onclose', undefined);
    await active.close();
  };
  return new Proxy(standard, {
    get(_target, name) {
      if (name === 'connect') return connect;
      if (name === 'close') return close;
      const value = Reflect.get(active, name, active); return typeof value === 'function' ? value.bind(active) : value;
    },
    set(_target, name, value) { Reflect.set(standard, name, value); Reflect.set(legacy, name, value); return true; },
  });
}
