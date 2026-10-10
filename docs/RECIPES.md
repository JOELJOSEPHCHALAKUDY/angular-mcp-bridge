# Angular recipes

These examples are standalone Angular components. Start with [your first app](FIRST-APP.md), then choose a recipe below. The [API reference](ANGULAR-API.md) explains signatures and capabilities; the [documentation map](index.md) covers server and tooling setup.

Save each component in the file named above its example. Add the exported component to your existing view's `imports` and render its selector. For example, import `SelectionActionsComponent` from `./selection-actions.js` into `apps/demo/src/app.ts`, add it to `DemoComponent`'s `imports`, and render `<selection-actions />`. The existing view bootstrap supplies `provideMcpBridge`; do not provide a new bridge in every child component.

## Send a message and share selection

Use a private state helper when you want an explicit Share action. Clicking a selection alone does not publish it to the model. The message and context actions require their host's corresponding capabilities and render any error.

`apps/demo/src/selection-actions.ts`:

```ts
import { Component, inject, signal } from '@angular/core';
import { McpBridge, injectViewState } from '@angular-mcp-bridge/angular';

@Component({
  selector: 'selection-actions',
  standalone: true,
  template: `
    <p>Selected: {{ selection.value().id }}</p>
    <button type="button" (click)="choose('atlas')">Atlas</button>
    <button type="button" (click)="choose('studio')">Studio</button>
    <button type="button" (click)="share()" [disabled]="!bridge.connected()">Share selection</button>
    <button type="button" (click)="discuss()" [disabled]="!bridge.connected()">Discuss selection</button>
    <p role="status">{{ notice() }}</p>
  `,
})
export class SelectionActionsComponent {
  readonly bridge = inject(McpBridge);
  readonly selection = injectViewState({ id: 'atlas' }, { shareKey: 'selection' });
  readonly notice = signal('');

  async choose(id: string): Promise<void> {
    try { await this.selection.set({ id }); this.notice.set('Selection is private.'); }
    catch (error) { this.report(error); }
  }

  async share(): Promise<void> {
    try { await this.selection.share(); this.notice.set('Selection shared with the model.'); }
    catch (error) { this.report(error); }
  }

  async discuss(): Promise<void> {
    try {
      await this.bridge.sendMessage(`Discuss project ${this.selection.value().id}.`);
      this.notice.set('Message sent.');
    } catch (error) { this.report(error); }
  }

  private report(error: unknown): void {
    this.notice.set(error instanceof Error ? error.message : String(error));
  }
}
```

For text plus structured context, replace `selection.share()` with a `bridge.setModelContext({ content: [{ type: 'text', text: yourSummary }], structuredContent: { selection: yourSelection } })` call in your own event handler. Use this when the model needs a human-readable explanation as well as data. Sharing changes model context; it does not authenticate the selection or persist it privately.

## Describe visible UI with a directive

Use computed strings for concise, predictable descriptions. This example requires the user to enable sharing. Install `DataLlmDirective` in the component's `imports`; no JSX transform or React provider is involved.

`apps/demo/src/visible-description.ts`:

```ts
import { Component, computed, signal } from '@angular/core';
import { DataLlmDirective } from '@angular-mcp-bridge/angular';

@Component({
  selector: 'visible-description',
  standalone: true,
  imports: [DataLlmDirective],
  template: `
    <label>
      <input #share type="checkbox" [checked]="sharing()" (change)="sharing.set(share.checked)">
      Share this view description
    </label>
    <button type="button" (click)="selectedId.set('atlas')">Atlas</button>
    <button type="button" (click)="selectedId.set('studio')">Studio</button>
    <section [dataLlm]="'Project chooser'" [dataLlmEnabled]="sharing()">
      <p [dataLlm]="summary()" [dataLlmEnabled]="sharing()">{{ summary() }}</p>
    </section>
  `,
})
export class VisibleDescriptionComponent {
  readonly selectedId = signal('atlas');
  readonly sharing = signal(false);
  readonly summary = computed(() => `The selected project is ${this.selectedId()}.`);
}
```

