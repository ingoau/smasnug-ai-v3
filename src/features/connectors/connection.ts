/**
 * A user's connection to one connector (docs/mcp-custom-connectors.md, "Auth"): one vault credential of kind
 * 'connector' named mcp.<slug>, meta { connector, auth }, holding either the API key or the OAuth state (client
 * registration, PKCE verifier, state, tokens). Also the MCP client for a call and the OAuth connect flow.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { auth, createMCPClient, type MCPClient, type OAuthClientInformation, type OAuthClientMetadata, type OAuthClientProvider, type OAuthTokens } from '@ai-sdk/mcp';
import { env } from '../../config.js';
import { log } from '../../log.js';
import { checkUrl } from '../../tools/safe-fetch.js';
import { getCredential, revealSecret, saveCredential, updateSecret, type Credential } from '../vault/store.js';
import type { ScrubSecret } from '../vault/scrub.js';
import { pinnedFetch } from './egress.js';
import { connectionName, type ConnectorDef, type EgressPolicy } from './logic.js';

export type ApiKeySecret = { type: 'api_key'; apiKey: string };
export interface OAuthSecret {
  type: 'oauth';
  tokens?: OAuthTokens;
  client?: OAuthClientInformation;
  clientDynamic?: boolean;
  verifier?: string;
  state?: string;
  stateAt?: number;
  /** Authorization-server / token-endpoint origins seen while connecting (allowed later for refreshes). */
  authOrigins?: string[];
  /** The sign-in link while a connect is pending. */
  authUrl?: string;
  [k: string]: unknown;
}
export type ConnSecret = ApiKeySecret | OAuthSecret;

export interface Connection {
  cred: Credential;
  secret: ConnSecret;
}

/** How long a pasted code may take after "Connect". */
export const OAUTH_PENDING_MS = 30 * 60 * 1000;
const LIST_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 20_000;

export class ConnectorError extends Error {}

export async function getConnection(ownerId: string, slug: string): Promise<Connection | null> {
  const cred = await getCredential(ownerId, connectionName(slug));
  if (!cred || cred.kind !== 'connector' || cred.meta.connector !== slug) return null;
  const secret = (await revealSecret({ ...cred, kind: 'connector' })) as unknown as ConnSecret;
  return { cred, secret };
}

/** Usable for calls: an API key, or OAuth tokens. */
export function isConnected(c: Connection | null | undefined): c is Connection {
  if (!c) return false;
  return c.secret.type === 'api_key' ? Boolean(c.secret.apiKey) : Boolean(c.secret.tokens?.access_token);
}

/** An OAuth connect is waiting for the pasted code. */
export function pendingAuthUrl(c: Connection | null | undefined): string | null {
  if (!c || c.secret.type !== 'oauth' || c.secret.tokens?.access_token || !c.secret.authUrl || !c.secret.stateAt) return null;
  return Date.now() - c.secret.stateAt < OAUTH_PENDING_MS ? c.secret.authUrl : null;
}

/** Strings to scrub out of anything the model or Slack sees. */
export function connectionSecrets(c: Connection): ScrubSecret[] {
  const name = c.cred.name;
  if (c.secret.type === 'api_key') return [{ name, value: c.secret.apiKey }];
  const t = c.secret.tokens;
  return [t?.access_token, t?.refresh_token, (c.secret.client as any)?.client_secret].filter((v): v is string => typeof v === 'string' && v.length > 0).map((value) => ({ name, value }));
}

function apiKeyHeaders(def: ConnectorDef, key: string): Record<string, string> {
  if (def.auth.type !== 'api_key') return {};
  const header = (def.auth.header || 'authorization').toLowerCase();
  const scheme = def.auth.scheme ?? (header === 'authorization' ? 'Bearer' : '');
  return { [header]: scheme ? `${scheme} ${key}` : key };
}

/**
 * OAuthClientProvider over a vault credential. Phase 'connect' (App Home Connect / pasted code) may start an
 * authorization; phase 'call' (a tool call or tool listing) only refreshes tokens: a needed sign-in sets `needsReauth`.
 */
export class VaultOAuthProvider implements OAuthClientProvider {
  authUrl: URL | null = null;
  needsReauth = false;
  constructor(
    private readonly cred: Pick<Credential, 'id' | 'ownerId'>,
    readonly secret: OAuthSecret,
    private readonly def: ConnectorDef,
    private readonly phase: 'connect' | 'call',
  ) {}

  get redirectUrl(): string {
    if (!env.MCP_OAUTH_REDIRECT_URL) throw new ConnectorError('OAuth is not set up on this bot (MCP_OAUTH_REDIRECT_URL).');
    return env.MCP_OAUTH_REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scopes = this.def.auth.type === 'oauth' ? this.def.auth.scopes : undefined;
    return {
      client_name: `${env.BOT_DISPLAY_NAME} (Slack)`,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
    } as OAuthClientMetadata;
  }

