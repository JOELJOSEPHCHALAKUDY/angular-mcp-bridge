import type { CallToolResult } from '@modelcontextprotocol/client';
/** Tool result _meta belongs to the UI and is excluded from every model/judge/transcript payload. */
export function publicResult(result: CallToolResult) {
  return { content: result.content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}), ...(result.isError ? { isError: true } : {}) };
}
