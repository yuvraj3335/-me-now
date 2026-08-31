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
import { archivedSessionIds, audit, db, setSessionArchived } from '../db'
import {
  deleteSession, getSession, listAllSessions, liveSessions, sessionExcerpt, sessionFilePaths,
} from '../sources/claudeSessions'
import { listRepos } from '../registry/scan'
import {
  DEFAULT_PERMISSION_MODE, buildPack, getPack, listPacks, openPack, parsePermissionMode, resolveCwd,
} from './launch'
import { handoffConfig } from './handoff'
import { issueConfirmation, useConfirmation } from '../security'
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
    // `title` and `description` ride along because the picker had nothing
    // human to render: a catalog letter and a hyphenated slug is a filename,
    // and 28 filenames is not a list anybody reads.
    skills: listSkills().map(s => ({
      id: s.id,
      name: s.name,
      catalog: s.catalog,
      title: s.title,
      description: s.description?.slice(0, 240) ?? null,
      whenToUse: s.when_to_use?.slice(0, 200) ?? null,
      mutating: !!s.mutating,
    })),
    sessions: sessionRows({ windowDays: 30, limit: 30 }),
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    packs: listPacks(20),
  }),
)

/**
 * Sessions, with the two facts a transcript cannot carry.
 *
 * A transcript's mtime says it was written to recently, which a *finished*
 * session satisfies just as well as a running one. `liveSessions()` reads the
 * per-process files Claude Code keeps, and that is the only place "right now"
 * is actually recorded.
 *
 * `archived` is the other direction: nothing on disk records that he is done
 * with a session, so it is Wake's own state, joined on here rather than inside
 * the filesystem source. That file's whole job is to say what the disk says,
 * and an opinion Wake holds is not that.
 */
function sessionRows(opts: { windowDays?: number; repo?: string; limit?: number }) {
  const live = liveSessions()
  const archived = archivedSessionIds()
  return listAllSessions(opts).map(s => ({
    ...s, live: live.has(s.id), archived: archived.has(s.id),
  }))
}

claudecode.get('/sessions', c => {
  const all = c.req.query('all') === '1'
  return c.json({
    sessions: sessionRows({
      // `all` widens the window rather than removing it: "every session on this
      // machine" is 130 transcript tails, and the page that asks for it is a
      // list, not an archive.
      windowDays: Number(c.req.query('window')) || (all ? 365 : 30),
      repo: c.req.query('repo') || undefined,
      limit: Number(c.req.query('limit')) || (all ? 500 : 30),
    }),
  })
})

claudecode.get('/sessions/:id', c => {
  const id = c.req.param('id')
  const s = getSession(id)
  if (!s) return c.json(bad('no such session on this machine'), 404)
  const excerpt = sessionExcerpt(id, 4_000)
  return c.json({
    session: { ...s, live: liveSessions().has(id) },
    excerpt: excerpt.found ? excerpt.text ?? '' : '',
    paths: sessionFilePaths(id),
  })
})

/**
 * Put a session away, or take it back out.
 *
 * Deliberately nothing like the delete below it. Archiving writes one row in
 * Wake's own database and touches no file on this machine, so it needs no
 * confirmation token, it is reversible by the same call with `archived: false`,
 * and — unlike the delete — it is allowed while the session is *running*. That
 * last one is the point rather than an oversight: the delete is refused for a
 * live session because unlinking a transcript out from under its own process
 * destroys a conversation still being had, and none of that is true of an
 * opinion about whether he wants to see it in a list.
 *
 * The session still has to exist. Without that check this route is a way to
 * write a row per POST for ids that name nothing.
 */
claudecode.post('/sessions/:id/archive', async c => {
  const id = c.req.param('id')
  if (!getSession(id)) return c.json(bad('no such session on this machine'), 404)

  const b = await c.req.json<{ archived?: boolean }>().catch(() => ({}) as { archived?: boolean })
  // Absent means archive: the route is named for the thing it does, and only an
  // explicit `false` asks for the reverse.
  const archived = b.archived !== false
  setSessionArchived(id, archived)
  return c.json({ ok: true, archived })
})

/**
 * Step one of a delete: name the files, and mint a token bound to this id.
 *
 * The dialog shows these paths back verbatim. All four are under `~/.claude`,
 * outside Wake's own data directory, and `file-history/<uuid>` is Claude Code's
 * edit-undo history for real source files — so this is the one delete in the
 * product where "are you sure" has to mean "here is what goes".
 */
claudecode.post('/sessions/:id/delete/confirm', c => {
  const id = c.req.param('id')
  const s = getSession(id)
  if (!s) return c.json(bad('no such session on this machine'), 404)
  const live = liveSessions().get(id)
  if (live) return c.json(bad(`that session is running right now (pid ${live.pid}) — close it first`), 409)

  const { token, expiresAt } = issueConfirmation('launch', { sessionId: id }, `delete session ${id}`)
  return c.json({ token, expiresAt, paths: sessionFilePaths(id), title: s.title })
})

/**
 * Delete a session's files. Irreversible, and gated.
 *
 * Deliberately unlike `DELETE /packs/:id` below it, which is unguarded: that one
 * removes two files Wake itself wrote inside its own `PACK_DIR`. This one
 * removes a transcript, its sidecar directory, its environment and its
 * file-history from under `~/.claude`. Copying the pack route here would have
 * put an irreversible delete of somebody else's data behind a single click.
 */
claudecode.delete('/sessions/:id', async c => {
  const id = c.req.param('id')
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string })
  const token = c.req.query('token') ?? body.token ?? ''

  const check = useConfirmation(token, 'launch', { sessionId: id })
  if (!check.ok) {
    audit('claude.session.delete', { target: id, ok: false, error: check.reason })
    return c.json(bad(check.reason), 409)
  }

  const removed = deleteSession(id)
  if (removed.error) {
    audit('claude.session.delete', { target: id, ok: false, error: removed.error })
    return c.json(bad(removed.error), 409)
  }
  // The files are gone, so any opinion Wake held about them goes too. A uuid is
  // never reissued, so this row could only ever be a leak.
  setSessionArchived(id, false)
  audit('claude.session.delete', { target: id, detail: { removed: removed.removed, kept: removed.kept } })
  return c.json({ ok: true, ...removed })
})

claudecode.post('/packs', async c => {
  const b = await c.req.json<any>().catch(() => ({}))
  const templates = Array.isArray(b.templates) && b.templates.length
    ? b.templates.map(String)
    : [String(b.template ?? 'blank')]
  // Refused by name rather than quietly defaulted: this string is rendered into
  // a command line the reader is invited to paste, so an unrecognised one is a
  // mistake to report, not a value to substitute.
  const mode = parsePermissionMode(b.permissionMode)
  if ('error' in mode) return c.json(bad(mode.error), 400)

  const built = buildPack({
    template: templates[0]!,
    templates,
    title: b.title,
    cwd: b.cwd ?? null,
    instruction: b.instruction,
    items: Array.isArray(b.items) ? b.items : [],
    skills: Array.isArray(b.skills) ? b.skills.map(String) : undefined,
    sessionId: typeof b.sessionId === 'string' ? b.sessionId : null,
    permissionMode: mode.mode,
  })
  if ('error' in built) return c.json(bad(built.error), 400)
  audit('claude.pack', {
    target: built.title,
    detail: {
      templates: built.templates, cwd: built.cwd, items: built.items.length,
      sessionId: built.sessionId, permissionMode: built.permissionMode,
    },
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
