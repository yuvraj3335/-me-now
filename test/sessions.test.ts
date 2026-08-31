/**
 * Claude Code sessions, as Wake reads them off the disk — and the one thing
 * about them that is Wake's own.
 *
 * Four things here are easy to break and impossible to notice: the directory a
 * session is filed under is a *lossy* encoding of where it ran, the list the
 * Sessions page renders must not be the newest-N-files list the card pile
 * wants, `?repo=` has to name one repository rather than four that share a
 * prefix, and deleting one removes files under `~/.claude` that nothing else in
 * this product touches.
 *
 * Archive is the fifth, and it is a different kind of fact: Claude Code has no
 * archive, so it lives in Wake's database and is joined onto rows read off the
 * disk. The tests for it are about that seam — the flag reaching the row, the
 * two directions being reversible, and archiving being allowed exactly where
 * deleting is refused.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { CLAUDE_HOME, CLAUDE_PROJECTS_DIR, FETCH_RUN_DIR } from '../src/server/env'
import {
  deleteSession, getSession, listAllSessions, listSessions, liveSessions, sessionFilePaths,
} from '../src/server/sources/claudeSessions'
import { archivedSessionIds, setSessionArchived } from '../src/server/db'
import { claudecode } from '../src/server/claudecode/router'
import {
  ALL_REPOS, chooseRepo, matchesView, readView, repoIdOf, repoList,
} from '../src/web/components/sessions'

const app = new Hono()
app.route('/api/claude', claudecode)
const call = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://localhost:8585/api/claude${path}`, init))

/** The same flattening Claude Code does when it files a transcript. */
const flatten = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * A transcript with two user turns.
 *
 * `cwd` is written on the turns rather than in a header because that is where
 * Claude Code actually puts it — and `undefined` is the real case this file
 * cares about, since it is the only one where the filename has to be read.
 */
function transcript(cwd: string | null, prompt: string, branch?: string) {
  const turn = {
    type: 'user',
    ...(cwd ? { cwd } : {}),
    ...(branch ? { gitBranch: branch, permissionMode: 'bypassPermissions', version: '2.1.247' } : {}),
    message: { role: 'user', content: prompt },
  }
  return [turn, { ...turn, message: { role: 'user', content: 'carry on' } },
    { type: 'last-prompt', lastPrompt: prompt }].map(l => JSON.stringify(l)).join('\n')
}

/** Write a transcript into `project`, with a chosen age so ordering is exact. */
function write(project: string, id: string, body: string, ageDays = 1) {
  const dir = `${CLAUDE_PROJECTS_DIR}/${project}`
  mkdirSync(dir, { recursive: true })
  const path = `${dir}/${id}.jsonl`
  writeFileSync(path, body)
  const at = (Date.now() - ageDays * 864e5) / 1000
  utimesSync(path, at, at)
  return path
}

const OLD_CWD = '/Users/me/work/truto-app'
const OLD_PROJECT = flatten(OLD_CWD)
/** `OLD_CWD` with its suffix removed — a real, different repository. */
const PREFIX_CWD = '/Users/me/work/truto'

beforeAll(() => {
  // Own the fixture directory outright. Every caller in this file counts rows,
  // and a transcript another suite left behind would make those counts a
  // property of test ordering.
  rmSync(CLAUDE_PROJECTS_DIR, { recursive: true, force: true })
  mkdirSync(CLAUDE_PROJECTS_DIR, { recursive: true })
  rmSync(`${CLAUDE_HOME}/sessions`, { recursive: true, force: true })

  // 40 recent sessions in one busy project, so any newest-N slice fills up
  // before it reaches anything else.
  for (let i = 0; i < 40; i++) {
    write(flatten('/Users/me/work/busy'), uuid(i), transcript('/Users/me/work/busy', `busy ${i}`), 1)
  }
  // One in a quiet repository, older than every one of them.
  write(flatten('/Users/me/work/quiet'), uuid(100), transcript('/Users/me/work/quiet', 'the quiet one'), 20)
  // One filed under a dashed repository, recording where it really ran.
  write(OLD_PROJECT, uuid(101), transcript(OLD_CWD, 'dashed repo', 'feat/x'), 2)
  // And its prefix, which is a different repository with a very similar name.
  // This pair is the whole point of the repo filter being exact: on the real
  // machine `truto`, `truto-app`, `truto-monitoring` and `truto-skills` all
  // live side by side under one parent.
  write(flatten(PREFIX_CWD), uuid(105), transcript(PREFIX_CWD, 'the shorter name'), 2)
  // One that never recorded a cwd, so only the filename is left.
  write(OLD_PROJECT, uuid(102), transcript(null, 'no cwd recorded'), 2)
  // One Wake ran itself.
  write(flatten(FETCH_RUN_DIR), uuid(103), transcript(FETCH_RUN_DIR, 'collect from slack'), 1)
  // One older than any window a list would use.
  write(flatten('/Users/me/work/ancient'), uuid(104), transcript('/Users/me/work/ancient', 'last year'), 400)
})

