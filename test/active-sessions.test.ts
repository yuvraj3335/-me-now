/**
 * The rule that made Sessions a list of work rather than a graveyard.
 *
 * Wake used to list transcripts. A transcript outlives the process that wrote
 * it by weeks, so the page showed a hundred and thirty dead conversations with
 * a handful of live ones scattered through them, he tapped one, and Claude Code
 * on his phone told him the session had been archived. It was right.
 *
 * So the tests here are all one shape: **an id that no process is holding open
 * must not reach any surface that starts something.** Not the list, not the
 * launcher's picker, not a resume, not a link. `listActiveSessions` is the only
 * thing allowed to answer "which sessions are there", and it answers from the
 * per-process files Claude Code writes rather than from the disk's memory of
 * what once ran — the same source `claude agents --json` reports from, which is
 * the closest thing this version has to a statement about what is alive.
 *
 * `parseSessionTurns` is here for the other half: the page that renders a
 * session has to read it as a conversation, and three record types in a
 * transcript are not conversation and must never be drawn as one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { CLAUDE_HOME, CLAUDE_PROJECTS_DIR } from '../src/server/env'
import {
  isSessionActive, listActiveSessions, liveSessions, parseSessionTurns,
} from '../src/server/sources/claudeSessions'
import { claudecode } from '../src/server/claudecode/router'

const app = new Hono()
app.route('/api/claude', claudecode)
const call = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://localhost:8585/api/claude${path}`, init))

const flatten = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const uuid = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`

const REPO = '/Users/me/work/alive'
const OTHER = '/Users/me/work/alive-adjacent'

/** A transcript written the way Claude Code writes one. */
function write(cwd: string, id: string, lines: unknown[]) {
  const dir = `${CLAUDE_PROJECTS_DIR}/${flatten(cwd)}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/${id}.jsonl`, lines.map(l => JSON.stringify(l)).join('\n'))
}

const userTurn = (cwd: string, text: string, at: string) => ({
  type: 'user', cwd, timestamp: at, message: { role: 'user', content: text },
})

/** Claude Code marks a session live by writing one file per process. */
function markLive(pid: number, sessionId: string, cwd: string) {
  mkdirSync(`${CLAUDE_HOME}/sessions`, { recursive: true })
  writeFileSync(
    `${CLAUDE_HOME}/sessions/${pid}.json`,
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now(), name: 'a live one' }),
  )
}

const LIVE = uuid(1)
const DEAD = uuid(2)
const LIVE_ELSEWHERE = uuid(3)

beforeAll(() => {
  rmSync(CLAUDE_PROJECTS_DIR, { recursive: true, force: true })
  rmSync(`${CLAUDE_HOME}/sessions`, { recursive: true, force: true })
  mkdirSync(CLAUDE_PROJECTS_DIR, { recursive: true })

  write(REPO, LIVE, [
    userTurn(REPO, 'the one that is running', '2026-08-31T10:00:00.000Z'),
    {
      type: 'assistant', cwd: REPO, timestamp: '2026-08-31T10:00:05.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'on it' },
          { type: 'tool_use', name: 'Bash', input: {} },
        ],
      },
    },
    // A tool's output. Claude Code files it as a *user* record, and drawing it
    // as something he said is how a transcript starts reading like a terminal.
    {
      type: 'user', cwd: REPO, timestamp: '2026-08-31T10:00:06.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'exit 0' }] },
    },
    // A subagent's own conversation, filed in the same transcript. Rendering
    // these inline turns one conversation into several interleaved ones.
    {
      type: 'assistant', isSidechain: true, cwd: REPO, timestamp: '2026-08-31T10:00:07.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'i am a subagent' }] },
    },
    {
      type: 'assistant', cwd: REPO, timestamp: '2026-08-31T10:00:08.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    },
  ])

  // Same repository, same shape, no process. This is the row that used to be
  // indistinguishable from the one above.
  write(REPO, DEAD, [userTurn(REPO, 'finished last week', '2026-08-24T10:00:00.000Z')])

  // Live, but in a repository with a confusingly similar name.
  write(OTHER, LIVE_ELSEWHERE, [userTurn(OTHER, 'a neighbour', '2026-08-31T09:00:00.000Z')])

  markLive(9001, LIVE, REPO)
  markLive(9002, LIVE_ELSEWHERE, OTHER)
})

afterAll(() => {
  rmSync(CLAUDE_PROJECTS_DIR, { recursive: true, force: true })
  rmSync(`${CLAUDE_HOME}/sessions`, { recursive: true, force: true })
})

