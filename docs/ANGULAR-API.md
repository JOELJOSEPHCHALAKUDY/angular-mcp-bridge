# Angular API reference

Start with [Getting started](GETTING-STARTED.md) and [your first app](FIRST-APP.md). Use [recipes](RECIPES.md) for complete components, or return to the [documentation map](index.md).

The UI uses Angular 22 standalone components, dependency injection, signals, native `resource()`, templates, and `DestroyRef`. Widgets call MCP through their host; do not add a second REST client to call the same tools.

## Choose an API

| You want to… | Use | Why |
| --- | --- | --- |
| Render the tool result that opened this widget | `createToolClient(tools).info(name)` | Typed, validated initial input/output and private metadata; no extra request. |
| Fetch read-only data when a selection/filter changes | `createToolClient(tools).resource(name, { params })` | Angular owns loading, cancellation and reload. |
| Run an action after a click, including a mutation | `createToolClient(tools).inject(name).execute(input)` | Execution is explicit; signals expose pending/data/error. |
| Read a file/resource by URI | `injectFileResource({ uri })` | Native Angular resource with optional host subscriptions and saving. |
| Edit a resource while its server version changes | `injectResourceDraft(file)` | Preserves the draft and original ETag; explicit save/discard/reload. |
| Share or cache repeated read requests | `provideMcpReadCache({ scope })` | Opt-in injector/connection/account ownership and explicit invalidation. |
| Validate a typed tool form | `injectToolForm()` from `/forms` | Native Signal Forms with explicit server submission. |
| Keep temporary UI state | Angular `signal()` | Private and component-local. |
| Persist or explicitly share UI state | `injectViewState()` | Versioned persistence and owned model-context contributions. |
| Let the host call a tool implemented by this component | `injectViewTool()` | SDK registration ends with the component's Angular lifetime. |
| Describe visible UI to the model | `DataLlmDirective` | Declarative, nested descriptions with coalesced updates. |
| Send messages, change display mode, open files or links | `inject(McpBridge)` | Capability-aware host actions. |

`createToolClient(tools)` itself is a plain factory. Call its `inject()`, `info()`, and `resource()` methods in an Angular injection context: a component/service field initializer or constructor. Do the same for `injectViewState()`, `injectFileResource()`, and `injectViewTool()`. Event handlers should call an already-created client, rather than calling an injection helper after an `await`.

## Provide one bridge per view

In the generated application's `apps/demo/src/main.ts`:

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { provideMcpBridge } from '@angular-mcp-bridge/angular';
import { DemoComponent } from './app.js';

bootstrapApplication(DemoComponent, {
  providers: [provideMcpBridge({ name: 'project-view', version: '1.0.0' })],
}).catch(console.error);
```

Keep the bootstrap component and imports matched to your Angular application. The initializer starts the handshake without blocking rendering. `McpBridge` and `McpViewContext` belong to the environment where the provider is installed; separate child environments receive separate instances. Angular destruction closes the transport and removes owned work.

| Option | Default | Use |
| --- | --- | --- |
| `name` | Required | Widget client identity; it need not equal the server name. |
| `version` | `'0.1.0'` | Client version reported to the host. |
| `connectTimeoutMs` | `10_000` | Bound the initial handshake. |
| `transportMode` | `'auto'` | `'mcp'` forces standard MCP Apps; `'legacy'` requires a usable older `window.openai.callTool` host. |
| `legacyProbeTimeoutMs` | At most `1_000`, and half the connect timeout | In auto mode, bound the standard handshake probe before a legacy fallback. Must be shorter than `connectTimeoutMs`. |
| `transportFactory` | Official SDK adapter | Inject a transport for tests or a compatible integration. |
| `contextBudget`, `onContextWarning` | Observer disabled | Opt-in developer diagnostics; see below. |

Use the local workbench to open the widget. Opening its URL directly in a top-level tab requires a usable legacy host adapter. In an iframe, auto mode prefers the standard handshake and only falls back after the probe times out; an explicit handshake failure is not treated as permission to change protocols.

## Typed tool calls and the initial result

This component uses the existing project contracts. Save it as `apps/demo/src/project-panel.ts`; the relative import works in both the framework and generated app. Import `ProjectPanelComponent` into your view component's `imports` and render `<project-panel />`.

```ts
import { Component, signal } from '@angular/core';
import { createToolClient } from '@angular-mcp-bridge/angular';
import { tools } from '../../../examples/shared/tools.js';

