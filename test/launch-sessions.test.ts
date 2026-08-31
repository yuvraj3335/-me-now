/**
 * The session menu on "Open in Claude" belongs to the repository above it.
 *
 * The live symptom this pins: with `truto` chosen, the menu offered all thirty
 * sessions on the machine — TRUTO, TMP, TRUTO-SKILLS, TRUTO-APP and
 * TRUTO-MONITORING — because the picker was never given the repository at all.
 * The filter is the whole of what the control does and none of it can be seen
 * to be right by looking at the component, so it is a function and this is what
 * holds it: a repository named `truto` must not answer with `truto-app`, which
 * is what both loose spellings of the test — `includes`, and a bare path prefix
 * — silently do. The server's own `?repo=` is the `includes` one, which is why
 * the answer is recomputed on this side.
 */

import { describe, expect, test } from 'bun:test'
import { sessionChoices, sessionInRepo } from '../src/web/components/launch'
import type { Session } from '../src/web/lib/launch'

const TRUTO = '/Users/y/work/truto'
const APP = '/Users/y/work/truto-app'

let clock = 1_700_000_000_000
const session = (over: Partial<Session> & { id: string; cwd: string }): Session => ({
  title: `session ${over.id}`,
  project: over.cwd.split('/').pop()!,
  lastPrompt: null,
  turns: 3,
  // Descending by default, in the order they are written, so a test that does
  // not care about time still gets a deterministic list.
  lastTs: (clock -= 1000),
  path: `${over.cwd}/.jsonl`,
  pr: null,
  ...over,
})

describe('a session belongs to a repository by path, not by name', () => {
  test('the repository itself and anything under it', () => {
    expect(sessionInRepo(TRUTO, TRUTO)).toBe(true)
    expect(sessionInRepo(`${TRUTO}/src/web`, TRUTO)).toBe(true)
  })

  test('a sibling sharing the whole name as a prefix does not', () => {
    // `'/w/truto-app'.startsWith('/w/truto')` is true, and it is the bug.
    expect(sessionInRepo(APP, TRUTO)).toBe(false)
    expect(sessionInRepo('/Users/y/work/truto-monitoring', TRUTO)).toBe(false)
  })

  test('and neither does an unrelated directory', () => {
    expect(sessionInRepo('/tmp', TRUTO)).toBe(false)
  })

  test('a transcript that never recorded a cwd is known by its filed name', () => {
    // Two of the thirty on this machine are this: no `cwd` in the transcript,
    // so the server answers with the directory Claude Code filed it under.
    expect(sessionInRepo('-Users-y-work-truto', TRUTO)).toBe(true)
  })

  test('but the filed name is never matched as a prefix', () => {
    // The encoding dashes out the separator, so a sibling repository and a
    // directory inside this one are the same string with one more dash in it.
    expect(sessionInRepo('-Users-y-work-truto-app', TRUTO)).toBe(false)
    expect(sessionInRepo('-Users-y-work-truto-cli', TRUTO)).toBe(false)
  })
})

describe('the rows the menu offers', () => {
  const rows = [
    session({ id: 'a', cwd: TRUTO }),
    session({ id: 'b', cwd: APP }),
    session({ id: 'c', cwd: `${TRUTO}/cli` }),
    session({ id: 'd', cwd: '/tmp' }),
  ]

  test('a new conversation is always the first row and always available', () => {
    for (const repo of [null, TRUTO, '/Users/y/work/nothing-here']) {
      expect(sessionChoices(rows, repo, null)[0]).toEqual({
        id: ':new', label: 'A new conversation',
      })
    }
  })

  test('with no repository chosen, every session is offered', () => {
    // Grouped by the directory each one recorded, which is `truto/cli` for `c`
    // rather than `truto` — the heading names where it ran, not what contains
    // it. So the groups come out in the order their newest session did.
    const ids = sessionChoices(rows, null, null).map(i => i.id)
    expect(ids).toEqual([':new', 'a', 'b', 'c', 'd'])
  })

  test('with one chosen, only that repository is', () => {
    const ids = sessionChoices(rows, TRUTO, null).map(i => i.id)
    expect(ids, 'a sibling repository leaked into the list').toEqual([':new', 'a', 'c'])
  })

  test('a repository with nothing in it offers exactly one row', () => {
    expect(sessionChoices(rows, '/Users/y/work/quiet', null)).toHaveLength(1)
  })

  test('the two reads overlap, and a session is still one row', () => {
    const twice = [...rows, ...rows]
    expect(sessionChoices(twice, TRUTO, null).map(i => i.id)).toEqual([':new', 'a', 'c'])
  })

  test('newest first, whichever read a row arrived from', () => {
    const old = session({ id: 'old', cwd: TRUTO, lastTs: 1 })
    const fresh = session({ id: 'fresh', cwd: TRUTO, lastTs: Date.now() })
    expect(sessionChoices([old, fresh], TRUTO, null).map(i => i.id))
      .toEqual([':new', 'fresh', 'old'])
  })
})

describe('each row carries its directory and the one fact beside its name', () => {
  test('rows sharing a directory arrive together, so the heading prints once', () => {
    // `Menu` prints a group heading when the value changes rather than nesting,
    // so a list interleaved by time would print `truto` above every third row.
    const items = sessionChoices([
      session({ id: 'a', cwd: TRUTO, lastTs: 500 }),
      session({ id: 'b', cwd: APP, lastTs: 400 }),
      session({ id: 'c', cwd: TRUTO, lastTs: 300 }),
    ], null, null)
    expect(items.map(i => i.group)).toEqual([undefined, 'truto', 'truto', 'truto-app'])
  })

  test('a running session says so, and the rest say when they last ran', () => {
    const items = sessionChoices([
      session({ id: 'a', cwd: TRUTO, live: true }),
      session({ id: 'b', cwd: TRUTO, lastTs: Date.now() - 3 * 3600_000 }),
    ], TRUTO, null)
    expect(items.find(i => i.id === 'a')?.meta).toBe('live')
    expect(items.find(i => i.id === 'b')?.meta).toBeTruthy()
  })
})

describe('the session the brief is already about is always offered', () => {
  const rows = [session({ id: 'a', cwd: TRUTO }), session({ id: 'b', cwd: APP })]

  test('even when it ran in another repository', () => {
    // Otherwise the trigger prints a dash over a brief that names it, and the
    // only way to see what is attached is to remove it.
    const ids = sessionChoices(rows, TRUTO, { id: 'b', title: null }).map(i => i.id)
    expect(ids).toContain('b')
  })

  test('and even when this window has never seen it', () => {
    // A session picked from the Sessions page can be a year old; `/state` reads
    // thirty days. The basket kept its title, so the row can still be named.
    const items = sessionChoices(rows, TRUTO, { id: 'z', title: 'the one from April' })
    expect(items.map(i => i.id)).toEqual([':new', 'a', 'z'])
    expect(items.at(-1)?.label).toBe('the one from April')
  })

  test('a chosen session with no title anywhere still gets a row', () => {
    const items = sessionChoices(rows, TRUTO, { id: 'z', title: null })
    expect(items.at(-1)?.id).toBe('z')
    expect(items.at(-1)?.label).toBeTruthy()
  })

  test('and it is not offered twice when it is in the list already', () => {
    const ids = sessionChoices(rows, TRUTO, { id: 'a', title: 'session a' }).map(i => i.id)
    expect(ids).toEqual([':new', 'a'])
  })
})
