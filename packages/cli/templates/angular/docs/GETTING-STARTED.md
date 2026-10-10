# Getting started

This guide runs the included starter in a generated app or the framework workspace. You will call a real MCP tool and see its result in an Angular view, using only local demo data.

## Before you start

Use npm and a supported Node version: **24.15.0 or newer 24.x**, **22.22.3 or newer 22.x**, or **26+**. The starter pins a local Node 24.15.0 runtime, and npm scripts use it after installation. Using a supported system Node first avoids installation engine warnings.

```sh
node --version
npm --version
```

You do not need an Angular CLI installed globally, an API key or a ChatGPT account for the local workbench. Internet access is needed for dependency installation. npm is the verified package manager; use the included npm lockfile for repeatable installs once generated.

If you have not created an app yet, run `npm install` in the framework folder, followed by `npm run create -- ../my-angular-app --install`. Change into `../my-angular-app`. Packages are currently local and unpublished; do not use an npm registry command to create this version.

## Run locally

From the folder containing your app's `package.json`:

```sh
npm install
npm run dev
```

Skip `npm install` if you created the app with `--install`. `dev` creates the initial build, starts the MCP server, workbench and Angular development servers, and watches changes. The first run builds several Angular applications and can take longer than later edits.

Wait for URLs similar to these; the actual ports may differ:

```text
Workbench: http://127.0.0.1:4200
MCP: http://127.0.0.1:3000/mcp
projects: http://127.0.0.1:4201
lab: http://127.0.0.1:4202
```

Open **Workbench**. The **MCP** URL is the protocol endpoint a host connects to; it is not a webpage. Individual view URLs are Angular development pages; open them through the workbench so the view has a host.

## Get your first successful result

1. Confirm the header says **connected**. The project browser loads automatically.
2. Select **Project overview** in Server tools. Keep the default arguments and click **Run tool**. Four projects appear in the Angular view.
3. Click **Ready** inside the view. It calls the server through the bridge and displays Atlas.
4. Open **Tool result** in the inspector to see the returned data; **Events** records the protocol activity.
5. Select **Angular integration lab** and run it to explore UI tools, resource reads/writes and Angular modal content.

The workbench records assistant messages and model context for inspection. It does not run a live model. Named host profiles simulate capability differences; real-host setup is a later step.

## Edit a view

Choose **Angular dev server · HMR** under **Preview source**. Change the heading in `apps/demo/src/app.ts` and save. Angular updates the preview without a manual resource build. Server files are watched too; if the connection is interrupted during restart, use **Reconnect**.

**Bundled MCP resource** shows production HTML. Rebuild with `npm run build` and reconnect after changes when you want to test that output. New views change the development-server plan: stop `dev`, run `npm run add-view -- greeting`, then restart `npm run dev`.

Stop development with **Ctrl+C** in its terminal. The managed child servers stop together. To diagnose a problem, run:

```sh
npm run doctor
```

## Know where to edit

| File or folder | Purpose |
| --- | --- |
| `examples/shared/tools.ts` | Shared project tool schemas; safe to import into Angular. |
| `examples/server/app.ts` | Demo project handlers and sample data. |
| `examples/server/framework-app.ts` | Active tool registry, handlers, resources and built-view registration. Add your tools here. |
| `examples/generated/<tool>/` | Editable contract/handler source created by native Angular generators. |
| `examples/shared/generated-tools.ts`, `examples/server/generated-handlers.ts` | Registries updated when tools/views are generated. |
| `examples/server/main.ts` | HTTP entrypoint and environment settings. |
| `apps/demo/src/app.ts` | Project browser standalone Angular component. |
| `apps/lab/src/app.ts` | Optional capability examples. |
| `views/*/view.json` | Names and Angular applications for discovered views. |
| `bridge.config.json` | Server entry, workbench, output directory and port preferences. |
| `generated/view-names.ts` | Generated types; regenerate through build, dev or add-view. |
| `dist/` | Built resources; edit source files rather than these outputs. |
| `vendor/` | Framework tarballs in a generated app; npm installs them locally. |

Next: [build your first tool and view](FIRST-APP.md). For common problems, use [Troubleshooting](TROUBLESHOOTING.md).
