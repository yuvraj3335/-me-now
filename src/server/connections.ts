/**
 * The Connections page's backend: OAuth 2.1 + PKCE against any MCP server,
 * with dynamic client registration when the server supports it and a pasted
 * client_id/secret when it does not (Slack is the latter — see SETUP.md).
 */
import { Hono } from 'hono'
import { latestFinishedRuns, db, now, uid } from './db'
import { resetSlackSession } from './sources/slack'
import { resetGmailSessions } from './mail/gmail'
import { MCP_SERVERS, PUBLIC_URL } from './env'
import { ADAPTERS, ingest } from './ingest'
import type { SourceName } from './sources/types'
import { resolveToken, claudeBridgeToken } from './mcp/creds'
import {
  challengeFor, decorateAuthorizeUrl, discover, exchangeCode, formatScopeList,
  getStored, makeVerifier, putStored, registerClient, scopeQueryParam,
} from './mcp/oauth'
import { seedGmailClientFromClaude } from './mcp/creds'

export const connections = new Hono()

const REDIRECT = `${PUBLIC_URL}/api/connections/callback`

connections.get('/', async c => {
  // The last finished poll per source, so a row can say "connected" and "the
  // last poll still failed" at once. Being reachable and being useful are
  // different claims, and a status row that only makes the first reads as
  // healthy for a source that has not returned anything in a day.
  //
  // `connected` comes with it, and it is the column that stops a lie. One ingest
  // run stamps every source with the same `started_at`, including the three that
  // have no account attached — so handing a status board `at` without
  // `connected` renders "Slack, synced 1m ago" about a Slack nobody ever
  // connected. `sync_runs` is the single source of truth for what happened;
  // `status()` below answers the different question of what could happen now.
  const runs = new Map(latestFinishedRuns().map(r => [r.source, r]))
  seedGmailClientFromClaude()

  const sources = await Promise.all(ADAPTERS.map(async a => {
    const status = await a.status()
    const cfg = MCP_SERVERS[a.name]
    const oauthable = !!cfg
    const stored = oauthable ? getStored(a.name) : null
    return {
      name: a.name,
      label: a.label,
      ...status,
      lastSync: runs.get(a.name) ?? null,
      oauthable,
      /**
       * Whether Connect can actually work. Gmail's MCP origin publishes no
       * metadata; Wake still builds a Google authorize URL from OIDC, so
       * this is true for Gmail the same way it is for Slack.
       */
      connectable: cfg?.oauth !== 'none',
      // Surface which link in the credential chain answered, so a confusing
      // "connected but empty" state is diagnosable from the UI.
      hasWakeToken: !!stored?.access_token,
      hasClaudeBridge: oauthable ? !!claudeBridgeToken(a.name) : false,
      hasClientId: !!stored?.client_id,
      needsClientId: oauthable && !stored?.client_id,
      // The two facts `ok` cannot carry. A source can poll perfectly at the same
      // moment its refresh token is dead, and go on doing so until the access
      // token expires — so "when did this credential last actually authenticate"
      // is a separate column, and so is the provider's own word for the refusal.
      lastAuthOkAt: stored?.last_auth_ok_at ?? null,
      lastAuthError: stored?.last_auth_error ?? null,
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

  if (server === 'gmail') seedGmailClientFromClaude()
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
    u.searchParams.set(scopeQueryParam(md.authorization_endpoint, server), formatScopeList(scopes, server))
  }
  decorateAuthorizeUrl(u, server)
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
      // `undefined`, not `null`. A provider that re-issues an access token
      // without a refresh token has not revoked the one it gave last time, and
      // `putStored` only inherits a field the patch leaves out.
      refresh_token: t.refresh_token ?? undefined,
      expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
      scope: t.scope,
      last_auth_ok_at: Date.now(),
      last_auth_error: null,
    })
    // The MCP sessions cache both the handshake and tools/list. A reconnect that
    // just granted search scopes would otherwise keep serving the previous
    // token's tool surface — and its session id — for the rest of the process.
    if (pending.server === 'slack') resetSlackSession()
    if (pending.server === 'gmail') resetGmailSessions()
    // Do not wait. The Allow tab is closing; Settings is about to reload
    // and must not still be reading the poll from before this grant.
    void ingest(pending.server as SourceName)
    return c.html(page(`${cfg!.label} connected`, 'You can close this tab.', true))
  } catch (e) {
    return c.html(page('Authorization failed', (e as Error).message))
  }
})

/**
 * Give back the grant, keep the app.
 *
 * `oauth_tokens` is one row per server and it holds two unrelated things: the
 * *credential* Wake was granted, and the *application* that grant was made
 * against — `client_id` and `client_secret`. `DELETE FROM oauth_tokens` took
 * both, and for Slack that is the expensive half: Slack publishes no dynamic
 * client registration, so those two values are ones he went to api.slack.com,
 * created an app for, and pasted into the sheet by hand. Disconnecting sent him
 * back there. `Settings.tsx` already names this as a cost worth avoiding, in the
 * comment on the button that decides between Disconnect and Reconnect — it just
 * had no way to avoid it once the button was pressed.
 *
 * So the credential columns are cleared and the registration stays. Reconnect
 * then goes straight to the consent screen, which is the whole difference
 * between "I revoked this" and "I have never set this up".
 *
 * And the cached MCP session goes with it, which is the same reason the connect
 * callback resets it twenty lines up: `HttpTransport` holds an `Mcp-Session-Id`
 * established under the credential being revoked here, and `discoverTools`
 * holds that session's tool surface for thirty minutes. Without this the
 * process keeps replaying a handshake made with a token the operator has just
 * taken away.
 */
connections.post('/:server/disconnect', c => {
  const server = c.req.param('server')
  db.query(
    `UPDATE oauth_tokens
        SET access_token = NULL, refresh_token = NULL, expires_at = NULL,
            scope = NULL, last_auth_ok_at = NULL, last_auth_error = NULL, updated_at = ?
      WHERE server = ?`,
  ).run(now(), server)
  if (server === 'slack') resetSlackSession()
  if (server === 'gmail') resetGmailSessions()
  return c.json({ ok: true })
})

connections.get('/:server/probe', async c => {
  const server = c.req.param('server')
  const { token, via, lastAuthOkAt, lastAuthError } = await resolveToken(server)
  return c.json({ connected: !!token, via, lastAuthOkAt, lastAuthError })
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
