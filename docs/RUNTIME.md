# Angular resource and state patterns

Start with [the Angular API](ANGULAR-API.md) and [the first-app tutorial](FIRST-APP.md). These additions use Angular 22 resources, resource chaining, snapshots, linked signals and environment-owned dependency injection.

## Compose dependent reads

Save this as `apps/demo/src/project-summary.ts`, import `ProjectSummaryComponent` into your view's `imports`, and render `<project-summary />`. It uses the generated project's existing shared contracts.

```ts
import { Component, inject } from '@angular/core';
import { createToolClient, McpBridge, retainedResourceValue } from '@angular-mcp-bridge/angular';
import { tools } from '../../../examples/shared/tools.js';

@Component({
  selector: 'project-summary', standalone: true,
  template: `
    @if (details.isLoading()) { <p>Loading project details…</p> }
    @if (details.error(); as error) { <p role="alert">{{ error.message }}</p> }
    @if (previous(); as value) { <p>{{ value.project.name }}</p> }
  `,
})
export class ProjectSummaryComponent {
  private readonly bridge = inject(McpBridge);
  private readonly client = createToolClient(tools);
  readonly projects = this.client.resource('list_projects', {
    params: () => ({ status: 'ready' }), debugName: 'Ready projects',
  });
  readonly details = this.client.resource('get_project', {
    params: ({ chain }) => {
      const list = chain(this.projects);
      const id = list?.projects[0]?.id;
      return id ? { id } : undefined;
    },
    debugName: 'First ready project',
  });
  readonly previous = retainedResourceValue(this.details, {
    resetKey: () => this.bridge.connectionEpoch(),
  });
}
```

`chain()` waits for a resolved/local upstream value and propagates idle/loading/error states without starting a premature RPC. A dependency failure retains its original error as `cause`. Use `info()` instead of another read when you only need the initial tool result that opened the widget.

Both tool-resource `params` and file-resource `uri` callbacks receive native `ResourceParamsContext`. Options also accept `equal`, `defaultValue`, and `debugName`. Equality compares loaded values, not authorization scopes or request inputs. `defaultValue` supplies display data while unavailable; it does not authorize calls or bypass `chain()`'s state checks.

Resources expose native `snapshot()` values. Import `resourceFromSnapshots` from `@angular/core` to compose several resource states. `retainedResourceValue(resource, { initialValue?, resetKey? })` preserves the latest available value through loading/errors. For authenticated views, include your authorization scope in `resetKey`, as well as the bridge's connection epoch, so the previous account's display data clears when identity changes.

MCP tool calls return complete results. These wrappers do not invent a stream of intermediate results. Native Angular streaming resources can consume actual application-owned streams; partial host tool input remains available through bridge signals.

## Share reads explicitly

Cache sharing is off by default. Add the provider beside your existing bridge provider. This example belongs in `apps/demo/src/main.ts` and intentionally uses a fixed scope for the public demo data:

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { provideMcpBridge, provideMcpReadCache } from '@angular-mcp-bridge/angular';
import { DemoComponent } from './app.js';

bootstrapApplication(DemoComponent, {
  providers: [
    provideMcpBridge({ name: 'project-view' }),
    provideMcpReadCache({ scope: () => 'public-demo', ttlMs: 0, maxEntries: 100 }),
  ],
}).catch(console.error);
```

Then opt individual reads in with `{ params: ..., cache: true }`, or `{ uri: ..., cache: true }`. `ttlMs: 0` deduplicates only concurrent requests. A positive provider TTL, or a query's `cache: { ttlMs: 5_000 }`, explicitly permits reusing completed data. Writes and commands are never cached.

For an authenticated application, replace the fixed scope with a reactive application-owned account/permission-version signal. Change it whenever authorization changes; it must not contain credentials. The bridge cannot detect an identity change that your application/host does not expose. Cache scopes partition data; they do not authenticate requests or replace server authorization.

Caches are isolated by bridge instance, connection epoch, authorization scope, tool/resource identity, wire arguments, timeout and TTL policy. JSON keys normalize property order. Non-JSON/cyclic wire values bypass sharing. Each consumer receives its own cloned result. Cancelling one consumer leaves other readers active; cancelling the last reader aborts the shared transport. Scope changes, connection closure and injector destruction abort pending reads, including entries evicted from the sharing table. Failures are never cached. `maxEntries` limits the sharing table, rather than cancelling legitimate concurrent work.

Save this component as `apps/demo/src/project-cache-actions.ts`, then import/render it in your view to offer an explicit refresh:

```ts
import { Component } from '@angular/core';
import { injectReadInvalidation } from '@angular-mcp-bridge/angular';

@Component({
  selector: 'project-cache-actions', standalone: true,
  template: `<button type="button" (click)="refreshProjects()">Refresh projects</button>`,
})
export class ProjectCacheActionsComponent {
  readonly reads = injectReadInvalidation();

