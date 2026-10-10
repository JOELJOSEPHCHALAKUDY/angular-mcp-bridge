# @angular-mcp-bridge/cli

Build Angular MCP Apps with standalone components, Angular CLI builders and a local workbench. This release is available from the local checkout; it has not been published to npm.

From the framework checkout, use supported Node 24.15+ and run:

```sh
npm install
npm run create -- ../my-angular-app --install
cd ../my-angular-app
npm run dev
```

`create` prepares and packs the local framework, creates the Angular app, and installs app dependencies when `--install` is supplied. Omit `--install` to run `npm install` yourself in the generated folder. `dev` builds the initial Angular resources, starts the MCP server and workbench, and prints the actual URLs. It selects free ports automatically.

Use `npm run doctor` if setup fails. Doctor checks the Node version, installed Angular/framework packages, view configuration, server entry and build prerequisites without network requests or reading credentials. Exit 0 means setup is ready, possibly with a build warning; exit 1 means a prerequisite needs attention. `npm run doctor -- --json` gives the same diagnostics as JSON.

Generated applications expose these commands:

```sh
npm run dev
npm run build
npm run start
npm run add-view -- reports
npm run doctor
npm run deploy
npm run tunnel -- --provider cloudflared --port 3001
```

Every CLI command has specific help, for example `npm run add-view -- --help` and `npm run tunnel -- --help`. `start` and `deploy` require an existing build. With a native registry, `add-view` generates a typed tool, handler and standalone Angular view and registers them automatically. Old workspaces keep the original view-only path. Tunnels require an already installed provider and open a public endpoint only when invoked. Deployment creates local Docker/Compose files for review.

The installed package also includes Angular schematics:

```sh
npx ng generate @angular-mcp-bridge/cli:view reports --dry-run
npx ng generate @angular-mcp-bridge/cli:view reports
npx ng generate @angular-mcp-bridge/cli:tool search
```

`ng add` integrates an existing Angular 22 standalone app with a server and workbench. Until publication, install the local CLI tarball and use `--local /absolute/path/angular-mcp-bridge` to copy prepared framework tarballs. The collection supports idempotent integration, collision checks, Angular dry runs and a configuration migration through `ng update`. Read `docs/TOOLING-NATIVE.md` in the checkout or generated app for complete commands.

The lower-level generator remains available for prepared packages:

```sh
node packages/cli/bin/bridge.mjs create ../my-app --local .
```

Both create paths protect nonempty folders and reject symbolic-link destinations. The generator stages files before placing the complete app, rechecks the target after preparation, and retains the scaffold if an optional dependency install fails.

`bridge.config.json` supplies the server entry, preferred ports, default view and views directory. Nested `view.json` files map views to Angular applications. Builds generate literal view types, self-contained HTML and a portable manifest. An optional `delivery.mode: "assets"` plus explicit HTTPS `assetOrigin` preserves separate Angular lazy chunks and writes hashed public assets with resource CSP metadata. Generated applications contain the local CLI, both example views, documentation and an Angular MCP agent skill; they have no source aliases back into the framework checkout.

Read the generated app's `docs/TOOLING.md` for configuration and artifact details.
