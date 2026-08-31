/**
 * The replies a brief can carry.
 *
 * A Desk Slack row is a thread *parent*, and the work is usually in what was
 * said under it. So the sheet that writes a brief has to be able to offer the
 * parent and any subset of the replies — which means a route that answers, per
 * message, who said it, when, what it said, and enough to land somebody in the
 * Slack app on *that* message.
 *
 * Two properties are worth more than the field list, and both are pinned below:
 *
 *   * **It costs nothing.** Wake already reads every thread on every poll and
 *     stores the parent and the newest replies on the card. This route parses
 *     `meta`; it does not call Slack. A sheet pressed fifty times a day cannot
 *     have another product's availability in its path when the answer is on
 *     disk.
 *   * **It cannot route around the refusals.** A direct message never became a
 *     card, and it cannot become an item here either. A bot message was never
 *     dropped, and it is not dropped here either.
 *
 * The card under test is built by the real adapter from the real captured
 * payloads, so what is stored is what the poll would have stored.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { db, now } from '../src/server/db'
import { api } from '../src/server/api'
import {
  bucketHits, buildThreadCard, parseSlackResults, parseThreadRead, searchArgs,
} from '../src/server/sources/slack'
import type { RawCard } from '../src/server/sources/types'
import { ME_ID, SEARCH_ONE_THREAD, SEARCH_WITH_DM, THREAD_READ } from './fixtures/slack'

type Any = Record<string, any>

const CH = 'C04D9HKDWAV'
const PARENT = '1787812499.720579'
const GROUP = `slackthread:${CH}:${PARENT}`
const TEAM = 'T04CWR1AM1R'

/** The card the poll would have stored for the live `#truto` thread. */
function threadCard(): RawCard {
  const hits = parseSlackResults(SEARCH_ONE_THREAD)
  const buckets = bucketHits(hits, ME_ID)
  const bucket = buckets.get(`${CH}:${PARENT}`)!
  return buildThreadCard(bucket, parseThreadRead(THREAD_READ), ME_ID)!
}

function store(card: RawCard, opts: { group?: string } = {}) {
  const id = `${card.source}:${card.source_id}`
  db.query(
    `INSERT INTO cards (id, source, source_id, group_key, kind, title, why, url, ts, pile,
                        refs, meta, first_seen_at, last_seen_at, gone)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, ts = excluded.ts`,
  ).run(
    id, card.source, card.source_id, opts.group ?? GROUP, card.kind, card.title, card.why,
    card.url, card.ts, card.pile,
    JSON.stringify(card.refs), JSON.stringify(card.meta ?? {}), now(), now(),
  )
  return id
}

const slackOf = async (group = GROUP): Promise<Any> =>
  (await api.request(`/cards/${encodeURIComponent(group)}/slack`)).json() as Promise<Any>

beforeEach(() => {
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
})

/* --------------------------- 1. what comes back --------------------------- */

