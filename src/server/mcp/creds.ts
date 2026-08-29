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

/** Refresh Wake's own token when it is within a minute of expiring. */
async function wakeOauthToken(server: string): Promise<string | null> {
  const row = getStored(server)
  if (!row?.access_token) return null

  const fresh = !row.expires_at || row.expires_at > Date.now() + 60_000
  if (fresh) return row.access_token

  if (!row.refresh_token || !row.client_id) return row.access_token
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