@Component({
  selector: 'project-panel',
  standalone: true,
  template: `
    @if (initial(); as invocation) {
      @if (invocation.status === 'success') {
        <p>{{ invocation.output.projects.length }} projects in the initial result.</p>
      }
    }
    <button type="button" (click)="selectedId.set('atlas')">Watch Atlas</button>
    @if (project.isLoading()) { <p>Loading…</p> }
    @if (project.error(); as error) { <p role="alert">{{ error.message }}</p> }
    @else { <p>{{ project.value()?.project.name }}</p> }

    <button type="button" (click)="loadOnce()" [disabled]="details.pending()">Load once</button>
    <p>{{ details.data()?.project.name }}</p>
    @if (details.error(); as error) { <p role="alert">{{ error.message }}</p> }
  `,
})
export class ProjectPanelComponent {
  private readonly client = createToolClient(tools);
  readonly selectedId = signal<string | undefined>(undefined);
  readonly initial = this.client.info('list_projects');
  readonly details = this.client.inject('get_project');
  readonly project = this.client.resource('get_project', {
    params: () => {
      const id = this.selectedId();
      return id ? { id } : undefined;
    },
    timeoutMs: 15_000,
  });

  async loadOnce(): Promise<void> {
    try { await this.details.execute({ id: 'atlas' }, { timeoutMs: 15_000 }); }
    catch { /* details.error() renders the failure. */ }
  }
}
```

Use `info()` for the tool actually bound to this view. It returns a computed union with `pending`, `success`, `error`, or `cancelled` status. Only a success has validated output. Input may be partial while streaming. Add `{ metadataSchema: yourZodSchema }` to validate and type private `_meta`; it is otherwise a record of unknown values.

A command exposes readonly `status`, `pending`, `data`, `error`, `result`, and `metadata` signals. `execute()` validates input, sends the original wire value so server transforms run once, validates output, and returns the parsed output. Newer calls own displayed state; older promises still resolve for their callers. `reset()` clears state and cancels outstanding calls. Destruction requests cancellation too; an older legacy host cannot cancel work already dispatched on its side.

A reactive query exposes Angular `value()`, `isLoading()`, `error()`, and `reload()`. An undefined parameter leaves it idle. Parameter changes cancel the obsolete request. Only tools with `annotations.readOnlyHint: true` can use this helper; call mutating tools explicitly. Guard `value()` with `error()` or `hasValue()` because an errored Angular resource can throw when read. See [runtime recipes](RUNTIME.md) for native `chain()` composition, retained results, equality, scoped deduplication and invalidation.

## Host state and lifecycle

Inject `McpBridge` once in your component: `readonly bridge = inject(McpBridge)`, importing both `inject` from `@angular/core` and `McpBridge` from this package. Read its signals in the template or a `computed()`.

| Signal | Contents |
| --- | --- |
| `status`, `connected`, `error` | Connection state and protocol errors. |
| `toolInput`, `toolResult`, `toolOutput`, `toolMetadata`, `cancelled` | Current host invocation, partial input, result and private metadata. |
| `hostContext`, `capabilities` | Standard host hints and advertised capabilities. |
| `hostInfo` | Normalized host name/version and supported extension flags. |
| `theme`, `locale`, `displayMode` | Appearance and the applied display mode. |
| `user` | Normalized locale, device class, touch/hover hints; not authenticated identity. |
| `viewport` | Granted dimensions, maximum height and safe-area insets. |
| `deepLink` | A validated app-relative deep link, when supplied. |
| `modelContext` | Reflected OpenAI context/update ID, when supplied. |
| `modal`, `display` | Local modal state and host display hints. |

`requestDisplayMode(mode)` records the mode actually granted. `requestSize({ width?, height? })` sends finite, nonnegative pixel dimensions; the standard adapter also resizes automatically. `requestClose()` asks the host to dismiss the view. `disconnect()` is recoverable; `reconnect()` and `retryConnect()` create a new handshake. `close()` and injector destruction permanently dispose this instance. Previous connections cannot overwrite newer state.

## Messages and model-visible context

Use [the message/context recipe](RECIPES.md#send-a-message-and-share-selection) for a complete component.

| Method | Payload / behavior |
| --- | --- |
| `sendMessage(textOrContentBlocks, options?)` | Standard text/image/resource content. Optional `{ target: 'new' }` requires `openai/message`; `{ scrollToBottom: false }` requires the detected ChatGPT text method. |
| `updateModelContext(structuredContent)` | Convenient structured context update; returns `Promise<void>`. |
| `setModelContext({ content?, structuredContent?, _meta? })` | Full standard context payload; returns an optional host update ID. |
| `setModelContextContribution(ownerKey, payload)` | Adds or replaces one independent contribution. |
| `removeModelContextContribution(ownerKey)` | Permanently removes it, even when disconnected. |
| `createModelContextContributionKey(prefix?)` | Allocates an injector-local owner ID. |

Ordinary messages prefer standard MCP Apps. Application context, explicitly shared state and directive descriptions are composed and sent through a serialized queue. Same-turn contributions are coalesced across the bridge, and acknowledged unchanged snapshots are skipped. Every caller still receives completion or failure; reconnects isolate pending updates. Use different `structuredContent` property names when independently owned contributions must coexist; duplicate properties use the later contribution's value. Destroy your own manually created contributions with the owning component; injection helpers do this automatically.

## Private state, persistence and sharing

For temporary UI state, prefer an Angular signal. Use `injectViewState()` when you need its sharing or persistence behavior. The [selection recipe](RECIPES.md#send-a-message-and-share-selection) stays private until the user clicks Share.

To create a persistent selection helper, save this as `apps/demo/src/selection-state.ts`:

```ts
import { injectViewState } from '@angular-mcp-bridge/angular';
import { z } from 'zod';

