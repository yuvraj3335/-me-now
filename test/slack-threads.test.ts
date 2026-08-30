/**
 * One row per thread.
 *
 * Measured on the live desk before a line was changed: a `#truto` conversation
 * occupied three rows — the question and the two answers under it, each in its
 * own place in the sort, each with its own Done button, none of which did
 * anything to the other two. The cause was one line. A Slack permalink carries
 * the conversation it belongs to as `?thread_ts=`, and the poller stored the
 * message's own ts there instead, so every message was its own thread.
 *
 * Everything here drives the real captured payloads through the real parsers.
 * No mock speaks Slack's dialect well enough to be worth trusting with this —
 * see `FIXTURES.md` for where each capture came from.
 *
 * Alert channels are deliberately absent: they arrive as history rather than as
 * search hits, they are keyed on a monitor or a short id rather than on a
 * thread, and `test/alerts.test.ts` owns them end to end.
 */

import { describe, expect, test } from 'bun:test'
import {
  bucketHits, buildThreadCard, parentTs, parseSlackResults, parseThreadRead, plain,
} from '../src/server/sources/slack'
import { PartialPoll, settle, type RawCard } from '../src/server/sources/types'
import { ME_ID, SEARCH_ONE_THREAD, SEARCH_ORPHAN_REPLY, SEARCH_WITH_DM, THREAD_READ } from './fixtures/slack'

/** The one call the adapter makes per thread, already parsed. */
const READ = parseThreadRead(THREAD_READ)

const only = <T>(m: Map<string, T>): [string, T] => {
  expect([...m.keys()]).toHaveLength(1)
  return [...m.entries()][0]!
}

/* ------------------------------- 1. identity ------------------------------ */

describe('the permalink carries the parent', () => {
  test('a parent, a reply, and a link with no thread_ts', () => {
    const parent = {
      ts: '1787812499.720579',
      permalink: 'https://truto.slack.com/archives/C04D9HKDWAV/p1787812499720579?thread_ts=1787812499.720579&cid=C04D9HKDWAV',
    }
    const reply = {
      ts: '1787814249.215859',
      permalink: 'https://truto.slack.com/archives/C04D9HKDWAV/p1787814249215859?thread_ts=1787812499.720579&cid=C04D9HKDWAV',
    }
    const bare = {
      ts: '1787724259.189389',
      permalink: 'https://truto.slack.com/archives/C0123ABCD/p1787724259189389',
    }

    // A standalone message's thread_ts equals its own ts, so one rule covers
    // both cases and neither needs a special path.
    expect(parentTs(parent)).toBe('1787812499.720579')
    expect(parentTs(reply)).toBe('1787812499.720579')
    expect(parentTs(bare)).toBe('1787724259.189389')
  })

  test('a permalink Slack did not give us is not a reason to throw', () => {
    // A channel read carries no permalink at all, and its messages are
    // top-level — so the message's own ts is the honest answer.
    expect(parentTs({ ts: '1788094379.882969', permalink: '' })).toBe('1788094379.882969')
    expect(parentTs({ ts: '1788094379.882969', permalink: 'not a url' })).toBe('1788094379.882969')
  })
})

/* ------------------------------ 2. one row -------------------------------- */

describe('a thread is one row', () => {
  test('three hits on one thread produce one card, titled from the parent', () => {
    const hits = parseSlackResults(SEARCH_ONE_THREAD)
    expect(hits).toHaveLength(3)

    const [key, bucket] = only(bucketHits(hits, ME_ID))
    expect(key).toBe('C04D9HKDWAV:1787812499.720579')
    expect(bucket.hits).toHaveLength(3)

    const card = buildThreadCard(bucket, READ, ME_ID)!
    expect(card.source_id).toBe('C04D9HKDWAV:1787812499.720579')
    expect(card.meta!.thread_ts).toBe('1787812499.720579')
    expect(card.title).toContain('can you confirm the clearing behavior')
    // The header's total, not the four replies the page happened to return.
    expect(card.meta!.replies).toBe(10)
  })

  test('a hit whose parent is not in the results still gets the parent from the read', () => {
    // The common case, and the reason the thread is read at all: he is named in
    // a reply, so the search returns the answer and not the question.
    const hits = parseSlackResults(SEARCH_ORPHAN_REPLY)
    const [, bucket] = only(bucketHits(hits, ME_ID))
    expect(bucket.seed, 'the parent was not among the results').toBeNull()

    const card = buildThreadCard(bucket, READ, ME_ID)!
    expect(card.source_id).toBe('C04D9HKDWAV:1787812499.720579')
    expect(card.title).toContain('can you confirm the clearing behavior')
    expect(card.actor).toBe('Nidhi')
  })

  test('the card links to the parent, not to the reply that was found', () => {
    const orphan = only(bucketHits(parseSlackResults(SEARCH_ORPHAN_REPLY), ME_ID))[1]
    // Nobody handed us the parent's permalink, so one is minted from the origin
    // the reply's own permalink came from.
    expect(buildThreadCard(orphan, READ, ME_ID)!.url)
      .toBe('https://truto.slack.com/archives/C04D9HKDWAV/p1787812499720579')

    // And when the search did return the parent, its real permalink wins.
    const full = only(bucketHits(parseSlackResults(SEARCH_ONE_THREAD), ME_ID))[1]
    expect(buildThreadCard(full, READ, ME_ID)!.url)
      .toContain('p1787812499720579?thread_ts=1787812499.720579')
  })
})

