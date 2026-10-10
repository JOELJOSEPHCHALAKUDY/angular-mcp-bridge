# Native Angular integration and generators

The CLI package includes a genuine Angular schematic collection. Angular CLI runs it through its normal workspace tree, dry-run reporting and file commit process. The collection composes Angular's application schematic; it does not introduce another frontend build system.

## Add the bridge to an existing app

This local release is unpublished. First prepare the framework packages in the bridge checkout:

```sh
npm install
npm run build:packages
npm run pack:all
```

From an existing **Angular 22 standalone application**, install the prepared CLI tarball, then run `ng add`. Replace `/absolute/path/angular-mcp-bridge` and `my-app` with your paths and Angular project name:

```sh
npm install --save-dev /absolute/path/angular-mcp-bridge/dist/tarballs/angular-mcp-bridge-cli-0.1.0.tgz
npx ng add @angular-mcp-bridge/cli --project my-app --local /absolute/path/angular-mcp-bridge
npm run mcp:dev
```

`--project` is optional when the workspace contains one application. `--local` copies Angular, contracts, server and CLI tarballs into `vendor/` and writes portable `file:` dependencies. `--skip-install` updates the tree without scheduling `npm install`; install dependencies yourself before starting. Use `--dry-run` to inspect the integration first.

The integration preserves the selected application's UI and original npm scripts. It adds `provideMcpBridge()` to its standalone bootstrap, makes that application the default view, adds an MCP server under `mcp/`, and creates a separate `mcp-workbench` Angular application. A scoped `mcp/package.json` enables ESM for the server while preserving the application's existing module setting. New scripts are `mcp:dev`, `mcp:build`, `mcp:start` and `mcp:doctor`. Repeating the same integration preserves the files and does not duplicate the provider. A different existing bridge server or conflicting files/scripts produce an error rather than a replacement.

An existing application can require further host adaptation: relative routing, authentication, iframe sizing and tool-result rendering remain application decisions. `ng add` registers a greeting tool for the existing view; it preserves the existing UI, so that UI must read the result if it needs to show it. NgModule bootstrap integration is not supported by this collection; migrate to standalone first.

## Generate a typed feature

In a starter app, framework workspace or integrated application:

```sh
npx ng generate @angular-mcp-bridge/cli:view reports --dry-run
npx ng generate @angular-mcp-bridge/cli:view reports
npx ng generate @angular-mcp-bridge/cli:tool search
npx ng generate @angular-mcp-bridge/cli:tool refresh_reports --view reports
```

`view reports` generates an `open_reports` tool unless `--tool` names another one. `--port` sets its preferred development port; dev selects another available port when necessary. The `tool` schematic creates a data-only tool by default; `--view` binds it to an already discovered view.

| Generated file | Purpose |
| --- | --- |
| `<native.directory>/<tool>/contract.ts` | Shared Zod input/output schema and readable `<tool>Tool` export. |
| `<native.directory>/<tool>/handler.ts` | Typed `<tool>Handler` backend implementation. |
| `apps/<view>/src/app.ts` | Standalone Angular component using `createToolClient().info()` and `.inject()`, with typed success/error states. |
| `apps/<view>/src/main.ts` | Standalone bootstrap with `provideMcpBridge()`. |
| `views/<view>/view.json` | Automatic build and development discovery. |
| `generated/view-names.ts` | Literal view names and `ViewName` union. |

The generators register contracts and handlers automatically through `native.contracts` and `native.handlers`. Starter apps use `examples/shared/generated-tools.ts`, `examples/server/generated-handlers.ts` and `examples/generated/`; `ng add` uses `mcp/tools.ts`, `mcp/handlers.ts` and `mcp/features/`. Those registry files export literal `tools` and `handlers` objects. The generator inserts imports and entries using the TypeScript syntax tree, preserving existing properties and comments. Custom nonliteral registry expressions need manual integration.

