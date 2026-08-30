/**
 * "Open in Claude" over HTTP.
 *
 * Two steps on purpose. `POST /packs` writes the brief and returns what it
 * contains; `POST /packs/:id/open` marks it handed over and returns the link.
 * Splitting them means you can read exactly what is about to be sent — which
 * objects, which instruction, how much of it fits — before anything leaves, and
 * the file on disk is the same text the link carries.
 */

import { Hono } from 'hono'
import { unlinkSync } from 'node:fs'
import { audit, db } from '../db'
import { listSessions } from '../sources/claudeSessions'
import { listRepos } from '../registry/scan'
import { buildPack, getPack, listPacks, openPack, resolveCwd } from './launch'
import { handoffConfig } from './handoff'
import { listSkills } from '../skills/catalog'
import { TEMPLATES } from './templates'

export const claudecode = new Hono()

const bad = (m: string) => ({ error: m })

claudecode.get('/state', c =>
  c.json({
    // The browser builds the link itself as you edit, so it needs the whole
    // config rather than a summary of it — one implementation of "how much
    // fits", in src/shared/handoff.ts, used on both sides.
    handoff: handoffConfig(),
    templates: TEMPLATES.map(t => ({
      id: t.id,
      label: t.label,
      blurb: t.blurb,
      slots: t.slots,
      skills: t.skills,
      defaultRepo: t.defaultRepo,
      instruction: t.instruction,
    })),
    // Only repositories the registry scanned can be named in a brief, so the
    // picker shows exactly the set the server will accept.
    repos: listRepos().map(r => ({ name: r.name, path: r.path, role: r.role, branch: r.branch, dirty: r.dirty })),
    // Metadata only, and small: the composer offers these as chips so a brief
    // can name a skill its template did not think of.
    skills: listSkills().map(s => ({
      id: s.id,
      name: s.name,
      catalog: s.catalog,
      whenToUse: s.when_to_use?.slice(0, 200) ?? null,
      mutating: !!s.mutating,
    })),
    sessions: listSessions(30, 30),
    packs: listPacks(20),
  }),
)

claudecode.get('/sessions', c => c.json({ sessions: listSessions(Number(c.req.query('limit')) || 30, 60) }))

claudecode.post('/packs', async c => {
  const b = await c.req.json<any>().catch(() => ({}))
  const templates = Array.isArray(b.templates) && b.templates.length
    ? b.templates.map(String)
    : [String(b.template ?? 'blank')]
  const built = buildPack({
    template: templates[0]!,
    templates,
    title: b.title,
    cwd: b.cwd ?? null,
    instruction: b.instruction,
    items: Array.isArray(b.items) ? b.items : [],
    skills: Array.isArray(b.skills) ? b.skills.map(String) : undefined,
  })
  if ('error' in built) return c.json(bad(built.error), 400)
  audit('claude.pack', {
    target: built.title,
    detail: { templates: built.templates, cwd: built.cwd, items: built.items.length },
  })
  return c.json(getPack(built.id))
})

claudecode.get('/packs', c => c.json({ packs: listPacks(Number(c.req.query('limit')) || 30) }))

claudecode.get('/packs/:id', c => {
  const p = getPack(c.req.param('id'))
  return p ? c.json(p) : c.json(bad('no such pack'), 404)
})

/** The brief itself, so "open the pack" shows the real text that was handed over. */
claudecode.get('/packs/:id/file', async c => {
  const p = getPack(c.req.param('id'))
  if (!p?.pack_path) return c.json(bad('no such pack'), 404)
  const file = Bun.file(p.pack_path)
  if (!(await file.exists())) return c.json(bad('the pack file is no longer on disk'), 410)
  return c.newResponse(await file.text(), 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
})

/**
 * Hand it over. The body may carry the edited brief, which becomes the record:
 * the row, the file and the link all move to what was actually approved.
 */
claudecode.post('/packs/:id/open', async c => {
  const b = await c.req.json<{ brief?: string }>().catch(() => ({}) as { brief?: string })
  const r = openPack(c.req.param('id'), typeof b.brief === 'string' ? b.brief : undefined)
  return 'error' in r ? c.json(bad(r.error), 404) : c.json(r)
})

/**
 * Delete a pack, and the files that are the pack.
 *
 * This used to remove the row and leave the `.md` and the `.json` on disk —
 * four such orphans were found and cleaned up by hand. A brief is a real file
 * containing quoted provider text and whatever an excerpt carried into it;
 * deleting the record and keeping the document is the wrong half.
 */
claudecode.delete('/packs/:id', c => {
  const id = c.req.param('id')
  const pack = getPack(id)
  db.query(`DELETE FROM launch_packs WHERE id = ?`).run(id)
  for (const f of [pack?.pack_path, pack?.pack_path?.replace(/\.md$/, '.json')]) {
    if (!f) continue
    try { unlinkSync(f) } catch { /* already gone is the state we wanted */ }
  }
  return c.json({ ok: true })
})

/** Used by the launch sheet to validate a chosen repository before offering Open. */
claudecode.get('/cwd', c => {
  const r = resolveCwd(c.req.query('path'))
  return r.ok ? c.json({ ok: true, path: r.path, repo: r.repo }) : c.json({ ok: false, error: r.error })
})
