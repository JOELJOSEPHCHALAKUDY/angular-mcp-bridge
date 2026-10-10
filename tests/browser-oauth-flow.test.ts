import '@angular/compiler';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { auth } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserOAuthProvider, WorkbenchAuth } from '../apps/workbench/src/browser-auth.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

/** A loopback IdP verifies real SDK PKCE requests; no production credentials are used. */
async function mockIssuer() {
  let origin = '';
  let sequence = 0;
  const codes = new Map<string, URLSearchParams>();
  const refreshClients = new Map<string, string>();
  const tokenRequests: URLSearchParams[] = [];
  const registrations: Record<string, unknown>[] = [];
  const clients = new Set(['public-client', 'replacement-client']);
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
  };
  const readBody = async (request: IncomingMessage) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString();
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        json(response, 200, { resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['notes:read'] }); return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        json(response, 200, {
          issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register',
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'], scopes_supported: ['notes:read', 'offline_access'], authorization_response_iss_parameter_supported: true,
        }); return;
      }
      if (url.pathname === '/register' && request.method === 'POST') {
        const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>; registrations.push(metadata);
        if (metadata['token_endpoint_auth_method'] !== 'none') { json(response, 400, { error: 'invalid_client_metadata' }); return; }
        const clientId = 'registered-' + ++sequence; clients.add(clientId); json(response, 201, { ...metadata, client_id: clientId }); return;
      }
      if (url.pathname === '/authorize') {
        if (!clients.has(url.searchParams.get('client_id') ?? '') || url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('state')) {
          json(response, 400, { error: 'invalid_request' }); return;
        }
        const code = 'code-' + ++sequence; codes.set(code, url.searchParams);
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', code); callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('iss', origin);
        response.writeHead(302, { location: callback.href }); response.end(); return;
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const params = new URLSearchParams(await readBody(request)); tokenRequests.push(params);
        if (request.headers.authorization || params.has('client_secret') || params.get('resource') !== origin + '/mcp') { json(response, 400, { error: 'invalid_request' }); return; }
        const clientId = params.get('client_id') ?? '';
        if (params.get('grant_type') === 'authorization_code') {
          const code = params.get('code') ?? ''; const offered = codes.get(code); codes.delete(code);
          const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
          if (!offered || offered.get('client_id') !== clientId || offered.get('code_challenge') !== challenge || offered.get('redirect_uri') !== params.get('redirect_uri')) {
            json(response, 400, { error: 'invalid_grant' }); return;
          }
        } else if (params.get('grant_type') === 'refresh_token') {
          if (refreshClients.get(params.get('refresh_token') ?? '') !== clientId) { json(response, 400, { error: 'invalid_grant' }); return; }
        } else { json(response, 400, { error: 'unsupported_grant_type' }); return; }
        const suffix = ++sequence; const refreshToken = 'refresh-' + suffix; refreshClients.set(refreshToken, clientId);
        json(response, 200, { access_token: 'access-' + suffix, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 600, scope: 'notes:read offline_access' }); return;
      }
      json(response, 404, { error: 'not_found' });
    })().catch(error => json(response, 500, { error: String(error) }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback address.');
  origin = 'http://127.0.0.1:' + address.port;
  return {
    origin, tokenRequests, registrations,
    async callback(authorization: URL) {
      const response = await fetch(authorization, { redirect: 'manual' }); expect(response.status).toBe(302);
      return new URL(response.headers.get('location')!);
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('browser OAuth with the official MCP auth orchestrator', () => {
  it('discovers scopes and persists a public client, PKCE and issuer across redirect/reload, then refreshes', async () => {
    const issuer = await mockIssuer();
    try {
      const storage = memoryStorage(); const navigate = vi.fn();
      const endpoint = new URL(issuer.origin + '/mcp'); const redirect = new URL(issuer.origin + '/?oauth_callback=true');
      const provider = new BrowserOAuthProvider(endpoint, redirect, storage, navigate, 'public-client');
      expect(await auth(provider, { serverUrl: endpoint })).toBe('REDIRECT');
      const authorization = navigate.mock.calls[0]![0] as URL;
      expect(authorization.searchParams.get('client_id')).toBe('public-client');
      expect(authorization.searchParams.get('scope')).toBe('notes:read offline_access');
      expect(authorization.searchParams.get('resource')).toBe(endpoint.href);
      expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorization.searchParams.get('code_challenge')).not.toBe(provider.codeVerifier());
      expect(issuer.registrations).toHaveLength(0);
      const callback = await issuer.callback(authorization);
      const reloaded = new BrowserOAuthProvider(endpoint, redirect, storage, navigate);
      reloaded.validateState(callback.searchParams.get('state'));
      expect(await auth(reloaded, { serverUrl: endpoint, authorizationCode: callback.searchParams.get('code')!, iss: callback.searchParams.get('iss')! })).toBe('AUTHORIZED');
      expect(reloaded.clientInformation({ issuer: issuer.origin })?.client_id).toBe('public-client');
      expect(reloaded.tokens()).toMatchObject({ issuer: issuer.origin, scope: 'notes:read offline_access' });
      expect(reloaded.tokens({ issuer: 'https://another-issuer.example' })).toBeUndefined();
      expect(new BrowserOAuthProvider(new URL(issuer.origin + '/other/mcp'), redirect, storage, navigate).tokens()).toBeUndefined();
      const firstAccess = reloaded.tokens()!.access_token; reloaded.invalidateCredentials('verifier');
      expect(await auth(reloaded, { serverUrl: endpoint })).toBe('AUTHORIZED');
      expect(reloaded.tokens()!.access_token).not.toBe(firstAccess); expect(navigate).toHaveBeenCalledTimes(1);
      expect(issuer.tokenRequests.map(params => params.get('grant_type'))).toEqual(['authorization_code', 'refresh_token']);
      reloaded.invalidateCredentials('all'); expect(reloaded.tokens()).toBeUndefined(); expect(reloaded.clientInformation()).toBeUndefined();
    } finally { await issuer.close(); }
  });

  it('dynamically registers a public client once and reloads it for the callback', async () => {
    const issuer = await mockIssuer();
    try {
      const storage = memoryStorage(); const navigate = vi.fn(); const endpoint = new URL(issuer.origin + '/mcp'); const redirect = new URL(issuer.origin + '/?oauth_callback=true');
      const provider = new BrowserOAuthProvider(endpoint, redirect, storage, navigate);
      await auth(provider, { serverUrl: endpoint });
      expect(issuer.registrations).toHaveLength(1); expect(issuer.registrations[0]).toMatchObject({ token_endpoint_auth_method: 'none', redirect_uris: [redirect.href], scope: 'notes:read offline_access' });
      const authorization = navigate.mock.calls[0]![0] as URL; const callback = await issuer.callback(authorization);
      const reloaded = new BrowserOAuthProvider(endpoint, redirect, storage, navigate); reloaded.validateState(callback.searchParams.get('state'));
      await auth(reloaded, { serverUrl: endpoint, authorizationCode: callback.searchParams.get('code')!, iss: issuer.origin });
      expect(reloaded.clientInformation()?.client_id).toBe(authorization.searchParams.get('client_id'));
      expect(reloaded.tokens()?.access_token).toMatch(/^access-/); expect(issuer.registrations).toHaveLength(1);
    } finally { await issuer.close(); }
  });

  it('rejects forged state and missing/mismatched callback issuers before sending the code', async () => {
    const issuer = await mockIssuer();
    try {
      const endpoint = new URL(issuer.origin + '/mcp'); const redirect = new URL(issuer.origin + '/?oauth_callback=true');
      const provider = new BrowserOAuthProvider(endpoint, redirect, memoryStorage(), vi.fn(), 'public-client');
      await auth(provider, { serverUrl: endpoint });
      await expect(auth(provider, { serverUrl: endpoint, authorizationCode: 'never-send-without-issuer' })).rejects.toThrow(/iss|issuer/i);
      await expect(auth(provider, { serverUrl: endpoint, authorizationCode: 'never-send-wrong-issuer', iss: 'https://forged.example' })).rejects.toThrow(/issuer/i);
      expect(() => provider.validateState('forged-state')).toThrow('state mismatch');
      expect(() => provider.codeVerifier()).toThrow('No PKCE'); expect(issuer.tokenRequests).toHaveLength(0);
      provider.invalidateCredentials('discovery');
      await expect(auth(provider, { serverUrl: endpoint, authorizationCode: 'no-persisted-flow', iss: issuer.origin })).rejects.toThrow(/discoveryState/);
      expect(issuer.tokenRequests).toHaveLength(0);
    } finally { await issuer.close(); }
  });

  it('switches explicit public client IDs without retaining registration or refresh tokens for the previous client', async () => {
    const issuer = await mockIssuer();
    try {
      const endpoint = new URL(issuer.origin + '/mcp'); const redirect = new URL(issuer.origin + '/?oauth_callback=true'); const storage = memoryStorage(); const navigate = vi.fn();
      const original = new BrowserOAuthProvider(endpoint, redirect, storage, navigate, 'public-client');
      await auth(original, { serverUrl: endpoint }); const callback = await issuer.callback(navigate.mock.calls[0]![0] as URL);
      original.validateState(callback.searchParams.get('state')); await auth(original, { serverUrl: endpoint, authorizationCode: callback.searchParams.get('code')!, iss: issuer.origin });
      const switched = new BrowserOAuthProvider(endpoint, redirect, storage, navigate, 'replacement-client');
      expect(switched.tokens()).toBeUndefined(); expect(switched.clientInformation({ issuer: issuer.origin })?.client_id).toBe('replacement-client');
      expect(await auth(switched, { serverUrl: endpoint })).toBe('REDIRECT');
      expect((navigate.mock.calls[1]![0] as URL).searchParams.get('client_id')).toBe('replacement-client');
      expect(issuer.tokenRequests).toHaveLength(1);
      switched.setPublicClientId(''); expect(switched.clientInformation()).toBeUndefined(); expect(switched.tokens()).toBeUndefined();
      expect(await auth(switched, { serverUrl: endpoint })).toBe('REDIRECT'); expect(issuer.registrations).toHaveLength(1);
      expect((navigate.mock.calls[2]![0] as URL).searchParams.get('client_id')).toMatch(/^registered-/);
    } finally { await issuer.close(); }
  });

  it('finishes the workbench callback after reload, scrubs history and signs out the current tab', async () => {
    const issuer = await mockIssuer();
    try {
      const navigate = vi.fn(); const replaceState = vi.fn(); const location = { origin: issuer.origin, pathname: '/', href: issuer.origin + '/', assign: navigate };
      vi.stubGlobal('window', { location, sessionStorage: memoryStorage(), history: { replaceState } });
      const first = new WorkbenchAuth(); first.configure('public-client'); await first.signIn();
      expect(first.busy()).toBe(false); expect(first.signedIn()).toBe(false);
      const callback = await issuer.callback(new URL(navigate.mock.calls[0]![0] as string)); location.href = callback.href;
      const reloaded = new WorkbenchAuth(); await reloaded.finishCallback();
      expect(reloaded.signedIn()).toBe(true); expect(reloaded.busy()).toBe(false);
      expect(reloaded.getProvider().clientInformation()?.client_id).toBe('public-client');
      expect(replaceState).toHaveBeenLastCalledWith(null, '', '/');
      reloaded.signOut(); expect(reloaded.signedIn()).toBe(false); expect(reloaded.getProvider().tokens()).toBeUndefined();
      expect(issuer.tokenRequests).toHaveLength(1); expect(navigate).toHaveBeenCalledTimes(1);
    } finally { await issuer.close(); }
  });
});