describe('the thread a row is about', () => {
  test('the parent and the replies under it, separately', async () => {
    store(threadCard())
    const { threads } = await slackOf()

    expect(threads).toHaveLength(1)
    const t = threads[0]

    // The parent is the message the row is named after — Nidhi's question, not
    // whichever reply happened to name him and put the row on the desk.
    expect(t.parent.parent).toBe(true)
    expect(t.parent.ts).toBe(PARENT)
    expect(t.parent.who).toBe('Nidhi')
    expect(t.parent.excerpt).toContain('can you confirm the clearing behavior')

    // And the replies are the replies, in the order the conversation happened.
    expect(t.replies.length).toBeGreaterThan(0)
    expect(t.replies.every((r: Any) => r.parent === false)).toBe(true)
    expect(t.replies.some((r: Any) => r.who === 'Riya')).toBe(true)
    // The parent is never among its own replies.
    expect(t.replies.some((r: Any) => r.ts === PARENT)).toBe(false)
  })

  test('each entry says who, when and what, in one shape', async () => {
    store(threadCard())
    const { threads } = await slackOf()
    const reply = threads[0].replies.find((r: Any) => r.who === 'Riya')!

    expect(reply.who_id).toBe('U0B5V7G3NQ5')
    expect(typeof reply.at).toBe('number')
    // Already cleaned and capped by the poll — the wire format never reaches a
    // reader.
    expect(reply.excerpt.length).toBeGreaterThan(0)
    expect(reply.excerpt.length).toBeLessThanOrEqual(280)
    expect(reply.excerpt).not.toContain('<@')
  })

  test('the header total is the count, not the length of what we kept', async () => {
    store(threadCard())
    const { threads } = await slackOf()
    // `=== THREAD REPLIES (10 total) ===`, even though the capture is abridged
    // and only four of them arrived. Counting the array would quietly report a
    // long conversation as a short one.
    expect(threads[0].reply_total).toBe(10)
    expect(threads[0].partial).toBe(false)
  })

  test("his own messages are kept, and marked", async () => {
    store(threadCard())
    const { threads } = await slackOf()
    const mine = threads[0].replies.filter((r: Any) => r.mine)
    // Three of the four replies in the capture are his. Hiding them is not this
    // route's call to make — his own words are context a brief can want — but
    // saying nothing about them would let the sheet quote him back at himself
    // as if somebody else had spoken.
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((r: Any) => r.who_id === ME_ID)).toBe(true)
  })
})

/* ------------------------------ 2. deep links ----------------------------- */

describe('every entry can be opened where it lives', () => {
  test('team, channel and the message ts are all on every entry', async () => {
    store(threadCard())
    const { threads } = await slackOf()
    const all = [threads[0].parent, ...threads[0].replies]

    for (const e of all) {
      expect(e.team_id).toBe(TEAM)
      expect(e.channel_id).toBe(CH)
      expect(typeof e.ts).toBe('string')
    }
  })

  test('a reply\'s app link points at the reply', async () => {
    store(threadCard())
    const { threads } = await slackOf()
    const reply = threads[0].replies.find((r: Any) => r.who === 'Riya')!

    // The exact string `slackAppUrl` in `src/web/lib/appLinks.ts` builds, with
    // `message=` carrying THIS message's ts. Pointing it at the parent — or at
    // the channel — would land him on the wrong thing, said three messages ago,
    // and look exactly like a link that worked.
    expect(reply.app_url).toBe(`slack://channel?team=${TEAM}&id=${CH}&message=${reply.ts}`)
    expect(reply.app_url).not.toBe(threads[0].parent.app_url)
  })

  test('and its https link is the durable form, carrying the thread', async () => {
    store(threadCard())
    const { threads } = await slackOf()
    const reply = threads[0].replies[0]

    expect(reply.url).toContain(`/archives/${CH}/p${reply.ts.replace('.', '')}`)
    // `?thread_ts=` is what `parentTs` reads back, and what makes this a link
    // into a conversation rather than to a message floating on its own.
    expect(reply.url).toContain(`thread_ts=${PARENT}`)
  })

  test('an entry is a pack item: a kind, and a ref of its own', async () => {
    store(threadCard())
    const { threads } = await slackOf()

    expect(threads[0].parent.kind).toBe('slack')
    // The parent's ref is byte-identical to what `refFor` in
    // `src/web/lib/cardContext.ts` mints for the whole card, so adding the card
    // and then the parent collapses to one item in the basket.
    expect(threads[0].parent.ref).toBe(`${CH}:${PARENT}`)

    const refs = threads[0].replies.map((r: Any) => r.ref)
    expect(new Set(refs).size).toBe(refs.length)
    expect(refs).not.toContain(threads[0].parent.ref)
  })
})

/* ------------------------ 3. the two standing rules ----------------------- */

