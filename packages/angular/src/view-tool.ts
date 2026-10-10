import { DestroyRef, inject, signal } from '@angular/core';
import type { z } from 'zod';
import { McpBridge, type ViewToolConfig, type ViewToolHandle } from './bridge.js';
import type { ToolResult } from './transport.js';

/** Component-scoped app tool: registration ends automatically when its Angular owner is destroyed. */
export function injectViewTool<I extends z.ZodType, O extends z.ZodType | undefined = undefined>(
  name: string, config: ViewToolConfig<I, O>, handler: (input: z.output<I>, signal: AbortSignal) => ToolResult | Promise<ToolResult>,
) {
  const bridge = inject(McpBridge);
  const destroyRef = inject(DestroyRef);
  const status = signal<'registering' | 'registered' | 'removed' | 'error'>('registering');
  const error = signal<Error | null>(null);
  let handle: ViewToolHandle | undefined;
  let removed = false;
  const remove = () => { removed = true; handle?.remove(); status.set('removed'); };
  destroyRef.onDestroy(remove);
  const ready = bridge.registerViewTool(name, config, handler).then(registered => {
    handle = registered;
    if (removed || destroyRef.destroyed) { registered.remove(); return undefined; }
    status.set('registered'); return registered;
  }).catch(cause => {
    if (!removed) { error.set(cause instanceof Error ? cause : new Error(String(cause))); status.set('error'); }
    return undefined;
  });
  return { status: status.asReadonly(), error: error.asReadonly(), ready, remove, enable: () => handle?.enable(), disable: () => handle?.disable() };
}
