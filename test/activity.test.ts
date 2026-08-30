/**
 * How much has landed on a thing since he last looked at it.
 *
 * The badge and the highlight are one fact — `+2` renders iff the count is
 * non-zero, and the amber edge appears iff the count is non-zero — so the count
 * is computed once, on the server, and both halves of the UI read the same
 * number. What is pinned here is the arithmetic underneath: the baseline, the
 * exclusion of his own messages, and the fact that merely *looking* at the desk
 * is not acknowledging anything.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { db, now } from '../src/server/db'
import { api } from '../src/server/api'
import { buildThreadCard, parseThreadRead } from '../src/server/sources/slack'
import { ME_ID, THREAD_READ, TRUTO_ENG } from './fixtures/slack'

type Any = Record<string, any>

const GROUP = 'slackthread:C04D9HKDWAV:1787812499.720579'

/** Wake first saw this thread here. Everything older than it is not news. */
const SEEN = 1_700_000_000_000
const ONE_MINUTE = 60_000

function putCard(opts: { ts: number; firstSeen: number; meta: Any; source?: string; id?: string }) {
  const id = opts.id ?? 'slack:C04D9HKDWAV:1787812499.720579'
  db.query(
    `INSERT INTO cards (id, source, source_id, group_key, kind, title, why, url, ts, pile,
                        refs, meta, first_seen_at, last_seen_at, gone)
     VALUES (?,?,?,?,?,?,?,?,?,?,'[]',?,?,?,0)
     ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, meta = excluded.meta`,
  ).run(
    id, opts.source ?? 'slack', id.split(':').slice(1).join(':'), GROUP, 'thread',
    'a thread', 'you were mentioned in #truto', 'https://truto.slack.com/archives/C1/p1',
    opts.ts, 'open', JSON.stringify(opts.meta), opts.firstSeen, opts.firstSeen,
  )
}

const reply = (at: number, over: Partial<Any> = {}) => ({
  // Slack stamps a ts string, which is what the card actually carries.
  ts: `${Math.floor(at / 1000)}.${String(at % 1000).padStart(3, '0')}000`,
  who: 'Riya', who_id: 'U0B5V7G3NQ5', text: 'a reply', tagged: false, mine: false,
  ...over,
})

const state = async () => {
  const r = await (await api.request('/state')).json() as Any
  const all = [...r.now, ...r.open, ...r.parked]
  return all.find((c: Any) => c.group_key === GROUP)!
}

const post = (path: string, body?: unknown) =>
  api.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

beforeEach(() => {
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
})

describe('the baseline is when he last looked', () => {
  test('a thread that already had replies on it when it arrived is not news', () => {
    // The failure this exists for: a fourteen-reply conversation appearing on
    // the desk for the first time is one thing to read, not fourteen.
    putCard({
      ts: SEEN - ONE_MINUTE,
      firstSeen: SEEN,
      meta: { thread: [reply(SEEN - 3 * ONE_MINUTE), reply(SEEN - ONE_MINUTE)] },
    })
    return state().then(card => {
      expect(card.activity).toEqual({ count: 0, tagged: false, at: null })
    })
  })

  test('a reply that lands after it arrived is one thing to read', async () => {
    putCard({
      ts: SEEN + ONE_MINUTE,
      firstSeen: SEEN,
      meta: {
        thread: [
          reply(SEEN - 3 * ONE_MINUTE),
          reply(SEEN - ONE_MINUTE),
          reply(SEEN + ONE_MINUTE),
        ],
      },
    })
    const card = await state()
    expect(card.activity.count).toBe(1)
    expect(card.activity.at).toBe(SEEN + ONE_MINUTE)
  })

  test('being named in the new reply changes the word, not the count', async () => {
    putCard({
      ts: SEEN + ONE_MINUTE,
      firstSeen: SEEN,
      meta: { thread: [reply(SEEN + ONE_MINUTE, { tagged: true })] },
    })
    const card = await state()
    expect(card.activity).toEqual({ count: 1, tagged: true, at: SEEN + ONE_MINUTE })
  })
})

