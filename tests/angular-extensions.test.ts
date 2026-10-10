import '@angular/compiler';
import { createEnvironmentInjector, EnvironmentInjector, Injector, PLATFORM_ID, runInInjectionContext } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { App } from '@modelcontextprotocol/ext-apps';
import { BRIDGE_OPTIONS, CHATGPT_EXTENSIONS, LOCAL_MODAL_ENABLED, VIEW_CONTEXT_BRIDGE, McpBridge, McpViewContext, createToolClient, injectViewState, injectViewTool, provideMcpBridge, type BridgeTransport, type ChatGptExtensions, type HostContext, type ToolResult } from '@angular-mcp-bridge/angular';
import { tools } from '../examples/shared/tools.js';

const injectors: EnvironmentInjector[] = [];
afterEach(() => { for (const injector of injectors.splice(0)) if (!injector.destroyed) injector.destroy(); });
function setup(overrides: Partial<BridgeTransport> = {}, extensions: ChatGptExtensions = {}, localModal = false) {
  const fake = {
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    getHostContext: () => ({ theme: 'dark', locale: 'fr_FR', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], platform: 'web', safeAreaInsets: { top: 4, right: 0, bottom: 8, left: 0 }, containerDimensions: { maxHeight: 600 }, deviceCapabilities: { touch: false, hover: true } }),
    getHostCapabilities: () => ({ serverTools: {}, serverResources: {}, openLinks: {}, downloadFile: {}, message: { text: {}, image: {} }, updateModelContext: {}, experimental: { 'openai/resource': {}, 'openai/modelContext': {}, 'openai/message': {}, 'openai/files': {} } }),
    getHostVersion: () => ({ name: 'Claude', version: '2' }),
    callServerTool: vi.fn(async () => ({ content: [], structuredContent: {} })),
    sendMessage: vi.fn(async () => ({})), updateModelContext: vi.fn(async () => ({})),
    requestDisplayMode: vi.fn(async () => ({ mode: 'inline' })), openLink: vi.fn(async () => ({})),
    sendSizeChanged: vi.fn(async () => {}), requestTeardown: vi.fn(async () => {}),
    downloadFile: vi.fn(async () => ({})), request: vi.fn(async () => ({})),
    setNotificationHandler: vi.fn(),
    readServerResource: vi.fn(async ({ uri }) => ({ contents: [{ uri, text: 'Original', mimeType: 'text/plain', _meta: { 'openai/resource': { writable: true, etag: 'v1' } } }] })),
    listServerResources: vi.fn(async () => ({ resources: [{ uri: 'file:///note.txt', name: 'Note' }] })),
    ...overrides,
  } as unknown as BridgeTransport;
  const injector = createEnvironmentInjector([
    { provide: PLATFORM_ID, useValue: 'browser' },
    { provide: BRIDGE_OPTIONS, useValue: { name: 'extensions-test', transportFactory: () => fake } },
    { provide: CHATGPT_EXTENSIONS, useValue: extensions }, { provide: LOCAL_MODAL_ENABLED, useValue: localModal }, McpBridge, McpViewContext, { provide: VIEW_CONTEXT_BRIDGE, useExisting: McpBridge },
  ], Injector.NULL as EnvironmentInjector);
  injectors.push(injector);
  return { fake, injector, bridge: injector.get(McpBridge) };
}

