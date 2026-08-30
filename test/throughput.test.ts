/**
 * What the product is allowed to call work.
 *
 * Two throughput claims, and both had a way of counting something that never
 * happened. "Cleared" summed `card_acked`, which was harmless while nothing
 * emitted one — the detail pane emits one automatically now, the moment a card
 * with unread activity is opened, so one Slack thread that gets a reply on
 * twelve different days and is read each time reported twelve clears while
 * still sitting on the desk. And `task_created` counted every `POST /tasks`,
 * including the one the swipe's undo makes to put a deleted task back.
 *
 * A chart that overstates is worse than no chart: it is the same page that ends
 * "nothing is estimated". `task_created` is no longer *drawn* — Pulse retired
 * the series — but it is still written, still queryable, and still the record of
 * how much work was made, so it is checked at the event rather than at a chart
 * that would hide the mistake.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { db, now } from '../src/server/db'
import { api } from '../src/server/api'

type Any = Record<string, any>

const GROUP = 'slackthread:C1:1.1'

const post = (path: string, body?: unknown) =>
  api.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

const pulse = async () => (await (await api.request('/analytics')).json()) as Any
const total = (series: Array<{ value: number }>) => series.reduce((n, d) => n + d.value, 0)

/** How many of an event kind the log actually holds. */
const events = (kind: string) =>
  db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM events WHERE kind = ?`)
    .get(kind)?.n ?? 0

beforeEach(() => {
  db.query(`DELETE FROM events`).run()
  db.query(`DELETE FROM tasks`).run()
  db.query(`DELETE FROM goals`).run()
  db.query(`DELETE FROM card_state`).run()
})

describe('reading a card is not clearing it', () => {
  test('an ack is not counted as a card cleared', async () => {
    // Same card, opened on three different days because a reply landed each
    // time. It is on the desk at the end of all three.
    for (let i = 0; i < 3; i++) await post(`/cards/${encodeURIComponent(GROUP)}/ack`)
    expect(total((await pulse()).throughput.cleared)).toBe(0)
  })

  test('Done and Won\'t do are counted', async () => {
    await post(`/cards/${encodeURIComponent(GROUP)}/done`)
    await post(`/cards/${encodeURIComponent(GROUP)}2/not-mine`)
    expect(total((await pulse()).throughput.cleared)).toBe(2)
  })

  test('the status control counts once when it lands on one of those two', async () => {
    // The swipe's picker writes through `/status`, and `setStatus` emits the
    // same `card_done` / `card_not_mine` the buttons do — so the count comes out
    // of one vocabulary however the move was made, and a move that lands on one
    // of the two is counted once rather than once per event kind it wrote.
    for (const status of ['in_progress', 'in_review', 'done', 'wont_do', 'not_started']) {
      await post(`/cards/${encodeURIComponent(GROUP)}/status`, { status })
    }
    expect(total((await pulse()).throughput.cleared)).toBe(2)
  })
})

describe('an undo puts something back rather than making one', () => {
  const create = async (body: Record<string, unknown>) =>
    (await (await post('/tasks', body)).json()) as Any

  test('a restored task is not a task created', async () => {
    await create({ title: 'real work' })
    expect(events('task_created')).toBe(1)

    await create({ title: 'real work', status: 'done', restore: true })
    expect(
      events('task_created'),
      'undoing a delete was recorded as work that happened',
    ).toBe(1)
  })

  test('a restored task keeps the times a status transition would have derived', async () => {
    // `PATCH` derives `completed_at` from a *transition*, and a create is not
    // one — so a finished task came back with no finish time and sorted to the
    // bottom of a Done list ordered by exactly that column.
    const at = now() - 5 * 60_000
    const t = await create({
      title: 'finished five minutes ago', status: 'done',
      completed_at: at, started_at: at - 60_000, sort: -42, restore: true,
    })
    expect(t.completed_at).toBe(at)
    expect(t.started_at).toBe(at - 60_000)
    expect(t.sort).toBe(-42)
  })

  test('a restored goal keeps its place in the list and its finished state', async () => {
    const at = now() - 60_000
    const g = (await (await post('/goals', {
      title: 'ship the thing', completed_at: at, sort: -7, restore: true,
    })).json()) as Any
    expect(g.completed_at, 'the undo un-finished a goal he had marked Done').toBe(at)
    expect(g.sort, 'the undo moved a goal it had not been asked to move').toBe(-7)
  })

  test('a restored goal is not a goal created either', async () => {
    await post('/goals', { title: 'ship the thing' })
    expect(events('goal_created')).toBe(1)
    await post('/goals', { title: 'ship the thing', restore: true })
    expect(events('goal_created')).toBe(1)
  })

  test('an ordinary create still starts from nothing', async () => {
    const t = await create({ title: 'new work' })
    expect(t.completed_at).toBeNull()
    expect(t.started_at).toBeNull()
    const g = (await (await post('/goals', { title: 'new goal' })).json()) as Any
    expect(g.completed_at).toBeNull()
  })
})