Names, projects, files, tools and view bindings are checked before generation. Do not register the same generated tool again in the main server. Edit its contract and handler together, then run `npm run build` in a starter or `npm run mcp:build` after `ng add`; Angular compiles the result template and the server checks handler types. The component's shared import contains schemas, never backend implementation or credentials.

`npm run add-view -- reports` uses this native collection when `bridge.config.json` has a `native` registry. Old workspaces without that registry keep the original standalone-view generator and require manual server binding.

## Migrations

The installed CLI declares an Angular `ng-update` migration collection:

```sh
NG_DISABLE_VERSION_CHECK=true npx ng update @angular-mcp-bridge/cli --migrate-only --from 0.0.0 --to 0.1.0
```

The environment variable uses your installed Angular CLI without its automatic registry version check (POSIX shell syntax shown). Run migrations from a clean Git working tree, as Angular CLI requires. The current migration normalizes configuration version 1, fills a missing native feature directory and adds the diagnostic script. It is idempotent, preserves other configuration and rejects unknown future versions. It does not upgrade Angular or rewrite application behavior. This is local migration support; registry publication and future version migrations remain separate release work.

## Optional asset delivery

The default build produces self-contained HTML. To preserve Angular's separate lazy chunks, including `@defer` output, configure an explicit HTTPS asset origin:

```json
{
  "delivery": {
    "mode": "assets",
    "assetOrigin": "https://assets.example.com"
  }
}
```

Merge this field into your existing `bridge.config.json`, then run the normal build command. The origin must have no credentials, path, query or fragment. The build copies the Angular output into `dist/assets/<build-hash>/<view>/`, keeps JavaScript imports and CSS references intact, and uses an absolute resource base in the widget HTML. `dist/bridge-manifest.json` declares an allowlist of public asset keys with MIME type, byte count and SHA256. Each resource's CSP includes the origin in `resourceDomains` and `baseUriDomains`; runtime API permissions are still explicit.

Asset mode requires a host that honors standard MCP Apps `ui.csp.baseUriDomains` as well as the resource origin. The legacy `openai/widgetCSP` mapping does not declare that base permission, so legacy Apps SDK compatibility for this mode is not claimed. Self-contained HTML remains the default across transport adapters.

The included server reads this manifest and serves verified files at `/__bridge/assets/`. A custom server can pass `assets: { directory: resolve('dist/assets'), manifest: manifest.assets }` to `serveBridge`. The HTTPS origin must route this asset path to that server, or host the exact allowlisted files under that path. Configure the server's allowed hostname for that origin. Assets are public, immutable and use credential-free CORS so sandboxed iframe module requests work. HTML, source maps, license text and unknown file types are not public endpoints. Keep secrets out of frontend builds.

Subsequent builds retain verified prior asset keys for the same origin/output so an already-open widget can still fetch its older lazy chunks. Deploy the complete retained `dist/assets` directory and manifest together; a fresh checkout or clean container build must restore the previous snapshot first if open sessions need this continuity. Changed origins begin a separate history. Retention has no automatic expiry: when old sessions are intentionally retired, remove their keys from the manifest and their hash directories together before the next build. Removing a referenced snapshot or changing its bytes fails validation. Keep the current hash referenced by each widget resource, and coordinate cleanup with your session/cache policy.

Build references must resolve to local output files. External build dependencies, escaping paths, symbolic links, nonliteral dynamic imports and unsupported referenced file types fail the asset build. Supported public assets include JavaScript, CSS, JSON, common images/fonts and WebAssembly. Runtime relative images use the widget's absolute base; use routes and links appropriate to the host iframe. Angular HMR still comes from the local view dev servers.

Tests cover native integration, idempotence, collisions, typed registry insertion, migrations, lazy chunk/CSS references, hash reuse/tampering and opt-in build selection. A generated view and workbench have also been compiled with Angular CLI 22.2.2, and a real CLI dry run left no generated files. Local checks do not certify a third-party host or a deployed HTTPS asset origin.
