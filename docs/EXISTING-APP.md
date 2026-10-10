# Add MCP Apps to an existing Angular app

Add a Node.js MCP server and a local Workbench to your Angular workspace. Your existing application becomes the default view that a host can open. Your components and original npm scripts are preserved; you decide how the UI uses tool results.

## 1. Check you can use it

| You need | Why |
| --- | --- |
| Angular 22 | The bridge uses Angular 22 APIs. Upgrade an older application using the Angular update process before integrating. |
| A standalone app (`bootstrapApplication`) | `ng add` adds a provider to your bootstrap. NgModule apps need migrating first. |
| Node 22.22.3+ within 22.x, 24.15+ within 24.x, or 26+ | Supported Node releases for this package and Angular 22. |

Commit or stash your work first so you can review exactly what `ng add` changed.

## 2. Run one command

From your workspace root:

```sh
npx ng add @angular-mcp-bridge/cli
```

Angular installs the package and runs the integration. If the workspace has several applications, name one with `--project my-app`. Add `--skip-install` to update `package.json` without installing.

## 3. Start it

```sh
npm run mcp:dev
```

Open the **Workbench** URL it prints, select the generated tool and click **Run tool**. Your existing app opens in the preview as the tool's view. Run `npm run mcp:doctor` if anything looks wrong.

## What was added

| Added | Purpose |
| --- | --- |
| `provideMcpBridge()` in your app config | Connects your app to the host and exposes tool results as signals |
| `mcp/` | The MCP server: `tools.ts` (contracts), `handlers.ts`, `main.ts` |
| `apps/mcp-workbench/` | The local Workbench, a separate Angular app |
| `bridge.config.json`, `views/`, `tsconfig.mcp.json` | Configuration for the build and dev commands |
| `mcp:dev`, `mcp:build`, `mcp:start`, `mcp:doctor` scripts | Your existing scripts are preserved |
| `MCP-BRIDGE.md` | A short summary in your project root |

Nothing in your existing components, routes or styles is edited.

## Display a result in your existing UI

The generated tool returns a placeholder greeting. Its result is visible in the Workbench inspector, but `ng add` does not insert a result display into your existing component.

Create a small standalone component beside your app component, for example **`src/app/mcp-result.component.ts`** in a standard Angular workspace:

```ts
import { JsonPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { McpBridge } from '@angular-mcp-bridge/angular';

@Component({
  selector: 'app-mcp-result',
  standalone: true,
  imports: [JsonPipe],
  template: `
    @if (bridge.connected()) {
      <section aria-label="MCP tool result">
        @if (bridge.toolResult()?.structuredContent; as data) {
          <h2>Tool result</h2>
          <pre>{{ data | json }}</pre>
        } @else {
          <p>Waiting for a tool result.</p>
        }
      </section>
    }
  `,
})
export class McpResultComponent {
  readonly bridge = inject(McpBridge);
}
```

In your existing standalone component, import `McpResultComponent` from that file and add it to its `@Component` **`imports`** array alongside its current imports. Place this element where you want the result to appear in its template:

```html
<app-mcp-result />
```

Keep your existing routes and other UI. In a multi-project workspace, put the component under the selected application's source directory instead of the example `src/app/` path.

Restart `npm run mcp:dev`, open the Workbench and run the generated greeting tool. The preview now shows the returned JSON in your own UI. Outside a connected MCP host, this component hides its result section, so your ordinary website can continue to display its existing content.

This first example displays public `structuredContent` from any tool. For schema-validated output, the separate view generated below already includes a typed client. To use one in your existing component, import your contract from `mcp/features/<tool>/contract.ts` and pass it to `createToolClient()`. The [typed initial results reference](ANGULAR-API.md#typed-tool-calls-and-the-initial-result) explains the API using starter-project contracts; adapt its import to your own contract rather than copying its `examples/shared/` path.

## Make a tool that opens your existing app

Check **`bridge.config.json` → `defaultView`** for your existing application's view name. Its generated tool is named `open_<view>`, with hyphens converted to underscores. For example, an Angular project named `cv-app` has view `cv-app` and tool `open_cv_app`.

For that example, edit:

| File | What you own |
| --- | --- |
| `mcp/features/open_cv_app/contract.ts` | The tool description and its input/output schemas |
| `mcp/features/open_cv_app/handler.ts` | The data returned by the server; call your own backend here |
| Your existing Angular component | How the returned data is displayed |

Use the actual tool folder created in your workspace; `open_cv_app` is an example name. Contracts are shared with the browser, so backend credentials and server-only imports belong in the handler. Installation registers a working greeting, not a connection to your existing API.

## Add a separate tool and view

For a focused CV panel without replacing your existing UI, stop dev and run:

```sh
npx ng generate @angular-mcp-bridge/cli:view cv-panel --tool show_cv
npm run mcp:dev
```

Choose unused view and tool names. The generator creates and registers these editable files:

| File | Purpose |
| --- | --- |
| `mcp/features/show_cv/contract.ts` | Shared input and output schemas |
| `mcp/features/show_cv/handler.ts` | Server implementation |
| `apps/cv-panel/src/app.ts` | A new standalone view that already reads the typed result |

The generated example returns a greeting. Change the contract, handler and view together to return and render CV data. Select the new tool in the Workbench and run it to see this new view. A data-only tool can be generated with `npx ng generate @angular-mcp-bridge/cli:tool search`; it returns data without opening a view.

## Build and connect a host

Run `npm run mcp:build` for production and `npm run mcp:start` to start the MCP server. Your existing website and this Node.js server have separate hosting responsibilities: a frontend-only hosting service needs a separate service for the server.

Publish the MCP server at a public HTTPS `/mcp` endpoint, configure its allowed hosts/origins and authentication, then connect it using [Host setup](HOST-SETUP.md). Your existing website can keep its current URL. Built Angular views are delivered as MCP resources; local Workbench URLs are for development.

## Things to check in your app

Your app will run inside a sandboxed frame in the host, not as a full page.

- **Routing:** the frame has its own URL. Use a route that renders on its own, and avoid depending on a base path or on `window.top`.
- **Authentication:** the host does not share your login cookies. Authenticate the MCP server with [OAuth](SERVER.md) and have tools call your API server-side.
- **Size:** the view reports its content height to the host, so let the content size itself. Fixed viewport-height layouts such as `100vh` can behave oddly in a host frame; check them in the Workbench.
- **Data:** let the server handler call your backend. Tools can call your API server-side, with credentials held by the server. See the [server guide](SERVER.md).

## Undo

The integration is an ordinary set of file changes. Review it with `git status` and `git diff`. To undo it, restore the bridge-related edits from your pre-install commit, remove the generated bridge files and Workbench, and run `npm install`. Restore only the changes you intend to undo, preserving later application work.

## Troubleshooting

| Message | Fix |
| --- | --- |
| "needs Angular 22 or newer" | Run `ng update @angular/core @angular/cli`, then repeat `ng add`. |
| "supports standalone Angular applications" | Migrate the bootstrap to `bootstrapApplication`. |
| "Select an existing Angular application with --project" | The workspace has several apps; pass `--project <name>`. |
| "Existing bridge configuration is preserved" | The workspace is already set up. Use `ng generate` to add tools. |
| Unsupported Node version | Install a supported Node release, then `npm install`. |

More options are in [Native tooling](TOOLING-NATIVE.md) and [Troubleshooting](TROUBLESHOOTING.md).
