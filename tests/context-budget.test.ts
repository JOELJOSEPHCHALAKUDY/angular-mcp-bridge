import '@angular/compiler';
import { createEnvironmentInjector, EnvironmentInjector, Injector, PLATFORM_ID } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_OPTIONS, McpBridge, estimateContextSize, checkContextBudget, CONTEXT_WARNING_DEFAULTS, type McpBridgeOptions, type BridgeTransport, type ToolResult, type ContextWarning } from '@angular-mcp-bridge/angular';

const injectors: EnvironmentInjector[] = [];
afterEach(() => { for (const injector of injectors.splice(0)) injector.destroy(); });
function setup(options: Partial<McpBridgeOptions> = {}, result: ToolResult = { content: [] }) {
  const fake = {
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    getHostContext: () => ({ theme: 'light', locale: 'en-US', displayMode: 'inline' }),
    getHostCapabilities: () => ({ serverTools: {}, updateModelContext: {} }),
    getHostVersion: () => ({ name: 'test', version: '1' }),
    callServerTool: vi.fn(async () => result), updateModelContext: vi.fn(async () => ({})),
  } as unknown as BridgeTransport;
  const injector = createEnvironmentInjector([
    { provide: PLATFORM_ID, useValue: 'browser' },
    { provide: BRIDGE_OPTIONS, useValue: { name: 'context-test', transportFactory: () => fake, ...options } }, McpBridge,
  ], Injector.NULL as EnvironmentInjector);
  injectors.push(injector);
  return { fake, bridge: injector.get(McpBridge) };
}

describe('context size estimates', () => {
  it('uses UTF-8 JSON bytes and a clearly configurable rough token ratio', () => {
    expect(estimateContextSize('é')).toMatchObject({ utf8Bytes: 4, estimatedTokens: 1, bytesPerToken: 4, serializable: true });
    expect(estimateContextSize('😀')).toMatchObject({ utf8Bytes: 6, estimatedTokens: 2 });
    expect(estimateContextSize('😀', { bytesPerToken: 2 })).toMatchObject({ estimatedTokens: 3 });
    expect(estimateContextSize(undefined)).toMatchObject({ utf8Bytes: 0, estimatedTokens: 0, serializable: true });
    expect(estimateContextSize(new Date('2026-10-10T00:00:00Z')).utf8Bytes).toBe(26);
    expect(checkContextBudget('é', { budgetTokens: 1 }).exceeded).toBe(true);
    expect(checkContextBudget('é', { budgetTokens: 2 }).exceeded).toBe(false);
    expect(CONTEXT_WARNING_DEFAULTS.toolResultTokens).toBe(5000);
  });
  it('excludes only protocol-private top-level metadata without changing the result', () => {
    const result = { content: [], structuredContent: { visible: 'x' }, _meta: { large: 'x'.repeat(100_000) } };
    expect(estimateContextSize(result).utf8Bytes).toBe(estimateContextSize({ content: [], structuredContent: { visible: 'x' } }).utf8Bytes);
    expect(estimateContextSize(result, { omitPrivateMetadata: false }).utf8Bytes).toBeGreaterThan(100_000);
    expect(result._meta.large).toHaveLength(100_000);
  });
  it('reports unmeasurable payloads without falsely calling them small', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(checkContextBudget(cyclic, { budgetTokens: 100 })).toMatchObject({ serializable: false, estimatedTokens: null, utf8Bytes: null, exceeded: null, reason: 'serialization-failed' });
    expect(estimateContextSize(1n)).toMatchObject({ serializable: false, reason: 'serialization-failed' });
    expect(estimateContextSize(() => {})).toMatchObject({ serializable: false, reason: 'not-json' });
  });
  it('rejects invalid developer budgets and ratios', () => {
    expect(() => checkContextBudget({}, { budgetTokens: 0 })).toThrow('budgetTokens');
    expect(() => checkContextBudget({}, { budgetTokens: Infinity })).toThrow('budgetTokens');
    expect(() => estimateContextSize({}, { bytesPerToken: NaN })).toThrow('bytesPerToken');
  });
});

describe('opt-in Angular diagnostics', () => {
  it('observes configured large tool results and host notifications without exposing data', async () => {
    const warn = vi.fn(), result = { content: [{ type: 'text' as const, text: 'x'.repeat(1000) }], _meta: { secret: 'private-identity' } };
    const { bridge, fake } = setup({ onContextWarning: warn, contextBudget: { toolResultTokens: 10 } }, result);
    expect(await bridge.callTool('large', {})).toBe(result);
    fake.ontoolresult?.(result);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatchObject({ kind: 'tool-result', source: 'callTool', toolName: 'large', exceeded: true, budgetTokens: 10 });
    expect(warn.mock.calls[1][0]).toMatchObject({ source: 'toolResult' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-identity');
    expect(warn.mock.calls[0][0]).not.toHaveProperty('content');
  });
  it('checks composed Angular context and allows observer failures without blocking sends', async () => {
    const warn = vi.fn((_warning: ContextWarning) => { throw new Error('Broken observer'); });
    const { bridge, fake } = setup({ onContextWarning: warn, contextBudget: { modelContextTokens: 10 } });
    await bridge.setModelContext({ structuredContent: { project: 'atlas' } });
    await bridge.setModelContextContribution('filter', { structuredContent: { filter: 'ready' } });
    expect(warn.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'model-context', source: 'setModelContext', exceeded: true });
    expect(fake.updateModelContext).toHaveBeenLastCalledWith({ structuredContent: { project: 'atlas', filter: 'ready' } });
    expect(bridge.error()).toBeNull();
  });
  it('isolates asynchronously rejected diagnostic observers', async () => {
    const observer = vi.fn(async (_warning: ContextWarning) => { throw new Error('Telemetry offline'); });
    const { bridge } = setup({ onContextWarning: observer, contextBudget: { toolResultTokens: 1 } });
    await expect(bridge.callTool('small', {})).resolves.toEqual({ content: [] });
    expect(observer).toHaveBeenCalledOnce(); expect(bridge.error()).toBeNull();
  });
  it('stays silent unless configured, ignores private metadata and validates opt-in configuration', async () => {
    const consoleWarning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const large = { content: [{ type: 'text' as const, text: 'x'.repeat(100_000) }] };
      const silent = setup({}, large); await silent.bridge.callTool('large', {});
      expect(consoleWarning).not.toHaveBeenCalled();
      const observer = vi.fn();
      const privateOnly = setup({ onContextWarning: observer }, { content: [], _meta: { large: 'x'.repeat(100_000) } });
      await privateOnly.bridge.callTool('private', {}); expect(observer).not.toHaveBeenCalled();
      expect(() => setup({ onContextWarning: observer, contextBudget: { modelContextTokens: -1 } })).toThrow('budgetTokens');
    } finally { consoleWarning.mockRestore(); }
  });
});