  async persist(): Promise<void> {
    await updateSecret<'connector'>(this.cred, this.secret as Record<string, unknown>);
  }

  tokens() {
    return this.secret.tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    this.secret.tokens = tokens;
    delete this.secret.verifier;
    delete this.secret.state;
    delete this.secret.stateAt;
    delete this.secret.authUrl;
    await this.persist();
  }
  redirectToAuthorization(url: URL) {
    if (this.phase === 'call') {
      this.needsReauth = true;
      return;
    }
    const checked = checkUrl(url.toString());
    if (checked.protocol !== 'https:') throw new ConnectorError('The sign-in page is not https.');
    this.authUrl = checked;
  }
  saveCodeVerifier(v: string) {
    this.secret.verifier = v;
  }
  codeVerifier() {
    if (!this.secret.verifier) throw new ConnectorError('No sign-in is in progress. Press Connect again.');
    return this.secret.verifier;
  }
  clientInformation() {
    return this.secret.client;
  }
  isClientInformationDynamicallyRegistered() {
    return this.secret.clientDynamic === true;
  }
  saveClientInformation(c: OAuthClientInformation) {
    this.secret.client = c;
    this.secret.clientDynamic = true;
  }
  validateAuthorizationServerURL(_server: string | URL, as: string | URL) {
    const u = checkUrl(String(as));
    if (u.protocol !== 'https:') throw new ConnectorError('The authorization server is not https.');
  }
  state() {
    return randomBytes(24).toString('base64url');
  }
  saveState(s: string) {
    this.secret.state = s;
    this.secret.stateAt = Date.now();
  }
  storedState() {
    return this.secret.state;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier') {
    if (scope === 'all' || scope === 'tokens') delete this.secret.tokens;
    if (scope === 'all' || scope === 'client') {
      delete this.secret.client;
      delete this.secret.clientDynamic;
    }
    if (scope === 'all' || scope === 'verifier') delete this.secret.verifier;
    if (this.phase === 'call' && (scope === 'all' || scope === 'tokens')) await this.persist();
  }
}

function policyFor(def: ConnectorDef, c: Connection | null, discovering: boolean): EgressPolicy {
  const authOrigins = new Set(c?.secret.type === 'oauth' ? (c.secret.authOrigins ?? []) : []);
  return { mcpOrigin: new URL(def.url).origin, authOrigins, discovering, seen: new Set() };
}

export interface OpenClient {
  client: MCPClient;
  provider: VaultOAuthProvider | null;
  close: () => Promise<void>;
}

/** An MCP client for one call (or one listing), over the pinned fetch. */
export async function openClient(def: ConnectorDef, c: Connection, o: { signal: AbortSignal; timeoutMs: number }): Promise<OpenClient> {
  const fetchFn = pinnedFetch(policyFor(def, c, false), { signal: o.signal, timeoutMs: o.timeoutMs });
  const provider = c.secret.type === 'oauth' ? new VaultOAuthProvider(c.cred, c.secret, def, 'call') : null;
  const client = await createMCPClient({
    transport: {
      type: 'http',
      url: def.url,
      ...(c.secret.type === 'api_key' ? { headers: apiKeyHeaders(def, c.secret.apiKey) } : {}),
      ...(provider ? { authProvider: provider } : {}),
      redirect: 'error',
      fetch: fetchFn,
    },
    protocolVersionDiscovery: false,
    initializationOptions: { signal: o.signal, timeout: Math.min(o.timeoutMs, LIST_TIMEOUT_MS) },
    maxRetries: 0,
    onUncaughtError: (err) => log.debug({ err, slug: def.slug }, 'mcp client error'),
  }).catch((err) => {
    if (provider?.needsReauth) throw new ConnectorError(`Your ${def.name} sign-in expired. Reconnect it in my App Home.`);
    throw err;
  });
  return { client, provider, close: () => client.close().catch(() => {}) };
}

/** Raw tool listing (first page; capped by the caller). */
export async function listServerTools(def: ConnectorDef, c: Connection, parent?: AbortSignal) {
  const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(LIST_TIMEOUT_MS)]) : AbortSignal.timeout(LIST_TIMEOUT_MS);
  const oc = await openClient(def, c, { signal, timeoutMs: LIST_TIMEOUT_MS });
  try {
    const res = await oc.client.listTools({ options: { signal, timeout: LIST_TIMEOUT_MS } });
    return res.tools;
  } catch (err) {
    if (oc.provider?.needsReauth) throw new ConnectorError(`Your ${def.name} sign-in expired. Reconnect it in my App Home.`);
    throw err;
  } finally {
    await oc.close();
  }
}

