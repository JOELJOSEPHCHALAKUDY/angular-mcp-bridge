# @angular-mcp-bridge/angular

Angular 22's DI, readonly signals, native resources, standalone directives/components and `DestroyRef` power this MCP Apps UI library. The host handles tool calls; a widget does not need its own REST API client.

Part of [Angular MCP Bridge](https://github.com/JOELJOSEPHCHALAKUDY/angular-mcp-bridge). Install with `npm install @angular-mcp-bridge/angular`. To start a new app, follow the [README](https://github.com/JOELJOSEPHCHALAKUDY/angular-mcp-bridge#readme) and the [first-app tutorial](https://github.com/JOELJOSEPHCHALAKUDY/angular-mcp-bridge/blob/main/docs/FIRST-APP.md). Peers: Angular core/common 22.2.2, MCP Apps 2.0.3, MCP core 2.3.1, the contracts package and Zod 4. Reference: [docs/ANGULAR-API.md](https://github.com/JOELJOSEPHCHALAKUDY/angular-mcp-bridge/blob/main/docs/ANGULAR-API.md).

## Minimal host-aware view

For an existing Angular application, place this in `src/main.ts` and ensure its HTML contains `<bridge-root></bridge-root>`:

```ts
import { Component, inject } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { McpBridge, provideMcpBridge } from '@angular-mcp-bridge/angular';

@Component({
  selector: 'bridge-root', standalone: true,
  template: `
    <main [attr.data-theme]="bridge.theme()">
      <p>Connection: {{ bridge.status() }}</p>
      <p>Locale: {{ bridge.locale() }}</p>
      @if (bridge.error(); as error) { <p role="alert">{{ error.message }}</p> }
    </main>
  `,
})
export class AppComponent { readonly bridge = inject(McpBridge); }

bootstrapApplication(AppComponent, {
  providers: [provideMcpBridge({ name: 'my-angular-view' })],
}).catch(console.error);
```

Open the view through an MCP Apps host or the generated local workbench. A standalone top-level tab needs a usable legacy `window.openai.callTool` adapter. `transportMode: 'mcp' | 'legacy' | 'auto'` controls transport selection; auto prefers the standard handshake when framed. The provider starts a bounded handshake without blocking Angular rendering and owns cleanup through the environment's lifetime.

## Pick the right Angular primitive

| Task | API |
| --- | --- |
| Initial tool data that opened the widget | `createToolClient(tools).info(name)` computed discriminated union |
| Parameter-driven read-only query | `createToolClient(tools).resource(name, { params })` native Angular resource |
| Click-driven query or mutation | `createToolClient(tools).inject(name).execute(input)` with pending/data/error signals |
| File/resource URI | `injectFileResource({ uri })` with optional watching and saving |
| Editing across server updates | `injectResourceDraft(file)` preserves content and original ETag |
| Share concurrent/cached reads | `provideMcpReadCache({ scope })`, `injectReadInvalidation()` |
| Typed Signal Forms | `injectToolForm()` from `@angular-mcp-bridge/angular/forms` |
| Experimental browser-agent tools | `declareWebMcpTool()` / `injectWebMcpTool()` from `/webmcp` |
| Private state and explicit sharing | `injectViewState(initial, options?)` |
| Component-owned tool callable by the host | `injectViewTool(name, config, handler)` |
| Semantic UI descriptions | Standalone `DataLlmDirective`, selector `[dataLlm]` |
| Local dialog fallback | `provideLocalMcpModal()` + `McpModalOutlet` + Angular `TemplateRef` |
| Messages, layout, links, files and capabilities | `inject(McpBridge)` |

Call injection helpers in a component/service field initializer or constructor. Call the created command's `execute()` from event handlers. A reactive query accepts undefined parameters to stay idle, rejects mutating tools, and cancels stale requests. Guard a resource's `value()` with `error()`/`hasValue()`.

Tool input/output is runtime validated against shared contracts; schema transforms run on the server's original wire input. Newer command calls own displayed state. Initial results and private metadata are read with `info()` without an extra request.

Native resources support `chain()`, equality and snapshots. Read sharing is opt-in and requires an application-owned authorization scope; default zero TTL shares only in-flight requests. Drafts preserve their original version during subscriptions/reloads, with explicit save/discard and conflict signals. Model-context updates coalesce across one bridge and skip unchanged acknowledged snapshots. Generated apps include complete examples in `docs/RUNTIME.md`.

Secondary entry points keep optional features separate. `/forms` requires the optional Angular Forms peer and uses native `FormRoot`/`FormField`. `/webmcp` requires explicit experimental opt-in and feature detection; the normal MCP Apps iframe bridge remains available. See the generated app's `docs/FORMS-AND-WEBMCP.md` for setup and host limits.

State is private by default. Persistence requires a stable unique view-instance key and a restoration schema. `share()` and `autoShare: true` publish intentionally. Host-specific actions are feature-detected and can throw `BridgeError` with `code: 'unsupported'`. A local modal fallback stays inside the iframe; native host modals retain their host-owned lifecycle.

See the sibling [contracts package](https://github.com/JOELJOSEPHCHALAKUDY/angular-mcp-bridge/tree/main/packages/contracts#readme) for shared schemas, [server package](https://github.com/JOELJOSEPHCHALAKUDY/angular-mcp-bridge/tree/main/packages/server#readme) for registration, and [testing package](https://github.com/JOELJOSEPHCHALAKUDY/angular-mcp-bridge/tree/main/packages/testing#readme) for conversation tests. Generated apps include complete standalone examples in `docs/RECIPES.md`. The library's local tests establish API/protocol wiring, not certification in every real host.
