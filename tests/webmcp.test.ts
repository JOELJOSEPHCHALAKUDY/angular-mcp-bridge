import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import { registerWebMcpTools, webMcpSupported, type WebMcpModelContext, type WebMcpToolDescriptor } from '../apps/workbench/src/webmcp.js';

const search: Tool = { name: 'search', description: 'Search projects.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } };
function adapter() {
  const descriptors: WebMcpToolDescriptor[] = [];
  const signals: AbortSignal[] = [];
  const context: WebMcpModelContext = { registerTool: vi.fn(async (tool, options) => { descriptors.push(tool); signals.push(options.signal); }) };
  return { descriptors, signals, context };
}
describe('experimental WebMCP workbench adapter', () => {
  it('does nothing without explicit opt-in or browser support', async () => {
    const host = adapter(), callTool = vi.fn();
    const disabled = await registerWebMcpTools({ tools: [search], callTool, modelContext: host.context });
    expect(disabled.supported).toBe(true); expect(disabled.registered).toEqual([]); expect(host.context.registerTool).not.toHaveBeenCalled();
    expect((await registerWebMcpTools({ enabled: true, tools: [search], callTool, modelContext: null })).supported).toBe(false);
    expect(webMcpSupported()).toBe(false); expect(callTool).not.toHaveBeenCalled();
    disabled.close(); disabled.close();
  });
  it('registers model-visible tools with their actual schemas and forwards browser arguments', async () => {
    const host = adapter(), callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Found.' }], structuredContent: { count: 1 }, _meta: { secret: 'private' } }));
    const hidden = { ...search, name: 'settings', _meta: { ui: { visibility: ['app'] } } };
    const registration = await registerWebMcpTools({ enabled: true, tools: [search, hidden], callTool, modelContext: host.context });
    expect(registration.registered).toEqual(['search']);
    expect(host.descriptors[0]).toMatchObject({ name: 'search', description: search.description, inputSchema: search.inputSchema, annotations: { readOnlyHint: true, debugging: true } });
    const response = await host.descriptors[0].execute({ query: 'angular' });
    expect(callTool).toHaveBeenCalledWith('search', { query: 'angular' }, { signal: host.signals[0] });
    expect(response).toEqual({ content: [{ type: 'text', text: 'Found.' }], structuredContent: { count: 1 } });
    expect(response).not.toHaveProperty('_meta'); registration.close();
  });
  it('provides a valid description when the server tool omits one and preserves tool errors', async () => {
    const host = adapter();
    await registerWebMcpTools({ enabled: true, tools: [{ ...search, description: undefined }], modelContext: host.context,
      callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'Denied.' }] }) });
    expect(host.descriptors[0].description).toContain('search');
    expect(await host.descriptors[0].execute({ query: 'x' })).toEqual({ isError: true, content: [{ type: 'text', text: 'Denied.' }] });
  });
  it('cancels registration and rejects future and in-flight execution when the owner closes', async () => {
    const host = adapter(), owner = new AbortController();
    let executionSignal: AbortSignal | undefined;
    const callTool = vi.fn((_name, _input, options) => { executionSignal = options.signal; return new Promise<never>(() => {}); });
    const registration = await registerWebMcpTools({ enabled: true, tools: [search], callTool, modelContext: host.context, signal: owner.signal });
    const pending = host.descriptors[0].execute({ query: 'angular' });
    owner.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.signals[0].aborted).toBe(true); expect(executionSignal?.aborted).toBe(true);
    await expect(host.descriptors[0].execute({ query: 'again' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(callTool).toHaveBeenCalledTimes(1); registration.close();
  });
  it('propagates browser execution cancellation without unregistering the other tools', async () => {
    const host = adapter(), cancellation = new AbortController();
    let signal: AbortSignal | undefined;
    const registration = await registerWebMcpTools({ enabled: true, tools: [search], modelContext: host.context,
      callTool: (_name, _input, options) => { signal = options.signal; return new Promise<never>(() => {}); } });
    const pending = host.descriptors[0].execute({ query: 'x' }, { signal: cancellation.signal });
    cancellation.abort(new Error('Browser cancelled.'));
    await expect(pending).rejects.toThrow('Browser cancelled.'); expect(signal?.aborted).toBe(true); expect(host.signals[0].aborted).toBe(false); registration.close();
  });
  it('cleans up partial registrations after a browser failure', async () => {
    const host = adapter();
    vi.mocked(host.context.registerTool).mockImplementationOnce(async (tool, options) => { host.descriptors.push(tool); host.signals.push(options.signal); }).mockRejectedValueOnce(new Error('Name already registered.'));
    await expect(registerWebMcpTools({ enabled: true, tools: [search, { ...search, name: 'other' }], callTool: vi.fn(), modelContext: host.context })).rejects.toThrow('Name already registered.');
    expect(host.signals[0].aborted).toBe(true);
  });
  it('rejects duplicate names before registration and observes an already-cancelled owner', async () => {
    const host = adapter(), owner = new AbortController();
    await expect(registerWebMcpTools({ enabled: true, tools: [search, search], callTool: vi.fn(), modelContext: host.context })).rejects.toThrow('Duplicate');
    expect(host.context.registerTool).not.toHaveBeenCalled();
    owner.abort();
    expect((await registerWebMcpTools({ enabled: true, tools: [search], callTool: vi.fn(), modelContext: host.context, signal: owner.signal })).registered).toEqual([]);
    expect(host.context.registerTool).not.toHaveBeenCalled();
  });
  it('does not hang when its owner cancels an unfinished browser registration', async () => {
    const owner = new AbortController(), host = adapter();
    vi.mocked(host.context.registerTool).mockImplementation(async (_tool, options) => { host.signals.push(options.signal); await new Promise(() => {}); });
    const pending = registerWebMcpTools({ enabled: true, tools: [search], callTool: vi.fn(), modelContext: host.context, signal: owner.signal });
    owner.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(host.signals[0].aborted).toBe(true);
  });
});
