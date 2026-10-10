import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { arch, cpus, platform } from 'node:os';
import { pathToFileURL } from 'node:url';

function attribute(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.replace(/&amp;/gi, '&');
}
function srcsetReferences(value) {
  const references = [];
  for (let index = 0; index < value.length;) {
    while (index < value.length && /[\s,]/.test(value[index])) ++index;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) ++index;
    const token = value.slice(start, index);
    if (token) references.push(token.replace(/,+$/, ''));
    if (token.endsWith(',')) continue;
    let parentheses = 0;
    while (index < value.length) {
      const character = value[index++];
      if (character === ',' && !parentheses) break;
      if (character === '(') ++parentheses;
      else if (character === ')' && parentheses) --parentheses;
    }
  }
  return references;
}
function cssReferences(source) {
  const references = [];
  const decode = value => value.replace(/\\(?:([\da-f]{1,6})\s?|\r\n|[\r\n\f]|(.))/gi, (_escape, hex, literal) => {
    const code = hex ? parseInt(hex, 16) : undefined;
    return hex ? String.fromCodePoint(code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? code : 0xfffd) : literal ?? '';
  });
  const trivia = start => {
    let index = start;
    while (index < source.length) {
      if (/\s/.test(source[index])) ++index;
      else if (source.startsWith('/*', index)) { const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2; }
      else break;
    }
    return index;
  };
  const string = start => {
    let end = start + 1;
    while (end < source.length && source[end] !== source[start]) { if (source[end] === '\\') ++end; ++end; }
    return { value: decode(source.slice(start + 1, end)), end: Math.min(end + 1, source.length) };
  };
  for (let index = 0; index < source.length;) {
    const next = trivia(index); if (next !== index) { index = next; continue; }
    if (source[index] === '"' || source[index] === "'") { index = string(index).end; continue; }
    if (source.slice(index, index + 7).toLowerCase() === '@import' && !/[\w-]/.test(source[index + 7] ?? '')) {
      const start = trivia(index + 7);
      if (source[start] === '"' || source[start] === "'") { const token = string(start); references.push(token.value); index = token.end; continue; }
      index = start; continue;
    }
    if (source.slice(index, index + 3).toLowerCase() === 'url' && !/[\w-]/.test(source[index - 1] ?? '')) {
      const open = trivia(index + 3);
      if (source[open] === '(') {
        const start = trivia(open + 1);
        if (source[start] === '"' || source[start] === "'") {
          const token = string(start), close = trivia(token.end);
          if (source[close] === ')') references.push(token.value);
          index = close + 1; continue;
        }
        let end = start;
        while (end < source.length && source[end] !== ')') { if (source[end] === '\\') ++end; ++end; }
        if (source[end] === ')') references.push(decode(source.slice(start, end).trim()));
        index = end + 1; continue;
      }
    }
    ++index;
  }
  return references;
}

let syntax;
const urlSpecifier = reference => /^(?:[./]|[a-z][a-z\d+.-]*:)/i.test(reference);
async function staticImports(source, filename) {
  syntax ??= import('typescript').then(module => module.default);
  const ts = await syntax, tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  return tree.statements.flatMap(node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      return [node.moduleSpecifier.text];
    }
    return [];
  });
}

