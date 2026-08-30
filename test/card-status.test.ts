/**
 * How far along a thing is, and the two older columns that say the same thing.
 *
 * `status` did not replace `done_at` and `not_mine` — `pile()` reads them, the
 * restore list reads them, and the whole undo machinery is built on them — so
 * the three are one fact written by one function. What is pinned here is that
 * they can never disagree: not after a status change, not after a Done, not
 * after an undo, and not after an undo of an action recorded before `status`
 * existed.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { db, now } from '../src/server/db'
import { api } from '../src/server/api'
import { CARD_STATUSES, STATUS_LABEL, STATUS_ORDER } from '../src/shared/status'

type Any = Record<string, any>

const GROUP = 'gh:acme/widgets#7'

const card = () =>
  db.query(
    `INSERT INTO cards (id, source, source_id, group_key, kind, title, why, url, ts, pile,
                        refs, meta, first_seen_at, last_seen_at, gone)
     VALUES (?,?,?,?,?,?,?,?,?,?,'[]','{}',?,?,0)`,
  ).run(`github:${GROUP}`, 'github', GROUP, GROUP, 'my_pr', 'A pull request', 'yours',
        'https://github.com/acme/widgets/pull/7', now(), 'open', now(), now())

const stateRow = () =>
  db.query<Any, [string]>(`SELECT * FROM card_state WHERE group_key = ?`).get(GROUP)

/** The state row, asserted into existence: every test below has just written one. */
const row = (): Any => {
  const r = stateRow()
  if (!r) throw new Error('no card_state row — the action under test wrote nothing')
  return r
}

const send = (method: string, path: string, body?: unknown) =>
  api.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

const post = (path: string, body?: unknown) => send('POST', path, body)
const at = (p: string) => `/cards/${encodeURIComponent(GROUP)}${p}`

/** The card as the desk renders it, live or hidden. */
async function shown(): Promise<Any | undefined> {
  const live = await (await api.request('/state')).json() as Any
  const found = [...live.now, ...live.open, ...live.parked].find((c: Any) => c.group_key === GROUP)
  if (found) return found
  const hidden = await (await api.request('/cards/done')).json() as Any
  return hidden.cards.find((c: Any) => c.group_key === GROUP)
}

beforeEach(() => {
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
  card()
})

describe('the vocabulary is fixed', () => {
  test('five statuses, in order, each with a label', () => {
    // Another branch is landing this exact enum. The two are meant to merge as
    // a dedupe, so nothing here may be renamed or reordered on a whim.
    expect(CARD_STATUSES).toEqual(['not_started', 'in_progress', 'in_review', 'done', 'wont_do'])
    expect(STATUS_ORDER).toEqual(CARD_STATUSES)
    expect(Object.keys(STATUS_LABEL).sort()).toEqual([...CARD_STATUSES].sort())
    expect(STATUS_LABEL.wont_do).toBe("Won't do")
  })

  test('a card with no state row still has a status', async () => {
    // Never `state?.status`. A card nobody has touched is not started, and the
    // UI must never have to decide what an absent value meant.
    expect(stateRow()).toBeNull()
    expect((await shown())!.status).toBe('not_started')
  })

  test('a status nobody defined is refused', async () => {
    expect((await post(at('/status'), { status: 'blocked' })).status).toBe(400)
    expect((await post(at('/status'), {})).status).toBe(400)
  })
})

describe('status and the legacy pair are one fact', () => {
  test('wont_do sets not_mine', async () => {
    await post(at('/status'), { status: 'wont_do' })
    expect(row().status).toBe('wont_do')
    expect(row().not_mine).toBe(1)
    expect(row().done_at).toBeNull()
    // And it leaves the desk, because that is what not_mine has always meant.
    const live = await (await api.request('/state')).json() as Any
    expect(live.open.map((c: Any) => c.group_key)).not.toContain(GROUP)
  })

  test('done stamps done_at', async () => {
    await post(at('/status'), { status: 'done' })
    expect(row().status).toBe('done')
    expect(row().done_at).toBeGreaterThan(0)
    expect(row().not_mine).toBe(0)
  })

  test('anything else clears both', async () => {
    await post(at('/status'), { status: 'done' })
    await post(at('/status'), { status: 'in_review' })
    expect(row().status).toBe('in_review')
    expect(row().done_at).toBeNull()
    expect(row().not_mine).toBe(0)
    expect((await shown())!.status).toBe('in_review')
  })

  test('the routes that predate the enum write it too', async () => {
    await post(at('/done'))
    expect(row().status).toBe('done')

    await post(at('/restore'))
    await post(at('/not-mine'))
    expect(row().status).toBe('wont_do')
  })

  test('a second Done does not move when it was finished', async () => {
    await post(at('/status'), { status: 'done' })
    const first = row().done_at
    await post(at('/status'), { status: 'done' })
    expect(row().done_at).toBe(first)
  })

  test('PATCH and POST are the same write', async () => {
    expect((await send('PATCH', at('/status'), { status: 'in_progress' })).status).toBe(200)
    expect(row().status).toBe('in_progress')
  })
})

describe('a status change is undoable, like everything else', () => {
  test('undo puts the previous status back, with its columns', async () => {
    await post(at('/status'), { status: 'in_progress' })
    await post(at('/status'), { status: 'done' })
    expect(row().done_at).toBeGreaterThan(0)

    await post(at('/restore'), { undo: 'status' })
    expect(row().status).toBe('in_progress')
    expect(row().done_at).toBeNull()
    expect(row().not_mine).toBe(0)
  })

  test('undoing a Done restores both halves', async () => {
    await post(at('/status'), { status: 'in_review' })
    await post(at('/done'))
    await post(at('/restore'), { undo: 'done' })
    expect(row().done_at).toBeNull()
    expect(row().status).toBe('in_review')
  })

  test('undoing a Won`t do restores both halves', async () => {
    await post(at('/status'), { status: 'in_progress' })
    await post(at('/not-mine'))
    await post(at('/restore'), { undo: 'not_mine' })
    expect(row().not_mine).toBe(0)
    expect(row().status).toBe('in_progress')
  })

  test('a card acted on before status existed still comes back consistent', async () => {
    // The upgrade path: an undo record written by the old code has no `status`
    // in it, and NOT NULL means the fallback cannot simply write null.
    await post(at('/done'))
    db.query(`UPDATE card_state SET undo_json = NULL WHERE group_key = ?`).run(GROUP)
    await post(at('/restore'), { undo: 'done' })
    expect(row().done_at).toBeNull()
    expect(row().status).toBe('not_started')
  })

  test('bringing it back from the hidden list resets the status too', async () => {
    await post(at('/status'), { status: 'wont_do' })
    await post(at('/restore'))
    expect(row().not_mine).toBe(0)
    expect(row().done_at).toBeNull()
    expect(row().status).toBe('not_started')
  })

  test('a snooze undo does not touch the status', async () => {
    await post(at('/status'), { status: 'in_review' })
    await post(at('/snooze'), { until: now() + 3.6e6 })
    await post(at('/restore'), { undo: 'snoozed' })
    expect(row().status).toBe('in_review')
    expect(row().snoozed_until).toBeNull()
  })
})
