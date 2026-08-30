/**
 * Taking a card off the list, and putting it back.
 *
 * Done is one unmodified keystroke with no confirmation. That is the right cost
 * for the action people take fifty times a day, and it is only defensible if it
 * is reversible — so what is pinned here is the way back: that the hidden set is
 * listable at all, and that an undo undoes exactly the thing it was offered for.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
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

describe('an undo restores every field the action replaced', () => {
  test('undoing Later puts the manual pile back, not just the snooze', async () => {
    // The failure this exists for. `Later` writes TWO fields — `snoozed_until`
    // and `pile_override = null` — and its undo cleared only the first. So on a
    // card parked indefinitely, "Later" then "Undo" left it in Open with the
    // Parked section gone from the page, and nothing in the UI could put a card
    // back into Parked. One click destroyed a state the product could not
    // re-create.
    await post(`/cards/${encodeURIComponent(GROUP)}/pile`, { pile: 'parked' })
    expect(state().pile_override).toBe('parked')
    expect(state().snoozed_until).toBeNull()

    await post(`/cards/${encodeURIComponent(GROUP)}/snooze`, { until: now() + 864e5 })
    expect(state().pile_override).toBeNull()
    expect(state().snoozed_until).toBeGreaterThan(now())

    await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'snoozed' })
    expect(state().snoozed_until).toBeNull()
    expect(state().pile_override, 'the park it replaced was not put back').toBe('parked')

    const live = await (await api.request('/state')).json() as any
    expect(live.parked.map((c: any) => c.group_key)).toContain(GROUP)
    expect(live.open.map((c: any) => c.group_key)).not.toContain(GROUP)
  })

  test('undoing a move puts the previous override back', async () => {
    await post(`/cards/${encodeURIComponent(GROUP)}/pile`, { pile: 'parked' })
    await post(`/cards/${encodeURIComponent(GROUP)}/pile`, { pile: 'now' })
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'moved' })
    expect(state().pile_override).toBe('parked')
  })

  test('a second undo does not rewind past the action it undid', async () => {
    await post(`/cards/${encodeURIComponent(GROUP)}/pile`, { pile: 'parked' })
    await post(`/cards/${encodeURIComponent(GROUP)}/snooze`, { until: now() + 864e5 })
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'snoozed' })
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'snoozed' })
    // The record is spent; the fallback clears the named field only, and the
    // park it restored is still there.
    expect(state().pile_override).toBe('parked')
    expect(state().snoozed_until).toBeNull()
  })

  test('undoing Done still leaves an unrelated park alone', async () => {
    await post(`/cards/${encodeURIComponent(GROUP)}/pile`, { pile: 'parked' })
    await post(`/cards/${encodeURIComponent(GROUP)}/done`)
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'done' })
    expect(state().done_at).toBeNull()
    expect(state().pile_override).toBe('parked')
  })

  test('a card acted on before any record existed still undoes its one field', async () => {
    // The upgrade path: a row whose action predates `undo_json`.
    await post(`/cards/${encodeURIComponent(GROUP)}/done`)
    db.query(`UPDATE card_state SET undo_json = NULL WHERE group_key = ?`).run(GROUP)
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`, { undo: 'done' })
    expect(state().done_at).toBeNull()
  })

  test('bringing a card back from the restore list still clears everything', async () => {
    await post(`/cards/${encodeURIComponent(GROUP)}/pile`, { pile: 'parked' })
    await post(`/cards/${encodeURIComponent(GROUP)}/done`)
    await post(`/cards/${encodeURIComponent(GROUP)}/restore`)
    expect(state().done_at).toBeNull()
    expect(state().pile_override).toBeNull()
    expect(state().snoozed_until).toBeNull()
  })
})

describe('every pile the server accepts is a pile the UI can ask for', () => {
  test('parked is one of them', async () => {
    const r = await post(`/cards/${encodeURIComponent(GROUP)}/pile`, { pile: 'parked' })
    expect(r.status).toBe(200)
    const live = await (await api.request('/state')).json() as any
    expect(live.parked.map((c: any) => c.group_key)).toContain(GROUP)
  })

  /**
   * AMENDED. The invariant is the same; the mechanism that keeps it is not.
   *
   * This used to assert that the control `filter`ed the current pile out of the
   * list — which is one way to make sure "move to Waiting" is never offered on a
   * card that is already waiting, and that offer used to be a silent write of
   * `pile_override`, freezing the card against Wake's own classification
   * forever. Filtering also meant the block never said where the card *was*: a
   * `Where` heading over two chips, neither of them the answer.
   *
   * All three are drawn now, and the one the card is in is pressed and carries
   * no handler at all — so it still cannot write, and the block now reads as an
   * answer rather than a menu. What is pinned is the thing that mattered: the
   * current pile is not clickable.
   */
  test('and the card detail cannot move a card to the group it is already in', () => {
    const detail = readFileSync('src/web/components/CardDetail.tsx', 'utf8')
    expect(detail).toMatch(/PILES\b/)
    expect(detail, 'the current group grew a handler that would write pile_override')
      .toMatch(/onClick=\{p\.id === card\.pile \? undefined :/)
  })
})
