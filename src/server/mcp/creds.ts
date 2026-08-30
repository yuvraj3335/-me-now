/**
 * Credential resolution chain (DECISIONS.md #2). Best available wins, so the
 * same adapter code works whether you connected through Wake, through
 * `claude mcp login` on the box, or with a token in the environment.
 *
 *   1. Wake's own OAuth store  — durable, auto-refreshing
 *   2. Claude Code's credential file — the bridge, zero extra setup
 *   3. A static token from the environment — the escape hatch
 */
import { readFileSync, statSync } from 'node:fs'
import { claudeCredentialsPath, MCP_SERVERS, STATIC_TOKENS } from '../env'
import {
  discover, getStored, putStored, refresh, RefreshRejected, type StoredToken,
} from './oauth'

export type CredSource = 'wake-oauth' | 'claude-bridge' | 'env' | 'none'

type ClaudeMcpEntry = {
  serverName?: string
  serverUrl?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
}

/**
 * Read whatever Claude Code has for this server. Entries are keyed
 * "<name>|<hash>", so we match on the name or on the MCP URL appearing anywhere
 * in the stored server URL — claude.ai connectors wrap the real URL in an
 * Anthropic proxy URL as a query parameter.
 */
export function claudeBridgeToken(server: string): string | null {
  let raw: string
  let writtenAt: number
  try {
    const path = claudeCredentialsPath()
    raw = readFileSync(path, 'utf8')
    writtenAt = statSync(path).mtimeMs
  } catch {
    return null
  }

  let parsed: { mcpOAuth?: Record<string, ClaudeMcpEntry> }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const wantUrl = MCP_SERVERS[server]?.url
  const wantName = server.toLowerCase()
  let best: { token: string; expiresAt: number } | null = null

  for (const [key, entry] of Object.entries(parsed.mcpOAuth ?? {})) {
    const token = entry?.accessToken?.trim()
    if (!token) continue

    const name = (entry.serverName ?? key.split('|')[0] ?? '').toLowerCase()
    const url = entry.serverUrl ?? ''
    const matches =
      name === wantName ||
      name.replace(/[\s_-]/g, '') === wantName.replace(/[\s_-]/g, '') ||
      (!!wantUrl && (url.includes(new URL(wantUrl).host) || url.includes(encodeURIComponent(wantUrl))))
    if (!matches) continue

    // An expired bridge token is worse than none: it produces a confusing 401
    // instead of an honest "not connected".
    //
    // An entry with no `expiresAt` used to score `Number.MAX_SAFE_INTEGER` and
    // be served for the life of the process. Claude's Gmail grant is exactly
    // that shape and lasts an hour, so the chain kept preferring a token that
    // died at 60 minutes over asking Wake's own store for a fresh one. With no
    // stated expiry the only honest bound is when the file was last written.
    const exp = entry.expiresAt ?? writtenAt + BRIDGE_ASSUMED_TTL_MS
    if (exp < Date.now()) continue
    if (!best || exp > best.expiresAt) best = { token, expiresAt: exp }
  }
  return best?.token ?? null
}

/**
 * How long an entry that states no expiry is trusted for, measured from the
 * file's mtime. Google's access tokens are an hour and Claude rewrites the file
 * when it renews one, so this expires at roughly the same moment the token does.
 */
const BRIDGE_ASSUMED_TTL_MS = 3_600_000

type ClaudeGmailClient = ClaudeMcpEntry & { clientId?: string; clientSecret?: string }

function isGmailEntryName(name: string) {
  return name.toLowerCase().replace(/[\s_-]/g, '') === 'gmail'
}

/** Installed Google OAuth clients look like this. Claude.ai's Gmail connector does not. */
export function isGoogleWebClientId(id: string | null | undefined): boolean {
  return !!id && id.endsWith('.apps.googleusercontent.com')
}