afterAll(() => {
  rmSync(CLAUDE_PROJECTS_DIR, { recursive: true, force: true })
  rmSync(`${CLAUDE_HOME}/sessions`, { recursive: true, force: true })
})

describe('where a session ran', () => {
  test('the recorded cwd wins over the name it is filed under', () => {
    const s = listAllSessions({ repo: 'truto-app', limit: 50 }).find(x => x.id === uuid(101))!
    expect(s).toBeTruthy()
    // `-Users-me-work-truto-app` → `/Users/me/work/truto/app` was the old
    // reconstruction, and it names a directory that does not exist.
    expect(s.cwd).toBe(OLD_CWD)
    expect(s.project).toBe('truto-app')
  })

  test('with no recorded cwd the filed name is kept, not turned into a path', () => {
    const s = listAllSessions({ repo: OLD_PROJECT, limit: 50 }).find(x => x.id === uuid(102))!
    expect(s).toBeTruthy()
    expect(s.cwd).toBe(OLD_PROJECT)
    expect(s.cwd, 'the dash reconstruction came back').not.toContain('/truto/app')
  })

  test('the branch and the mode of the last turn come through', () => {
    const s = getSession(uuid(101))!
    expect(s.branch).toBe('feat/x')
    expect(s.permissionMode).toBe('bypassPermissions')
    expect(s.version).toBe('2.1.247')
  })
})

describe('which sessions are listed', () => {
  test('a quiet repository is not buried by a busy one', () => {
    // The card pile wants the newest handful and slices before parsing. A page
    // whose whole job is "my sessions in this repository" cannot: the newest 30
    // files are all from one directory, so every other repository read empty.
    expect(listSessions(30, 30).map(s => s.id)).not.toContain(uuid(100))
    expect(listAllSessions({ limit: 500 }).map(s => s.id)).toContain(uuid(100))
    expect(listAllSessions({ repo: 'quiet' }).map(s => s.id)).toEqual([uuid(100)])
  })

  test('Wake’s own collection runs are never offered', () => {
    const ids = listAllSessions({ limit: 500 }).map(s => s.id)
    expect(ids, 'Wake is quoting its own paperwork back to itself').not.toContain(uuid(103))
    expect(getSession(uuid(103))).toBeNull()
  })

  test('the window bounds the list, and never the lookup', () => {
    // A session named by id is looked up over all of history — the window
    // exists to keep the list short, not to decide what may be opened.
    expect(listAllSessions({ windowDays: 30, limit: 500 }).map(s => s.id)).not.toContain(uuid(104))
    expect(getSession(uuid(104))?.id).toBe(uuid(104))
  })

  test('the limit bounds the answer without reordering it', () => {
    const three = listAllSessions({ limit: 3 })
    expect(three).toHaveLength(3)
    const all = listAllSessions({ limit: 500 })
    expect(three.map(s => s.id)).toEqual(all.slice(0, 3).map(s => s.id))
  })
})

