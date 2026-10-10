import { z } from 'zod';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { HostProfile } from './host-profiles.js';
const fixtureSchema = z.object({
  version: z.literal(1), name: z.string().min(1).max(200), tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()), result: CallToolResultSchema,
  host: z.object({ profile: z.enum(['standard', 'limited', 'chatgpt', 'claude', 'vscode']), locale: z.string().min(2).max(50), theme: z.enum(['light', 'dark']) }),
});
export interface WorkbenchFixture {
  version: 1; name: string; tool: string; arguments: Record<string, unknown>; result: CallToolResult;
  host: { profile: HostProfile; locale: string; theme: 'light' | 'dark' };
}
export function parseFixture(text: string): WorkbenchFixture {
  if (text.length > 2_000_000) throw new Error('Fixture exceeds the 2 MB limit.');
  return fixtureSchema.parse(JSON.parse(text)) as WorkbenchFixture;
}
/** Export initial data only; never iframe HTML or private server metadata. */
export function serializeFixture(fixture: WorkbenchFixture): string {
  const { _meta: privateMetadata, ...result } = fixture.result;
  return JSON.stringify(fixtureSchema.parse({ ...fixture, result }), null, 2);
}
