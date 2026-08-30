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
  /** When this credential last completed an auth round-trip. */
  last_auth_ok_at: number | null
  /** The provider's own word for why the last one did not. */
  last_auth_error: string | null
}

export const getStored = (server: string): StoredToken | null =>
  db.query<StoredToken, [string]>(`SELECT * FROM oauth_tokens WHERE server = ?`).get(server) ?? null

/**
 * Merge a patch into the stored row.
 *
 * An absent key inherits; an explicit `null` clears. The distinction matters
 * because callers routinely hand over a field the provider omitted — a token
 * response with no `refresh_token` is normal, and `{ ...cur, ...patch }` let
 * that bare `undefined` overwrite a perfectly good stored one. That is the
 * persistence half of "Gmail dies every hour".
 *
 * The read-modify-write is one transaction because it is not one statement: two
 * refreshes landing together would otherwise both read the old row and the
 * second would write back a generation the provider has already rotated away.
 */
export function putStored(server: string, patch: Partial<StoredToken>) {
  db.transaction(() => {
    const cur = getStored(server)
    const next: Partial<StoredToken> = { ...(cur ?? {}) }
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (next as Record<string, unknown>)[k] = v
    }
    db.query(
      `INSERT INTO oauth_tokens (server, access_token, refresh_token, expires_at, scope, client_id, client_secret, metadata, last_auth_ok_at, last_auth_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server) DO UPDATE SET
         access_token = excluded.access_token, refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at, scope = excluded.scope,
         client_id = excluded.client_id, client_secret = excluded.client_secret,
         metadata = excluded.metadata, last_auth_ok_at = excluded.last_auth_ok_at,
         last_auth_error = excluded.last_auth_error, updated_at = excluded.updated_at`,
    ).run(
      server,
      next.access_token ?? null,
      next.refresh_token ?? null,
      next.expires_at ?? null,
      next.scope ?? null,
      next.client_id ?? null,
      next.client_secret ?? null,
      next.metadata ?? null,
      next.last_auth_ok_at ?? null,
      next.last_auth_error ?? null,
      now(),
    )
  })()
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

  const { status, ok, text, json } = await postForm(md.token_endpoint, body)
  // A 502 HTML page from a proxy in front of the token endpoint used to reach
  // the operator as a JSON-parse complaint about an unexpected `<`, which names
  // the parser rather than the thing that went wrong.
  if (!ok && !json) throw new Error(`token endpoint answered ${status}: ${friendly(text)}`)
  const t = (json ?? {}) as TokenResponse
  if (t.ok === false || t.error) throw new Error(`token exchange failed: ${t.error ?? 'unknown'}`)
  if (!ok) throw new Error(`token endpoint answered ${status}: ${friendly(text)}`)
  const n = normalizeTokenResponse(t)
  if (!n.access_token) throw new Error('token endpoint returned no access token')
  return n
}

/**
 * The grant itself was refused. Terminal: nothing gets better by trying again,
 * and the stored tokens are cleared so the product offers Connect.
 */
export class RefreshRejected extends Error {
  constructor(readonly reason: string) {
    super(`refresh rejected: ${reason}`)
    this.name = 'RefreshRejected'
  }
}

/**
 * The refresh could not be *attempted* — a 5xx, a network failure, a timeout, a
 * body that is not JSON. Nothing has been established, so nothing is cleared and
 * the next poll asks again.
 */
export class RefreshUnavailable extends Error {
  constructor(message = 'the token endpoint could not be reached') {
    super(message)
    this.name = 'RefreshUnavailable'
  }
}

/**
 * Provider error codes that mean the grant is dead.
 *
 * The first four are RFC 6749's. The rest are Slack's, which answers 200 with
 * `{ok:false}` rather than a 4xx and has its own vocabulary for the same fact —
 * and Slack is the connection that rotates its refresh token on every use, so
 * it is the one most likely to actually get here.
 *
 * Anything not on this list is treated as transient. The asymmetry is
 * deliberate: a wrong "transient" costs one more failed refresh, and a wrong
 * "terminal" costs a re-authorisation nobody asked for.
 */
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_request',
  'invalid_refresh_token', 'token_revoked', 'token_expired', 'account_inactive', 'invalid_auth',
])

const friendly = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200)

/** One POST, decoded once, so a caller can see the status *and* the body. */
async function postForm(url: string, body: URLSearchParams) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await r.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not JSON — the caller decides what that means for its status code */
  }
  return { status: r.status, ok: r.ok, text, json }
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

  let res: Awaited<ReturnType<typeof postForm>>
  try {
    res = await postForm(md.token_endpoint, body)
  } catch (e) {
    throw new RefreshUnavailable(`token endpoint unreachable: ${(e as Error).message}`)
  }

  const t = (res.json ?? null) as TokenResponse | null
  const code = t?.error ?? null

  if (!res.ok) {
    // Only a 4xx is the provider judging the grant. A 5xx is the provider
    // having a bad minute, and clearing a live refresh token over one is how a
    // working connection gets thrown away during someone else's outage.
    if (res.status < 500 && code && TERMINAL_REFRESH_ERRORS.has(code)) throw new RefreshRejected(code)
    throw new RefreshUnavailable(`token endpoint answered ${res.status}: ${friendly(res.text)}`)
  }
  if (!t) throw new RefreshUnavailable('the token endpoint answered 200 with something that is not JSON')
  if (t.ok === false || code) {
    if (code && TERMINAL_REFRESH_ERRORS.has(code)) throw new RefreshRejected(code)
    throw new RefreshUnavailable(`refresh failed: ${code ?? 'unknown'}`)
  }

  const n = normalizeTokenResponse(t)
  if (!n.access_token) throw new RefreshUnavailable('refresh returned no access token')
  return n
}
