import '@angular/compiler';
import { createEnvironmentInjector, EnvironmentInjector, Injector, PLATFORM_ID } from '@angular/core';
import { App } from '@modelcontextprotocol/ext-apps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_OPTIONS, CHATGPT_EXTENSIONS, McpBridge, createTransport } from '@angular-mcp-bridge/angular';
import { isLegacyAppsSdkHost, LegacyAppsSdkTransport, LegacyTransportError, type LegacyAppsSdkHost } from '../packages/angular/src/legacy-transport.js';

const injectors: EnvironmentInjector[] = [];
afterEach(() => { for (const injector of injectors.splice(0)) if (!injector.destroyed) injector.destroy(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture(overrides: Partial<LegacyAppsSdkHost> = {}) {
  const host: LegacyAppsSdkHost = {
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'Done' }], structuredContent: { value: 2 }, meta: { secret: 'private' } })),
    sendFollowUpMessage: vi.fn(async () => {}), openExternal: vi.fn(), requestDisplayMode: vi.fn(async ({ mode }) => ({ mode })), requestClose: vi.fn(async () => {}),
    setWidgetState: vi.fn(async () => {}), widgetState: { modelContent: { prior: true }, privateContent: { preserved: true }, imageIds: ['image-1'] },
    theme: 'dark', locale: 'fr_FR', displayMode: 'inline', maxHeight: 700,
    userAgent: { device: { type: 'mobile' }, capabilities: { hover: false, touch: true } }, safeArea: { insets: { top: 3, bottom: 8, left: 0, right: 0 } },
    toolInput: { value: 1 }, toolOutput: { value: 1 }, toolResponseMetadata: { initial: true }, ...overrides,
  };
  const events = new EventTarget(); const browser = Object.assign(events, { openai: host, parent: undefined as unknown }); browser.parent = browser;
  vi.stubGlobal('window', browser);
  const injector = createEnvironmentInjector([{ provide: PLATFORM_ID, useValue: 'browser' }, { provide: BRIDGE_OPTIONS, useValue: { name: 'legacy-test' } }, { provide: CHATGPT_EXTENSIONS, useValue: host }, McpBridge], Injector.NULL as EnvironmentInjector);
  injectors.push(injector);
  return { host, events, injector, bridge: injector.get(McpBridge), changed(globals: Record<string, unknown>) { const event = new Event('openai:set_globals'); Object.defineProperty(event, 'detail', { value: { globals } }); events.dispatchEvent(event); } };
}

