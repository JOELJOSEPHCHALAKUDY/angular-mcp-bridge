import { cp, mkdir, readFile, readdir, rename, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, basename, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = resolve(packageRoot, 'templates/angular');
function within(parent, child) { const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith(`..${sep}`)); }

/** This check deliberately runs before a local framework build or package install. */
export async function assertEmptyDestination(target) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('A target folder is required. Example: npm run create -- ../my-angular-app');
  const directory = resolve(target);
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new Error(`Target folder is a symbolic link: ${directory}. Choose a new directory.`);
    if (!info.isDirectory()) throw new Error(`Target path is not a directory: ${directory}`);
    if ((await readdir(directory)).length) throw new Error(`Target folder is not empty: ${directory}. Choose a new or empty directory.`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return directory;
}

export function shellArgument(value) {
  return /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}
export function creationInstructions(directory, installed = false) {
  return `Created ${directory}\n\nNext:\n  cd ${shellArgument(directory)}\n${installed ? '' : '  npm install\n'}  npm run dev\n\nDev builds the initial Angular resources and prints the workbench and MCP URLs.\nFor setup diagnostics: npm run doctor`;
}

export async function createProject(target, local) {
  const directory = await assertEmptyDestination(target);
  const version = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')).version;
  const manifest = JSON.parse(await readFile(resolve(template, 'package.json'), 'utf8'));
  manifest.name = basename(directory).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'angular-mcp-app';
  const packages = [];
  let source;
  if (local) {
    // Local mode: install the framework from prepared tarballs in a framework checkout.
    source = resolve(local, 'dist/tarballs');
    if (within(template, directory) || within(source, directory)) throw new Error('Choose a target outside the scaffold template and framework tarballs.');
    let tarballs;
    try { tarballs = await readdir(source); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Framework packages are not prepared. From the framework checkout, use npm run create -- ../my-angular-app.'); throw error; }
    for (const name of ['angular', 'contracts', 'server']) {
      const file = `angular-mcp-bridge-${name}-${version}.tgz`;
      if (!tarballs.includes(file)) throw new Error(`Missing ${file}. From the framework checkout, use npm run create -- ../my-angular-app to build and pack automatically.`);
      packages.push(file);
      manifest.dependencies[`@angular-mcp-bridge/${name}`] = `file:vendor/${file}`;
    }
    for (const name of ['cli', 'testing']) {
      const file = `angular-mcp-bridge-${name}-${version}.tgz`;
      if (tarballs.includes(file)) { packages.push(file); manifest.devDependencies[`@angular-mcp-bridge/${name}`] = `file:vendor/${file}`; }
    }
  } else {
    // Registry mode: the packages are published, so install them by version.
    if (within(template, directory)) throw new Error('Choose a target outside the scaffold template.');
    for (const name of ['angular', 'contracts', 'server']) manifest.dependencies[`@angular-mcp-bridge/${name}`] = version;
    for (const name of ['cli', 'testing']) manifest.devDependencies[`@angular-mcp-bridge/${name}`] = version;
  }
  // Prepare away from the destination, then publish the complete directory.
  // rename refuses a nonempty directory created while preparation was running.
  await mkdir(dirname(directory), { recursive: true });
  const stagingRoot = await mkdtemp(resolve(dirname(directory), `.${basename(directory)}-bridge-`));
  const staging = resolve(stagingRoot, 'app');
  try {
    await cp(template, staging, { recursive: true, force: false, errorOnExist: true });
    await rename(resolve(staging, '_gitignore'), resolve(staging, '.gitignore'));
    if (packages.length) await mkdir(resolve(staging, 'vendor'), { recursive: true });
    for (const file of packages) {
      const path = resolve(source, file); if (!(await lstat(path)).isFile()) throw new Error(`Framework tarball is not a regular file: ${file}`);
      await cp(path, resolve(staging, 'vendor', file), { force: false, errorOnExist: true });
    }
    await writeFile(resolve(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    await assertEmptyDestination(directory);
    await rename(staging, directory);
  } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  return directory;
}