/* --------------------- 3. a link is not an identity ----------------------- */

describe('a link in a thread is a pointer, not a second identity', () => {
  test("a permalink somebody pasted does not become this row's thread ref", () => {
    // Nidhi's parent quotes `…/archives/C0AHHQMF08L/p1787777335863559`. Read as
    // a thread reference, that gave this row a second identity — so any other
    // thread where anybody quoted the same link was unioned into it, and one
    // desk row spoke for two conversations.
    const [, bucket] = only(bucketHits(parseSlackResults(SEARCH_ONE_THREAD), ME_ID))
    const refs = buildThreadCard(bucket, READ, ME_ID)!.refs

    expect(refs.filter(r => r.t === 'slackthread'))
      .toEqual([{ t: 'slackthread', v: 'C04D9HKDWAV:1787812499.720579' }])
  })
})

/* ------------------- 4. what he said is not work on him ------------------- */

describe('the desk does not hand him back what he just said', () => {
  test('a message he wrote is never marked as naming him', () => {
    // Ten of the eleven messages in the captured thread are his own, and two of
    // them would match a naive "does this text mention me" test.
    const card = buildThreadCard(
      only(bucketHits(parseSlackResults(SEARCH_ONE_THREAD), ME_ID))[1], READ, ME_ID,
    )!
    const thread = card.meta!.thread as Array<{ who_id: string; mine: boolean; tagged: boolean }>
    for (const e of thread.filter(x => x.who_id === ME_ID)) {
      expect(e.mine).toBe(true)
      expect(e.tagged, 'his own message was counted as somebody naming him').toBe(false)
    }
  })

  test('a hit he wrote himself never opens a bucket', () => {
    // The search asks for `<@me>`, so a hit of his own is him naming himself.
    const hits = parseSlackResults(SEARCH_ONE_THREAD).map(h => ({ ...h, fromId: ME_ID }))
    expect(bucketHits(hits, ME_ID).size).toBe(0)
  })
})

/* --------------------------- 5. no direct messages ------------------------ */

describe('a direct message can never reach the desk', () => {
  test('a DM-shaped hit never becomes a bucket', () => {
    const hits = parseSlackResults(SEARCH_WITH_DM)
    expect(hits).toHaveLength(3)

    const buckets = bucketHits(hits, ME_ID)
    // The `#dm-tools` channel survives, and it is the reason the rule is two
    // tells rather than a name test: a public channel whose name merely starts
    // with `dm` is a channel.
    expect([...buckets.keys()]).toEqual(['C0DMTOOLS1:1787811201.222222'])
  })
})

/* ------------------------ 6. the thread read itself ----------------------- */

describe('the thread read answers everything a row needs at once', () => {
  test('ten replies, the parent author, and the parent naming him', () => {
    expect(READ.replyTotal, 'the header total, not the page length').toBe(10)
    expect(READ.replies).toHaveLength(4)
    expect(READ.parent!.who).toBe('Nidhi')
    expect(READ.parent!.whoId).toBe('U0BBZV4HQHH')
    expect(READ.parent!.text).toContain('<@U09617LRRDF|Yuvraj Muley>')
  })

  test('Reactions and Files are transport, not something somebody said', () => {
    expect(READ.parent!.text).not.toContain('Reactions:')
    expect(READ.replies.map(r => r.text).join('\n')).not.toContain('Files:')
  })

  test('a body runs to the end of the message, not to the end of its first line', () => {
    // With a `/m`-flagged `$` terminator this parent truncates at the comma.
    expect(READ.parent!.text).toContain('Forwarded message from Sunny Siu')
  })

  test('a payload in the search tool\'s dialect is not silently empty', () => {
    // The shipped `readThread` handed thread markdown to `parseSlackResults`,
    // which splits on `### Result N of M` — a separator that appears nowhere in
    // this payload. It returned an empty array for every thread ever read.
    expect(parseSlackResults(THREAD_READ)).toEqual([])
    expect(parseThreadRead(THREAD_READ).replies.length).toBeGreaterThan(0)
  })
})

