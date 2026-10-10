import { DestroyRef, Directive, effect, ElementRef, inject, Injectable, InjectionToken, input, signal } from '@angular/core';
import type { ModelContextParams } from './transport.js';

export interface ViewContextBridge {
  setModelContextContribution(key: string, params: ModelContextParams | null): Promise<string | undefined>;
  removeModelContextContribution(key: string): Promise<string | undefined>;
}
/** Bound to the owning McpBridge by provideMcpBridge, including child environments. */
export const VIEW_CONTEXT_BRIDGE = new InjectionToken<ViewContextBridge>('Angular view context bridge');

interface ContextNode { key: symbol; parent?: symbol; content: string; }
/** Application-scoped context registry; Angular DI owns its lifetime. */
@Injectable()
export class McpViewContext {
  private readonly bridge = inject(VIEW_CONTEXT_BRIDGE);
  private readonly nodes = new Map<symbol, ContextNode>();
  private timer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private readonly errorState = signal<Error | null>(null);
  readonly error = this.errorState.asReadonly();
  constructor() { inject(DestroyRef).onDestroy(() => { this.destroyed = true; clearTimeout(this.timer); this.nodes.clear(); }); }
  register(node: ContextNode): void { if (this.destroyed) return; this.nodes.set(node.key, node); this.schedule(); }
  remove(key: symbol): void { this.nodes.delete(key); this.schedule(); }
  /** Coalesces rapid Angular updates and DOM mutations into one context request. */
  private schedule() { if (this.destroyed) return; clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush(); }, 40); }
  async flush(): Promise<void> {
    if (this.destroyed) return;
    clearTimeout(this.timer);
    const children = new Map<symbol | undefined, ContextNode[]>();
    for (const node of this.nodes.values()) {
      const parent = node.parent && this.nodes.has(node.parent) ? node.parent : undefined;
      const siblings = children.get(parent) ?? []; siblings.push(node); children.set(parent, siblings);
    }
    const lines: string[] = [];
    const visit = (parent: symbol | undefined, depth: number) => {
      for (const node of children.get(parent) ?? []) { if (node.content.trim()) lines.push(`${'  '.repeat(depth)}- ${node.content.trim()}`); visit(node.key, depth + 1); }
    };
    visit(undefined, 0);
    const text = lines.join('\n');
    try {
      if (text) await this.bridge.setModelContextContribution('angular:view-context', { structuredContent: { viewContext: text }, content: [{ type: 'text', text, annotations: { audience: ['assistant'] } }] });
      else await this.bridge.removeModelContextContribution('angular:view-context');
      this.errorState.set(null);
    } catch (cause) { this.errorState.set(cause instanceof Error ? cause : new Error(String(cause))); }
  }
}

/** Explicitly shares UI descriptions. Undefined observes element text; empty/null stays empty. */
@Directive({ selector: '[dataLlm]', standalone: true })
export class DataLlmDirective {
  readonly dataLlm = input<string | null | undefined>(undefined);
  readonly dataLlmEnabled = input(true);
  readonly key = Symbol('Angular view context');
  private readonly parent = inject(DataLlmDirective, { optional: true, skipSelf: true });
  private readonly registry = inject(McpViewContext);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  constructor() {
    const update = () => {
      if (!this.dataLlmEnabled()) { this.registry.remove(this.key); return; }
      const explicit = this.dataLlm();
      const content = explicit === undefined ? this.element.textContent ?? '' : explicit ?? '';
      this.registry.register({ key: this.key, parent: this.parent?.key, content });
    };
    effect(update);
    const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(() => { if (this.dataLlm() === undefined) update(); });
    observer?.observe(this.element, { childList: true, characterData: true, subtree: true });
    inject(DestroyRef).onDestroy(() => { observer?.disconnect(); this.registry.remove(this.key); });
  }
}