/**
 * Claude stores two things named Gmail. The claude.ai connector has a UUID
 * client and an Anthropic proxy URL. `claude mcp login gmail` has the Google
 * Cloud client (`*.apps.googleusercontent.com`) against gmailmcp.googleapis.com.
 * Wake authorizes at accounts.google.com, so only the second one can work.
 */
export function pickGmailClientFromClaude(parsed: {
  mcpOAuth?: Record<string, ClaudeGmailClient>
  mcpOAuthClientConfig?: Record<string, { clientSecret?: string }>
}): { client_id: string; client_secret: string | null } | null {
  let best: { client_id: string; client_secret: string | null; score: number } | null = null
  for (const [key, entry] of Object.entries(parsed.mcpOAuth ?? {})) {
    const name = entry.serverName ?? key.split('|')[0] ?? ''
    const id = entry.clientId?.trim()
    if (!isGmailEntryName(name) || !id || !isGoogleWebClientId(id)) continue
    const secret = entry.clientSecret ?? parsed.mcpOAuthClientConfig?.[key]?.clientSecret ?? null
    const url = entry.serverUrl ?? ''
    // Direct Gmail MCP beats a URL that only mentions it inside an Anthropic query string.
    const score = url.includes('gmailmcp.googleapis.com') && !url.includes('anthropic.com') ? 2 : 1
    if (!best || score > best.score) best = { client_id: id, client_secret: secret, score }
  }
  return best ? { client_id: best.client_id, client_secret: best.client_secret } : null
}

/**
 * The Google client Claude already used for `claude mcp login gmail`.
 * Wake needs the same id/secret to run its own offline grant. Does not
 * copy the hourly access token — that one cannot be refreshed.
 */
export function seedGmailClientFromClaude() {
  if (isGoogleWebClientId(getStored('gmail')?.client_id)) return
  let raw: string
  try {
    raw = readFileSync(claudeCredentialsPath(), 'utf8')
  } catch {
    return
  }
  let parsed: {
    mcpOAuth?: Record<string, ClaudeGmailClient>
    mcpOAuthClientConfig?: Record<string, { clientSecret?: string }>
  }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  const picked = pickGmailClientFromClaude(parsed)
  if (!picked) return
  putStored('gmail', { client_id: picked.client_id, client_secret: picked.client_secret })
}

/**
 * How early a token counts as stale.
 *
 * Sixty seconds was a cliff: a poll that started inside the last minute of a
 * token's life reached the provider after it had already expired, and the whole
 * run came back 401. Five minutes is long enough to cover a slow poll and short
 * enough that it costs one extra refresh an hour at most.
 */
export const REFRESH_SKEW_MS = 300_000

/**
 * One refresh per server at a time.
 *
 * This is not defensive programming against a hypothetical. `doIngest` runs five
 * adapters in `Promise.all`, `listThreads` fans out per account, and
 * `HttpTransport.headers()` resolves a token on *every* JSON-RPC request — so a
 * single poll can ask for the same credential a dozen times in the same
 * millisecond. Where the provider rotates the refresh token on use (Slack does;
 * Google can), everyone but the winner of that race then presents a refresh
 * token the provider has already invalidated, and the row can be left holding an
 * older generation than the one last issued. The connection dies, and it looks
 * like the provider dropped it.
 */
const inflight = new Map<string, Promise<string | null>>()

/**
 * The MCP server behind a credential key. `gmail:yuvraj@truto.one` is a
 * credential for the `gmail` server; the suffix names the account, not a
 * different server. Without this, `MCP_SERVERS[server]?.url` was `undefined`,
 * `discover('')` threw a TypeError out of `new URL('')` — outside the try, so it
 * rejected `resolveToken` itself rather than degrading to "not connected".
 */
const baseServer = (server: string) => server.split(':')[0]!

