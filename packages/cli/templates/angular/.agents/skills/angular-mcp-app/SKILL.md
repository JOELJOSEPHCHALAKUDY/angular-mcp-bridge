---
name: angular-mcp-app
description: Build Angular MCP Apps using the local typed bridge, server and Angular CLI view pipeline.
---

Read docs/index.md and docs/FIRST-APP.md before adding a tool/view; use docs/ANGULAR-API.md for reference. Inspect bridge.config.json and views/*/view.json. Use standalone Angular components, signals, dependency injection, DestroyRef and resource() for read-only requests. Do not introduce React hooks, JSX or React runtime packages.

Define safe shared contracts in examples/shared. The active registry and combined handlers are in examples/server/framework-app.ts; examples/server/app.ts owns the existing project demo handlers. Each Angular CLI application has a named view marker. Use npm run add-view -- <name> or ng generate @angular-mcp-bridge/cli:view; native generators register the contract and handler in bridge.config.json.native's registries. See docs/TOOLING-NATIVE.md before editing a generated feature. Keep generated view names typed; do not hand-edit generated/ or dist/.

Use docs/RUNTIME.md for resource chain(), retained results, account-scoped read caching/invalidation and injectResourceDraft. A dirty draft keeps the original ETag; never silently replace it on subscription updates. Import optional Signal Forms and experimental WebMCP from their secondary entry points and follow docs/FORMS-AND-WEBMCP.md. Standalone HTML remains the default; asset delivery requires an explicit HTTPS origin and matching host CSP, as documented in docs/TOOLING-NATIVE.md.

Start with npm install and npm run dev. Use the printed Workbench URL and Angular dev server HMR preview. Run npm run doctor for local setup diagnostics and npm run check/npm run build to validate changes. Use capability checks for host actions. Never expose secrets in shared schemas, structuredContent, exported fixtures or HTML. Private state stays local until explicitly shared. Host-shaped workbench profiles are simulations. Use docs/HOST-SETUP.md for real-host configuration. Open public tunnels, publish packages or deploy only when the user requests those actions.