describe('a direct message cannot get here', () => {
  test('the refusal is at ingest, and again on the way out', () => {
    // Where it lives: `bucketHits` in `sources/slack.ts`. Two of the four
    // captured hits are a DM and a group DM, and neither becomes a bucket — so
    // neither can become a card, so this route reads from a store that has
    // never contained one. The one survivor is the channel on the desk's list;
    // `#dm-tools` leaves on the channel rule rather than the DM one.
    const buckets = bucketHits(parseSlackResults(SEARCH_WITH_DM), ME_ID)
    expect([...buckets.keys()]).toEqual(['C07351C8Z8E:1787811801.333333'])
  })

  test('and a stored card that somehow named one is still not served', async () => {
    // "The data cannot contain it" is an invariant one future adapter can
    // quietly break, and this route is where it would be noticed last. So the
    // same `isDmChannel` predicate runs again here, over a row that should not
    // exist.
    store({
      ...threadCard(),
      source_id: 'D0BT1ED811Q:1787808801.580799',
      meta: {
        channel: 'DM', channel_id: 'D0BT1ED811Q', thread_ts: '1787808801.580799',
        team_id: TEAM, replies: 1,
        parent: { ts: '1787808801.580799', who: 'Ramesh', who_id: 'U09038ZHE3H', text: 'hi', tagged: false, mine: false },
        thread: [],
      },
    })
    expect((await slackOf()).threads).toEqual([])
  })
})

describe('a bot message is not silently dropped', () => {
  test('the poll asks for bots, explicitly', () => {
    // `include_bots` defaults to false on Slack's search tool, and a desk whose
    // alert bots, triage bot and integrations stop existing — under a green
    // sync line — is the failure this pins. It is a value rather than a literal
    // buried in an await precisely so it can be held here.
    expect(searchArgs('<@U1> after:2026-08-16', 20).include_bots).toBe(true)
  })

  test('and a bot line survives all the way to an item', async () => {
    // The shape an alert row stores: separate top-level messages by bots, no
    // parent, which is what `#sentry-alerts` actually looks like.
    store({
      ...threadCard(),
      source_id: 'C0SENTRY01:1787812000.000100',
      meta: {
        alert: true, channel: '#sentry-alerts', channel_id: 'C0SENTRY01',
        thread_ts: '1787812000.000100', team_id: TEAM, bot_id: 'B0SENTRY',
        replies: 2,
        thread: [
          { ts: '1787812000.000100', who: 'Sentry', who_id: 'B0SENTRY', text: 'TRUTO-38 · TypeError', tagged: false, mine: false },
          { ts: '1787812300.000200', who: 'Cursor', who_id: 'B0CURSOR', text: 'Root cause: a null repo', tagged: false, mine: false },
        ],
      },
    })

    const { threads } = await slackOf()
    expect(threads).toHaveLength(1)
    expect(threads[0].alert).toBe(true)
    // An alert has no parent and does not pretend to: its members are separate
    // top-level messages dedup unioned on a short id, not a parent and the
    // replies under it.
    expect(threads[0].parent).toBeNull()
    expect(threads[0].replies.map((r: Any) => r.who)).toEqual(['Sentry', 'Cursor'])
    expect(threads[0].replies.every((r: Any) => r.bot)).toBe(true)
    expect(threads[0].replies[1].app_url).toBe(
      `slack://channel?team=${TEAM}&id=C0SENTRY01&message=1787812300.000200`,
    )
  })
})

/* --------------------------- 4. the empty answers ------------------------- */

describe('nothing to show is not an error', () => {
  test('a thread nobody has answered has an empty reply list', async () => {
    store({
      ...threadCard(),
      meta: {
        channel: '#truto', channel_id: CH, thread_ts: PARENT, team_id: TEAM, replies: 0,
        parent: { ts: PARENT, who: 'Nidhi', who_id: 'U0BBZV4HQHH', text: 'anyone seen this', tagged: false, mine: false },
        thread: [],
      },
    })

    const { threads } = await slackOf()
    expect(threads).toHaveLength(1)
    // An empty array the sheet renders as nothing at all — not a placeholder
    // entry saying there is nothing here, which is a thing to read that says
    // nothing.
    expect(threads[0].replies).toEqual([])
    expect(threads[0].reply_total).toBe(0)
    expect(threads[0].parent.who).toBe('Nidhi')
  })

  test('a card with no Slack in it answers 200 with no threads', async () => {
    db.query(
      `INSERT INTO cards (id, source, source_id, group_key, kind, title, why, url, ts, pile,
                          refs, meta, first_seen_at, last_seen_at, gone)
       VALUES (?,?,?,?,?,?,?,?,?,?,'[]','{}',?,?,0)`,
    ).run('github:1', 'github', '1', 'gh:acme/widgets#7', 'my_pr', 'A PR', 'yours',
          'https://github.com/acme/widgets/pull/7', now(), 'open', now(), now())

    const r = await api.request(`/cards/${encodeURIComponent('gh:acme/widgets#7')}/slack`)
    // 200, because "this card is not a Slack card" is a fact the sheet renders
    // as an absent section, not an error it has to catch.
    expect(r.status).toBe(200)
    expect(((await r.json()) as Any).threads).toEqual([])
  })

  test('a group nobody has ever heard of answers the same way', async () => {
    const r = await api.request(`/cards/${encodeURIComponent('gh:nobody/nothing#1')}/slack`)
    expect(r.status).toBe(200)
    expect(((await r.json()) as Any).threads).toEqual([])
  })
})

