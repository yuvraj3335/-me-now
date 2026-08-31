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
 * — silently do.
 *
 * The rule itself is no longer recomputed here. It is `sessionInRepo` in
 * `src/shared/sessionRepo.ts`, and the server's `?repo=` filter is that same
 * function — so this file tests the predicate where it lives and the menu that
 * uses it, and `test/sessions.test.ts` holds the two sides to it. Recomputing a
 * shared rule on one side is how the two got to disagree in the first place.
 */

import { describe, expect, test } from 'bun:test'
import { sessionChoices } from '../src/web/components/launch'
import { sessionInRepo } from '../src/shared/sessionRepo'
import type { Session } from '../src/web/lib/launch'

/** The predicate takes a place, not a path: a bare name matches on `project`. */
const at = (cwd: string, project = cwd.split('/').pop()!) => ({ cwd, project })

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
    expect(sessionInRepo(at(TRUTO), TRUTO)).toBe(true)
    expect(sessionInRepo(at(`${TRUTO}/src/web`), TRUTO)).toBe(true)
    // The two that made the exact-match rule untenable on the real machine: a
    // package inside a monorepo, and a worktree kept inside the checkout.
    expect(sessionInRepo(at(`${APP}/packages/web`), APP)).toBe(true)
    expect(sessionInRepo(at(`${TRUTO}/.claude/worktrees/reverent-hertz`), TRUTO)).toBe(true)
  })

  test('a sibling sharing the whole name as a prefix does not', () => {
    // `'/w/truto-app'.startsWith('/w/truto')` is true, and it is the bug.
    expect(sessionInRepo(at(APP), TRUTO)).toBe(false)
    expect(sessionInRepo(at('/Users/y/work/truto-monitoring'), TRUTO)).toBe(false)
  })

  test('and neither does an unrelated directory', () => {
    expect(sessionInRepo(at('/tmp'), TRUTO)).toBe(false)
  })

  test('a transcript that never recorded a cwd is known by its filed name', () => {
    // Three of the two hundred on this machine are this: no `cwd` in the
    // transcript, so the server answers with the directory Claude Code filed
    // it under, and the same string is its `project`.
    expect(sessionInRepo(at('-Users-y-work-truto', '-Users-y-work-truto'), TRUTO)).toBe(true)
  })

  test('but the filed name is never matched as a prefix', () => {
    // The encoding dashes out the separator, so a sibling repository and a
    // directory inside this one are the same string with one more dash in it.
    const filed = (n: string) => at(n, n)
    expect(sessionInRepo(filed('-Users-y-work-truto-app'), TRUTO)).toBe(false)
    expect(sessionInRepo(filed('-Users-y-work-truto-cli'), TRUTO)).toBe(false)
  })

  test('a bare name is matched against the name, and only when it is bare', () => {
    // What a hand-typed `?repo=truto` is. It names a repository and not a path,
    // so it answers for the one whose short name that is — and `/elsewhere/truto`
    // is emphatically not `~/work/truto`, so a *path* never matches by name.
    expect(sessionInRepo(at(TRUTO), 'truto')).toBe(true)
    expect(sessionInRepo(at(TRUTO), 'TRUTO')).toBe(true)
    expect(sessionInRepo(at(APP), 'truto')).toBe(false)
    expect(sessionInRepo(at('/Users/y/elsewhere/truto'), TRUTO)).toBe(false)
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

  test('one repository is one heading, however many directories it holds', () => {
    // Live, before this: `wake` chosen, and the menu printed three headings —
    // `wake`, `reverent-hertz-369f69`, `QA_EVIDENCE` — for one repository.
    // Grouping reorders, so the worktree's newest row sat below `wake`'s
    // oldest and the list stopped reading newest-first.
    const items = sessionChoices([
      session({ id: 'a', cwd: TRUTO, lastTs: 500 }),
      session({ id: 'b', cwd: `${TRUTO}/.claude/worktrees/quiet-hertz`, lastTs: 400 }),
      session({ id: 'c', cwd: `${TRUTO}/QA_EVIDENCE`, lastTs: 300 }),
    ], TRUTO, null, [TRUTO])
    expect(items.map(i => i.group)).toEqual([undefined, 'truto', 'truto', 'truto'])
    expect(items.map(i => i.id), 'grouping reordered a list that was newest-first')
      .toEqual([':new', 'a', 'b', 'c'])
  })

  test('and a directory in no repository is still headed by where it ran', () => {
    // `/private/tmp/wake-ws/scratch` is a real one. Nothing contains it, so the
    // honest heading is the directory itself rather than a repository it is
    // not in.
    const items = sessionChoices([session({ id: 'a', cwd: '/private/tmp/scratch' })], null, null, [TRUTO])
    expect(items.at(-1)?.group).toBe('scratch')
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

describe('a session he has put away is not the default context for new work', () => {
  const rows = [
    session({ id: 'a', cwd: TRUTO }),
    session({ id: 'z', cwd: TRUTO, archived: true }),
  ]

  test('an archived session is not offered', () => {
    // Archive is Wake's own word for "done with this". Thirteen of the thirty
    // on this machine could carry it, and a menu that offers them anyway is a
    // menu that has ignored the only filing decision he made.
    expect(sessionChoices(rows, TRUTO, null).map(i => i.id)).toEqual([':new', 'a'])
    expect(sessionChoices(rows, null, null).map(i => i.id)).toEqual([':new', 'a'])
  })

  test('but the one this brief is about is, archived or not', () => {
    // The way back to it: open it from the Sessions page's Archived view and it
    // arrives here as the chosen session. Out of the way, not out of reach —
    // and without this the trigger prints a dash over a brief that names it.
    const ids = sessionChoices(rows, TRUTO, { id: 'z', title: null }).map(i => i.id)
    expect(ids).toEqual([':new', 'a', 'z'])
  })

  test('a row from before the flag existed is not archived', () => {
    const legacy = [session({ id: 'a', cwd: TRUTO })]
    expect(sessionChoices(legacy, TRUTO, null).map(i => i.id)).toEqual([':new', 'a'])
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
