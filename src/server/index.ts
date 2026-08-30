import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { api } from './api'
import { agentApi, bootAgent } from './agentApi'
import { originGuard, sweepConfirmations } from './security'
import { HOST, PORT, POLL_INTERVAL_MS, PUBLIC_URL, REMINDER_TICK_MS, IS_DEV } from './env'
import { ingest } from './ingest'
import { runReminders } from './push'
import { db } from './db'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const DIST = join(ROOT, 'dist')

const app = new Hono()

// One line per request, which is what makes `journalctl -u wake -f` useful.
app.use('*', async (c, next) => {
  const t0 = Date.now()
  await next()
  if (!c.req.path.startsWith('/assets/')) {
    console.log(`${c.res.status} ${c.req.method} ${c.req.path} ${Date.now() - t0}ms`)
  }
})

// Cloudflare Access proves who is asking; this proves which page asked.
app.use('*', originGuard())

app.onError((err, c) => {
  console.error(`error on ${c.req.method} ${c.req.path}:`, err)
  return c.json({ error: err.message }, 500)
})

app.get('/healthz', c =>
  c.json({
    ok: true,
    cards: (db.query(`SELECT COUNT(*) AS n FROM cards WHERE gone = 0`).get() as any).n,
    uptime: Math.round(process.uptime()),
  }),
)

app.route('/api', api)
app.route('/api/agent', agentApi)

/* ------------------------------- static --------------------------------- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp',
}

async function serveFile(path: string, c: any) {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  const ext = path.slice(path.lastIndexOf('.'))
  const headers: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' }
  // Hashed asset names are immutable; the service worker and shell are not.
  if (path.includes('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  else headers['Cache-Control'] = 'no-cache'
  return c.newResponse(file.stream(), 200, headers)
}

app.get('/*', async c => {
  const url = new URL(c.req.url)
  // normalize() collapses any ../ before it can escape the served directory.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '')

  if (rel) {
    const hit = await serveFile(join(DIST, rel), c)
    if (hit) return hit
  }
  // Unknown API paths must 404 rather than fall through to the SPA shell.
  if (rel.startsWith('api/')) return c.json({ error: 'not found' }, 404)

  const shell = await serveFile(join(DIST, 'index.html'), c)
  if (shell) return shell
  return c.text(
    existsSync(DIST) ? 'not found' : 'wake: no build yet — run `bun run build`',
    existsSync(DIST) ? 404 : 503,
  )
})

/* ------------------------------ scheduler -------------------------------- */

function every(ms: number, label: string, fn: () => Promise<unknown>) {
  const tick = async () => {
    try { await fn() } catch (e) { console.error(`${label} failed:`, (e as Error).message) }
  }
  void tick()
  const t = setInterval(tick, ms)
  // A stray interval must not hold the process open during a restart.
  t.unref?.()
  return t
}

if (!process.env.WAKE_NO_SCHEDULER) {
  every(POLL_INTERVAL_MS, 'ingest', async () => {
    const r = await ingest()
    const failed = r.sources.filter(s => !s.ok)
    console.log(
      `ingest: ${r.groups} groups (+${r.newGroups} new) · ` +
      r.sources.map(s => `${s.source}${s.ok ? `=${s.count}` : '=err'}`).join(' ') +
      (failed.length ? ` · errors: ${failed.map(f => `${f.source}: ${f.error}`).join('; ')}` : ''),
    )
  })
  every(REMINDER_TICK_MS, 'reminders', runReminders)
  // Spent and expired confirmation tokens are noise in a table that should only
  // ever contain live ones.
  every(6 * 3.6e6, 'confirmations', async () => { sweepConfirmations() })
}

const boot = bootAgent()
console.log(
  `agent: ${boot.repos} repos, ${boot.skills} skills indexed, key ${boot.key.present ? `via ${boot.key.via} (…${boot.key.last4})` : 'MISSING — Settings → Agent'}` +
  (boot.interrupted ? `, ${boot.interrupted} interrupted turn(s) closed` : '') +
  (boot.expired ? `, ${boot.expired} orphaned approval(s) expired` : '') +
  (boot.packs ? `, ${boot.packs} interrupted launch(es) closed` : ''),
)
console.log(`claude code: ${boot.launcher.ok ? boot.launcher.version : boot.launcher.reason}`)

console.log(`wake listening on http://${HOST}:${PORT}  (public: ${PUBLIC_URL})${IS_DEV ? '  [dev]' : ''}`)

export default { port: PORT, hostname: HOST, fetch: app.fetch, idleTimeout: 60 }
