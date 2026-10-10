# Angular CLI pipeline

The bridge uses Angular's application and dev-server builders. A view is a standalone Angular application with a `view.json` marker, rather than a React entry point or Vite plugin. Angular compiles templates, resolves application providers and builds its own JavaScript chunks; the bridge then packages that output into MCP HTML resources.

## Create your first app

This release uses the local checkout; it is not published to npm yet. With a supported Node release installed, run these commands from the framework folder:

```sh
npm install
npm run create -- ../my-angular-app --install
cd ../my-angular-app
npm run dev
```

The wrapper runs the local `build:packages` and `pack:all` scripts before scaffolding, so you do not need to pass `--local` or prepare tarballs manually. `--install` installs the generated app's dependencies. Omit it to install later with `npm install`. Dev builds the initial resources itself; a separate build is only needed for `start` or deployment artifacts.

The destination must be new or empty. It is checked before any preparation and again before the staged scaffold is placed. Symbolic-link destinations, scaffold-template folders and framework-tarball folders are rejected. Choose a separate app folder, as in the quickstart. If app installation fails, the generated folder remains available and the error prints recovery commands. Nothing installs automatically without `--install`.

For an already prepared framework checkout, the lower-level command remains `node packages/cli/bin/bridge.mjs create ../my-app --local .`. Run `npm run create -- --help` for the wrapper or `node packages/cli/bin/bridge.mjs create --help` for the lower-level generator.

## Setup diagnostics

Run `npm run doctor` from the framework checkout or a generated app. It reports the active Node version, installed Angular CLI/compiler/build packages, framework entry points, Angular view discovery, server entry and built-resource prerequisites. The supported Node range is `^22.22.3 || ^24.15.0 || >=26.0.0`; this checkout installs Node 24.15 for its npm scripts.

Doctor only reads package/configuration manifests and file metadata. It does not run app code, fetch packages, contact hosts or read `.env` files or credentials. Missing resources are a warning because `npm run dev` builds them. Unsupported Node, missing dependencies or invalid configuration produce exit 1 and an actionable command. Exit 0 means local development prerequisites are ready, possibly with warnings; it does not certify a live host connection or deployment. `npm run doctor -- --json` emits structured diagnostics.

## Discovery and configuration

`bridge.config.json` describes workspace conventions:

```json
{
  "version": 1,
  "viewsDirectory": "views",
  "defaultView": "projects",
  "outputDirectory": "dist",
  "server": { "entry": "examples/server/main.ts", "port": 3000 },
  "workbench": { "project": "workbench", "port": 4200 }
}
```

Each nested `view.json` is discovered automatically:

```json
{
  "name": "projects",
  "project": "demo",
  "description": "Browse projects in Angular",
  "htmlPath": "dist/demo/browser/index.html",
  "devPort": 4201
}
```

`htmlPath` is optional: discovery derives it from the Angular application's `outputPath`. Names must be lowercase identifiers. Duplicate names, projects and HTML paths fail before a build. Workspace paths cannot be absolute or escape through `..`; discovery does not follow symbolic links. The build also rejects source assets and output directories that escape through symbolic links. Old workspaces without view markers retain the `demo` → `projects` fallback.

## Commands

| Command | Behavior |
|---|---|
| `npm run create -- ../my-app [--install]` | From the framework checkout, checks the destination, prepares local framework packages, scaffolds and optionally installs the app. |
| `npm run doctor` or `npm run doctor -- --json` | Reports local setup diagnostics and a next command; exits 1 when a prerequisite needs attention. |
| `npm run build` | Discovers views, generates literal names, builds each Angular application and workbench, checks server TypeScript, bundles each view. |
| `npm run dev` | Builds initial resources, chooses available ports, starts the API watcher and Angular HMR servers, waits for all endpoints, prints actual URLs. |
| `npm run start` | Requires an existing build manifest, then starts the configured TypeScript server. |
| `npm run preview` | Serves the built workbench and MCP server for a local production check; `PORT` overrides the default 3000. |
| `npm run benchmark` | Records resource sizes in `dist/benchmark.json`; optionally measures the printed workbench URL in a browser. |
| `npm run add-view -- reports` | With a native registry, generates a typed contract, handler and standalone Angular view through Angular schematics; old workspaces retain the view-only generator. |
| `npm run deploy` or `npm run deploy -- deployment` | Requires a concrete build and lockfile, writes Dockerfile/Compose configuration, refuses a nonempty destination. |
| `npm run tunnel -- --provider cloudflared --port 3001` | Starts an already installed tunnel provider explicitly; `ngrok` is also supported. |

