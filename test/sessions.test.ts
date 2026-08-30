/**
 * Claude Code sessions, as Wake reads them off the disk.
 *
 * Three things here are easy to break and impossible to notice: the directory a
 * session is filed under is a *lossy* encoding of where it ran, the list the
 * Sessions page renders must not be the newest-N-files list the card pile
 * wants, and deleting one removes files under `~/.claude` that nothing else in
 * this product touches.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { CLAUDE_HOME, CLAUDE_PROJECTS_DIR, FETCH_RUN_DIR } from '../src/server/env'
import {
  deleteSession, getSession, listAllSessions, listSessions, liveSessions, sessionFilePaths,
} from '../src/server/sources/claudeSessions'
import { claudecode } from '../src/server/claudecode/router'

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
