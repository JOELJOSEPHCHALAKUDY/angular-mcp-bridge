import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBridgeServer, serveBridge } from '@angular-mcp-bridge/server';
import { demoOptions } from '../examples/server/app.js';
let directory: string, htmlPath: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'angular-mcp-tests-')); htmlPath = join(directory, 'view.html'); await writeFile(htmlPath, '<html><body>Angular view</body></html>'); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function connect() {
  const server = await createBridgeServer(demoOptions(htmlPath));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [first, second] = InMemoryTransport.createLinkedPair();
  await server.connect(second); await client.connect(first);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}
describe('MCP server contract', () => {
  it('registers annotated typed tools and a view resource', async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools(); expect(tools).toHaveLength(2);
      const render = tools.find(tool => tool.name === 'list_projects')!;
      expect(render.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      const uri = (render._meta?.['ui'] as { resourceUri: string }).resourceUri;
      const resource = await client.readResource({ uri });
      expect(resource.contents[0].mimeType).toBe('text/html;profile=mcp-app');
      expect(resource.contents[0]._meta?.['ui']).toMatchObject({ csp: { connectDomains: [], resourceDomains: [] } });
      const result = await client.callTool({ name: 'list_projects', arguments: { status: 'ready' } });
      expect(result.structuredContent).toMatchObject({ total: 4, filter: 'ready', projects: [{ id: 'atlas' }] });
    } finally { await close(); }
  });
  it('rejects invalid input and reports missing data', async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: 'get_project', arguments: { id: 'missing' } }); expect(result.isError).toBe(true);
      expect((await client.callTool({ name: 'list_projects', arguments: { status: 'broken' } })).isError).toBe(true);
    } finally { await close(); }
  });
  it('versions resource URIs by bundled content', async () => {
    const first = await connect(); const original = (await first.client.listResources()).resources[0].uri; await first.close();
    await writeFile(htmlPath, '<html><body>New view</body></html>');
    const second = await connect(); expect((await second.client.listResources()).resources[0].uri).not.toBe(original); await second.close();
  });
  it('fails clearly when a tool references a missing view', async () => {
    const options = demoOptions(htmlPath); options.views = {};
    await expect(createBridgeServer(options)).rejects.toThrow('unregistered view');
  });
  it('serves real Streamable HTTP and rejects disallowed origins and hosts', async () => {
    const instance = await serveBridge(demoOptions(htmlPath), { port: 0 });
    const address = instance.server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const url = `http://127.0.0.1:${address.port}`;
    const client = new Client({ name: 'http-test', version: '1' });
    try {
      expect((await fetch(`${url}/health`)).status).toBe(200);
      expect((await fetch(`${url}/health`, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
      const hostStatus = await new Promise<number | undefined>((resolve, reject) => { get(`${url}/health`, { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); });
      expect(hostStatus).toBe(403);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      expect((await client.listTools()).tools).toHaveLength(2);
      const result = await client.callTool({ name: 'get_project', arguments: { id: 'atlas' } });
      expect(result.structuredContent).toMatchObject({ project: { name: 'Atlas workspace' } });
    } finally { await client.close(); await instance.close(); }
  });
});
