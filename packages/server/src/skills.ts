import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { McpServer, ProtocolError, INVALID_PARAMS } from '@modelcontextprotocol/server';

export const SKILLS_EXTENSION_KEY = 'io.modelcontextprotocol/skills';
export interface SkillResource { uri: string; digest: string; content: string }
export interface Skill { uri: string; frontmatter: { name: string; description: string; [key: string]: unknown }; resources: SkillResource[] }
export type SkillsManifest = Skill[];
export interface SkillDiscoveryOptions { maxFiles?: number; maxFileBytes?: number; maxDepth?: number }
/** Reads Markdown from immediate skill directories only. Symlinks, binaries, and executable files are excluded. */
export async function discoverSkills(directory: string, options: SkillDiscoveryOptions = {}): Promise<SkillsManifest> {
  const maxFiles = options.maxFiles ?? 500, maxBytes = options.maxFileBytes ?? 256 * 1024, maxDepth = options.maxDepth ?? 8;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const manifest: SkillsManifest = []; let count = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue;
    const files = new Map<string, string>();
    const scan = async (relative: string, depth: number) => {
      if (depth > maxDepth) throw new Error(`Skill discovery exceeds depth limit ${maxDepth}.`);
      for (const child of await readdir(join(directory, entry.name, relative), { withFileTypes: true })) {
        if (child.isSymbolicLink() || child.name.startsWith('.')) continue;
        const name = relative ? `${relative}/${child.name}` : child.name;
        if (child.isDirectory()) await scan(name, depth + 1);
        else if (child.isFile() && child.name.toLowerCase().endsWith('.md')) {
          if (++count > maxFiles) throw new Error(`Skill discovery exceeds file limit ${maxFiles}.`);
          const path = join(directory, entry.name, name);
          if ((await stat(path)).size > maxBytes) throw new Error(`Skill resource exceeds ${maxBytes} bytes: ${name}`);
          files.set(name, await readFile(path, 'utf8'));
        }
      }
    };
    await scan('', 0);
    const source = files.get('SKILL.md'); if (!source) continue;
    const yaml = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (!yaml) throw new Error(`Skill ${entry.name} has no YAML frontmatter.`);
    const document = parseDocument(yaml[1]);
    if (document.errors.length) throw new Error(`Skill ${entry.name} has invalid YAML frontmatter.`);
    const metadata = document.toJS({ maxAliasCount: 25 }) as Record<string, unknown>;
    if (metadata?.['name'] !== entry.name || typeof metadata['description'] !== 'string' || !metadata['description'].trim() || metadata['description'].length > 1024) throw new Error(`Skill ${entry.name} needs a matching name and a non-empty description.`);
    manifest.push({ uri: `skill://${entry.name}/SKILL.md`, frontmatter: metadata as Skill['frontmatter'],
      resources: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => ({ uri: `skill://${entry.name}/${name.split('/').map(encodeURIComponent).join('/')}`, content, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` })) });
  }
  return manifest;
}
export function registerSkills(server: McpServer, manifest: SkillsManifest): void {
  const skills = new Map<string, Skill>(); const files = new Map<string, SkillResource>();
  for (const skill of manifest) {
    if (skills.has(skill.uri)) throw new Error(`Duplicate skill: ${skill.uri}`);
    skills.set(skill.uri, skill);
    for (const resource of skill.resources) {
      if (files.has(resource.uri)) throw new Error(`Duplicate skill resource: ${resource.uri}`);
      files.set(resource.uri, resource);
      server.registerResource(`${skill.frontmatter.name}:${resource.uri.split('/').at(-1)}`, resource.uri, { description: skill.frontmatter.description, mimeType: 'text/markdown' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: resource.content }] }));
    }
  }
  const wire = (skill: Skill) => ({ uri: skill.uri, frontmatter: skill.frontmatter, resources: skill.resources.map(({ uri, digest }) => ({ uri, digest })) });
  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_KEY]: { directoryRead: true } } });
  server.server.setRequestHandler('skills/list', { params: z.object({ cursor: z.string().optional() }).optional() }, () => ({ skills: manifest.map(wire) }));
  server.server.setRequestHandler('skills/get', { params: z.object({ uri: z.string() }) }, params => {
    const skill = skills.get(params.uri); if (!skill) throw new ProtocolError(INVALID_PARAMS, 'Unknown skill URI.'); return { skill: wire(skill) };
  });
  server.server.setRequestHandler('resources/directory/read', { params: z.object({ uri: z.string(), cursor: z.string().optional() }) }, params => {
    const prefix = `${params.uri.replace(/\/+$/, '')}/`;
    let decoded: string;
    try { decoded = decodeURIComponent(params.uri); } catch { throw new ProtocolError(INVALID_PARAMS, 'Invalid skill directory URI.'); }
    if (!/^skill:\/\/[a-z0-9-]+(?:\/[^?#]*)?$/.test(params.uri) || decoded.split('/').some(part => part === '..' || part === '.')) throw new ProtocolError(INVALID_PARAMS, 'Invalid skill directory URI.');
    const children = new Map<string, { uri: string; name: string; mimeType: string }>();
    for (const uri of files.keys()) {
      if (!uri.startsWith(prefix)) continue;
      const rest = uri.slice(prefix.length), segment = rest.split('/')[0];
      children.set(segment, { uri: `${prefix}${segment}`, name: decodeURIComponent(segment), mimeType: rest.includes('/') ? 'inode/directory' : 'text/markdown' });
    }
    if (!children.size) throw new ProtocolError(INVALID_PARAMS, 'Unknown skill directory.');
    return { resources: [...children.values()] };
  });
}