describe('the list is what is running', () => {
  test('a transcript with no process behind it is not a session', () => {
    const ids = listActiveSessions({ limit: 500 }).map(s => s.id)
    expect(ids, 'a live session went missing').toContain(LIVE)
    expect(ids, 'a dead transcript was listed as a session').not.toContain(DEAD)
  })

  test('liveSessions is the source, so the two can never disagree', () => {
    // The bug was two answers to one question. There is one now, and this is it.
    expect(new Set(listActiveSessions({ limit: 500 }).map(s => s.id)))
      .toEqual(new Set([...liveSessions().keys()]))
  })

  test('the repo filter is still exact-or-under, on the live set', () => {
    expect(listActiveSessions({ repo: REPO }).map(s => s.id)).toEqual([LIVE])
    expect(listActiveSessions({ repo: OTHER }).map(s => s.id)).toEqual([LIVE_ELSEWHERE])
  })

  test('the route answers active-only and cannot be widened', async () => {
    // `?all=1` and `?window=` were the two ways archived work got back onto the
    // same surface as live work. Neither may mean anything any more.
    const ids = async (q: string) => {
      const r = await call(`/sessions${q}`)
      return (await r.json() as { sessions: Array<{ id: string }> }).sessions.map(s => s.id)
    }
    expect(await ids('')).toContain(LIVE)
    expect(await ids('?all=1'), '`all` still widens the list').not.toContain(DEAD)
    expect(await ids('?window=3650'), '`window` still widens the list').not.toContain(DEAD)
  })

  test('the default view cannot render an archived row', async () => {
    const r = await call('/sessions')
    const rows = (await r.json() as { sessions: Array<{ archived: boolean; live: boolean }> }).sessions
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter(s => s.archived), 'an archived row reached the list').toEqual([])
    expect(rows.every(s => s.live), 'a row on the list was not live').toBe(true)
  })

  test('the launcher picker is fed the same set the list is', async () => {
    // The picker was the other way a dead id reached a pack, and it read from a
    // different function than the page did.
    const r = await call('/state')
    const ids = (await r.json() as { sessions: Array<{ id: string }> }).sessions.map(s => s.id)
    expect(ids).toContain(LIVE)
    expect(ids, 'the picker offered a session that is not running').not.toContain(DEAD)
  })

  test('isSessionActive is the gate every start goes through', () => {
    expect(isSessionActive(LIVE)).toBe(true)
    expect(isSessionActive(DEAD)).toBe(false)
    expect(isSessionActive(uuid(999))).toBe(false)
  })

  /*
   * And the gate is actually *wired*, which the test above does not prove.
   *
   * `isSessionActive` had zero production callers while its own docstring
   * called it "the one gate every path that starts something goes through".
   * The list, the picker and `/sessions/:id/send` all asked the question; the
   * one route that literally starts a process did not. It gated on
   * `getSession`, which searches every transcript on the box — five hundred
   * here against nine that are up — so a card for a session that finished last
   * week still reached `claude --resume <id>`, and Claude Code answered, on his
   * phone, that the session had been archived. That is the sentence this whole
   * pass exists to delete, arriving through the one door nobody had shut.
   */
  test('a dead id cannot start a terminal either, and is refused in the same words', async () => {
    const r = await call('/terminals', {
      method: 'POST', body: JSON.stringify({ sessionId: DEAD }),
    })
    expect(r.status, 'a dead transcript was handed to --resume').toBe(409)
    const { error } = await r.json() as { error: string }
    expect(error).toContain('not running any more')
    expect(error).toContain('start a new one')
  })

  test('the refusal is about liveness, not about being unknown', async () => {
    // An id that names nothing at all is a different refusal, and keeping the
    // two apart is what stops the gate being read as "resume never works".
    const r = await call('/terminals', {
      method: 'POST', body: JSON.stringify({ sessionId: uuid(999) }),
    })
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toContain('no session')

    // And a live one is not refused *for that reason*. It may still fail on the
    // box's own terms — this checkout is not under WORKSPACE_ROOT and there is
    // no tmux in a test run — but never with the dead session's sentence.
    const live = await call('/terminals', {
      method: 'POST', body: JSON.stringify({ sessionId: LIVE }),
    })
    const body = await live.json() as { error?: string }
    expect(body.error ?? '', 'a live session was called dead').not.toContain('not running any more')
  })
})

