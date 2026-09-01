/**
 * New activity goes to the top.
 *
 * The desk's order used to be an emergent property of five adapters that each
 * decided `ts` for their own reasons, and those reasons are not the same reason:
 * a Slack thread's `ts` is its newest message, a Sentry issue's is a last-seen,
 * a Claude session's is a transcript's mtime, a GitHub row's is an `updated_at`.
 * There was nowhere to point at and say what the sort *means*, and two of the
 * five things that ought to move a row did not move it at all.
 *
 * `activity_at` in `src/server/api.ts` is that place. What is pinned here is one
 * test per trigger, driven through the shapes the real sources produce, plus the
 * property that makes the field worth having: it is a union of the card's `ts`
 * with the per-message facts on it, so a source whose own stamp lags cannot hold
 * a row down.
 *
 * `activity` — the `+N` badge and the amber edge — is a different question with
 * a different test file, and nothing here changes it. A timestamp moving forward
 * is not something he has missed; `test/activity.test.ts` owns that distinction
 * and it still holds.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { db, now } from '../src/server/db'
import { api } from '../src/server/api'
import { bySessionActivity, inSessionOrder } from '../src/shared/sessionOrder'

type Any = Record<string, any>

const MINUTE = 60_000
const HOUR = 3.6e6
/** Everything in here is older than this, so nothing depends on the wall clock. */
const T0 = 1_800_000_000_000

/** A Slack ts string for an epoch, which is what a card actually stores. */
const slackTs = (at: number) =>
  `${Math.floor(at / 1000)}.${String(at % 1000).padStart(3, '0')}000`

function putCard(o: {
  id: string
  source: string
  group: string
  ts: number
  meta?: Any
  firstSeen?: number
}) {
  db.query(
    `INSERT INTO cards (id, source, source_id, group_key, kind, title, why, url, ts, pile,
                        refs, meta, first_seen_at, last_seen_at, gone)
     VALUES (?,?,?,?,?,?,?,?,?,?,'[]',?,?,?,0)
     ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, meta = excluded.meta`,
  ).run(
    o.id, o.source, o.id, o.group, 'thing', o.id, 'because', 'https://example.test/x',
    o.ts, 'open', JSON.stringify(o.meta ?? {}), o.firstSeen ?? T0 - 30 * HOUR, now(),
  )
}

/** The desk, in the order the server sends it. */
const order = async (): Promise<string[]> => {
  const r = (await (await api.request('/state')).json()) as Any
  return r.cards.map((c: Any) => c.group_key)
}

const cardFor = async (group: string): Promise<Any> => {
  const r = (await (await api.request('/state')).json()) as Any
  return r.cards.find((c: Any) => c.group_key === group)!
}

beforeEach(() => {
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
})

/**
 * Two rows above the one under test, so "it moved up" is a real claim about a
 * list rather than an observation about a list of one.
 */
function bystanders() {
  putCard({ id: 'gh:1', source: 'github', group: 'gh:acme/a#1', ts: T0 - 1 * MINUTE })
  putCard({ id: 'gh:2', source: 'github', group: 'gh:acme/a#2', ts: T0 - 2 * MINUTE })
}

/* ------------------------- 1. a reply in a Slack thread ------------------- */

