import { afterRenderEffect, Component, ElementRef, inject, input, TemplateRef, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { McpBridge } from './bridge.js';

export interface ModalTemplateContext { $implicit: Record<string, unknown>; close: () => void; }
/** Native dialog inside the app iframe. Content remains an application-owned Angular template. */
@Component({
  selector: 'mcp-modal-outlet', standalone: true, imports: [NgTemplateOutlet],
  template: `@if (bridge.modal(); as modal) {
    <dialog #dialog aria-labelledby="mcp-modal-title" (cancel)="close()">
      <header><h2 id="mcp-modal-title">{{ modal.title || 'Dialog' }}</h2><button type="button" aria-label="Close dialog" (click)="close()">×</button></header>
      @if (modalContent(); as content) { <ng-container [ngTemplateOutlet]="content" [ngTemplateOutletContext]="context()" /> }
      @else { <ng-content /> }
    </dialog>
  }`,
  styles: `dialog { border: 1px solid #d5d9d7; border-radius: 12px; background: var(--color-background-primary, Canvas); color: var(--color-text-primary, CanvasText); max-width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 24px; }
    dialog::backdrop { background: rgb(0 0 0 / .3); } header { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 16px; } h2 { font: inherit; font-weight: 600; margin: 0; } button { border: 0; padding: 4px 8px; background: transparent; color: inherit; font-size: 24px; cursor: pointer; }`,
})
export class McpModalOutlet {
  protected readonly bridge = inject(McpBridge);
  readonly modalContent = input<TemplateRef<ModalTemplateContext>>();
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  readonly close = () => this.bridge.closeModal();
  protected readonly context = () => ({ $implicit: this.bridge.modal()?.params ?? {}, close: this.close });
  constructor() { afterRenderEffect(() => { const dialog = this.dialog()?.nativeElement; if (dialog && !dialog.open) dialog.showModal(); }); }
}