describe('Angular host context and lifecycle', () => {
  it('normalizes host identity/locale and exposes reactive device and viewport state', async () => {
    const { bridge, fake } = setup(); await bridge.connect();
    expect(bridge.hostInfo()).toMatchObject({ name: 'claude', version: '2', openaiCapabilities: { files: true, resource: true } });
    expect(bridge.user()).toEqual({ theme: 'dark', locale: 'fr-FR', device: { type: 'desktop' }, capabilities: { touch: false, hover: true } });
    expect(bridge.viewport()).toMatchObject({ maxHeight: 600, safeArea: { insets: { top: 4, bottom: 8 } } });
    fake.onhostcontextchanged?.({ locale: 'not@valid', safeAreaInsets: { top: 0, bottom: 1, left: 2, right: 3 } });
    expect(bridge.user().locale).toBe('en-US'); expect(bridge.viewport().safeArea.insets.bottom).toBe(1);
  });
  it('validates deep links and reflected model context from live host events', async () => {
    const { bridge, fake } = setup(); await bridge.connect();
    fake.onhostcontextchanged?.({ 'openai/deepLink': { url: '/projects?status=ready' }, 'openai/modelContext': { updateId: 'u1', structuredContent: { selected: 1 } } } as HostContext);
    expect(bridge.deepLink()).toBe('/projects?status=ready'); expect(bridge.modelContext()?.updateId).toBe('u1');
    fake.onhostcontextchanged?.({ 'openai/deepLink': { url: '//evil.example' }, 'openai/modelContext': null } as HostContext);
    expect(bridge.deepLink()).toBeUndefined(); expect(bridge.modelContext()).toBeNull();
  });
  it('can retry a failed handshake and permanently closes on injector destruction', async () => {
    let fail = true;
    const { bridge, fake, injector } = setup({ connect: vi.fn(async () => { if (fail) throw new Error('offline'); }) });
    await expect(bridge.connect()).rejects.toThrow('offline');
    fail = false; await bridge.retryConnect(); expect(bridge.connected()).toBe(true); expect(fake.connect).toHaveBeenCalledTimes(2);
    await bridge.disconnect(); expect(bridge.status()).toBe('closed');
    await bridge.connect(); expect(bridge.connected()).toBe(true);
    injector.destroy(); await expect(bridge.connect()).rejects.toThrow('closed');
  });
  it('ignores notifications from an old connection after reconnecting', async () => {
    const { bridge, fake } = setup(); await bridge.connect(); const oldContextHandler = fake.onhostcontextchanged;
    await bridge.reconnect(); oldContextHandler?.({ theme: 'light' });
    expect(bridge.theme()).toBe('dark');
  });
  it('does not let a slow disconnect overwrite the newer connection status', async () => {
    let finish!: () => void;
    const { bridge } = setup({ close: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) });
    await bridge.connect(); const closing = bridge.disconnect(); await bridge.connect();
    finish(); await closing; expect(bridge.connected()).toBe(true);
  });
  it('requests host dismissal without closing the transport and sends explicit dimensions', async () => {
    const { bridge, fake } = setup();
    await bridge.requestSize({ width: 500, height: 300 }); await bridge.requestClose();
    expect(fake.sendSizeChanged).toHaveBeenCalledWith({ width: 500, height: 300 });
    expect(fake.requestTeardown).toHaveBeenCalledOnce(); expect(fake.close).not.toHaveBeenCalled();
    await expect(bridge.requestSize({ height: -1 })).rejects.toThrow('nonnegative');
  });
});

