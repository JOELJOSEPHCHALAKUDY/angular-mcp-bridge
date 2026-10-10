import '@angular/compiler';
import { DOCUMENT, PLATFORM_ID, platformCore, provideZonelessChangeDetection, signal } from '@angular/core';
import { BrowserTestingModule } from '@angular/platform-browser/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';
import { McpBridge } from '@angular-mcp-bridge/angular';
import { injectToolForm, provideExperimentalWebMcpForms } from '../packages/angular/forms/public-api.js';

TestBed.initTestEnvironment(BrowserTestingModule, platformCore());
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
const definition = defineTool({ title: 'Search', description: 'Search by query', annotations: readOnlyAnnotations,
 input: z.object({ query: z.string().min(2).transform(value => value.trim().toUpperCase()), limit: z.number().default(5) }),
 output: z.object({ value: z.string() }),
});
function setup(call: ReturnType<typeof vi.fn<(...args: any[]) => Promise<any>>> = vi.fn(async () => ({ content: [], structuredContent: { value: 'found' } }))) {
 TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), { provide: DOCUMENT, useValue: { getElementById: () => null } }, { provide: PLATFORM_ID, useValue: 'browser' }, { provide: McpBridge, useValue: { callTool: call } }] });
 const tool = TestBed.runInInjectionContext(() => injectToolForm('search', definition, { query: '' }));
 return { tool, call };
}
describe('native Angular tool Signal Forms', () => {
 it('maps shared Zod issues onto native fields and refuses invalid commands', async () => {
  const { tool, call } = setup();
  expect(tool.fields.query().invalid()).toBe(true);
  expect(tool.fields.query().errors()[0].message).toContain('>=2');
  expect(await tool.submit()).toBe(false); expect(call).not.toHaveBeenCalled();
  expect(tool.fields.query().touched()).toBe(true); expect(tool.status()).toBe('invalid');
 });
 it('preserves wire inputs through transforms/defaults and exposes native submission state', async () => {
  let finish!: (value: unknown) => void;
  const call = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const { tool } = setup(call); tool.fields.query().value.set(' raw ');
  const request = tool.submit(); await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  expect(call.mock.calls[0]).toEqual(['search', { query: ' raw ' }, expect.objectContaining({ signal: expect.any(AbortSignal) })]);
  expect(tool.model()).toEqual({ query: ' raw ' }); expect(tool.fields().submitting()).toBe(true); expect(tool.pending()).toBe(true);
  expect(await tool.submit()).toBe(false); expect(call).toHaveBeenCalledOnce();
  finish({ content: [], structuredContent: { value: 'found' } });
  expect(await request).toBe(true); expect(tool.data()).toEqual({ value: 'found' }); expect(tool.status()).toBe('success'); expect(tool.pending()).toBe(false);
 });
 it('returns native submission errors and can retry a transient failure without editing input', async () => {
  const call = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ content: [], structuredContent: { value: 'recovered' } });
  const { tool } = setup(call); tool.model.set({ query: 'hello' });
  expect(await tool.submit()).toBe(false); expect(tool.error()?.message).toBe('offline');
  expect(tool.errors()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool', message: 'offline' })]));
  expect(await tool.submit()).toBe(true); expect(tool.error()).toBeNull(); expect(tool.data()).toEqual({ value: 'recovered' });
 });
 it('cancels uncooperative work promptly and ignores its late result', async () => {
  let finish!: (value: unknown) => void;
  const call = vi.fn(() => new Promise<any>(resolve => { finish = resolve; })); const { tool } = setup(call);
  tool.model.set({ query: 'hello' }); const request = tool.submit(); await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  tool.cancel(); expect(await request).toBe(false); expect(tool.status()).toBe('cancelled'); expect(tool.pending()).toBe(false);
  finish({ content: [], structuredContent: { value: 'stale' } }); await Promise.resolve(); expect(tool.data()).toBeNull();
 });
 it('reset and injector destruction abort pending calls without stale updates', async () => {
  const call = vi.fn(() => new Promise<any>(() => {})); const { tool } = setup(call);
  tool.model.set({ query: 'hello' }); const request = tool.submit(); await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  tool.reset({ query: 'fresh' }); expect(await request).toBe(false); expect(tool.model()).toEqual({ query: 'fresh' }); expect(tool.errors()).toHaveLength(0); expect(tool.status()).toBe('idle');
  const next = tool.submit(); await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2)); TestBed.resetTestingModule();
  expect(await next).toBe(false); expect(tool.status()).toBe('closed'); expect(await tool.submit()).toBe(false);
 });
 it('uses a caller-owned writable model and rejects invalid structured output', async () => {
  const call = vi.fn(async () => ({ content: [], structuredContent: { wrong: 1 } })); setup(call);
  const model = signal({ query: 'hello' }); const tool = TestBed.runInInjectionContext(() => injectToolForm('search', definition, model));
  expect(tool.model).toBe(model); expect(await tool.submit()).toBe(false); expect(tool.status()).toBe('error'); expect(tool.data()).toBeNull();
 });
 it('blocks submission while native asynchronous Standard Schema validation is pending', async () => {
  const { call } = setup(); let release!: () => void; let checked = false;
  const asynchronous = defineTool({ ...definition, input: z.object({ query: z.string().refine(async value => {
   if (!checked) await new Promise<void>(resolve => { release = resolve; }); return value === 'allowed';
  }, 'Query is not allowed') }) });
  const tool = TestBed.runInInjectionContext(() => injectToolForm('async', asynchronous, { query: 'allowed' }));
  expect(tool.validating()).toBe(true); expect(tool.canSubmit()).toBe(false); expect(await tool.submit()).toBe(false); expect(call).not.toHaveBeenCalled();
  TestBed.tick(); await vi.waitFor(() => expect(release).toBeTypeOf('function')); checked = true; release();
  await vi.waitFor(() => expect(tool.validating()).toBe(false)); expect(tool.valid()).toBe(true); expect(await tool.submit()).toBe(true);
 });
 it('integrates the opt-in native WebMCP forms provider with submission and lifecycle cleanup', async () => {
  let registered: any, registrationSignal!: AbortSignal;
  const registerTool = vi.fn(async (tool: any, options: { signal: AbortSignal }) => { registered = tool; registrationSignal = options.signal; });
  vi.stubGlobal('document', { modelContext: { registerTool } }); vi.stubGlobal('navigator', {});
  const call = vi.fn(async () => ({ content: [], structuredContent: { value: 'native form' } }));
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideExperimentalWebMcpForms(), { provide: DOCUMENT, useValue: { getElementById: () => null } }, { provide: PLATFORM_ID, useValue: 'browser' }, { provide: McpBridge, useValue: { callTool: call } }] });
  const tool = TestBed.runInInjectionContext(() => injectToolForm('search', definition, { query: 'initial', limit: 5 }, { experimentalWebMcpTool: { name: 'search-form', description: 'Submit this search form' } }));
  TestBed.tick(); await vi.waitFor(() => expect(registerTool).toHaveBeenCalledOnce());
  expect(registered.name).toBe('search-form'); await registered.execute({ query: 'browser', limit: 3 }, { signal: new AbortController().signal });
  expect(tool.model()).toEqual({ query: 'browser', limit: 3 }); expect(tool.data()).toEqual({ value: 'native form' });
  TestBed.resetTestingModule(); expect(registrationSignal.aborted).toBe(true); expect(tool.status()).toBe('closed');
 });
 it('skips native WebMCP form registration on SSR even if globals expose a registry', () => {
  const registerTool = vi.fn(); vi.stubGlobal('document', { modelContext: { registerTool } }); vi.stubGlobal('navigator', {});
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), { provide: DOCUMENT, useValue: { getElementById: () => null } }, { provide: PLATFORM_ID, useValue: 'server' }, { provide: McpBridge, useValue: { callTool: vi.fn() } }] });
  const tool = TestBed.runInInjectionContext(() => injectToolForm('search', definition, { query: 'initial' }, { experimentalWebMcpTool: { name: 'search-form', description: 'Not registered during SSR' } }));
  TestBed.tick(); expect(registerTool).not.toHaveBeenCalled(); expect(tool.fields.query().value()).toBe('initial');
 });
});
