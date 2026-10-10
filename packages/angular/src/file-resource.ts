import { computed, effect, inject, resource, signal, type ResourceParamsContext, type ResourceRef, type ValueEqualityFn } from '@angular/core';
import { McpBridge } from './bridge.js';
import type { FileResource, FileResourceContent, FileWriteResult, ResourceRepresentation } from './extensions.js';
import { createReadCacheKey, MCP_READ_CACHE, type ReadCachePolicy } from './read-cache.js';

export type FileResourceValue = FileResource & { resourceUri: string };
export interface FileResourceOptions {
  uri: (context: ResourceParamsContext) => string | undefined;
  representation?: ResourceRepresentation;
  watch?: boolean;
  timeoutMs?: number;
  equal?: ValueEqualityFn<FileResourceValue>;
  defaultValue?: FileResourceValue;
  debugName?: string;
  cache?: boolean | ReadCachePolicy;
}
export interface FileResourceHandle {
  resource: ResourceRef<FileResourceValue | undefined>;
  watching: import('@angular/core').Signal<boolean>;
  selectedUri: import('@angular/core').Signal<string | undefined>;
  reload(): boolean;
  save(content: FileResourceContent, options?: { ifMatch?: string }): Promise<FileWriteResult>;
}

/** Angular resource() reads host-proxied MCP resources and reloads on supported subscriptions. */
export function injectFileResource(options: FileResourceOptions): FileResourceHandle {
  const bridge = inject(McpBridge);
  const cache = options.cache ? inject(MCP_READ_CACHE, { optional: true }) : null;
  const watching = signal(false);
  // A single native params function owns chaining. Watchers use the requested URI.
  const request = resource<string, string | undefined>({ params: options.uri, loader: ({ params }) => Promise.resolve(params) });
  const selectedUri = computed(() => request.hasValue() ? request.value() : undefined);
  const result = resource<FileResourceValue, { uri: string; revision?: number; scope?: string; epoch?: number } | undefined>({
    params: context => {
      const uri = context.chain(request);
      if (cache && (bridge.status() === 'closed' || bridge.status() === 'error')) return undefined;
      return uri ? { uri, ...(cache ? { revision: cache.revision(bridge, `resource:${uri}`)(), scope: cache.scope(), epoch: bridge.connectionEpoch() } : {}) } : undefined;
    },
    equal: options.equal, defaultValue: options.defaultValue, debugName: options.debugName ?? 'MCP file resource',
    loader: async ({ params, abortSignal }) => {
      await bridge.connect(); abortSignal.throwIfAborted();
      const load = (signal: AbortSignal) => bridge.readResource(params.uri, options.representation, { signal, timeoutMs: options.timeoutMs });
      const value = cache
        ? await cache.read(bridge, `resource:${params.uri}`, createReadCacheKey([params.uri, options.representation ?? null, options.timeoutMs ?? null]), load, abortSignal, typeof options.cache === 'object' ? options.cache : undefined)
        : await load(abortSignal);
      return { ...value, resourceUri: params.uri };
    },
  });
  const reload = () => {
    if (cache && request.hasValue()) { cache.invalidate(bridge, `resource:${request.value()}`); return true; }
    return result.reload();
  };
  effect(onCleanup => {
    const uri = request.hasValue() ? request.value() : undefined;
    if (!uri || options.watch === false || !bridge.connected() || !bridge.supportsExtension('resource')) return;
    let disposed = false;
    let unsubscribe: (() => Promise<void>) | undefined;
    void bridge.watchResource(uri, reload).then(dispose => {
      if (disposed) void dispose().catch(() => {});
      else { unsubscribe = dispose; watching.set(true); }
    }).catch(() => { if (!disposed) watching.set(false); });
    onCleanup(() => { disposed = true; watching.set(false); void unsubscribe?.().catch(() => {}); });
  });
  return {
    resource: result, watching: watching.asReadonly(), selectedUri, reload,
    /** An explicit ifMatch (including undefined) preserves a draft's original base version. */
    async save(content, saveOptions) {
      if (!result.hasValue()) throw new Error('Load a resource before saving.');
      const current = result.value()!;
      if (selectedUri() !== current.resourceUri) throw new Error('The selected resource changed. Wait for the current read before saving.');
      if (!current.writable) throw new Error('This resource is read-only.');
      const ifMatch = saveOptions && 'ifMatch' in saveOptions ? saveOptions.ifMatch : current.etag;
      const saved = await bridge.writeResource(current.resourceUri, content, ifMatch);
      if (saved.outcome === 'saved') reload();
      return saved;
    },
  };
}