describe('a new message in its Slack thread', () => {
  const GROUP = 'slackthread:C04D9HKDWAV:1787812499.720579'
  const base = (extra: Any[], ts: number) => ({
    id: 'slack:C04D9HKDWAV:1787812499.720579',
    source: 'slack',
    group: GROUP,
    ts,
    meta: {
      channel: '#truto', channel_id: 'C04D9HKDWAV', thread_ts: '1787812499.720579',
      team_id: 'T04CWR1AM1R', replies: 1 + extra.length,
      last_reply_at: extra.length ? Math.max(...extra.map(e => e.at)) : null,
      parent: { ts: slackTs(T0 - 3 * HOUR), who: 'Nidhi', who_id: 'U0B', text: 'a question', tagged: false, mine: false },
      thread: extra.map(e => ({
        ts: slackTs(e.at), who: e.who ?? 'Riya', who_id: 'U0R', text: 'a reply', tagged: false, mine: false,
      })),
    },
  })

  test('moves the row to the top', async () => {
    bystanders()
    putCard(base([], T0 - 3 * HOUR))
    expect((await order())[2]).toBe(GROUP)

    // The poll runs again and Riya has answered.
    putCard(base([{ at: T0 }], T0))
    expect((await order())[0]).toBe(GROUP)
  })

  test('even when the card\'s own stamp did not move', async () => {
    // The belt-and-braces half. `buildThreadCard` folds the newest reply into
    // `ts` itself, so this cannot happen today — but the sort must not *depend*
    // on that, or the day an adapter's stamp lags is the day a conversation goes
    // quiet on the desk while it is happening in Slack.
    bystanders()
    putCard(base([{ at: T0 }], T0 - 3 * HOUR))

    const card = await cardFor(GROUP)
    expect(card.activity_at).toBe(T0)
    expect((await order())[0]).toBe(GROUP)
  })
})

/* --------------------------- 2. a Gmail thread reply ---------------------- */

describe('a new message in its Gmail thread', () => {
  const GROUP = 'gmailthread:me@example.com:t1'
  const mail = (msgs: number[], ts: number) => ({
    id: 'gmail:me@example.com:t1',
    source: 'gmail',
    group: GROUP,
    ts,
    meta: {
      account: 'me@example.com', thread_id: 't1', direct: true,
      replies: Math.max(msgs.length - 1, 0),
      // Gmail stamps epoch ms as a number, where Slack stamps a string. The
      // desk has one clock and `eventMs` reads both.
      messages: msgs.map(at => ({ ts: at, who: 'Sunny', snippet: 'a mail', mine: false })),
    },
  })

  test('moves the row to the top', async () => {
    bystanders()
    putCard(mail([T0 - 4 * HOUR], T0 - 4 * HOUR))
    expect((await order())[2]).toBe(GROUP)

    putCard(mail([T0 - 4 * HOUR, T0], T0))
    expect((await order())[0]).toBe(GROUP)
  })

  test('even when the thread stamp lags its newest message', async () => {
    // The failure this closes. `th.date` is *usually* the newest message and
    // "usually" is not good enough for the one number the desk sorts on — a
    // payload that stamps a thread with the date it started leaves a
    // conversation answered this morning under one nobody has touched since
    // Tuesday, with nothing on the row to say why.
    bystanders()
    putCard(mail([T0 - 4 * HOUR, T0], T0 - 4 * HOUR))

    expect((await cardFor(GROUP)).activity_at).toBe(T0)
    expect((await order())[0]).toBe(GROUP)
  })
})

/* --------------------------- 3. a Sentry issue moves ---------------------- */

describe('a new event on the same short id, or a comment about it', () => {
  const GROUP = 'sentry:TRUTO-38'
  const issue = (ts: number) => ({
    id: 'sentry:TRUTO-38', source: 'sentry', group: GROUP, ts,
    meta: { short_id: 'TRUTO-38', level: 'error', events: 4, users: 2, project: 'truto', comments: 0 },
  })

  test('a fresh event moves the row up', async () => {
    // A Sentry card's `ts` is a *last-seen*, not a created-at, so another event
    // on the same issue is the timestamp moving forward.
    bystanders()
    putCard(issue(T0 - 5 * HOUR))
    expect((await order())[2]).toBe(GROUP)

    putCard(issue(T0))
    expect((await order())[0]).toBe(GROUP)
  })

  test('and a follow-up in the alert channel moves it through the group', async () => {
    // How a comment on this deployment actually reaches the desk: the Cursor
    // triage bot posts it in `#sentry-alerts`, dedup unions that card onto this
    // group on the shared `sentry:TRUTO-38` reference, and the group's newest
    // activity is the newest of its members. The Sentry row's own last-seen is
    // untouched and irrelevant.
    bystanders()
    putCard(issue(T0 - 5 * HOUR))

    putCard({
      id: 'slack:C0SENTRY01:1787812000.000100',
      source: 'slack',
      group: GROUP,
      ts: T0,
      firstSeen: T0 - 30 * HOUR,
      meta: {
        alert: true, channel: '#sentry-alerts', channel_id: 'C0SENTRY01',
        thread_ts: slackTs(T0), team_id: 'T04CWR1AM1R', short_id: 'TRUTO-38',
        thread: [
          { ts: slackTs(T0 - 5 * HOUR), who: 'Sentry', who_id: 'B0S', text: 'TRUTO-38', tagged: false, mine: false },
          { ts: slackTs(T0), who: 'Cursor', who_id: 'B0C', text: 'Root cause: a null repo', tagged: false, mine: false },
        ],
      },
    })

    expect((await cardFor(GROUP)).activity_at).toBe(T0)
    expect((await order())[0]).toBe(GROUP)
  })
})

