import { DestroyRef, effect, inject, InjectionToken, Injector, makeEnvironmentProviders, signal, untracked, type Signal } from '@angular/core';
import { McpBridge } from './bridge.js';

export interface McpReadCacheOptions {
  /** A reactive, non-secret account/authorization scope. Change it whenever read permissions change. */
  scope: () => string;
  /** Zero shares only in-flight reads. Completed reads require an explicit positive TTL. */
  ttlMs?: number;
  maxEntries?: number;
}
export interface ReadCachePolicy { ttlMs?: number; }
interface Entry {
  controller: AbortController;
  promise: Promise<unknown>;
  consumers: Set<symbol>;
  group: string;
  settled: boolean;
  expires: number;
}
interface Partition {
  epoch: number;
  scope: string;
  entries: Map<string, Entry>;
  inFlight: Set<Entry>;
  revisions: Map<string, ReturnType<typeof signal<number>>>;
}
const aborted = () => new DOMException('The read was cancelled.', 'AbortError');
const finiteNonnegative = (value: number, name: string) => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative.`);
  return value;
};

/** Stable wire keys exclude functions, cyclic objects and non-JSON values. Such inputs bypass sharing. */
export function createReadCacheKey(value: unknown): string | undefined {
  const seen = new Set<object>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || seen.has(item)) throw new TypeError('Not a JSON wire value.');
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.map(visit);
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError('Not a plain wire object.');
      return Object.fromEntries(Object.keys(item).sort().filter(key => (item as Record<string, unknown>)[key] !== undefined).map(key => [key, visit((item as Record<string, unknown>)[key])]));
    } finally { seen.delete(item); }
  };
  try { return JSON.stringify(visit(value)); } catch { return undefined; }
}

/** Opt-in, environment-owned read coordinator. Each bridge/connection/auth scope has a separate cache. */
export class McpReadCache {
  private readonly injector = inject(Injector);
  private readonly partitions = new Map<McpBridge, Partition>();
  private disposed = false;
  constructor(private readonly options: McpReadCacheOptions) {
    finiteNonnegative(options.ttlMs ?? 0, 'ttlMs');
    if (!Number.isInteger(options.maxEntries ?? 100) || (options.maxEntries ?? 100) < 1) throw new RangeError('maxEntries must be a positive integer.');
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      for (const partition of this.partitions.values()) this.clear(partition);
      this.partitions.clear();
    });
  }
  scope(): string {
    const scope = this.options.scope();
    if (typeof scope !== 'string' || !scope) throw new TypeError('The read cache requires a nonempty authorization scope.');
    return scope;
  }
  private partition(bridge: McpBridge): Partition {
    const scope = this.scope(); const epoch = bridge.connectionEpoch();
    let partition = this.partitions.get(bridge);
    if (!partition) {
      partition = { scope, epoch, entries: new Map(), inFlight: new Set(), revisions: new Map() };
      this.partitions.set(bridge, partition);
      const tracked = partition;
      untracked(() => {
        const lifecycle = effect(() => {
          const currentEpoch = bridge.connectionEpoch(); const currentScope = this.scope();
          if (tracked.epoch !== currentEpoch || tracked.scope !== currentScope) {
            this.clear(tracked); tracked.epoch = currentEpoch; tracked.scope = currentScope;
          }
          if (bridge.status() === 'closed' || bridge.status() === 'error') {
            this.clear(tracked);
            if (this.partitions.get(bridge) === tracked) this.partitions.delete(bridge);
            lifecycle.destroy();
          }
        }, { injector: this.injector });
      });
    } else if (partition.epoch !== epoch || partition.scope !== scope) {
      this.clear(partition); partition.epoch = epoch; partition.scope = scope;
    }
    return partition;
  }
  /** Read in resource params so invalidation, reconnect and authorization changes reload the consumer. */
  revision(bridge: McpBridge, group: string): Signal<number> {
    const partition = this.partition(bridge);
    let revision = partition.revisions.get(group);
    if (!revision) { revision = signal(0); partition.revisions.set(group, revision); }
    return revision.asReadonly();
  }
  private clear(partition: Partition, group?: string): void {
    for (const [key, entry] of partition.entries) if (!group || entry.group === group) {
      partition.entries.delete(key); entry.controller.abort(aborted());
    }
    for (const entry of partition.inFlight) if (!group || entry.group === group) {
      partition.inFlight.delete(entry); entry.controller.abort(aborted());
    }
  }
  invalidate(bridge: McpBridge, group?: string): void {
    const partition = this.partition(bridge); this.clear(partition, group);
    for (const [name, revision] of partition.revisions) if (!group || name === group) revision.update(value => value + 1);
  }
  read<T>(bridge: McpBridge, group: string, key: string | undefined, load: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, policy: ReadCachePolicy = {}): Promise<T> {
    if (this.disposed) return Promise.reject(aborted());
    signal.throwIfAborted();
    if (!key) return load(signal);
    const ttl = finiteNonnegative(policy.ttlMs ?? this.options.ttlMs ?? 0, 'ttlMs');
    const partition = this.partition(bridge);
    const cacheKey = `${ttl}:${key}`;
    let entry = partition.entries.get(cacheKey);
    if (entry?.settled && entry.expires <= Date.now()) { partition.entries.delete(cacheKey); entry = undefined; }
    if (!entry) {
      const controller = new AbortController();
      const created: Entry = { controller, group, consumers: new Set(), settled: false, expires: 0, promise: Promise.resolve() };
      partition.inFlight.add(created);
      created.promise = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return load(controller.signal); }).then(value => {
        partition.inFlight.delete(created);
        created.settled = true; created.expires = Date.now() + ttl;
        if (ttl === 0 && partition.entries.get(cacheKey) === created) partition.entries.delete(cacheKey);
        return value;
      }, error => {
        partition.inFlight.delete(created);
        created.settled = true;
        if (partition.entries.get(cacheKey) === created) partition.entries.delete(cacheKey);
        throw error;
      });
      partition.entries.set(cacheKey, created); entry = created;
      while (partition.entries.size > (this.options.maxEntries ?? 100)) partition.entries.delete(partition.entries.keys().next().value!);
    }
    const shared = entry; const consumer = Symbol('read consumer'); shared.consumers.add(consumer);
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true; signal.removeEventListener('abort', cancel); shared.controller.signal.removeEventListener('abort', sharedCancel); shared.consumers.delete(consumer);
        if (!shared.settled && !shared.consumers.size) {
          if (partition.entries.get(cacheKey) === shared) partition.entries.delete(cacheKey);
          shared.controller.abort(aborted());
        }
        return true;
      };
      const cancel = () => { if (finish()) reject(signal.reason ?? aborted()); };
      const sharedCancel = () => { if (finish()) reject(shared.controller.signal.reason ?? aborted()); };
      signal.addEventListener('abort', cancel, { once: true });
      shared.controller.signal.addEventListener('abort', sharedCancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      if (shared.controller.signal.aborted) { sharedCancel(); return; }
      shared.promise.then(value => {
        if (finish()) { try { resolve(structuredClone(value) as T); } catch (error) { reject(error); } }
      }, error => { if (finish()) reject(error); });
    });
  }
}
export const MCP_READ_CACHE = new InjectionToken<McpReadCache>('MCP read cache');
export function provideMcpReadCache(options: McpReadCacheOptions) {
  return makeEnvironmentProviders([{ provide: MCP_READ_CACHE, useFactory: () => new McpReadCache(options) }]);
}
/** Invalidate after a successful mutation or when application authorization changes. No-op without a cache provider. */
export function injectReadInvalidation() {
  const bridge = inject(McpBridge); const cache = inject(MCP_READ_CACHE, { optional: true });
  return {
    tool: (name: string) => cache?.invalidate(bridge, `tool:${name}`),
    resource: (uri: string) => cache?.invalidate(bridge, `resource:${uri}`),
    all: () => cache?.invalidate(bridge),
  };
}
