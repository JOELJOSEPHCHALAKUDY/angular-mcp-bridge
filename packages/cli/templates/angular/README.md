# Your Angular MCP App

Run from this folder:

```sh
npm install
npm run dev
```

Skip installation if the creator already installed dependencies. Open the **Workbench** URL printed in your terminal. You should see **connected**, four tools and the project browser. Click **Run tool** to invoke the server and inspect its returned data. Local development needs no API key or host account. Ctrl+C stops all development servers.

Choose **Angular dev server · HMR** in Preview source, edit `apps/demo/src/app.ts` and save. Dev selects free ports; always use the printed URLs.

## Start building

- [Getting started](docs/GETTING-STARTED.md): setup, workbench and folder map.
- [Build your first tool and view](docs/FIRST-APP.md): complete typed greeting tutorial.
- [Angular recipes](docs/RECIPES.md): data, state, messages and UI tools.
- [Native generators](docs/TOOLING-NATIVE.md): create a typed tool, handler and view together.
- [Runtime patterns](docs/RUNTIME.md): compose reads, scope caching and preserve editing drafts.
- [Signal Forms and WebMCP](docs/FORMS-AND-WEBMCP.md): optional native form and browser-agent APIs.
- [All documentation](docs/index.md): Angular/server APIs, tooling, evaluations and real-host setup.
- [Troubleshooting](docs/TROUBLESHOOTING.md): run `npm run doctor` for local setup diagnostics.

Views are standalone Angular applications under `apps/`, discovered through `views/*/view.json`. Generate a complete typed feature with `npx ng generate @angular-mcp-bridge/cli:view greeting --tool greet`; customize its editable contract and handler in `examples/generated/greet/`. The generator updates registries and server registration automatically. `npm run add-view -- reports` uses the same native workflow with the tool name `open_reports`. Follow the first-app tutorial for complete file contents.

`npm run build` compiles all views and writes `dist/bridge-manifest.json` plus standalone HTML. `npm run start` serves that build's MCP endpoint. `npm run preview` serves the production workbench for local checks. `npm run check` checks server/contracts; build/dev also compile Angular templates. `npm run docs:check` verifies the bundled documentation links.

Framework packages are local unpublished tarballs under `vendor/`. Keep them with the app and use its lockfile for repeatable installs. They do not reference the source workspace. An [Angular MCP coding skill](.agents/skills/angular-mcp-app/SKILL.md) is included.

Host-shaped workbench profiles are simulations. Follow [Host setup](docs/HOST-SETUP.md) when connecting a real host or preparing public hosting. The [tooling guide](docs/TOOLING.md) explains optional tunnels and local container artifacts.
