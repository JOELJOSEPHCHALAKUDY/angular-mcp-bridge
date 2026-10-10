import { parseSchemaInput, type JsonSchema } from './schema-form.js';

export interface SavedToolInput { tool: string; schemaDigest: string; name: string; arguments: Record<string, unknown>; savedAt: string }
export type SavedInputStorage = Pick<Storage, 'getItem' | 'setItem'>;
const storageKey = 'angular-mcp-bridge:saved-inputs:v1';
function browserStorage(): SavedInputStorage | undefined { try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; } }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function inputSchemaDigest(schema: JsonSchema): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(schema)));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Named tool arguments only; this store does not read results or OAuth credentials. */
export class SavedInputStore {
  constructor(private readonly storage: SavedInputStorage | undefined = browserStorage(), private readonly options: { maxEntries?: number; maxBytes?: number } = {}) {
    if (options.maxEntries !== undefined && (!Number.isInteger(options.maxEntries) || options.maxEntries < 1 || options.maxEntries > 1000)) throw new RangeError('maxEntries must be between 1 and 1000.');
    if (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes < 1)) throw new RangeError('maxBytes must be positive.');
  }
  private read(): SavedToolInput[] {
    try {
      const text = this.storage?.getItem(storageKey);
      if (!text || new TextEncoder().encode(text).length > (this.options.maxBytes ?? 1_000_000)) return [];
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('entries' in parsed) || !Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter((entry): entry is SavedToolInput => !!entry && typeof entry === 'object' && typeof entry.tool === 'string' && typeof entry.name === 'string' && entry.name.length > 0 && entry.name.length <= 100 && /^[a-f0-9]{64}$/.test(entry.schemaDigest) && typeof entry.savedAt === 'string' && Number.isFinite(Date.parse(entry.savedAt)) && entry.arguments && typeof entry.arguments === 'object' && !Array.isArray(entry.arguments)).slice(-(this.options.maxEntries ?? 100));
    } catch { return []; }
  }
  private write(entries: SavedToolInput[]): void {
    if (!this.storage) throw new Error('Browser storage is unavailable. Export a fixture instead.');
    const text = JSON.stringify({ version: 1, entries: entries.slice(-(this.options.maxEntries ?? 100)) });
    if (new TextEncoder().encode(text).length > (this.options.maxBytes ?? 1_000_000)) throw new Error('Saved inputs exceed the storage size limit.');
    try { this.storage.setItem(storageKey, text); } catch { throw new Error('The browser could not persist the saved input. Export a fixture instead.'); }
  }
  async list(tool: string, schema: JsonSchema): Promise<SavedToolInput[]> {
    const digest = await inputSchemaDigest(schema);
    return this.read().filter(entry => entry.tool === tool && entry.schemaDigest === digest).flatMap(entry => {
      try { return [{ ...entry, arguments: parseSchemaInput(schema, JSON.stringify(entry.arguments)) }]; } catch { return []; }
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  async save(tool: string, schema: JsonSchema, name: string, args: Record<string, unknown>): Promise<SavedToolInput> {
    const trimmed = name.trim();
    if (!tool.trim() || !trimmed || trimmed.length > 100) throw new Error('Saved inputs need a tool and a name between 1 and 100 characters.');
    const validated = parseSchemaInput(schema, JSON.stringify(args));
    const digest = await inputSchemaDigest(schema);
    const entry: SavedToolInput = { tool, schemaDigest: digest, name: trimmed, arguments: validated, savedAt: new Date().toISOString() };
    const entries = this.read().filter(item => !(item.tool === tool && item.schemaDigest === digest && item.name === trimmed));
    this.write([...entries, entry]);
    return entry;
  }
  async remove(tool: string, schema: JsonSchema, name: string): Promise<void> {
    const digest = await inputSchemaDigest(schema);
    this.write(this.read().filter(entry => !(entry.tool === tool && entry.schemaDigest === digest && entry.name === name)));
  }
}
