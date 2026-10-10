import { inject, resource, type ResourceParamsContext, type ValueEqualityFn } from '@angular/core';
import type { ToolDefinition, ToolInput, ToolOutput } from '@angular-mcp-bridge/contracts';
import { McpBridge } from './bridge.js';
import { createReadCacheKey, MCP_READ_CACHE, type ReadCachePolicy } from './read-cache.js';

export interface ToolResourceOptions<T extends ToolDefinition> {
  params: (context: ResourceParamsContext) => ToolInput<T> | undefined;
  timeoutMs?: number;
  equal?: ValueEqualityFn<ToolOutput<T>>;
  defaultValue?: ToolOutput<T>;
  debugName?: string;
  /** Requires provideMcpReadCache; disabled by default even when a provider exists. */
  cache?: boolean | ReadCachePolicy;
}

/** Angular owns reactive loading, cancellation, reload and error state for read-only tools. */
export function injectToolResource<T extends ToolDefinition>(
  name: string,
  definition: T,
  options: ToolResourceOptions<T>,
) {
  if (!definition.annotations.readOnlyHint) throw new Error('Reactive resources only support read-only tools. Use injectTool for commands.');
  const bridge = inject(McpBridge);
  const cache = options.cache ? inject(MCP_READ_CACHE, { optional: true }) : null;
  const group = `tool:${name}`;
  return resource<ToolOutput<T>, { input: ToolInput<T>; revision?: number; scope?: string; epoch?: number } | undefined>({
    params: context => {
      const input = options.params(context);
      if (input === undefined) return undefined;
      if (cache && (bridge.status() === 'closed' || bridge.status() === 'error')) return undefined;
      return { input, ...(cache ? { revision: cache.revision(bridge, group)(), scope: cache.scope(), epoch: bridge.connectionEpoch() } : {}) };
    },
    equal: options.equal, defaultValue: options.defaultValue, debugName: options.debugName ?? `MCP tool ${name}`,
    loader: async ({ params, abortSignal }) => {
      definition.input.parse(params.input);
      await bridge.connect(); abortSignal.throwIfAborted();
      const load = (signal: AbortSignal) => bridge.callTool(name, params.input as Record<string, unknown>, { signal, timeoutMs: options.timeoutMs });
      const result = cache
        ? await cache.read(bridge, group, createReadCacheKey([name, params.input, options.timeoutMs ?? null]), load, abortSignal, typeof options.cache === 'object' ? options.cache : undefined)
        : await load(abortSignal);
      return definition.output.parse(result.structuredContent) as ToolOutput<T>;
    },
  });
}
