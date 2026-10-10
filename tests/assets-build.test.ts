import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Native ESM tooling has no compilation step.
import { assetOrigin, buildAssetViews } from '../packages/cli/lib/assets.mjs';
// @ts-expect-error Native ESM tooling.
import { readConfiguration, discoverViews } from '../packages/cli/lib/config.mjs';
// @ts-expect-error Native ESM tooling.
import { buildProject } from '../packages/cli/lib/commands.mjs';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-assets-')); roots.push(root);
  await writeFile(join(root, 'bridge.config.json'), JSON.stringify({ version: 1, defaultView: 'greeting', delivery: { mode: 'assets', assetOrigin: 'https://assets.example.test' } }));
  await writeFile(join(root, 'angular.json'), JSON.stringify({ version: 1, projects: { greeting: { projectType: 'application', architect: { build: { options: { outputPath: 'dist/greeting' } } } } } }));
  await mkdir(join(root, 'views/greeting'), { recursive: true }); await writeFile(join(root, 'views/greeting/view.json'), JSON.stringify({ name: 'greeting', project: 'greeting', csp: { connectDomains: ['https://api.example.test'] } }));
  const browser = join(root, 'dist/greeting/browser'); await mkdir(join(browser, 'media'), { recursive: true });
  const files = { 'index.html': '<html><head><base href="/"><link rel="stylesheet" href="styles.css"><link rel="modulepreload" href="lazy.js"></head><body><img src="media/icon.svg?v=2#image" srcset="media/icon.svg 1x, media/icon.svg 2x"><script type="module" crossorigin="anonymous" src="main.js"></script></body></html>', 'main.js': 'import { answer } from "./chunk.js"; export function load() { return import("./lazy.js"); } const image = new URL("./media/icon.svg", import.meta.url); console.log(answer, image); const docs = "import(\"not-a-build-asset\")"; /* import("comment-example") */', 'chunk.js': 'export const answer = 42;', 'lazy.js': 'import { answer } from "./chunk.js"; export const deferred = answer;', 'styles.css': '@import "./more.css"; @font-face { font-family: Example; src: url("./media/font.woff2"); } body { background: url("./media/icon.svg?v=2#background"); }', 'more.css': 'body { color: red; }', 'media/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'media/font.woff2': 'font-fixture', 'main.js.map': '{"version":3}', 'license.txt': 'license fixture' };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(browser, name), bytes);
  const config = await readConfiguration(root); return { root, browser, files, config, views: await discoverViews(config) };
}
describe('optional Angular asset delivery', () => {
  it('preserves lazy chunks, CSS assets and module URLs in a hashed public snapshot', async () => {
    const { root, files, config, views } = await fixture(); const manifest = await buildAssetViews(config, views);
    const keys = Object.keys(manifest.assets.files); expect(keys).toHaveLength(7);
    expect(keys.some(key => key.endsWith('/index.html') || key.endsWith('.map') || key.endsWith('.txt'))).toBe(false);
    const mainKey = keys.find(key => key.endsWith('/main.js'))!; expect(mainKey).toMatch(/^[a-f0-9]{24}\/greeting\/main\.js$/);
    expect(await readFile(join(root, manifest.assets.files[mainKey].path), 'utf8')).toBe(files['main.js']);
    const lazyKey = keys.find(key => key.endsWith('/lazy.js'))!; expect(await readFile(join(root, manifest.assets.files[lazyKey].path), 'utf8')).toBe(files['lazy.js']);
    const html = await readFile(join(root, manifest.views.greeting.htmlPath), 'utf8');
    expect(html).toContain(`src="https://assets.example.test/__bridge/assets/${mainKey}"`);
    expect(html).toContain('crossorigin="anonymous"'); expect(html).toContain('srcset="media/icon.svg 1x, media/icon.svg 2x"');
    expect(html).not.toContain('<base href="/">'); expect(html).toContain('<base href="https://assets.example.test/__bridge/assets/');
    expect(manifest.views.greeting.csp).toEqual({ connectDomains: ['https://api.example.test'], resourceDomains: ['https://assets.example.test'], baseUriDomains: ['https://assets.example.test'] });
    expect(await readFile(join(root, 'dist/widget.html'), 'utf8')).toBe(html);
  });
  it('uses the opt-in pipeline through buildProject and leaves standalone as the default', async () => {
    const { root } = await fixture(); const assets = await buildProject(root, { bundleOnly: true }); expect(assets.delivery.mode).toBe('assets');
    await writeFile(join(root, 'bridge.config.json'), '{"version":1,"defaultView":"greeting"}');
    // Standalone intentionally rejects srcset; use a supported standalone entry.
    await writeFile(join(root, 'dist/greeting/browser/index.html'), '<html><script type="module" src="chunk.js"></script></html>');
    const standalone = await buildProject(root, { bundleOnly: true }); expect(standalone.assets).toBeUndefined();
    expect(await readFile(join(root, 'dist/widget.html'), 'utf8')).not.toContain('https://assets.example.test');
  });
  it('reuses identical snapshots, makes changed chunks a new namespace and detects tampered immutable files', async () => {
    const { root, browser, config, views } = await fixture(); const first = await buildAssetViews(config, views); const second = await buildAssetViews(config, views);
    expect(second).toEqual(first); const key = Object.keys(first.assets.files).find(key => key.endsWith('/lazy.js'))!;
    await writeFile(join(browser, 'lazy.js'), 'export const deferred = 99;'); const changed = await buildAssetViews(config, views);
    expect(changed.assets.files[key]).toEqual(first.assets.files[key]);
    expect(Object.keys(changed.assets.files).some(value => value.split('/')[0] !== key.split('/')[0])).toBe(true);
    await writeFile(join(root, changed.assets.files[Object.keys(changed.assets.files)[0]].path), 'tampered');
    await expect(buildAssetViews(config, views)).rejects.toThrow('Immutable asset differs');
  });
  it('retains verified chunks from previous builds for open widgets and starts new history after an origin change', async () => {
    const { root, browser, config, views } = await fixture(); const first = await buildAssetViews(config, views);
    const previousKey = Object.keys(first.assets.files).find(key => key.endsWith('/lazy.js'))!;
    await writeFile(join(browser, 'lazy.js'), 'export const deferred = 100;'); const second = await buildAssetViews(config, views);
    expect(Object.keys(second.assets.files)).toHaveLength(14); expect(second.assets.files[previousKey]).toEqual(first.assets.files[previousKey]);
    expect(await readFile(join(root, second.assets.files[previousKey].path), 'utf8')).toContain('import { answer }');
    config.delivery.assetOrigin = 'https://new-assets.example.test'; const anotherOrigin = await buildAssetViews(config, views); expect(Object.keys(anotherOrigin.assets.files)).toHaveLength(7);
    expect(anotherOrigin.assets.files[previousKey]).toBeUndefined();
  });
  it('refuses forged prior asset paths, MIME metadata and symlink history', async () => {
    const { root, config, views } = await fixture(); const first = await buildAssetViews(config, views); const key = Object.keys(first.assets.files)[0];
    for (const change of [{ path: '../outside.js' }, { mimeType: 'image/svg+xml' }]) {
      const invalid = structuredClone(first); Object.assign(invalid.assets.files[key], change); await writeFile(join(root, 'dist/bridge-manifest.json'), JSON.stringify(invalid));
      await expect(buildAssetViews(config, views)).rejects.toThrow('Invalid previous asset metadata');
    }
    await writeFile(join(root, 'dist/bridge-manifest.json'), JSON.stringify(first)); const target = join(root, first.assets.files[key].path); const copied = join(root, 'same-content.js'); await writeFile(copied, await readFile(target)); await rm(target); await symlink(copied, target);
    await expect(buildAssetViews(config, views)).rejects.toThrow('symbolic link');
  });
  it('requires an explicit HTTPS origin before building', async () => {
    for (const value of [undefined, 'http://localhost:3000', 'https://user:secret@assets.example.test', 'https://assets.example.test/path', 'https://assets.example.test/?query=yes']) expect(() => assetOrigin(value)).toThrow();
    const { root } = await fixture(); await writeFile(join(root, 'bridge.config.json'), '{"version":1,"delivery":{"mode":"assets"}}');
    await expect(readConfiguration(root)).rejects.toThrow('explicit HTTPS');
  });
  it('rejects missing, escaping, external and nonliteral chunk references', async () => {
    const { browser, config, views } = await fixture();
    for (const [code, message] of [['import("./missing.js")', 'Missing or escaping'], ['import("../../outside.js")', 'Missing or escaping'], ['import("https://other.example/lazy.js")', 'External Angular build asset'], ['import(window.chunk)', 'Nonliteral dynamic import'], ['new URL(window.image, import.meta.url)', 'Nonliteral import.meta asset']]) {
      await writeFile(join(browser, 'main.js'), code); await expect(buildAssetViews(config, views)).rejects.toThrow(message);
    }
  });
  it('rejects symbolic-link input and output escapes, and unsupported referenced asset types', async () => {
    const { root, browser, config, views } = await fixture(); await symlink(join(root, 'package.json'), join(browser, 'unsafe-link'));
    await expect(buildAssetViews(config, views)).rejects.toThrow('symbolic link'); await rm(join(browser, 'unsafe-link'));
    await writeFile(join(browser, 'styles.css'), 'body { background: url("license.txt"); }'); await expect(buildAssetViews(config, views)).rejects.toThrow('Unsupported public Angular asset type');
    await writeFile(join(browser, 'styles.css'), 'body {}'); const outside = await mkdtemp(join(tmpdir(), 'bridge-assets-outside-')); roots.push(outside); await symlink(outside, join(root, 'dist/assets'));
    await expect(buildAssetViews(config, views)).rejects.toThrow('symbolic link');
  });
});
