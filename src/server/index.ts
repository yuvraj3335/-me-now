import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { api } from './api'
import { boot } from './boot'
import { rescan } from './registry/scan'
import { terminalSocket, websocket } from './claudecode/terminalSocket'
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

/**
 * The terminal socket, mounted above `/api` rather than inside it.
 *
 * A WebSocket upgrade cannot travel through Hono's normal response path — Bun
 * has to see the upgrade on the way in, which is why `createBunWebSocket`
 * returns a `websocket` handler that belongs on the serve options at the bottom
 * of this file rather than on a router. Registering the route here, before
 * `app.route('/api', …)`, is what puts it in front of the sub-app that would
 * otherwise answer the same path with a 404.
 */
app.route('/', terminalSocket)

app.route('/api', api)

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

  /*
   * And so must an asset that is not on disk. This one produced a white screen.
   *
   * `/assets/*` names are content-hashed, so a request for one that does not
   * exist means the page asking for it was built against a different commit — a
   * phone holding a shell from before a deploy, most often out of the service
   * worker's own cache. Falling through returned the SPA shell: **200, with a
   * `text/html` body, to a `<script type="module">` request.** The browser
   * rejects that as a module, `import()` rejects, React re-throws it during
   * render, and the whole root unmounts — a blank page with one console line.
   * Reproduced end to end; `#root` innerHTML length 0.
   *
   * A 404 does not by itself put anything on screen — that is the error
   * boundary's job, in `src/web/main.tsx` — but it is the difference between a
   * failure the client can recognise as "my build is stale" and one that looks
   * like the server sending nonsense. It also stops the service worker storing
   * an HTML body under a `.js` key and serving it back for as long as the cache
   * lives.
   */
  if (rel.startsWith('assets/')) return c.text('not found', 404)

  const shell = await serveFile(join(DIST, 'index.html'), c)
  if (shell) return shell
  return c.text(
    existsSync(DIST) ? 'not found' : 'wake: no build yet — run `bun run build`',
    existsSync(DIST) ? 404 : 503,
  )
})

/* ------------------------------ scheduler -------------------------------- */

/**
 * How often the repository registry is re-read.
 *
 * It used to be read **once**, at boot, by `boot()` — there was no timer, no
 * route and no expiry, so the branch and the uncommitted count a repository
 * picker showed were as old as the process. Frequent restarts from the deploy
 * timer were the only thing hiding it; on a quiet week the numbers would be days
 * stale. Observed directly: the cache said `wake` had 15 uncommitted files
 * several minutes after they had been committed and the real answer was 0.
 *
 * Five minutes rather than every poll, because a rescan shells out to `git` once
 * per repository and the answer only changes when he is working — at which
 * point he is the one making it change, and a five-minute-old branch name has
 * never been the thing that misled anybody.
 */
const REGISTRY_RESCAN_MS = 5 * 60_000

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
    // A source nobody connected is `=off`, not `=err`: it is a choice, not a
    // fault, and a log that shouts about it hides the one that really broke.
    const failed = r.sources.filter(s => !s.ok && s.connected)
    console.log(
      `ingest: ${r.groups} groups (+${r.newGroups} new) · ` +
      r.sources.map(s => `${s.source}=${!s.connected ? 'off' : s.ok ? s.count : 'err'}`).join(' ') +
      (failed.length ? ` · errors: ${failed.map(f => `${f.source}: ${f.error}`).join('; ')}` : ''),
    )
  })
  every(REMINDER_TICK_MS, 'reminders', runReminders)
  // The repository registry, which used to be read once at boot and never
  // again. See `REGISTRY_RESCAN_MS`.
  every(REGISTRY_RESCAN_MS, 'registry', async () => { rescan() })
  // Spent and expired confirmation tokens are noise in a table that should only
  // ever contain live ones.
  every(6 * 3.6e6, 'confirmations', async () => { sweepConfirmations() })
}

const b = boot()
console.log(`workspace: ${b.repos} repos, ${b.skills} skills indexed`)
console.log(`claude code: ${b.terminal}`)

console.log(`wake listening on http://${HOST}:${PORT}  (public: ${PUBLIC_URL})${IS_DEV ? '  [dev]' : ''}`)

/**
 * 255 is Bun's ceiling and 60 was not enough.
 *
 * Measured on the box: a Fetch that asks two connectors through the box's own
 * `claude` takes 40–60 seconds, and the socket was closed underneath it at
 * exactly 60 — `curl: (52) Empty reply from server` while the run itself
 * finished fine and landed its rows. `POST /api/fetch` returns immediately now
 * and the result is polled, so nothing depends on this; it is raised anyway
 * because a slow poll of five sources is the same shape of request.
 */
/**
 * `websocket` is not optional decoration.
 *
 * Bun routes an upgraded socket's open/message/close events through the handler
 * on *this object*, not through anything the Hono route returned. Without this
 * key the upgrade succeeds and then nothing ever arrives — a terminal that
 * connects, renders an empty screen and never reports why.
 */
export default { port: PORT, hostname: HOST, fetch: app.fetch, websocket, idleTimeout: 255 }
