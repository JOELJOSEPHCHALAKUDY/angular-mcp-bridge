import '@angular/compiler';
import { DOCUMENT } from '@angular/common';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, TestComponentRenderer } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { describe, expect, it } from 'vitest';
import { parseSchemaInput, SchemaFieldComponent, SchemaFormComponent, schemaDefaults, schemaInputKind, validateSchemaValue, type JsonSchema } from '../apps/workbench/src/schema-form.js';
import { inputSchemaDigest, SavedInputStore } from '../apps/workbench/src/saved-inputs.js';

const schema: JsonSchema = { type: 'object', additionalProperties: false, required: ['enabled', 'limit', 'filter', 'tags'], properties: {
  enabled: { type: 'boolean', default: true }, limit: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
  filter: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 2 }, status: { type: 'string', enum: ['ready', 'blocked'], default: 'ready' } }, required: ['query'] },
  tags: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true, maxItems: 3 }, optional: { type: 'string' },
} };
const valid = { enabled: true, limit: 3, filter: { query: 'angular', status: 'ready' }, tags: ['mcp'] };
describe('Angular schema input form', () => {
  it('identifies recursive widgets and keeps unsupported schema branches in JSON', () => {
    expect(['string', 'integer', 'number', 'boolean', 'array', 'object'].map(type => schemaInputKind({ type }))).toEqual(['string', 'integer', 'number', 'boolean', 'array', 'object']);
    expect(schemaInputKind({ type: 'string', enum: ['a', 'b'] })).toBe('enum');
    for (const unsupported of [{ oneOf: [{ type: 'string' }, { type: 'number' }] }, { type: ['null', 'string'] }, { $ref: '#/$defs/input' }, {}]) expect(schemaInputKind(unsupported)).toBe('json');
  });
  it('uses defaults and required fields without silently adding optional fields', () => {
    expect(schemaDefaults(schema)).toEqual({ enabled: true, limit: 3, filter: { query: '', status: 'ready' }, tags: [] });
    const source = { type: 'object', default: { values: [1] } }, first = schemaDefaults(source) as { values: number[] };
    first.values.push(2); expect(schemaDefaults(source)).toEqual({ values: [1] });
  });
  it('accepts nested values and rejects wrong types, required omissions, numeric limits and unknown properties', () => {
    expect(validateSchemaValue(schema, valid)).toEqual([]);
    expect(parseSchemaInput(schema, JSON.stringify(valid))).toEqual(valid);
    const errors = validateSchemaValue(schema, { enabled: 'yes', limit: 2.5, filter: { status: 'wrong', extra: true }, tags: ['', 'x', 'x'], unexpected: 1 });
    expect(errors.join('\n')).toContain('$.enabled: expected boolean');
    expect(errors.join('\n')).toContain('$.limit: expected integer');
    expect(errors.join('\n')).toContain('missing required field query');
    expect(errors.join('\n')).toContain('choose one'); expect(errors.join('\n')).toContain('unknown field');
    expect(errors.join('\n')).toContain('items must be unique'); expect(errors.join('\n')).toContain('at least 1 characters');
    expect(() => parseSchemaInput(schema, JSON.stringify({ ...valid, limit: 11 }))).toThrow('maximum');
  });
  it('validates JSON fallback unions and local references without fetching external references', () => {
    const references: JsonSchema = { type: 'object', properties: { id: { $ref: '#/$defs/id' }, value: { oneOf: [{ type: 'string', minLength: 2 }, { type: 'integer', minimum: 0 }] } }, required: ['id', 'value'], $defs: { id: { type: 'string', pattern: '^item-' } } };
    expect(validateSchemaValue(references, { id: 'item-1', value: 4 })).toEqual([]);
    expect(validateSchemaValue(references, { id: 'wrong', value: false }).join('\n')).toContain('oneOf');
    expect(validateSchemaValue({ $ref: 'https://example.com/schema' }, {}).join('\n')).toContain('external references');
    expect(validateSchemaValue({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1).join('\n')).toContain('oneOf');
  });
  it('resolves a recursive field against its enclosing tool schema and keeps its full error path', () => {
    const root: JsonSchema = { type: 'object', properties: { label: { $ref: '#/$defs/text' } }, $defs: { text: { type: 'string', minLength: 2 } } };
    const child = (root['properties'] as Record<string, JsonSchema>)['label'];
    expect(validateSchemaValue(child, 'Angular', { rootSchema: root, path: '$.label' })).toEqual([]);
    expect(validateSchemaValue(child, 'x', { rootSchema: root, path: '$.label' })).toEqual(['$.label: needs at least 2 characters']);
    const escaped: JsonSchema = { $defs: { 'a/b~c': { type: 'integer' } } };
    expect(validateSchemaValue({ $ref: '#/$defs/a~1b~0c' }, 3, { rootSchema: escaped })).toEqual([]);
  });
  it('handles string patterns, array bounds, optional removal and malformed JSON as validation errors', () => {
    expect(() => parseSchemaInput(schema, '[]')).toThrow('JSON object');
    expect(() => parseSchemaInput(schema, '{broken')).toThrow();
    expect(validateSchemaValue({ type: 'number', multipleOf: 0.1 }, 0.3)).toEqual([]);
    expect(validateSchemaValue({ type: 'string', minLength: 1, maxLength: 1 }, '😀')).toEqual([]);
    expect(validateSchemaValue({ type: 'string', pattern: '[' }, 'x').join('\n')).toContain('pattern is invalid');
    expect(validateSchemaValue({ type: 'array', minItems: 1 }, []).join('\n')).toContain('at least');
    expect(validateSchemaValue(schema, { ...valid, optional: undefined }).join('\n')).toContain('expected string');
    expect(validateSchemaValue({ type: 'array', uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]).join('\n')).toContain('unique');
    expect(validateSchemaValue({ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 })).toEqual([]);
  });
  it('does not publish a valid-looking parent draft while a nested JSON parser is invalid', () => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
    try {
      TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), { provide: DOCUMENT, useValue: {} }, { provide: TestComponentRenderer, useValue: { insertRootElement() {}, removeAllRootElements() {} } }] });
      const field = TestBed.runInInjectionContext(() => new SchemaFieldComponent());
      const form = TestBed.runInInjectionContext(() => new SchemaFormComponent());
      Object.assign(field, { schema: signal({ anyOf: [{ type: 'object' }, { type: 'null' }] }), value: signal({ selected: 1 }) });
      Object.assign(form, { schema: signal(schema), value: signal(valid) });
      const published: unknown[] = [], validity: boolean[] = [];
      field.validityChange.subscribe(value => form.fieldValidity.set(value));
      form.valueChange.subscribe(value => published.push(value)); form.validityChange.subscribe(value => validity.push(value));
      field.json('{broken');
      form.change({ ...valid, limit: 5 });
      TestBed.tick();
      expect(field.valid()).toBe(false); expect(form.valid()).toBe(false); expect(published).toEqual([]); expect(validity).toContain(false);
      field.json('{"selected":2}');
      TestBed.tick();
      expect(field.valid()).toBe(true); expect(form.valid()).toBe(true); expect(published).toEqual([{ ...valid, limit: 5 }]);
    } finally { TestBed.resetTestingModule(); TestBed.resetTestEnvironment(); }
  });
});
function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
describe('named workbench inputs', () => {
  it('scopes named inputs to tool and stable schema digest, validates values and replaces an existing name', async () => {
    const storage = memoryStorage(), store = new SavedInputStore(storage);
    await store.save('search', schema, '  Ready  ', valid);
    await store.save('search', schema, 'Ready', { ...valid, limit: 5 });
    expect((await store.list('search', schema)).map(entry => [entry.name, entry.arguments.limit])).toEqual([['Ready', 5]]);
    expect(await store.list('another', schema)).toEqual([]);
    expect(await store.list('search', { ...schema, description: 'new schema' })).toEqual([]);
    await expect(store.save('search', schema, 'Bad', { ...valid, enabled: 'yes' })).rejects.toThrow('boolean');
    await store.remove('search', schema, 'Ready'); expect(await store.list('search', schema)).toEqual([]);
  });
  it('produces the same schema hash when object property order differs', async () => {
    expect(await inputSchemaDigest({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'boolean' } } })).toBe(await inputSchemaDigest({ properties: { b: { type: 'boolean' }, a: { type: 'string' } }, type: 'object' }));
  });
  it('recovers malformed/oversized storage and skips persisted invalid arguments', async () => {
    const storage = memoryStorage(), store = new SavedInputStore(storage);
    await store.save('search', schema, 'Ready', valid);
    const key = [...storage.data.keys()][0], envelope = JSON.parse(storage.data.get(key)!); envelope.entries[0].arguments.limit = 50;
    storage.data.set(key, JSON.stringify(envelope)); expect(await store.list('search', schema)).toEqual([]);
    storage.data.set(key, '{broken'); expect(await store.list('search', schema)).toEqual([]);
    storage.data.set(key, ' '.repeat(101)); expect(await new SavedInputStore(storage, { maxBytes: 100 }).list('search', schema)).toEqual([]);
  });
  it('bounds retained entries and reports quota failures without claiming a successful save', async () => {
    const store = new SavedInputStore(memoryStorage(), { maxEntries: 2 });
    await store.save('search', schema, 'One', valid); await store.save('search', schema, 'Two', valid); await store.save('search', schema, 'Three', valid);
    expect((await store.list('search', schema)).map(entry => entry.name)).toEqual(['Three', 'Two']);
    const broken = new SavedInputStore({ getItem: () => null, setItem: () => { throw new Error('Quota'); } });
    await expect(broken.save('search', schema, 'Ready', valid)).rejects.toThrow('could not persist');
    await expect(new SavedInputStore(undefined).save('search', schema, 'Ready', valid)).rejects.toThrow('unavailable');
    await expect(new SavedInputStore(memoryStorage(), { maxBytes: 10 }).save('search', schema, 'Ready', valid)).rejects.toThrow('size limit');
  });
});
