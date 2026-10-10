import '@angular/compiler';
import { createEnvironmentInjector, inject, InjectionToken, Injector, PLATFORM_ID, runInInjectionContext, type EnvironmentInjector } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, defineTools, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';
import { McpBridge } from '@angular-mcp-bridge/angular';
import { declareWebMcpTool, injectWebMcpTool, isWebMcpAvailable, provideWebMcpTools } from '@angular-mcp-bridge/angular/webmcp';

const definition = defineTool({ title: 'Search', description: 'Search local items', annotations: readOnlyAnnotations,
 input: z.object({ query: z.string().min(2).transform(value => value.trim().toUpperCase()), limit: z.number().default(5) }),
 output: z.object({ value: z.string() }),
});
const injectors: EnvironmentInjector[] = [];
afterEach(() => { for (const injector of injectors.splice(0)) if (!injector.destroyed) injector.destroy(); vi.unstubAllGlobals(); });
function environment(providers: any[] = [], platform = 'browser') {
 const injector = createEnvironmentInjector([{ provide: PLATFORM_ID, useValue: platform }, ...providers], Injector.NULL as EnvironmentInjector);
 injectors.push(injector); return injector;
}
function host() {
 const tools = new Map<string, any>(), registrations = new Map<string, AbortSignal>();
 const registerTool = vi.fn(async (tool: any, { signal }: { signal: AbortSignal }) => {
  if (tools.has(tool.name)) throw new Error('Duplicate tool');
  tools.set(tool.name, tool); registrations.set(tool.name, signal);
  signal.addEventListener('abort', () => tools.delete(tool.name), { once: true });
 });
 vi.stubGlobal('document', { modelContext: { registerTool } }); vi.stubGlobal('navigator', {});
 return { tools, registerTool, registrations, execute: (name: string, args: unknown, signal = new AbortController().signal) => tools.get(name).execute(args, { signal }) };
}
describe('Angular native browser WebMCP adapter', () => {
 it('requires opt-in and gracefully handles unsupported browsers and SSR', async () => {
  const browser = host(), injector = environment();
  const disabled = runInInjectionContext(injector, () => declareWebMcpTool('search', definition, () => ({ value: 'ok' })));
  expect(await disabled.ready).toBe(false); expect(disabled.status()).toBe('disabled'); expect(browser.registerTool).not.toHaveBeenCalled();
  vi.stubGlobal('document', {}); expect(isWebMcpAvailable()).toBe(false);
  const unsupported = runInInjectionContext(injector, () => declareWebMcpTool('search', definition, () => ({ value: 'ok' }), { enabled: true }));
  expect(await unsupported.ready).toBe(false); expect(unsupported.status()).toBe('unsupported');
  host(); const server = environment([], 'server');
  const ssr = runInInjectionContext(server, () => declareWebMcpTool('search', definition, () => ({ value: 'ok' }), { enabled: true }));
  expect(await ssr.ready).toBe(false); expect(ssr.status()).toBe('unsupported');
 });
 it('uses Angular registration and restores DI after asynchronous contract validation', async () => {
  const browser = host(), token = new InjectionToken<string>('local dependency'), injector = environment([{ provide: token, useValue: 'DI' }]);
  const handler = vi.fn((input: any) => ({ value: `${inject(token)}:${input.query}:${input.limit}` }));
  const registration = runInInjectionContext(injector, () => declareWebMcpTool('search', definition, handler, { enabled: true }));
  expect(await registration.ready).toBe(true); expect(registration.status()).toBe('ready');
  expect(browser.tools.get('search').inputSchema.required).toEqual(['query']);
  expect(browser.tools.get('search').annotations).toEqual({ readOnlyHint: true, consequentialHint: false });
  const wire = { query: ' raw ' }; const result = await browser.execute('search', wire);
  expect(handler.mock.calls[0][0]).toEqual({ query: 'RAW', limit: 5 }); expect(wire).toEqual({ query: ' raw ' });
  expect(result).toEqual({ content: [{ type: 'text', text: '{"value":"DI:RAW:5"}' }], structuredContent: { value: 'DI:RAW:5' } });
  registration.dispose(); expect(browser.registrations.get('search')?.aborted).toBe(true); expect(browser.tools.has('search')).toBe(false); expect(registration.status()).toBe('closed');
 });
 it('rejects invalid input before effects and validates local output', async () => {
  const browser = host(), injector = environment(); const handler = vi.fn(() => ({ value: 'ok' }));
  const registration = runInInjectionContext(injector, () => declareWebMcpTool('search', definition, handler, { enabled: true })); await registration.ready;
  await expect(browser.execute('search', { query: 'x' })).rejects.toThrow(); expect(handler).not.toHaveBeenCalled();
  registration.dispose();
  const invalidOutput = runInInjectionContext(injector, () => declareWebMcpTool('search', definition, () => ({ value: 2 } as any), { enabled: true })); await invalidOutput.ready;
  await expect(browser.execute('search', { query: 'good' })).rejects.toThrow(); expect(invalidOutput.status()).toBe('ready');
 });
 it('preserves server wire arguments, validates results and excludes private metadata', async () => {
  const browser = host(), callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { value: 'server' }, _meta: { private: 'secret' } }));
  const injector = environment([{ provide: McpBridge, useValue: { callTool } }]);
  const registration = runInInjectionContext(injector, () => injectWebMcpTool('search', definition, { enabled: true, timeoutMs: 1000 })); await registration.ready;
  const result = await browser.execute('search', { query: ' raw ' });
  expect(callTool.mock.calls[0]).toEqual(['search', { query: ' raw ' }, expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 1000 })]);
  expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }], structuredContent: { value: 'server' } });
  callTool.mockResolvedValueOnce({ content: [], structuredContent: { value: 'server' }, isError: true } as any);
  await expect(browser.execute('search', { query: 'good' })).rejects.toThrow('rejected');
 });
 it('cancels uncooperative handlers on client cancellation and injector teardown', async () => {
  const browser = host(), injector = environment(), handler = vi.fn(() => new Promise<{ value: string }>(() => {}));
  const registration = runInInjectionContext(injector, () => declareWebMcpTool('search', definition, handler, { enabled: true })); await registration.ready;
  const client = new AbortController(); const request = browser.execute('search', { query: 'good' }, client.signal);
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce()); client.abort(new DOMException('Cancelled', 'AbortError'));
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  const next = browser.execute('search', { query: 'good' }); await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
  injector.destroy(); await expect(next).rejects.toMatchObject({ name: 'AbortError' }); expect(registration.status()).toBe('closed'); expect(browser.tools.size).toBe(0);
 });
 it('prevents app-only tools from being exposed and reports registration errors', async () => {
  const browser = host(), injector = environment(), onError = vi.fn();
  const appOnly = defineTool({ ...definition, visibility: ['app'] });
  const hidden = runInInjectionContext(injector, () => declareWebMcpTool('hidden', appOnly, () => ({ value: 'ok' }), { enabled: true, onError }));
  expect(await hidden.ready).toBe(false); expect(hidden.error()?.message).toContain('app-only'); expect(browser.registerTool).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledOnce();
  const first = runInInjectionContext(injector, () => declareWebMcpTool('search', definition, () => ({ value: 'ok' }), { enabled: true })); await first.ready;
  const duplicate = runInInjectionContext(injector, () => declareWebMcpTool('search', definition, () => ({ value: 'other' }), { enabled: true, onError }));
  expect(await duplicate.ready).toBe(false); expect(duplicate.status()).toBe('error'); expect(browser.tools.size).toBe(1);
 });
 it('registers a selected registry through an environment initializer and cleans up its scope', async () => {
  const browser = host(), tools = defineTools({ search: definition });
  const injector = environment([provideWebMcpTools(tools, { search: input => ({ value: input.query }) }, { enabled: true })]);
  await vi.waitFor(() => expect(browser.tools.size).toBe(1)); expect((await browser.execute('search', { query: 'hello' })).structuredContent).toEqual({ value: 'HELLO' });
  injector.destroy(); expect(browser.tools.size).toBe(0);
 });
 it('prefers document modelContext and falls back to navigator when document has none', async () => {
  const primary = host(), secondary = vi.fn(async () => {}); vi.stubGlobal('navigator', { modelContext: { registerTool: secondary } });
  const injector = environment(); const first = runInInjectionContext(injector, () => declareWebMcpTool('first', definition, () => ({ value: 'ok' }), { enabled: true }));
  expect(await first.ready).toBe(true); expect(primary.registerTool).toHaveBeenCalledOnce(); expect(secondary).not.toHaveBeenCalled();
  vi.stubGlobal('document', {}); const fallback = runInInjectionContext(injector, () => declareWebMcpTool('second', definition, () => ({ value: 'ok' }), { enabled: true }));
  expect(await fallback.ready).toBe(true); expect(secondary).toHaveBeenCalledOnce();
 });
 it('settles ready promptly when destroyed during an uncooperative registration', async () => {
  let signal!: AbortSignal;
  vi.stubGlobal('document', { modelContext: { registerTool: (_tool: unknown, options: { signal: AbortSignal }) => {
   signal = options.signal; return new Promise<void>(() => {});
  } } }); vi.stubGlobal('navigator', {});
  const injector = environment();
  const registration = runInInjectionContext(injector, () => declareWebMcpTool('search', definition, () => ({ value: 'ok' }), { enabled: true }));
  expect(registration.status()).toBe('registering'); injector.destroy();
  expect(await registration.ready).toBe(false); expect(signal.aborted).toBe(true); expect(registration.status()).toBe('closed');
 });
});
