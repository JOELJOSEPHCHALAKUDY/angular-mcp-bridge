import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const files = [];
async function addIfPresent(path) {
  try { if ((await stat(path)).isFile()) files.push(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function walk(path) {
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith('.md')) files.push(child);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await addIfPresent(resolve(root, 'README.md'));
await addIfPresent(resolve(root, 'llms.txt'));
await walk(resolve(root, 'docs'));
await walk(resolve(root, '.agents/skills'));
for (const name of ['angular', 'contracts', 'server', 'testing', 'cli']) await addIfPresent(resolve(root, 'packages', name, 'README.md'));
let checked = 0;
const failures = [];
const contents = new Map();
async function read(path) {
  if (!contents.has(path)) contents.set(path, await readFile(path, 'utf8'));
  return contents.get(path);
}
function headingAnchors(content) {
  const anchors = new Set(); const duplicates = new Map(); let fenced = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    const heading = !fenced && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = heading[1].replace(/<[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const suffix = duplicates.get(base) ?? 0;
    anchors.add(suffix ? `${base}-${suffix}` : base); duplicates.set(base, suffix + 1);
  }
  return anchors;
}
for (const file of files) {
  const content = await read(file);
  const links = [...content.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)].map(match => match[1] ?? match[2]);
  for (const link of links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
    const path = decodeURIComponent(link.split(/[?#]/)[0]);
    const target = !path ? file : path.startsWith('/') ? resolve(root, `.${path}`) : resolve(dirname(file), path);
    checked++;
    try {
      await stat(target);
      const fragment = link.includes('#') && decodeURIComponent(link.slice(link.indexOf('#') + 1));
      if (fragment && target.endsWith('.md') && !headingAnchors(await read(target)).has(fragment)) failures.push(`${relative(root, file)}: missing heading ${link}`);
    } catch { failures.push(`${relative(root, file)}: missing ${link}`); }
  }
}
if (failures.length) {
  console.error(`Documentation check failed (${failures.length} broken local links):\n${failures.join('\n')}`);
  process.exitCode = 1;
} else console.log(`Documentation check passed: ${files.length} files, ${checked} local links.`);
