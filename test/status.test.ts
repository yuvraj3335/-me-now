/**
 * Status, priority and due date — the three things about a card that only he
 * can say.
 *
 * The load-bearing part is not the column. It is that a column is a snapshot
 * and Pulse is built out of events: the Cleared chart, both response-time
 * percentiles, both heatmaps and the streak are all counts of `card_done`,
 * `card_not_mine` and `card_acked`. Moving those three verbs onto one status
 * route is exactly the change that could stop emitting them, and nothing in the
 * product would have failed — five charts would just have gone quietly empty.
 * So the event mapping is pinned here, per transition.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { db, now } from '../src/server/db'
import { api } from '../src/server/api'
import { pile } from '../src/server/dedup'

const GROUP = 'gh:acme/widgets#7'

const card = (group: string) =>
  db.query(
    `INSERT INTO cards (id, source, source_id, group_key, kind, title, why, url, ts, pile,
                        refs, meta, first_seen_at, last_seen_at, gone)
     VALUES (?,?,?,?,?,?,?,?,?,?,'[]','{}',?,?,0)`,
  ).run(`github:${group}`, 'github', group, group, 'my_pr', 'A pull request', 'yours',
        'https://github.com/acme/widgets/pull/7', now(), 'open', now(), now())

const state = () =>
  db.query<any, [string]>(`SELECT * FROM card_state WHERE group_key = ?`).get(GROUP)

const events = () =>
  db.query<{ kind: string; meta: string | null }, [string]>(
    `SELECT kind, meta FROM events WHERE group_key = ? ORDER BY id`,
  ).all(GROUP)

const kinds = () => events().map(e => e.kind)

const post = (path: string, body?: unknown) =>
  api.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

const setStatus = (status: string) =>
  post(`/cards/${encodeURIComponent(GROUP)}/status`, { status })

beforeEach(() => {
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
  db.query(`DELETE FROM events`).run()
  card(GROUP)
})

describe('the events Pulse is made of survive the move to a column', () => {
  test('done still emits card_done', async () => {
    await setStatus('done')
    expect(kinds()).toEqual(['card_done', 'card_status'])
  })

  test("won't do still emits card_not_mine", async () => {
    await setStatus('wont_do')
    expect(kinds()).toEqual(['card_not_mine', 'card_status'])
  })

  test('starting something still emits card_acked', async () => {
    await setStatus('in_progress')
    expect(kinds()).toEqual(['card_acked', 'card_status'])
  })

  test('in review emits card_status and nothing legacy', async () => {
    await setStatus('in_review')
    expect(kinds()).toEqual(['card_status'])
  })

  test('card_status carries both ends of the move', async () => {
    await setStatus('in_progress')
    await setStatus('in_review')

    const moves = events().filter(e => e.kind === 'card_status').map(e => JSON.parse(e.meta!))
    expect(moves).toEqual([
      { from: 'not_started', to: 'in_progress' },
      { from: 'in_progress', to: 'in_review' },
    ])
  })

  test('setting the status it already has says nothing', async () => {
    await setStatus('done')
    db.query(`DELETE FROM events`).run()
    await setStatus('done')
    expect(kinds()).toEqual([])
  })

  test('an ack promotes a card nobody started, and demotes nothing', async () => {
    await setStatus('in_review')
    await post(`/cards/${encodeURIComponent(GROUP)}/ack`)
    expect(state().status, 'the ack demoted work already in review').toBe('in_review')
    expect(state().acked_at).toBeGreaterThan(0)
  })
})

describe('the old verbs are the same act under an older name', () => {
  test('done sets the status', async () => {
    await post(`/cards/${encodeURIComponent(GROUP)}/done`)
    expect(state().status).toBe('done')
    expect(state().done_at).toBeGreaterThan(0)
  })

  test("not-mine sets won't do, and the hidden list still shows both facts", async () => {
    await setStatus('wont_do')

    const hidden = await (await api.request('/cards/done')).json() as any
    expect(hidden.cards).toHaveLength(1)
    expect(hidden.cards[0].state.not_mine).toBe(true)
    expect(hidden.cards[0].state.status).toBe('wont_do')
  })

  test('moving off done clears the completion time it no longer has', async () => {
    await setStatus('done')
    await setStatus('in_progress')
    expect(state().done_at).toBeNull()
    expect(state().not_mine).toBe(0)
  })

  test('a status a card cannot have is refused', async () => {
    const r = await setStatus('parked')
    expect(r.status).toBe(400)
    expect(state()?.status ?? 'not_started').toBe('not_started')
  })

  test('a status undo puts back what the move replaced', async () => {
    await setStatus('in_progress')
    await setStatus('done')
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'status' })
    expect(state().status).toBe('in_progress')
    expect(state().done_at).toBeNull()
  })
})

describe('a due date is his, and the past is a legitimate answer', () => {
  test('a date already gone is accepted', async () => {
    const past = now() - 5 * 864e5
    const r = await post(`/cards/${encodeURIComponent(GROUP)}/due`, { at: past })
    expect(r.status).toBe(200)
    expect(state().due_at).toBe(past)
  })

  test('null clears it', async () => {
    await post(`/cards/${encodeURIComponent(GROUP)}/due`, { at: now() })
    await post(`/cards/${encodeURIComponent(GROUP)}/due`, { at: null })
    expect(state().due_at).toBeNull()
  })

  test('anything that is not a timestamp is refused', async () => {
    expect((await post(`/cards/${encodeURIComponent(GROUP)}/due`, { at: 'friday' })).status).toBe(400)
    expect((await post(`/cards/${encodeURIComponent(GROUP)}/due`, {})).status).toBe(400)
  })

  test('a due date rides through a status change untouched', async () => {
    const at = now() + 3 * 864e5
    await post(`/cards/${encodeURIComponent(GROUP)}/due`, { at })
    await setStatus('in_progress')
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'status' })
    expect(state().due_at).toBe(at)
  })

  test('a full restore leaves the due date alone', async () => {
    const at = now() + 3 * 864e5
    await post(`/cards/${encodeURIComponent(GROUP)}/due`, { at })
    await setStatus('done')
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`)
    expect(state().status).toBe('not_started')
    expect(state().due_at, 'a due date is his, not the action\'s').toBe(at)
  })
})

describe('priority', () => {
  test('every step of the scale is accepted, and nothing outside it is', async () => {
    for (const priority of [0, 1, 2, 3]) {
      const r = await post(`/cards/${encodeURIComponent(GROUP)}/priority`, { priority })
      expect(r.status).toBe(200)
      expect(state().priority).toBe(priority)
    }
    for (const priority of [4, -1, 1.5, 'high']) {
      expect((await post(`/cards/${encodeURIComponent(GROUP)}/priority`, { priority })).status).toBe(400)
    }
    expect(state().priority).toBe(3)
  })

  test('a card nobody has touched is normal', async () => {
    const live = await (await api.request('/state')).json() as any
    expect(live.cards.find((c: any) => c.group_key === GROUP).priority).toBe(2)
  })

  test('an undo cannot clobber it', async () => {
    // `priority` is deliberately outside `UNDOABLE`: no undoable action writes
    // it, so snapshotting it would only give Undo a way to reset a value the
    // action it is undoing never saw.
    await post(`/cards/${encodeURIComponent(GROUP)}/priority`, { priority: 0 })
    await setStatus('done')
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'status' })
    expect(state().priority).toBe(0)
  })
})

describe('what /api/state says about a card', () => {
  test('the flat list carries status, priority and due date on every row', async () => {
    const at = now() + 864e5
    await setStatus('in_review')
    await post(`/cards/${encodeURIComponent(GROUP)}/priority`, { priority: 1 })
    await post(`/cards/${encodeURIComponent(GROUP)}/due`, { at })

    const live = await (await api.request('/state')).json() as any
    const row = live.cards.find((c: any) => c.group_key === GROUP)
    expect(row.status).toBe('in_review')
    expect(row.priority).toBe(1)
    expect(row.due_at).toBe(at)
    // The same three on the state sub-object, so nothing has to choose.
    expect(row.state.status).toBe('in_review')
    expect(row.state.priority).toBe(1)
    expect(row.state.due_at).toBe(at)
  })

  test('the flat list is the three pile arrays, unsplit', async () => {
    const live = await (await api.request('/state')).json() as any
    expect(live.cards.map((c: any) => c.group_key))
      .toEqual([...live.now, ...live.open, ...live.parked].map((c: any) => c.group_key))
  })

  test('a card he finished is on none of them', async () => {
    await setStatus('done')
    const live = await (await api.request('/state')).json() as any
    expect(live.cards).toHaveLength(0)
  })
})

describe('a status decides whether a card is on any list at all', () => {
  test('done and won\'t do are hidden; a live snooze parks whatever the status', async () => {
    // Read back the row the API wrote rather than a hand-built one: what is
    // being pinned is that the state `setStatus` persists is a state `pile()`
    // classifies the way the desk expects.
    await setStatus('done')
    expect(pile({ pile: 'now' }, state())).toBe('hidden')

    await setStatus('wont_do')
    expect(pile({ pile: 'now' }, state())).toBe('hidden')

    await setStatus('in_progress')
    await post(`/cards/${encodeURIComponent(GROUP)}/snooze`, { until: now() + 3.6e6 })
    expect(state().status, 'a park is not a status').toBe('in_progress')
    expect(pile({ pile: 'now' }, state())).toBe('parked')
  })
})

describe('a card acted on before the status column existed', () => {
  test('undoing it does not 500', async () => {
    // The upgrade path that would have failed loudest: `undo_json` written
    // before migration 9 has no `status` key, and restoring every UNDOABLE
    // field with `?? null` would write NULL into a NOT NULL column — inside a
    // route with no catch, which is a 500 on the Undo button.
    await post(`/cards/${encodeURIComponent(GROUP)}/done`)
    db.query(`UPDATE card_state SET undo_json = ? WHERE group_key = ?`).run(
      JSON.stringify({
        action: 'done',
        at: now(),
        fields: { pile_override: null, snoozed_until: null, acked_at: null, done_at: null, not_mine: 0 },
      }),
      GROUP,
    )

    const r = await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'done' })
    expect(r.status).toBe(200)
    expect(state().status).toBe('not_started')
    expect(state().done_at).toBeNull()
  })
})