describe('rich model communication', () => {
  it('sends content blocks/new conversations and feature-detects scroll control', async () => {
    const scroll = vi.fn(async () => {}); const { bridge, fake } = setup({}, { sendFollowUpMessage: scroll });
    await bridge.sendMessage([{ type: 'text', text: 'Selected', _meta: { 'openai/title': 'A project' } }], { target: 'new' });
    expect(fake.sendMessage).toHaveBeenCalledWith({ role: 'user', content: [{ type: 'text', text: 'Selected', _meta: { 'openai/title': 'A project' } }], _meta: { 'openai/message': { target: 'new' } } });
    await bridge.sendMessage('Discuss this', { scrollToBottom: false }); expect(scroll).toHaveBeenCalledWith({ prompt: 'Discuss this', scrollToBottom: false });
    await expect(bridge.sendMessage([], { scrollToBottom: false })).rejects.toThrow('extension');
  });
  it('does not assume extensions on a standard-only host', async () => {
    const { bridge, fake } = setup({ getHostCapabilities: () => ({ message: { text: {} }, serverResources: {} }) });
    await expect(bridge.sendMessage('New', { target: 'new' })).rejects.toThrow('new conversation');
    await expect(bridge.download({ contents: [] })).rejects.toThrow('downloads');
    await expect(bridge.openFile('/note')).rejects.toThrow('file opening');
    await expect(bridge.writeResource('file:///note', { text: 'new' })).rejects.toThrow('writes');
    await expect(bridge.watchResource('file:///note', () => {})).rejects.toThrow('subscriptions');
    expect(fake.request).not.toHaveBeenCalled(); expect(fake.sendMessage).not.toHaveBeenCalled();
  });
  it('merges explicit context and independent Angular contributions and returns the host update id', async () => {
    const updateModelContext = vi.fn(async () => ({ _meta: { 'openai/modelContext': { updateId: 'attached-1' } } }));
    const { bridge } = setup({ updateModelContext });
    expect(await bridge.setModelContext({ content: [{ type: 'text', text: 'Manual' }], structuredContent: { project: 'atlas' } })).toBe('attached-1');
    await bridge.setModelContextContribution('filters', { structuredContent: { status: 'ready' } });
    expect(updateModelContext).toHaveBeenLastCalledWith({ content: [{ type: 'text', text: 'Manual' }], structuredContent: { project: 'atlas', status: 'ready' } });
    await bridge.setModelContextContribution('filters', null);
    expect(updateModelContext).toHaveBeenLastCalledWith({ content: [{ type: 'text', text: 'Manual' }], structuredContent: { project: 'atlas' } });
  });
  it('retains the application context while a view-context registry adds and removes nodes', async () => {
    const { bridge, fake, injector } = setup(); await bridge.updateModelContext({ project: 'atlas' });
    const registry = injector.get(McpViewContext); const parent = Symbol(), child = Symbol();
    registry.register({ key: parent, content: 'Visible projects' }); registry.register({ key: child, parent, content: 'Atlas' });
    await registry.flush();
    expect(fake.updateModelContext).toHaveBeenLastCalledWith({ structuredContent: { project: 'atlas', viewContext: '- Visible projects\n  - Atlas' }, content: [{ type: 'text', text: '- Visible projects\n  - Atlas', annotations: { audience: ['assistant'] } }] });
    registry.remove(parent); registry.remove(child); await registry.flush();
    expect(fake.updateModelContext).toHaveBeenLastCalledWith({ structuredContent: { project: 'atlas' } });
  });
});

describe('resource and file APIs', () => {
  it('reads metadata, forwards cancellation and discovers resources/templates', async () => {
    const { bridge, fake } = setup(); const controller = new AbortController();
    const resource = await bridge.readResource('file:///note.txt', 'text', { signal: controller.signal });
    expect(resource).toEqual({ text: 'Original', mimeType: 'text/plain', writable: true, etag: 'v1' });
    expect(fake.readServerResource).toHaveBeenCalledWith({ uri: 'file:///note.txt', _meta: { 'openai/resource': { representation: 'text' } } }, { signal: controller.signal, timeout: undefined });
    expect((await bridge.listResources()).resources).toHaveLength(1);
    await bridge.listResourceTemplates({ cursor: 'page-2' }); expect(fake.request).toHaveBeenCalledWith({ method: 'resources/templates/list', params: { cursor: 'page-2' } }, expect.anything());
  });
  it('deduplicates subscriptions and unsubscribes when the last Angular listener leaves', async () => {
    const { bridge, fake } = setup(); const first = vi.fn(), second = vi.fn();
    const stopFirst = await bridge.watchResource('file:///note', first), stopSecond = await bridge.watchResource('file:///note', second);
    expect(fake.request).toHaveBeenCalledTimes(1);
    const notify = vi.mocked(fake.setNotificationHandler!).mock.calls[0][1] as (message: { params: { uri: string } }) => void;
    notify({ params: { uri: 'file:///note' } }); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    await stopFirst(); expect(fake.request).toHaveBeenCalledTimes(1);
    await stopSecond(); expect(fake.request).toHaveBeenLastCalledWith({ method: 'resources/unsubscribe', params: { uri: 'file:///note' } }, expect.anything());
    await stopSecond(); expect(fake.request).toHaveBeenCalledTimes(2);
  });
  it('retains the new subscription when an old same-URI watcher disposes after reconnect', async () => {
    const { bridge, fake } = setup(); const oldListener = vi.fn(), currentListener = vi.fn();
    const stopOld = await bridge.watchResource('file:///note', oldListener);
    const oldNotification = vi.mocked(fake.setNotificationHandler!).mock.calls[0][1] as (message: { params: { uri: string } }) => void;
    await bridge.reconnect(); const stopCurrent = await bridge.watchResource('file:///note', currentListener);
    const currentNotification = vi.mocked(fake.setNotificationHandler!).mock.calls[1][1] as typeof oldNotification;
    await stopOld(); oldNotification({ params: { uri: 'file:///note' } });
    expect(currentListener).not.toHaveBeenCalled();
    currentNotification({ params: { uri: 'file:///note' } }); expect(currentListener).toHaveBeenCalledOnce();
    expect(fake.request).toHaveBeenCalledTimes(2); await stopCurrent(); expect(fake.request).toHaveBeenCalledTimes(3);
  });
  it('passes optimistic concurrency tokens and returns conflicts without retrying a write', async () => {
    const request = vi.fn(async () => ({ outcome: 'conflict', etag: 'v2' })); const { bridge } = setup({ request: request as unknown as BridgeTransport['request'] });
    expect(await bridge.writeResource('file:///note', { text: 'Edited' }, 'v1')).toEqual({ outcome: 'conflict', etag: 'v2' });
    expect(request).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledWith({ method: 'openai/resources/write', params: { uri: 'file:///note', text: 'Edited', ifMatch: 'v1' } }, expect.anything());
  });
  it('feature-detects native file operations and preserves/deduplicates image state', async () => {
    const extensions: ChatGptExtensions = { widgetState: { modelContent: { selection: 'atlas' }, privateContent: { draft: 'keep' }, imageIds: ['old'] },
      uploadFile: vi.fn(async () => ({ fileId: 'image-1', mimeType: 'image/png' })), selectFiles: vi.fn(async () => [{ fileId: 'image-1', mimeType: 'image/png' }]),
      getFileDownloadUrl: vi.fn(async () => ({ downloadUrl: 'https://example.com/image' })),
      setWidgetState: vi.fn(async state => { extensions.widgetState = state; }),
    };
    const { bridge } = setup({}, extensions);
    await bridge.uploadFile(new File(['image'], 'demo.png', { type: 'image/png' }), { library: true });
    await bridge.selectFiles(); expect(extensions.widgetState).toEqual({ modelContent: { selection: 'atlas' }, privateContent: { draft: 'keep' }, imageIds: ['old', 'image-1'] });
    expect(await bridge.getFileDownloadUrl({ fileId: 'image-1' })).toEqual({ downloadUrl: 'https://example.com/image' });
    await expect(setup().bridge.uploadFile(new File([], 'a'))).rejects.toThrow('upload');
  });
});

