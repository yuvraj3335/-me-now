/**
 * What Pulse is allowed to say.
 *
 * The page is only as honest as this payload, and the two panels it now opens
 * with — the pile and how stale it is — read facts that used to be computed from
 * the vocabulary the product has just retired. `done_at` and `not_mine` are
 * still written and still kept in sync; `status` is the column that decides.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { db, logEvent } from '../src/server/db'
import { analytics } from '../src/server/analytics'

const DAY = 864e5

const get = async (query = '') =>
  (await (await analytics.request(`/${query}`)).json()) as any

function card(group: string, source: string, ageDays: number) {
  const at = Date.now() - ageDays * DAY
  db.query(
    `INSERT OR REPLACE INTO cards
       (id, source, source_id, group_key, kind, title, why, url, ts, pile, first_seen_at, last_seen_at, gone)
     VALUES (?,?,?,?,'thread',?,'because','https://example.invalid/',?,'open',?,?,0)`,
  ).run(`${source}:${group}`, source, group, group, group, at, at, at)
  return { group, at }
}

const state = (group: string, patch: { status?: string; done_at?: number; not_mine?: number }, at: number) =>
  db.query(
    `INSERT OR REPLACE INTO card_state (group_key, status, done_at, not_mine, first_seen_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(group, patch.status ?? 'not_started', patch.done_at ?? null, patch.not_mine ?? 0, at, at)

beforeEach(() => {
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
  db.query(`DELETE FROM events`).run()
})

describe('what counts as still on the desk', () => {
  test('done and wont_do are out; the other three are in', async () => {
    for (const [group, status] of [
      ['g-not', 'not_started'], ['g-doing', 'in_progress'], ['g-review', 'in_review'],
      ['g-done', 'done'], ['g-wont', 'wont_do'],
    ] as const) {
      const c = card(group, 'slack', 1)
      state(group, { status }, c.at)
    }

    const a = await get()
    expect(a.totals.openNow).toBe(3)
    const slack = a.aging.find((r: any) => r.source === 'slack')
    expect(Object.values(slack.buckets).reduce((n: number, v: any) => n + v, 0)).toBe(3)
  })

  test('a snoozed card is counted by the slices as well as by the centre', async () => {
    // The donut prints `openNow` in the middle of slices built from `aging`, so
    // the two queries have to select the same rows. `aging` used to drop
    // anything snoozed into the future and `openNow` never did: with one snoozed
    // card the ring's slices summed to one less than its own centre and the
    // percentages beside them added to 99%.
    const plain = card('g-awake', 'slack', 1)
    state('g-awake', {}, plain.at)

    const naps = card('g-snoozed', 'github', 1)
    db.query(
      `INSERT OR REPLACE INTO card_state
         (group_key, status, snoozed_until, first_seen_at, updated_at)
       VALUES (?,'not_started',?,?,?)`,
    ).run('g-snoozed', Date.now() + 7 * DAY, naps.at, naps.at)

    const a = await get()
    const sliced = a.aging.reduce(
      (n: number, r: any) => n + Object.values(r.buckets).reduce((m: number, v: any) => m + v, 0),
      0,
    )
    expect(sliced).toBe(a.totals.openNow)
    expect(a.totals.openNow).toBe(2)
  })

  test('status is authoritative where the legacy timestamps disagree', async () => {
    // `done_at` and `not_mine` are still written and kept in sync — see
    // DECISIONS.md #32 — but they are the old vocabulary. The predicate reads
    // `status`, so a row where the two disagree follows the word he chose.
    const a = card('g-timestamp-only', 'github', 2)
    state('g-timestamp-only', { status: 'in_progress', done_at: Date.now() }, a.at)
    const b = card('g-status-only', 'github', 2)
    state('g-status-only', { status: 'done' }, b.at)

    expect((await get()).totals.openNow).toBe(1)
  })
})

describe('the donut can keep its slices still', () => {
  test('aging comes back ordered by source', async () => {
    // Unordered, two sources traded places between polls and the ring appeared
    // to have changed when only a count had.
    for (const source of ['slack', 'gmail', 'claude', 'sentry', 'github']) {
      const c = card(`g-${source}`, source, 1)
      state(`g-${source}`, {}, c.at)
    }
    const sources = (await get()).aging.map((r: any) => r.source)
    expect(sources).toEqual([...sources].sort())
  })
})

describe('the range control moves what it says it moves', () => {
  test('byHour follows the window and the streak does not', async () => {
    const now = Date.now()
    // Two runs of consecutive days, one of them well outside a 7-day window.
    for (let i = 0; i < 20; i++) logEvent('task_done', { at: now - i * DAY })

    const wide = await get('?days=90')
    const narrow = await get('?days=7')

    const total = (a: any) => a.rhythm.byHour.reduce((n: number, h: any) => n + h.value, 0)
    expect(total(narrow)).toBeLessThan(total(wide))
    // All-time, and the page labels it as one. Reading it off the windowed set
    // would silently cap "best 20" at "best 7".
    expect(narrow.rhythm.bestStreak).toBe(wide.rhythm.bestStreak)
    expect(narrow.rhythm.bestStreak).toBeGreaterThanOrEqual(20)
  })

  test('reading a card is not a day of work', async () => {
    // The detail pane emits `card_acked` by itself, the instant a row with
    // unread activity is opened. The clock is labelled "when I actually work"
    // and the streak "consecutive local days with something finished", so a week
    // of only reading has to report neither.
    const now = Date.now()
    for (let i = 0; i < 5; i++) logEvent('card_acked', { at: now - i * DAY })

    const a = await get('?days=30')
    expect(a.rhythm.streak).toBe(0)
    expect(a.rhythm.byHour.reduce((n: number, h: any) => n + h.value, 0)).toBe(0)

    // And the two writes that genuinely finish a card still do.
    logEvent('card_done', { at: now })
    logEvent('card_not_mine', { at: now - DAY })
    const b = await get('?days=30')
    expect(b.rhythm.byHour.reduce((n: number, h: any) => n + h.value, 0)).toBe(2)
    expect(b.rhythm.streak).toBeGreaterThanOrEqual(1)
  })
})

describe('the payload carries nothing the page does not draw', () => {
  test('the retired keys are gone', async () => {
    const a = await get()
    expect(a.throughput.created, 'nothing has drawn task_created since Pulse was rebuilt').toBeUndefined()
    expect(a.totals.doneAllTime).toBeUndefined()
    expect(a.totals.tasksOpen).toBeUndefined()
    expect(Object.keys(a.totals)).toEqual(['openNow'])
  })

  test('a daily response-time point is a day and a value, and nothing else', async () => {
    const a = await get('?days=7')
    for (const d of a.responseTime.daily) expect(Object.keys(d).sort()).toEqual(['day', 'value'])
  })
})
