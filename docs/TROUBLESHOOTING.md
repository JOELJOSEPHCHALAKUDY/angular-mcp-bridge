# Troubleshooting

From the app folder, start with `npm run doctor`. Read the first failed check and run its suggested command. Keep the development terminal visible: Angular and server errors appear there.

## Setup and commands

| Symptom | Fix |
| --- | --- |
| `package.json` or `bridge.config.json` is missing | Change into the generated app or framework folder before running commands. |
| Node engine warning or Angular rejects Node | Use Node 24.15.0+, newer 22.x from 22.22.3, or 26+. Run `npm install`; npm scripts then select the pinned local runtime. |
| Angular CLI/tsx/module not found | Run `npm install` in this app. A global Angular installation is unnecessary. Use `npm run …` scripts. |
| npm cannot find `@angular-mcp-bridge/*` in the registry | Check your network and registry settings, and that the versions in `package.json` exist (`npm view @angular-mcp-bridge/server versions`). Apps created from a framework checkout use `vendor/` tarballs and `file:` dependencies; keep them. |
| CLI reports missing local tarballs | In the framework use the simple creator, or run `npm run build` and `npm run pack:all` before advanced `create --local`. |
| Create refuses an existing folder | Choose a new or empty folder. It refuses to overwrite existing work. |
| `start` reports a missing manifest | Run `npm run build` first. For development use `npm run dev`, which prepares the initial resources. |
| Angular workbench bundle budget warning | Compilation can succeed with a warning. The included workbench currently exceeds its 900 KB warning threshold; inspect actual build errors separately. |

An install failure can be retried with `npm install`. Keep the lockfile and vendor directory. Check registry/network access if npm reports a download failure; do not edit generated package names to registry versions.

## Workbench and views

| Symptom | Fix |
| --- | --- |
| The browser can't connect | Keep `npm run dev` running, wait for **Workbench**, then open that exact URL. Port selection can move away from the defaults. |
| A view says it needs an MCP Apps host | Open it inside the workbench, run its bound tool and wait for the handshake. Opening an Angular view URL alone supplies no standard host. |
| A generated view is absent from Server tools | `add-view` creates an application, not a server tool. Follow the contract, registry and handler steps in [First app](FIRST-APP.md). |
| A new tool is absent after editing | Add both its shared definition and handler to `frameworkOptions()` in `examples/server/framework-app.ts`. Wait for the server restart and click **Reconnect**. |
| Changes don't appear | Choose **Angular dev server · HMR**. The bundled source updates after a production build/reconnect. Restart dev after adding a view. |
| HMR URL is unavailable | Start with `npm run dev`, not `start` or `preview`. Inspect `.bridge-runtime.json` for the current URLs; it is generated on startup. |
| `Invalid arguments` or an output validation error | Check the shared Zod contract. Fix the form/JSON input or return the declared `data` shape from the handler. |
| A button reports `unsupported` | Select a host profile that advertises the feature, or capability-check the action. Workbench profiles simulate real host differences. |
| A fixture looks stale | Fixture replay supplies recorded initial data. Run the tool again for current server output. |

**MCP endpoint is not a webpage.** A plain browser GET to `/mcp` is not a tool invocation; use the workbench or an MCP client. Legacy optional SSE requests may return 405 without breaking POST calls. Check the failed operation and protocol logs before treating that response as a connection failure.

## Resources, authentication and public hosts

Resource-write conflicts are expected when the note changed after a read. Reload the resource, preserve any unsaved text and retry against the new ETag. The demo note is process-local and resets on a server restart.

For OAuth, use the workbench's **OAuth connection** controls with a public client and allowed redirect URL. Do not put client secrets in browser configuration. A changed endpoint/issuer/client ID requires matching registration. Rejected state/callbacks, expired credentials or provider restrictions need a fresh sign-in and correct provider settings. See [Host setup](HOST-SETUP.md) and [Server](SERVER.md).

Public hosts require a reachable HTTPS `/mcp` endpoint. Use the MCP port printed by dev when opening a tunnel, and configure the resulting hostname in `ALLOWED_HOSTS`. `ALLOWED_ORIGINS` controls allowed browser origins; resource CSP controls requests made by the view. These are separate settings. See the [host setup guide](HOST-SETUP.md) before testing a real host.

## Get a useful bug report

Include the command, OS, system Node version, doctor output, first error from the terminal, and the relevant tool/view name. Include the schema and a minimal reproduction when possible. Remove bearer tokens, authorization headers, cookies and secrets from logs before sharing.

Return to [Getting started](GETTING-STARTED.md) or the [documentation index](index.md).
