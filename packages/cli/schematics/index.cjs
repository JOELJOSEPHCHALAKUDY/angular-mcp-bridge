const { chain, externalSchematic, SchematicsException } = require('@angular-devkit/schematics');
const { getWorkspace, writeWorkspace } = require('@schematics/angular/utility/workspace');
const { addRootProvider } = require('@schematics/angular/utility/standalone/index');
const { getMainFilePath, findBootstrapApplicationCall, findProvidersLiteral } = require('@schematics/angular/utility/standalone/util');
const { findAppConfig } = require('@schematics/angular/utility/standalone/app_config');
const { isStandaloneApp } = require('@schematics/angular/utility/ng-ast-utils');
const { NodePackageInstallTask } = require('@angular-devkit/schematics/tasks');
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const packageRoot = path.resolve(__dirname, '..');
const packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
const templateRoot = path.join(packageRoot, 'templates/angular');
const fail = message => { throw new SchematicsException(message); };
const json = (tree, file) => { try { const parsed = ts.parseConfigFileTextToJson(file, tree.readText(file)); if (parsed.error) throw new Error('Invalid JSON'); return parsed.config; } catch { return fail(`Cannot read ${file}. Run ng add @angular-mcp-bridge/cli first, or repair its JSON.`); } };
const writeJson = (tree, file, value) => put(tree, file, JSON.stringify(value, null, 2) + '\n');
function put(tree, file, content) { tree.exists(file) ? tree.overwrite(file, content) : tree.create(file, content); }
function safePath(value, label) {
  if (typeof value !== 'string' || !value || path.posix.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) fail(`${label} must be a relative workspace path.`);
  return value.replace(/^\.\//, '');
}
function identifier(value, label) { if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(value)) fail(`${label} must start with a lowercase letter and contain only lowercase letters, numbers, underscores or hyphens.`); return value; }
function ensureAbsent(tree, paths) { for (const file of paths) if (tree.exists(file) || tree.getDir(file).subfiles.length || tree.getDir(file).subdirs.length) fail(`Refusing to overwrite existing work: ${file}`); }
function registryConfig(tree) {
  const config = json(tree, 'bridge.config.json');
  if (config.version !== 1 || !config.native) fail('Native generator registry is not configured. Run ng add @angular-mcp-bridge/cli for a plain Angular app, or configure native.contracts/native.handlers/native.directory.');
  return { config, contracts: safePath(config.native.contracts, 'native.contracts'), handlers: safePath(config.native.handlers, 'native.handlers'), directory: safePath(config.native.directory, 'native.directory') };
}
function objectExport(tree, file, name) {
  const source = ts.createSourceFile(file, tree.readText(file), ts.ScriptTarget.Latest, true);
  let value;
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === name) value = declaration.initializer;
  while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
  if (value && ts.isCallExpression(value)) value = value.arguments[0];
  if (!value || !ts.isObjectLiteralExpression(value)) fail(`${file} must export ${name} as an object literal${name === 'tools' ? ' wrapped in defineTools' : ''}. Existing custom expressions are preserved; adjust the native registry before generating.`);
  return { source, object: value };
}
function relativeModule(from, to) { const value = path.posix.relative(path.posix.dirname(from), to).replace(/\.ts$/, '.js'); return value.startsWith('.') ? value : './' + value; }
function appendRegistry(tree, file, exported, key, symbol, modulePath, imported = symbol) {
  const { object } = objectExport(tree, file, exported);
  if (object.properties.some(property => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === key)) fail(`Tool is already registered: ${key}`);
  const text = tree.readText(file), end = object.getEnd() - 1;
  const comma = object.properties.length && !object.properties.hasTrailingComma ? ',' : '';
  tree.overwrite(file, `import { ${imported === symbol ? symbol : `${imported} as ${symbol}`} } from ${JSON.stringify(relativeModule(file, modulePath))};\n` + text.slice(0, end) + `${comma}\n  ${JSON.stringify(key)}: ${symbol},\n` + text.slice(end));
}
function toolNames(tree, native) {
  const names = new Set(), visited = new Set();
  function visit(file) {
    file = '/' + file.replace(/^\//, ''); if (visited.has(file) || !tree.exists(file)) return; visited.add(file);
    const source = ts.createSourceFile(file, tree.readText(file), ts.ScriptTarget.Latest, true);
    function walk(node) {
      if (ts.isPropertyAssignment(node) && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && ['defineTool', 'defineFileViewerTool'].includes(node.initializer.expression.text) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) names.add(node.name.text);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineTools' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) for (const property of node.arguments[0].properties) if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) names.add(property.name.text);
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
        const target = path.posix.resolve(path.posix.dirname(file), node.moduleSpecifier.text);
        for (const candidate of [target.replace(/\.[cm]?js$/, '.ts'), target + '.ts', target + '/index.ts']) if (tree.exists(candidate)) { visit(candidate); break; }
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  // Inspect the active server's local import graph, not test fixtures or
  // unrelated Angular applications which may define their own sample tools.
  visit(native.contracts); visit(native.handlers); visit(safePath(native.config.server?.entry ?? 'examples/server/main.ts', 'server.entry')); return names;
}
function viewDefinitions(tree, config) {
  const directory = safePath(config.viewsDirectory ?? 'views', 'viewsDirectory'), views = [];
  tree.visit(file => { if (file.startsWith('/' + directory + '/') && file.endsWith('/view.json')) views.push(json(tree, file)); });
  return views;
}
function generateTypes(tree, config) {
  const names = viewDefinitions(tree, config).map(view => identifier(view.name, 'View name')).sort();
  if (new Set(names).size !== names.length) fail('Duplicate view names are registered.');
  put(tree, 'generated/view-names.ts', `// Generated by Angular MCP Bridge.\nexport const viewNames = ${JSON.stringify(names)} as const;\nexport type ViewName = typeof viewNames[number];\nexport function isViewName(value: string): value is ViewName { return (viewNames as readonly string[]).includes(value); }\n`);
}
function featurePaths(native, name) { return { contract: `${native.directory}/${name}/contract.ts`, handler: `${native.directory}/${name}/handler.ts` }; }
function feature(tree, native, name, view) {
  const files = featurePaths(native, name); ensureAbsent(tree, Object.values(files));
  const suffix = createHash('sha256').update(name).digest('hex').slice(0, 8), toolSymbol = `tool_${suffix}`, handlerSymbol = `handler_${suffix}`;
  const exportedTool = `${name.replaceAll('-', '_')}Tool`, exportedHandler = `${name.replaceAll('-', '_')}Handler`;
  const viewImport = view ? `import type { ViewName } from ${JSON.stringify(relativeModule(files.contract, 'generated/view-names.ts'))};\n` : '';
  tree.create(files.contract, `import { defineTool, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';\nimport { z } from 'zod';\n${viewImport}export const ${exportedTool} = defineTool({\n  title: ${JSON.stringify(name)},\n  description: ${JSON.stringify(`Use ${name} to display a greeting. Replace this description and schema with your app's task.`)},\n  input: z.object({ name: z.string().min(1).default('World') }),\n  output: z.object({ message: z.string() }),\n  annotations: readOnlyAnnotations,${view ? `\n  view: ${JSON.stringify(view)} satisfies ViewName,` : ''}\n});\n`);
  tree.create(files.handler, `import type { ToolHandlers } from '@angular-mcp-bridge/server';\nimport { ${exportedTool} as ${toolSymbol} } from './contract.js';\nexport const ${exportedHandler}: ToolHandlers<{ ${JSON.stringify(name)}: typeof ${toolSymbol} }>[${JSON.stringify(name)}] = input => ({\n  data: { message: \`Hello, \${input.name}!\` }, text: \`Hello, \${input.name}!\`,\n});\n`);
  appendRegistry(tree, native.contracts, 'tools', name, toolSymbol, files.contract, exportedTool);
  appendRegistry(tree, native.handlers, 'handlers', name, handlerSymbol, files.handler, exportedHandler);
  return { ...files, toolSymbol, exportedTool };
}
function typedComponent(tree, file, featureInfo, tool) {
  put(tree, file, `import { Component, inject } from '@angular/core';\nimport { createToolClient, McpBridge } from '@angular-mcp-bridge/angular';\nimport { ${featureInfo.exportedTool} as ${featureInfo.toolSymbol} } from ${JSON.stringify(relativeModule(file, featureInfo.contract))};\nconst client = createToolClient({ ${JSON.stringify(tool)}: ${featureInfo.toolSymbol} });\n@Component({\n  selector: 'bridge-root', standalone: true,\n  template: \`<main><h1>${tool}</h1>@let result = info();\n    @switch (result.status) {\n      @case ('success') { <p>{{ result.output.message }}</p> }\n      @case ('error') { <p role="alert">{{ result.error.message }}</p> }\n      @case ('cancelled') { <p role="status">Request cancelled.</p> }\n      @default { <p role="status">Waiting for the host…</p> }\n    }\n    <button type="button" [disabled]="!bridge.connected() || command.pending()" (click)="greet()">Greet again</button>\n    @if (command.data(); as output) { <p aria-live="polite">{{ output.message }}</p> }\n    @if (command.error(); as error) { <p role="alert">{{ error.message }}</p> }\n  </main>\`,\n})\nexport class AppComponent {\n  readonly bridge = inject(McpBridge);\n  readonly info = client.info(${JSON.stringify(tool)});\n  readonly command = client.inject(${JSON.stringify(tool)});\n  async greet(): Promise<void> { try { await this.command.execute({ name: 'Angular' }); } catch { /* Error signal renders feedback. */ } }\n}\n`);
}
function applicationRule(name, projectRoot) { return externalSchematic('@schematics/angular', 'application', { name, projectRoot, standalone: true, routing: false, skipTests: true, minimal: true, skipInstall: true, skipPackageJson: true, style: 'css' }); }
function setupViewProject(name, root, featureInfo, tool) {
  return async tree => {
    // The application was generated by Angular's own schematic. Retain its
    // builders/options and replace only the newly generated starter files.
    tree.visit(file => { if (file.startsWith('/' + root + '/src/app/')) tree.delete(file); });
    typedComponent(tree, `${root}/src/app.ts`, featureInfo, tool);
    put(tree, `${root}/src/main.ts`, `import { bootstrapApplication } from '@angular/platform-browser';\nimport { provideMcpBridge } from '@angular-mcp-bridge/angular';\nimport { AppComponent } from './app.js';\nvoid bootstrapApplication(AppComponent, { providers: [provideMcpBridge({ name: ${JSON.stringify(name)} })] });\n`);
    put(tree, `${root}/src/styles.css`, ':root { font-family: system-ui, sans-serif; color-scheme: light dark; } main { padding: 24px; }\n');
    const index = `${root}/src/index.html`; put(tree, index, tree.readText(index).replace(/<app-root><\/app-root>/, '<bridge-root></bridge-root>'));
    const tsconfig = `${root}/tsconfig.app.json`, parsed = json(tree, tsconfig); parsed.include = ['src/**/*.d.ts']; parsed.files = ['src/main.ts']; writeJson(tree, tsconfig, parsed);
    const workspace = await getWorkspace(tree), project = workspace.projects.get(name), build = project.targets.get('build');
    build.options = { ...build.options, outputPath: `dist/${name}` };
    // Isolate application tsconfig from the project-wide server build.
    await writeWorkspace(tree, workspace); return tree;
  };
}
function ensureToolAvailable(tree, native, name) {
  identifier(name, 'Tool name');
  for (const [file, exported] of [[native.contracts, 'tools'], [native.handlers, 'handlers']]) {
    const { object } = objectExport(tree, file, exported);
    if (object.properties.some(property => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name)) fail(`Tool is already registered: ${name}`);
  }
  if (toolNames(tree, native).has(name)) fail(`Tool is already defined: ${name}`);
  ensureAbsent(tree, Object.values(featurePaths(native, name)));
}
exports.generateTool = options => async tree => {
  const native = registryConfig(tree), name = identifier(options.name, 'Tool name'); ensureToolAvailable(tree, native, name);
  if (options.view && !viewDefinitions(tree, native.config).some(view => view.name === options.view)) fail(`Unknown view: ${options.view}`);
  generateTypes(tree, native.config); feature(tree, native, name, options.view); return tree;
};
exports.generateView = options => async tree => {
  const native = registryConfig(tree), name = identifier(options.name, 'View name'), tool = identifier(options.tool ?? `open_${name.replaceAll('-', '_')}`, 'Tool name');
  const workspace = await getWorkspace(tree), views = viewDefinitions(tree, native.config);
  if (workspace.projects.has(name) || views.some(view => view.name === name)) fail(`View or Angular project already exists: ${name}`);
  ensureToolAvailable(tree, native, tool);
  const root = `apps/${name}`, marker = `${safePath(native.config.viewsDirectory ?? 'views', 'viewsDirectory')}/${name}/view.json`;
  ensureAbsent(tree, [root, marker]);
  tree.create(marker, JSON.stringify({ name, project: name, description: `Typed Angular view ${name}`, devPort: options.port ?? 4201 + views.length }, null, 2) + '\n');
  generateTypes(tree, native.config); const info = feature(tree, native, tool, name);
  return chain([applicationRule(name, root), setupViewProject(name, root, info, tool)]);
};

function providerExists(tree, main) {
  const config = findAppConfig(findBootstrapApplicationCall(tree, main), tree, main);
  if (!config) return false;
  const providers = findProvidersLiteral(config.node); if (!providers) return false;
  const source = config.node.getSourceFile(), names = new Set(), namespaces = new Set(), arrays = new Map();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === '@angular-mcp-bridge/angular') {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if ((element.propertyName?.text ?? element.name.text) === 'provideMcpBridge') names.add(element.name.text);
    }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer)) arrays.set(declaration.name.text, declaration.initializer);
  }
  let found = false; const visited = new Set();
  function walk(node) {
    if (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && names.has(node.expression.text)) || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && namespaces.has(node.expression.expression.text) && node.expression.name.text === 'provideMcpBridge'))) found = true;
    if (ts.isSpreadElement(node) && ts.isIdentifier(node.expression) && arrays.has(node.expression.text) && !visited.has(node.expression.text)) { visited.add(node.expression.text); walk(arrays.get(node.expression.text)); }
    ts.forEachChild(node, walk);
  }
  walk(providers); return found;
}
function copyWorkbench(tree) {
  const source = path.join(templateRoot, 'apps/workbench');
  function copy(from, to) { for (const entry of fs.readdirSync(from, { withFileTypes: true })) { if (entry.isSymbolicLink()) fail('Workbench template contains symbolic links.'); const target = `${to}/${entry.name}`, sourceFile = path.join(from, entry.name); entry.isDirectory() ? copy(sourceFile, target) : put(tree, target, fs.readFileSync(sourceFile)); } }
  copy(source, 'apps/mcp-workbench');
  tree.visit(file => { if (file.startsWith('/apps/mcp-workbench/src/app/')) tree.delete(file); });
}
function dependencyChanges(tree, options) {
  const pkg = json(tree, 'package.json'), template = JSON.parse(fs.readFileSync(path.join(templateRoot, 'package.json'), 'utf8'));
  pkg.dependencies ??= {}; pkg.devDependencies ??= {}; pkg.scripts ??= {};
  const angularVersion = pkg.dependencies['@angular/core'] ?? '22.2.2';
  for (const name of ['@angular/forms', '@angular/aria']) pkg.dependencies[name] ??= angularVersion;
  for (const [name, version] of Object.entries(template.dependencies)) if (!name.startsWith('@angular/') && !name.startsWith('@angular-mcp-bridge/')) pkg.dependencies[name] ??= version;
  for (const name of ['tsx', 'esbuild', '@types/node', '@types/express']) pkg.devDependencies[name] ??= template.devDependencies[name];
  pkg.devDependencies['@angular-mcp-bridge/cli'] ??= packageVersion;
  for (const name of ['angular', 'contracts', 'server', ...(options.local ? ['cli'] : [])]) {
    const dependency = `@angular-mcp-bridge/${name}`;
    if (options.local) {
      const filename = `angular-mcp-bridge-${name}-${packageVersion}.tgz`, source = path.resolve(options.local, 'dist/tarballs', filename), destination = `vendor/${filename}`;
      let info; try { info = fs.lstatSync(source); } catch { fail(`Missing ${filename}. Run npm run create once or npm run build:packages && npm run pack:all in the framework checkout first.`); }
      if (!info.isFile() || info.isSymbolicLink()) fail(`Framework tarball must be a regular file: ${filename}`);
      const bytes = fs.readFileSync(source); if (tree.exists(destination) && !tree.read(destination).equals(bytes)) fail(`Existing vendored package differs: ${destination}`);
      put(tree, destination, bytes); (name === 'cli' ? pkg.devDependencies : pkg.dependencies)[dependency] = `file:${destination}`;
    } else pkg.dependencies[dependency] ??= packageVersion;
  }
  for (const [name, command] of Object.entries({ 'mcp:dev': 'dev', 'mcp:build': 'build', 'mcp:start': 'start', 'mcp:doctor': 'doctor' })) {
    const value = `angular-mcp-bridge ${command}`; if (pkg.scripts[name] && pkg.scripts[name] !== value) fail(`Existing script ${name} is different. Preserve it and choose another integration path.`); pkg.scripts[name] = value;
  }
  writeJson(tree, 'package.json', pkg);
}
function serverSource() {
  return `import { readFileSync } from 'node:fs';\nimport { resolve } from 'node:path';\nimport { serveBridge, type BridgeServerOptions } from '@angular-mcp-bridge/server';\nimport { tools } from './tools.js';\nimport { handlers } from './handlers.js';\ninterface Manifest { views: Record<string, { htmlPath: string; description: string; csp?: NonNullable<BridgeServerOptions<typeof tools>['views'][string]['csp']> }>; assets?: { routePrefix: string; files: Record<string, { path: string; mimeType: string; sha256: string; bytes: number }> } }\nconst manifest = JSON.parse(readFileSync(resolve('dist/bridge-manifest.json'), 'utf8')) as Manifest;\nconst options: BridgeServerOptions<typeof tools> = {\n  name: 'angular-mcp-app', tools, handlers,\n  views: Object.fromEntries(Object.entries(manifest.views).map(([name, view]) => [name, { htmlPath: resolve(view.htmlPath), description: view.description, csp: view.csp }])),\n};\nasync function main(): Promise<void> {\nconst port = Number(process.env['PORT'] ?? 3000);\nconst instance = await serveBridge(options, {\n  port, hostname: process.env['HOST'] ?? '127.0.0.1',\n  allowedHosts: (process.env['ALLOWED_HOSTS'] ?? 'localhost,127.0.0.1,[::1]').split(',').filter(Boolean),\n  allowedOrigins: (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:4200,http://localhost:4201').split(',').filter(Boolean),\n  ...(manifest.assets ? { assets: { directory: resolve('dist/assets'), manifest: manifest.assets } } : {}),\n  configureApp: app => app.get('/__bridge/runtime', (_request, response) => {\n    const runtimePath = process.env['BRIDGE_RUNTIME_MANIFEST'];\n    const runtime: { mcpUrl: string; workbenchUrl?: string; views: Record<string, { devUrl?: string }> } = runtimePath ? JSON.parse(readFileSync(runtimePath, 'utf8')) as { mcpUrl: string; workbenchUrl?: string; views: Record<string, { devUrl?: string }> } : { mcpUrl: \`http://127.0.0.1:\${port}/mcp\`, views: {} };\n    response.json({ mcpUrl: runtime.mcpUrl, workbenchUrl: runtime.workbenchUrl, views: Object.fromEntries(Object.entries(runtime.views).map(([name, view]) => [name, { devUrl: view.devUrl }])) });\n  }),\n});\nconsole.log(\`MCP server: http://127.0.0.1:\${port}/mcp\`);\nlet stopping = false;\nasync function close() { if (stopping) return; stopping = true; await instance.close(); }\nprocess.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });\n}\nvoid main().catch(error => { console.error(error); process.exitCode = 1; });\n`;
}
function ensureServerModule(tree) {
  const file = 'mcp/package.json';
  if (tree.exists(file)) {
    const pkg = json(tree, file);
    if (pkg.type && pkg.type !== 'module') fail('mcp/package.json declares a conflicting module type. Preserve that server and configure its ESM entry explicitly before repeating ng add.');
    if (pkg.type === 'module') return;
    writeJson(tree, file, { ...pkg, type: 'module' });
  } else writeJson(tree, file, { private: true, type: 'module' });
}
exports.ngAdd = options => async (tree, context) => {
  const workspace = await getWorkspace(tree), applications = [...workspace.projects].filter(([, project]) => project.extensions.projectType === 'application');
  const projectName = options.project ?? (applications.length === 1 ? applications[0][0] : undefined), project = workspace.projects.get(projectName);
  if (!projectName || !project || project.extensions.projectType !== 'application') fail('Select an existing Angular application with --project <name>.');
  const main = await getMainFilePath(tree, projectName); if (!isStandaloneApp(tree, main)) fail('ng add currently supports standalone Angular applications. Migrate the application bootstrap to standalone first.');
  const declaredCore = json(tree, 'package.json').dependencies?.['@angular/core'], coreMajor = Number.parseInt(String(declaredCore ?? '').match(/\d+/)?.[0] ?? '', 10);
  if (Number.isFinite(coreMajor) && coreMajor < 22) fail(`Angular MCP Bridge needs Angular 22 or newer, but this app uses @angular/core ${declaredCore}. Run "ng update @angular/core @angular/cli" first, then repeat "ng add @angular-mcp-bridge/cli".`);
  if (tree.exists('bridge.config.json')) {
    const config = json(tree, 'bridge.config.json');
    if (config.native?.project !== projectName || !tree.exists(config.native.contracts) || !tree.exists(config.native.handlers)) fail('Existing bridge configuration is preserved. Use its configured native generators; ng add does not replace an existing server.');
    ensureServerModule(tree); dependencyChanges(tree, options); if (!options.skipInstall) context.addTask(new NodePackageInstallTask());
    return providerExists(tree, main) ? tree : addRootProvider(projectName, ({ code, external }) => code`${external('provideMcpBridge', '@angular-mcp-bridge/angular')}({ name: ${JSON.stringify(projectName)} })`);
  }
  ensureAbsent(tree, ['mcp', 'apps/mcp-workbench', 'tsconfig.mcp.json', 'views']); if (workspace.projects.has('mcp-workbench')) fail('Angular project mcp-workbench already exists.');
  const view = identifier(projectName.replace(/^@/, '').replaceAll('/', '-').toLowerCase(), 'Default view name');
  const config = { version: 1, viewsDirectory: 'views', defaultView: view, outputDirectory: 'dist', server: { entry: 'mcp/main.ts', tsConfig: 'tsconfig.mcp.json', port: 3000 }, workbench: { project: 'mcp-workbench', port: 4200 }, native: { project: projectName, contracts: 'mcp/tools.ts', handlers: 'mcp/handlers.ts', directory: 'mcp/features' } };
  dependencyChanges(tree, options); writeJson(tree, 'bridge.config.json', config);
  ensureServerModule(tree);
  tree.create('mcp/tools.ts', `import { defineTools } from '@angular-mcp-bridge/contracts';\nexport const tools = defineTools({});\n`); tree.create('mcp/handlers.ts', 'export const handlers = {};\n'); tree.create('mcp/main.ts', serverSource());
  writeJson(tree, 'tsconfig.mcp.json', { extends: './tsconfig.json', compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', types: ['node'], strict: true, esModuleInterop: true }, include: ['mcp/**/*.ts'] });
  writeJson(tree, `views/${view}/view.json`, { name: view, project: projectName, description: `Existing Angular application ${projectName}`, devPort: 4201 }); generateTypes(tree, config);
  feature(tree, registryConfig(tree), `open_${view.replaceAll('-', '_')}`, view);
  const ignore = tree.exists('.gitignore') ? tree.readText('.gitignore') : ''; put(tree, '.gitignore', ignore + '\n.bridge-runtime.json\n.bridge-proxy.json\ngenerated/\n');
  tree.create('MCP-BRIDGE.md', '# Angular MCP Bridge\n\nYour existing Angular application is the default MCP view. Its UI and original npm scripts are preserved.\n\nRun `npm install` if installation was skipped, then `npm run mcp:dev`. The first start builds resources and prints the workbench/MCP URLs. Diagnose setup with `npm run mcp:doctor`.\n\nGenerate a typed view with `ng generate @angular-mcp-bridge/cli:view reports`, or a data-only tool with `ng generate @angular-mcp-bridge/cli:tool search`. Edit the generated contract and handler together. Native generators support Angular CLI `--dry-run`; collisions fail without overwriting files.\n\nFramework packages are local tarballs until npm publication. Configure authorization and host allowlists before connecting private data.\n');
  if (!options.skipInstall) context.addTask(new NodePackageInstallTask());
  context.logger.info(['', 'Angular MCP Bridge is set up. Your existing app is unchanged and is now the default MCP view.', '', 'Next:', '  npm run mcp:dev        start the server, your app and the Workbench', '  npm run mcp:doctor     diagnose setup problems', '', 'Open the Workbench URL it prints, select the tool and click Run tool.', 'Add more: ng generate @angular-mcp-bridge/cli:view <name>', 'Read MCP-BRIDGE.md in your project root for what was added.', ''].join('\n'));
  const rules = [applicationRule('mcp-workbench', 'apps/mcp-workbench'), async current => { copyWorkbench(current); const next = await getWorkspace(current); const build = next.projects.get('mcp-workbench').targets.get('build'); build.options = { ...build.options, browser: 'apps/mcp-workbench/src/main.ts', index: 'apps/mcp-workbench/src/index.html', tsConfig: 'apps/mcp-workbench/tsconfig.app.json', styles: ['apps/mcp-workbench/src/styles.css'], outputPath: 'dist/mcp-workbench' }; await writeWorkspace(current, next); return current; }];
  if (!providerExists(tree, main)) rules.push(addRootProvider(projectName, ({ code, external }) => code`${external('provideMcpBridge', '@angular-mcp-bridge/angular')}({ name: ${JSON.stringify(projectName)} })`));
  return chain(rules);
};
exports.migrateNative = () => tree => {
  if (!tree.exists('bridge.config.json')) return tree;
  const config = json(tree, 'bridge.config.json');
  if (config.version !== undefined && config.version !== 1) fail('Unknown bridge config version. Migration will not replace it.');
  config.version = 1;
  if (config.native && !config.native.directory) config.native.directory = 'mcp/features';
  writeJson(tree, 'bridge.config.json', config);
  const pkg = json(tree, 'package.json'); pkg.scripts ??= {}; pkg.scripts['mcp:doctor'] ??= 'angular-mcp-bridge doctor'; writeJson(tree, 'package.json', pkg);
  return tree;
};
