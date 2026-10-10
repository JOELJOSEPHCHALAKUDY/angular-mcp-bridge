import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Directly executable ESM tooling.
import { measureViewResources } from '../tooling/benchmark.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(html: string, sources: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-benchmark-')); roots.push(root);
  await mkdir(join(root, 'dist/views'), { recursive: true }); await writeFile(join(root, 'dist/views/demo.html'), html);
  const files: Record<string, { path: string; mimeType: string }> = {};
  for (const [name, bytes] of Object.entries(sources)) {
    const path = `dist/assets/build/demo/${name}`; await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes);
    files[`build/demo/${name}`] = { path, mimeType: name.endsWith('.css') ? 'text/css' : /\.(?:js|mjs)$/.test(name) ? 'text/javascript' : 'application/octet-stream' };
  }
  const view = { htmlPath: 'dist/views/demo.html', sha256: 'fixture-build-digest' };
  const manifest = { delivery: { mode: 'assets', assetOrigin: 'https://assets.example.test' }, assets: { routePrefix: '/__bridge/assets', files }, views: { demo: view } };
  return { root, manifest, view };
}
const base = 'https://assets.example.test/__bridge/assets/build/demo/';

describe('asset delivery benchmark accounting', () => {
  it('counts transitive static imports/reexports and CSS dependencies once, excluding dynamic and prefetched chunks', async () => {
    const html = `<html><head><base href="${base}"><link rel="stylesheet" href="styles.css"><link rel="modulepreload" href="static.js"><link rel="prefetch" href="lazy.js"></head><body><script type="module" src="main.js"></script></body></html>`;
    const sources = {
      'main.js': 'import { value } from "./static.js?v=1#dep"; export * from "./exports.mjs"; export const load = () => import("./lazy.js"); console.log(value);',
      'static.js': 'import "./cycle.js"; export const value = 1;',
      'cycle.js': 'import "./main.js";',
      'exports.mjs': 'export { deep } from "./deep.js";',
      'deep.js': 'export const deep = 42;',
      'lazy.js': 'import "./deferred.js"; export const lazy = 2;',
      'deferred.js': 'export const deferred = true;',
      'styles.css': '@import "./theme/theme.css" screen; body { background: url("./media/image.svg?v=2#asset"); }',
      'theme/theme.css': String.raw`@import url("../styles.css"); @font-face { src: url("../media/my\ font.woff2"); }`,
      'media/image.svg': '<svg />',
      'media/my font.woff2': Buffer.from('font fixture'),
    };
    const { root, manifest, view } = await fixture(html, sources);
    const result = await measureViewResources(manifest, 'demo', view, root);
    const initialNames = ['main.js', 'static.js', 'cycle.js', 'exports.mjs', 'deep.js', 'styles.css', 'theme/theme.css', 'media/image.svg', 'media/my font.woff2'];
    const initialBuffers = initialNames.map(name => Buffer.from(sources[name as keyof typeof sources]));
    expect(result.initialBytes).toBe(Buffer.byteLength(html) + initialBuffers.reduce((sum, bytes) => sum + bytes.length, 0));
    expect(result.initialGzipBytes).toBe(gzipSync(html).length + initialBuffers.reduce((sum, bytes) => sum + gzipSync(bytes).length, 0));
    expect(result.initialAssetCount).toBe(9);
    expect(result.totalGraphBytes).toBe(Buffer.byteLength(html) + Object.values(sources).reduce((sum, value) => sum + Buffer.byteLength(value), 0));
    expect(result.sha256).toBe('fixture-build-digest');
  });
  it('reads inline static modules/styles but ignores comments, string examples, bare imports and foreign origins', async () => {
    const html = `<head><base href="${base}"><style>@import "inline.css";</style><script type="module">import './inline.js'; import 'bare-package'; import('lazy.js');</script><link rel="modulepreload" href="https://foreign.example.test/__bridge/assets/build/demo/foreign.js"></head>`;
    const sources = {
      'inline.js': 'import "./real.js"; import "bare-package"; const example = "import(\\\"./fake.js\\\")"; /* import "./fake.js"; */',
      'real.js': 'export const real = 1;',
      'inline.css': String.raw`/* @import "fake.css"; url("ghost.png") */ .x { content: 'url(fake.png)'; background: url("media/icon\2e svg"); }`,
      'media/icon.svg': '<svg />',
      'foreign.js': 'export const foreign = true;',
      'fake.js': 'export const fake = true;',
      'fake.css': '.x {}',
      'ghost.png': 'ghost',
      'fake.png': 'fake',
      'lazy.js': 'export const lazy = true;',
      'bare-package': 'not resolved without an import map',
    };
    const { root, manifest, view } = await fixture(html, sources); const result = await measureViewResources(manifest, 'demo', view, root);
    expect(result.initialAssetCount).toBe(4);
    expect(result.initialBytes).toBe(Buffer.byteLength(html) + ['inline.js', 'real.js', 'inline.css', 'media/icon.svg'].reduce((sum, name) => sum + Buffer.byteLength(sources[name as keyof typeof sources]), 0));
  });
  it('keeps standalone HTML accounting unchanged without loading an asset graph', async () => {
    const html = '<html><script type="module">const load = () => Promise.resolve(42)</script><style>body{color:red}</style></html>';
    const { root, view } = await fixture(html, {}); const result = await measureViewResources({ views: { demo: view } }, 'demo', view, root);
    expect(result).toEqual({ htmlBytes: Buffer.byteLength(html), initialBytes: Buffer.byteLength(html), initialGzipBytes: gzipSync(html).length, totalGraphBytes: Buffer.byteLength(html), initialAssetCount: 0, sha256: 'fixture-build-digest' });
  });
  it('executes the size-only CLI and retains runtime, machine and delivery metadata', async () => {
    const html = `<head><base href="${base}"><script type="module" src="main.js"></script></head>`;
    const { root, manifest } = await fixture(html, { 'main.js': 'import "./static.js"; import("./lazy.js");', 'static.js': 'export const initial = 1;', 'lazy.js': 'export const deferred = 2;' });
    await writeFile(join(root, 'dist/bridge-manifest.json'), JSON.stringify(manifest));
    await promisify(execFile)(process.execPath, [resolve('tooling/benchmark.mjs')], { cwd: root });
    const report = JSON.parse(await readFile(join(root, 'dist/benchmark.json'), 'utf8'));
    expect(report.runtime).toBe(process.version); expect(report.machine).toMatchObject({ platform: process.platform, arch: process.arch });
    expect(report.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); expect(report.delivery).toBe('assets');
    expect(report.browser).toBeUndefined(); expect(report.views.demo.initialAssetCount).toBe(2);
  });
  it('excludes retained releases while counting current lazy files and actual cross-build static dependencies', async () => {
    const html = `<head><base href="${base}"><script type="module" src="main.js"></script></head>`;
    const current = { 'main.js': 'import "../../retained/demo/shared.js"; import("./lazy.js");', 'lazy.js': 'export const currentDeferred = true;' };
    const { root, manifest, view } = await fixture(html, current);
    const retained = { 'main.js': 'old entry'.repeat(100), 'lazy.js': 'old deferred'.repeat(100), 'shared.js': 'import "./dependency.js";', 'dependency.js': 'export const shared = true;' };
    for (const [name, bytes] of Object.entries(retained)) {
      const path = `dist/assets/retained/demo/${name}`; await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes);
      manifest.assets.files[`retained/demo/${name}`] = { path, mimeType: 'text/javascript' };
    }
    const result = await measureViewResources(manifest, 'demo', view, root);
    const actualStatic = [current['main.js'], retained['shared.js'], retained['dependency.js']];
    expect(result.initialBytes).toBe(Buffer.byteLength(html) + actualStatic.reduce((sum, value) => sum + Buffer.byteLength(value), 0));
    expect(result.totalGraphBytes).toBe(result.initialBytes + Buffer.byteLength(current['lazy.js']));
    expect(result.initialAssetCount).toBe(3);
  });
  it('includes declared HTML media URLs and conservatively counts srcset candidates without double counting', async () => {
    const html = `<head><base href="${base}"></head><body><img src="media/small.png" srcset="media/small.png 1x, media/large.png 2x"><source srcset="data:image/png;base64,aGVsbG8= 1x, media/alternative.png 2x"><audio src="media/audio.mp3"></audio><video src="media/video.mp4" poster="media/small.png"><source src="media/fallback.mp4"></video><img loading="lazy" src="media/later.png"></body>`;
    const sources = { 'media/small.png': 'small', 'media/large.png': 'large', 'media/alternative.png': 'alternative', 'media/audio.mp3': 'audio', 'media/video.mp4': 'video', 'media/fallback.mp4': 'fallback', 'media/later.png': 'later' };
    const { root, manifest, view } = await fixture(html, sources); const result = await measureViewResources(manifest, 'demo', view, root);
    expect(result.initialAssetCount).toBe(7);
    expect(result.initialBytes).toBe(Buffer.byteLength(html) + Object.values(sources).reduce((sum, value) => sum + Buffer.byteLength(value), 0));
    expect(result.totalGraphBytes).toBe(result.initialBytes);
  });
});
