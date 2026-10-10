import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { z } from 'zod';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineTools, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';
import { createBridgeServer, createJwksVerifier, customProvider, auth0Provider, clerkProvider, workosProvider, stytchProvider, descopeProvider, authplaneProvider, evaluateSecuritySchemes, serveBridge, text, image, audio, embeddedResource, resourceLink, FileRef, discoverSkills, getViewManifest, requestFormInput, requestOpenAIFormInput, runMiddleware, defineEvent, createEventPublisher, deliverEvent, signWebhook, protectedResourceMetadataUrl, defineFileViewerTool, registerFileViewer, registerMentions, registerSettings, type BridgeServerOptions, type EventSubscription, type BridgeConstructionContext, type BridgeRequestContext } from '@angular-mcp-bridge/server';
import type { ServerContext } from '@modelcontextprotocol/server';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals(); });
const tools = defineTools({ secure: { title: 'Secure tool', description: 'Read account', input: z.object({ value: z.string().default('hello') }), output: z.object({ value: z.string() }), annotations: readOnlyAnnotations, securitySchemes: [{ type: 'oauth2', scopes: ['read'] }] },
  public: { title: 'Public tool', description: 'Anonymous access', input: z.object({}), output: z.object({ value: z.string() }), annotations: readOnlyAnnotations, securitySchemes: [{ type: 'noauth' }] } });
