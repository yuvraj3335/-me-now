/**
 * OAuth 2.1 for MCP servers: PKCE always, RFC 7591 dynamic client registration
 * when the server offers it, a pasted client_id/secret when it does not.
 *
 * Slack is the "does not" case — its metadata advertises no registration
 * endpoint, so Wake accepts a Slack app's credentials from the Connections page
 * (see SETUP.md). Sentry is the "does" case and needs nothing from you.
 */
import { db, now } from '../db'

export type AsMetadata = {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url')

export function makeVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function challengeFor(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
}

async function json<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return null
    const ct = r.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

/**
 * Resource → authorization server, per RFC 9728. Falls back to probing the
 * origin directly, which is what most MCP servers actually implement.
 */
export async function discover(mcpUrl: string): Promise<AsMetadata | null> {
  const u = new URL(mcpUrl)
  const origin = u.origin

  const prm = await json<{ authorization_servers?: string[] }>(`${origin}/.well-known/oauth-protected-resource`)
  const candidates = [...(prm?.authorization_servers ?? []), origin]
  // Gmail MCP publishes no OAuth metadata. Google's own OIDC document does,
  // and that is the grant that can carry a refresh token. Without this,
  // Claude's hourly access token is the only thing Wake can hold.
  if (origin.includes('gmailmcp.googleapis.com')) {
    candidates.push('https://accounts.google.com')
  }

  for (const as of candidates) {
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const md = await json<AsMetadata>(`${as.replace(/\/$/, '')}${path}`)
      if (md?.authorization_endpoint && md.token_endpoint) return md
    }
  }
  return null
}

/**
 * Which query parameter carries scopes on this authorize URL.
 *
 * Slack MCP (mcp.slack.com) authorizes at `/oauth/v2_user/authorize`. That
 * endpoint only reads `scope`. Sending `user_scope` there is Slack's
 * "No scopes requested" page — the app can have every user scope configured
 * and the install still dies.
 *
 * Classic workspace install (`/oauth/v2/authorize`) still reads user grants
 * from `user_scope`. Everything else is standard `scope`.
 */
export function scopeQueryParam(authorizationEndpoint: string, server: string): 'scope' | 'user_scope' {
  if (server === 'slack' && !/\/oauth\/v2_user\b/.test(authorizationEndpoint)) return 'user_scope'
  return 'scope'
}

/** Slack wants commas on both of its authorize URLs; other servers want spaces. */
export function formatScopeList(scopes: string, server: string): string {
  return scopes.replace(/,/g, server === 'slack' ? ',' : ' ')
}

/**
 * Extra query params Wake must set on an authorize URL.
 *
 * Claude's Gmail login omits `access_type=offline`, so Google issues a
 * one-hour access token and no refresh token. Wake then goes dark every
 * hour. These two params are what make the grant durable.
 */
export function decorateAuthorizeUrl(url: URL, server: string): URL {
  if (server === 'gmail') {
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
  }
  return url
}

export async function registerClient(md: AsMetadata, redirectUri: string): Promise<{ client_id: string; client_secret?: string } | null> {
  if (!md.registration_endpoint) return null
  return json(md.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Wake',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  })
}

export type StoredToken = {
  server: string
  access_token: string | null
  refresh_token: string | null
  expires_at: number | null
  scope: string | null
  client_id: string | null
  client_secret: string | null
  metadata: string | null
}

export const getStored = (server: string): StoredToken | null =>
  db.query<StoredToken, [string]>(`SELECT * FROM oauth_tokens WHERE server = ?`).get(server) ?? null

export function putStored(server: string, patch: Partial<StoredToken>) {
  const cur = getStored(server)
  const next = { ...cur, ...patch }
  db.query(
    `INSERT INTO oauth_tokens (server, access_token, refresh_token, expires_at, scope, client_id, client_secret, metadata, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server) DO UPDATE SET
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, scope = excluded.scope,
       client_id = excluded.client_id, client_secret = excluded.client_secret,
       metadata = excluded.metadata, updated_at = excluded.updated_at`,
  ).run(
    server,
    next.access_token ?? null,
    next.refresh_token ?? null,
    next.expires_at ?? null,
    next.scope ?? null,
    next.client_id ?? null,
    next.client_secret ?? null,
    next.metadata ?? null,
    now(),
  )
}

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  // Slack returns the user grant nested rather than at the top level.
  authed_user?: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }
  ok?: boolean
  error?: string
}

/** Slack's oauth.v2.user.access answers 200 with {ok:false} and nests the grant. */
function normalizeTokenResponse(t: TokenResponse) {
  const u = t.authed_user
  return {
    access_token: t.access_token ?? u?.access_token ?? null,
    refresh_token: t.refresh_token ?? u?.refresh_token ?? null,
    expires_in: t.expires_in ?? u?.expires_in ?? null,
    scope: t.scope ?? u?.scope ?? null,
  }
}

export async function exchangeCode(md: AsMetadata, params: {
  code: string; verifier: string; redirectUri: string; clientId: string; clientSecret?: string | null
}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.verifier,
  })
  if (params.clientSecret) body.set('client_secret', params.clientSecret)

  const r = await fetch(md.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  const t = (await r.json()) as TokenResponse
  if (t.ok === false || t.error) throw new Error(`token exchange failed: ${t.error ?? 'unknown'}`)
  const n = normalizeTokenResponse(t)
  if (!n.access_token) throw new Error('token endpoint returned no access token')
  return n
}

export async function refresh(md: AsMetadata, params: {
  refreshToken: string; clientId: string; clientSecret?: string | null
}) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  })
  if (params.clientSecret) body.set('client_secret', params.clientSecret)

  const r = await fetch(md.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  const t = (await r.json()) as TokenResponse
  if (t.ok === false || t.error) throw new Error(`refresh failed: ${t.error ?? 'unknown'}`)
  const n = normalizeTokenResponse(t)
  if (!n.access_token) throw new Error('refresh returned no access token')
  return n
}