describe('Angular state, UI tools and modals', () => {
  it('provides isolated context registries for sibling Angular bridge environments', async () => {
    const parent = setup();
    const first = createEnvironmentInjector([provideMcpBridge({ name: 'first', transportFactory: () => setup().fake })], parent.injector);
    const second = createEnvironmentInjector([provideMcpBridge({ name: 'second', transportFactory: () => setup().fake })], parent.injector);
    injectors.push(first, second);
    expect(first.get(McpViewContext)).not.toBe(second.get(McpViewContext));
    expect(first.get(VIEW_CONTEXT_BRIDGE)).toBe(first.get(McpBridge));
    expect(second.get(VIEW_CONTEXT_BRIDGE)).toBe(second.get(McpBridge));
    expect(first.get(McpBridge)).not.toBe(parent.bridge);
  });
  it('preserves the original wire input when schemas transform values', async () => {
    const definition = { ...tools.get_project, input: z.object({ count: z.string().transform(Number) }), output: z.object({ count: z.number() }) };
    const { injector, fake } = setup({ callServerTool: vi.fn(async () => ({ content: [], structuredContent: { count: 3 } })) });
    const tool = runInInjectionContext(injector, () => createToolClient({ counter: definition }).inject('counter'));
    await tool.execute({ count: '3' });
    expect(fake.callServerTool).toHaveBeenCalledWith({ name: 'counter', arguments: { count: '3' } }, expect.anything());
  });
  it('has typed, validated initial tool information and clears stale output on a new invocation', async () => {
    const { bridge, fake, injector } = setup(); await bridge.connect();
    const info = runInInjectionContext(injector, () => createToolClient(tools).info('get_project', { metadataSchema: z.object({ source: z.string() }) }));
    expect(info().status).toBe('pending');
    fake.ontoolinput?.({ arguments: { id: 'atlas' } });
    fake.ontoolresult?.({ content: [], structuredContent: { project: { id: 'atlas', name: 'Atlas', description: 'Demo', status: 'ready', progress: 100 } }, _meta: { source: 'server' } });
    expect(info()).toMatchObject({ status: 'success', metadata: { source: 'server' }, output: { project: { id: 'atlas' } } });
    fake.ontoolinput?.({ arguments: { id: 'next' } }); expect(info().status).toBe('pending');
    fake.ontoolresult?.({ content: [], structuredContent: { invalid: true } }); expect(info().status).toBe('error');
  });
  it('registers runtime-validated UI tools and removes them with the Angular injector', async () => {
    const sdk = new App({ name: 'ui-tools-test', version: '1' }, { tools: {} });
    const remove = vi.fn(); let callback: (input: unknown, context: { mcpReq: { signal: AbortSignal } }) => Promise<ToolResult>;
    const registerTool = vi.fn((name, config, handler) => {
      const registered = sdk.registerTool(name, config, handler);
      callback = registered.handler as unknown as typeof callback;
      const original = registered.remove.bind(registered); registered.remove = () => { remove(); original(); };
      return registered;
    });
    const { bridge, injector } = setup({ registerTool: registerTool as unknown as BridgeTransport['registerTool'] });
    const handle = await bridge.registerViewTool('set_counter', { inputSchema: z.object({ count: z.string().transform(Number).pipe(z.number().finite()) }), outputSchema: z.object({ count: z.number() }) }, async ({ count }, signal) => { expect(signal).toBeInstanceOf(AbortSignal); return { content: [], structuredContent: { count } }; });
    const context = { mcpReq: { signal: new AbortController().signal } };
    await expect(callback!({ count: 'bad' }, context)).rejects.toThrow();
    expect((await callback!({ count: '2' }, context)).structuredContent).toEqual({ count: 2 });
    handle.disable(); injector.destroy(); handle.remove(); expect(remove).toHaveBeenCalledOnce();
  });
  it('removes a component-scoped app tool while retaining the parent bridge connection', async () => {
    const remove = vi.fn();
    const { bridge, injector } = setup({ registerTool: vi.fn(() => ({ remove, enable: vi.fn(), disable: vi.fn() })) as unknown as BridgeTransport['registerTool'] });
    const component = createEnvironmentInjector([], injector); injectors.push(component);
    const tool = runInInjectionContext(component, () => injectViewTool('select', { inputSchema: z.object({ id: z.string() }) }, ({ id }) => ({ content: [], structuredContent: { id } })));
    await tool.ready; expect(tool.status()).toBe('registered');
    component.destroy(); expect(remove).toHaveBeenCalledOnce(); expect(bridge.connected()).toBe(true);
  });
  it('keeps persisted ChatGPT state private and shares only with explicit autoShare', async () => {
    const extensions: ChatGptExtensions = { widgetState: { modelContent: { keep: true }, privateContent: { draft: 'keep' } }, setWidgetState: vi.fn(async state => { extensions.widgetState = state; }) };
    const { injector, fake } = setup({}, extensions);
    const state = runInInjectionContext(injector, () => injectViewState({ selected: 'atlas' }, { key: 'view-one', persist: true, schema: z.object({ selected: z.string() }), autoShare: true }));
    await state.set({ selected: 'studio' });
    expect(extensions.widgetState).toMatchObject({ modelContent: { keep: true }, privateContent: { draft: 'keep', angularMcpBridge: { 'angular-mcp-bridge:view-one': { version: 1, value: { selected: 'studio' } } } } });
    expect(fake.updateModelContext).toHaveBeenCalledWith({ structuredContent: { viewState: { selected: 'studio' } } });
    expect(runInInjectionContext(injector, () => injectViewState({ selected: 'default' }, { key: 'view-one', persist: true, schema: z.object({ selected: z.string() }) })).value()).toEqual({ selected: 'studio' });
  });
  it('preserves concurrent state instances and image tracking through one host write queue', async () => {
    const saved: Record<string, unknown>[] = [];
    const extensions: ChatGptExtensions = {
      widgetState: { modelContent: { keep: true }, privateContent: { draft: 'keep' } },
      uploadFile: vi.fn(async () => ({ fileId: 'image-1', mimeType: 'image/png' })),
      // Simulate a host whose globals still show the old snapshot after acknowledgement.
      setWidgetState: vi.fn(async state => { await new Promise(resolve => setTimeout(resolve, 5)); saved.push(state); }),
    };
    const { bridge, injector } = setup({}, extensions);
    const create = (key: string) => runInInjectionContext(injector, () => injectViewState({ selected: 'default' }, { key, persist: true, schema: z.object({ selected: z.string() }) }));
    const a = create('view-a'), b = create('view-b');
    await Promise.all([a.set({ selected: 'atlas' }), b.set({ selected: 'studio' }), bridge.uploadFile(new File(['image'], 'a.png', { type: 'image/png' }))]);
    expect(saved.at(-1)).toMatchObject({ modelContent: { keep: true }, imageIds: ['image-1'], privateContent: { draft: 'keep', angularMcpBridge: {
      'angular-mcp-bridge:view-a': { version: 1, value: { selected: 'atlas' } },
      'angular-mcp-bridge:view-b': { version: 1, value: { selected: 'studio' } },
    } } });
    expect(create('view-a').value()).toEqual({ selected: 'atlas' }); expect(create('view-b').value()).toEqual({ selected: 'studio' });
    expect(extensions.setWidgetState).toHaveBeenCalledTimes(3);
  });
  it('removes only the destroyed state owner while another shared state remains', async () => {
    const { injector, bridge, fake } = setup();
    const first = createEnvironmentInjector([], injector), second = createEnvironmentInjector([], injector); injectors.push(first, second);
    const a = runInInjectionContext(first, () => injectViewState({ id: 'atlas' }, { shareKey: 'selection' }));
    const b = runInInjectionContext(second, () => injectViewState({ status: 'ready' }, { shareKey: 'filters' }));
    await a.share(); await b.share();
    expect(fake.updateModelContext).toHaveBeenLastCalledWith({ structuredContent: { selection: { id: 'atlas' }, filters: { status: 'ready' } } });
    first.destroy(); await vi.waitFor(() => expect(fake.updateModelContext).toHaveBeenLastCalledWith({ structuredContent: { filters: { status: 'ready' } } }));
    expect(bridge.connected()).toBe(true); await expect(a.share()).rejects.toThrow('destroyed');
  });
  it('permanently drops destroyed view-state context while offline', async () => {
    const { injector, bridge, fake } = setup(); const component = createEnvironmentInjector([], injector); injectors.push(component);
    const state = runInInjectionContext(component, () => injectViewState({ id: 'atlas' }));
    await state.share(); await bridge.disconnect(); component.destroy(); await bridge.connect();
    await bridge.updateModelContext({ current: 'new view' });
    expect(fake.updateModelContext).toHaveBeenLastCalledWith({ structuredContent: { current: 'new view' } });
  });
  it('requires an explicit Angular local-modal provider and rejects host-only templates', async () => {
    await expect(setup().bridge.openModal({ title: 'No modal host' })).rejects.toThrow('provideLocalMcpModal');
    const { bridge } = setup({}, {}, true);
    await bridge.openModal({ title: 'Details', params: { id: 'atlas' } }); expect(bridge.display()).toEqual({ mode: 'modal', params: { id: 'atlas' } });
    bridge.closeModal(); expect(bridge.modal()).toBeNull();
    await expect(bridge.openModal({ template: 'ui://remote' })).rejects.toThrow('Angular content');
  });
  it('uses optional ChatGPT modal/link extensions only when available', async () => {
    const requestModal = vi.fn(async () => {}), setOpenInAppUrl = vi.fn(async () => {}), openExternal = vi.fn();
    const { bridge } = setup({}, { requestModal, setOpenInAppUrl, openExternal });
    await bridge.openModal({ title: 'Native', template: 'ui://native' }); expect(requestModal).toHaveBeenCalledWith({ title: 'Native', template: 'ui://native' }); expect(bridge.modal()).toBeNull();
    await bridge.setOpenInAppUrl('https://example.com/app'); expect(setOpenInAppUrl).toHaveBeenCalledWith({ href: 'https://example.com/app' });
    await bridge.openExternal('https://example.com', { redirectUrl: false }); expect(openExternal).toHaveBeenCalledWith({ href: 'https://example.com/', redirectUrl: false });
    await expect(bridge.setOpenInAppUrl('javascript:alert(1)')).rejects.toThrow('HTTP');
  });
});
