# Add MCP Apps to an existing Angular app

One command turns an existing Angular app into an MCP App you can try in a local workbench. Your UI and npm scripts are left as they are.

## 1. Check you can use it

| You need | Why |
| --- | --- |
| Angular 22 or newer | The bridge uses Angular 22 APIs. On an older app, run `ng update @angular/core @angular/cli` first; `ng add` stops with this message if it detects an older version. |
| A standalone app (`bootstrapApplication`) | `ng add` adds a provider to your bootstrap. NgModule apps need migrating first. |
| Node 22.22.3+, 24.15+ or 26+ | Required by Angular 22 itself. |

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

## 4. Make it yours

The generated tool is a placeholder greeting. Replace it with something your app can do:

1. Edit the tool's `contract.ts` (input and output schemas) and `handler.ts` (what the server returns) under `mcp/features/`.
2. Read the result in your component with `client.info('your_tool')`. See [Build your first tool and view](FIRST-APP.md).
3. Add more with `npx ng generate @angular-mcp-bridge/cli:view reports` (a tool with its own view) or `...:tool search` (a data-only tool).

## Things to check in your app

Your app will run inside a sandboxed frame in the host, not as a full page.

- **Routing:** the frame has its own URL. Use a route that renders on its own, and avoid depending on a base path or on `window.top`.
- **Authentication:** the host does not share your login cookies. Authenticate the MCP server with [OAuth](SERVER.md) and have tools call your API server-side.
- **Size:** the view reports its content height to the host, so let the content size itself. Fixed viewport-height layouts such as `100vh` can behave oddly in a host frame; check them in the Workbench.
- **Data:** let the server handler call your backend. The view should not call your API directly. See the [server guide](SERVER.md).

## Undo

The integration is an ordinary set of file changes. Review it with `git status` and `git diff`. To undo it, discard the edits to your tracked files (`git restore .`), delete the new files listed in the table above, and run `npm install`.

## Troubleshooting

| Message | Fix |
| --- | --- |
| "needs Angular 22 or newer" | Run `ng update @angular/core @angular/cli`, then repeat `ng add`. |
| "supports standalone Angular applications" | Migrate the bootstrap to `bootstrapApplication`. |
| "Select an existing Angular application with --project" | The workspace has several apps; pass `--project <name>`. |
| "Existing bridge configuration is preserved" | The workspace is already set up. Use `ng generate` to add tools. |
| Unsupported Node version | Install a supported Node release, then `npm install`. |

More options are in [Native tooling](TOOLING-NATIVE.md) and [Troubleshooting](TROUBLESHOOTING.md).