async function doRefresh(server: string, row: StoredToken): Promise<string | null> {
  try {
    const url = MCP_SERVERS[baseServer(server)]?.url
    if (!url) throw new Error(`no MCP server is configured for ${baseServer(server)}`)
    const md = await discover(url)
    if (!md) throw new Error(`${baseServer(server)} published no OAuth metadata to refresh against`)

    const t = await refresh(md, {
      refreshToken: row.refresh_token!,
      clientId: row.client_id!,
      clientSecret: row.client_secret,
    })
    putStored(server, {
      access_token: t.access_token,
      // A response that omits `refresh_token` is not a response that revoked
      // one — most providers only re-issue it when they rotate.
      refresh_token: t.refresh_token ?? row.refresh_token,
      expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
      scope: t.scope ?? row.scope,
      last_auth_ok_at: Date.now(),
      last_auth_error: null,
    })
    return t.access_token
  } catch (e) {
    if (e instanceof RefreshRejected) {
      // Terminal. Keeping the tokens would only let the next caller make a real
      // request with a credential the provider has already disowned, which is
      // how a dead grant came to read as `sync failed · 401 from …` instead of
      // as something he can act on.
      putStored(server, {
        access_token: null, refresh_token: null, expires_at: null,
        last_auth_error: e.reason,
      })
      return null
    }
    // Transient. Nothing was established, so nothing is cleared.
    putStored(server, { last_auth_error: (e as Error).message })
    return null
  }
}

function refreshOnce(server: string, row: StoredToken): Promise<string | null> {
  const running = inflight.get(server)
  if (running) return running
  const p = doRefresh(server, row).finally(() => inflight.delete(server))
  inflight.set(server, p)
  return p
}

/**
 * Refresh whatever the freshness check would have accepted.
 *
 * This is what a 401 calls: the server has just told us the token we hold is not
 * good, which is a fact `expires_at` does not have. It joins the same
 * single-flight, so a burst of 401s across five concurrent requests is still one
 * round-trip to the token endpoint.
 */
export function forceRefresh(server: string): Promise<string | null> {
  const row = getStored(server)
  if (!row?.refresh_token || !row.client_id) return Promise.resolve(null)
  return refreshOnce(server, row)
}

async function wakeOauthToken(server: string): Promise<string | null> {
  const row = getStored(server)
  if (!row?.access_token) return null

  if (!row.expires_at || row.expires_at > Date.now() + REFRESH_SKEW_MS) return row.access_token

  // An expired grant with no refresh token is not a token. Serving it turned
  // Gmail's hourly death into a 401 instead of Connect.
  if (!row.refresh_token || !row.client_id) return null
  return refreshOnce(server, row)
}

export type ResolvedToken = {
  token: string | null
  via: CredSource
  /** When this credential last completed an auth round-trip. */
  lastAuthOkAt: number | null
  /** Non-null means reconnect, and the string is the provider's own reason. */
  lastAuthError: string | null
}

export async function resolveToken(server: string): Promise<ResolvedToken> {
  // Read after the refresh, not before: a refresh that just failed is the whole
  // reason there is no token, and it is the sentence the Settings row wants.
  const own = await wakeOauthToken(server)
  const row = getStored(server)
  const auth = {
    lastAuthOkAt: row?.last_auth_ok_at ?? null,
    lastAuthError: row?.last_auth_error ?? null,
  }
  if (own) return { token: own, via: 'wake-oauth', ...auth }

  const bridged = claudeBridgeToken(server)
  if (bridged) return { token: bridged, via: 'claude-bridge', ...auth }

  const stat = STATIC_TOKENS[server]?.trim()
  if (stat) return { token: stat, via: 'env', ...auth }

  return { token: null, via: 'none', ...auth }
}

/**
 * The token source a transport is built on.
 *
 * `refresh` is what makes a 401 recoverable: the transport does not know which
 * credential it is holding, and this does. Handing the renewal to the token
 * source rather than to the transport's constructor is what lets a session built
 * anywhere in the codebase get the retry without naming a server twice.
 */
export const tokenGetter = (server: string) => {
  const get = async () => (await resolveToken(server)).token
  get.refresh = () => forceRefresh(server)
  return get
}