/** API key Connect: store it (replacing an earlier connection). */
export async function saveApiKeyConnection(ownerId: string, def: ConnectorDef, apiKey: string): Promise<Connection> {
  const secret: ApiKeySecret = { type: 'api_key', apiKey };
  const cred = await saveCredential({ ownerId, name: connectionName(def.slug), kind: 'connector', service: def.name, meta: { connector: def.slug, auth: 'api_key', savedBy: 'user' }, secret: secret as unknown as Record<string, unknown> });
  return { cred, secret };
}

/**
 * OAuth Connect: discovery, dynamic client registration and PKCE, keeping the state in the vault. Returns the
 * sign-in link (or 'connected' when stored tokens still worked).
 */
export async function startOAuth(ownerId: string, def: ConnectorDef): Promise<{ status: 'redirect'; url: string } | { status: 'connected' }> {
  if (def.auth.type !== 'oauth') throw new ConnectorError('Not an OAuth connector.');
  if (!env.MCP_OAUTH_REDIRECT_URL) throw new ConnectorError('OAuth sign-in is not set up on this bot yet. Ask the admin.');
  const old = await getConnection(ownerId, def.slug).catch(() => null);
  // Keep an earlier client registration (same server, same redirect URL); drop tokens and any pending attempt.
  const prev = old?.secret.type === 'oauth' ? old.secret : null;
  const secret: OAuthSecret = { type: 'oauth', ...(prev?.client ? { client: prev.client, clientDynamic: prev.clientDynamic } : {}), ...(prev?.authOrigins ? { authOrigins: prev.authOrigins } : {}) };
  const cred = await saveCredential({ ownerId, name: connectionName(def.slug), kind: 'connector', service: def.name, meta: { connector: def.slug, auth: 'oauth', savedBy: 'user' }, secret: secret as Record<string, unknown> });
  const conn: Connection = { cred, secret };
  const provider = new VaultOAuthProvider(cred, secret, def, 'connect');
  const policy = policyFor(def, conn, true);
  const fetchFn = pinnedFetch(policy, { signal: AbortSignal.timeout(AUTH_TIMEOUT_MS), timeoutMs: AUTH_TIMEOUT_MS });
  const scope = def.auth.scopes?.length ? def.auth.scopes.join(' ') : undefined;
  const result = await auth(provider, { serverUrl: def.url, fetchFn, ...(scope ? { scope } : {}) });
  secret.authOrigins = [...new Set([...(secret.authOrigins ?? []), ...(policy.seen ?? [])])].slice(0, 10);
  if (result === 'AUTHORIZED') {
    await provider.persist();
    return { status: 'connected' };
  }
  if (!provider.authUrl) throw new ConnectorError("The server didn't give a sign-in link.");
  secret.authUrl = provider.authUrl.toString();
  await provider.persist();
  return { status: 'redirect', url: secret.authUrl };
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The pasted `<state>.<code>`: check the state, exchange the code, store the tokens. */
export async function finishOAuth(ownerId: string, def: ConnectorDef, blob: { state: string; code: string }): Promise<void> {
  const conn = await getConnection(ownerId, def.slug);
  if (!conn || conn.secret.type !== 'oauth' || !conn.secret.state || !conn.secret.stateAt) throw new ConnectorError('No sign-in is waiting for a code. Press Connect first.');
  if (Date.now() - conn.secret.stateAt > OAUTH_PENDING_MS) throw new ConnectorError('That sign-in expired. Press Connect again.');
  if (!sameString(conn.secret.state, blob.state)) throw new ConnectorError("That code belongs to a different sign-in. Copy the code from the page you were sent to after this Connect.");
  const provider = new VaultOAuthProvider(conn.cred, conn.secret, def, 'connect');
  const policy = policyFor(def, conn, true);
  const fetchFn = pinnedFetch(policy, { signal: AbortSignal.timeout(AUTH_TIMEOUT_MS), timeoutMs: AUTH_TIMEOUT_MS });
  const scope = def.auth.type === 'oauth' && def.auth.scopes?.length ? def.auth.scopes.join(' ') : undefined;
  const result = await auth(provider, { serverUrl: def.url, authorizationCode: blob.code, callbackState: blob.state, fetchFn, ...(scope ? { scope } : {}) });
  if (result !== 'AUTHORIZED' || !conn.secret.tokens?.access_token) throw new ConnectorError("The server didn't accept that code. Press Connect and try again.");
  conn.secret.authOrigins = [...new Set([...(conn.secret.authOrigins ?? []), ...(policy.seen ?? [])])].slice(0, 10);
  await provider.persist();
}