Generated starter projects expose `npm run build`, `dev`, `start`, `preview`, `doctor`, `add-view`, `deploy`, `tunnel`, `docs:check` and `benchmark`. Every CLI command supports its own `--help`, for example `npm run add-view -- --help`. The preview and benchmark scripts are local starter utilities; the [performance guide](PERFORMANCE.md) explains browser dependencies. Starters include local CLI modules and vendored framework tarballs; no source alias points back into the framework checkout. The scaffold contains both example views and an Angular MCP agent skill. The installed CLI also supplies genuine `ng add`, `ng generate` and `ng update` collections; see [Native Angular tooling](TOOLING-NATIVE.md) for existing-app integration and typed generators. The package is currently unpublished.

## Artifacts and type checking

`generated/view-names.ts` exports a literal tuple, the `ViewName` union and `isViewName()` guard. Import the union where view names are defined, or use `satisfies ViewName` for a tool's `view` value. It is generated before server type checking.

`dist/bridge-manifest.json` maps view names to **workspace-relative** HTML paths, Angular project, description, SHA256 and default resource CSP. Server integrations should resolve these paths against the workspace. Each view has its own `dist/views/<name>.html`. The default view also becomes `dist/widget.html` for older integrations.

The bundler flattens Angular's dynamic JavaScript imports through esbuild, inlines CSS, encodes supported local images/fonts as data URLs, and removes preload links. It checks critical inline CSS too. Build-time external assets, unresolved runtime `import.meta.url`, CSS `@import` and HTML `srcset` fail with an actionable error instead of returning an incomplete widget. Use Angular imports or a local `img src` for assets. Runtime network requests need an explicit MCP resource CSP and server authorization; bundling does not infer domain permissions.

For separate Angular lazy chunks and `@defer` output, opt into `delivery.mode: "assets"` with an explicit HTTPS asset origin. This writes hashed assets and CSP metadata while retaining self-contained delivery as the default. The [native tooling guide](TOOLING-NATIVE.md#optional-asset-delivery) explains the allowlisted serving contract and deployment requirements.

## Local development

Port selection checks IPv4 and IPv6 and avoids reusing a port within the same plan. All servers bind `127.0.0.1`. The chosen ports are written to `.bridge-runtime.json`; `.bridge-proxy.json` forwards MCP, health, runtime and `/.well-known` OAuth discovery endpoints to the actual API. `BRIDGE_RUNTIME_MANIFEST`, `PORT`, `HOST` and `ALLOWED_ORIGINS` are passed to the API. The workbench reads `/__bridge/runtime` and chooses the corresponding view's dev URL for HMR.

Port probes cannot eliminate another process taking a port between planning and binding. A process failure stops the other children and reports an error; rerun the command to select another plan. SIGINT/SIGTERM stops children, with a bounded SIGKILL fallback. Child scripts receive the project's `node_modules/.bin` first on PATH so Angular runs with the installed supported Node version.

## Tunnels and deployment

No public tunnel or deployment runs as part of `build` or `dev`. The tunnel command does not install providers, fetch credentials or select a vendor account. It parses cloudflared HTTPS quick-tunnel logs and ngrok HTTPS logs, reports missing binaries/errors/timeouts, and shuts down its child on exit. Configure the server's public `ALLOWED_HOSTS` explicitly; the tunnel CLI prints the hostname to add. The command has unit tests with provider logs, but no external tunnel was opened during implementation.

The deployment command writes reviewable local files only. Build its Dockerfile from the workspace root and supply actual domain/OAuth settings. The container retains dependencies because its TypeScript server runs through `tsx`; it is portable rather than a size-optimized production image. The Dockerfile requires an existing `package-lock.json`; secrets, local caches and host `node_modules` are excluded from its build context by the generated Dockerfile-specific ignore file. The Docker image itself has not been built or published as part of this task.
