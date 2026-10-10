import { DestroyRef, inject, InjectionToken, makeEnvironmentProviders, signal } from '@angular/core';
import { McpBridge } from './bridge.js';
import { CHATGPT_EXTENSIONS, type ChatGptExtensions } from './extensions.js';

export interface ViewStateStore {
  read(key: string): unknown;
  write(key: string, envelope: { version: number; value: unknown }): void | Promise<void>;
}
export const VIEW_STATE_STORE = new InjectionToken<ViewStateStore>('Angular MCP view state store');
export function provideViewStateStore(store: ViewStateStore) {
  return makeEnvironmentProviders([{ provide: VIEW_STATE_STORE, useValue: store }]);
}
/** Explicit opt-in to browser storage; sandboxed hosts may deny access or clear it. */
export function provideBrowserViewStateStore(kind: 'local' | 'session' = 'session') {
  return makeEnvironmentProviders([{ provide: VIEW_STATE_STORE, useFactory: (): ViewStateStore => ({
    read(key) { try { if (typeof window === 'undefined') return undefined; const storage = kind === 'local' ? window.localStorage : window.sessionStorage; return JSON.parse(storage.getItem(key) ?? 'null'); } catch { return undefined; } },
    write(key, envelope) { if (typeof window === 'undefined') return; const storage = kind === 'local' ? window.localStorage : window.sessionStorage; storage.setItem(key, JSON.stringify(envelope)); },
  }) }]);
}
interface Envelope<T> { version: number; value: T; }
export interface ViewStateOptions<T> {
  /** A unique conversation/view-instance key. Never use a shared user-global key. */
  key?: string;
  persist?: boolean;
  version?: number;
  /** Runtime validation for restored state, e.g. a Zod schema. */
  schema?: { parse(value: unknown): T };
  /** Explicitly publish each successful update to the model; the default remains private. */
  autoShare?: boolean;
  /** Key in structured model context. Use distinct keys when sharing multiple state instances. */
  shareKey?: string;
}

/** Private local state; versioned, validated persistence when explicitly requested. */
export function injectViewState<T>(initial: T, options: ViewStateOptions<T> = {}) {
  const bridge = inject(McpBridge);
  const destroyRef = inject(DestroyRef);
  const store = inject(VIEW_STATE_STORE, { optional: true });
  const browser = typeof window !== 'undefined';
  const host = inject(CHATGPT_EXTENSIONS, { optional: true }) ?? (browser ? (window as Window & { openai?: ChatGptExtensions }).openai : undefined);
  let starting = initial;
  const version = options.version ?? 1;
  const storageKey = options.key ? `angular-mcp-bridge:${options.key}` : undefined;
  if (options.persist && !storageKey) throw new Error('Persistent view state requires a unique per-view-instance key.');
  if (options.persist && !options.schema) throw new Error('Persistent view state requires a schema to validate restored data.');
  if (options.persist && storageKey) {
    try {
      const hostEnvelope = (host ? bridge.getWidgetState(host) : undefined) as { privateContent?: { angularMcpBridge?: Record<string, Envelope<T>> }; angularMcpBridge?: Record<string, Envelope<T>> } | undefined;
      const stored = store ? store.read(storageKey) : hostEnvelope?.privateContent?.angularMcpBridge?.[storageKey] ?? hostEnvelope?.angularMcpBridge?.[storageKey] ?? (browser ? JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') : null);
      if (stored && typeof stored === 'object' && 'version' in stored && 'value' in stored && stored.version === version) starting = options.schema!.parse(stored.value);
    } catch { /* Invalid, outdated or unavailable storage resets to the default. */ }
  }
  const state = signal(starting);
  const contributionKey = bridge.createModelContextContributionKey('angular:view-state');
  const shareKey = options.shareKey ?? 'viewState';
  if (!shareKey) throw new Error('A nonempty model context shareKey is required.');
  let destroyed = false;
  let shared = false;
  if (options.persist && storageKey && browser) {
    const restore = (event: Event) => {
      const detail = (event as CustomEvent<{ globals?: { widgetState?: { privateContent?: { angularMcpBridge?: Record<string, Envelope<T>> } } } }>).detail;
      if (!detail?.globals || !('widgetState' in detail.globals)) return;
      const envelope = detail.globals.widgetState?.privateContent?.angularMcpBridge?.[storageKey];
      try { state.set(envelope?.version === version ? options.schema!.parse(envelope.value) : initial); } catch { state.set(initial); }
    };
    window.addEventListener('openai:set_globals', restore);
    destroyRef.onDestroy(() => window.removeEventListener('openai:set_globals', restore));
  }
  const share = () => {
    if (destroyed) return Promise.reject(new Error('This view state has been destroyed.'));
    shared = true;
    return bridge.setModelContextContribution(contributionKey, { structuredContent: { [shareKey]: state() } }).then(() => {});
  };
  destroyRef.onDestroy(() => { destroyed = true; if (shared) void bridge.removeModelContextContribution(contributionKey).catch(() => {}); });
  let writes = Promise.resolve();
  return {
    value: state.asReadonly(),
    set(value: T | ((current: T) => T)): Promise<void> {
      if (destroyed) return Promise.reject(new Error('This view state has been destroyed.'));
      const updated = typeof value === 'function' ? (value as (current: T) => T)(state()) : value;
      const next = options.schema ? options.schema.parse(updated) : updated;
      state.set(next);
      if (!options.persist || !storageKey) return options.autoShare ? share() : Promise.resolve();
      const envelope = { version, value: next };
      // Serialize persistence so slow writes cannot overwrite a later selection.
      const pending = writes.catch(() => {}).then(async () => {
        if (store) { await store.write(storageKey, envelope); return; }
        if (host?.setWidgetState) {
          await bridge.updateWidgetState(previous => {
            const existing = previous as { privateContent?: { angularMcpBridge?: Record<string, unknown> } };
            return { modelContent: {}, ...previous, privateContent: { ...existing.privateContent, angularMcpBridge: { ...existing.privateContent?.angularMcpBridge, [storageKey]: envelope } } };
          }, host);
        } else if (browser) {
          try { sessionStorage.setItem(storageKey, JSON.stringify(envelope)); } catch { /* Private state still works. */ }
        }
      });
      writes = pending;
      return options.autoShare ? pending.then(share) : pending;
    },
    /** Sharing is explicit: UI state is never silently sent to the model. */
    share,
  };
}
