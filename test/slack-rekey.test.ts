/**
 * The one-shot move his decisions have to survive.
 *
 * A Slack row used to be keyed on each message's own timestamp and is keyed on
 * the thread's parent from this release on, so one `#truto` conversation that
 * occupied three rows becomes one. The card rows self-heal — the poller stops
 * returning the old ids and the sweep marks them gone — but `card_state` is
 * keyed by *group*, and `slackthread:C05CJ0CUV35:<replyTs>` is a group key
 * nothing will ever mention again. Every Done, Won't do, snooze and pin he
 * pressed on a row that turns out to have been a reply would have been stranded
 * there, and the finished thread would have come back to the desk with no state.
 *
 * What makes the move possible is that the parent is already in the data:
 * Slack's permalink carries `?thread_ts=<parent>` on a reply and on a standalone
 * message alike, and that permalink is the card's `url`.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { db, rekeySlackThreadGroups } from '../src/server/db'

type Any = Record<string, any>

const CHANNEL = 'C05CJ0CUV35'
const PARENT = '1784530611.515999'
const THREAD = `slackthread:${CHANNEL}:${PARENT}`

const link = (ts: string, thread = PARENT) =>
  `https://truto.slack.com/archives/${CHANNEL}/p${ts.replace('.', '')}?thread_ts=${thread}&cid=${CHANNEL}`

/** A card as the shipped version of the poller wrote it: keyed on its own ts. */
function putCard(ts: string, over: Partial<Any> = {}) {
  const id = `slack:${CHANNEL}:${ts}`
  db.query(
    `INSERT INTO cards (id, source, source_id, group_key, kind, title, why, url, ts, pile,
                        refs, meta, first_seen_at, last_seen_at, gone, found_by)
     VALUES (?,'slack',?,?,'mention','a reply','you were mentioned in #spendflo-truto',?,?, 'now',
             '[]','{}',?,?,0,'poll')`,
  ).run(
    id,
    `${CHANNEL}:${ts}`,
    over.group_key ?? `slackthread:${CHANNEL}:${ts}`,
    over.url ?? link(ts),
    1_784_530_611_515,
    1_784_530_611_515,
    1_784_530_611_515,
  )
  return id
}

function putState(groupKey: string, over: Partial<Any> = {}) {
  db.query(
    `INSERT INTO card_state (group_key, snoozed_until, acked_at, notified_at, not_mine, done_at,
                             status, pinned, first_seen_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    groupKey, over.snoozed_until ?? null, over.acked_at ?? null, over.notified_at ?? null,
    over.not_mine ?? 0, over.done_at ?? null, over.status ?? 'not_started',
    over.pinned ?? 0, over.first_seen_at ?? 1_784_000_000_000, 1_784_000_000_000,
  )
}

const stateOf = (g: string) =>
  db.query<Any, [string]>(`SELECT * FROM card_state WHERE group_key = ?`).get(g)

beforeEach(() => {
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
  db.query(`DELETE FROM events`).run()
  db.query(`DELETE FROM tasks`).run()
})

describe('a decision follows its thread', () => {
  test('a reply-keyed group moves onto the parent, and the row goes with it', () => {
    const id = putCard('1784530700.100000')
    putState(`slackthread:${CHANNEL}:1784530700.100000`, { done_at: 1_784_600_000_000, status: 'done' })

    expect(rekeySlackThreadGroups()).toBe(1)

    expect(stateOf(`slackthread:${CHANNEL}:1784530700.100000`), 'the old key survived').toBeNull()
    const moved = stateOf(THREAD)!
    expect(moved.done_at, 'the Done he pressed was left on a key nothing mentions').toBe(1_784_600_000_000)
    expect(moved.status).toBe('done')

    // And the superseded row does not sit on the desk beside the thread that
    // replaced it until some later poll happens to be authoritative.
    expect(db.query<Any, [string]>(`SELECT gone FROM cards WHERE id = ?`).get(id)!.gone).toBe(1)
  })

  test('two replies to one thread merge, taking the handled side of each field', () => {
    putCard('1784530700.100000')
    putCard('1784530800.200000')
    putState(`slackthread:${CHANNEL}:1784530700.100000`, { done_at: 1_784_600_000_000, status: 'done' })
    putState(`slackthread:${CHANNEL}:1784530800.200000`, { not_mine: 1, status: 'wont_do', pinned: 1 })

    expect(rekeySlackThreadGroups()).toBe(2)

    const merged = stateOf(THREAD)!
    expect(merged.done_at).toBe(1_784_600_000_000)
    expect(merged.not_mine).toBe(1)
    expect(merged.pinned).toBe(1)
    // The pair decides and the enum follows it, which is the rule `migrateState`
    // holds when dedup unions two groups — a row cannot be `done_at`-stamped and
    // `in_progress` at once.
    expect(merged.status).toBe('wont_do')
  })

  test('a task made from one of those replies follows it', () => {
    putCard('1784530700.100000')
    putState(`slackthread:${CHANNEL}:1784530700.100000`)
    db.query(
      `INSERT INTO tasks (id, title, status, source_card_group, sort, created_at, updated_at)
       VALUES ('t1','ship it','todo',?,0,1,1)`,
    ).run(`slackthread:${CHANNEL}:1784530700.100000`)

    rekeySlackThreadGroups()

    expect(db.query<Any, []>(`SELECT source_card_group FROM tasks WHERE id = 't1'`).get()!.source_card_group)
      .toBe(THREAD)
  })

  test('the parent row itself is not moved and not marked gone', () => {
    // Its own ts *is* the thread's, so it keeps its id, its key and its state.
    const id = putCard(PARENT)
    putState(THREAD, { done_at: 1_784_600_000_000 })

    expect(rekeySlackThreadGroups()).toBe(0)
    expect(db.query<Any, [string]>(`SELECT gone FROM cards WHERE id = ?`).get(id)!.gone).toBe(0)
    expect(stateOf(THREAD)!.done_at).toBe(1_784_600_000_000)
  })

  test('a row that had merged into a pull request keeps the group it merged into', () => {
    // Its state lives under `gh:trutohq/truto#2034`, which is not moving, and
    // the new thread-keyed card will union into it again by the same reference.
    putCard('1784530700.100000', { group_key: 'gh:trutohq/truto#2034' })
    putState('gh:trutohq/truto#2034', { done_at: 1_784_600_000_000 })

    expect(rekeySlackThreadGroups()).toBe(0)
    expect(stateOf('gh:trutohq/truto#2034')!.done_at).toBe(1_784_600_000_000)
    expect(stateOf(THREAD)).toBeNull()
  })

  test('a card whose permalink carries no thread_ts is left alone', () => {
    putCard('1784530700.100000', {
      url: `https://truto.slack.com/archives/${CHANNEL}/p1784530700100000`,
    })
    putState(`slackthread:${CHANNEL}:1784530700.100000`)

    expect(rekeySlackThreadGroups()).toBe(0)
    expect(stateOf(`slackthread:${CHANNEL}:1784530700.100000`)).not.toBeNull()
  })

  test('running it twice moves nothing the second time', () => {
    putCard('1784530700.100000')
    putState(`slackthread:${CHANNEL}:1784530700.100000`, { done_at: 1_784_600_000_000 })

    expect(rekeySlackThreadGroups()).toBe(1)
    // The card rows are still there and still say what they said, so the second
    // pass sees the same mapping — and has to find nothing left to move.
    rekeySlackThreadGroups()
    expect(stateOf(THREAD)!.done_at).toBe(1_784_600_000_000)
  })
})