/** Static manifest accounting only: this never fetches assets or executes code. */
export async function measureViewResources(manifest, name, view, rootDirectory = process.cwd()) {
  const html = await readFile(resolve(rootDirectory, view.htmlPath));
  if (!manifest.assets) return { htmlBytes: html.length, initialBytes: html.length, initialGzipBytes: gzipSync(html).length,
    totalGraphBytes: html.length, initialAssetCount: 0, sha256: view.sha256 };
  const files = manifest.assets?.files ?? {}, route = manifest.assets?.routePrefix;
  const initial = new Set(), cache = new Map();
  const htmlText = html.toString('utf8');
  const baseHref = attribute(htmlText.match(/<base\b[^>]*>/i)?.[0] ?? '', 'href');
  const origin = manifest.delivery?.assetOrigin ? new URL(manifest.delivery.assetOrigin).origin : undefined;
  const base = origin ? new URL(baseHref ?? '/', origin).href : undefined;
  let currentPrefix;
  if (baseHref && base && route) {
    const target = new URL(base);
    if (target.origin === origin && target.pathname.startsWith(`${route}/`)) {
      const segments = decodeURIComponent(target.pathname.slice(route.length + 1)).split('/');
      if (segments[0] && segments[1] === name) currentPrefix = `${segments[0]}/${name}/`;
    }
  }
  if (!currentPrefix) throw new Error(`Asset HTML for ${name} needs a base URL identifying its current build and view directory.`);
  // Manifests retain older immutable releases for already-open views. Their
  // bytes do not belong to this view's current build. Actual cross-build static
  // dependencies are added separately during traversal below.
  const graph = new Set(Object.keys(files).filter(key => key.startsWith(currentPrefix)));
  const assetUrl = key => new URL(`${route}/${key.split('/').map(encodeURIComponent).join('/')}`, origin).href;
  const add = (reference, parent = base) => {
    if (!origin || !route || !parent || !reference || /^(?:data:|blob:|#)/i.test(reference)) return;
    let target, key;
    try { target = new URL(reference, parent); key = decodeURIComponent(target.pathname.slice(route.length + 1)); }
    catch { return; }
    if (target.origin === origin && target.pathname.startsWith(`${route}/`) && Object.hasOwn(files, key)) initial.add(key);
  };
  const readAsset = async key => { if (!cache.has(key)) cache.set(key, await readFile(resolve(rootDirectory, files[key].path))); return cache.get(key); };
  for (const match of htmlText.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    if (/^<script/i.test(tag)) add(attribute(tag, 'src'));
    else {
      const rel = attribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
      if (rel.some(value => ['stylesheet', 'modulepreload', 'preload', 'icon', 'apple-touch-icon'].includes(value))) add(attribute(tag, 'href'));
    }
  }
  for (const match of htmlText.matchAll(/<(?:img|source|audio|video)\b[^>]*>/gi)) {
    for (const name of ['src', 'poster']) add(attribute(match[0], name));
    for (const reference of srcsetReferences(attribute(match[0], 'srcset') ?? '')) add(reference);
  }
  for (const match of htmlText.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) for (const reference of cssReferences(match[1])) add(reference);
  for (const match of htmlText.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attribute(match[1], 'type')?.toLowerCase() === 'module' && !attribute(match[1], 'src')) {
      for (const reference of await staticImports(match[2], 'inline-module.js')) if (urlSpecifier(reference)) add(reference);
    }
  }
  // Set iteration visits newly discovered entries and handles cycles/deduplication.
  for (const key of initial) {
    const bytes = await readAsset(key), mime = files[key].mimeType?.split(';')[0].trim();
    const parent = assetUrl(key);
    if (mime === 'text/css' || /\.css$/i.test(key)) {
      for (const reference of cssReferences(bytes.toString('utf8'))) add(reference, parent);
    } else if (['text/javascript', 'application/javascript'].includes(mime) || /\.(?:js|mjs)$/i.test(key)) {
      for (const reference of await staticImports(bytes.toString('utf8'), key)) {
        // Bare module specifiers require import maps, which this static estimate
        // does not resolve. Angular's bundled imports use relative URLs.
        if (urlSpecifier(reference)) add(reference, parent);
      }
    }
    graph.add(key);
  }
  let initialBytes = html.length, initialGzipBytes = gzipSync(html).length, graphBytes = html.length;
  for (const key of graph) {
    const bytes = await readAsset(key); graphBytes += bytes.length;
    if (initial.has(key)) { initialBytes += bytes.length; initialGzipBytes += gzipSync(bytes).length; }
  }
  return { htmlBytes: html.length, initialBytes, initialGzipBytes, totalGraphBytes: graphBytes, initialAssetCount: initial.size, sha256: view.sha256 };
}

export async function main(args = process.argv.slice(2)) {
  const option = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} needs a value.`); return args[i + 1]; };
  if (args.includes('--help')) {
    console.log('Usage: npm run benchmark -- [--url http://127.0.0.1:3000] [--iterations 5]\nBuild first. Without --url, measures raw/gzip resource sizes. With --url, measures local workbench-to-widget readiness and the project demo read flow in fresh browser contexts. Results: dist/benchmark.json.');
    return;
  }
  const iterations = Number(option('--iterations', '5'));
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 30) throw new Error('iterations must be an integer between 1 and 30.');
  const manifest = JSON.parse(await readFile(resolve('dist/bridge-manifest.json'), 'utf8'));
  const report = { recordedAt: new Date().toISOString(), runtime: process.version, machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, delivery: manifest.delivery?.mode ?? 'standalone', views: {}, browser: undefined,
    interpretation: 'Local observations for this build and machine. Gzip sizes assume gzip delivery. Read timings include bridge/server/render work. No cross-framework comparison or real-host measurement.' };
  for (const [name, view] of Object.entries(manifest.views)) {
    report.views[name] = await measureViewResources(manifest, name, view);
  }
  const url = option('--url');
  if (url) {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Benchmark URL must use HTTP or HTTPS.');
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const ready = [], reads = [];
    try {
      for (let i = 0; i < iterations; i++) {
        const context = await browser.newContext();
        try {
          const page = await context.newPage(), start = performance.now();
          await page.goto(target.href); await page.locator('.preview-status').filter({ hasText: /^connected$/ }).waitFor({ timeout: 30_000 });
          const widget = page.frameLocator('iframe'); await widget.locator('main').waitFor();
          ready.push(performance.now() - start);
          const filter = widget.getByRole('button', { name: 'Ready', exact: true });
          if (await filter.count()) {
            await filter.waitFor(); const readStart = performance.now(); await filter.click();
            await widget.getByRole('button', { name: /Atlas workspace/ }).waitFor();
            await filter.evaluate(element => new Promise((resolve, reject) => {
              const started = Date.now(); const done = () => { if (!element.disabled) resolve(); else if (Date.now() - started > 30_000) reject(new Error('Read timed out')); else requestAnimationFrame(done); }; done();
            }));
            reads.push(performance.now() - readStart);
          }
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
    const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { samplesMs: values.map(value => Math.round(value * 100) / 100), medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)] }; };
    report.browser = { url: target.href, version: browser.version(), freshContexts: iterations, workbenchToWidgetReady: summary(ready), ...(reads.length ? { projectReadThroughHost: summary(reads) } : {}) };
  }
  await writeFile(resolve('dist/benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('Saved dist/benchmark.json');
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
