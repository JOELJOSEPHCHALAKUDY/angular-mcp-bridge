import '@angular/compiler';
import { DOCUMENT, PLATFORM_ID, provideZonelessChangeDetection, resource, resourceFromSnapshots, signal, type ResourceSnapshot } from '@angular/core';
import { TestBed, TestComponentRenderer } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_OPTIONS, McpBridge, MCP_READ_CACHE, createToolClient, injectFileResource, injectReadInvalidation, injectResourceDraft, provideMcpReadCache, retainedResourceValue, type BridgeTransport, type McpReadCacheOptions, type ToolResult } from '@angular-mcp-bridge/angular';
import { tools } from '../examples/shared/tools.js';

beforeEach(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
afterEach(() => { TestBed.resetTestingModule(); TestBed.resetTestEnvironment(); });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
const project = (id = 'atlas') => ({ id, name: id, description: '', status: 'ready' as const, progress: 100 });
function setup(cacheOptions?: McpReadCacheOptions) {
  let updated: ((value: { params: { uri: string } }) => void) | undefined;
  const fake = {
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    getHostContext: () => ({ theme: 'light', locale: 'en-US', displayMode: 'inline' }),
    getHostCapabilities: () => ({ serverTools: {}, serverResources: {}, updateModelContext: {}, experimental: { 'openai/resource': {} } }),
    getHostVersion: () => ({ name: 'test', version: '1' }),
    callServerTool: vi.fn(async (_params: { name: string; arguments?: Record<string, unknown> }, _options?: { signal?: AbortSignal }): Promise<ToolResult> => ({ content: [], structuredContent: { project: project() } })),
    updateModelContext: vi.fn(async (_params: unknown): Promise<{ _meta?: Record<string, unknown> }> => ({})),
    readServerResource: vi.fn(async ({ uri }: { uri: string }, _options?: { signal?: AbortSignal }) => ({ contents: [{ uri, text: 'Original', _meta: { 'openai/resource': { writable: true, etag: 'v1' } } }] })),
    request: vi.fn(async (_request: { method: string; params?: Record<string, unknown> }): Promise<unknown> => ({})),
    setNotificationHandler: vi.fn((_method: string, callback: typeof updated) => { updated = callback; }),
    removeNotificationHandler: vi.fn(),
  };
  TestBed.configureTestingModule({ providers: [
    provideZonelessChangeDetection(), { provide: DOCUMENT, useValue: { getElementById: () => null } },
    { provide: TestComponentRenderer, useValue: { insertRootElement() {}, removeAllRootElements() {} } },
    { provide: PLATFORM_ID, useValue: 'browser' }, McpBridge,
    { provide: BRIDGE_OPTIONS, useValue: { name: 'runtime-test', transportFactory: () => fake as unknown as BridgeTransport } },
    ...(cacheOptions ? [provideMcpReadCache(cacheOptions)] : []),
  ] });
  return { fake, bridge: TestBed.inject(McpBridge), updated: (uri: string) => updated?.({ params: { uri } }) };
}
async function settled(assertion: () => void) {
  await vi.waitFor(() => { TestBed.tick(); assertion(); }, { interval: 1 });
}

describe('native Angular resource composition', () => {
  it('chains resources without a premature tool call and propagates dependency failure', async () => {
    const { bridge, fake } = setup(); await bridge.connect();
    const input = deferred<string>();
    const upstream = TestBed.runInInjectionContext(() => resource({ loader: () => input.promise }));
    const downstream = TestBed.runInInjectionContext(() => createToolClient(tools).resource('get_project', {
      params: ({ chain }) => { const id = chain(upstream); return id ? { id } : undefined; }, debugName: 'project details',
    }));
    TestBed.tick(); expect(fake.callServerTool).not.toHaveBeenCalled();
    input.resolve('atlas');
    await settled(() => expect(downstream.value()?.project.id).toBe('atlas'));
    expect(fake.callServerTool).toHaveBeenCalledWith({ name: 'get_project', arguments: { id: 'atlas' } }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const failed = TestBed.runInInjectionContext(() => resource<string, unknown>({ loader: () => Promise.reject(new Error('Dependency failed')) }));
    const dependent = TestBed.runInInjectionContext(() => createToolClient(tools).resource('get_project', { params: ({ chain }) => { const id = chain(failed); return id ? { id } : undefined; } }));
    await settled(() => expect(dependent.error()).toMatchObject({ message: 'Dependency error', cause: { message: 'Dependency failed' } }));
    expect(fake.callServerTool).toHaveBeenCalledTimes(1);
  });
  it('retains previous values through loading/errors and clears them on an explicit scope reset', () => {
    setup();
    const snapshot = signal<ResourceSnapshot<string | undefined>>({ status: 'resolved', value: 'atlas' });
    const scope = signal('alice');
    const retained = TestBed.runInInjectionContext(() => retainedResourceValue(resourceFromSnapshots(snapshot), { resetKey: scope }));
    expect(retained()).toBe('atlas');
    snapshot.set({ status: 'loading', value: undefined }); expect(retained()).toBe('atlas');
    snapshot.set({ status: 'error', error: new Error('offline') }); expect(retained()).toBe('atlas');
    scope.set('bob'); expect(retained()).toBeUndefined();
    snapshot.set({ status: 'resolved', value: 'bob-project' }); expect(retained()).toBe('bob-project');
  });
});

describe('scoped read sharing', () => {
  it('shares a request while individual consumer cancellation leaves the remaining reader active', async () => {
    const { bridge } = setup({ scope: () => 'alice' }); await bridge.connect();
    const cache = TestBed.inject(MCP_READ_CACHE); const result = deferred<{ value: string }>();
    const load = vi.fn((_signal: AbortSignal) => result.promise);
    const first = new AbortController(), second = new AbortController();
    const a = cache.read(bridge, 'tool:read', 'same', load, first.signal);
    const b = cache.read(bridge, 'tool:read', 'same', load, second.signal);
    const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    first.abort(); await rejected;
    expect(load).toHaveBeenCalledOnce(); expect(load.mock.calls[0][0].aborted).toBe(false);
    result.resolve({ value: 'safe' }); expect(await b).toEqual({ value: 'safe' });
  });
  it('cancels the shared transport when its last consumer leaves and allows a fresh request', async () => {
    const { bridge } = setup({ scope: () => 'alice' }); await bridge.connect();
    const cache = TestBed.inject(MCP_READ_CACHE), controller = new AbortController();
    let underlying!: AbortSignal;
    const read = cache.read(bridge, 'tool:read', 'same', async signal => { underlying = signal; return new Promise<string>(() => {}); }, controller.signal);
    await Promise.resolve(); const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await rejected;
    expect(underlying.aborted).toBe(true);
    await expect(cache.read(bridge, 'tool:read', 'same', async () => 'fresh', new AbortController().signal)).resolves.toBe('fresh');
  });
  it('keeps evicted in-flight reads under injector lifecycle ownership', async () => {
    const { bridge } = setup({ scope: () => 'alice', maxEntries: 1 }); await bridge.connect();
    const cache = TestBed.inject(MCP_READ_CACHE), signals: AbortSignal[] = [];
    const load = async (signal: AbortSignal) => { signals.push(signal); return new Promise<string>(() => {}); };
    const a = cache.read(bridge, 'tool:read', 'a', load, new AbortController().signal);
    const b = cache.read(bridge, 'tool:read', 'b', load, new AbortController().signal);
    const rejected = Promise.all([expect(a).rejects.toMatchObject({ name: 'AbortError' }), expect(b).rejects.toMatchObject({ name: 'AbortError' })]);
    await Promise.resolve(); TestBed.resetTestingModule(); await rejected;
    expect(signals).toHaveLength(2); expect(signals.every(signal => signal.aborted)).toBe(true);
  });
  it('partitions completed reads by authorization and connection, and clones consumer results', async () => {
    const scope = signal('alice'); const { bridge } = setup({ scope, ttlMs: 60_000 }); await bridge.connect();
    const cache = TestBed.inject(MCP_READ_CACHE), load = vi.fn(async () => ({ owner: scope() }));
    const read = () => cache.read(bridge, 'tool:read', 'same', load, new AbortController().signal);
    const first = await read(); first.owner = 'tampered';
    expect(await read()).toEqual({ owner: 'alice' }); expect(load).toHaveBeenCalledOnce();
    scope.set('bob'); expect(await read()).toEqual({ owner: 'bob' });
    await bridge.reconnect(); expect(await read()).toEqual({ owner: 'bob' }); expect(load).toHaveBeenCalledTimes(3);
  });
  it('aborts evicted pending reads when authorization changes or a connection closes', async () => {
    const scope = signal('alice'); const { bridge } = setup({ scope, maxEntries: 1 }); await bridge.connect();
    const cache = TestBed.inject(MCP_READ_CACHE);
    const load = (_signal: AbortSignal) => new Promise<string>(() => {});
    const a = cache.read(bridge, 'tool:read', 'a', load, new AbortController().signal);
    const b = cache.read(bridge, 'tool:read', 'b', load, new AbortController().signal);
    const denied = Promise.all([expect(a).rejects.toMatchObject({ name: 'AbortError' }), expect(b).rejects.toMatchObject({ name: 'AbortError' })]);
    TestBed.tick(); scope.set('bob'); TestBed.tick(); await denied;
    const c = cache.read(bridge, 'tool:read', 'c', load, new AbortController().signal);
    const disconnected = expect(c).rejects.toMatchObject({ name: 'AbortError' });
    await bridge.disconnect(); TestBed.tick(); await disconnected;
  });
  it('expires positive TTL results and never caches errors', async () => {
    const { bridge } = setup({ scope: () => 'alice', ttlMs: 10 }); await bridge.connect();
    const cache = TestBed.inject(MCP_READ_CACHE), load = vi.fn(async () => 'first');
    let now = 100; const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const read = () => cache.read(bridge, 'tool:read', 'same', load, new AbortController().signal);
      expect(await read()).toBe('first'); now = 109; expect(await read()).toBe('first'); expect(load).toHaveBeenCalledOnce();
      now = 110; load.mockRejectedValueOnce(new Error('temporary')); await expect(read()).rejects.toThrow('temporary');
      load.mockResolvedValueOnce('recovered'); expect(await read()).toBe('recovered'); expect(load).toHaveBeenCalledTimes(3);
    } finally { clock.mockRestore(); }
  });
  it('deduplicates resource consumers and explicit tool invalidation reloads them', async () => {
    const { bridge, fake } = setup({ scope: () => 'demo', ttlMs: 60_000 }); await bridge.connect();
    const queries = TestBed.runInInjectionContext(() => [1, 2].map(() => createToolClient(tools).resource('get_project', { params: () => ({ id: 'atlas' }), cache: true })));
    await settled(() => { for (const query of queries) expect(query.value()?.project.id).toBe('atlas'); });
    expect(fake.callServerTool).toHaveBeenCalledOnce();
    fake.callServerTool.mockResolvedValue({ content: [], structuredContent: { project: project('updated') } });
    TestBed.runInInjectionContext(injectReadInvalidation).tool('get_project');
    await settled(() => { for (const query of queries) expect(query.value()?.project.id).toBe('updated'); });
    expect(fake.callServerTool).toHaveBeenCalledTimes(2);
  });
  it('does not resurrect an explicitly disconnected bridge through cached resources', async () => {
    const { bridge, fake } = setup({ scope: () => 'demo', ttlMs: 60_000 }); await bridge.connect();
    const query = TestBed.runInInjectionContext(() => createToolClient(tools).resource('get_project', { params: () => ({ id: 'atlas' }), cache: true }));
    await settled(() => expect(query.hasValue()).toBe(true));
    await bridge.disconnect(); TestBed.tick(); await Promise.resolve();
    expect(bridge.status()).toBe('closed'); expect(query.status()).toBe('idle'); expect(fake.connect).toHaveBeenCalledOnce();
    await bridge.connect(); await settled(() => expect(query.hasValue()).toBe(true)); expect(fake.callServerTool).toHaveBeenCalledTimes(2);
  });
});

describe('draft-safe MCP resources', () => {
  it('keeps subscribed dirty content and the original etag through refreshes and conflicts', async () => {
    const { bridge, fake, updated } = setup(); await bridge.connect();
    const file = TestBed.runInInjectionContext(() => injectFileResource({ uri: () => 'file:///note' }));
    const editor = TestBed.runInInjectionContext(() => injectResourceDraft(file));
    await settled(() => expect(editor.content()).toEqual({ text: 'Original' }));
    await settled(() => expect(file.watching()).toBe(true));
    editor.set({ text: 'My draft' });
    fake.readServerResource.mockResolvedValue({ contents: [{ uri: 'file:///note', text: 'Someone else', _meta: { 'openai/resource': { writable: true, etag: 'v2' } } }] });
    updated('file:///note');
    await settled(() => expect(file.resource.value()?.etag).toBe('v2'));
    expect(editor.content()).toEqual({ text: 'My draft' }); expect(editor.baseEtag()).toBe('v1'); expect(editor.remoteChanged()).toBe(true);
    fake.request.mockResolvedValue({ outcome: 'conflict', etag: 'v2' });
    await editor.save();
    expect(fake.request).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'openai/resources/write', params: { uri: 'file:///note', text: 'My draft', ifMatch: 'v1' } }), expect.anything());
    expect(editor.conflict()).toBe(true); expect(editor.content()).toEqual({ text: 'My draft' });
    await settled(() => expect(file.resource.isLoading()).toBe(false));
    editor.discard(); expect(editor.content()).toEqual({ text: 'Someone else' }); expect(editor.baseEtag()).toBe('v2'); expect(editor.dirty()).toBe(false);
  });
  it('manual reload bypasses a positive file cache TTL while keeping the unsaved draft', async () => {
    const { bridge, fake } = setup({ scope: () => 'demo', ttlMs: 60_000 }); await bridge.connect();
    const file = TestBed.runInInjectionContext(() => injectFileResource({ uri: () => 'file:///note', watch: false, cache: true }));
    const editor = TestBed.runInInjectionContext(() => injectResourceDraft(file));
    await settled(() => expect(file.resource.hasValue()).toBe(true)); editor.set({ text: 'Draft' });
    fake.readServerResource.mockResolvedValue({ contents: [{ uri: 'file:///note', text: 'Remote', _meta: { 'openai/resource': { writable: true, etag: 'v2' } } }] });
    editor.reload(); await settled(() => expect(file.resource.value()?.etag).toBe('v2'));
    expect(fake.readServerResource).toHaveBeenCalledTimes(2); expect(editor.content()).toEqual({ text: 'Draft' }); expect(editor.baseEtag()).toBe('v1');
  });
  it('does not apply an old save completion to a newly selected clean resource', async () => {
    const { bridge, fake } = setup(); await bridge.connect(); const uri = signal('file:///a');
    const file = TestBed.runInInjectionContext(() => injectFileResource({ uri, watch: false }));
    const editor = TestBed.runInInjectionContext(() => injectResourceDraft(file));
    await settled(() => expect(editor.baseEtag()).toBe('v1'));
    const pending = deferred<unknown>(); fake.request.mockImplementation(() => pending.promise);
    const save = editor.save();
    fake.readServerResource.mockResolvedValue({ contents: [{ uri: 'file:///b', text: 'B', _meta: { 'openai/resource': { writable: true, etag: 'b1' } } }] });
    uri.set('file:///b'); await settled(() => expect(editor.content()).toEqual({ text: 'B' }));
    pending.resolve({ outcome: 'saved', etag: 'a2' }); await save;
    expect(editor.content()).toEqual({ text: 'B' }); expect(editor.baseEtag()).toBe('b1'); expect(editor.canSave()).toBe(true);
  });
  it('keeps edits made during a save dirty against the acknowledged version', async () => {
    const { bridge, fake } = setup(); await bridge.connect();
    const file = TestBed.runInInjectionContext(() => injectFileResource({ uri: () => 'file:///note', watch: false }));
    const editor = TestBed.runInInjectionContext(() => injectResourceDraft(file));
    await settled(() => expect(editor.baseEtag()).toBe('v1'));
    editor.set({ text: 'Submitted' }); const pending = deferred<unknown>(); fake.request.mockImplementation(() => pending.promise);
    const save = editor.save(); editor.set({ text: 'Edited later' });
    fake.readServerResource.mockResolvedValue({ contents: [{ uri: 'file:///note', text: 'Submitted', _meta: { 'openai/resource': { writable: true, etag: 'v2' } } }] });
    pending.resolve({ outcome: 'saved', etag: 'v2' }); await save;
    await settled(() => expect(file.resource.value()?.etag).toBe('v2'));
    expect(editor.content()).toEqual({ text: 'Edited later' }); expect(editor.baseEtag()).toBe('v2'); expect(editor.dirty()).toBe(true);
  });
  it('rejects saving an old dirty draft after selection changes', async () => {
    const { bridge, fake } = setup(); await bridge.connect(); const uri = signal('file:///a');
    const file = TestBed.runInInjectionContext(() => injectFileResource({ uri, watch: false }));
    const editor = TestBed.runInInjectionContext(() => injectResourceDraft(file));
    await settled(() => expect(editor.baseEtag()).toBe('v1')); editor.set({ text: 'A draft' });
    uri.set('file:///b'); await expect(editor.save()).rejects.toThrow('selected resource changed');
    expect(fake.request).not.toHaveBeenCalled(); expect(editor.content()).toEqual({ text: 'A draft' });
  });
});

