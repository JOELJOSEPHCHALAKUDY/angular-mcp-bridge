import { describe, it, expect } from 'vitest';
import { parseFixture, serializeFixture, type WorkbenchFixture } from '../apps/workbench/src/fixtures.js';
const fixture: WorkbenchFixture = { version: 1, name: 'Projects', tool: 'list_projects', arguments: { status: 'ready' }, result: { content: [], structuredContent: { projects: [] }, _meta: { private: 'secret' } }, host: { profile: 'limited', locale: 'de-DE', theme: 'dark' } };
describe('workbench fixtures', () => {
  it('round-trips capabilities and initial data while redacting private metadata', () => { const text = serializeFixture(fixture); expect(text).not.toContain('secret'); expect(parseFixture(text)).toMatchObject({ arguments: fixture.arguments, host: fixture.host }); });
  it('rejects malformed results, unsupported versions and oversized input', () => {
    expect(() => parseFixture('{broken')).toThrow();
    expect(() => parseFixture(JSON.stringify({ ...fixture, version: 2 }))).toThrow();
    expect(() => parseFixture(JSON.stringify({ ...fixture, result: { content: [{ type: 'broken' }] } }))).toThrow();
    expect(() => parseFixture(' '.repeat(2_000_001))).toThrow('limit');
  });
});
