/**
 * The session menu on the composer belongs to the repository above it — and,
 * since this pass, to the set of conversations that are actually running.
 *
 * Two live symptoms are pinned here, and they are different bugs.
 *
 * The first: with `truto` chosen, the menu offered all thirty sessions on the
 * machine — TRUTO, TMP, TRUTO-SKILLS, TRUTO-APP and TRUTO-MONITORING — because
 * the picker was never given the repository at all. The filter is the whole of
 * what the control does and none of it can be seen to be right by looking at the
 * component, so it is a function and this is what holds it: a repository named
 * `truto` must not answer with `truto-app`, which is what both loose spellings
 * of the test — `includes`, and a bare path prefix — silently do.
 *
 * The second, and the reason this file changed shape: **a row that is not a live
 * conversation must not be offered.** `/state` and `/sessions` read Claude
 * Code's own per-process files now, so being in the list *is* being alive. The
 * escape hatch this function used to have — a `chosen` session waved past every
 * filter so the trigger could name the session a brief was already about — was
 * exactly a way to print a dead id as a live choice, and every use of that id
 * downstream starts something. It is gone, and the tests that pinned it are
 * replaced by the ones that pin its absence. That is not lost coverage: the same
 * scenarios are still here, asserting the opposite outcome, which is the outcome
 * `SessionChip` then acts on by dropping the session from the brief.
 *
 * The repository rule itself is not recomputed here. It is `sessionInRepo` in
 * `src/shared/sessionRepo.ts`, and the server's `?repo=` filter is that same
 * function — so this file tests the predicate where it lives and the menu that
 * uses it, and `test/sessions.test.ts` holds the two sides to it.
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
  // Every row the server sends is a running process now. The fixture says so,
  // because a fixture that could not be built by the real reader is a fixture
  // that tests nothing.
  live: true,
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
    // It is also the only row that is not a session: picking it starts one.
    for (const repo of [null, TRUTO, '/Users/y/work/nothing-here']) {
      expect(sessionChoices(rows, repo)[0]).toEqual({
        id: ':new', label: 'A new conversation',
      })
    }
  })

  test('with no repository chosen, every session is offered', () => {
    // Grouped by the directory each one recorded, which is `truto/cli` for `c`
    // rather than `truto` — the heading names where it ran, not what contains
    // it. So the groups come out in the order their newest session did.
    const ids = sessionChoices(rows, null).map(i => i.id)
    expect(ids).toEqual([':new', 'a', 'b', 'c', 'd'])
  })

  test('with one chosen, only that repository is', () => {
    const ids = sessionChoices(rows, TRUTO).map(i => i.id)
    expect(ids, 'a sibling repository leaked into the list').toEqual([':new', 'a', 'c'])
  })

  test('a repository with nothing running in it offers exactly one row', () => {
    // Which is the row that starts one. A repository whose work has all finished
    // is a repository you begin a conversation in, not one you resume.
    expect(sessionChoices(rows, '/Users/y/work/quiet')).toHaveLength(1)
  })

  test('the two reads overlap, and a session is still one row', () => {
    const twice = [...rows, ...rows]
    expect(sessionChoices(twice, TRUTO).map(i => i.id)).toEqual([':new', 'a', 'c'])
  })

  test('newest first, whichever read a row arrived from', () => {
    const old = session({ id: 'old', cwd: TRUTO, lastTs: 1 })
    const fresh = session({ id: 'fresh', cwd: TRUTO, lastTs: Date.now() })
    expect(sessionChoices([old, fresh], TRUTO).map(i => i.id))
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
    ], null)
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
    ], TRUTO, [TRUTO])
    expect(items.map(i => i.group)).toEqual([undefined, 'truto', 'truto', 'truto'])
    expect(items.map(i => i.id), 'grouping reordered a list that was newest-first')
      .toEqual([':new', 'a', 'b', 'c'])
  })

  test('and a directory in no repository is still headed by where it ran', () => {
    // `/private/tmp/wake-ws/scratch` is a real one. Nothing contains it, so the
    // honest heading is the directory itself rather than a repository it is
    // not in.
    const items = sessionChoices([session({ id: 'a', cwd: '/private/tmp/scratch' })], null, [TRUTO])
    expect(items.at(-1)?.group).toBe('scratch')
  })

  test('the fact beside the name is when it last said anything', () => {
    // It used to be `live` for a running session and an age for the rest. Every
    // row is running now, so `live` on all of them is a column of one repeated
    // word — and what actually tells two sessions in one repository apart is
    // which of them moved most recently, because their titles are frequently the
    // same commit message twice.
    const items = sessionChoices([
      session({ id: 'a', cwd: TRUTO, lastTs: Date.now() - 3 * 3600_000 }),
      session({ id: 'b', cwd: TRUTO, lastTs: Date.now() - 40 * 3600_000 }),
    ], TRUTO)
    expect(items.find(i => i.id === 'a')?.meta).toBeTruthy()
    expect(items.find(i => i.id === 'b')?.meta).toBeTruthy()
    expect(items.find(i => i.id === 'a')?.meta, 'two ages three hours apart read the same')
      .not.toBe(items.find(i => i.id === 'b')?.meta)
  })
})

describe('a session he has put away is not the default context for new work', () => {
  const rows = [
    session({ id: 'a', cwd: TRUTO }),
    session({ id: 'z', cwd: TRUTO, archived: true }),
  ]

  test('an archived session is not offered', () => {
    // Archive is Wake's own word for "done with this", and it is the one opinion
    // Wake keeps about a session Claude Code still has open. A menu that offers
    // it anyway has ignored the only filing decision he made.
    expect(sessionChoices(rows, TRUTO).map(i => i.id)).toEqual([':new', 'a'])
    expect(sessionChoices(rows, null).map(i => i.id)).toEqual([':new', 'a'])
  })

  test('and it is not let back in by being the one this brief is about', () => {
    // This is the reversal. There used to be a `chosen` argument that waved a
    // session past every filter so the trigger could keep naming it. Under an
    // active-only list that is a hole rather than a courtesy: the way a dead id
    // reaches `--resume` is by being the id a stale brief still carries. The
    // composer drops the session instead, and the next press starts a new
    // conversation — which is the true option.
    expect(sessionChoices(rows, TRUTO).map(i => i.id)).not.toContain('z')
  })

  test('a row from before the flag existed is not archived', () => {
    const legacy = [session({ id: 'a', cwd: TRUTO })]
    expect(sessionChoices(legacy, TRUTO).map(i => i.id)).toEqual([':new', 'a'])
  })
})

describe('a session that is not running is not a row', () => {
  const rows = [session({ id: 'a', cwd: TRUTO }), session({ id: 'b', cwd: APP })]

  test('an id this machine is not running is simply absent', () => {
    // The list *is* the answer to "what is alive". A brief opened from a card
    // written last week can name a session that has since ended, and there is
    // nowhere in this menu for it: no ghost row, no disabled row, no row with an
    // age on it. `SessionChip` reads that absence and takes the session off the
    // brief, so the commit becomes `Start a session` rather than a resume.
    const ids = sessionChoices(rows, TRUTO).map(i => i.id)
    expect(ids, 'a session nobody is running was offered as a destination')
      .toEqual([':new', 'a'])
    expect(ids).not.toContain('the-one-from-april')
  })

  test('a live session in another repository is still filtered by repository', () => {
    // Not because it is dead — it is not — but because this menu is scoped, and
    // the composer answers the mismatch by moving the repository to where that
    // session actually runs rather than by widening the list.
    expect(sessionChoices(rows, TRUTO).map(i => i.id)).not.toContain('b')
    expect(sessionChoices(rows, APP).map(i => i.id)).toEqual([':new', 'b'])
  })
})
