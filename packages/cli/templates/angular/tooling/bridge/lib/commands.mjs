import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { readConfiguration, discoverViews, generateViewTypes, validateIdentifier, containedPath, assertSafeDestination } from './config.mjs';
import { bundleViews } from './bundle.mjs';
import { buildAssetViews } from './assets.mjs';
import { runLocal, spawnLocal, choosePort, waitForUrl, manageChildren } from './process.mjs';
import { workflowCommands } from './workflow.mjs';

export async function buildProject(root = process.cwd(), options = {}) {
  const config = await readConfiguration(root); const views = await discoverViews(config);
  console.log(`Building ${views.length} Angular view${views.length === 1 ? '' : 's'}: ${views.map(view => view.name).join(', ')}.`);
  await generateViewTypes(config, views);
  if (!options.bundleOnly) {
    for (const project of new Set(views.map(view => view.project))) await runLocal(config.root, 'ng', ['build', project]);
    if (config.workbench.project && config.angular.projects[config.workbench.project]) await runLocal(config.root, 'ng', ['build', config.workbench.project]);
    await runLocal(config.root, 'tsc', ['--noEmit', '-p', config.server.tsConfig ?? 'tsconfig.server.json']);
  }
  return config.delivery?.mode === 'assets' ? buildAssetViews(config, views) : bundleViews(config, views);
}
export async function planDevelopment(root = process.cwd(), probe) {
  const config = await readConfiguration(root); const views = await discoverViews(config); const reserved = new Set();
  const port = await choosePort(config.server.port, reserved, probe);
  const workbenchPort = await choosePort(config.workbench.port, reserved, probe);
  const runtime = { version: 1, mcpUrl: `http://127.0.0.1:${port}/mcp`, workbenchUrl: `http://127.0.0.1:${workbenchPort}`, manifestPath: resolve(config.root, config.outputDirectory, 'bridge-manifest.json'), views: {} };
  for (const view of views) {
    const viewPort = await choosePort(view.devPort, reserved, probe);
    runtime.views[view.name] = { project: view.project, htmlPath: view.htmlPath, description: view.description, devUrl: `http://127.0.0.1:${viewPort}` };
  }
  return { config, views, port, workbenchPort, runtime };
}
export async function developProject(root = process.cwd(), options = {}) {
  const plan = await planDevelopment(root); const { config, views, runtime, port, workbenchPort } = plan;
  console.log('Preparing the initial Angular resources. The first start compiles all views and the workbench.');
  // Server views must exist before either HTTP process starts. Angular dev servers then provide HMR.
  await buildProject(config.root);
  await generateViewTypes(config, views);
  const runtimePath = resolve(config.root, '.bridge-runtime.json');
  await assertSafeDestination(config.root, runtimePath);
  await writeFile(runtimePath, JSON.stringify(runtime, null, 2) + '\n');
  const proxyPath = resolve(config.root, '.bridge-proxy.json');
  await assertSafeDestination(config.root, proxyPath);
  await writeFile(proxyPath, JSON.stringify({ '/mcp': { target: `http://127.0.0.1:${port}`, secure: false }, '/health': { target: `http://127.0.0.1:${port}`, secure: false }, '/__bridge': { target: `http://127.0.0.1:${port}`, secure: false }, '/.well-known': { target: `http://127.0.0.1:${port}`, secure: false } }, null, 2) + '\n');
  const origins = [runtime.workbenchUrl, ...Object.values(runtime.views).map(view => view.devUrl)];
  const children = []; const completions = []; const stop = manageChildren(children);
  const track = child => {
    children.push(child);
    const completion = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { if (code !== 0 && !signal) reject(new Error(`Development process exited with ${code}.`)); else resolveExit(); }); });
    // An early build/process failure must be handled even while another endpoint is starting.
    completion.catch(() => {}); completions.push(completion); return child;
  };
  try {
    const api = track(spawnLocal(config.root, 'tsx', ['watch', config.server.entry], { env: { PORT: String(port), HOST: '127.0.0.1', ALLOWED_ORIGINS: origins.join(','), BRIDGE_RUNTIME_MANIFEST: runtimePath } }));
    for (const view of views) track(spawnLocal(config.root, 'ng', ['serve', view.project, '--host', '127.0.0.1', '--port', String(new URL(runtime.views[view.name].devUrl).port), '--proxy-config', proxyPath]));
    track(spawnLocal(config.root, 'ng', ['serve', config.workbench.project, '--host', '127.0.0.1', '--port', String(workbenchPort), '--proxy-config', proxyPath]));
    await Promise.race([Promise.all([waitForUrl(`http://127.0.0.1:${port}/health`, api), waitForUrl(runtime.workbenchUrl, children.at(-1)), ...views.map((view, index) => waitForUrl(runtime.views[view.name].devUrl, children[index + 1]))]), ...completions.map(completion => completion.then(() => { throw new Error('Development process stopped before all endpoints became ready.'); }))]);
    console.log(`\nReady. Open the workbench to test your tools:\nWorkbench: ${runtime.workbenchUrl}\nMCP: ${runtime.mcpUrl}\n${views.map(view => `${view.name}: ${runtime.views[view.name].devUrl}`).join('\n')}\n\nAngular changes use HMR. Stop all local servers with Ctrl+C.`);
    if (options.onReady) await options.onReady(runtime);
    await Promise.race(completions);
  } finally { await stop(); }
  return runtime;
}
export async function startProject(root = process.cwd()) {
  const config = await readConfiguration(root);
  try { await access(resolve(config.root, config.outputDirectory, 'bridge-manifest.json')); }
  catch (error) { if (error.code === 'ENOENT') { const commands = workflowCommands(JSON.parse(await readFile(resolve(config.root, 'package.json'), 'utf8'))); throw new Error(`Built resources are missing. Run ${commands.build}, then ${commands.start}. For local development, use ${commands.dev}.`); } throw error; }
  const child = spawnLocal(config.root, 'tsx', [config.server.entry], { env: { PORT: process.env.PORT ?? String(config.server.port) } });
  const stop = manageChildren([child]);
  try { await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => code === 0 || child.signalCode ? resolveExit() : reject(new Error(`Server exited with ${code}.`))); }); }
  finally { await stop(); }
}
export async function addView(name, root = process.cwd()) {
  validateIdentifier(name); const config = await readConfiguration(root); const views = await discoverViews(config);
  if (views.some(view => view.name === name) || config.angular.projects[name]) throw new Error(`View or Angular project already exists: ${name}`);
  if (config.native) {
    // Angular's workflow provides dry-run/transactional writes and composes its
    // own application generator with the typed bridge feature generator.
    await runLocal(config.root, 'ng', ['generate', '@angular-mcp-bridge/cli:view', name]);
    return { name, project: name, tool: `open_${name.replaceAll('-', '_')}`, directory: `apps/${name}`, marker: `${config.viewsDirectory}/${name}/view.json` };
  }
  const applicationRoot = `apps/${name}`; const directory = containedPath(config.root, applicationRoot);
  const marker = resolve(config.root, config.viewsDirectory, name, 'view.json');
  await assertSafeDestination(config.root, directory);
  await assertSafeDestination(config.root, resolve(config.root, 'angular.json'));
  await assertSafeDestination(config.root, marker);
  try { await access(directory); throw new Error(`Application folder already exists: ${applicationRoot}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await access(marker); throw new Error(`View marker already exists: ${relative(config.root, marker)}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Discovery's original v0.1 demo fallback must become explicit before the first
  // new marker appears; otherwise marker discovery would lose the default view.
  for (const view of views.filter(view => !view.marker)) {
    const originalMarker = resolve(config.root, config.viewsDirectory, view.name, 'view.json');
    await assertSafeDestination(config.root, originalMarker);
    await mkdir(dirname(originalMarker), { recursive: true });
    await writeFile(originalMarker, JSON.stringify({ name: view.name, project: view.project, description: view.description, htmlPath: relative(config.root, view.sourceHtmlPath), devPort: view.devPort }, null, 2) + '\n', { flag: 'wx' });
  }
  await mkdir(resolve(directory, 'src'), { recursive: true });
  await writeFile(resolve(directory, 'src/app.ts'), `import { Component, inject } from '@angular/core';\nimport { McpBridge } from '@angular-mcp-bridge/angular';\n@Component({ selector: 'bridge-root', standalone: true, template: \`<main><h1>${name}</h1><p>Bridge: {{ bridge.status() }}</p><pre>{{ bridge.toolOutput() | json }}</pre></main>\`, imports: [JsonPipe] })\nexport class AppComponent { readonly bridge = inject(McpBridge); }\nimport { JsonPipe } from '@angular/common';\n`);
  await writeFile(resolve(directory, 'src/main.ts'), `import { bootstrapApplication } from '@angular/platform-browser';\nimport { provideMcpBridge } from '@angular-mcp-bridge/angular';\nimport { AppComponent } from './app';\nvoid bootstrapApplication(AppComponent, { providers: [provideMcpBridge({ name: '${name}', version: '0.1.0' })] });\n`);
  await writeFile(resolve(directory, 'src/index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><bridge-root></bridge-root></body></html>\n`);
  await writeFile(resolve(directory, 'src/styles.css'), ':root { font-family: system-ui, sans-serif; color-scheme: light dark; } body { margin: 0; } main { padding: 24px; }\n');
  await writeFile(resolve(directory, 'tsconfig.app.json'), JSON.stringify({ extends: '../../tsconfig.json', compilerOptions: { outDir: `../../.angular/out-tsc/${name}`, types: [] }, files: ['src/main.ts'], include: ['src/**/*.d.ts'] }, null, 2) + '\n');
  config.angular.projects[name] = { projectType: 'application', root: applicationRoot, sourceRoot: `${applicationRoot}/src`, architect: { build: { builder: '@angular/build:application', options: { browser: `${applicationRoot}/src/main.ts`, index: `${applicationRoot}/src/index.html`, tsConfig: `${applicationRoot}/tsconfig.app.json`, outputPath: `dist/${name}`, styles: [`${applicationRoot}/src/styles.css`], outputHashing: 'all' }, configurations: { development: { optimization: false, sourceMap: true, outputHashing: 'none' } } }, serve: { builder: '@angular/build:dev-server', options: { buildTarget: `${name}:build:development`, proxyConfig: 'proxy.conf.json' } } } };
  await writeFile(resolve(config.root, 'angular.json'), JSON.stringify(config.angular, null, 2) + '\n');
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ name, project: name, description: `Angular view ${name}`, devPort: 4201 + views.length }, null, 2) + '\n', { flag: 'wx' });
  await generateViewTypes(config, await discoverViews(config));
  return { name, project: name, directory: relative(config.root, directory), marker: relative(config.root, marker) };
}
