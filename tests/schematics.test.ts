import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { SchematicTestRunner, type UnitTestTree } from '@angular-devkit/schematics/testing';
import { HostTree } from '@angular-devkit/schematics';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');
const collection = resolve('packages/cli/schematics/collection.json');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const readJson = (tree: UnitTestTree, file: string) => ts.parseConfigFileTextToJson(file, tree.readContent(file)).config;
async function existing() {
  const runner = new SchematicTestRunner('@angular-mcp-bridge/cli', collection);
  let tree = await runner.runExternalSchematic('@schematics/angular', 'workspace', { name: 'existing', version: '22.2.2' }, new HostTree());
  tree = await runner.runExternalSchematic('@schematics/angular', 'application', { name: 'existing', projectRoot: '', standalone: true, skipInstall: true, skipTests: true, routing: false }, tree);
  const local = await mkdtemp(join(tmpdir(), 'bridge-schematic-')); roots.push(local); await mkdir(join(local, 'dist/tarballs'), { recursive: true });
  for (const name of ['angular', 'contracts', 'server', 'cli']) await writeFile(join(local, `dist/tarballs/angular-mcp-bridge-${name}-0.1.4.tgz`), `fixture-${name}`);
  return { runner, tree, local };
}
async function integrated() { const value = await existing(); return { ...value, tree: await value.runner.runSchematic('ng-add', { local: value.local, skipInstall: true }, value.tree) }; }
describe('Angular native schematic collection', () => {
  it('explains how to proceed when the app is older than Angular 22', async () => {
    const { runner, tree: original, local } = await existing();
    const pkg = readJson(original, '/package.json'); pkg.dependencies['@angular/core'] = '^19.2.0'; original.overwrite('/package.json', JSON.stringify(pkg));
    await expect(runner.runSchematic('ng-add', { local, skipInstall: true }, original.branch())).rejects.toThrow('ng update @angular/core');
  });
  it('integrates an existing standalone app, preserving UI/scripts and installing a real local server/workbench', async () => {
    const { runner, tree: original, local } = await existing();
    original.overwrite('/src/app/app.html', '<h1>My existing product</h1>');
    const originalScripts = readJson(original, '/package.json').scripts;
    const tree = await runner.runSchematic('ng-add', { local, skipInstall: true }, original.branch());
    expect(tree.readContent('/src/app/app.html')).toBe('<h1>My existing product</h1>');
    expect(readJson(tree, '/package.json').scripts).toMatchObject({ ...originalScripts, 'mcp:dev': 'angular-mcp-bridge dev', 'mcp:doctor': 'angular-mcp-bridge doctor' });
    expect(readJson(tree, '/package.json').dependencies).toMatchObject({ '@angular-mcp-bridge/angular': 'file:vendor/angular-mcp-bridge-angular-0.1.4.tgz', '@angular/forms': '^22.2.0', '@angular/aria': '^22.2.0' });
    expect(readJson(tree, '/package.json').devDependencies['@angular-mcp-bridge/cli']).toBe('file:vendor/angular-mcp-bridge-cli-0.1.4.tgz');
    expect(tree.readContent('/src/app/app.config.ts')).toContain('provideMcpBridge({ name: "existing" })');
    expect(readJson(tree, '/bridge.config.json')).toMatchObject({ defaultView: 'existing', server: { entry: 'mcp/main.ts', tsConfig: 'tsconfig.mcp.json' }, native: { project: 'existing', contracts: 'mcp/tools.ts', handlers: 'mcp/handlers.ts' } });
    expect(tree.readContent('/mcp/main.ts')).toContain("assets: { directory: resolve('dist/assets')");
    expect(tree.readContent('/mcp/main.ts')).toContain('name: "existing"');
    expect(readJson(tree, '/mcp/package.json')).toEqual({ private: true, type: 'module' });
    expect(readJson(tree, '/package.json').type).toBeUndefined();
    expect(tree.readContent('/apps/mcp-workbench/src/app.ts')).toContain('Workbench');
    expect(readJson(tree, '/angular.json').projects['mcp-workbench'].architect.build.builder).toBe('@angular/build:application');
    expect(runner.tasks).toHaveLength(0);
    expect(original.exists('/mcp/main.ts')).toBe(false);
  });
  it('is idempotent, and schedules npm installation only when requested', async () => {
    const { runner, tree, local } = await integrated(); const before = new Map(tree.files.map(file => [file, tree.readContent(file)]));
    const again = await runner.runSchematic('ng-add', { project: 'existing', local, skipInstall: true }, tree);
    expect(new Map(again.files.map(file => [file, again.readContent(file)]))).toEqual(before);
    expect(again.readContent('/src/app/app.config.ts').match(/provideMcpBridge\(/g)).toHaveLength(1);
    await runner.runSchematic('ng-add', { project: 'existing', local }, again);
    expect(runner.tasks).toHaveLength(1); expect(runner.tasks[0].name).toBe('node-package');
  });
  it('checks the actual root provider list and recognizes an existing aliased bridge provider', async () => {
    const { runner, tree, local } = await existing();
    tree.create('/src/unused-provider.ts', "import { provideMcpBridge } from '@angular-mcp-bridge/angular'; export const unused = provideMcpBridge();\n");
    const integrated = await runner.runSchematic('ng-add', { local, skipInstall: true }, tree.branch());
    expect(integrated.readContent('/src/app/app.config.ts')).toContain('provideMcpBridge({ name: "existing" })');
    tree.overwrite('/src/app/app.config.ts', "import { ApplicationConfig } from '@angular/core';\nimport { provideMcpBridge as existingBridge } from '@angular-mcp-bridge/angular';\nconst bridgeProviders = [existingBridge({ name: 'already-connected' })];\nexport const appConfig: ApplicationConfig = { providers: [...bridgeProviders] };\n");
    const alreadyConfigured = await runner.runSchematic('ng-add', { local, skipInstall: true }, tree.branch());
    expect(alreadyConfigured.readContent('/src/app/app.config.ts')).toBe(tree.readContent('/src/app/app.config.ts'));
  });
  it('scopes ESM to the server, repairs older integrations and preserves conflicting module configuration', async () => {
    const { runner, tree, local } = await existing(); const pkg = readJson(tree, '/package.json'); pkg.type = 'commonjs'; tree.overwrite('/package.json', JSON.stringify(pkg));
    const current = await runner.runSchematic('ng-add', { local, skipInstall: true }, tree.branch());
    expect(readJson(current, '/package.json').type).toBe('commonjs'); expect(readJson(current, '/mcp/package.json').type).toBe('module');
    current.delete('/mcp/package.json'); const repaired = await runner.runSchematic('ng-add', { project: 'existing', local, skipInstall: true }, current.branch());
    expect(readJson(repaired, '/mcp/package.json').type).toBe('module');
    current.create('/mcp/package.json', '{"type":"commonjs","custom":true}'); await expect(runner.runSchematic('ng-add', { project: 'existing', local, skipInstall: true }, current.branch())).rejects.toThrow('conflicting module type');
    expect(current.readContent('/mcp/package.json')).toBe('{"type":"commonjs","custom":true}');
  });
  it('generates a typed vertical slice using Angular application builders and literal view names', async () => {
    const { runner, tree: initial } = await integrated();
    const tree = await runner.runSchematic('view', { name: 'reports', tool: 'show_reports', port: 4310 }, initial.branch());
    expect(readJson(tree, '/views/reports/view.json')).toMatchObject({ name: 'reports', project: 'reports', devPort: 4310 });
    expect(readJson(tree, '/angular.json').projects.reports.architect.build.builder).toBe('@angular/build:application');
    expect(tree.readContent('/mcp/features/show_reports/contract.ts')).toContain('view: "reports" satisfies ViewName');
    expect(tree.readContent('/mcp/features/show_reports/handler.ts')).toContain('ToolHandlers<{ "show_reports":');
    expect(tree.readContent('/apps/reports/src/app.ts')).toContain('client.info("show_reports")');
    expect(tree.readContent('/apps/reports/src/app.ts')).toContain('{{ result.output.message }}');
    expect(tree.readContent('/apps/reports/src/app.ts')).not.toContain('JsonPipe');
    expect(tree.readContent('/mcp/tools.ts')).toContain('"show_reports": tool_');
    expect(tree.readContent('/mcp/handlers.ts')).toContain('"show_reports": handler_');
    expect(tree.readContent('/generated/view-names.ts')).toContain('["existing","reports"] as const');
    expect(initial.exists('/views/reports/view.json')).toBe(false);
  });
  it('adds data-only and view-bound tools without replacing customized registry entries', async () => {
    const { runner, tree: initial } = await integrated();
    initial.overwrite('/mcp/handlers.ts', initial.readContent('/mcp/handlers.ts').replace('export const handlers = {', '// Keep this custom registration\nexport const handlers = {'));
    let tree = await runner.runSchematic('tool', { name: 'search' }, initial);
    expect(tree.readContent('/mcp/features/search/contract.ts')).not.toContain('view:');
    expect(tree.readContent('/mcp/handlers.ts')).toContain('// Keep this custom registration');
    tree = await runner.runSchematic('tool', { name: 'refresh_existing', view: 'existing' }, tree);
    expect(tree.readContent('/mcp/features/refresh_existing/contract.ts')).toContain('view: "existing" satisfies ViewName');
    await expect(runner.runSchematic('tool', { name: 'unknown_view', view: 'absent' }, tree)).rejects.toThrow('Unknown view');
  });
  it('refuses project/tool/path collisions and preserves the input tree when generation fails', async () => {
    const { runner, tree } = await integrated(); const before = new Map(tree.files.map(file => [file, tree.readContent(file)]));
    await expect(runner.runSchematic('view', { name: 'existing' }, tree)).rejects.toThrow('already exists');
    await expect(runner.runSchematic('view', { name: 'reports', tool: 'open_existing' }, tree)).rejects.toThrow('already registered');
    await expect(runner.runSchematic('view', { name: '../outside' }, tree)).rejects.toThrow('lowercase letter');
    tree.create('/apps/reports/custom.txt', 'keep me');
    await expect(runner.runSchematic('view', { name: 'reports' }, tree)).rejects.toThrow('Refusing to overwrite');
    expect(tree.readContent('/apps/reports/custom.txt')).toBe('keep me');
    expect(tree.exists('/mcp/features/open_reports/contract.ts')).toBe(false);
    for (const [file, content] of before) expect(tree.readContent(file)).toBe(content);
  });
  it('checks tools in the active server import graph and ignores unrelated test fixtures', async () => {
    const { runner, tree } = await integrated();
    tree.create('/mcp/manual-contracts.ts', "import { defineTools, defineTool } from '@angular-mcp-bridge/contracts'; export const manual = defineTools({ existing_manual: defineTool({}) });\n");
    tree.overwrite('/mcp/main.ts', "import { manual } from './manual-contracts.js';\n" + tree.readContent('/mcp/main.ts'));
    tree.create('/tests/sample.ts', "import { defineTools } from '@angular-mcp-bridge/contracts'; const fixture = defineTools({ sample_only: {} });\n");
    await expect(runner.runSchematic('tool', { name: 'existing_manual' }, tree.branch())).rejects.toThrow('already defined');
    const generated = await runner.runSchematic('tool', { name: 'sample_only' }, tree.branch()); expect(generated.exists('/mcp/features/sample_only/contract.ts')).toBe(true);
  });
  it('rejects ambiguous existing workspaces and missing local tarballs without replacing the app', async () => {
    const { runner, tree, local } = await existing();
    await rm(join(local, 'dist/tarballs/angular-mcp-bridge-server-0.1.4.tgz'));
    await expect(runner.runSchematic('ng-add', { local, skipInstall: true }, tree)).rejects.toThrow('Missing angular-mcp-bridge-server');
    expect(tree.exists('/bridge.config.json')).toBe(false);
    const multiple = await runner.runExternalSchematic('@schematics/angular', 'application', { name: 'second', projectRoot: 'apps/second', standalone: true, skipInstall: true, skipTests: true }, tree);
    await expect(runner.runSchematic('ng-add', { skipInstall: true }, multiple)).rejects.toThrow('--project');
  });
  it('provides an idempotent ng-update migration and preserves unknown config versions', async () => {
    const runner = new SchematicTestRunner('@angular-mcp-bridge/cli', resolve('packages/cli/schematics/migrations.json'));
    const original = new HostTree(); original.create('/bridge.config.json', JSON.stringify({ native: { contracts: 'mcp/tools.ts', handlers: 'mcp/handlers.ts' }, custom: 'preserved' })); original.create('/package.json', JSON.stringify({ scripts: { test: 'custom' } }));
    const tree = await runner.runSchematic('native-config-v1', {}, original);
    expect(readJson(tree, '/bridge.config.json')).toMatchObject({ version: 1, custom: 'preserved', native: { directory: 'mcp/features' } });
    expect(readJson(tree, '/package.json').scripts).toEqual({ test: 'custom', 'mcp:doctor': 'angular-mcp-bridge doctor' });
    const again = await runner.runSchematic('native-config-v1', {}, tree); expect(again.readContent('/bridge.config.json')).toBe(tree.readContent('/bridge.config.json'));
    original.overwrite('/bridge.config.json', '{"version":2}'); await expect(runner.runSchematic('native-config-v1', {}, original)).rejects.toThrow('Unknown bridge config version');
  });
});