  refreshProjects(): void {
    this.reads.tool('list_projects');
    this.reads.tool('get_project');
  }
}
```

You can also call `refreshProjects()` after your real mutation succeeds. `resource(uri)` invalidates a resource group; `all()` invalidates the view's cached reads. Invalidation also reloads active consumers. These methods are harmless without a cache provider. With a positive tool cache TTL, use explicit invalidation when you need fresh server data; native `resource.reload()` may reuse a still-valid cache entry. The file handle's `reload()` explicitly invalidates before reading, and subscriptions/successful writes do the same.

## Preserve an editable draft

The lab uses `injectResourceDraft(fileHandle)`. Save this component as `apps/demo/src/note-draft.ts`, then import/render it in your view.

```ts
import { Component, computed, inject, signal } from '@angular/core';
import { injectFileResource, injectResourceDraft, McpBridge } from '@angular-mcp-bridge/angular';

@Component({
  selector: 'note-draft', standalone: true,
  template: `
    @if (file.resource.error(); as error) { <p role="alert">{{ error.message }}</p> }
    <textarea #input aria-label="Shared note" [value]="text()"
      [disabled]="!file.resource.hasValue() || editor.saving()"
      (input)="editor.set({ text: input.value })"></textarea>
    <button type="button" (click)="save()" [disabled]="!canSave()">Save</button>
    <button type="button" (click)="editor.reload()" [disabled]="editor.saving()">Reload server</button>
    <button type="button" (click)="editor.discard()"
      [disabled]="!file.resource.hasValue() || editor.saving()">Discard draft</button>
    @if (editor.dirty()) { <p>Unsaved changes are preserved.</p> }
    @if (editor.remoteChanged()) { <p>The server version changed.</p> }
    @if (editor.conflict()) { <p role="alert">Resolve the conflicting edit before retrying.</p> }
    <p role="status">{{ notice() }}</p>
  `,
})
export class NoteDraftComponent {
  private readonly bridge = inject(McpBridge);
  readonly file = injectFileResource({
    uri: () => this.bridge.connected() && this.bridge.capabilities().serverResources
      ? 'bridge://lab/notes' : undefined,
  });
  readonly editor = injectResourceDraft(this.file);
  readonly notice = signal('');
  readonly text = computed(() => {
    const content = this.editor.content();
    return 'text' in content ? content.text : '';
  });
  readonly canSave = computed(() => this.editor.canSave() && !this.editor.saving()
    && this.bridge.supportsExtension('resource'));

  async save(): Promise<void> {
    try {
      const result = await this.editor.save();
      this.notice.set(result.outcome === 'saved' ? 'Saved.'
        : result.outcome === 'conflict' ? 'Your draft was kept.' : 'The draft exceeds the host size limit.');
    } catch (error) { this.notice.set(error instanceof Error ? error.message : String(error)); }
  }
}
```

The draft keeps the content and etag it was based on. A subscribed refresh updates remote data while preserving dirty content and the original `baseEtag()`. `reload()` refreshes remote data; `discard()` explicitly adopts the currently loaded remote version. Save sends the original etag and exposes conflicts without overwriting a newer version. `saving()`, `error()`, `remoteChanged()` and `canSave()` support UI controls. The helper supports text and base64 blob content.

If selection changes while a dirty draft exists, it stays available and cannot be saved to the new resource. Explicitly discard it to adopt the new loaded selection. An old save completion cannot replace another resource's clean draft. Edits made during a save remain dirty against the acknowledged saved version. When no etag was supplied, the host cannot enforce a version check; the helper does not manufacture one. Resource writes still require advertised host support, a writable resource and server authorization.

The file handle also exposes `selectedUri()`, loaded values include `resourceUri`, and `save(content, { ifMatch })` supports an explicit original version. Load before editing/saving. Draft actions reject after their Angular owner is destroyed; native resources dispose their loads with that owner.

## Compose model context once

The bridge combines manual context, explicitly shared view state and declarative descriptions. Synchronous writers coalesce into one latest merged snapshot; every promise receives the acknowledgment ID for that snapshot. Updates arriving during a request send a subsequent snapshot. Byte-equivalent wire snapshots skip another request and reuse the latest host acknowledgment. Reconnection invalidates that acknowledgment.

Coalescing intentionally allows later updates to supersede intermediate values for the same owner. A failed request rejects its writers and restores the previous accepted state; failed older versions and permanently removed component contributions are not resurrected. Disconnect rejects pending writers promptly, even if a transport ignores cancellation. Diagnostic budgets remain observational and never truncate payloads.

## Render details on demand

The lab's **Load deferred details** button demonstrates a standalone component inside Angular `@defer`. The default standalone HTML build includes the full JavaScript graph, so deferred rendering reduces initial component work but does not remove its bytes from that HTML. Only an explicitly configured hosted-assets build can preserve lazy network chunks. See [tooling](TOOLING.md) for build modes and [host setup](HOST-SETUP.md) for the actual host/CSP boundary.