/* ------------------------ 4. a turn in a Claude session ------------------- */

describe('a new turn in a Claude Code session', () => {
  const GROUP = 'claude:abc'
  const session = (ts: number, meta: Any = {}) => ({
    id: 'claude:abc', source: 'claude', group: GROUP, ts,
    meta: {
      project: 'wake', session_id: 'abc', cwd: '/home/me/work/wake', branch: 'main',
      turns: 4, live: false, live_at: null, ...meta,
    },
  })

  test('moves the row up, because the transcript was written to', async () => {
    bystanders()
    putCard(session(T0 - 6 * HOUR))
    expect((await order())[2]).toBe(GROUP)

    // `ts` is the transcript's mtime, and a turn is a write.
    putCard(session(T0))
    expect((await order())[0]).toBe(GROUP)
  })
})

/* ------------------------- 5. a session becoming live --------------------- */

describe('a session becoming live again', () => {
  const GROUP = 'claude:abc'

  test('moves the row up, on a transcript nobody has written to', async () => {
    // The trigger nothing covered. An mtime says a session was *written to*
    // recently, which a session that finished two days ago satisfies exactly as
    // well as one that is open right now — so "he came back to this and it is
    // running" had no representation anywhere in the card pile.
    bystanders()
    putCard({
      id: 'claude:abc', source: 'claude', group: GROUP, ts: T0 - 40 * HOUR,
      meta: { session_id: 'abc', cwd: '/home/me/work/wake', turns: 9, live: false, live_at: null },
    })
    expect((await order())[2]).toBe(GROUP)

    // He resumes it. `liveSessions()` reports the process, and the card carries
    // when it started — not `Date.now()`, so the row moves up once and then
    // sits still instead of pinning itself to the top on every poll.
    putCard({
      id: 'claude:abc', source: 'claude', group: GROUP, ts: T0 - 40 * HOUR,
      meta: { session_id: 'abc', cwd: '/home/me/work/wake', turns: 9, live: true, live_at: T0 },
    })

    const card = await cardFor(GROUP)
    expect(card.activity_at).toBe(T0)
    expect((await order())[0]).toBe(GROUP)
  })

  test('and the row still says it was last written to when it was', async () => {
    // The `+N` badge is a different question and this must not have touched it:
    // a timestamp moving forward is not a message he has missed.
    bystanders()
    putCard({
      id: 'claude:abc', source: 'claude', group: GROUP, ts: T0 - 40 * HOUR,
      firstSeen: T0 - 60 * HOUR,
      meta: { session_id: 'abc', turns: 9, live: true, live_at: T0 },
    })
    expect((await cardFor(GROUP)).activity).toEqual({ count: 0, tagged: false, at: null })
  })
})

/* --------------------------- 6. one rule, every tab ----------------------- */

