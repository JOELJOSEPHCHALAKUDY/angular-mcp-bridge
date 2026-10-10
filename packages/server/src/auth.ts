import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import type { AuthInfo, OAuthMetadata } from '@modelcontextprotocol/server';
import type { SecurityScheme } from '@angular-mcp-bridge/contracts';

export interface TokenVerifier { verifyAccessToken(token: string): Promise<AuthInfo> }
export interface JwksVerifierOptions {
  issuer: string;
  /** Required for resource-bound tokens. Skip only when the provider does not issue aud. */
  audience?: string | string[];
  jwksUri?: string;
  jwks?: JSONWebKeySet | JWTVerifyGetKey;
  algorithms?: string[];
  clockTolerance?: number;
}
export class AuthenticationError extends Error {
  constructor(public readonly code: 'invalid_token' | 'insufficient_scope', message: string, public readonly scopes: string[] = []) { super(message); this.name = 'AuthenticationError'; }
}
export function createJwksVerifier(options: JwksVerifierOptions): TokenVerifier {
  if (!options.issuer) throw new Error('An issuer is required for JWT verification.');
  const key = typeof options.jwks === 'function' ? options.jwks : options.jwks
    ? createLocalJWKSet(options.jwks)
    : createRemoteJWKSet(new URL(options.jwksUri ?? `${options.issuer.replace(/\/$/, '')}/.well-known/jwks.json`), { timeoutDuration: 5000 });
  return { async verifyAccessToken(token) {
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(token, key, {
        issuer: options.issuer, audience: options.audience,
        algorithms: options.algorithms ?? ['RS256', 'ES256', 'EdDSA'],
        requiredClaims: ['exp', 'sub'], clockTolerance: options.clockTolerance ?? 5,
      }));
    } catch { throw new AuthenticationError('invalid_token', 'The access token is invalid or expired.'); }
    const rawScope = claims['scope'] ?? claims['scp'];
    const scopes = typeof rawScope === 'string' ? rawScope.split(/\s+/).filter(Boolean) : Array.isArray(rawScope) ? rawScope.filter((item): item is string => typeof item === 'string') : [];
    const { sub, exp, scope: _scope, scp: _scp, client_id, ...extra } = claims;
    return { token, clientId: typeof client_id === 'string' ? client_id : typeof claims['azp'] === 'string' ? claims['azp'] : sub ?? '', scopes, expiresAt: exp, extra: { ...extra, subject: sub } };
  } };
}
export interface ResolvedOAuth {
  resource: string;
  authorizationServers: string[];
  scopes?: string[];
  verifier: TokenVerifier;
  /** Served only when explicitly advertising this server as the authorization server. */
  authorizationMetadata?: OAuthMetadata;
}
export interface OAuthProvider { resolve(): Promise<ResolvedOAuth> }
export interface CustomProviderOptions extends JwksVerifierOptions {
  /** Public MCP resource URL; configured explicitly rather than trusting proxy headers. */
  resource: string;
  authorizationServer?: string;
  scopes?: string[];
  /** Optional OAuth metadata; endpoint overrides do not change JWT trust anchors. */
  metadata?: OAuthMetadata;
  /** Explicitly permit HTTP for a local development authorization server. */
  allowInsecureLocalhost?: boolean;
  /** Resource-bound audience checking is the default. Disable only for a provider that issues no aud, e.g. Clerk. */
  verifyAudience?: boolean;
}
function checkedUrl(value: string, local = false): URL {
  const url = new URL(value);
  if (url.hash || url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error(`OAuth URL must use HTTPS without credentials or a fragment: ${value}`);
  return url;
}
async function discover(issuer: string, local: boolean): Promise<{ issuer: string; jwks_uri: string; [key: string]: unknown }> {
  const expected = checkedUrl(issuer, local).href.replace(/\/$/, '');
  const url = new URL(expected);
  const paths = [new URL(`/.well-known/oauth-authorization-server${url.pathname === '/' ? '' : url.pathname}`, url.origin), new URL(`${expected}/.well-known/openid-configuration`)];
  for (const endpoint of paths) {
    let response: Response;
    try { response = await fetch(endpoint, { signal: AbortSignal.timeout(5000), redirect: 'error' }); } catch { continue; }
    if (!response.ok) continue;
    const document = await response.json() as Record<string, unknown>;
    if (typeof document['issuer'] !== 'string' || new URL(document['issuer']).href !== new URL(issuer).href) throw new Error('OAuth discovery issuer does not match the configured trust anchor.');
    if (typeof document['jwks_uri'] !== 'string') throw new Error('OAuth discovery has no jwks_uri.');
    checkedUrl(document['jwks_uri'], local);
    return document as { issuer: string; jwks_uri: string; [key: string]: unknown };
  }
  throw new Error(`Unable to discover OAuth metadata for ${issuer}`);
}
export function customProvider(options: CustomProviderOptions): OAuthProvider {
  checkedUrl(options.resource, options.allowInsecureLocalhost); checkedUrl(options.issuer, options.allowInsecureLocalhost);
  if (options.authorizationServer) checkedUrl(options.authorizationServer, options.allowInsecureLocalhost);
  let resolved: Promise<ResolvedOAuth> | undefined;
  return { resolve() {
    // Failure is retryable; successful discovery and key cache are reused across HTTP requests.
    return resolved ??= (async () => {
      const metadata = !options.jwks && !options.jwksUri ? await discover(options.issuer, !!options.allowInsecureLocalhost) : undefined;
      return { resource: options.resource, authorizationServers: [options.authorizationServer ?? metadata?.issuer ?? options.issuer], scopes: options.scopes,
        verifier: createJwksVerifier({ ...options, issuer: metadata?.issuer ?? options.issuer, audience: options.verifyAudience === false ? undefined : options.audience ?? options.resource, jwksUri: options.jwksUri ?? metadata?.jwks_uri }), authorizationMetadata: options.metadata };
    })().catch(error => { resolved = undefined; throw error; });
  } };
}
type DomainProviderOptions = Omit<CustomProviderOptions, 'issuer'> & { domain: string };
const domainIssuer = (domain: string) => new URL(domain.includes('://') ? domain : `https://${domain}`).href.replace(/\/$/, '');
/** Auth0 requires audience on the authorization URL; advertise a local AS metadata facade while verifying the actual tenant issuer. */
export function auth0Provider(options: DomainProviderOptions & { audience: string }): OAuthProvider {
  const issuer = domainIssuer(options.domain), advertisedIssuer = options.authorizationServer ?? new URL(options.resource).origin;
  const base = customProvider({ ...options, issuer, authorizationServer: advertisedIssuer });
  let resolved: Promise<ResolvedOAuth> | undefined;
  return { resolve() { return resolved ??= (async () => {
    const result = await base.resolve();
    const metadata = options.metadata ?? await discover(issuer, !!options.allowInsecureLocalhost) as unknown as OAuthMetadata;
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) throw new Error('Auth0 discovery must provide authorization and token endpoints.');
    const authorization = new URL(metadata.authorization_endpoint); authorization.searchParams.set('audience', options.audience);
    return { ...result, authorizationMetadata: { ...metadata, issuer: advertisedIssuer, authorization_endpoint: authorization.href } };
  })().catch(error => { resolved = undefined; throw error; }); } };
}
export function clerkProvider(options: Omit<DomainProviderOptions, 'audience'>): OAuthProvider { return customProvider({ ...options, issuer: domainIssuer(options.domain), verifyAudience: false }); }
export function workosProvider(options: DomainProviderOptions & { audience: string | string[] }): OAuthProvider { return customProvider({ ...options, issuer: domainIssuer(options.domain) }); }
export function stytchProvider(options: DomainProviderOptions & { audience: string }): OAuthProvider { return customProvider({ ...options, issuer: domainIssuer(options.domain) }); }
export function authplaneProvider(options: Omit<CustomProviderOptions, 'audience'> & { audience?: string }): OAuthProvider { return customProvider({ ...options, audience: options.audience ?? options.resource }); }
export function descopeProvider(options: Omit<CustomProviderOptions, 'issuer'> & { url: string }): OAuthProvider {
  const discovery = options.url.replace(/\/\.well-known\/[^?#]+$/, '').replace(/\/$/, '');
  const matched = /^(.*)\/agentic\/([^/]+)\/[^/]+$/.exec(discovery);
  if (!matched) throw new Error('Descope url must be an agentic MCP discovery URL.');
  return customProvider({ ...options, issuer: `${matched[1]}/${matched[2]}`, authorizationServer: options.authorizationServer ?? discovery, audience: options.audience ?? matched[2] });
}
export function evaluateSecuritySchemes(schemes: SecurityScheme[] | undefined, auth: AuthInfo | undefined, configuredOAuth: boolean): AuthenticationError | undefined {
  if (!schemes?.length) return configuredOAuth && !auth ? new AuthenticationError('invalid_token', 'Sign in to use this tool.') : undefined;
  if (!auth && schemes.some(scheme => scheme.type === 'noauth')) return undefined;
  const oauth = schemes.filter((scheme): scheme is Extract<SecurityScheme, { type: 'oauth2' }> => scheme.type === 'oauth2');
  if (!oauth.length) return undefined;
  const scopes = [...new Set(oauth.flatMap(scheme => scheme.scopes ?? []))];
  if (!auth) return new AuthenticationError('invalid_token', 'Sign in to use this tool.', scopes);
  if (!oauth.some(scheme => (scheme.scopes ?? []).every(scope => auth.scopes.includes(scope)))) return new AuthenticationError('insufficient_scope', 'The token lacks a scope required by this tool.', scopes);
  return undefined;
}
const headerValue = (value: string) => value.replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, ' ');
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  return new URL(`/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname}`, url.origin).href;
}
export function bearerChallenge(error: AuthenticationError, metadataUrl?: string): string {
  return `Bearer error="${error.code}", error_description="${headerValue(error.message)}"${error.scopes.length ? `, scope="${headerValue(error.scopes.join(' '))}"` : ''}${metadataUrl ? `, resource_metadata="${headerValue(metadataUrl)}"` : ''}`;
}