describe('which repository a session is in', () => {
  test('a repository is named exactly, not by prefix', () => {
    // The live symptom this replaces: `?repo=truto` answered with `truto`,
    // `truto-app`, `truto-monitoring` and `truto-skills` — four of the five
    // repositories with sessions on the machine — because the filter was a
    // substring test over `cwd` and `project` joined together. A picker built
    // on that can narrow to everything or to nothing, never to one repository.
    expect(listAllSessions({ repo: 'truto', limit: 500 }).map(s => s.id)).toEqual([uuid(105)])
    expect(listAllSessions({ repo: PREFIX_CWD, limit: 500 }).map(s => s.id)).toEqual([uuid(105)])
    expect(listAllSessions({ repo: 'truto-app', limit: 500 }).map(s => s.id)).toEqual([uuid(101)])
  })

  test('both real names for a place are accepted', () => {
    // The recorded working directory, and the basename it is listed under.
    // Neither is more correct than the other; the picker sends the first and a
    // hand-typed `?repo=` is usually the second.
    const byPath = listAllSessions({ repo: '/Users/me/work/quiet', limit: 500 })
    const byName = listAllSessions({ repo: 'QUIET', limit: 500 })
    expect(byPath.map(s => s.id)).toEqual([uuid(100)])
    expect(byName.map(s => s.id), 'the match stopped being case-insensitive').toEqual([uuid(100)])
  })

  test('the id the picker sends is the id the server answers for', () => {
    // The client derives a repository id from a row (`repoIdOf`) and hands it
    // straight back as `?repo=`. If the two ever disagree about what names a
    // place, every session in the picker leads to an empty list — and the one
    // row that would prove it is the session that never recorded a `cwd`,
    // whose id is a flattened directory name rather than a path.
    const interesting = [uuid(101), uuid(102), uuid(105)]
    const rows = listAllSessions({ limit: 500 }).filter(r => interesting.includes(r.id))
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(
        listAllSessions({ repo: repoIdOf(row), limit: 500 }).map(s => s.id),
        `${row.id} cannot be found under its own repository`,
      ).toContain(row.id)
    }
  })
})