describe('his own messages are never activity on him', () => {
  test('replying to a thread does not make the thread demand something', async () => {
    putCard({
      ts: SEEN + 2 * ONE_MINUTE,
      firstSeen: SEEN,
      meta: {
        thread: [
          reply(SEEN + ONE_MINUTE, { mine: true, who: 'Yuvraj Muley', who_id: ME_ID }),
          reply(SEEN + 2 * ONE_MINUTE, { mine: true, who: 'Yuvraj Muley', who_id: ME_ID }),
        ],
      },
    })
    expect((await state()).activity).toEqual({ count: 0, tagged: false, at: null })
  })

  test('the real thread: ten replies, all but one of them his', async () => {
    // Straight off the captured payload. Four replies came back, three of them
    // his own, so exactly one thing happened that he has not already answered.
    const read = parseThreadRead(THREAD_READ)
    const card = buildThreadCard(
      {
        channelId: 'C04D9HKDWAV', channelName: '#truto', parent: read.parent!.ts,
        hits: [], alert: false, seed: null, host: null, newest: read.parent!.epochMs,
      },
      read, ME_ID, [TRUTO_ENG],
    )!

    putCard({ ts: card.ts, firstSeen: read.parent!.epochMs, meta: card.meta! })

    const row = await state()
    expect(row.activity.count, 'his own replies were counted as things to read').toBe(1)
    expect(row.activity.at).toBe(1787820616819)
  })
})

describe('a second source landing is activity too', () => {
  /** The group has been on the desk since `SEEN`, whatever arrives into it later. */
  const groupSeenAt = (at: number) =>
    db.query(
      `INSERT INTO card_state (group_key, first_seen_at, updated_at) VALUES (?,?,?)
       ON CONFLICT(group_key) DO UPDATE SET first_seen_at = excluded.first_seen_at`,
    ).run(GROUP, at, at)

  test('a Sentry row joining a Slack thread counts once, not twice', async () => {
    // Arriving is the event, so the joining card carries a later `first_seen_at`
    // than the group — which is exactly what ingest writes it with, since the
    // group's state row predates the poll that landed the second source.
    groupSeenAt(SEEN)
    putCard({ ts: SEEN - ONE_MINUTE, firstSeen: SEEN, meta: { thread: [] } })
    putCard({
      id: 'sentry:TRUTO-38', source: 'sentry',
      ts: SEEN + ONE_MINUTE, firstSeen: SEEN + ONE_MINUTE, meta: {},
    })
    expect((await state()).activity.count).toBe(1)
  })

  test('a card whose own ts is also its newest reply is one event, not two', async () => {
    // The union is a union. Without keying events by *when*, a Slack card — whose
    // `ts` is by construction its newest message — would count every fresh reply
    // twice and the badge would read `+2` for one thing.
    groupSeenAt(SEEN - 10 * ONE_MINUTE)
    putCard({
      ts: SEEN + ONE_MINUTE,
      firstSeen: SEEN,
      meta: { thread: [reply(SEEN + ONE_MINUTE)] },
    })
    expect((await state()).activity.count).toBe(1)
  })

  test('a timestamp that merely moved forward is not something that landed', async () => {
    /*
     * A Claude session's `ts` is its transcript's mtime and one of his own pull
     * requests carries `updated_at`, so both move every time *he* does the work.
     * Neither card has a thread to disagree with that, so the card's own `ts` was
     * the only event on the group — and it was hard-coded `mine: false`. Every
     * poll after he typed in the session painted the amber edge and a `+1`
     * titled "new since you last looked" for work he had just done himself.
     */
    groupSeenAt(SEEN)
    putCard({ id: 'claude:s1', source: 'claude', ts: SEEN, firstSeen: SEEN, meta: {} })
    expect((await state()).activity.count).toBe(0)

    // He types in the session. The next poll stamps a newer mtime on the row,
    // and nothing else about it has changed.
    putCard({ id: 'claude:s1', source: 'claude', ts: SEEN + ONE_MINUTE, firstSeen: SEEN, meta: {} })
    expect(
      (await state()).activity.count,
      'his own work came back to him as activity on him',
    ).toBe(0)
  })

  test('a thread that merges into an older group brings its history, not news', async () => {
    /*
     * A Slack thread mentioning PR #2034 joins that pull request's group, whose
     * state row is weeks old. Counted against the *group's* baseline, all twelve
     * of the thread's replies were newer than it, so a conversation he had never
     * been shown arrived reading `+12`. A member's own history counts from when
     * that member landed.
     */
    groupSeenAt(SEEN - 30 * ONE_MINUTE)
    putCard({
      ts: SEEN,
      firstSeen: SEEN,
      meta: {
        thread: [
          reply(SEEN - 20 * ONE_MINUTE),
          reply(SEEN - 10 * ONE_MINUTE),
          reply(SEEN - ONE_MINUTE),
        ],
      },
    })
    // One event: the thread landing. Not one per reply it arrived carrying.
    expect((await state()).activity.count).toBe(1)
  })
})

