import { Component, computed, effect, inject, signal } from '@angular/core';
import { McpBridge, DataLlmDirective, McpModalOutlet, injectViewTool, injectFileResource, injectResourceDraft } from '@angular-mcp-bridge/angular';
import { z } from 'zod';
import { DeferredDetailsComponent } from './deferred-details.js';
import { ProjectToolFormComponent } from '../../../examples/forms/tool-form.component.js';

@Component({
  selector: 'bridge-root', standalone: true, imports: [DataLlmDirective, McpModalOutlet, DeferredDetailsComponent, ProjectToolFormComponent],
  template: `
    <main [attr.data-theme]="bridge.theme()">
      <header><span class="eyebrow">ANGULAR MCP BRIDGE / INTEGRATION LAB</span><span class="connection">{{ bridge.status() }}</span></header>
      <h1>Explore the bridge<span>.</span></h1><p class="intro">A second standalone Angular view. Signals own local state; Angular resources own reads. Each action goes through the host.</p>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (notice()) { <p class="notice" role="status">{{ notice() }}</p> }
      <section class="environment"><h2>Host environment</h2><dl><div><dt>Theme</dt><dd>{{ bridge.theme() }}</dd></div><div><dt>Locale</dt><dd>{{ bridge.locale() }}</dd></div><div><dt>Display</dt><dd>{{ bridge.displayMode() }}</dd></div><div><dt>UI tools</dt><dd>{{ registered() ? 'lab_selection ready' : 'Connecting…' }}</dd></div></dl></section>
      <section><div class="section-heading"><h2>Private selection</h2><span>Angular signal → registered view tool</span></div><div class="choices">@for (choice of choices; track choice) { <button [class.selected]="selection() === choice" (click)="selection.set(choice)">{{ choice }}</button> }</div><p class="hint">Call <code>lab_selection</code> from the workbench's View tools tab to change this signal.</p><button (click)="share()" [disabled]="!bridge.capabilities().updateModelContext">Share selection with model</button><button class="subtle" (click)="ask()" [disabled]="!bridge.capabilities().message">Discuss selection</button></section>
      <section><div class="section-heading"><h2>Shared note</h2><span>Angular resource → MCP resource</span></div>@if (note.isLoading()) { <p>Reading…</p> }<textarea #noteEditor aria-label="Shared note" [value]="draft()" [disabled]="!note.hasValue() || editor.saving()" (input)="editor.set({ text: noteEditor.value })"></textarea><div class="actions"><button (click)="saveNote()" [disabled]="!editor.canSave() || editor.saving() || !bridge.supportsExtension('resource')">Save note</button><button class="subtle" (click)="refreshNote()" [disabled]="editor.saving()">Reload server</button><button class="subtle" (click)="discardNote()" [disabled]="!note.hasValue() || editor.saving()">Discard draft</button><button class="subtle" (click)="downloadNote()" [disabled]="!bridge.capabilities().downloadFile">Download</button></div>@if (editor.dirty()) { <p class="hint">Unsaved changes are kept when server data refreshes.</p> }@if (editor.remoteChanged()) { <p class="notice">The server version changed. Review it before discarding or retrying this draft.</p> }@if (editor.conflict()) { <p class="error" role="alert">Save conflict: the original version changed. Your draft is preserved.</p> }@if (note.error(); as resourceError) { <p class="error" role="alert">{{ resourceError.message }}</p> }<p class="hint">{{ file.watching() ? 'Resource subscription active.' : 'Reload after external edits when the host has no subscription support.' }} Writes use an ETag. A stale edit fails instead of overwriting another editor.</p></section>
      <section><div class="section-heading"><h2>Angular modal & layout</h2><span>Standalone component + TemplateRef</span></div><button (click)="openDetails()">Open Angular modal</button><button class="subtle" (click)="fullscreen()" [disabled]="!bridge.hostContext().availableDisplayModes?.includes('fullscreen')">Fullscreen</button><button class="subtle" (click)="resize()">Request size</button><button class="subtle" (click)="closeView()">Close view</button></section>
      <section><div class="section-heading"><h2>Validated Angular tool form</h2><span>Signal Forms + FormRoot</span></div><project-tool-form /></section>
      <section><div class="section-heading"><h2>Load details on demand</h2><span>Angular &#64;defer + standalone component</span></div><button (click)="showDeferredDetails.set(true)" [disabled]="showDeferredDetails()">Load deferred details</button>
        @defer (when showDeferredDetails()) { <bridge-deferred-details /> }
        @placeholder { <p class="hint">The details component is created after you request it.</p> }
        @loading { <p role="status">Loading Angular details…</p> }
        @error { <p class="error" role="alert">The details could not load. Reopen the view to retry.</p> }
      </section>
      <label class="context-toggle"><input type="checkbox" [checked]="shareVisible()" (change)="shareVisible.set($any($event.target).checked)"> Share visible selection using an Angular directive</label>
      @if (shareVisible()) { <p class="context-preview" [dataLlm]="contextSummary()">{{ contextSummary() }}</p> }
      <ng-template #details><h2>Selected: {{ selection() }}</h2><p>This content is an Angular template. Closing the dialog destroys its view through Angular.</p></ng-template>
      <mcp-modal-outlet [modalContent]="details" />
      <footer>Host capabilities decide which actions are available. This lab uses demo data.</footer>
    </main>`,
})
export class LabComponent {
  readonly bridge = inject(McpBridge);
  readonly choices = ['Signals', 'Resources', 'Dependency injection'];
  readonly selection = signal('Signals');
  readonly error = signal('');
  readonly notice = signal('');
  readonly shareVisible = signal(false);
  readonly showDeferredDetails = signal(false);
  readonly contextSummary = computed(() => `The user is exploring Angular ${this.selection()}.`);
  readonly selectionTool = injectViewTool('lab_selection', {
    title: 'Change the Angular lab selection', description: 'Set the private selection in the current Angular view.',
    inputSchema: z.object({ selection: z.enum(['Signals', 'Resources', 'Dependency injection']) }),
    outputSchema: z.object({ selection: z.string() }),
  }, input => { this.selection.set(input.selection); return { content: [], structuredContent: { selection: this.selection() } }; });
  readonly registered = computed(() => this.selectionTool.status() === 'registered');
  readonly file = injectFileResource({ uri: () => this.bridge.connected() && this.bridge.capabilities().serverResources ? 'bridge://lab/notes' : undefined });
  readonly note = this.file.resource;
  readonly editor = injectResourceDraft(this.file);
  readonly draft = computed(() => { const content = this.editor.content(); return 'text' in content ? content.text : ''; });
  constructor() {
    effect(() => { const error = this.selectionTool.error(); if (error) this.error.set(error.message); });
  }
  private async perform(action: () => Promise<unknown>, success?: string) {
    this.error.set(''); this.notice.set('');
    try { await action(); if (success) this.notice.set(success); }
    catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
  }
  share() { void this.perform(() => this.bridge.setModelContext({ content: [{ type: 'text', text: this.contextSummary() }], structuredContent: { selection: this.selection() } }), 'Selection shared.'); }
  ask() { void this.perform(() => this.bridge.sendMessage(`Explain Angular ${this.selection()} using this example.`), 'Message sent to host.'); }
  refreshNote() { this.editor.reload(); }
  discardNote() { void this.perform(async () => this.editor.discard(), 'Server version adopted.'); }
  saveNote() { void this.perform(async () => { const result = await this.editor.save(); if (result.outcome !== 'saved') throw new Error(result.outcome === 'conflict' ? 'The note changed. Reload before saving your edit.' : 'The note is too large.'); }, 'Note saved.'); }
  downloadNote() { void this.perform(() => this.bridge.download({ contents: [{ type: 'resource', resource: { uri: 'bridge://lab/notes', mimeType: 'text/plain', text: this.draft() } }] }), 'Download requested.'); }
  openDetails() { void this.perform(() => this.bridge.openModal({ title: 'Angular template', params: { selection: this.selection() } })); }
  fullscreen() { void this.perform(() => this.bridge.requestDisplayMode('fullscreen')); }
  resize() { void this.perform(() => this.bridge.requestSize({ height: 900 })); }
  closeView() { void this.perform(() => this.bridge.requestClose()); }
}
