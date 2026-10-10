import { readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path';

export function containedPath(root, path, label = 'Path') {
  if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error(`${label} must be a relative workspace path.`);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label} escapes the workspace: ${path}`);
  return target;
}
export function assetOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Asset delivery requires an explicit HTTPS assetOrigin, for example https://assets.example.com.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('assetOrigin must be an HTTPS origin without credentials, path, query or fragment.');
  return url.origin;
}
function angularJson(text) {
  // Angular workspaces permit JSON comments and trailing commas. Keep this
  // parser dependency-free so doctor also works before npm install.
  let output = '', quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index], next = text[index + 1];
    if (quoted) { output += character; if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; continue; }
    if (character === '"') { quoted = true; output += character; continue; }
    if (character === '/' && next === '/') { while (index < text.length && text[index] !== '\n') index++; output += '\n'; continue; }
    if (character === '/' && next === '*') { index += 2; while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++; if (index >= text.length) throw new Error('Unterminated comment in angular.json.'); index++; output += ' '; continue; }
    output += character;
  }
  let normalized = ''; quoted = false; escaped = false;
  for (let index = 0; index < output.length; index++) {
    const character = output[index];
    if (quoted) { normalized += character; if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; continue; }
    if (character === '"') quoted = true;
    if (character === ',' && /^\s*[}\]]/.test(output.slice(index + 1))) continue;
    normalized += character;
  }
  return JSON.parse(normalized);
}
async function safeExisting(root, target) {
  const actual = await realpath(target);
  const rel = relative(await realpath(root), actual);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Symbolic link escapes the workspace: ${target}`);
  return actual;
}
export async function assertSafeDestination(root, target) {
  const actualRoot = await realpath(root); let ancestor = target;
  while (true) {
    try {
      const actual = await realpath(ancestor); const rel = relative(actualRoot, actual);
      if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Destination escapes the workspace through a symbolic link: ${target}`);
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; }
  }
}
export async function readConfiguration(root = process.cwd()) {
  root = resolve(root);
  let config;
  try { config = JSON.parse(await readFile(resolve(root, 'bridge.config.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = { version: 1, viewsDirectory: 'views', defaultView: 'projects' };
  }
  if (config.version !== 1) throw new Error('Unsupported bridge.config.json version; expected 1.');
  const angular = angularJson(await readFile(resolve(root, 'angular.json'), 'utf8'));
  const outputDirectory = config.outputDirectory ?? 'dist';
  containedPath(root, outputDirectory, 'outputDirectory');
  containedPath(root, config.viewsDirectory ?? 'views', 'viewsDirectory');
  const server = { entry: 'examples/server/main.ts', port: 3000, ...config.server };
  containedPath(root, server.entry, 'server.entry');
  if (server.tsConfig) containedPath(root, server.tsConfig, 'server.tsConfig');
  if (config.delivery && !['standalone', 'assets'].includes(config.delivery.mode)) throw new Error('delivery.mode must be standalone or assets.');
  if (config.delivery?.mode === 'assets') assetOrigin(config.delivery.assetOrigin);
  return { ...config, root, angular, outputDirectory, viewsDirectory: config.viewsDirectory ?? 'views', server, workbench: { project: 'workbench', port: 4200, ...config.workbench } };
}
export function validateIdentifier(value, label = 'View name') {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(value)) throw new Error(`${label} must start with a lowercase letter and contain only lowercase letters, numbers, underscores or hyphens.`);
  return value;
}
export async function discoverViews(config) {
  const directory = containedPath(config.root, config.viewsDirectory, 'viewsDirectory');
  const markers = [];
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`View discovery does not follow symbolic links: ${entry.name}`);
      if (entry.isDirectory()) await walk(resolve(path, entry.name));
      else if (entry.isFile() && entry.name === 'view.json') markers.push(resolve(path, entry.name));
    }
  }
  try { await safeExisting(config.root, directory); await walk(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Existing v0.1 workspaces remain buildable until they add view markers.
  const definitions = markers.length ? await Promise.all(markers.map(async marker => ({ ...JSON.parse(await readFile(marker, 'utf8')), marker }))) : [{ name: 'projects', project: 'demo', description: 'Angular MCP application', devPort: 4201 }];
  const names = new Set(); const projects = new Set(); const paths = new Set();
  const views = definitions.map((view, index) => {
    validateIdentifier(view.name);
    if (names.has(view.name)) throw new Error(`Duplicate view name: ${view.name}`); names.add(view.name);
    const project = config.angular.projects?.[view.project];
    if (!project || project.projectType !== 'application') throw new Error(`View ${view.name} references an unknown Angular application: ${view.project}`);
    if (projects.has(view.project)) throw new Error(`Angular project ${view.project} is mapped to more than one view.`); projects.add(view.project);
    const build = project.architect?.build ?? project.targets?.build;
    const output = build?.options?.outputPath ?? `dist/${view.project}`;
    const base = typeof output === 'string' ? output : output.base;
    const browser = typeof output === 'object' ? (output.browser ?? 'browser') : 'browser';
    const htmlPath = containedPath(config.root, view.htmlPath ?? `${base}/${browser ? `${browser}/` : ''}index.html`, `View ${view.name} htmlPath`);
    if (paths.has(htmlPath)) throw new Error(`Duplicate view HTML path: ${htmlPath}`); paths.add(htmlPath);
    const bundledPath = containedPath(config.root, `${config.outputDirectory}/views/${view.name}.html`, 'Bundled HTML path');
    return { ...view, project: view.project, name: view.name, description: view.description ?? `Angular view ${view.name}`, sourceHtmlPath: htmlPath, htmlPath: bundledPath, devPort: view.devPort ?? 4201 + index };
  });
  if (config.defaultView && !names.has(config.defaultView)) throw new Error(`Default view is not registered: ${config.defaultView}`);
  return views;
}
export async function generateViewTypes(config, views) {
  const file = resolve(config.root, 'generated/view-names.ts');
  await assertSafeDestination(config.root, file);
  await mkdir(dirname(file), { recursive: true });
  const names = views.map(view => JSON.stringify(view.name)).join(', ');
  await writeFile(file, `// Generated by Angular MCP Bridge. Run bridge build or bridge dev after adding a view.\nexport const viewNames = [${names}] as const;\nexport type ViewName = typeof viewNames[number];\nexport function isViewName(value: string): value is ViewName { return (viewNames as readonly string[]).includes(value); }\n`);
  return file;
}
