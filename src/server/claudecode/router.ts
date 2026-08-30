/**
 * "Open in Claude Code" over HTTP.
 *
 * Two steps on purpose. `POST /packs` writes the pack and returns what it
 * contains; `POST /packs/:id/launch` starts the session. Splitting them means
 * the person can read exactly what is about to be handed over — which objects,
 * which directory, which instruction — before anything runs, and the pack file
 * on disk is the same text the session received.
 */

import { Hono } from 'hono'
import { audit, db } from '../db'
import { listSessions } from '../sources/claudeSessions'
import { listRepos } from '../registry/scan'
import { buildPack, getPack, launcherStatus, launchPack, listPacks, resolveCwd, stopLaunch } from './launch'
import { TEMPLATES } from './templates'

export const claudecode = new Hono()

const bad = (m: string) => ({ error: m })

claudecode.get('/state', c =>
  c.json({
    status: launcherStatus(),
    templates: TEMPLATES.map(t => ({
      id: t.id,
      label: t.label,
      blurb: t.blurb,
      slots: t.slots,
      skills: t.skills,
      defaultRepo: t.defaultRepo,
      instruction: t.instruction,
    })),
    // Only repositories the registry scanned can host a session, so the picker
    // shows exactly the set the server will accept.
    repos: listRepos().map(r => ({ name: r.name, path: r.path, role: r.role, branch: r.branch, dirty: r.dirty })),
    sessions: listSessions(30, 30),
    packs: listPacks(20),
  }),
)

claudecode.get('/sessions', c => c.json({ sessions: listSessions(Number(c.req.query('limit')) || 30, 60) }))

claudecode.post('/packs', async c => {
  const b = await c.req.json<any>().catch(() => ({}))
  const built = buildPack({
    template: String(b.template ?? 'blank'),
    title: b.title,
    cwd: b.cwd ?? null,
    instruction: b.instruction,
    items: Array.isArray(b.items) ? b.items : [],
    resumeSessionId: b.resumeSessionId ?? null,
  })
  if ('error' in built) return c.json(bad(built.error), 400)
  audit('claude.pack', { target: built.title, detail: { template: built.template, cwd: built.cwd, items: built.items.length } })
  return c.json(getPack(built.id))
})

claudecode.get('/packs', c => c.json({ packs: listPacks(Number(c.req.query('limit')) || 30) }))

claudecode.get('/packs/:id', c => {
  const p = getPack(c.req.param('id'))
  return p ? c.json(p) : c.json(bad('no such pack'), 404)
})

/** The pack file itself, so "Open pack" shows the real text that was handed over. */
claudecode.get('/packs/:id/file', async c => {
  const p = getPack(c.req.param('id'))
  if (!p?.pack_path) return c.json(bad('no such pack'), 404)
  const file = Bun.file(p.pack_path)
  if (!(await file.exists())) return c.json(bad('the pack file is no longer on disk'), 410)
  return c.newResponse(await file.text(), 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
})

claudecode.post('/packs/:id/launch', c => {
  const r = launchPack(c.req.param('id'))
  return r.launched ? c.json(r) : c.json(bad(r.error ?? 'could not launch'), 409)
})

claudecode.post('/packs/:id/stop', c => c.json({ stopped: stopLaunch(c.req.param('id')) }))

claudecode.delete('/packs/:id', c => {
  db.query(`DELETE FROM launch_packs WHERE id = ?`).run(c.req.param('id'))
  return c.json({ ok: true })
})

/** Used by the launch sheet to validate a chosen directory before offering Open. */
claudecode.get('/cwd', c => {
  const r = resolveCwd(c.req.query('path'))
  return r.ok ? c.json({ ok: true, path: r.path, repo: r.repo }) : c.json({ ok: false, error: r.error })
})