describe('acknowledging is something he does, not something the page does', () => {
  test('ack clears the count', async () => {
    putCard({
      ts: SEEN + ONE_MINUTE,
      firstSeen: SEEN,
      meta: { thread: [reply(SEEN + ONE_MINUTE)] },
    })
    expect((await state()).activity.count).toBe(1)

    await post(`/cards/${encodeURIComponent(GROUP)}/ack`)
    expect((await state()).activity.count).toBe(0)
  })

  test('reading the desk does not', async () => {
    // The laptop pane shows the top row before anything is clicked. If merely
    // rendering the desk acknowledged that row, the one thing he had not read
    // would be the one thing the count stopped mentioning.
    putCard({
      ts: SEEN + ONE_MINUTE,
      firstSeen: SEEN,
      meta: { thread: [reply(SEEN + ONE_MINUTE)] },
    })
    await state()
    await state()
    expect((await state()).activity.count).toBe(1)

    const row = db.query<Any, [string]>(`SELECT * FROM card_state WHERE group_key = ?`).get(GROUP)
    expect(row?.acked_at ?? null, 'a read wrote an acknowledgement').toBeNull()
  })

  test('an ack ages: a reply after it counts again', async () => {
    putCard({ ts: SEEN, firstSeen: SEEN, meta: { thread: [] } })
    await post(`/cards/${encodeURIComponent(GROUP)}/ack`)

    const later = now() + 5 * ONE_MINUTE
    putCard({ ts: later, firstSeen: SEEN, meta: { thread: [reply(later)] } })
    expect((await state()).activity.count).toBe(1)
  })
})

describe('Gmail counts the same way', () => {
  test('a later message in a thread is activity, not a second row', async () => {
    putCard({
      id: 'gmail:me@example.com:t1',
      source: 'gmail',
      ts: SEEN + ONE_MINUTE,
      firstSeen: SEEN,
      meta: {
        replies: 2,
        messages: [
          { ts: SEEN - ONE_MINUTE, who: 'Sunny', snippet: 'first', mine: false },
          { ts: SEEN + ONE_MINUTE, who: 'Sunny', snippet: 'chasing', mine: false },
        ],
      },
    })
    expect((await state()).activity.count).toBe(1)
  })

  test('his own reply to a mail thread is not the thread chasing him', async () => {
    putCard({
      id: 'gmail:me@example.com:t1',
      source: 'gmail',
      ts: SEEN + ONE_MINUTE,
      firstSeen: SEEN,
      meta: {
        messages: [{ ts: SEEN + ONE_MINUTE, who: 'Yuvraj', snippet: 'on it', mine: true }],
      },
    })
    expect((await state()).activity.count).toBe(0)
  })
})
