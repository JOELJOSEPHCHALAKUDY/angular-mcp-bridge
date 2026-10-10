import '@angular/compiler';
import { createEnvironmentInjector, EnvironmentInjector, Injector, PLATFORM_ID, runInInjectionContext } from '@angular/core';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { BRIDGE_OPTIONS, McpBridge, createToolClient, injectViewState, type BridgeTransport, type ToolResult, VIEW_STATE_STORE } from '@angular-mcp-bridge/angular';
import { z } from 'zod';
import { tools } from '../examples/shared/tools.js';

const injectors: EnvironmentInjector[] = [];
afterEach(() => { for (const injector of injectors.splice(0)) injector.destroy(); });
function setup(overrides: Partial<BridgeTransport> = {}, timeout = 1000) {
  const fake = {
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    getHostContext: () => ({ theme: 'light', locale: 'en-US', displayMode: 'inline', availableDisplayModes: ['inline'] }),
    getHostCapabilities: () => ({ serverTools: {}, message: { text: {} }, updateModelContext: {} }),
    getHostVersion: () => ({ name: 'test', version: '1' }),
    callServerTool: vi.fn(async () => ({ content: [], structuredContent: { project: { id: 'atlas', name: 'Atlas', description: 'Demo', status: 'ready', progress: 100 } } })),
    sendMessage: vi.fn(async () => ({})), updateModelContext: vi.fn(async () => ({})),
    requestDisplayMode: vi.fn(async () => ({ mode: 'inline' })), openLink: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as BridgeTransport;
  const injector = createEnvironmentInjector([
    { provide: PLATFORM_ID, useValue: 'browser' },
    { provide: BRIDGE_OPTIONS, useValue: { name: 'test', transportFactory: () => fake, connectTimeoutMs: timeout } }, McpBridge,
  ], Injector.NULL as EnvironmentInjector);
  injectors.push(injector);
  return { fake, injector, bridge: injector.get(McpBridge) };
}
describe('McpBridge lifecycle and isolation', () => {
  it('deduplicates handshake and receives host events as signals', async () => {
    const { bridge, fake } = setup();
    await Promise.all([bridge.connect(), bridge.connect()]);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    fake.onhostcontextchanged?.({ theme: 'dark' });
    fake.ontoolinput?.({ arguments: { status: 'ready' } });
    fake.ontoolresult?.({ content: [], structuredContent: { value: 7 }, _meta: { private: 'view only' } });
    expect(bridge.theme()).toBe('dark'); expect(bridge.toolInput()).toEqual({ status: 'ready' });
    expect(bridge.toolOutput()).toEqual({ value: 7 }); expect(bridge.toolMetadata()).toEqual({ private: 'view only' });
  });
  it('keeps separate Angular injector instances isolated', async () => {
    const first = setup(), second = setup(); await Promise.all([first.bridge.connect(), second.bridge.connect()]);
    first.fake.onhostcontextchanged?.({ theme: 'dark' });
    expect(first.bridge.theme()).toBe('dark'); expect(second.bridge.theme()).toBe('light');
    first.injector.destroy(); injectors.splice(injectors.indexOf(first.injector), 1);
    expect(first.fake.close).toHaveBeenCalledTimes(1); expect(second.fake.close).not.toHaveBeenCalled();
  });
  it('reports handshake failure and closes the transport', async () => {
    const { bridge, fake } = setup({ connect: vi.fn(async () => { throw new Error('Host refused handshake'); }) });
    await expect(bridge.connect()).rejects.toThrow('Host refused');
    expect(bridge.status()).toBe('error'); expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it('bounds a hanging handshake', async () => {
    const { bridge } = setup({ connect: () => new Promise(() => {}) }, 15);
    await expect(bridge.connect()).rejects.toThrow('timed out'); expect(bridge.status()).toBe('error');
  });
  it('does not invoke an unsupported capability', async () => {
    const { bridge, fake } = setup({ getHostCapabilities: () => ({ serverTools: {} }) });
    await expect(bridge.sendMessage('Hello')).rejects.toThrow('does not support');
    expect(fake.sendMessage).not.toHaveBeenCalled();
    await expect(bridge.requestDisplayMode('fullscreen')).rejects.toThrow('does not support');
  });
  it('preserves in-band tool errors', async () => {
    const { bridge } = setup({ callServerTool: vi.fn(async () => ({ isError: true, content: [{ type: 'text' as const, text: 'Unknown project' }] })) });
    await expect(bridge.callTool('get_project', { id: 'missing' })).rejects.toThrow('Unknown project');
  });
});
describe('typed tool calls', () => {
  it('validates inputs before calling the host and output after response', async () => {
    const { injector, fake } = setup();
    const tool = runInInjectionContext(injector, () => createToolClient(tools).inject('get_project'));
    await expect(tool.execute({ id: '' })).rejects.toThrow(); expect(fake.callServerTool).not.toHaveBeenCalled();
    await tool.execute({ id: 'atlas' }); expect(tool.data()?.project.id).toBe('atlas');
    vi.mocked(fake.callServerTool).mockResolvedValueOnce({ content: [], structuredContent: { invalid: true } });
    await expect(tool.execute({ id: 'atlas' })).rejects.toThrow(); expect(tool.status()).toBe('error');
  });
  it('prevents a late older response from overwriting the newest result', async () => {
    const pending: ((value: ToolResult) => void)[] = [];
    const { injector } = setup({ callServerTool: vi.fn(() => new Promise<ToolResult>(resolve => pending.push(resolve))) });
    const tool = runInInjectionContext(injector, () => createToolClient(tools).inject('get_project'));
    const first = tool.execute({ id: 'first' }); const second = tool.execute({ id: 'second' });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const response = (id: string): ToolResult => ({ content: [], structuredContent: { project: { id, name: id, description: '', status: 'ready', progress: 100 } } });
    pending[1](response('second')); await second;
    pending[0](response('first')); await first;
    expect(tool.data()?.project.id).toBe('second');
  });
  it('rejects reactive resources for mutating tools', () => {
    const { injector } = setup(); const mutable = { ...tools.get_project, annotations: { ...tools.get_project.annotations, readOnlyHint: false } };
    expect(() => runInInjectionContext(injector, () => createToolClient({ mutable }).resource('mutable', { params: () => ({ id: 'atlas' }) }))).toThrow('read-only');
  });
  it('keeps state private until explicitly shared', async () => {
    const { injector, fake } = setup(); const state = runInInjectionContext(injector, () => injectViewState({ selected: 'atlas' }));
    await state.set({ selected: 'waypoint' }); expect(fake.updateModelContext).not.toHaveBeenCalled();
    await state.share(); expect(fake.updateModelContext).toHaveBeenCalledWith({ structuredContent: { viewState: { selected: 'waypoint' } } });
  });
});

const stateSchema = z.object({ selected: z.string() });
describe('versioned view state', () => {
  it('requires an instance key and restoration schema for persistence', () => {
    const { injector } = setup();
    expect(() => runInInjectionContext(injector, () => injectViewState({}, { persist: true }))).toThrow('key');
    expect(() => runInInjectionContext(injector, () => injectViewState({}, { persist: true, key: 'view-1' }))).toThrow('schema');
  });
  it('restores a valid matching envelope and isolates view keys', async () => {
    const { injector } = setup();
    const saved = new Map<string, unknown>();
    const store = { read: (key: string) => saved.get(key), write: async (key: string, value: unknown) => { saved.set(key, value); } };
    const scoped = createEnvironmentInjector([{ provide: VIEW_STATE_STORE, useValue: store }], injector); injectors.push(scoped);
    const create = (key: string, version = 1) => runInInjectionContext(scoped, () => injectViewState({ selected: 'default' }, { key, version, persist: true, schema: stateSchema }));
    await create('view-one').set({ selected: 'atlas' });
    expect(create('view-one').value()).toEqual({ selected: 'atlas' });
    expect(create('view-two').value()).toEqual({ selected: 'default' });
    expect(create('view-one', 2).value()).toEqual({ selected: 'default' });
    saved.set('angular-mcp-bridge:view-one', { version: 1, value: { selected: 7 } });
    expect(create('view-one').value()).toEqual({ selected: 'default' });
  });
  it('serializes asynchronous writes to preserve the newest state', async () => {
    const { injector } = setup(); const written: unknown[] = [];
    const store = { read: () => undefined, write: async (_key: string, value: unknown) => { await new Promise(resolve => setTimeout(resolve, 5)); written.push(value); } };
    const scoped = createEnvironmentInjector([{ provide: VIEW_STATE_STORE, useValue: store }], injector); injectors.push(scoped);
    const state = runInInjectionContext(scoped, () => injectViewState({ selected: 'default' }, { key: 'one', persist: true, schema: stateSchema }));
    await Promise.all([state.set({ selected: 'first' }), state.set({ selected: 'second' })]);
    expect(written).toEqual([{ version: 1, value: { selected: 'first' } }, { version: 1, value: { selected: 'second' } }]);
  });
});
