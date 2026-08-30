/**
 * Taking a card off the list, and putting it back.
 *
 * Done is one unmodified keystroke with no confirmation. That is the right cost
 * for the action people take fifty times a day, and it is only defensible if it
 * is reversible — so what is pinned here is the way back: that the hidden set is
 * listable at all, and that an undo undoes exactly the thing it was offered for.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { db, now } from '../src/server/db'
import { api } from '../src/server/api'

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

const post = (path: string, body?: unknown) =>
  api.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

beforeEach(() => {
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
  card(GROUP)
})

describe('a card that was taken off the list', () => {
  test('is listed, with when and why', async () => {
    await post(`/cards/${encodeURIComponent(GROUP)}/done`)

    const live = await (await api.request('/state')).json() as any
    expect(live.open.map((c: any) => c.group_key)).not.toContain(GROUP)

    const hidden = await (await api.request('/cards/done')).json() as any
    expect(hidden.cards).toHaveLength(1)
    expect(hidden.cards[0].group_key).toBe(GROUP)
    expect(hidden.cards[0].state.done_at).toBeGreaterThan(0)
    expect(hidden.cards[0].state.not_mine).toBe(false)
  })

  test('a full restore brings it back', async () => {
    await post(`/cards/${encodeURIComponent(GROUP)}/done`)
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`)

    const live = await (await api.request('/state')).json() as any
    expect(live.open.map((c: any) => c.group_key)).toContain(GROUP)
    expect((await (await api.request('/cards/done')).json() as any).cards).toHaveLength(0)
  })
})

describe('an undo undoes one thing', () => {
  test('undoing a Done leaves a pile someone chose alone', async () => {
    // The order that matters: park it, then complete it, then change your mind
    // about the completion. A blanket restore would also un-park it, which is
    // not what the button said it would do.
    await post(`/cards/${encodeURIComponent(GROUP)}/pile`, { pile: 'parked' })
    await post(`/cards/${encodeURIComponent(GROUP)}/done`)
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'done' })

    expect(state().done_at).toBeNull()
    expect(state().pile_override).toBe('parked')

    const live = await (await api.request('/state')).json() as any
    expect(live.parked.map((c: any) => c.group_key)).toContain(GROUP)
  })

  test('undoing a snooze leaves it on the list and clears nothing else', async () => {
    await post(`/cards/${encodeURIComponent(GROUP)}/not-mine`)
    await post(`/cards/${encodeURIComponent(GROUP)}/snooze`, { until: now() + 3.6e6 })
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'snoozed' })

    expect(state().snoozed_until).toBeNull()
    expect(state().not_mine).toBe(1)
  })

  test('an undo target nobody defined is refused', async () => {
    const r = await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'everything' })
    expect(r.status).toBe(400)
  })
})