/* ------------------------------- 7. honesty ------------------------------- */

describe('honesty about what a poll could not ask', () => {
  test('a thread read that failed degrades one row and says so', () => {
    const [, bucket] = only(bucketHits(parseSlackResults(SEARCH_ONE_THREAD), ME_ID))
    const card = buildThreadCard(bucket, null, ME_ID)!

    // Still one row, still titled from the parent — because the search happened
    // to return it — and marked as a row whose thread would not load.
    expect(card.meta!.thread_partial).toBe(true)
    expect(card.title).toContain('can you confirm the clearing behavior')

    // And the hits become the conversation. Reading the replies off the failed
    // read alone left this empty, which threw away the two messages that named
    // him — the reason the row exists at all — from the pane, the excerpt and
    // the `Who` column.
    const thread = card.meta!.thread as Array<Record<string, any>>
    expect(thread.map(e => e.ts)).toEqual(['1787812964.247529', '1787814249.215859'])
    expect(thread.every(e => e.tagged)).toBe(true)
    expect(card.meta!.replies).toBe(2)
    expect(card.excerpt).toContain('ptal when you get a minute')
    expect(card.who).toBe('Riya')
  })

  test('but a query that failed is still the whole poll', () => {
    // A thread read is one row's problem. A search or an alert-channel read is
    // the poll's, because a channel that did not answer is a channel whose
    // alerts are missing — so the rows survive and the sweep authority does not.
    const cards: RawCard[] = []
    let thrown: unknown
    try {
      settle('slack', [
        { status: 'fulfilled', value: [] },
        { status: 'rejected', reason: new Error('channel_not_found') },
      ], cards)
    } catch (e) { thrown = e }

    expect(thrown).toBeInstanceOf(PartialPoll)
    expect((thrown as PartialPoll).cards).toBe(cards)
  })
})

/**
 * The wire format does not reach the desk.
 *
 * Both of these were read off the deployed page rather than imagined. A
 * `#spendflo-truto` row's Who column, its From row and the author of every line
 * in its thread list all read `Varad (U08HCR8KXQB, external: spendflo)`, because
 * `parseWho`'s id pattern closed on `)` and a guest from another workspace
 * carries a comma and a workspace name inside those parentheses. And a `#truto`
 * row's title read `<!subteam^S06HDT77E1M> Whoever is looking into it`, because
 * a thread card's text went through `clean` — which knows `<@U…|Name>` and not
 * the four other tokens Slack writes.
 */
describe('a thread card is text, not Slack markup', () => {
  test('a guest author keeps their name and loses their workspace', () => {
    const read = parseThreadRead(
      '=== THREAD PARENT MESSAGE ===\n' +
      'From: rameshsutaliya (U09038ZHE3H, external: spendflo)\n' +
      'Time: 2026-08-27 12:04:59 IST\n' +
      'Message TS: 1784530611.515999\n' +
      'Hi team, *NetSuite SuiteTax Setup* — we have begun working on it\n' +
      '\n=== THREAD REPLIES (1 total) ===\n\n' +
      '--- Reply 1 of 1 ---\n' +
      'From: ishan (U08J4DL6W1K, external: spendflo)\n' +
      'Time: 2026-08-27 12:35:33 IST\n' +
      'Message TS: 1784530700.100000\n' +
      'could we split this instead\n',
    )
    expect(read.parent?.who).toBe('rameshsutaliya')
    expect(read.parent?.whoId).toBe('U09038ZHE3H')
    expect(read.replies[0]?.who).toBe('ishan')
    expect(read.replies[0]?.whoId).toBe('U08J4DL6W1K')
  })

  test('the name that survives is still the one with an email beside it', () => {
    const read = parseThreadRead(
      '=== THREAD PARENT MESSAGE ===\n' +
      'From: Nidhi <nidhi@truto.one> (U0BBZV4HQHH)\n' +
      'Time: 2026-08-27 12:04:59 IST\n' +
      'Message TS: 1787812499.720579\n' +
      'a question\n',
    )
    expect(read.parent?.who).toBe('Nidhi')
    expect(read.parent?.whoId).toBe('U0BBZV4HQHH')
  })

  test('a usergroup page and Slack emphasis are words by the time they are a title', () => {
    expect(plain('<!subteam^S06HDT77E1M> Whoever is looking into it'))
      .toBe('Whoever is looking into it')
    expect(plain('Hi team, *NetSuite SuiteTax Setup* — begun'))
      .toBe('Hi team, NetSuite SuiteTax Setup — begun')
  })
})