describe('sending into a session', () => {
  test('a dead id is refused in a sentence, not handed to Claude Code', async () => {
    const r = await call(`/sessions/${DEAD}/send`, {
      method: 'POST', body: JSON.stringify({ text: 'carry on' }),
    })
    expect(r.status).toBe(409)
    const { error } = await r.json() as { error: string }
    // The words matter: this is the sentence that replaced Claude Code on his
    // phone saying the session had been archived.
    expect(error).toContain('not running any more')
    expect(error).toContain('start a new one')
  })

  test('an id that names nothing is a 404 rather than a start', async () => {
    const r = await call(`/sessions/${uuid(999)}/send`, {
      method: 'POST', body: JSON.stringify({ text: 'hello' }),
    })
    expect(r.status).toBe(404)
  })

  test('an empty message is refused before anything is spawned', async () => {
    const r = await call(`/sessions/${LIVE}/send`, {
      method: 'POST', body: JSON.stringify({ text: '   ' }),
    })
    expect(r.status).toBe(400)
  })

  test('a live session Wake did not start is read-only, and says why', async () => {
    // Wake has no tmux for this one — he opened it in a terminal himself. The
    // only way in would be Claude Code's control socket, and that line holds.
    const r = await call(`/sessions/${LIVE}/send`, {
      method: 'POST', body: JSON.stringify({ text: 'carry on' }),
    })
    expect(r.status).toBe(409)
    const { error } = await r.json() as { error: string }
    expect(error).toContain('cannot type into it')
  })
})

describe('starting a conversation', () => {
  test('it takes a repository and never a session id', async () => {
    const r = await call('/sessions/new', { method: 'POST', body: JSON.stringify({}) })
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toContain('repository')
  })

  test('a repository that is not on the registry is refused by name', async () => {
    const r = await call('/sessions/new', {
      method: 'POST', body: JSON.stringify({ repo: '/etc', text: 'hi' }),
    })
    // Validation runs before availability, so this refuses on a box with no
    // tmux exactly as it does on one with tmux.
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(await r.json()).toHaveProperty('error')
  })
})

describe('a transcript read as a conversation', () => {
  test('turns come back as roles and prose', () => {
    const { found, turns } = parseSessionTurns(LIVE)
    expect(found).toBe(true)
    expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(turns[0]!.text).toBe('the one that is running')
    expect(turns.every(t => typeof t.ts === 'number' && t.ts > 0)).toBe(true)
  })

  test('a tool call rides on its turn instead of becoming one', () => {
    const { turns } = parseSessionTurns(LIVE)
    expect(turns[1]!.tools).toEqual(['Bash'])
    expect(turns[1]!.text).toBe('on it')
  })

  test('tool output is not something he said', () => {
    const { turns } = parseSessionTurns(LIVE)
    expect(turns.map(t => t.text).join(' '), 'a tool_result was drawn as a message')
      .not.toContain('exit 0')
  })

  test('a subagent conversation is not interleaved into this one', () => {
    const { turns } = parseSessionTurns(LIVE)
    expect(turns.map(t => t.text).join(' '), 'a sidechain turn reached the page')
      .not.toContain('i am a subagent')
  })

  test('`after` returns only what the page has not seen', () => {
    const all = parseSessionTurns(LIVE).turns
    const last = all.at(-1)!.ts
    expect(parseSessionTurns(LIVE, { after: last }).turns, 'polling repeated a turn').toEqual([])
    expect(parseSessionTurns(LIVE, { after: all[0]!.ts }).turns.length).toBe(all.length - 1)
  })

  test('the route serves the turns the page renders', async () => {
    const r = await call(`/sessions/${LIVE}`)
    expect(r.status).toBe(200)
    const body = await r.json() as { turns: Array<{ role: string }>; session: { active: boolean } }
    expect(body.turns.length).toBe(3)
    expect(body.session.active).toBe(true)
  })

  test('the poll route reports whether it is still worth polling', async () => {
    const r = await call(`/sessions/${LIVE}/turns?after=0`)
    const body = await r.json() as { turns: unknown[]; active: boolean }
    expect(body.turns.length).toBe(3)
    expect(body.active).toBe(true)

    // A session that has ended still serves its transcript — reading is always
    // allowed — but says so, which is what stops the composer offering to send.
    const dead = await call(`/sessions/${DEAD}/turns?after=0`)
    expect((await dead.json() as { active: boolean }).active).toBe(false)
  })
})
