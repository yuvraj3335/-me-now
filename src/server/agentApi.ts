/**
 * The agent's HTTP surface.
 *
 * The important endpoint is the SSE tail. It is a cursor over `turn_events`
 * rather than a pipe from the model, so `?after=<seq>` resumes exactly where a
 * client left off — the same code path serves a fresh connection (after=0), a
 * reconnect after a dropped network, and a phone that was asleep.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { db, now, uid } from './db'
import { eventsSince, subscribe, foldSegments } from './agent/events'
import { startTurn, cancelTurn, isRunning, recoverInterrupted } from './agent/turns'
import { listPending, resolveApproval, expireOrphans } from './agent/approvals'
import { MODE_LIST, isMode } from './agent/modes'
import { listRepos, rescan, searchRepos } from './registry/scan'
import { listSkills, reindexSkills } from './skills/catalog'
import { routeSkills } from './skills/route'
import { listProfiles } from './truto/cli'
import { remoteStatus } from './agent/remote'
import { keyStatus } from './agent/key'
import { launcherStatus, recoverPacks } from './claudecode/launch'
import { probeMail } from './mail/gmail'
import { AGENT_MODEL } from './env'

export const agentApi = new Hono()

const bad = (m: string) => ({ error: m })

/* ------------------------------- overview -------------------------------- */

agentApi.get('/state', async c => {
  const repos = listRepos()
  return c.json({
    // Whether the agent can run at all, said first: everything else on this page
    // is moot without a key, and "nothing happens when I press send" is the
    // worst way to learn that.
    key: keyStatus(),
    model: AGENT_MODEL,
    launcher: launcherStatus(),
    mail: await probeMail().then(m => ({ connected: m.connected, reason: m.reason, canSend: m.canSend })),
    modes: MODE_LIST.map(m => ({ id: m.id, label: m.label, blurb: m.blurb, readOnly: m.readOnly })),
    skills: listSkills().map(s => ({
      id: s.id,
      name: s.name,
      catalog: s.catalog,
      surface: s.surface,
      whenToUse: s.when_to_use?.slice(0, 300) ?? null,
      mutating: !!s.mutating,
      bytes: s.bytes,
    })),
    repos: repos.map(r => ({
      name: r.name,
      path: r.path,
      role: r.role,
      branch: r.branch,
      dirty: r.dirty,
      language: r.language,
      upstream: r.upstream,
    })),
    // Profile discovery shells out, so a slow or missing CLI degrades to an
    // empty list rather than failing the whole page.
    profiles: await listProfiles().catch(() => []),
    remote: remoteStatus(),
  })
})

agentApi.post('/registry/rescan', c => c.json(rescan()))
agentApi.post('/skills/reindex', c => c.json(reindexSkills()))

agentApi.get('/repos', c => c.json({ repos: listRepos() }))
agentApi.get('/repos/search', c => c.json({ repos: searchRepos(c.req.query('q') ?? '', 10) }))

/** What routing WOULD pick — powers the inspector's preview before sending. */
agentApi.get('/route', c => {
  const mode = c.req.query('mode') ?? 'triage'
  return c.json(
    routeSkills({
      mode: isMode(mode) ? mode : 'triage',
      prompt: c.req.query('q') ?? '',
      repoPath: c.req.query('repo') ?? null,
    }),
  )
})

/* ----------------------------- conversations ------------------------------ */

agentApi.get('/conversations', c => {
  const rows = db
    .query<Record<string, any>, []>(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conv_id = c.id) AS messages
       FROM conversations c WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 100`,
    )
    .all()
  return c.json({ conversations: rows })
})

agentApi.post('/conversations', async c => {
  const b = await c.req.json().catch(() => ({}))
  const id = uid()
  const at = now()
  const mode = isMode(b.mode ?? '') ? b.mode : 'triage'
  db.query(
    `INSERT INTO conversations (id, title, mode, repo_path, profile, model, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, b.title ?? 'New conversation', mode, b.repo_path ?? null, b.profile ?? null, b.model ?? null, at, at)
  return c.json({ id, mode })
})

