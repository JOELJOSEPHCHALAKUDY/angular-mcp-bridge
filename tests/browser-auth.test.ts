import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';
import { BrowserOAuthProvider } from '../apps/workbench/src/browser-auth.js';

function fixture(endpoint = 'http://127.0.0.1:3000/mcp', storage = new Map<string, string>()) {
  const navigate = vi.fn();
  const provider = new BrowserOAuthProvider(new URL(endpoint), new URL('http://127.0.0.1:4200/?oauth_callback=true'), {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: key => { storage.delete(key); },
  }, navigate);
  return { provider, storage, navigate };
}
describe('browser OAuth provider', () => {
  it('binds credentials to endpoint and issuer while retaining per-request token lookup', () => {
    const { provider, storage } = fixture();
    provider.saveTokens({ access_token: 'first', token_type: 'Bearer' }, { issuer: 'https://issuer-a.example' });
    provider.saveTokens({ access_token: 'second', token_type: 'Bearer' }, { issuer: 'https://issuer-b.example' });
    expect(provider.tokens()?.access_token).toBe('second');
    expect(provider.tokens({ issuer: 'https://issuer-a.example' })?.access_token).toBe('first');
    expect(provider.tokens({ issuer: 'https://issuer-c.example' })).toBeUndefined();
    expect(fixture('http://127.0.0.1:3001/mcp', storage).provider.tokens()).toBeUndefined();
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none');
    expect(() => provider.saveClientInformation({ client_id: 'private', client_secret: 'secret' })).toThrow('public OAuth client');
  });
  it('requires a matching state and verifier, clears a failed flow and creates fresh state', () => {
    const { provider } = fixture(); const first = provider.state(); provider.saveCodeVerifier('verifier');
    expect(provider.state()).toBe(first); provider.validateState(first); expect(provider.codeVerifier()).toBe('verifier');
    expect(() => provider.validateState('forged')).toThrow('state mismatch');
    expect(() => provider.codeVerifier()).toThrow('No PKCE'); expect(provider.state()).not.toBe(first);
    provider.invalidateCredentials('all'); expect(() => provider.validateState(null)).toThrow('state mismatch');
  });
  it('rejects unsafe redirects and clears token state independently of client registration', () => {
    const { provider, navigate, storage } = fixture();
    provider.saveClientInformation({ client_id: 'public' }, { issuer: 'https://issuer.example' });
    provider.saveTokens({ access_token: 'token', token_type: 'Bearer' }, { issuer: 'https://issuer.example' });
    provider.invalidateCredentials('tokens'); expect(provider.tokens()).toBeUndefined(); expect(provider.clientInformation()?.client_id).toBe('public');
    expect(() => provider.redirectToAuthorization(new URL('javascript:alert(1)'))).toThrow('HTTPS');
    provider.redirectToAuthorization(new URL('https://issuer.example/authorize')); expect(navigate).toHaveBeenCalledTimes(1);
    provider.invalidateCredentials('all'); expect(storage.size).toBe(0);
  });
});