const identity = { token: 'test-token', clientId: 'client', scopes: ['read'], extra: { subject: 'alice' } };
const oauth = { resolve: async () => ({ resource: 'https://api.example/mcp', authorizationServers: ['https://auth.example'], scopes: ['read'], verifier: { verifyAccessToken: async () => identity } }) };
function options(): BridgeServerOptions<typeof tools> { return { name: 'extension-test', tools, views: {}, oauth, handlers: { secure: input => ({ data: input }), public: () => ({ data: { value: 'public' } }) } }; }
async function connect(config: BridgeServerOptions<any>, context: BridgeConstructionContext = {}, clientOptions: ConstructorParameters<typeof Client>[1] = {}) {
  const server = await createBridgeServer(config, context); const client = new Client({ name: 'extensions', version: '1' }, clientOptions);
  const [a, b] = InMemoryTransport.createLinkedPair(), outgoing: unknown[] = [];
  const send = b.send.bind(b); b.send = async (...args) => { outgoing.push(args[0]); return send(...args); };
  await server.connect(b); await client.connect(a);
  cleanups.push(async () => { await client.close(); await server.close(); }); return { server, client, outgoing };
}
async function keyFixture() {
  const { privateKey, publicKey } = await generateKeyPair('ES256'); const publicJwk = await exportJWK(publicKey); publicJwk.kid = 'test';
  const verifier = createJwksVerifier({ issuer: 'https://auth.example', audience: 'bridge', jwks: { keys: [publicJwk] } });
  const sign = (scope = 'read', audience = 'bridge', expiry = '1h') => new SignJWT({ scope, client_id: 'client' }).setProtectedHeader({ alg: 'ES256', kid: 'test' }).setIssuer('https://auth.example').setSubject('alice').setAudience(audience).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
  return { verifier, sign };
}
describe('OAuth identity and scoped tools', () => {
  it('discovers an exact trusted issuer, caches results and normalizes provider presets', async () => {
    const publicJwk = await exportJWK((await generateKeyPair('ES256')).publicKey);
    const document = { issuer: 'https://tenant.example/', authorization_endpoint: 'https://tenant.example/authorize', token_endpoint: 'https://tenant.example/token', jwks_uri: 'https://tenant.example/jwks', response_types_supported: ['code'], registration_endpoint: 'https://tenant.example/register' };
    const mockedFetch = vi.fn(async () => new Response(JSON.stringify(document), { headers: { 'content-type': 'application/json' } })); vi.stubGlobal('fetch', mockedFetch);
    const provider = customProvider({ issuer: 'https://tenant.example', resource: 'https://api.example/mcp' });
    expect((await provider.resolve()).authorizationServers).toEqual(['https://tenant.example/']); await provider.resolve(); expect(mockedFetch).toHaveBeenCalledOnce();
    const facade = await auth0Provider({ domain: 'tenant.example', resource: 'https://api.example/mcp', audience: 'api', jwks: { keys: [publicJwk] }, metadata: document }).resolve();
    expect(facade.authorizationServers).toEqual(['https://api.example']); expect(new URL(facade.authorizationMetadata!.authorization_endpoint).searchParams.get('audience')).toBe('api');
    const common = { resource: 'https://api.example/mcp', jwks: { keys: [publicJwk] } };
    for (const preset of [clerkProvider({ ...common, domain: 'tenant.example' }), workosProvider({ ...common, domain: 'tenant.example', audience: 'api' }), stytchProvider({ ...common, domain: 'tenant.example', audience: 'project' }), authplaneProvider({ ...common, issuer: 'https://tenant.example' })]) expect((await preset.resolve()).authorizationServers).toEqual(['https://tenant.example']);
    expect((await descopeProvider({ ...common, url: 'https://api.descope.com/v1/apps/agentic/project/server' }).resolve()).authorizationServers).toEqual(['https://api.descope.com/v1/apps/agentic/project/server']);
    expect(protectedResourceMetadataUrl('https://api.example/custom/path')).toBe('https://api.example/.well-known/oauth-protected-resource/custom/path');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...document, issuer: 'https://evil.example' }))));
    await expect(customProvider({ issuer: 'https://tenant.example', resource: 'https://api.example/mcp' }).resolve()).rejects.toThrow('trust anchor');
  });
  it('verifies signature, issuer, expiry and audience using a local JWKS', async () => {
    const { verifier, sign } = await keyFixture(); const auth = await verifier.verifyAccessToken(await sign('read write'));
    expect(auth.scopes).toEqual(['read', 'write']); expect(auth.extra?.['subject']).toBe('alice');
    await expect(verifier.verifyAccessToken(await sign('read', 'wrong'))).rejects.toThrow('invalid or expired');
    await expect(verifier.verifyAccessToken(await sign('read', 'bridge', '-1h'))).rejects.toThrow('invalid or expired');
    await expect(verifier.verifyAccessToken('tampered')).rejects.toThrow('invalid or expired');
  });
  it('ORs schemes, ANDs scopes and permits explicit noauth', () => {
    expect(evaluateSecuritySchemes([{ type: 'noauth' }, { type: 'oauth2', scopes: ['write'] }], undefined, true)).toBeUndefined();
    expect(evaluateSecuritySchemes([{ type: 'oauth2', scopes: ['write'] }, { type: 'oauth2', scopes: ['read'] }], identity, true)).toBeUndefined();
    expect(evaluateSecuritySchemes([{ type: 'oauth2', scopes: ['read', 'write'] }], identity, true)?.code).toBe('insufficient_scope');
    expect(evaluateSecuritySchemes([{ type: 'noauth' }, { type: 'oauth2', scopes: ['write'] }], identity, true)?.code).toBe('insufficient_scope');
  });
  it('denies before calling the handler and advertises an in-band auth challenge', async () => {
    const config = options(); const handler = vi.fn(config.handlers.secure); config.handlers.secure = handler;
    const { client } = await connect(config);
    expect((await client.callTool({ name: 'secure', arguments: {} }))._meta?.['mcp/www_authenticate']).toEqual([expect.stringContaining('resource_metadata=')]); expect(handler).not.toHaveBeenCalled();
    expect((await client.callTool({ name: 'public', arguments: {} })).structuredContent).toEqual({ value: 'public' });
    const authenticated = await connect(config, { authInfo: identity });
    expect((await authenticated.client.callTool({ name: 'secure', arguments: {} })).structuredContent).toEqual({ value: 'hello' });
    expect((await authenticated.client.listTools()).tools[0]._meta?.['securitySchemes']).toEqual(tools.secure.securitySchemes);
    expect(authenticated.outgoing).toContainEqual(expect.objectContaining({ result: expect.objectContaining({ tools: expect.arrayContaining([expect.objectContaining({ name: 'secure', securitySchemes: tools.secure.securitySchemes })]) }) }));
  });
  it('sanitizes HTTP context and does not expose credentials in convenient handler context', async () => {
    let seen: BridgeRequestContext | undefined; const config = options(); config.handlers.secure = (input, ctx) => { seen = ctx; return { data: input }; };
    const { client } = await connect(config, { authInfo: identity, requestInfo: new Request('https://api.example/mcp', { headers: { authorization: 'Bearer secret', cookie: 'session=secret', 'accept-language': 'de-DE,en', 'user-agent': 'host-agent' } }) });
    await client.callTool({ name: 'secure', arguments: {} });
    expect(seen?.auth).toMatchObject({ subject: 'alice', scopes: ['read'] }); expect(seen?.auth).not.toHaveProperty('token'); expect(seen?.http?.headers).not.toHaveProperty('authorization'); expect(seen?.http?.headers).not.toHaveProperty('cookie'); expect(seen?.locale).toBe('de-DE');
  });
  it('serves protected-resource discovery and rejects invalid bearer tokens over HTTP', async () => {
    const fixture = await keyFixture(); const config = options();
    config.oauth = { resolve: async () => ({ resource: 'https://api.example/mcp', authorizationServers: ['https://auth.example'], verifier: fixture.verifier }) };
    const running = await serveBridge(config, { port: 0 }); cleanups.push(() => running.close());
    const address = running.server.address(); if (!address || typeof address === 'string') throw new Error('No port'); const url = `http://127.0.0.1:${address.port}`;
    expect(await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json()).toMatchObject({ resource: 'https://api.example/mcp', authorization_servers: ['https://auth.example'] });
    const bad = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(401); expect(bad.headers.get('www-authenticate')).toContain('resource_metadata=');
    const client = new Client({ name: 'oauth', version: '1' }); cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await fixture.sign()}` } } }));
    expect((await client.callTool({ name: 'secure', arguments: {} })).structuredContent).toEqual({ value: 'hello' });
  });
});
describe('MCP middleware and extensions', () => {
  it('applies middleware around tools and custom resources with filters and telemetry', async () => {
    const calls: string[] = [], telemetry = vi.fn(); const config = options(); config.telemetry = telemetry;
    config.middleware = [{ filter: 'tools/*', handle: async (request, _ctx, next) => { calls.push(`before:${request.method}`); const result = await next(); calls.push(`after:${request.method}`); return result; } }];
    config.configure = server => { server.registerResource('text', 'bridge://text', { mimeType: 'text/plain' }, async uri => ({ contents: [{ uri: uri.href, text: 'resource' }] })); };
    const { client } = await connect(config, { authInfo: identity }); await client.callTool({ name: 'secure', arguments: {} }); await client.readResource({ uri: 'bridge://text' });
    expect(calls).toContain('before:tools/call'); expect(calls).toContain('after:tools/call'); expect(calls).not.toContain('before:resources/read');
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ method: 'resources/read', status: 'succeeded' }));
    config.handlers.secure = () => { throw new Error('observed failure'); }; const failed = await connect(config, { authInfo: identity }); await failed.client.callTool({ name: 'secure', arguments: {} });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ method: 'tools/call', status: 'failed', error: expect.any(Error) }));
  });
  it('rejects multiple next calls', async () => {
    await expect(runMiddleware([{ handle: async (_request, _ctx, next) => { await next(); return next(); } }], { method: 'tools/call', params: {}, notification: false }, undefined, async () => ({}))).rejects.toThrow('only be called once');
  });
  it('preserves custom and spec notification overloads and their validated arguments', async () => {
    const custom = vi.fn(), spec = vi.fn(), middleware = vi.fn(async (_request, _context, next: () => Promise<unknown>) => next());
    const config = options(); config.middleware = [{ filter: 'notification', handle: middleware }];
    config.configure = server => {
      server.server.setNotificationHandler('bridge/event', { params: z.object({ value: z.string().default('default') }) }, custom);
      server.server.setNotificationHandler('notifications/roots/list_changed', spec);
    };
    const { client } = await connect(config, {}, { capabilities: { roots: { listChanged: true } } });
    await client.notification({ method: 'bridge/event', params: { _meta: { application: 'test' } } });
    await client.notification({ method: 'notifications/roots/list_changed' });
    await vi.waitFor(() => { expect(custom).toHaveBeenCalledOnce(); expect(spec).toHaveBeenCalledOnce(); });
    expect(custom.mock.calls[0][0]).toEqual({ value: 'default' });
    expect(custom.mock.calls[0][1]).toMatchObject({ method: 'bridge/event', params: { _meta: { application: 'test' } } });
    expect(spec.mock.calls[0][0]).toMatchObject({ method: 'notifications/roots/list_changed' });
    expect(middleware).toHaveBeenCalledWith(expect.objectContaining({ method: 'bridge/event', notification: true }), undefined, expect.any(Function));
  });
  it('builds rich multimodal content and reports view manifests', async () => {
    const config = options(); config.views = { first: { html: '<html>one</html>', description: 'First', csp: { connectDomains: ['https://api.example'] }, permissions: { clipboardWrite: {} } }, second: { html: '<html>two</html>', description: 'Second' } };
    const { server, client } = await connect(config); expect(getViewManifest(server)).toHaveLength(2); expect(getViewManifest(server)[0].digest).toMatch(/^sha256:/);
    const resource = await client.readResource({ uri: getViewManifest(server)[0].uri }); expect(resource.contents[0]._meta?.['openai/widgetCSP']).toEqual({ connect_domains: ['https://api.example'], resource_domains: [] });
    expect([text('hello'), image(new Uint8Array([1, 2]), 'image/png'), audio('YWJj', 'audio/wav'), embeddedResource({ uri: 'bridge://text', text: 'embedded' }), resourceLink({ uri: 'bridge://text', name: 'text' })].map(block => block.type)).toEqual(['text', 'image', 'audio', 'resource', 'resource_link']);
    expect(FileRef.parse({ file_id: 'id', download_url: 'https://files.example/file' })).toHaveProperty('file_id', 'id');
  });
  it('discovers only controlled Markdown files and exposes skills and directory methods', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-skills-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'test-skill', 'docs'), { recursive: true }); await writeFile(join(directory, 'test-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: A test skill\n---\nUse this skill.'); await writeFile(join(directory, 'test-skill', 'docs', 'guide.md'), 'Guide'); await writeFile(join(directory, 'test-skill', 'secret.txt'), 'excluded'); await symlink('/etc/passwd', join(directory, 'test-skill', 'linked.md'));
    const skills = await discoverSkills(directory); expect(skills[0].resources).toHaveLength(2);
    const config = options(); config.skills = skills; const { client } = await connect(config);
    expect(client.getServerCapabilities()?.extensions?.['io.modelcontextprotocol/skills']).toEqual({ directoryRead: true });
    expect((await client.readResource({ uri: 'skill://test-skill/docs/guide.md' })).contents[0]).toHaveProperty('text', 'Guide');
    const listed = await client.request({ method: 'skills/list' }, z.object({ skills: z.array(z.object({ uri: z.string() })) })); expect(listed.skills[0].uri).toBe('skill://test-skill/SKILL.md');
    const children = await client.request({ method: 'resources/directory/read', params: { uri: 'skill://test-skill' } }, z.object({ resources: z.array(z.object({ name: z.string() })) })); expect(children.resources.map(resource => resource.name)).toEqual(expect.arrayContaining(['SKILL.md', 'docs']));
    await expect(client.request({ method: 'resources/directory/read', params: { uri: 'skill://test-skill/../' } }, z.object({}))).rejects.toThrow('Invalid skill directory');
    await expect(client.request({ method: 'resources/directory/read', params: { uri: 'skill://test-skill/%oops' } }, z.object({}))).rejects.toMatchObject({ code: -32602 });
  });
  it('elicits and validates a standard form through the official SDK retry flow', async () => {
    const config = options(); config.handlers.public = (_input, context) => {
      const result = requestFormInput(context.sdk, { key: 'confirmation', message: 'Name?', schema: z.object({ value: z.string().min(2) }) });
      return 'resultType' in result ? result : { data: { value: result.action === 'accept' ? result.content.value : result.action } };
    };
    const { client } = await connect(config, {}, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { value: 'accepted' } }));
    expect((await client.callTool({ name: 'public', arguments: {} })).structuredContent).toEqual({ value: 'accepted' });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'decline' }));
    expect((await client.callTool({ name: 'public', arguments: {} })).structuredContent).toEqual({ value: 'decline' });
  });
  it('gates rich OpenAI forms and rejects forged resource choices', async () => {
    const config = options(); let failure: unknown; config.handlers.public = async (_input, context) => { try { return await requestOpenAIFormInput(context.sdk, { key: 'file', message: 'Choose', requestedSchema: { type: 'object', properties: {} } }) as any; } catch (error) { failure = error; throw error; } };
    const { client } = await connect(config); expect((await client.callTool({ name: 'public', arguments: {} })).isError).toBe(true); expect(String(failure)).toContain('does not advertise');
    const sdk = { mcpReq: { envelope: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} }, extensions: { 'openai/elicitation': { form: {} } } } }, inputResponses: { file: { action: 'accept', content: { file: 'https://evil.example/file' } } } } } as unknown as ServerContext;
    const form = { type: 'object' as const, properties: { file: { type: 'string' as const, format: 'uri', 'x-openai-input': { type: 'resource', options: [{ uri: 'https://safe.example/file', name: 'file' }] } } }, required: ['file'] };
    await expect(requestOpenAIFormInput(sdk, { key: 'file', message: 'Choose', requestedSchema: form })).rejects.toThrow('not offered');
    sdk.mcpReq.inputResponses!['file'] = { action: 'accept', content: { file: 'https://safe.example/file' } };
    expect(await requestOpenAIFormInput(sdk, { key: 'file', message: 'Choose', requestedSchema: form })).toMatchObject({ action: 'accept', content: { file: 'https://safe.example/file' } });
  });
});
describe('Authenticated webhook events', () => {
  it('verifies callbacks, produces stable subscriptions, signs delivery and unsubscribes', async () => {
    const deliveries: { body: any; signature?: string; id?: string; timestamp?: string }[] = [];
    const callback = createServer((req, res) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { const data = JSON.parse(body); deliveries.push({ body: data, signature: req.headers['webhook-signature'] as string, id: req.headers['webhook-id'] as string, timestamp: req.headers['webhook-timestamp'] as string }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data.type === 'verification' ? { challenge: data.challenge } : {})); }); });
    await new Promise<void>(resolve => callback.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise<void>(resolve => callback.close(() => resolve())));
    const address = callback.address(); if (!address || typeof address === 'string') throw new Error('No port'); const url = `http://localhost:${address.port}/events`, delivery = { allowedOrigins: [new URL(url).origin], allowInsecureLocalhost: true };
    let subscription: EventSubscription | undefined; const unsubscribe = vi.fn();
    const event = defineEvent({ name: 'project.changed', input: z.object({ id: z.string() }), payload: z.object({ status: z.string() }), onSubscribe: (_input, context) => { subscription = context.subscription; }, onUnsubscribe: unsubscribe });
    const config = options(); config.events = { definitions: [event], delivery };
    const { server, client, outgoing } = await connect(config, { authInfo: identity }); const secret = `whsec_${randomBytes(32).toString('base64')}`;
    expect((server.server.getCapabilities() as { events?: object }).events).toEqual({});
    expect(outgoing).toEqual(expect.arrayContaining([expect.objectContaining({ result: expect.objectContaining({ capabilities: expect.objectContaining({ events: {} }) }) })]));
    const params = { name: event.name, arguments: { id: 'atlas' }, delivery: { url, secret } };
    await expect(client.request({ method: 'events/subscribe', params: { ...params, delivery: { url, secret: 'invalid' } } }, z.object({}))).rejects.toMatchObject({ code: -32602 });
    await expect(client.request({ method: 'events/subscribe', params: { ...params, arguments: { id: 3 } } }, z.object({}))).rejects.toMatchObject({ code: -32602 });
    expect(deliveries).toHaveLength(0);
    const first = await client.request({ method: 'events/subscribe', params }, z.object({ id: z.string() })); const second = await client.request({ method: 'events/subscribe', params: { ...params, ttlMs: null } }, z.object({ id: z.string() })); expect(second.id).toBe(first.id); expect(subscription!.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
    expect(await deliverEvent(subscription!, { name: event.name, id: 'event1', data: { status: 'ready' } }, delivery)).toEqual({ ok: true });
    expect(() => createEventPublisher(event, delivery)(subscription!, { id: 'invalid', data: { status: 5 } as any })).toThrow();
    const latest = deliveries.at(-1)!; expect(latest.body).toMatchObject({ eventId: 'event1', name: event.name, data: { status: 'ready' } });
    const signedBody = JSON.stringify(latest.body); const expected = `v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${latest.id}.${latest.timestamp}.${signedBody}`).digest('base64')}`; expect(latest.signature).toBe(expected);
    await client.request({ method: 'events/unsubscribe', params: { name: event.name, arguments: { id: 'atlas' }, delivery: { url } } }, z.object({})); expect(unsubscribe).toHaveBeenCalledOnce();
    const anonymous = await connect(config); await expect(anonymous.client.request({ method: 'events/subscribe', params }, z.object({}))).rejects.toThrow('authenticated');
  });
  it('rejects untrusted/private callbacks and skips expired deliveries', async () => {
    const subscription = { id: 'sub', url: 'https://127.0.0.1/events', secret: `whsec_${randomBytes(32).toString('base64')}`, expiresAt: new Date(Date.now() + 1000) };
    await expect(deliverEvent(subscription, { name: 'test', id: '1', data: {} }, { allowedOrigins: ['https://127.0.0.1'] })).rejects.toThrow('Private');
    expect(await deliverEvent({ ...subscription, expiresAt: new Date(0) }, { name: 'test', id: '1', data: {} }, { allowedOrigins: [] })).toMatchObject({ ok: false, reason: 'expired', retryable: false });
    expect(signWebhook(subscription.secret, '1', 1, '{}')).toMatch(/^v1,/);
  });
});
describe('ChatGPT entrypoints, mentions and settings', () => {
  it('validates shared entrypoints and emits the exact tool/resource metadata split', async () => {
    const file = defineFileViewerTool({ title: 'Viewer', description: 'File viewer', view: 'viewer', extensions: ['.txt'], output: z.object({ name: z.string() }), annotations: readOnlyAnnotations, openai: { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' } });
    const entryTools = defineTools({ file, home: { title: 'Home', description: 'Home view', view: 'home', input: z.object({}), output: z.object({}), annotations: readOnlyAnnotations,
      openai: { entrypoints: [{ type: 'global', quickAction: { title: 'Home', icons: [{ src: 'https://icons.example/home.svg' }], target: { type: 'tool', name: 'home', arguments: {} } } }], preferredModelDisplayMode: 'fullscreen' } } });
    const config: BridgeServerOptions<typeof entryTools> = { name: 'entrypoints', tools: entryTools, views: { viewer: { html: '<html>file</html>', description: 'Viewer' }, home: { html: '<html>home</html>', description: 'Home' } }, handlers: { file: input => ({ data: { name: input.file.name } }), home: () => ({ data: {} }) } };
    const { client, server } = await connect(config); const list = (await client.listTools()).tools;
    expect(list.find(tool => tool.name === 'file')?._meta?.['openai/ui']).toEqual({ entrypoints: [{ type: 'file', extensions: ['.txt'] }] });
    const resource = await client.readResource({ uri: getViewManifest(server).find(view => view.name === 'viewer')!.uri });
    expect(resource.contents[0]._meta?.['openai/ui']).toEqual({ availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' });
    expect((await client.callTool({ name: 'file', arguments: { file: { name: 'notes.txt', resourceUri: 'bridge://notes' } } })).structuredContent).toEqual({ name: 'notes.txt' });
    const invalid = { ...config, tools: { ...entryTools, home: { ...entryTools.home, input: z.object({ required: z.string() }) } } } as BridgeServerOptions<any>;
    await expect(createBridgeServer(invalid)).rejects.toThrow('requires arguments');
    expect(() => defineFileViewerTool({ ...file, extensions: ['txt'] })).toThrow('File extensions');
  });
  it('registers a view-linked file viewer and hidden mentions search with validated results', async () => {
    const config = options(); config.views = { files: { html: '<html>files</html>', description: 'Files' } };
    config.configure = server => {
      registerFileViewer(server, { name: 'open_file', resourceUri: getViewManifest(server)[0].uri, extensions: ['.txt'], output: z.object({ name: z.string() }) }, input => ({ data: { name: input.file.name } }));
      registerMentions(server, { name: 'search_mentions', handler: ({ query }) => ({ items: [resourceLink({ uri: `bridge://notes/${encodeURIComponent(query)}`, name: query || 'notes' })] }) });
    };
    const { client } = await connect(config, { authInfo: identity }); const list = (await client.listTools()).tools;
    expect(list.find(tool => tool.name === 'open_file')?._meta?.['openai/ui']).toEqual({ entrypoints: [{ type: 'file', extensions: ['.txt'] }] });
    expect(list.find(tool => tool.name === 'search_mentions')?._meta).toMatchObject({ 'openai/extensions': { 'mentions/search': {} }, ui: { visibility: ['app'] } });
    expect((await client.callTool({ name: 'search_mentions', arguments: { query: 'notes' } })).structuredContent).toMatchObject({ items: [{ type: 'resource_link', name: 'notes' }] });
    expect((await client.callTool({ name: 'open_file', arguments: { file: { name: 'notes.txt', resourceUri: 'bridge://notes' } } })).structuredContent).toEqual({ name: 'notes.txt' });
    const anonymous = await connect(config); expect((await anonymous.client.callTool({ name: 'search_mentions', arguments: { query: 'notes' } })).isError).toBe(true);
  });
  it('reads current settings, accepts changed fields only and rejects unknown or empty updates', async () => {
    let values: { units: 'mm' | 'in'; grid: boolean } = { units: 'mm', grid: true }; const updated = vi.fn(); const config = options();
    config.configure = server => registerSettings(server, { fields: { units: { title: 'Units', schema: z.enum(['mm', 'in']) }, grid: { title: 'Grid', schema: z.boolean() } }, layout: [{ kind: 'group', title: 'View', items: [{ kind: 'property', property: 'units' }, { kind: 'property', property: 'grid' }] }], read: () => values, update: set => { updated(set); values = { ...values, ...set }; return values; } });
    const { client } = await connect(config, { authInfo: identity }); expect(client.getServerCapabilities()?.extensions?.['openai/settings']).toEqual({ readTool: 'settings.read', updateTool: 'settings.update' });
    expect(client.getServerCapabilities()?.experimental?.['openai/settings']).toEqual({ readTool: 'settings.read', updateTool: 'settings.update' });
    expect((await client.callTool({ name: 'settings.read', arguments: {} })).structuredContent).toMatchObject({ values: { units: 'mm', grid: true }, schema: { additionalProperties: false } });
    expect((await client.callTool({ name: 'settings.update', arguments: { set: { grid: false } } })).structuredContent).toEqual({ values: { units: 'mm', grid: false } });
    expect(updated).toHaveBeenCalledWith({ grid: false });
    expect((await client.callTool({ name: 'settings.update', arguments: { set: {} } })).isError).toBe(true);
    expect((await client.callTool({ name: 'settings.update', arguments: { set: { secret: 'no' } } })).isError).toBe(true);
    expect(updated).toHaveBeenCalledOnce();
  });
  it('rejects nonprimitive/default settings and invalid layout before registration', async () => {
    for (const schema of [z.string().default('default'), z.array(z.string())]) {
      const config = options(); config.configure = server => registerSettings(server, { fields: { invalid: { title: 'Invalid', schema: schema as any } }, read: () => ({ invalid: '' }), update: () => ({ invalid: '' }) });
      await expect(createBridgeServer(config)).rejects.toThrow(/default|primitive/);
    }
    const config = options(); config.configure = server => registerSettings(server, { fields: { name: { title: 'Name', schema: z.string() } }, layout: [{ kind: 'group', title: 'Group', items: [{ kind: 'property', property: 'unknown' as any }] }], read: () => ({ name: 'name' }), update: () => ({ name: 'name' }) });
    await expect(createBridgeServer(config)).rejects.toThrow('unknown or duplicate');
  });
});
