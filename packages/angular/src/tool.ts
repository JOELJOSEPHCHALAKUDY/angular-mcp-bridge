import { computed, DestroyRef, inject, signal } from '@angular/core';
import type { ToolDefinition, ToolInput, ToolOutput, ToolRegistry } from '@angular-mcp-bridge/contracts';
import { injectToolResource, type ToolResourceOptions } from './resource.js';
import { McpBridge } from './bridge.js';
import type { ToolResult } from './transport.js';

export type ToolInfo<T extends ToolDefinition, M = Record<string, unknown>> =
  | { status: 'pending'; input: Partial<ToolInput<T>> | undefined; output: undefined; metadata: undefined }
  | { status: 'success'; input: ToolInput<T> | undefined; output: ToolOutput<T>; metadata: M }
  | { status: 'error' | 'cancelled'; input: Partial<ToolInput<T>> | undefined; output: undefined; metadata: undefined; error: Error };

/** Reactive, runtime-validated invocation that caused the host to render this view. */
export function injectToolInfo<T extends ToolDefinition, M = Record<string, unknown>>(definition: T, options: { metadataSchema?: { parse(value: unknown): M } } = {}) {
  const bridge = inject(McpBridge);
  return computed<ToolInfo<T, M>>(() => {
    const rawInput = bridge.toolInput();
    const input = rawInput === null ? undefined : rawInput as Partial<ToolInput<T>>;
    const cancelled = bridge.cancelled();
    if (cancelled) return { status: 'cancelled', input, output: undefined, metadata: undefined, error: new Error(cancelled) };
    const result = bridge.toolResult();
    if (!result) return { status: 'pending', input, output: undefined, metadata: undefined };
    try {
      if (result.isError) throw new Error(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'The tool failed.');
      if (rawInput !== null) definition.input.parse(rawInput);
      const parsedInput = rawInput === null ? undefined : rawInput as ToolInput<T>;
      const output = definition.output.parse(result.structuredContent) as ToolOutput<T>;
      const metadata = options.metadataSchema ? options.metadataSchema.parse(result._meta ?? {}) : (result._meta ?? {}) as M;
      return { status: 'success', input: parsedInput, output, metadata };
    } catch (cause) { return { status: 'error', input, output: undefined, metadata: undefined, error: cause instanceof Error ? cause : new Error(String(cause)) }; }
  });
}

/** Latest invocation owns rendered state. Older promises still resolve for their caller. */
export function injectTool<T extends ToolDefinition>(name: string, definition: T) {
  const bridge = inject(McpBridge);
  const status = signal<'idle' | 'pending' | 'success' | 'error'>('idle');
  const data = signal<ToolOutput<T> | null>(null);
  const error = signal<Error | null>(null);
  const resultState = signal<ToolResult | null>(null);
  let generation = 0;
  const controllers = new Set<AbortController>();
  inject(DestroyRef).onDestroy(() => { generation++; for (const controller of controllers) controller.abort(); });
  return {
    status: status.asReadonly(), data: data.asReadonly(), error: error.asReadonly(),
    result: resultState.asReadonly(), metadata: computed(() => resultState()?._meta ?? null),
    pending: computed(() => status() === 'pending'),
    async execute(input: ToolInput<T>, options?: { timeoutMs?: number }): Promise<ToolOutput<T>> {
      const current = ++generation;
      const controller = new AbortController(); controllers.add(controller);
      status.set('pending'); error.set(null);
      try {
        definition.input.parse(input);
        // Preserve wire input: transforms/defaults belong to the server's parser.
        const result = await bridge.callTool(name, input as Record<string, unknown>, { ...options, signal: controller.signal });
        const output = definition.output.parse(result.structuredContent) as ToolOutput<T>;
        if (current === generation) { data.set(output); resultState.set(result); status.set('success'); }
        return output;
      } catch (cause) {
        if (current === generation) { error.set(cause instanceof Error ? cause : new Error(String(cause))); status.set('error'); }
        throw cause;
      } finally { controllers.delete(controller); }
    },
    reset() { generation++; for (const controller of controllers) controller.abort(); data.set(null); resultState.set(null); error.set(null); status.set('idle'); },
  };
}
/** Share a contract map between backend and Angular without importing backend code. */
export function createToolClient<const T extends ToolRegistry>(tools: T) {
  return {
    inject<K extends keyof T & string>(name: K) { return injectTool<T[K]>(name, tools[name]); },
    info<K extends keyof T & string, M = Record<string, unknown>>(name: K, options?: { metadataSchema?: { parse(value: unknown): M } }) { return injectToolInfo<T[K], M>(tools[name], options); },
    resource<K extends keyof T & string>(name: K, options: ToolResourceOptions<T[K]>) {
      return injectToolResource(name, tools[name], options);
    },
  };
}
