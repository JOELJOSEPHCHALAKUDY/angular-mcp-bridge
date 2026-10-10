import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafeDestination } from './config.mjs';

const mimeTypes = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml', '.webp':'image/webp', '.avif':'image/avif', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.ico':'image/x-icon' };
async function localAsset(directory, url) {
  if (/^(?:data:|https?:|\/\/|#)/i.test(url)) return null;
  const path = decodeURIComponent(url.split(/[?#]/)[0]);
  if (!path || path.startsWith('/')) throw new Error(`Widget asset must be a relative file: ${url}`);
  const file = resolve(directory, path);
  const actual = await realpath(file); const root = await realpath(directory); const rel = relative(root, actual);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Widget asset escapes its output directory: ${url}`);
  return actual;
}
async function dataUrl(file) {
  const mime = mimeTypes[extname(file).toLowerCase()];
  if (!mime) throw new Error(`Cannot inline unsupported widget asset type: ${extname(file)}`);
  return `data:${mime};base64,${(await readFile(file)).toString('base64')}`;
}
function rejectExternal(url) {
  if (/^(?:https?:|\/\/)/i.test(url)) throw new Error(`External widget asset ${url} cannot be bundled. Use a local asset or declare and serve it explicitly outside the standalone build.`);
}
async function rewriteCss(css, directory) {
  if (/@import\b/i.test(css)) throw new Error('Standalone CSS must not contain @import. Let Angular bundle imports first.');
  for (const asset of [...css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)]) {
    rejectExternal(asset[1]); const assetFile = await localAsset(directory, asset[1]);
    if (assetFile) { const encoded = await dataUrl(assetFile); css = css.replace(asset[0], () => `url("${encoded}")`); }
  }
  return css;
}
export async function bundleHtml(sourceHtmlPath, outputHtmlPath, options = {}) {
  const { build } = await import('esbuild');
  const directory = dirname(sourceHtmlPath);
  if (options.workspaceRoot) await assertSafeDestination(options.workspaceRoot, outputHtmlPath);
  await localAsset(directory, sourceHtmlPath.slice(directory.length + 1));
  let html = await readFile(sourceHtmlPath, 'utf8');
  if (/\bsrcset\s*=/i.test(html)) throw new Error('Standalone HTML srcset is unsupported. Use an imported image or a local img src instead.');
  for (const match of [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi)]) {
    rejectExternal(match[1]); const file = await localAsset(directory, match[1]);
    if (!file) throw new Error('Script source must be a local JavaScript file.');
    const result = await build({ entryPoints: [file], bundle: true, splitting: false, format: 'esm', platform: 'browser', target: 'es2022', minify: options.minify ?? true, write: false, legalComments: 'inline', loader: { '.svg':'dataurl', '.png':'dataurl', '.jpg':'dataurl', '.jpeg':'dataurl', '.gif':'dataurl', '.woff':'dataurl', '.woff2':'dataurl' } });
    if (result.outputFiles.length !== 1) throw new Error('Standalone JavaScript bundling produced additional assets. Import CSS through the Angular styles option.');
    const source = result.outputFiles[0].text;
    // Runtime asset URLs emitted by new URL(asset, import.meta.url) cannot resolve in srcdoc.
    if (/import\.meta\.url/.test(source)) throw new Error('Widget JavaScript uses import.meta.url. Import local assets as data URLs or configure an explicit host resource domain.');
    html = html.replace(match[0], () => `<script type="module">${source.replace(/<\/script/gi, '<\\/script')}</script>`);
  }
  for (const match of [...html.matchAll(/<link\b[^>]*>/gi)]) {
    if (/rel=["'](?:modulepreload|preload|prefetch)["']/i.test(match[0])) { html = html.replace(match[0], ''); continue; }
    if (!/rel=["']stylesheet["']/i.test(match[0])) continue;
    const url = match[0].match(/href=["']([^"']+)["']/i)?.[1]; if (!url) throw new Error('Stylesheet missing href.');
    rejectExternal(url); const file = await localAsset(directory, url); if (!file) throw new Error('Stylesheet must be local.');
    const css = await rewriteCss(await readFile(file, 'utf8'), dirname(file));
    html = html.replace(match[0], () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
  }
  for (const match of [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]) {
    const css = await rewriteCss(match[1], directory);
    html = html.replace(match[0], () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
  }
  // Inline static image/icon sources as well; resource domains remain empty by default.
  for (const match of [...html.matchAll(/<(?:img|source|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi)]) {
    if (/^<link/i.test(match[0]) && !/rel=["'](?:icon|apple-touch-icon)["']/i.test(match[0])) continue;
    rejectExternal(match[1]); const file = await localAsset(directory, match[1]);
    if (file) { const encoded = await dataUrl(file); html = html.replace(match[0], () => match[0].replace(match[1], () => encoded)); }
  }
  await mkdir(dirname(outputHtmlPath), { recursive: true });
  await writeFile(outputHtmlPath, html);
  return { bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex'), csp: { connectDomains: [], resourceDomains: [] } };
}
export async function bundleViews(config, views) {
  const manifest = { version: 1, defaultView: config.defaultView ?? views[0]?.name, views: {} };
  for (const view of views) {
    const result = await bundleHtml(view.sourceHtmlPath, view.htmlPath, { workspaceRoot: config.root });
    manifest.views[view.name] = { project: view.project, htmlPath: relative(config.root, view.htmlPath).split(sep).join('/'), description: view.description, ...result };
    console.log(`Bundled ${view.name} (${Math.round(result.bytes / 1024)} KB).`);
  }
  const directory = resolve(config.root, config.outputDirectory); await mkdir(directory, { recursive: true });
  await assertSafeDestination(config.root, resolve(directory, 'bridge-manifest.json'));
  await writeFile(resolve(directory, 'bridge-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const primary = views.find(view => view.name === manifest.defaultView);
  if (primary) { await assertSafeDestination(config.root, resolve(directory, 'widget.html')); await writeFile(resolve(directory, 'widget.html'), await readFile(primary.htmlPath)); }
  return manifest;
}
