/**
 * The Connections page's backend: OAuth 2.1 + PKCE against any MCP server,
 * with dynamic client registration when the server supports it and a pasted
 * client_id/secret when it does not (Slack is the latter — see SETUP.md).
 */
import { Hono } from 'hono'
import { db, now, uid } from './db'
import { MCP_SERVERS, PUBLIC_URL } from './env'
import { ADAPTERS } from './ingest'
import { resolveToken, claudeBridgeToken } from './mcp/creds'
import { challengeFor, discover, exchangeCode, getStored, makeVerifier, putStored, registerClient } from './mcp/oauth'

export const connections = new Hono()

const REDIRECT = `${PUBLIC_URL}/api/connections/callback`

connections.get('/', async c => {
  // The last finished poll per source, so a row can say "connected" and "the
  // last poll still failed" at once. Being reachable and being useful are
  // different claims, and a status row that only makes the first reads as
  // healthy for a source that has not returned anything in a day.
  const runs = new Map<string, { ok: number; at: number; error: string | null }>(
    db.query<{ source: string; at: number; ok: number; error: string | null }, []>(
      `SELECT source, MAX(started_at) AS at, ok, error
         FROM sync_runs WHERE finished_at IS NOT NULL GROUP BY source`,
    ).all().map(r => [r.source, { ok: r.ok, at: r.at, error: r.error }]),
  )

  const sources = await Promise.all(ADAPTERS.map(async a => {
    const status = await a.status()
    const oauthable = a.name in MCP_SERVERS
    const stored = oauthable ? getStored(a.name) : null
    return {
      name: a.name,
      label: a.label,
      ...status,
      lastSync: runs.get(a.name) ?? null,
      oauthable,
      // Surface which link in the credential chain answered, so a confusing
      // "connected but empty" state is diagnosable from the UI.
      hasWakeToken: !!stored?.access_token,
      hasClaudeBridge: oauthable ? !!claudeBridgeToken(a.name) : false,
      hasClientId: !!stored?.client_id,
      needsClientId: oauthable && !stored?.client_id,
    }
  }))
  return c.json({ sources, redirectUri: REDIRECT })
})

/** Store a manually-created OAuth app's credentials (the no-DCR path). */
connections.post('/:server/client', async c => {
  const server = c.req.param('server')
  if (!(server in MCP_SERVERS)) return c.json({ error: 'unknown server' }, 404)
  const { client_id, client_secret } = await c.req.json<{ client_id: string; client_secret?: string }>()
  if (!client_id?.trim()) return c.json({ error: 'client_id required' }, 400)
  putStored(server, { client_id: client_id.trim(), client_secret: client_secret?.trim() || null })
  return c.json({ ok: true })
})

connections.post('/:server/start', async c => {
  const server = c.req.param('server')
  const cfg = MCP_SERVERS[server]
  if (!cfg) return c.json({ error: 'unknown server' }, 404)

  const md = await discover(cfg.url)
  if (!md) return c.json({ error: `${cfg.label} publishes no OAuth metadata; see SETUP.md` }, 400)

  let stored = getStored(server)
  if (!stored?.client_id) {
    const reg = await registerClient(md, REDIRECT)
    if (reg?.client_id) {
      putStored(server, { client_id: reg.client_id, client_secret: reg.client_secret ?? null })
      stored = getStored(server)
    }
  }
  if (!stored?.client_id) {
    return c.json({
      error: 'needs_client_id',
      detail: `${cfg.label} does not support dynamic client registration. Create an app, then paste its client id and secret here.`,
      redirectUri: REDIRECT,
    }, 428)
  }

  const verifier = makeVerifier()
  const state = uid()
  db.query(`INSERT INTO oauth_pending (state, server, verifier, redirect, created_at) VALUES (?,?,?,?,?)`)
    .run(state, server, verifier, REDIRECT, now())

  const u = new URL(md.authorization_endpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', stored.client_id)
  u.searchParams.set('redirect_uri', REDIRECT)
  u.searchParams.set('state', state)
  u.searchParams.set('code_challenge', await challengeFor(verifier))
  u.searchParams.set('code_challenge_method', 'S256')
  const scopes = cfg.scopes ?? md.scopes_supported?.join(',')
  if (scopes) {
    // Slack reads user grants from `user_scope`; everything else uses `scope`.
    u.searchParams.set(server === 'slack' ? 'user_scope' : 'scope', scopes.replace(/,/g, server === 'slack' ? ',' : ' '))
  }
  return c.json({ url: u.toString() })
})

connections.get('/callback', async c => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const err = c.req.query('error')
  if (err) return c.html(page(`Authorization failed`, err))
  if (!code || !state) return c.html(page('Authorization failed', 'missing code or state'))

  const pending = db.query<any, [string]>(`SELECT * FROM oauth_pending WHERE state = ?`).get(state)
  if (!pending) return c.html(page('Authorization failed', 'unknown or expired state'))
  db.query(`DELETE FROM oauth_pending WHERE state = ?`).run(state)

  const cfg = MCP_SERVERS[pending.server]
  const md = cfg ? await discover(cfg.url) : null
  if (!md) return c.html(page('Authorization failed', 'server metadata unavailable'))

  const stored = getStored(pending.server)
  try {
    const t = await exchangeCode(md, {
      code, verifier: pending.verifier, redirectUri: pending.redirect,
      clientId: stored?.client_id ?? '', clientSecret: stored?.client_secret,
    })
    putStored(pending.server, {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
      scope: t.scope,
    })
    return c.html(page(`${cfg!.label} connected`, 'You can close this tab.', true))
  } catch (e) {
    return c.html(page('Authorization failed', (e as Error).message))
  }
})

connections.post('/:server/disconnect', c => {
  db.query(`DELETE FROM oauth_tokens WHERE server = ?`).run(c.req.param('server'))
  return c.json({ ok: true })
})

connections.get('/:server/probe', async c => {
  const server = c.req.param('server')
  const { token, via } = await resolveToken(server)
  return c.json({ connected: !!token, via })
})

/**
 * Tiny self-contained page for the OAuth round-trip's landing.
 *
 * Every interpolated value is escaped. `detail` carries `?error=` straight off
 * the query string and provider error text — this page is a GET the identity
 * provider redirects to, so it is exempt from the origin guard by construction
 * and anyone can make a browser load it with an argument they chose.
 */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const page = (rawTitle: string, rawDetail: string, ok = false) => {
  const title = esc(rawTitle)
  const detail = esc(rawDetail.slice(0, 500))
  return `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0a0a0b;
         color:#e7e7ea; font:15px/1.6 ui-sans-serif,-apple-system,system-ui,sans-serif }
  .c { text-align:center; padding:2rem }
  .d { width:10px;height:10px;border-radius:99px;margin:0 auto 1.25rem;
       background:${ok ? '#4ade80' : '#f87171'}; box-shadow:0 0 24px ${ok ? '#4ade8066' : '#f8717166'} }
  h1 { font-size:1.0625rem; font-weight:560; margin:0 0 .375rem; letter-spacing:-.01em }
  p { margin:0; color:#8b8b93; font-size:.875rem; max-width:34ch }
</style>
<div class="c"><div class="d"></div><h1>${title}</h1><p>${detail}</p></div>
<script>setTimeout(()=>window.close(),${ok ? 1500 : 8000})</script>`
}