describe('the same rule everywhere', () => {
  test('one list, one order — the source tabs are filters over it', async () => {
    // Desk's five source tabs are predicates over `state.cards`; none of them
    // re-sorts. So proving this array is in `activity_at` order proves All,
    // Slack, Gmail, GitHub and Sentry are too.
    putCard({ id: 'gh:1', source: 'github', group: 'gh:acme/a#1', ts: T0 - 3 * HOUR })
    putCard({
      id: 'slack:C1:1', source: 'slack', group: 'slackthread:C1:1', ts: T0 - 9 * HOUR,
      meta: {
        channel_id: 'C1', thread_ts: slackTs(T0 - 9 * HOUR), team_id: 'T1',
        thread: [{ ts: slackTs(T0 - MINUTE), who: 'Riya', who_id: 'U1', text: 'x', tagged: false, mine: false }],
      },
    })
    putCard({
      id: 'gmail:me@example.com:t1', source: 'gmail', group: 'gmailthread:me@example.com:t1',
      ts: T0 - 2 * HOUR,
      meta: { account: 'me@example.com', thread_id: 't1', messages: [{ ts: T0 - 2 * HOUR, who: 'S', snippet: 'x', mine: false }] },
    })

    const r = (await (await api.request('/state')).json()) as Any
    const ats = r.cards.map((c: Any) => c.activity_at)
    expect(ats).toEqual([...ats].sort((a, b) => b - a))
    // The Slack row leads on its reply, not on its own stale stamp.
    expect(r.cards[0].group_key).toBe('slackthread:C1:1')
  })

  test('`ts` and `activity_at` are one number, so the age and the order agree', async () => {
    putCard({
      id: 'slack:C1:1', source: 'slack', group: 'slackthread:C1:1', ts: T0 - 9 * HOUR,
      meta: {
        channel_id: 'C1', thread_ts: slackTs(T0 - 9 * HOUR), team_id: 'T1', last_reply_at: T0,
        thread: [],
      },
    })
    const card = await cardFor('slackthread:C1:1')
    expect(card.activity_at).toBe(T0)
    // Emitting both and letting them differ would put a row at the top of the
    // list while the age beside it said nine hours, with nothing on screen to
    // explain the gap.
    expect(card.ts).toBe(card.activity_at)
  })

  test('a pin and a pile still outrank recency', async () => {
    // Not a regression to guard against so much as the ordering's shape: a pin
    // is a standing instruction and a pile is where a card belongs. Recency is
    // the tie-break under both, and was before this change too.
    putCard({ id: 'gh:1', source: 'github', group: 'gh:acme/a#1', ts: T0 })
    putCard({ id: 'gh:2', source: 'github', group: 'gh:acme/a#2', ts: T0 - 10 * HOUR })
    await api.request(`/cards/${encodeURIComponent('gh:acme/a#2')}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    })
    expect((await order())[0]).toBe('gh:acme/a#2')
  })

  test('the due sort still has something in its own order to reorder', async () => {
    // Desk's Due sort runs over the array the server sent, only when
    // `?sort=due` is set, and it takes precedence when it is — so the new order
    // arrives underneath it rather than in front of it. What the server owes
    // that arrangement is a `due_at` on every row, which is asserted here
    // because the page that reads it belongs to somebody else.
    putCard({ id: 'gh:1', source: 'github', group: 'gh:acme/a#1', ts: T0 })
    await api.request(`/cards/${encodeURIComponent('gh:acme/a#1')}/due`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at: T0 + 4 * HOUR }),
    })
    const card = await cardFor('gh:acme/a#1')
    expect(card.due_at).toBe(T0 + 4 * HOUR)
    expect(card.activity_at).toBe(T0)
  })
})

/* ---------------------------- 7. the Sessions page ------------------------ */

describe('on Sessions, a live session sorts to the top', () => {
  const s = (id: string, lastTs: number, live = false) => ({ id, lastTs, live })

  test('running now beats written-to recently', async () => {
    const rows = [
      s('finished-just-now', T0),
      s('live-but-idle', T0 - 30 * HOUR, true),
      s('finished-yesterday', T0 - 26 * HOUR),
    ]
    expect(inSessionOrder(rows).map(r => r.id)).toEqual([
      'live-but-idle', 'finished-just-now', 'finished-yesterday',
    ])
  })

  test('and among the live ones, the most recently active leads', async () => {
    const rows = [
      s('live-old', T0 - 5 * HOUR, true),
      s('live-new', T0, true),
      s('dead', T0 - MINUTE),
    ]
    expect(inSessionOrder(rows).map(r => r.id)).toEqual(['live-new', 'live-old', 'dead'])
  })

  test('it never sorts the array it was given', async () => {
    // The rows come out of a store the page shares with two fetches; sorting in
    // place would reorder somebody else's state as a side effect of rendering.
    const rows = [s('a', T0 - HOUR), s('b', T0, true)]
    const before = rows.map(r => r.id)
    inSessionOrder(rows)
    expect(rows.map(r => r.id)).toEqual(before)
  })

  test('a row with no live flag at all is simply not live', async () => {
    // `live` is optional on the wire — an older client, or a row from a
    // response that predates the field. Undefined must read as "not running"
    // rather than sorting unpredictably against a boolean.
    expect(bySessionActivity({ lastTs: T0 }, { lastTs: T0 - HOUR, live: true })).toBeGreaterThan(0)
  })
})

/**
 * How far along a thing is decides where it sits, before anything else does.
 *
 * The desk was ordered by pile and then by `activity_at`, so status — the one
 * fact a reader sets by hand — moved nothing. Measured on the live box: the two
 * cards actually in progress were at positions five and seven of seventy-three,
 * with sixty-odd things nobody had started above them. Work has grouped by
 * status since it learned the five words, so the two surfaces were giving
 * different answers about the same five.
 */
describe('the desk is ordered by how far along a thing is', () => {
  const status = (group: string, s: string) =>
    api.request(`/cards/${encodeURIComponent(group)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: s }),
    })

  test('in progress, then in review, then not started', async () => {
    // Deliberately seeded in the *reverse* of the wanted order and with the
    // newest activity on the least-started row, so recency alone would produce
    // exactly the wrong list.
    putCard({ id: 'c:1', source: 'github', group: 'g:not-started', ts: T0 - 1 * MINUTE })
    putCard({ id: 'c:2', source: 'github', group: 'g:in-review', ts: T0 - 2 * MINUTE })
    putCard({ id: 'c:3', source: 'github', group: 'g:in-progress', ts: T0 - 3 * MINUTE })

    expect(await order(), 'the fixture is not in recency order to begin with')
      .toEqual(['g:not-started', 'g:in-review', 'g:in-progress'])

    await status('g:in-review', 'in_review')
    await status('g:in-progress', 'in_progress')

    expect(await order()).toEqual(['g:in-progress', 'g:in-review', 'g:not-started'])
  })

  test('recency still decides the order inside one status', async () => {
    // The new term is a grouping, not a replacement: within a status the row
    // something just landed on is still the one at the top.
    putCard({ id: 'c:1', source: 'github', group: 'g:older', ts: T0 - 9 * MINUTE })
    putCard({ id: 'c:2', source: 'github', group: 'g:newer', ts: T0 - 1 * MINUTE })
    await status('g:older', 'in_progress')
    await status('g:newer', 'in_progress')

    expect(await order()).toEqual(['g:newer', 'g:older'])
  })

  test('a pin still outranks it', async () => {
    // A pin is a standing instruction about one row; status is a fact about
    // every row. The one asked for by hand wins.
    putCard({ id: 'c:1', source: 'github', group: 'g:pinned', ts: T0 - 9 * MINUTE })
    putCard({ id: 'c:2', source: 'github', group: 'g:doing', ts: T0 - 1 * MINUTE })
    await status('g:doing', 'in_progress')
    await api.request(`/cards/${encodeURIComponent('g:pinned')}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    })

    expect((await order())[0]).toBe('g:pinned')
  })

  test('a settled card is not on the desk to be ordered at all', async () => {
    // `done` and `wont_do` are the separate section: `pileOf` sends them to
    // `hidden` and `groupedCards` drops them, so they are read through
    // `GET /cards/done` rather than sorted to the bottom of this list.
    putCard({ id: 'c:1', source: 'github', group: 'g:live', ts: T0 - 1 * MINUTE })
    putCard({ id: 'c:2', source: 'github', group: 'g:settled', ts: T0 - 2 * MINUTE })
    await status('g:settled', 'wont_do')

    expect(await order(), 'a settled card stayed on the desk').toEqual(['g:live'])
  })
})