An undefined description observes the element's text: `<p [dataLlm]="undefined">…</p>`. Null/empty strings describe nothing. `textContent` includes descendants, so prefer explicit parent summaries when nesting descriptions to avoid repeating child text. Disabling one directive removes that directive's node; independently enabled descendants remain active. Disable the descendants too when disabling an entire shared subtree, as above.

## Let the host operate an Angular component

Use an app-side tool for local UI actions, such as changing the visible selection. Use a server tool for durable business actions. The handler below updates an Angular signal; it does not mutate a backend.

`apps/demo/src/host-selection.ts`:

```ts
import { Component, signal } from '@angular/core';
import { injectViewTool } from '@angular-mcp-bridge/angular';
import { z } from 'zod';

@Component({
  selector: 'host-selection',
  standalone: true,
  template: `
    <p>Selected: {{ selectedId() }}</p>
    <p>App tool: {{ selectionTool.status() }}</p>
    @if (selectionTool.error(); as error) { <p role="alert">{{ error.message }}</p> }
  `,
})
export class HostSelectionComponent {
  readonly selectedId = signal('atlas');
  readonly selectionTool = injectViewTool('select_visible_project', {
    title: 'Select a visible project',
    description: 'Change the selection in this Angular project chooser.',
    inputSchema: z.object({ id: z.enum(['atlas', 'studio']) }),
    outputSchema: z.object({ selected: z.string() }),
  }, ({ id }, signal) => {
    signal.throwIfAborted();
    this.selectedId.set(id);
    return { content: [], structuredContent: { selected: id } };
  });
}
```

In the workbench, open the selected view and inspect **View tools**. Call `select_visible_project` with `{"id":"studio"}` and watch the signal change. Registration ends with the component's `DestroyRef`. Real host presentation of app-side tools depends on host support; a legacy adapter cannot synthesize modern tool discovery.

## Render an Angular dialog fallback

Add the local provider to your existing bootstrap. This full `apps/demo/src/main.ts` keeps the generated root component:

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { provideLocalMcpModal, provideMcpBridge } from '@angular-mcp-bridge/angular';
import { DemoComponent } from './app.js';

bootstrapApplication(DemoComponent, {
  providers: [provideMcpBridge({ name: 'project-view' }), provideLocalMcpModal()],
}).catch(console.error);
```

Then add this component to that view:

`apps/demo/src/dialog-example.ts`:

```ts
import { Component, inject, signal } from '@angular/core';
import { McpBridge, McpModalOutlet } from '@angular-mcp-bridge/angular';

@Component({
  selector: 'angular-dialog-example',
  standalone: true,
  imports: [McpModalOutlet],
  template: `
    <button type="button" (click)="open()">Show details</button>
    <p role="alert">{{ error() }}</p>
    <mcp-modal-outlet [modalContent]="details" />
    <ng-template #details let-params let-close="close">
      <p>Project: {{ params['id'] }}</p>
      <button type="button" (click)="close()">Done</button>
    </ng-template>
  `,
})
export class DialogExampleComponent {
  private readonly bridge = inject(McpBridge);
  readonly error = signal('');

  async open(): Promise<void> {
    this.error.set('');
    try { await this.bridge.openModal({ title: 'Project details', params: { id: 'atlas' } }); }
    catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
  }
}
```

The standard local host exercises this fallback. When a host supplies `requestModal`, the host handles the request and owns its content/dismissal; the local outlet is not used. Local templates stay inside the iframe and a native dialog provides focus behavior. Use one outlet for the bridge environment. To always render your own Angular dialog, manage that dialog in your application independently of the host-modal request API.

## Download and handle unsupported actions

Host actions can change availability across hosts. Check a known capability where useful and still catch an unsupported response. This recipe includes embedded text; the URI identifies the download content and does not require a server resource with that URI.

`apps/demo/src/download-example.ts`:

```ts
import { Component, inject, signal } from '@angular/core';
import { BridgeError, McpBridge } from '@angular-mcp-bridge/angular';

@Component({
  selector: 'download-example',
  standalone: true,
  template: `
    <button type="button" (click)="download()" [disabled]="!bridge.connected()">Download report</button>
    <p role="status">{{ notice() }}</p>
  `,
})
export class DownloadExampleComponent {
  readonly bridge = inject(McpBridge);
  readonly notice = signal('');

