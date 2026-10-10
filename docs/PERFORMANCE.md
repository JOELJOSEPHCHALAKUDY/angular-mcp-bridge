# Measure your Angular MCP App

Angular signals and OnPush are the default foundation. Performance still depends on your components, tool payloads, server latency and the host. Measure the same interaction before and after a change; this project does not claim an Angular-versus-React speed advantage.

## Resource sizes

From your project folder, build and measure:

```sh
npm run build
npm run benchmark
```

The report at `dist/benchmark.json` records each view's HTML, initial download bytes, estimated gzip bytes and complete asset graph bytes. In standalone delivery, the complete JavaScript graph is inlined, so `@defer` delays component creation but does not reduce transferred bytes. In asset delivery, the initial resources and lazy graph are measured separately.

Gzip figures assume your server/CDN uses gzip. They are estimates, not a recording of a real host's network transfer. Use your browser's Network panel to verify deployed compression and caching.

For asset delivery, initial bytes include HTML script entries, stylesheet links, explicit preloads and declared media sources/posters, plus their transitive static JavaScript imports/reexports and CSS imports/URLs. References are counted once, including cycles. Dynamic `import()` and `prefetch` links stay outside the initial estimate; an explicit `modulepreload` still counts because the browser requests it initially. The complete graph includes the current build's files, including deferred chunks, plus any static dependencies actually referenced across build directories. Retained older releases are excluded. The current build is identified by the HTML's asset base URL.

This is static accounting of declared build assets. CSS URLs and HTML media URLs are counted conservatively even when a selector, lazy-loading policy or media preload setting might not use them. All `srcset` candidates are counted rather than predicting which image the browser selects. Import maps, runtime-created media, requests started by JavaScript, external resources and browser cache/compression decisions are outside this estimate. Use network recordings for actual transferred bytes. The report also records the CPU/platform and, when measuring browser interactions, the browser version.

## Local startup and tool reads

Keep `npm run dev` running and use the **Workbench** URL printed in its terminal:

```sh
npm run benchmark -- --url http://127.0.0.1:4200 --iterations 5
```

Replace the URL with the printed value. The framework checkout includes Playwright. For browser measurements in a generated app, first run `npm install --save-dev @playwright/test`. If its browser is missing, run `npx playwright install chromium`. Size measurements need neither Playwright nor a browser. The benchmark creates fresh browser contexts, measures navigation through the actual MCP handshake until the view is ready, and measures the project demo's read through the host. It records samples, median and p95. The project-read metric is omitted for apps without that demo.

Use the production preview when measuring a production build: run `npm run build`, then `npm run preview`, and pass the preview URL. Development timings include Angular's dev-server costs and should not be compared directly with production timings.

Small samples describe this machine and run; they do not establish a general performance claim. Record the build digest, delivery mode, browser, hardware, server/cache state and payload size when comparing runs. Real ChatGPT/Claude/VS Code hosts require their own measurements.

## Keep optional features out of the base bundle

Import typed forms from `@angular-mcp-bridge/angular/forms` and experimental browser-agent features from `@angular-mcp-bridge/angular/webmcp` only where needed. The base bridge does not import Angular Forms, Aria or CDK.

Read caching is opt-in and belongs to a specific bridge/connection/account scope. Start with in-flight sharing and a zero TTL. Enable longer caching only for reads whose invalidation rules your app owns. Never cache commands to make a benchmark look faster.

See [Angular API](ANGULAR-API.md), [tooling](TOOLING.md) and [the native tooling guide](TOOLING-NATIVE.md) for resource composition, optional asset delivery and build configuration.