describe('Angular Apps SDK host compatibility', () => {
  it('selects a usable legacy host and initializes Angular signals without requiring an iframe handshake', async () => {
    const { bridge, host } = fixture();
    expect(isLegacyAppsSdkHost(host)).toBe(true); expect(createTransport({ name: 'legacy' })).toBeInstanceOf(LegacyAppsSdkTransport);
    await bridge.connect(); expect(bridge.connected()).toBe(true);
    expect(bridge.hostInfo()).toMatchObject({ name: 'chatgpt', version: 'apps-sdk' });
    expect(bridge.theme()).toBe('dark'); expect(bridge.user()).toMatchObject({ locale: 'fr-FR', device: { type: 'mobile' }, capabilities: { touch: true } });
    expect(bridge.viewport()).toMatchObject({ maxHeight: 700, safeArea: { insets: { top: 3, bottom: 8 } } });
    expect(bridge.toolInput()).toEqual({ value: 1 }); expect(bridge.toolOutput()).toEqual({ value: 1 }); expect(bridge.toolMetadata()).toEqual({ initial: true });
    expect(bridge.capabilities()).not.toHaveProperty('serverResources'); expect(bridge.capabilities()).not.toHaveProperty('experimental');
  });
  it('retains the official transport for standard hosts and extension objects without a callable tool surface', () => {
    vi.stubGlobal('window', { openai: { uploadFile() {} } });
    expect(isLegacyAppsSdkHost()).toBe(false); expect(createTransport({ name: 'standard' })).toBeInstanceOf(App);
    vi.stubGlobal('window', { openai: { callTool: true } }); expect(isLegacyAppsSdkHost()).toBe(false);
  });
  it('prefers a responding standard host even when modern ChatGPT exposes the legacy overlay', async () => {
    const { host, events } = fixture(); (window as unknown as { parent: unknown }).parent = {};
    const standardConnect = vi.spyOn(App.prototype, 'connect').mockResolvedValue();
    const standardClose = vi.spyOn(App.prototype, 'close').mockResolvedValue();
    vi.spyOn(App.prototype, 'getHostCapabilities').mockReturnValue({ serverTools: {}, serverResources: {}, message: { text: {}, image: {} }, updateModelContext: {} });
    vi.spyOn(App.prototype, 'getHostVersion').mockReturnValue({ name: 'modern-chatgpt', version: '2' });
    const transport = createTransport({ name: 'modern', legacyProbeTimeoutMs: 5 });
    await transport.connect(); expect(standardConnect).toHaveBeenCalledOnce(); expect(transport.getHostVersion()?.name).toBe('modern-chatgpt');
    expect(transport.getHostCapabilities()).toHaveProperty('serverResources'); expect(transport.getHostCapabilities()?.message).toHaveProperty('image');
    expect(transport.registerTool).toBeTypeOf('function'); expect(transport.readServerResource).toBeTypeOf('function'); expect(host.callTool).not.toHaveBeenCalled();
    await transport.close(); expect(standardClose).toHaveBeenCalledOnce();
    expect(events).toBeInstanceOf(EventTarget);
  });
  it('falls back only after a bounded unanswered standard probe, preserving an explicit handshake rejection', async () => {
    fixture(); (window as unknown as { parent: unknown }).parent = {};
    vi.spyOn(App.prototype, 'connect').mockImplementation(() => new Promise(() => {}));
    const close = vi.spyOn(App.prototype, 'close').mockResolvedValue();
    const transport = createTransport({ name: 'fallback', legacyProbeTimeoutMs: 1 });
    await transport.connect(); expect(close).toHaveBeenCalledOnce(); expect(transport.getHostVersion()?.version).toBe('apps-sdk');
    expect(transport.getHostCapabilities()).not.toHaveProperty('serverResources'); await transport.close();
    vi.spyOn(App.prototype, 'connect').mockRejectedValue(new Error('Host explicitly rejected initialization'));
    const rejected = createTransport({ name: 'rejected', legacyProbeTimeoutMs: 5 });
    await expect(rejected.connect()).rejects.toThrow('explicitly rejected'); expect(rejected.getHostVersion()?.version).not.toBe('apps-sdk'); await rejected.close();
    expect(() => createTransport({ name: 'invalid-probe', connectTimeoutMs: 1, legacyProbeTimeoutMs: 1 })).toThrow('shorter');
  });
  it('validates globals changes, propagates host input/output and removes listeners after destruction', async () => {
    const { bridge, changed, injector } = fixture(); await bridge.connect();
    changed({ theme: 'light', locale: 'de-DE', toolInput: { value: 3 }, toolOutput: { value: 4 }, toolResponseMetadata: { next: true } });
    expect(bridge.theme()).toBe('light'); expect(bridge.locale()).toBe('de-DE'); expect(bridge.toolInput()).toEqual({ value: 3 }); expect(bridge.toolOutput()).toEqual({ value: 4 });
    changed({ theme: 'invalid', maxHeight: -1, toolOutput: 'invalid', locale: 'it-IT' });
    expect(bridge.theme()).toBe('light'); expect(bridge.locale()).toBe('it-IT'); expect(bridge.toolOutput()).toEqual({ value: 4 }); expect(bridge.error()).toBeInstanceOf(LegacyTransportError);
    changed({ toolOutput: null }); expect(bridge.toolOutput()).toBeNull();
    injector.destroy(); changed({ theme: 'dark', toolOutput: { value: 99 } });
    expect(bridge.status()).toBe('closed'); expect(bridge.toolOutput()).toBeNull();
  });
  it('calls host tools, maps private metadata and supports only supplied text/link/display/dismissal methods', async () => {
    const { bridge, host } = fixture();
    expect(await bridge.callTool('update', { value: 2 })).toMatchObject({ structuredContent: { value: 2 }, _meta: { secret: 'private' } });
    expect(host.callTool).toHaveBeenCalledWith('update', { value: 2 });
    await bridge.sendMessage('Discuss selection'); expect(host.sendFollowUpMessage).toHaveBeenCalledWith({ prompt: 'Discuss selection' });
    await bridge.requestDisplayMode('fullscreen'); expect(bridge.displayMode()).toBe('fullscreen');
    await bridge.openLink('https://example.com'); expect(host.openExternal).toHaveBeenCalledWith({ href: 'https://example.com/' });
    await bridge.requestClose(); expect(host.requestClose).toHaveBeenCalledOnce(); expect(bridge.connected()).toBe(true);
    await expect(bridge.sendMessage([{ type: 'image', data: 'AA==', mimeType: 'image/png' }])).rejects.toMatchObject({ code: 'unsupported' });
    await expect(bridge.sendMessage('New conversation', { target: 'new' })).rejects.toThrow('new conversation');
    await expect(bridge.readResource('file:///notes')).rejects.toThrow('resource reads');
    await expect(bridge.requestSize({ height: 300 })).rejects.toThrow(/size|sizing/i);
    host.callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 99 }] }));
    await expect(bridge.callTool('invalid', {})).rejects.toMatchObject({ code: 'invalid-host-data' });
  });
  it('serializes model context with private widget state and preserves uploaded image IDs while acknowledgements lag', async () => {
    const { bridge, host } = fixture(); await bridge.connect();
    await Promise.all([
      bridge.updateModelContext({ selected: 'one' }),
      bridge.updateWidgetState(previous => ({ ...previous, privateContent: { ...(previous['privateContent'] as Record<string, unknown>), edited: true } })),
    ]);
    const current = bridge.getWidgetState();
    expect(current).toEqual({ modelContent: { structuredContent: { selected: 'one' } }, privateContent: { preserved: true, edited: true }, imageIds: ['image-1'] });
    expect(host.setWidgetState).toHaveBeenLastCalledWith(current); expect(host.widgetState).toHaveProperty('modelContent', { prior: true });
    await bridge.setModelContext({ content: [{ type: 'text', text: 'Context' }], structuredContent: { count: 1 } });
    expect(bridge.getWidgetState()['modelContent']).toEqual({ content: [{ type: 'text', text: 'Context' }], structuredContent: { count: 1 } });
  });
  it('settles cancellation, timeout and closed requests without claiming it can cancel host-side work', async () => {
    const { host, events } = fixture({ callTool: () => new Promise(() => {}) });
    const transport = new LegacyAppsSdkTransport(host, events); await transport.connect();
    const controller = new AbortController(); const aborted = transport.callServerTool({ name: 'wait', arguments: {} }, { signal: controller.signal }); controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'aborted' });
    await expect(transport.callServerTool({ name: 'wait', arguments: {} }, { timeout: 1 })).rejects.toMatchObject({ code: 'timeout' });
    const pending = transport.callServerTool({ name: 'wait', arguments: {} }); await transport.close();
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
    await expect(transport.callServerTool({ name: 'wait', arguments: {} })).rejects.toMatchObject({ code: 'closed' });
    await expect(transport.connect()).rejects.toMatchObject({ code: 'closed' });
    const unavailable = new LegacyAppsSdkTransport({ callTool: async () => ({ content: [] }) }, events); await unavailable.connect();
    expect(unavailable.getHostCapabilities()).toEqual({ serverTools: {} });
    await expect(unavailable.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Hello' }] })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(unavailable.updateModelContext({ structuredContent: {} })).rejects.toMatchObject({ code: 'unsupported' }); await unavailable.close();
  });
});
