import { isPlatformBrowser } from '@angular/common';
import { computed, DestroyRef, inject, isSignal, PLATFORM_ID, signal, type Signal, type WritableSignal } from '@angular/core';
import { apply, form, submit, validateStandardSchema, type FieldTree, type FormOptions, type SchemaOrSchemaFn, type ValidationError } from '@angular/forms/signals';
import type { ToolDefinition, ToolInput, ToolOutput } from '@angular-mcp-bridge/contracts';
import { McpBridge, type ToolResult } from '@angular-mcp-bridge/angular';

export type ToolFormStatus = 'idle' | 'invalid' | 'pending' | 'success' | 'error' | 'cancelled' | 'closed';
export interface ToolFormOptions<T extends ToolDefinition> {
  timeoutMs?: number;
  /** Extra native Signal Forms rules; the shared input schema always runs too. */
  schema?: SchemaOrSchemaFn<ToolInput<T>>;
  /** Requires provideExperimentalWebMcpForms and a supported browser. Opt in explicitly. */
  experimentalWebMcpTool?: FormOptions<ToolInput<T>>['experimentalWebMcpTool'];
}
export interface ToolForm<T extends ToolDefinition> {
  readonly model: WritableSignal<ToolInput<T>>;
  readonly fields: FieldTree<ToolInput<T>>;
  readonly status: Signal<ToolFormStatus>;
  readonly data: Signal<ToolOutput<T> | null>;
  readonly result: Signal<ToolResult | null>;
  readonly error: Signal<Error | null>;
  readonly errors: Signal<readonly ValidationError.WithFieldTree[]>;
  readonly valid: Signal<boolean>;
  readonly validating: Signal<boolean>;
  readonly pending: Signal<boolean>;
  readonly canSubmit: Signal<boolean>;
  /** false means invalid, busy, cancelled, closed, or a failed tool call. */
  submit(event?: Event): Promise<boolean>;
  cancel(): void;
  reset(value?: ToolInput<T>): void;
}

function supportsWebMcp(): boolean {
  const host = (typeof document === 'undefined' ? undefined : (document as Document & { modelContext?: { registerTool?: unknown } }).modelContext)
    ?? (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { modelContext?: { registerTool?: unknown } }).modelContext);
  return typeof host?.registerTool === 'function';
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', stop); }
}

/** A native Signal Form whose model is the tool's wire input, never its parsed output. */
export function injectToolForm<T extends ToolDefinition>(name: string, definition: T,
  initial: NoInfer<ToolInput<T>> | WritableSignal<NoInfer<ToolInput<T>>>, options: ToolFormOptions<T> = {}): ToolForm<T> {
  const bridge = inject(McpBridge), destroyRef = inject(DestroyRef);
  const browser = isPlatformBrowser(inject(PLATFORM_ID));
  const model = isSignal(initial) ? initial as WritableSignal<ToolInput<T>> : signal<ToolInput<T>>(structuredClone(initial));
  if (typeof model.set !== 'function') throw new TypeError('A tool form needs a writable model signal.');
  const baseline = structuredClone(model());
  const state = signal<ToolFormStatus>('idle'), data = signal<ToolOutput<T> | null>(null);
  const result = signal<ToolResult | null>(null), error = signal<Error | null>(null);
  let disposed = false, generation = 0, controller: AbortController | undefined;

  const execute = async (): Promise<ValidationError.WithOptionalFieldTree[] | undefined> => {
    if (disposed) return [{ kind: 'closed', message: 'The tool form is closed.' }];
    const current = ++generation, active = new AbortController(); controller = active;
    state.set('pending'); error.set(null);
    try {
      const wire = structuredClone(model());
      // Recheck at the invocation boundary, including async Zod refinements.
      // The parsed value is intentionally discarded: server defaults/transforms run once.
      await abortable(definition.input.parseAsync(wire), active.signal);
      const response = await abortable(bridge.callTool(name, wire as Record<string, unknown>, { timeoutMs: options.timeoutMs, signal: active.signal }), active.signal);
      const output = await abortable(definition.output.parseAsync(response.structuredContent), active.signal) as ToolOutput<T>;
      if (!disposed && current === generation) { data.set(output); result.set(response); state.set('success'); }
    } catch (cause) {
      if (!disposed && current === generation) {
        if (active.signal.aborted) state.set('cancelled');
        else { error.set(cause instanceof Error ? cause : new Error(String(cause))); state.set('error'); }
      }
      // Native FormRoot also invokes this action: return submission errors rather
      // than throw an unhandled rejection from its DOM submit listener.
      if (!disposed && (current === generation || state() === 'cancelled')) {
        return [{ kind: active.signal.aborted ? 'cancelled' : 'tool', message: active.signal.aborted ? 'Tool submission cancelled.' : error()?.message ?? 'The tool failed.', fieldTree: nativeFields }];
      }
      return undefined;
    } finally { if (controller === active) controller = undefined; }
  };
  // Angular's conditional CompatFieldState types cannot resolve a generic Zod
  // object against AbstractControl. Erase only at this native API boundary;
  // callers retain their precise wire-model FieldTree throughout the public API.
  const nativeFields = form<Record<string, unknown>>(model, path => {
    validateStandardSchema(path, definition.input);
    if (options.schema) apply(path, options.schema as SchemaOrSchemaFn<Record<string, unknown>>);
  }, {
    name,
    submission: { action: execute, ignoreValidators: 'none', onInvalid: field => {
      if (!disposed) state.set('invalid');
      field().errorSummary()[0]?.fieldTree().focusBoundControl();
    } },
    ...(options.experimentalWebMcpTool && browser && supportsWebMcp() ? { experimentalWebMcpTool: options.experimentalWebMcpTool } : {}),
  });
  const fields = nativeFields as unknown as FieldTree<ToolInput<T>>;
  const cancel = () => {
    if (!controller) return;
    ++generation; controller.abort(new DOMException('Tool form submission cancelled.', 'AbortError'));
    if (!disposed) { error.set(null); state.set('cancelled'); }
  };
  destroyRef.onDestroy(() => { disposed = true; cancel(); ++generation; state.set('closed'); });
  return {
    model, fields, status: state.asReadonly(), data: data.asReadonly(), result: result.asReadonly(), error: error.asReadonly(),
    errors: computed(() => fields().errorSummary()),
    valid: computed(() => fields().valid()), validating: computed(() => fields().pending()), pending: computed(() => fields().submitting()),
    canSubmit: computed(() => state() !== 'closed' && !fields().submitting() && fields().valid()),
    async submit(event) {
      event?.preventDefault();
      if (disposed || fields().submitting()) return false;
      // Clear an earlier root submission error to permit retrying the same wire
      // input. Native validation still runs, and field values stay unchanged.
      if (state() === 'error' || state() === 'cancelled') model.set(structuredClone(model()));
      error.set(null);
      try { return await submit(fields) && state() === 'success'; }
      catch (cause) {
        if (!disposed) { error.set(cause instanceof Error ? cause : new Error(String(cause))); state.set('error'); }
        return false;
      }
    },
    cancel,
    reset(value = baseline) {
      if (disposed) return;
      cancel(); ++generation; nativeFields().reset(structuredClone(value));
      data.set(null); result.set(null); error.set(null); state.set('idle');
    },
  };
}