/* ------------------------ 5. a merged group's threads --------------------- */

describe('a group that holds more than one conversation', () => {
  test('every Slack card on the row contributes its own thread', async () => {
    // The standard triage move: an alert row and the human thread that collided
    // with it, unioned by dedup onto one group. A sheet offered only one of them
    // is offered half the conversation — which is why this route reads every
    // Slack member rather than `ORDER BY ts DESC LIMIT 1`, as
    // `/cards/:group/thread` does.
    store(threadCard())
    store({
      ...threadCard(),
      source_id: 'C0SENTRY01:1787812000.000100',
      meta: {
        alert: true, channel: '#sentry-alerts', channel_id: 'C0SENTRY01',
        thread_ts: '1787812000.000100', team_id: TEAM, replies: 1,
        thread: [{ ts: '1787812000.000100', who: 'Sentry', who_id: 'B0SENTRY', text: 'TRUTO-38', tagged: false, mine: false }],
      },
    })

    const { threads } = await slackOf()
    expect(threads.map((t: Any) => t.channel_id).sort()).toEqual(['C04D9HKDWAV', 'C0SENTRY01'])
  })
})

/* --------------------------- 6. the pasted link --------------------------- */

describe('a link he pastes becomes the same kind of item', () => {
  test('and comes back knowing what Wake already knew about it', async () => {
    store(threadCard())
    const r = await api.request('/slack/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No `thread_ts` on it — the bare form somebody types or a bot mints.
      body: JSON.stringify({ url: `https://truto.slack.com/archives/${CH}/p1787814333427979` }),
    })
    expect(r.status).toBe(200)
    const { item } = (await r.json()) as Any

    // The stored copy wins whole: the link knew a channel and a ts, and Wake
    // knew who said it, what they said, and — the thing the link could not say —
    // which conversation it hangs off.
    expect(item.who).toBe('Yuvraj Muley')
    expect(item.excerpt.length).toBeGreaterThan(0)
    expect(item.thread_ts).toBe(PARENT)
    expect(item.parent).toBe(false)
    expect(item.ref).toBe(`${CH}:1787814333.427979`)
  })

  test('a link to something Wake has never listed still becomes an item', async () => {
    const r = await api.request('/slack/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://truto.slack.com/archives/C0NEVERSEEN/p1787812499720579' }),
    })
    expect(r.status).toBe(200)
    const { item } = (await r.json()) as Any
    expect(item.channel_id).toBe('C0NEVERSEEN')
    expect(item.who).toBeNull()
    // The team comes from the workspace this Wake is configured for, which is
    // the one thing the https form cannot carry and the route can.
    expect(item.app_url).toContain('slack://channel?team=')
  })

  test('a refusal is a 400 carrying a sentence a person can act on', async () => {
    const post = (url: unknown) =>
      api.request('/slack/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })

    const dm = await post('https://truto.slack.com/archives/D0BT1ED811Q/p1787808801580799')
    expect(dm.status).toBe(400)
    expect(((await dm.json()) as Any).error).toBe('Wake does not carry direct messages')

    expect((await post('https://github.com/trutohq/truto/pull/1')).status).toBe(400)
    expect((await post(42)).status).toBe(400)
  })
})