  async download(): Promise<void> {
    if (!this.bridge.capabilities().downloadFile) {
      this.notice.set('This host does not offer downloads.');
      return;
    }
    try {
      await this.bridge.download({ contents: [{
        type: 'resource',
        resource: { uri: 'bridge://reports/summary', mimeType: 'text/plain', text: 'Atlas is ready.' },
      }] });
      this.notice.set('Download requested.');
    } catch (error) {
      this.notice.set(error instanceof BridgeError && error.code === 'unsupported'
        ? 'This host does not offer downloads.'
        : error instanceof Error ? error.message : String(error));
    }
  }
}
```

The same pattern applies to `openLink()`, `requestDisplayMode()`, file upload and other host actions. Check `bridge.hostContext().availableDisplayModes?.includes('fullscreen')` before offering fullscreen. Use the mode the host grants, read from `bridge.displayMode()`.

## Edit a resource with conflict handling

The demo server registers `bridge://lab/notes`; your server must register its own resource and writing behavior. This recipe keeps `watch: false` while editing so its loaded etag stays the edit's base version. The explicit reload button discards the draft. For a read-only live preview, omit `watch: false` instead.

`apps/demo/src/note-editor.ts`:

```ts
import { Component, computed, effect, inject, signal } from '@angular/core';
import { McpBridge, injectFileResource } from '@angular-mcp-bridge/angular';

@Component({
  selector: 'note-editor',
  standalone: true,
  template: `
    @if (note.isLoading()) { <p>Reading…</p> }
    @if (note.error(); as error) { <p role="alert">{{ error.message }}</p> }
    <textarea #editor aria-label="Note" [value]="draft()"
      [disabled]="!canSave() || note.isLoading() || saving()" (input)="edit(editor.value)"></textarea>
    <button type="button" (click)="save()" [disabled]="!canSave() || note.isLoading() || saving()">Save</button>
    <button type="button" (click)="discardAndReload()" [disabled]="note.isLoading() || saving()">Discard draft and reload</button>
    @if (dirty()) { <p>Unsaved changes.</p> }
    <p role="status">{{ notice() }}</p>
  `,
})
export class NoteEditorComponent {
  private readonly bridge = inject(McpBridge);
  readonly file = injectFileResource({
    uri: () => this.bridge.connected() && this.bridge.capabilities().serverResources
      ? 'bridge://lab/notes' : undefined,
    representation: 'text',
    watch: false,
  });
  readonly note = this.file.resource;
  readonly draft = signal('');
  readonly dirty = signal(false);
  readonly saving = signal(false);
  readonly notice = signal('');
  readonly canSave = computed(() => this.note.hasValue()
    && this.note.value().writable && this.bridge.supportsExtension('resource'));

  constructor() {
    effect(() => {
      if (this.note.hasValue() && !this.dirty()) {
        const value = this.note.value();
        this.draft.set('text' in value ? value.text : '');
      }
    });
  }

  edit(text: string): void { this.draft.set(text); this.dirty.set(true); }

  discardAndReload(): void {
    this.dirty.set(false);
    this.notice.set('');
    this.note.reload();
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      const result = await this.file.save({ text: this.draft() });
      if (result.outcome === 'saved') {
        this.dirty.set(false);
        this.notice.set('Saved.');
      } else if (result.outcome === 'conflict') {
        this.notice.set('The note changed on the server. Keep your draft and resolve it before retrying.');
      } else if (result.outcome === 'too-large') {
        this.notice.set(`The host allows at most ${result.maxBytes} bytes.`);
      }
    } catch (error) { this.notice.set(error instanceof Error ? error.message : String(error)); }
    finally { this.saving.set(false); }
  }
}
```

A conflict keeps the draft and performs no overwrite. Standard resource reads do not imply write support: the host must advertise `openai/resource`, the resource must be writable, and the server must enforce its own authorization. For URI-dependent editors or background subscriptions, store the draft's original etag separately and call `bridge.writeResource(uri, { text: draft }, originalEtag)`.

For loading server data by typed tool name instead of resource URI, use the [typed tool example](ANGULAR-API.md#typed-tool-calls-and-the-initial-result). For server registration, continue to [server APIs](SERVER.md).