export function injectPersistentSelection(viewInstanceKey: string) {
  return injectViewState({ id: 'atlas' }, {
    key: `${viewInstanceKey}:selection`,
    persist: true,
    version: 1,
    schema: z.object({ id: z.string() }),
    shareKey: 'selection',
  });
}
```

Call that helper in a component field/constructor with a stable, unique conversation/view-instance key from your application. Reuse the key to restore the same instance; use another key for a separate instance. A random new key on every reload prevents restoration. The bridge does not invent an authenticated user or conversation identifier for you.

| Option / member | Behavior |
| --- | --- |
| `value()` | Readonly signal with current private state. |
| `set(valueOrUpdater)` | Updates immediately; returns a promise for persistence and optional sharing. The configured schema validates new values too. |
| `share()` | Publishes the current value as an owned model-context contribution. |
| `persist` | Default false; requires both `key` and `schema`. |
| `version` | Default 1; mismatched stored versions reset to the initial value. |
| `shareKey` | Model-visible property, default `viewState`; use distinct names for multiple states. |
| `autoShare` | Default false; explicit opt-in to publishing successful `set()` updates. It does not share the initial value by itself. |

Default persistence prefers host widget state and otherwise uses session storage when available. Host storage lives under `widgetState.privateContent.angularMcpBridge`; writes preserve unrelated state and image IDs. Invalid restored data resets to the initial value. Sharing stays separate from private persistence, and component destruction removes that state's shared contribution.

Override storage at bootstrap with `provideViewStateStore({ read, write })`, or `provideBrowserViewStateStore('local' | 'session')`. Import the provider from `@angular-mcp-bridge/angular` and add it alongside `provideMcpBridge`. `read(key)` is synchronous; `write(key, { version, value })` may be asynchronous. Browser persistence uses JSON-safe values, may be denied by sandbox policy, and is not a cross-host durability guarantee. A custom store can implement its own serialization.

## Describe UI and expose component tools

[Recipes](RECIPES.md) include full standalone components for both APIs.

`DataLlmDirective` uses `[dataLlm]="description"`, optionally `[dataLlmEnabled]="enabled"`. Import it in the component's `imports`. Prefer an explicit string/computed description for predictable semantic content. An undefined value observes the element's `textContent`, including descendants. Empty strings and null stay empty. Nested descriptions retain their hierarchy; updates coalesce after 40 ms. This explicitly shares described content with the model, and `inject(McpViewContext).error()` reports failures. Angular destruction removes descriptions and observers.

`injectViewTool(name, { inputSchema, outputSchema?, title?, description?, annotations? }, handler)` registers a callable app-side tool. The handler receives parsed input and an `AbortSignal`, and returns standard `{ content, structuredContent?, _meta? }`. The SDK validates schemas. The returned `ready`, `status`, and `error` describe registration; `enable()`, `disable()`, and `remove()` control it. Use unique names per bridge environment. Destruction removes the tool. `bridge.registerViewTool()` is the lower-level bridge-lifetime API. Registering a tool does not promise that every real host will expose it to a model.

## Read and edit MCP resources

Choose `injectFileResource({ uri, representation?, watch? })` for a reactive file. The [editor recipe](RECIPES.md#edit-a-resource-with-conflict-handling) includes loading, errors and conflicts. `uri()` may return undefined to remain idle. Representation is `'text'` or `'blob'`; reads return that content plus optional `mimeType`, `writable`, and `etag`.

The helper returns `{ resource, watching, save }`. It forwards Angular cancellation, subscribes when supported unless `watch: false`, and reloads after a successful save. `save({ text } | { blob })` supplies the resource's currently loaded etag and returns `saved`, `conflict`, or `too-large`. It rejects a loaded read-only resource. Load before editing. For an unsaved draft, retain the etag of the version the draft was based on; use `watch: false` or an explicit `bridge.writeResource(uri, content, originalEtag)` so a background reload cannot silently advance your edit's base version.

| Imperative API | Support / result |
| --- | --- |
| `readResource(uri, representation?, { signal?, timeoutMs? }?)` | Standard `serverResources`; returns one content representation with metadata. |
| `listResources({ cursor? }?)` | Standard `serverResources`; SDK resource listing. |
| `listResourceTemplates({ cursor? }?)` | Standard `serverResources`; SDK template listing. |
| `watchResource(uri, listener)` | Advertised `openai/resource` extension; returns an async disposer. |
| `writeResource(uri, content, ifMatch?)` | `openai/resource`; returns an explicit write outcome. |
| `openFile(path)` | Advertised `openai/files` extension. |

Standard read support does not imply subscriptions or writes. Watchers are deduplicated by URI and cleaned up on disconnect. The reactive helper recreates them as capabilities/connection change; direct callers must recreate watches after reconnecting. Writes never automatically retry an etag conflict.

## Host files, links and dialogs

| Method | Required support |
| --- | --- |
| `openLink(httpOrHttpsUrl)` | Standard `openLinks`. |
| `openExternal(url, { redirectUrl: false })` | Detected ChatGPT method for redirect control. |
| `download({ contents })` | Standard `downloadFile`; embedded resources or resource links. |
| `uploadFile(file, { library? }?)` | Detected file-upload method; returns `{ fileId, fileName?, mimeType? }`. |
| `selectFiles()` | Detected file picker; returns file metadata entries. |
| `getFileDownloadUrl(fileMetadata)` | Detected host method; returns `{ downloadUrl }`. |
| `setOpenInAppUrl(url)` | Detected ChatGPT method; HTTP(S). |
| `openModal({ title?, params?, template?, anchor? }?)` | Detected host modal method, or explicitly enabled local fallback. |

All optional actions are feature-detected and fail explicitly when unavailable. Catch `BridgeError` with `code === 'unsupported'` to show a useful fallback; [the host-action recipe](RECIPES.md#download-and-handle-unsupported-actions) demonstrates this. Image IDs from uploads/selections preserve unrelated widget state.

Use `provideChatGptExtensions(adapter)` for tests or an equivalent host adapter; production defaults read optional methods from `window.openai`. An injected adapter does not add authenticated capabilities to an unrelated host.

For the Angular local fallback, install `provideLocalMcpModal()` alongside the bridge, import `McpModalOutlet` in the component, and render `<mcp-modal-outlet [modalContent]="yourTemplate" />`. See [the complete dialog recipe](RECIPES.md#render-an-angular-dialog-fallback). Hosts with `requestModal` own their rendering/dismissal; the local fallback is used when that method is absent. `closeModal()` closes the local dialog and rejects attempts to control a host-owned modal. One outlet belongs to one bridge environment, stays inside the iframe, and renders application-owned Angular templates rather than remote HTML.

## Optional context diagnostics

`estimateContextSize(value)` reports UTF-8 JSON bytes and a rough token estimate, excluding top-level private `_meta`. `checkContextBudget(value, { budgetTokens })` compares against an explicit developer budget. Unmeasurable data returns null sizes and `serializable: false`.

To opt in, use this application config:

```ts
import type { ApplicationConfig } from '@angular/core';
import { provideMcpBridge } from '@angular-mcp-bridge/angular';

export const appConfig: ApplicationConfig = {
  providers: [provideMcpBridge({
    name: 'project-view',
    contextBudget: { toolResultTokens: 5_000, modelContextTokens: 20_000 },
    onContextWarning: warning => { console.warn('MCP context budget reached', warning); },
  })],
};
```

The observer receives measurements, kind/source and tool name when known, without payload data. It checks received results and merged outgoing context. Defaults are heuristics of 5,000/20,000 tokens at four UTF-8 bytes per token; they are not host limits or exact tokenizer counts. Override the ratio with `contextBudget.bytesPerToken`. No warning occurs by default, observer failures are isolated, and estimates do not truncate or block payloads.

## What is verified

Unit/compiler tests and the local workbench exercise lifecycle, schema validation, protocols and capability behavior. Named-host profiles are simulations; they do not certify native uploads/modals or every feature in live ChatGPT, Claude or other hosts. [Host setup](HOST-SETUP.md) explains testing in your actual host. For server registration and authorization, continue to [server APIs](SERVER.md).
