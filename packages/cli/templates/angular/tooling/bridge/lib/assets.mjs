import { readFile, readdir, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { assertSafeDestination, assetOrigin } from './config.mjs';
export { assetOrigin } from './config.mjs';

const mimeTypes = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm' };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const portable = value => value.split(sep).join('/');
function contained(root, path) { const value = relative(root, path); return value === '' || (value !== '..' && !value.startsWith(`..${sep}`)); }
async function outputFiles(root, directory) {
  const actualRoot = await realpath(root), actualDirectory = await realpath(directory);
  if (!contained(actualRoot, actualDirectory)) throw new Error('Angular asset output escapes the workspace.');
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Asset output must not be a symbolic link.');
  const files = new Map();
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = resolve(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Asset output contains a symbolic link: ${entry.name}`);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.set(portable(relative(directory, full)), await readFile(full));
      else throw new Error(`Asset output contains a non-file entry: ${entry.name}`);
    }
  }
  await walk(directory); return files;
}
function reference(files, from, url) {
  if (/^(?:data:|#)/i.test(url)) return;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) throw new Error(`External Angular build asset is unsupported: ${url}. Keep build dependencies local; configure runtime requests separately.`);
  let decoded; try { decoded = decodeURIComponent(url.split(/[?#]/)[0]); } catch { throw new Error(`Invalid asset URL: ${url}`); }
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\')) throw new Error(`Asset URL must be relative to the Angular output: ${url}`);
  const base = resolve('/output', dirname(from)), path = resolve(base, decoded);
  if (!contained('/output', path) || !files.has(portable(relative('/output', path)))) throw new Error(`Missing or escaping Angular asset from ${from}: ${url}`);
  if (!mimeTypes[extname(path).toLowerCase()]) throw new Error(`Unsupported public Angular asset type from ${from}: ${url}`);
}
function inspect(files, filename, bytes) {
  const extension = extname(filename).toLowerCase(); if (!['.html', '.css', '.js', '.mjs'].includes(extension)) return;
  const text = bytes.toString('utf8');
  if (extension === '.css') {
    for (const match of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) reference(files, filename, match[1]);
    for (const match of text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) reference(files, filename, match[1]);
  } else if (extension === '.html') {
    for (const tag of text.matchAll(/<(?:script|link|img|source|audio|video)\b[^>]*>/gi)) {
      for (const match of tag[0].matchAll(/\b(?:src|href|poster)=["']([^"']+)["']/gi)) reference(files, filename, match[1]);
      for (const match of tag[0].matchAll(/\bsrcset=["']([^"']+)["']/gi)) for (const value of match[1].split(',')) reference(files, filename, value.trim().split(/\s+/)[0]);
    }
    for (const match of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) reference(files, filename, match[1]);
  } else {
    // Read syntax rather than strings/comments containing examples of imports.
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const string = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
    const metaUrl = node => node && ts.isPropertyAccessExpression(node) && node.name.text === 'url' && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && string(node.moduleSpecifier)) reference(files, filename, node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!string(node.arguments[0])) throw new Error(`Nonliteral dynamic import in ${filename}. Asset delivery requires statically resolvable Angular chunks.`);
        reference(files, filename, node.arguments[0].text);
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && metaUrl(node.arguments?.[1])) {
        if (!string(node.arguments?.[0])) throw new Error(`Nonliteral import.meta asset URL in ${filename}. Use a literal relative build asset.`);
        reference(files, filename, node.arguments[0].text);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
}
async function retainedAssets(config, origin, routePrefix) {
  const path = resolve(config.root, config.outputDirectory, 'bridge-manifest.json'); let previous;
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (previous.delivery?.mode !== 'assets' || previous.delivery.assetOrigin !== origin) return {};
  if (previous.assets?.routePrefix !== routePrefix || !previous.assets.files || typeof previous.assets.files !== 'object' || Array.isArray(previous.assets.files)) throw new Error('Previous asset manifest is invalid. Restore its verified build snapshot or explicitly retire it before rebuilding.');
  const root = resolve(config.root, config.outputDirectory, 'assets'), result = {};
  for (const [key, entry] of Object.entries(previous.assets.files)) {
    const segments = key.split('/');
    if (!/^[a-f0-9]{24}$/.test(segments[0]) || !/^[a-z][a-z0-9_-]*$/.test(segments[1]) || segments.length < 3 || key.includes('\\') || key.includes('%') || segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error(`Invalid previous asset key: ${key}`);
    const target = resolve(root, key), expectedPath = portable(relative(config.root, target));
    const mimeType = mimeTypes[extname(key).toLowerCase()];
    if (!entry || !mimeType || entry.path !== expectedPath || entry.mimeType !== mimeType || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid previous asset metadata: ${key}`);
    await assertSafeDestination(config.root, target);
    let ancestor = target;
    while (true) { const info = await lstat(ancestor); if (info.isSymbolicLink()) throw new Error(`Previous asset contains a symbolic link: ${key}`); if (ancestor === target && !info.isFile()) throw new Error(`Previous asset must be a regular file: ${key}`); if (ancestor === root) break; ancestor = dirname(ancestor); }
    const bytes = await readFile(target);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Immutable asset differs from its build hash: ${target}`);
    result[key] = { path: expectedPath, mimeType: entry.mimeType, sha256: entry.sha256, bytes: entry.bytes };
  }
  return result;
}
export async function buildAssetViews(config, views) {
  const origin = assetOrigin(config.delivery?.assetOrigin); const routePrefix = '/__bridge/assets';
  const manifest = { version: 1, defaultView: config.defaultView ?? views[0]?.name, delivery: { mode: 'assets', assetOrigin: origin }, assets: { routePrefix, files: await retainedAssets(config, origin, routePrefix) }, views: {} };
  for (const view of views) {
    const sourceDirectory = dirname(view.sourceHtmlPath), files = await outputFiles(config.root, sourceDirectory);
    const sourceName = portable(relative(sourceDirectory, view.sourceHtmlPath));
    if (!files.has(sourceName)) throw new Error(`Missing Angular HTML for ${view.name}.`);
    for (const [file, bytes] of files) inspect(files, file, bytes);
    const digest = createHash('sha256'); for (const [file, bytes] of files) digest.update(file).update('\0').update(sha256(bytes)).update('\0');
    const buildId = digest.digest('hex').slice(0, 24), keyPrefix = `${buildId}/${view.name}`;
    const base = `${origin}${routePrefix}/${keyPrefix}/`;
    const output = resolve(config.root, config.outputDirectory, 'assets', buildId, view.name);
    await assertSafeDestination(config.root, output);
    for (const [file, bytes] of files) {
      if (file.includes('%') || file.includes('\\')) throw new Error(`Unsupported public asset filename: ${file}`);
      const target = resolve(output, file); await assertSafeDestination(config.root, target); await mkdir(dirname(target), { recursive: true });
      try { await writeFile(target, bytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; if (sha256(await readFile(target)) !== sha256(bytes)) throw new Error(`Immutable asset differs from its build hash: ${target}`); }
      // HTML is delivered as an MCP resource. Source maps, licenses and unknown
      // files remain in the build artifact without becoming public endpoints.
      const mimeType = mimeTypes[extname(file).toLowerCase()];
      if (mimeType) manifest.assets.files[`${keyPrefix}/${file}`] = { path: portable(relative(config.root, target)), mimeType, sha256: sha256(bytes), bytes: bytes.length };
    }
    let html = files.get(sourceName).toString('utf8').replace(/<base\b[^>]*>/gi, '');
    // Base is required for runtime-created relative images; direct boot resources
    // are also absolute so module entry and preload resolution is unambiguous.
    html = html.replace(/<(script|link|img|source|audio|video)\b[^>]*>/gi, tag => tag.replace(/\b(src|href|poster)=(["'])([^"']+)\2/gi, (attribute, name, quote, value) => /^(?:data:|#)/i.test(value) ? attribute : `${name}=${quote}${new URL(value, base).href}${quote}`));
    const baseTag = `<base href="${base}">`;
    html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, head => head + baseTag) : baseTag + html;
    await assertSafeDestination(config.root, view.htmlPath); await mkdir(dirname(view.htmlPath), { recursive: true }); await writeFile(view.htmlPath, html);
    manifest.views[view.name] = { project: view.project, htmlPath: portable(relative(config.root, view.htmlPath)), description: view.description, bytes: Buffer.byteLength(html), sha256: sha256(html), csp: { ...view.csp, connectDomains: view.csp?.connectDomains ?? [], resourceDomains: [...new Set([...(view.csp?.resourceDomains ?? []), origin])], baseUriDomains: [...new Set([...(view.csp?.baseUriDomains ?? []), origin])] } };
    console.log(`Packaged ${view.name} with ${files.size} immutable Angular assets.`);
  }
  const directory = resolve(config.root, config.outputDirectory); await mkdir(directory, { recursive: true });
  await assertSafeDestination(config.root, resolve(directory, 'bridge-manifest.json')); await writeFile(resolve(directory, 'bridge-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const primary = views.find(view => view.name === manifest.defaultView);
  if (primary) { await assertSafeDestination(config.root, resolve(directory, 'widget.html')); await writeFile(resolve(directory, 'widget.html'), await readFile(primary.htmlPath)); }
  return manifest;
}