agentApi.get('/conversations/:id', c => {
  const id = c.req.param('id')
  const conv = db.query<Record<string, any>, [string]>(`SELECT * FROM conversations WHERE id = ?`).get(id)
  if (!conv) return c.json(bad('no such conversation'), 404)

  const messages = db
    .query<Record<string, any>, [string]>(`SELECT * FROM messages WHERE conv_id = ? ORDER BY seq`)
    .all(id)
    .map(m => ({ ...m, segments: safeJson(m.segments, []) }))

  const turns = db
    .query<Record<string, any>, [string]>(
      `SELECT id, state, mode, skills_used, cost_usd, num_turns, error, started_at, finished_at
       FROM turns WHERE conv_id = ? ORDER BY started_at`,
    )
    .all(id)
    .map(t => ({ ...t, skills_used: safeJson<string[]>(t.skills_used, []) }) as Record<string, any>)

  const live = turns.find(t => t.state === 'running' && isRunning(String(t.id)))

  return c.json({
    conversation: conv,
    messages,
    turns,
    pending: listPending(id).map(p => ({ ...p, payload: safeJson(p.payload, {}) })),
    activeTurnId: live ? String(live.id) : null,
  })
})

agentApi.patch('/conversations/:id', async c => {
  const b = await c.req.json().catch(() => ({}))
  const id = c.req.param('id')
  const fields: string[] = []
  const values: Array<string | number | null> = []
  for (const k of ['title', 'mode', 'repo_path', 'profile', 'model'] as const) {
    if (b[k] === undefined) continue
    if (k === 'mode' && !isMode(b[k])) return c.json(bad(`unknown mode "${b[k]}"`), 400)
    fields.push(`${k} = ?`)
    values.push(b[k])
  }
  if (!fields.length) return c.json(bad('nothing to update'), 400)
  db.query(`UPDATE conversations SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...([...values, now(), id] as (string | number | null)[]))
  return c.json({ ok: true })
})

agentApi.delete('/conversations/:id', c => {
  db.query(`UPDATE conversations SET archived_at = ? WHERE id = ?`).run(now(), c.req.param('id'))
  return c.json({ ok: true })
})

/* --------------------------------- turns ---------------------------------- */

agentApi.post('/conversations/:id/turns', async c => {
  const b = await c.req.json().catch(() => ({}))
  const prompt = String(b.prompt ?? '').trim()
  if (!prompt) return c.json(bad('prompt is required'), 400)

  const convId = c.req.param('id')
  const already = db
    .query<{ id: string }, [string]>(`SELECT id FROM turns WHERE conv_id = ? AND state = 'running'`)
    .all(convId)
    .find(t => isRunning(t.id))
  if (already) return c.json(bad('a turn is already running in this conversation'), 409)

  try {
    return c.json(startTurn({ convId, prompt, mode: isMode(b.mode ?? '') ? b.mode : undefined }))
  } catch (e) {
    return c.json(bad((e as Error).message), 400)
  }
})

agentApi.post('/turns/:id/cancel', c => c.json({ cancelled: cancelTurn(c.req.param('id')) }))

agentApi.get('/turns/:id', c => {
  const t = db.query<Record<string, any>, [string]>(`SELECT * FROM turns WHERE id = ?`).get(c.req.param('id'))
  if (!t) return c.json(bad('no such turn'), 404)
  return c.json({ turn: { ...t, skills_used: safeJson(t.skills_used, []) }, segments: foldSegments(t.id) })
})

const HEARTBEAT_MS = 15_000

agentApi.get('/turns/:id/events', c => {
  const turnId = c.req.param('id')
  const after = Number(c.req.query('after') ?? 0) || 0

  const turn = db.query<Record<string, any>, [string]>(`SELECT * FROM turns WHERE id = ?`).get(turnId)
  if (!turn) return c.json(bad('no such turn'), 404)

  return streamSSE(c, async stream => {
    let closed = false
    stream.onAbort(() => {
      closed = true
    })

    const send = async (e: { seq: number; type: string; payload: Record<string, unknown> }) => {
      if (closed) return
      await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify({ ...e.payload, seq: e.seq }) })
    }

    // Buffer anything that lands while the backlog is draining, so a fast turn
    // cannot slip an event between the replay and the subscription.
    const queued: Array<{ seq: number; type: string; payload: Record<string, unknown> }> = []
    let draining = true
    const unsubscribe = subscribe(turnId, e => {
      if (draining) queued.push(e)
      else void send(e)
    })

    try {
      let cursor = after
      for (const e of eventsSince(turnId, after)) {
        await send(e)
        cursor = e.seq
      }
      for (const e of queued) {
        if (e.seq > cursor) await send(e)
      }
      draining = false

      // Already finished before the client connected: replay, then close.
      const fresh = db
        .query<{ state: string }, [string]>(`SELECT state FROM turns WHERE id = ?`)
        .get(turnId)
      if (fresh && fresh.state !== 'running') {
        await stream.writeSSE({ event: 'closed', data: JSON.stringify({ state: fresh.state }) })
        return
      }

      while (!closed) {
        await stream.sleep(HEARTBEAT_MS)
        if (closed) break
        const row = db.query<{ state: string }, [string]>(`SELECT state FROM turns WHERE id = ?`).get(turnId)
        if (!row || row.state !== 'running') {
          await stream.writeSSE({ event: 'closed', data: JSON.stringify({ state: row?.state ?? 'gone' }) })
          break
        }
        await stream.writeSSE({ event: 'ping', data: '{}' })
      }
    } finally {
      unsubscribe()
    }
  })
})

/* ------------------------------- approvals -------------------------------- */

agentApi.get('/approvals', c =>
  c.json({ pending: listPending(c.req.query('conv') ?? undefined).map(p => ({ ...p, payload: safeJson(p.payload, {}) })) }),
)

agentApi.post('/approvals/:id', async c => {
  const b = await c.req.json().catch(() => ({}))
  const state = b.state === 'approved' || b.approve === true ? 'approved' : 'denied'
  const r = resolveApproval(c.req.param('id'), state, b.answer)
  return r.ok ? c.json(r) : c.json(bad(r.error ?? 'could not resolve'), 400)
})

/* --------------------------------- audit ---------------------------------- */

agentApi.get('/audit', c => {
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)
  return c.json({
    commands: db
      .query<Record<string, any>, [number]>(
        `SELECT id, turn_id, profile, argv, class, exit_code, ms, ok, at FROM cli_audit ORDER BY id DESC LIMIT ?`,
      )
      .all(limit)
      .map(r => ({ ...r, argv: safeJson(r.argv, []) })),
    backups: db
      .query<Record<string, any>, [number]>(
        `SELECT id, resource, ref, profile, applied_at, at FROM admin_backups ORDER BY at DESC LIMIT ?`,
      )
      .all(limit),
    // Sessions Wake starts are launch packs now; `eng_sessions` was dropped by
    // migration 2 and reading it here threw on the boot that applied it.
    launches: db
      .query<Record<string, any>, [number]>(
        `SELECT id, template, title, cwd, repo_name, session_id, status, error, created_at, launched_at, finished_at
         FROM launch_packs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit),
  })
})

function safeJson<T>(v: string | null, fallback: T): T {
  try {
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

/** Called once at boot. Nothing survives a restart except the record of it. */
export function bootAgent() {
  const interrupted = recoverInterrupted()
  const expired = expireOrphans()
  const packs = recoverPacks()
  const repos = rescan()
  const skills = reindexSkills()
  return {
    interrupted, expired, packs,
    repos: repos.scanned,
    skills: skills.indexed,
    key: keyStatus(),
    launcher: launcherStatus(),
  }
}
