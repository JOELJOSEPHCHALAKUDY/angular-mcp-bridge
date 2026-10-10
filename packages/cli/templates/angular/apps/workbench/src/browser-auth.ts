import { Injectable, signal } from '@angular/core';
import { auth, type OAuthClientProvider, type OAuthClientMetadata, type StoredOAuthTokens, type StoredOAuthClientInformation, type OAuthDiscoveryState } from '@modelcontextprotocol/client';

type IssuerContext = { issuer: string };
interface SavedAuth {
  publicClientId?: string;
  clients?: Record<string, StoredOAuthClientInformation>;
  tokens?: Record<string, StoredOAuthTokens>;
  lastIssuer?: string;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  state?: string;
}
/** Public browser client: credentials stay in one tab and are scoped to the MCP endpoint and issuer. */
export class BrowserOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  private readonly key: string;
  constructor(readonly serverUrl: URL, redirectUrl: URL, private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly navigate: (url: URL) => void, preRegisteredId?: string) {
    this.redirectUrl = redirectUrl.href;
    this.key = 'angular-mcp-workbench:oauth:' + serverUrl.href;
    if (preRegisteredId !== undefined) this.setPublicClientId(preRegisteredId);
  }
  get clientMetadata(): OAuthClientMetadata {
    return { redirect_uris: [this.redirectUrl], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: 'Angular MCP Workbench' };
  }
  private read(): SavedAuth {
    try { const parsed: unknown = JSON.parse(this.storage.getItem(this.key) ?? '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SavedAuth : {}; }
    catch { return {}; }
  }
  private update(change: (saved: SavedAuth) => void) { const saved = this.read(); change(saved); this.storage.setItem(this.key, JSON.stringify(saved)); }
  setPublicClientId(clientId?: string) {
    const value = clientId?.trim() || undefined;
    if (this.read().publicClientId === value) return;
    this.invalidateCredentials('all');
    if (value) this.update(saved => { saved.publicClientId = value; });
  }
  publicClientId() { return this.read().publicClientId; }
  clientInformation(context?: IssuerContext): StoredOAuthClientInformation | undefined {
    const saved = this.read(); const issuer = context?.issuer ?? saved.lastIssuer;
    const publicClientId = saved.publicClientId;
    return (issuer ? saved.clients?.[issuer] : undefined) ?? (publicClientId ? { client_id: publicClientId } : undefined);
  }
  saveClientInformation(info: StoredOAuthClientInformation, context?: IssuerContext) {
    if (info.client_secret) throw new Error('The workbench requires a public OAuth client with no client secret.');
    const issuer = context?.issuer ?? this.read().lastIssuer ?? 'legacy';
    this.update(saved => { saved.lastIssuer = issuer; saved.clients = { ...saved.clients, [issuer]: info }; });
  }
  tokens(context?: IssuerContext): StoredOAuthTokens | undefined {
    const saved = this.read(); return saved.tokens?.[context?.issuer ?? saved.lastIssuer ?? 'legacy'];
  }
  saveTokens(tokens: StoredOAuthTokens, context?: IssuerContext) {
    const issuer = context?.issuer ?? this.read().lastIssuer ?? 'legacy';
    this.update(saved => { saved.lastIssuer = issuer; saved.tokens = { ...saved.tokens, [issuer]: tokens }; });
  }
  state() {
    const existing = this.read().state; if (existing) return existing;
    const state = crypto.randomUUID(); this.update(saved => { saved.state = state; }); return state;
  }
  validateState(state: string | null) {
    const expected = this.read().state;
    if (!expected || state !== expected) { this.invalidateCredentials('verifier'); throw new Error('OAuth state mismatch. Start sign-in again in this tab.'); }
  }
  redirectToAuthorization(url: URL) {
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('OAuth authorization requires HTTPS or local development.');
    this.navigate(url);
  }
  saveCodeVerifier(verifier: string) { this.update(saved => { saved.verifier = verifier; }); }
  codeVerifier() { const verifier = this.read().verifier; if (!verifier) throw new Error('No PKCE verifier was saved in this tab. Start sign-in again.'); return verifier; }
  saveDiscoveryState(discovery: OAuthDiscoveryState) { this.update(saved => { saved.discovery = discovery; }); }
  discoveryState() { return this.read().discovery; }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all') { this.storage.removeItem(this.key); return; }
    this.update(saved => {
      if (scope === 'client') delete saved.clients;
      if (scope === 'tokens') delete saved.tokens;
      if (scope === 'discovery') delete saved.discovery;
      if (scope === 'verifier') { delete saved.verifier; delete saved.state; }
    });
  }
}

@Injectable({ providedIn: 'root' })
export class WorkbenchAuth {
  readonly signedIn = signal(false);
  readonly busy = signal(false);
  private provider?: BrowserOAuthProvider;
  private clientId = '';
  configure(clientId: string) { this.getProvider().setPublicClientId(clientId); this.clientId = clientId.trim(); this.provider = undefined; this.signedIn.set(false); }
  getProvider() {
    if (!this.provider) {
      const redirect = new URL(window.location.pathname, window.location.origin); redirect.searchParams.set('oauth_callback', 'true');
      this.provider = new BrowserOAuthProvider(new URL('/mcp', window.location.origin), redirect, window.sessionStorage, url => window.location.assign(url.href), this.clientId || undefined);
    }
    this.signedIn.set(!!this.provider.tokens()); return this.provider;
  }
  async signIn() {
    const provider = this.getProvider(); provider.invalidateCredentials('verifier');
    this.busy.set(true);
    try { await auth(provider, { serverUrl: provider.serverUrl }); this.signedIn.set(!!provider.tokens()); }
    finally { this.busy.set(false); }
  }
  async finishCallback() {
    const url = new URL(window.location.href); if (url.searchParams.get('oauth_callback') !== 'true') return;
    const provider = this.getProvider(); this.busy.set(true);
    try {
      provider.validateState(url.searchParams.get('state'));
      if (url.searchParams.has('error')) throw new Error('OAuth authorization was declined or failed.');
      const code = url.searchParams.get('code'); if (!code) throw new Error('OAuth callback has no authorization code.');
      await auth(provider, { serverUrl: provider.serverUrl, authorizationCode: code, iss: url.searchParams.get('iss') ?? undefined });
      this.signedIn.set(!!provider.tokens());
    } finally {
      provider.invalidateCredentials('verifier'); this.busy.set(false);
      // Remove authorization codes from browser history and subsequent request referrers.
      window.history.replaceState(null, '', window.location.pathname);
    }
  }
  signOut() { this.getProvider().invalidateCredentials('all'); this.signedIn.set(false); }
}