describe('bridge-wide context coalescing', () => {
  it('acknowledges every simultaneous writer with one merged request and skips equivalent snapshots', async () => {
    const { bridge, fake } = setup(); await bridge.connect();
    fake.updateModelContext.mockResolvedValue({ _meta: { 'openai/modelContext': { updateId: 'u1' } } });
    const results = await Promise.all([
      bridge.setModelContext({ structuredContent: { project: 'atlas' } }),
      bridge.setModelContextContribution('selection', { structuredContent: { selected: true } }),
      bridge.setModelContextContribution('description', { content: [{ type: 'text', text: 'Visible' }] }),
    ]);
    expect(results).toEqual(['u1', 'u1', 'u1']); expect(fake.updateModelContext).toHaveBeenCalledOnce();
    await bridge.setModelContext({ structuredContent: { project: 'atlas' } });
    expect(fake.updateModelContext).toHaveBeenCalledOnce();
    await bridge.reconnect(); await bridge.setModelContext({ structuredContent: { project: 'atlas' } });
    expect(fake.updateModelContext).toHaveBeenCalledTimes(2);
  });
  it('sends the newest update arriving during an in-flight acknowledgment', async () => {
    const { bridge, fake } = setup(); await bridge.connect();
    const first = deferred<{ _meta?: Record<string, unknown> }>(); fake.updateModelContext.mockImplementationOnce(() => first.promise);
    const a = bridge.updateModelContext({ selected: 'a' });
    await vi.waitFor(() => expect(fake.updateModelContext).toHaveBeenCalledOnce());
    const b = bridge.updateModelContext({ selected: 'b' }); first.resolve({}); await Promise.all([a, b]);
    expect(fake.updateModelContext).toHaveBeenCalledTimes(2); expect(fake.updateModelContext).toHaveBeenLastCalledWith({ structuredContent: { selected: 'b' } });
  });
  it('rejects all failed writers and never resurrects an earlier failed version', async () => {
    const { bridge, fake } = setup(); await bridge.connect();
    fake.updateModelContext.mockRejectedValueOnce(new Error('Host rejected context'));
    const a = bridge.updateModelContext({ invalid: 'a' }), b = bridge.updateModelContext({ invalid: 'b' });
    await Promise.all([expect(a).rejects.toThrow('Host rejected'), expect(b).rejects.toThrow('Host rejected')]);
    await bridge.setModelContextContribution('valid', { structuredContent: { ok: true } });
    expect(fake.updateModelContext).toHaveBeenLastCalledWith({ structuredContent: { ok: true } });
  });
  it('rejects pending writers promptly on disconnect and allows new writes on the next connection', async () => {
    const { bridge, fake } = setup(); await bridge.connect();
    const hung = deferred<{ _meta?: Record<string, unknown> }>(); fake.updateModelContext.mockImplementationOnce(() => hung.promise);
    const write = bridge.updateModelContext({ old: true }); const rejected = expect(write).rejects.toThrow('disconnected');
    await vi.waitFor(() => expect(fake.updateModelContext).toHaveBeenCalledOnce()); await bridge.disconnect(); await rejected;
    await bridge.connect(); await bridge.updateModelContext({ new: true });
    expect(fake.updateModelContext).toHaveBeenLastCalledWith({ structuredContent: { new: true } });
    hung.resolve({}); await Promise.resolve();
  });
});
