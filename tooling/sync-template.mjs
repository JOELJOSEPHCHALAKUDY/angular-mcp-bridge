import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const target = resolve('packages/cli/templates/angular');
await mkdir(target, { recursive: true });
for (const entry of ['apps', 'examples', 'views', '.agents', 'llms.txt', 'bridge.config.json', 'angular.json', 'proxy.conf.json', 'tsconfig.json', 'tsconfig.server.json']) {
  await mkdir(resolve(target, entry, '..'), { recursive: true });
  await cp(resolve(entry), resolve(target, entry), { recursive: true });
}
// Generated apps get self-contained user guides, not framework source-audit
// links to packages/tests that do not exist in a consumer's app.
await rm(resolve(target, 'docs'), { recursive: true, force: true });
await mkdir(resolve(target, 'docs'), { recursive: true });
for (const guide of ['index.md', 'GETTING-STARTED.md', 'FIRST-APP.md', 'RECIPES.md', 'ANGULAR-API.md', 'RUNTIME.md', 'SERVER.md', 'HOST-SETUP.md', 'TOOLING.md', 'TOOLING-NATIVE.md', 'FORMS-AND-WEBMCP.md', 'PERFORMANCE.md', 'EVALUATIONS.md', 'TROUBLESHOOTING.md', 'ARCHITECTURE.md', 'workbench-preview.png']) {
  await cp(resolve('docs', guide), resolve(target, 'docs', guide));
}
await rm(resolve(target, 'tooling/bridge'), { recursive: true, force: true });
for (const entry of ['bin', 'lib']) await cp(resolve('packages/cli', entry), resolve(target, 'tooling/bridge', entry), { recursive: true });
await writeFile(resolve(target, 'tooling/bundle-widget.mjs'), "// esbuild standalone Angular resource bundler\nimport { buildProject } from './bridge/lib/commands.mjs';\nawait buildProject(process.cwd(), { bundleOnly: true });\n");
await cp(resolve('tooling/check-docs.mjs'), resolve(target, 'tooling/check-docs.mjs'));
await cp(resolve('tooling/benchmark.mjs'), resolve(target, 'tooling/benchmark.mjs'));
await cp(resolve('tooling/preview.ts'), resolve(target, 'tooling/preview.ts'));
await cp(resolve('.gitignore'), resolve(target, '_gitignore'));
await writeFile(resolve(target, '_gitignore'), (await readFile(resolve(target, '_gitignore'), 'utf8')) + '\n.bridge-runtime.json\n.bridge-proxy.json\n');
const root = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = {
  name: 'angular-mcp-app', version: '0.1.0', private: true, type: 'module', engines: root.engines,
  scripts: {
    build: 'node tooling/bridge/bin/bridge.mjs build',
    dev: 'node tooling/bridge/bin/bridge.mjs dev',
    start: 'node tooling/bridge/bin/bridge.mjs start', check: 'tsc --noEmit -p tsconfig.server.json',
    'add-view': 'node tooling/bridge/bin/bridge.mjs add-view',
    tunnel: 'node tooling/bridge/bin/bridge.mjs tunnel',
    deploy: 'node tooling/bridge/bin/bridge.mjs deploy',
    doctor: 'node tooling/bridge/bin/bridge.mjs doctor',
    'docs:check': 'node tooling/check-docs.mjs',
    benchmark: 'node tooling/benchmark.mjs',
    preview: 'tsx tooling/preview.ts',
  }, dependencies: root.dependencies,
  devDependencies: Object.fromEntries(Object.entries(root.devDependencies).filter(([key]) => !['ng-packagr','vitest','@vitest/browser-playwright','@playwright/test'].includes(key))),
};
await writeFile(resolve(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
const angular = JSON.parse(await readFile('angular.json', 'utf8')); delete angular.projects.bridge;
await writeFile(resolve(target, 'angular.json'), JSON.stringify(angular, null, 2) + '\n');
const tsconfig = JSON.parse(await readFile('tsconfig.json', 'utf8')); delete tsconfig.compilerOptions.paths;
await writeFile(resolve(target, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');
const server = JSON.parse(await readFile('tsconfig.server.json', 'utf8')); server.include = ['examples/**/*.ts']; delete server.exclude;
await writeFile(resolve(target, 'tsconfig.server.json'), JSON.stringify(server, null, 2) + '\n');
await writeFile(resolve(target, 'README.md'), `# Your Angular MCP App

Run from this folder:

\`\`\`sh
npm install
npm run dev
\`\`\`

Skip installation if the creator already installed dependencies. Open the **Workbench** URL printed in your terminal. You should see **connected**, four tools and the project browser. Click **Run tool** to invoke the server and inspect its returned data. Local development needs no API key or host account. Ctrl+C stops all development servers.

Choose **Angular dev server · HMR** in Preview source, edit \`apps/demo/src/app.ts\` and save. Dev selects free ports; always use the printed URLs.

## Start building

- [Getting started](docs/GETTING-STARTED.md): setup, workbench and folder map.
- [Build your first tool and view](docs/FIRST-APP.md): complete typed greeting tutorial.
- [Angular recipes](docs/RECIPES.md): data, state, messages and UI tools.
- [Native generators](docs/TOOLING-NATIVE.md): create a typed tool, handler and view together.
- [Runtime patterns](docs/RUNTIME.md): compose reads, scope caching and preserve editing drafts.
- [Signal Forms and WebMCP](docs/FORMS-AND-WEBMCP.md): optional native form and browser-agent APIs.
- [All documentation](docs/index.md): Angular/server APIs, tooling, evaluations and real-host setup.
- [Troubleshooting](docs/TROUBLESHOOTING.md): run \`npm run doctor\` for local setup diagnostics.

Views are standalone Angular applications under \`apps/\`, discovered through \`views/*/view.json\`. Generate a complete typed feature with \`npx ng generate @angular-mcp-bridge/cli:view greeting --tool greet\`; customize its editable contract and handler in \`examples/generated/greet/\`. The generator updates registries and server registration automatically. \`npm run add-view -- reports\` uses the same native workflow with the tool name \`open_reports\`. Follow the first-app tutorial for complete file contents.

\`npm run build\` compiles all views and writes \`dist/bridge-manifest.json\` plus standalone HTML. \`npm run start\` serves that build's MCP endpoint. \`npm run preview\` serves the production workbench for local checks. \`npm run check\` checks server/contracts; build/dev also compile Angular templates. \`npm run docs:check\` verifies the bundled documentation links.

Framework packages are local unpublished tarballs under \`vendor/\`. Keep them with the app and use its lockfile for repeatable installs. They do not reference the source workspace. An [Angular MCP coding skill](.agents/skills/angular-mcp-app/SKILL.md) is included.

Host-shaped workbench profiles are simulations. Follow [Host setup](docs/HOST-SETUP.md) when connecting a real host or preparing public hosting. The [tooling guide](docs/TOOLING.md) explains optional tunnels and local container artifacts.
`);
console.log('Updated CLI template from verified framework example.');
