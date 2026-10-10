import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Direct ESM tooling is executable without a compilation step.
import { readConfiguration, discoverViews, generateViewTypes } from '../packages/cli/lib/config.mjs';
// @ts-expect-error Direct ESM tooling.
import { bundleViews, bundleHtml } from '../packages/cli/lib/bundle.mjs';
// @ts-expect-error Direct ESM tooling.
import { planDevelopment, addView, startProject } from '../packages/cli/lib/commands.mjs';
// @ts-expect-error Direct ESM tooling.
import { choosePort } from '../packages/cli/lib/process.mjs';
// @ts-expect-error Direct ESM tooling.
import { parseTunnelLine, tunnelArguments } from '../packages/cli/lib/tunnel.mjs';
// @ts-expect-error Direct ESM tooling.
import { createDeployment } from '../packages/cli/lib/deploy.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'angular-bridge-tooling-')); roots.push(root);
  await writeFile(join(root, 'bridge.config.json'), JSON.stringify({ version: 1, viewsDirectory: 'views', defaultView: 'projects', server: { entry: 'examples/server/main.ts', port: 3000 } }));
  await writeFile(join(root, 'angular.json'), JSON.stringify({ version: 1, projects: Object.fromEntries(['demo','detail','workbench'].map(name => [name, { projectType: 'application', architect: { build: { options: { outputPath: `dist/${name}` } } } }])) }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'angular-mcp-bridge build' } }));
  await writeFile(join(root, 'package-lock.json'), '{}');
  for (const [name, project] of [['projects','demo'], ['details','detail']]) {
    await mkdir(join(root, 'views', name), { recursive: true });
    await writeFile(join(root, 'views', name, 'view.json'), JSON.stringify({ name, project, devPort: 4201, description: name }));
    await mkdir(join(root, 'dist', project, 'browser'), { recursive: true });
    await writeFile(join(root, 'dist', project, 'browser', 'index.html'), '<html><head><link rel="stylesheet" href="styles.css"><link rel="modulepreload" href="lazy.js"></head><body><img src="icon.svg"><script type="module" src="main.js"></script></body></html>');
    await writeFile(join(root, 'dist', project, 'browser', 'main.js'), 'import("./lazy.js").then(x => globalThis.answer = x.answer); console.log("$&");');
    await writeFile(join(root, 'dist', project, 'browser', 'lazy.js'), 'export const answer = 42;');
    await writeFile(join(root, 'dist', project, 'browser', 'styles.css'), 'body { background-image: url("icon.svg"); }');
    await writeFile(join(root, 'dist', project, 'browser', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  }
  return root;
}
describe('Angular CLI view pipeline', () => {
  it('discovers Angular view markers and generates literal view types', async () => {
    const root = await fixture(); const config = await readConfiguration(root); const views = await discoverViews(config);
    expect(views.map((view: { name: string }) => view.name)).toEqual(['details','projects']);
    const file = await generateViewTypes(config, views); expect(await readFile(file, 'utf8')).toContain('"details", "projects"');
  });
  it('reads Angular JSON comments and trailing commas without changing URL strings', async () => {
    const root = await fixture(); const workspace = JSON.parse(await readFile(join(root, 'angular.json'), 'utf8'));
    await writeFile(join(root, 'angular.json'), '// Angular workspace\n{\n/* keep comments */\n"$schema": "https://example.test/schema?literal=/*text*/",\n"version":1,\n"projects":' + JSON.stringify(workspace.projects) + ',\n}');
    const config = await readConfiguration(root); expect(config.angular.$schema).toBe('https://example.test/schema?literal=/*text*/');
    expect((await discoverViews(config)).map((view: { name: string }) => view.name)).toEqual(['details', 'projects']);
  });
  it('rejects duplicate names, unknown projects and path traversal', async () => {
    const root = await fixture(); const marker = join(root, 'views/details/view.json');
    await writeFile(marker, JSON.stringify({ name: 'projects', project: 'detail' }));
    await expect(discoverViews(await readConfiguration(root))).rejects.toThrow('Duplicate view name');
    await writeFile(marker, JSON.stringify({ name: 'details', project: 'missing' }));
    await expect(discoverViews(await readConfiguration(root))).rejects.toThrow('unknown Angular application');
    await writeFile(marker, JSON.stringify({ name: 'details', project: 'detail', htmlPath: '../../outside.html' }));
    await expect(discoverViews(await readConfiguration(root))).rejects.toThrow('escapes the workspace');
  });
  it('refuses symbolic links in the discovery tree', async () => {
    const root = await fixture(); await symlink(tmpdir(), join(root, 'views/external'));
    await expect(discoverViews(await readConfiguration(root))).rejects.toThrow('symbolic links');
  });
  it('bundles multiple views, dynamic chunks, styles and assets into portable HTML', async () => {
    const root = await fixture(); const config = await readConfiguration(root); const views = await discoverViews(config);
    const manifest = await bundleViews(config, views);
    expect(Object.keys(manifest.views)).toEqual(['details','projects']);
    expect(manifest.views.projects.htmlPath).toBe('dist/views/projects.html');
    const html = await readFile(join(root, manifest.views.projects.htmlPath), 'utf8');
    expect(html).not.toMatch(/<script[^>]+src=/); expect(html).not.toContain('modulepreload'); expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('$&'); expect(html).not.toContain('import("./lazy.js")');
    expect(await readFile(join(root, 'dist/widget.html'), 'utf8')).toBe(html);
  });
  it('rejects external or escaping widget dependencies', async () => {
    const root = await fixture(); const html = join(root, 'dist/demo/browser/index.html');
    await writeFile(html, '<script src="https://cdn.example/main.js"></script>');
    await expect(bundleHtml(html, join(root, 'dist/out.html'))).rejects.toThrow('External widget asset');
    await writeFile(html, '<script src="../../../package.json"></script>');
    await expect(bundleHtml(html, join(root, 'dist/out.html'))).rejects.toThrow('escapes its output directory');
  });
  it('inlines critical CSS assets and refuses srcset and output symlink escapes', async () => {
    const root = await fixture(); const config = await readConfiguration(root); const html = join(root, 'dist/demo/browser/index.html');
    await writeFile(html, '<style>body{background:url(icon.svg?v=1#x)}</style>');
    await bundleHtml(html, join(root, 'dist/critical.html'));
    expect(await readFile(join(root, 'dist/critical.html'), 'utf8')).toContain('data:image/svg+xml;base64,');
    await writeFile(html, '<img srcset="icon.svg 1x, icon.svg 2x">');
    await expect(bundleHtml(html, join(root, 'dist/critical.html'))).rejects.toThrow('srcset');
    await writeFile(html, '<p>safe</p>'); await symlink(tmpdir(), join(root, 'dist/views'));
    await expect(bundleViews(config, await discoverViews(config))).rejects.toThrow('symbolic link');
  });
  it('remaps API, workbench and colliding view ports together', async () => {
    const root = await fixture(); const plan = await planDevelopment(root, async (port: number) => ![3000,4200,4201].includes(port));
    expect(plan.port).toBe(3001); expect(plan.workbenchPort).toBe(4202);
    expect(plan.runtime.views.details.devUrl).toBe('http://127.0.0.1:4203');
    expect(plan.runtime.views.projects.devUrl).toBe('http://127.0.0.1:4204');
    await expect(choosePort(0)).rejects.toThrow('Invalid port');
  });
  it('generates a standalone Angular view and refuses overwrite', async () => {
    const root = await fixture(); await addView('reports', root);
    const app = await readFile(join(root, 'apps/reports/src/app.ts'), 'utf8');
    expect(app).toContain('standalone: true'); expect(app).toContain('inject(McpBridge)');
    expect(await readFile(join(root, 'angular.json'), 'utf8')).toContain('@angular/build:application');
    await expect(addView('reports', root)).rejects.toThrow('already exists');
    await expect(addView('../bad', root)).rejects.toThrow('lowercase letter');
  });
  it('delegates native add-view to the Angular schematic workflow', async () => {
    const root = await fixture(); const config = JSON.parse(await readFile(join(root, 'bridge.config.json'), 'utf8'));
    config.native = { contracts: 'mcp/tools.ts', handlers: 'mcp/handlers.ts', directory: 'mcp/features' }; await writeFile(join(root, 'bridge.config.json'), JSON.stringify(config));
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
    await symlink(process.execPath, join(root, 'node_modules/.bin/node'));
    const executable = join(root, 'node_modules/.bin/ng'); await writeFile(executable, `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.writeFileSync('generator-args.json', JSON.stringify(process.argv.slice(2)));\n`); await chmod(executable, 0o755);
    await addView('reports', root);
    expect(JSON.parse(await readFile(join(root, 'generator-args.json'), 'utf8'))).toEqual(['generate', '@angular-mcp-bridge/cli:view', 'reports']);
    await expect(readFile(join(root, 'apps/reports/src/app.ts'))).rejects.toThrow();
  });
  it('preserves the original v0.1 demo fallback when adding the first discovered view', async () => {
    const root = await fixture(); await rm(join(root, 'views'), { recursive: true }); await rm(join(root, 'bridge.config.json'));
    await addView('reports', root);
    const views = await discoverViews(await readConfiguration(root));
    expect(views.map((view: {name: string}) => view.name)).toEqual(['projects', 'reports']);
    expect(JSON.parse(await readFile(join(root, 'views/projects/view.json'), 'utf8'))).toMatchObject({name: 'projects', project: 'demo'});
    expect((await readConfiguration(root)).defaultView).toBe('projects');
  });
  it('refuses to overwrite an existing view marker whose directory differs from its name', async () => {
    const root = await fixture(); const marker = join(root, 'views/reports/view.json');
    await mkdir(join(root, 'views/reports')); const original = JSON.stringify({name: 'overview', project: 'workbench'}); await writeFile(marker, original);
    await expect(addView('reports', root)).rejects.toThrow('marker already exists');
    expect(await readFile(marker, 'utf8')).toBe(original);
    await expect(readFile(join(root, 'apps/reports/src/main.ts'))).rejects.toThrow();
  });
  it('writes container configuration only after concrete assets exist', async () => {
    const root = await fixture(); await expect(createDeployment(root)).rejects.toThrow();
    const config = await readConfiguration(root); await bundleViews(config, await discoverViews(config));
    const folder = await createDeployment(root); expect(await readFile(join(folder, 'Dockerfile'), 'utf8')).toContain('node:24.15.0');
    expect(await readFile(join(folder, 'compose.yaml'), 'utf8')).toContain('ALLOWED_HOSTS');
    await expect(createDeployment(root)).rejects.toThrow('not empty');
  });
  it('uses the bridge build script for native setup recovery and container builds', async () => {
    const root = await fixture();
    const manifest = { scripts: { start: 'ng serve', build: 'ng build', 'mcp:dev': 'angular-mcp-bridge dev', 'mcp:build': 'angular-mcp-bridge build', 'mcp:start': 'angular-mcp-bridge start' } };
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    await expect(startProject(root)).rejects.toThrow('Run npm run mcp:build, then npm run mcp:start. For local development, use npm run mcp:dev.');
    const config = await readConfiguration(root); await bundleViews(config, await discoverViews(config));
    const folder = await createDeployment(root); const dockerfile = await readFile(join(folder, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('RUN npm run mcp:build\n'); expect(dockerfile).not.toContain('RUN npm run build\n');
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toEqual(manifest);
  });
});
describe('provider-neutral tunnels', () => {
  it('parses installed provider HTTPS endpoint logs and ignores unrelated URLs', () => {
    expect(parseTunnelLine('cloudflared', 'INF Visit https://small-angular-app.trycloudflare.com')).toBe('https://small-angular-app.trycloudflare.com');
    expect(parseTunnelLine('ngrok', '{"msg":"started tunnel","url":"https://my-app.ngrok-free.app","name":"command_line"}')).toBe('https://my-app.ngrok-free.app');
    expect(parseTunnelLine('ngrok', 'msg="started tunnel" url=https://my-app.ngrok.app')).toBe('https://my-app.ngrok.app');
    expect(parseTunnelLine('cloudflared', 'https://developers.cloudflare.com')).toBeNull();
    expect(parseTunnelLine('ngrok', '{"msg":"started tunnel","url":"http://insecure.example"}')).toBeNull();
    expect(tunnelArguments('cloudflared', 3001)).toContain('http://127.0.0.1:3001');
    expect(() => tunnelArguments('unknown', 3000)).toThrow('provider');
  });
});
