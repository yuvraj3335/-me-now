/**
 * Credential resolution chain (DECISIONS.md #2). Best available wins, so the
 * same adapter code works whether you connected through Wake, through
 * `claude mcp login` on the box, or with a token in the environment.
 *
 *   1. Wake's own OAuth store  — durable, auto-refreshing
 *   2. Claude Code's credential file — the bridge, zero extra setup
 *   3. A static token from the environment — the escape hatch
 */
import { readFileSync } from 'node:fs'
import { claudeCredentialsPath, MCP_SERVERS, STATIC_TOKENS } from '../env'
import { discover, getStored, putStored, refresh } from './oauth'

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
  try {
    raw = readFileSync(claudeCredentialsPath(), 'utf8')
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
    const exp = entry.expiresAt ?? Number.MAX_SAFE_INTEGER
    if (exp < Date.now()) continue
    if (!best || exp > best.expiresAt) best = { token, expiresAt: exp }
  }
  return best?.token ?? null
}

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

/** Refresh Wake's own token when it is within a minute of expiring. */
async function wakeOauthToken(server: string): Promise<string | null> {
  const row = getStored(server)
  if (!row?.access_token) return null

  const fresh = !row.expires_at || row.expires_at > Date.now() + 60_000
  if (fresh) return row.access_token

  // An expired grant with no refresh token is not a token. Serving it
  // turned Gmail's hourly death into a 401 instead of Connect.
  if (!row.refresh_token || !row.client_id) return null
  const md = await discover(MCP_SERVERS[server]?.url ?? '')
  if (!md) return row.access_token

  try {
    const t = await refresh(md, {
      refreshToken: row.refresh_token,
      clientId: row.client_id,
      clientSecret: row.client_secret,
    })
    putStored(server, {
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? row.refresh_token,
      expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
      scope: t.scope ?? row.scope,
    })
    return t.access_token
  } catch {
    // Keep serving the stale token; the 401 path will surface it properly.
    return row.access_token
  }
}

export async function resolveToken(server: string): Promise<{ token: string | null; via: CredSource }> {
  const own = await wakeOauthToken(server)
  if (own) return { token: own, via: 'wake-oauth' }

  const bridged = claudeBridgeToken(server)
  if (bridged) return { token: bridged, via: 'claude-bridge' }

  const stat = STATIC_TOKENS[server]?.trim()
  if (stat) return { token: stat, via: 'env' }

  return { token: null, via: 'none' }
}

export const tokenGetter = (server: string) => async () => (await resolveToken(server)).token