describe('archiving a session', () => {
  const id = uuid(105)

  const markLiveAs = (pid: number, sessionId: string) => {
    mkdirSync(`${CLAUDE_HOME}/sessions`, { recursive: true })
    writeFileSync(
      `${CLAUDE_HOME}/sessions/${pid}.json`,
      JSON.stringify({ pid, sessionId, cwd: PREFIX_CWD, startedAt: Date.now() }),
    )
  }

  test('a row means archived, and taking it back out removes the row', () => {
    setSessionArchived(id, true)
    expect(archivedSessionIds().has(id)).toBe(true)
    // Twice is once. The button is idempotent in both directions, because the
    // list it acts on can be a few seconds old.
    setSessionArchived(id, true)
    expect([...archivedSessionIds()].filter(x => x === id)).toHaveLength(1)

    setSessionArchived(id, false)
    expect(archivedSessionIds().has(id), 'un-archiving left a row behind').toBe(false)
  })

  test('the flag rides the rows the list already returns', async () => {
    const rows = async () => {
      const r = await call('/sessions?all=1')
      return (await r.json() as { sessions: Array<{ id: string; archived: boolean }> }).sessions
    }

    expect((await rows()).find(s => s.id === id)?.archived).toBe(false)

    const on = await call(`/sessions/${id}/archive`, { method: 'POST', body: '{}' })
    expect(on.status).toBe(200)
    expect(await on.json()).toMatchObject({ archived: true })

    const after = await rows()
    expect(after.find(s => s.id === id)?.archived).toBe(true)
    expect(
      after.filter(s => s.archived).map(s => s.id),
      'archiving one session moved another',
    ).toEqual([id])

    const off = await call(`/sessions/${id}/archive`, {
      method: 'POST', body: JSON.stringify({ archived: false }),
    })
    expect(await off.json()).toMatchObject({ archived: false })
    expect((await rows()).find(s => s.id === id)?.archived).toBe(false)
  })

  test('a running session can be archived, and still cannot be deleted', async () => {
    // The whole reason these are two different actions. Deleting a live
    // transcript destroys a conversation that is still being had; archiving it
    // writes one row in Wake's own database and touches nothing on disk, so
    // there is nothing for the live check to protect.
    markLiveAs(5150, id)
    expect(liveSessions().has(id)).toBe(true)

    expect((await call(`/sessions/${id}/archive`, { method: 'POST', body: '{}' })).status).toBe(200)
    expect(archivedSessionIds().has(id)).toBe(true)

    const refused = await call(`/sessions/${id}/delete/confirm`, { method: 'POST', body: '{}' })
    expect(refused.status).toBe(409)

    rmSync(`${CLAUDE_HOME}/sessions/5150.json`, { force: true })
    setSessionArchived(id, false)
  })

  test('an id that names nothing on this machine is refused', async () => {
    const r = await call(`/sessions/${uuid(999)}/archive`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(404)
    expect(archivedSessionIds().has(uuid(999)), 'a row was written for a session that does not exist')
      .toBe(false)
  })

  test('deleting a session forgets that it was archived', async () => {
    const gone = uuid(400)
    write(flatten('/Users/me/work/gone'), gone, transcript('/Users/me/work/gone', 'archive, then delete'))
    setSessionArchived(gone, true)
    expect(archivedSessionIds().has(gone)).toBe(true)

    const minted = await call(`/sessions/${gone}/delete/confirm`, { method: 'POST', body: '{}' })
    const { token } = await minted.json() as { token: string }
    expect((await call(`/sessions/${gone}?token=${token}`, { method: 'DELETE' })).status).toBe(200)

    // A uuid is never reissued, so a row left here could only ever be a leak.
    expect(archivedSessionIds().has(gone), 'a row outlived the session it described').toBe(false)
  })
})

describe('what the page shows, before it is rendered', () => {
  test('Active is what he opens on, and it hides what he put away', () => {
    expect(readView(null)).toBe('active')
    expect(readView('nonsense')).toBe('active')
    expect(readView('archived')).toBe('archived')
    expect(readView('all')).toBe('all')

    // A row from before this release carries no flag at all, and an absent
    // flag is not an archived session.
    const rows = [{ archived: false }, { archived: true }, {}]
    expect(rows.filter(r => matchesView(r, 'active'))).toHaveLength(2)
    expect(rows.filter(r => matchesView(r, 'archived'))).toHaveLength(1)
    expect(rows.filter(r => matchesView(r, 'all'))).toHaveLength(3)
  })

  test('the picker lists every repository that has a session, and counts it once', () => {
    const rows = listAllSessions({ limit: 500 })
    const repos = repoList(rows)

    expect(new Set(repos.map(r => r.id)).size, 'a repository is offered twice').toBe(repos.length)
    expect(repos.reduce((n, r) => n + r.count, 0), 'a session belongs to no repository')
      .toBe(rows.length)
    expect(repos.map(r => r.id)).toContain(PREFIX_CWD)
    // Newest first, because that is what "the repository you were last in"
    // means and it is what the page falls back to.
    expect(repos[0]!.id).toBe('/Users/me/work/busy')
  })

  test('the first paint is a repository, never the whole machine', () => {
    const repos = repoList(listAllSessions({ limit: 500 }))

    expect(chooseRepo(null, null, repos)).toBe(repos[0]!.id)
    expect(chooseRepo(null, null, repos)).not.toBe(ALL_REPOS)
    // A remembered choice is a memory, so it has to still exist.
    expect(chooseRepo(null, PREFIX_CWD, repos)).toBe(PREFIX_CWD)
    expect(chooseRepo(null, '/Users/me/work/deleted-since', repos)).toBe(repos[0]!.id)
    // The address bar outranks both — including for a repository this index
    // does not list, since the index is capped and a bookmark is not a guess.
    expect(chooseRepo('/Users/me/work/somewhere-else', PREFIX_CWD, repos))
      .toBe('/Users/me/work/somewhere-else')
    expect(chooseRepo(ALL_REPOS, PREFIX_CWD, repos)).toBe(ALL_REPOS)
  })
})

describe('deleting a session', () => {
  const id = uuid(200)

  const seed = () => {
    write(flatten('/Users/me/work/doomed'), id, transcript('/Users/me/work/doomed', 'delete me'))
    mkdirSync(`${CLAUDE_PROJECTS_DIR}/${flatten('/Users/me/work/doomed')}/${id}`, { recursive: true })
    mkdirSync(`${CLAUDE_HOME}/session-env`, { recursive: true })
    writeFileSync(`${CLAUDE_HOME}/session-env/${id}`, 'PATH=/usr/bin\n')
    mkdirSync(`${CLAUDE_HOME}/file-history/${id}`, { recursive: true })
    writeFileSync(`${CLAUDE_HOME}/file-history/${id}/a.json`, '{}')
  }

  const markLive = () => {
    mkdirSync(`${CLAUDE_HOME}/sessions`, { recursive: true })
    writeFileSync(
      `${CLAUDE_HOME}/sessions/4242.json`,
      JSON.stringify({ pid: 4242, sessionId: id, cwd: '/Users/me/work/doomed', startedAt: Date.now() }),
    )
  }

  test('all four places a session lives are named', () => {
    seed()
    const paths = sessionFilePaths(id)
    expect(paths).toHaveLength(4)
    expect(paths.some(p => p.endsWith(`${id}.jsonl`))).toBe(true)
    expect(paths.some(p => p.endsWith(`/session-env/${id}`))).toBe(true)
    expect(paths.some(p => p.endsWith(`/file-history/${id}`))).toBe(true)
  })

  test('a running session is refused, not deleted', () => {
    seed()
    markLive()
    expect(liveSessions().has(id)).toBe(true)

    const r = deleteSession(id)
    expect(r.error, 'a live session was deleted out from under its own process').toContain('running')
    expect(r.removed).toEqual([])
    // Unlinking a live transcript does not stop the process; it leaves it
    // appending to a file with no name, and the history is gone.
    expect(existsSync(`${CLAUDE_HOME}/session-env/${id}`)).toBe(true)

    rmSync(`${CLAUDE_HOME}/sessions/4242.json`, { force: true })
  })

  test('every path that existed is removed', () => {
    seed()
    const before = sessionFilePaths(id)
    const r = deleteSession(id)
    expect(r.error).toBeUndefined()
    expect(r.kept).toEqual([])
    expect(r.removed.length).toBeGreaterThanOrEqual(4)
    for (const p of before) expect(existsSync(p), `${p} survived`).toBe(false)
  })

  test('an id that is not one is refused before anything is touched', () => {
    expect(deleteSession('../../etc').error).toContain('not a session id')
  })
})

describe('the delete route is gated', () => {
  test('no token is a 4xx, not a delete', async () => {
    seed4xx()
    const r = await call(`/sessions/${uuid(300)}`, { method: 'DELETE' })
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.status).toBeLessThan(500)
    expect(existsSync(`${CLAUDE_PROJECTS_DIR}/${flatten('/Users/me/work/gated')}/${uuid(300)}.jsonl`)).toBe(true)
  })

  test('a token minted for another session does not spend here', async () => {
    seed4xx()
    const minted = await call(`/sessions/${uuid(300)}/delete/confirm`, { method: 'POST', body: '{}' })
    const { token } = await minted.json() as { token: string }
    // Argument-bound: the approval describes one session id and only that one.
    const r = await call(`/sessions/${uuid(301)}?token=${token}`, { method: 'DELETE' })
    expect(r.status).toBe(409)
  })

  test('the minted token names the files it is for, and spends exactly once', async () => {
    seed4xx()
    const minted = await call(`/sessions/${uuid(300)}/delete/confirm`, { method: 'POST', body: '{}' })
    const body = await minted.json() as { token: string; paths: string[] }
    expect(body.paths.some(p => p.includes('file-history'))).toBe(true)

    expect((await call(`/sessions/${uuid(300)}?token=${body.token}`, { method: 'DELETE' })).status).toBe(200)
    expect((await call(`/sessions/${uuid(300)}?token=${body.token}`, { method: 'DELETE' })).status).toBe(409)
  })

  function seed4xx() {
    for (const n of [300, 301]) {
      write(flatten('/Users/me/work/gated'), uuid(n), transcript('/Users/me/work/gated', 'gated'))
    }
    mkdirSync(`${CLAUDE_HOME}/file-history/${uuid(300)}`, { recursive: true })
  }
})
