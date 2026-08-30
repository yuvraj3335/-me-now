/**
 * One row per thread, and nothing from a direct message.
 *
 * Two facts are pinned here, and both were measured on the live desk before a
 * line was changed: a `#truto` conversation occupied three rows because the row
 * was keyed on each message's own timestamp, and half the Slack desk was direct
 * messages. Everything in this file drives the real captured payloads through
 * the real parsers — no mock speaks Slack's dialect well enough to be worth
 * trusting with this.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  alertIsOnHim, bucketAlerts, bucketHits, buildThreadCard, isDirectMessage, parentTs,
  parseChannelRead, parseSlackResults, parseThreadRead,
  type ThreadBucket,
} from '../src/server/sources/slack'
import { groupCards } from '../src/server/dedup'
import { PartialPoll, settle, type RawCard } from '../src/server/sources/types'
import {
  CHANNEL_READ, CHANNEL_READ_METRONOME, CHANNEL_READ_WORDLESS, ME_ID,
  SEARCH_FIREHOSE, SEARCH_ONE_THREAD, SEARCH_ORPHAN_REPLY,
  SEARCH_WITH_DM, THREAD_READ, TRUTO_ENG,
} from './fixtures/slack'

const GROUPS = [TRUTO_ENG]

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
    expect(parentTs({ ts: '1.2', permalink: '' })).toBe('1.2')
    expect(parentTs({ ts: '1.2', permalink: 'not a url' })).toBe('1.2')
  })
})

/* ---------------------------- 2 & 3. one row ------------------------------ */

describe('a thread is one row', () => {
  test('three hits on one thread produce one card, titled from the parent', () => {
    const hits = parseSlackResults(SEARCH_ONE_THREAD)
    expect(hits).toHaveLength(3)

    const [key, bucket] = only(bucketHits(hits, ME_ID))
    expect(key).toBe('C04D9HKDWAV:1787812499.720579')
    expect(bucket.hits).toHaveLength(3)

    const card = buildThreadCard(bucket, READ, ME_ID, GROUPS)!
    expect(card.source_id).toBe('C04D9HKDWAV:1787812499.720579')
    expect(card.refs).toContainEqual({ t: 'slackthread', v: 'C04D9HKDWAV:1787812499.720579' })
    // Not "what did we land on here", which is the reply the search ranked first.
    expect(card.title).toContain('can you confirm the clearing behavior')
    expect(card.meta!.thread_ts).toBe('1787812499.720579')
  })

  test('a hit whose parent is not in the results still gets the parent from the read', () => {
    // The `#spendflo-truto` shape: he was named in a reply, and the parent
    // predates the lookback so search never returns it. Without the thread read
    // this row's title is somebody answering a question the desk never showed.
    const hits = parseSlackResults(SEARCH_ORPHAN_REPLY)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.ts).not.toBe('1787812499.720579')

    const [, bucket] = only(bucketHits(hits, ME_ID))
    expect(bucket.seed, 'the parent was not among the hits').toBeNull()

    const card = buildThreadCard(bucket, READ, ME_ID, GROUPS)!
    expect(card.title).toContain('can you confirm the clearing behavior')
    expect(card.actor).toBe('Nidhi')
    expect(card.meta!.thread_partial).toBeUndefined()
  })

  test('the card links to the parent, not to the reply that was found', () => {
    const hits = parseSlackResults(SEARCH_ORPHAN_REPLY)
    const [, bucket] = only(bucketHits(hits, ME_ID))
    const card = buildThreadCard(bucket, READ, ME_ID, GROUPS)!
    expect(card.url).toContain('p1787812499720579')
    expect(card.url).not.toContain('p1787820616819949')
  })
})

/* ------------ 3b. what a conversation is allowed to say about itself ------ */

describe('a link in a thread is a pointer, not a second identity', () => {
  test('a permalink somebody pasted does not become this row\'s thread ref', () => {
    // Nidhi's parent quotes `…/archives/C0AHHQMF08L/p1787777335863559`. Read as
    // a thread reference it gave this row a second identity, so any other thread
    // that quoted the same link was unioned into it — and one desk row then
    // spoke for two conversations while the other's title, why and Who
    // disappeared into `sources`.
    const [, bucket] = only(bucketHits(parseSlackResults(SEARCH_ONE_THREAD), ME_ID))
    const card = buildThreadCard(bucket, READ, ME_ID, GROUPS)!

    expect(card.refs.filter(r => r.t === 'slackthread')).toEqual([
      { t: 'slackthread', v: 'C04D9HKDWAV:1787812499.720579' },
    ])
  })

  test('two unrelated threads quoting one link stay two rows', () => {
    const [, bucket] = only(bucketHits(parseSlackResults(SEARCH_ONE_THREAD), ME_ID))
    const mine = buildThreadCard(bucket, READ, ME_ID, GROUPS)!
    const billing: RawCard = {
      source: 'slack', source_id: 'C0BILLING1:1787900000.111111', kind: 'thread',
      title: 'the invoice run', why: 'you were mentioned in #billing',
      url: 'https://truto.slack.com/archives/C0BILLING1/p1787900000111111',
      ts: 1787900000111, pile: 'now',
      refs: [
        { t: 'slackthread', v: 'C0BILLING1:1787900000.111111' },
        // The same link, pasted in a completely different conversation.
        { t: 'slackthread', v: 'C0AHHQMF08L:1787777335.863559' },
      ],
    }
    const groups = groupCards([mine, billing])
    expect(groups.get('slack:C04D9HKDWAV:1787812499.720579'))
      .not.toBe(groups.get('slack:C0BILLING1:1787900000.111111'))
  })

  test('every other reference in a reply still counts', () => {
    // The rule is narrow on purpose: a `TRUTO-38` posted in a reply is exactly
    // what collapsing a thread into one row is supposed to be able to see.
    const [, bucket] = only(bucketHits(parseSlackResults(SEARCH_ONE_THREAD), ME_ID))
    const withRef = parseThreadRead(THREAD_READ.replace('Added comments', 'looks like TRUTO-38'))
    const card = buildThreadCard(bucket, withRef, ME_ID, GROUPS)!
    expect(card.refs).toContainEqual({ t: 'sentry', v: 'TRUTO-38' })
  })
})

/* ---------------- 3c. what he said himself is not on him ------------------ */

describe('the desk does not hand him back what he just said', () => {
  const HIS_PAGE = `# Search Results for: <!subteam^S06HDT77E1M> after:2026-08-16

### Result 1 of 1
Channel: #truto-eng (ID: C0ENGCHAN1)
From: Yuvraj Muley <yuvraj@truto.one> (ID: U09617LRRDF)
Message_ts: 1788000000.100000
Permalink: [link](https://truto.slack.com/archives/C0ENGCHAN1/p1788000000100000?thread_ts=1788000000.100000&cid=C0ENGCHAN1)
Text:
<!subteam^S06HDT77E1M|@truto-eng> heads up, deploying the MFA fix now
`

  test('his own page to his own team is not a row', () => {
    // One of the two searches asks for his usergroup and he is on that team, so
    // every announcement he writes comes back as a hit of his own. Decided on
    // his own text it landed as `now` — the pile that means somebody is waiting
    // — with an empty Who, because the only tagged message in it was his.
    const [, bucket] = only(bucketHits(parseSlackResults(HIS_PAGE), ME_ID))
    expect(buildThreadCard(bucket, null, ME_ID, GROUPS)).toBeNull()
  })

  test('the same thread lands the moment somebody else says something', () => {
    const [, bucket] = only(bucketHits(parseSlackResults(HIS_PAGE), ME_ID))
    const answered = parseThreadRead(`=== THREAD PARENT MESSAGE ===
From: Yuvraj Muley <yuvraj@truto.one> (U09617LRRDF)
Time: 2026-08-30 12:00:00 IST
Message TS: 1788000000.100000
<!subteam^S06HDT77E1M|@truto-eng> heads up, deploying the MFA fix now

=== THREAD REPLIES (1 total) ===

--- Reply 1 of 1 ---
From: Riya <riya@truto.one> (U0B5V7G3NQ5)
Time: 2026-08-30 12:05:00 IST
Message TS: 1788000300.100000
<@U09617LRRDF> can you hold that until the migration lands?
`)
    const card = buildThreadCard(bucket, answered, ME_ID, GROUPS)!
    expect(card.pile).toBe('now')
    expect(card.why).toBe('you were mentioned in #truto-eng')
    expect(card.who, 'the person waiting is the one who asked').toBe('Riya')
  })

  test('a message he wrote is never marked as naming him', () => {
    // `tagged` draws the `@you` rule in the detail pane and fills the Who
    // column. On his own line it is the pane telling him he is waiting on
    // himself — and he is on `@truto-eng`, so the raw text really does name a
    // group he is in every time he pages his own team.
    const [, bucket] = only(bucketHits(parseSlackResults(HIS_PAGE), ME_ID))
    const read = parseThreadRead(THREAD_READ)
    const card = buildThreadCard({ ...bucket, seed: null }, read, ME_ID, GROUPS)!
    const thread = card.meta!.thread as Array<{ mine: boolean; tagged: boolean }>
    expect(thread.filter(e => e.mine).every(e => !e.tagged)).toBe(true)
  })
})

/* ------------------------------ 4. no DMs -------------------------------- */

describe('a direct message can never reach the desk', () => {
  test('a DM-shaped hit never becomes a bucket, from either query', () => {
    const hits = parseSlackResults(SEARCH_WITH_DM)
    expect(hits).toHaveLength(3)

    const buckets = bucketHits(hits, ME_ID)
    for (const b of buckets.values()) {
      expect(b.channelId.startsWith('D'), `${b.channelId} is a DM`).toBe(false)
    }
    // The third hit is `#dm-tools` — a real public channel whose name merely
    // begins with the two letters. Dropping it would be the ban overreaching.
    const [key] = only(buckets)
    expect(key).toContain('C0DMTOOLS1')
  })

  test('every tell a DM has, in one function', () => {
    expect(isDirectMessage({ channelId: 'D0BT1ED811Q' })).toBe(true)
    expect(isDirectMessage({ channelName: 'DM (ID: D0BT1ED811Q)' })).toBe(true)
    expect(isDirectMessage({ channelName: 'MPIM' })).toBe(true)
    expect(isDirectMessage({ isDm: true })).toBe(true)
    expect(isDirectMessage({ channelId: 'C04D9HKDWAV', channelName: '#truto' })).toBe(false)
    expect(isDirectMessage({ channelId: 'C0DMTOOLS1', channelName: '#dm-tools' })).toBe(false)
  })

  test('the one function every Slack card is built by refuses a DM outright', () => {
    // `bucketHits` guards the search pipe and Fetch guards its own two. This
    // guards the desk: a bucket assembled by hand, or an alert channel
    // misconfigured with a `D` id, still cannot produce a row.
    const dm: ThreadBucket = {
      channelId: 'D0BT1ED811Q', channelName: 'DM', parent: '1787808801.580799',
      hits: [], alert: false, host: null, newest: 1787808801580,
      seed: {
        ts: '1787808801.580799', epochMs: 1787808801580,
        who: 'Ramesh Sutaliya', whoId: 'U09038ZHE3H',
        text: `<@${ME_ID}> can you check with Varad`,
      },
    }
    expect(buildThreadCard(dm, null, ME_ID, GROUPS)).toBeNull()
    expect(
      buildThreadCard({ ...dm, channelId: 'C04D9HKDWAV', channelName: '#truto' }, null, ME_ID, GROUPS),
      'the guard is eating real channels',
    ).not.toBeNull()
  })

  test('the DM query and the dm kind are gone from every pipe', () => {
    // Structural, because the ban has to survive somebody adding a query back:
    // there is no `to:me` left to ask with and no `dm` left to label a row.
    // Comments are stripped first — the files explain the ban, and explaining it
    // must not read as breaking it.
    const code = (path: string) =>
      readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    for (const f of ['src/server/sources/slack.ts', 'src/server/fetch/index.ts']) {
      expect(code(f), `${f} still asks a DM question`).not.toContain('to:me')
      expect(code(f), `${f} still mints a dm row`).not.toMatch(/kind:.*['"]dm['"]/)
    }
  })
})

/* --------------------------- firehose channels ---------------------------- */

describe('a firehose channel lands only when he is named', () => {
  test('#github-updates keeps the message that names him and drops the rest', () => {
    const hits = parseSlackResults(SEARCH_FIREHOSE)
    expect(hits).toHaveLength(2)

    const buckets = bucketHits(hits, ME_ID)
    const [, bucket] = only(buckets)
    expect(bucket.hits[0]!.text).toContain('requested as a reviewer')
  })
})

/* ------------------------- 5. the alert channel --------------------------- */

describe('the alert channel Slack search cannot see', () => {
  test('the channel read parses two messages and finds the usergroup', () => {
    const read = parseChannelRead(CHANNEL_READ)
    expect(read.channelId).toBe('C0BERTMS9K4')
    expect(read.channelName).toBe('#sentry-alerts')
    expect(read.messages).toHaveLength(2)

    const [cursor, sentry] = read.messages
    expect(cursor!.who).toBe('Cursor')
    expect(cursor!.whoId).toBe('U092446PCTV')
    expect(cursor!.ts).toBe('1788094634.851449')
    expect(sentry!.who).toBe('Sentry')

    // The line that justifies reading rather than searching. It is Block Kit,
    // and Slack's search index does not return it.
    expect(sentry!.text).toContain(`<!subteam^${TRUTO_ENG}|@truto-eng>`)
  })

  test('the Sentry post becomes a card that pages the usergroup and names the issue', () => {
    const read = parseChannelRead(CHANNEL_READ)
    const card = alertCard(read, 1)

    expect(card.kind).toBe('alert')
    expect(card.why).toBe('@truto-eng in #sentry-alerts')
    expect(card.pile).toBe('now')
    expect(card.meta!.usergroup).toBe('@truto-eng')
    expect(card.refs).toContainEqual({ t: 'sentry', v: 'TRUTO-38' })
    // A bot is not a person waiting on him, so the Who column stays empty.
    expect(card.who).toBeUndefined()
  })

  test('a channel read carries no permalink, so one is built', () => {
    const card = alertCard(parseChannelRead(CHANNEL_READ), 0)
    expect(card.url).toBe('https://truto.slack.com/archives/C0BERTMS9K4/p1788094634851449')
  })

  test('an alert nobody named him in is open, not now', () => {
    const read = parseChannelRead(CHANNEL_READ)
    // The Cursor follow-up quotes the issue but pages no one.
    const card = alertCard(read, 0)
    expect(card.pile).toBe('open')
    expect(card.why).toBe('posted in #sentry-alerts')
  })

  test('one digest message is one card, however many error rows it lists', () => {
    // The whole shape of the fix: a card is built per *message*, so a digest
    // that names forty failing endpoints is one row on the desk.
    const read = parseChannelRead(CHANNEL_READ)
    expect(read.messages.map(m => m.ts)).toEqual(['1788094634.851449', '1788094379.882969'])
  })
})

/* ------------- 5b. what an alert channel is allowed to land ---------------- */

describe('an alert channel is not replicated onto the desk', () => {
  /*
   * DESIGN §7, which was written after the channel was read live and supersedes
   * the "one card per digest message" line before it. `#truto-api-alerts` has no
   * digest in it: it has Datadog posting a `Warn:` and a `Recovered:` six
   * minutes apart, forever, naming `@slack-truto-api-alerts` — a channel handle,
   * not him and not a usergroup he is in. A card per message is a metronome.
   *
   * These drive `bucketAlerts`, which is the function the poll actually calls,
   * rather than the predicate underneath it. A rule tested only through its
   * predicate is a rule that can be left unwired, which is exactly what had
   * happened: the predicate did not exist and every message became a row.
   */
  const CUTOFF = 0
  const fold = (md: string, fallback = { id: 'C05UPHVT2CQ', name: 'truto-api-alerts' }) =>
    bucketAlerts(new Map<string, ThreadBucket>(), parseChannelRead(md), fallback, ME_ID, CUTOFF, GROUPS)

  test('the Datadog metronome never reaches the desk', () => {
    const read = parseChannelRead(CHANNEL_READ_METRONOME)
    expect(read.messages, 'the fixture stopped carrying all three messages').toHaveLength(3)

    const buckets = fold(CHANNEL_READ_METRONOME)
    // Only the digest that pages @truto-eng. The Warn and the Recovered name a
    // channel handle, which is not him.
    expect([...buckets.keys()]).toEqual(['C05UPHVT2CQ:1788103800.000100'])
  })

  test('the paging digest lands, as one card', () => {
    const [, bucket] = only(fold(CHANNEL_READ_METRONOME))
    const card = buildThreadCard(bucket, null, ME_ID, GROUPS)!
    expect(card.pile).toBe('now')
    expect(card.why).toBe('@truto-eng in #truto-api-alerts')
    expect(card.title).toContain('4 endpoints over budget')
  })

  test('#sentry-alerts still lands both messages, on the Sentry reference', () => {
    // The whole reason these channels are read rather than searched. The Sentry
    // post pages @truto-eng; Cursor's follow-up names nobody at all and earns
    // its place with `TRUTO-38`, which is also what merges the two.
    const buckets = fold(CHANNEL_READ, { id: 'C0BERTMS9K4', name: 'sentry-alerts' })
    expect([...buckets.keys()]).toEqual([
      'C0BERTMS9K4:1788094634.851449',
      'C0BERTMS9K4:1788094379.882969',
    ])
  })

  test('a row the search already earned keeps its place and gains the Block Kit text', () => {
    // A message can be both: search returned it, and the channel read carries
    // the `notes:` line search cannot see. The admission rule must not throw
    // away a bucket that arrived by another route.
    const seeded = new Map<string, ThreadBucket>([
      ['C05UPHVT2CQ:1788108092.130049', {
        channelId: 'C05UPHVT2CQ', channelName: '#truto-api-alerts',
        parent: '1788108092.130049', hits: [], alert: false, seed: null,
        host: null, newest: 1788108092130,
      }],
    ])
    bucketAlerts(seeded, parseChannelRead(CHANNEL_READ_METRONOME),
      { id: 'C05UPHVT2CQ', name: 'truto-api-alerts' }, ME_ID, CUTOFF, GROUPS)

    const kept = seeded.get('C05UPHVT2CQ:1788108092.130049')!
    expect(kept.alert, 'a search hit in an alert channel stopped being an alert').toBe(true)
    expect(kept.seed?.text, 'the channel read text never reached the bucket').toContain('Recovered')
  })

  test('a bucket the search already seeded still gains the Block Kit', () => {
    /*
     * The half of that the `??=` got wrong. A Sentry alert that also names him
     * in plain text is returned by the `<@me>` search on its own ts, so the
     * bucket arrives already seeded — with the search index's projection of the
     * message, which has no Block Kit in it. Kept, the row carried neither the
     * `@truto-eng` page nor the `sentry:` references that union it with the
     * Sentry issue's own card: one incident, two desk rows.
     */
    const read = parseChannelRead(CHANNEL_READ, 'C0BERTMS9K4')
    const thin = { text: `:red_circle: TypeError cc <@${ME_ID}>`, ts: '1788094379.882969' }
    const seeded = new Map<string, ThreadBucket>([
      ['C0BERTMS9K4:1788094379.882969', {
        channelId: 'C0BERTMS9K4', channelName: '#sentry-alerts', parent: thin.ts,
        hits: [{
          channelId: 'C0BERTMS9K4', channelName: '#sentry-alerts', isDm: false,
          fromName: 'Sentry', fromId: 'U0BFL7HM40Y', ts: thin.ts,
          epochMs: 1788094379882, permalink: '', text: thin.text,
        }],
        alert: false,
        seed: { ts: thin.ts, epochMs: 1788094379882, who: 'Sentry', whoId: 'U0BFL7HM40Y', text: thin.text },
        host: null, newest: 1788094379882,
      }],
    ])
    bucketAlerts(seeded, read, { id: 'C0BERTMS9K4', name: 'sentry-alerts' }, ME_ID, CUTOFF, GROUPS)

    const card = buildThreadCard(seeded.get('C0BERTMS9K4:1788094379.882969')!, null, ME_ID, GROUPS)!
    expect(card.meta!.usergroup, 'the Block Kit page never reached the card').toBe('@truto-eng')
    expect(card.refs).toContainEqual({ t: 'sentry', v: 'TRUTO-38' })
    expect(card.refs).toContainEqual({ t: 'sentry', v: '7700748352' })
  })

  test('a thread read with nothing in it does not erase the message we hold', () => {
    /*
     * An alert's body lives in Block Kit, and a thread read of the same message
     * can come back as a header and an `Attachments:` line — which `bodyAfterTs`
     * drops as transport, leaving an empty parent. Preferred over the seed, that
     * empty parent took the title with it and the card was refused outright, so
     * an alert `alertIsOnHim` had just admitted vanished from the desk.
     */
    const read = parseChannelRead(CHANNEL_READ, 'C0BERTMS9K4')
    const sentry = read.messages.find(m => m.ts === '1788094379.882969')!
    const bucket: ThreadBucket = {
      channelId: 'C0BERTMS9K4', channelName: '#sentry-alerts', parent: sentry.ts,
      hits: [], alert: true, seed: sentry, host: null, newest: sentry.epochMs,
    }
    const wordless = parseThreadRead(`=== THREAD PARENT MESSAGE ===
From: Sentry <botuser@slack-bots.com> (U0BFL7HM40Y)
Time: 2026-08-30 18:22:59 IST
Message TS: 1788094379.882969
Attachments: TypeError (https://truto.sentry.io/issues/7700748352/)

=== THREAD REPLIES (0 total) ===
`)
    expect(wordless.parent!.text, 'the fixture stopped being wordless').toBe('')

    const card = buildThreadCard(bucket, wordless, ME_ID, GROUPS)
    expect(card, 'an admitted alert was refused because its thread read was empty').not.toBeNull()
    expect(card!.title).toContain('TypeError')
    expect(card!.meta!.usergroup).toBe('@truto-eng')
  })

  test('a message older than the lookback is not read back onto the desk', () => {
    const future = Date.now() + 864e5
    expect([...fold(CHANNEL_READ_METRONOME).keys()]).toHaveLength(1)
    expect([...bucketAlerts(
      new Map<string, ThreadBucket>(), parseChannelRead(CHANNEL_READ_METRONOME),
      { id: 'C05UPHVT2CQ', name: 'truto-api-alerts' }, ME_ID, future, GROUPS,
    ).keys()]).toEqual([])
  })

  test('the rule is the three tells and nothing else', () => {
    expect(alertIsOnHim(`<@${ME_ID}> can you look`, ME_ID, GROUPS)).toBe(true)
    expect(alertIsOnHim(`<!subteam^${TRUTO_ENG}|@truto-eng> paged`, ME_ID, GROUPS)).toBe(true)
    expect(alertIsOnHim('Short ID: TRUTO-38', ME_ID, GROUPS)).toBe(true)
    expect(alertIsOnHim('https://truto.sentry.io/issues/7700748352/', ME_ID, GROUPS)).toBe(true)
    // A channel handle is not a person and not a usergroup.
    expect(alertIsOnHim('Notified: @slack-truto-api-alerts', ME_ID, GROUPS)).toBe(false)
    expect(alertIsOnHim('Deploy finished in 43s', ME_ID, GROUPS)).toBe(false)
  })
})

/* --------------------- 5c. an untitled row is worse ----------------------- */

describe('a message with no words is not a row', () => {
  test('a body that renders empty never becomes a card', () => {
    // It used to become `Message from Sentry` — a title that says only which
    // robot spoke, so the only way to learn what the row is is to open it.
    const read = parseChannelRead(CHANNEL_READ_WORDLESS)
    expect(read.messages, 'the fixture stopped parsing').toHaveLength(1)
    expect(read.messages[0]!.text, 'Reactions and Files are transport').toBe('')

    const m = read.messages[0]!
    expect(buildThreadCard({
      channelId: read.channelId, channelName: read.channelName, parent: m.ts,
      hits: [], alert: true, seed: m, host: null, newest: m.epochMs,
    }, null, ME_ID, GROUPS)).toBeNull()

    // And it is refused one step earlier too, so it never even buckets.
    expect([...bucketAlerts(
      new Map<string, ThreadBucket>(), read,
      { id: 'C0BERTMS9K4', name: 'sentry-alerts' }, ME_ID, 0, GROUPS,
    ).keys()]).toEqual([])
  })

  test('a wordless parent still yields a row when the thread has words', () => {
    // The row is the thread, not the parent. An uncaptioned screenshot with a
    // real conversation under it is work; dropping it would lose that.
    const card = buildThreadCard(
      {
        channelId: 'C04D9HKDWAV', channelName: '#truto', parent: '1787812499.720579',
        hits: [], alert: false, seed: null, host: null, newest: 1787812499720,
      },
      {
        parent: { ts: '1787812499.720579', epochMs: 1787812499720, who: 'Nidhi', whoId: 'U0BBZV4HQHH', text: '' },
        replies: [{ ts: '1787814333.427979', epochMs: 1787814333427, who: 'Riya', whoId: 'U0B5V7G3NQ5', text: `<@${ME_ID}> ptal` }],
        replyTotal: 1,
      },
      ME_ID, GROUPS,
    )
    expect(card, 'a thread with words in it was dropped').not.toBeNull()
    expect(card!.title).toBe('@U09617LRRDF ptal')
  })
})

/* ---------------------------- 6. the thread read -------------------------- */

describe('the thread read answers everything a row needs at once', () => {
  test('ten replies, the parent author, and the parent naming him', () => {
    expect(READ.replyTotal, 'the header is authoritative, not the page').toBe(10)
    expect(READ.parent!.who).toBe('Nidhi')
    expect(READ.parent!.whoId).toBe('U0BBZV4HQHH')
    expect(READ.replies).toHaveLength(4)

    const card = buildThreadCard(bucketFor(READ), READ, ME_ID, GROUPS)!
    expect(card.meta!.replies).toBe(10)
    expect((card.meta!.parent as any).tagged).toBe(true)
    expect((card.meta!.parent as any).mine).toBe(false)
  })

  test('his own replies are marked his own, and Riya`s is not', () => {
    const card = buildThreadCard(bucketFor(READ), READ, ME_ID, GROUPS)!
    const thread = card.meta!.thread as Array<{ who: string; mine: boolean }>
    expect(thread.map(e => e.mine)).toEqual([true, true, true, false])
    expect(thread[3]!.who).toBe('Riya')
  })

  test('Reactions and Files are transport, not something somebody said', () => {
    const fourth = READ.replies[2]!
    expect(fourth.text).toContain('crazy blunder')
    expect(fourth.text).not.toContain('Files:')
    expect(READ.parent!.text).not.toContain('Reactions:')
  })

  test('a body runs to the end of the message, not to the end of its first line', () => {
    expect(READ.parent!.text).toContain('Forwarded message from Sunny Siu')
  })
})

/* -------------------------- 7. one Sentry short id ------------------------ */

describe('a Sentry short id is one row', () => {
  test('the Cursor follow-up, the Sentry post and the API row are one group', () => {
    const read = parseChannelRead(CHANNEL_READ)
    const cursor = alertCard(read, 0)
    const sentryPost = alertCard(read, 1)

    // The Sentry adapter's own row, in the shape it builds.
    const apiRow: RawCard = {
      source: 'sentry',
      source_id: 'TRUTO-38',
      kind: 'error',
      title: "TypeError: Cannot read properties of undefined (reading 'payload_transform')",
      why: 'assigned to you in Sentry',
      url: 'https://truto.sentry.io/issues/7700748352/',
      ts: 1788094379000,
      pile: 'now',
      refs: [{ t: 'sentry', v: 'TRUTO-38' }, { t: 'sentry', v: '7700748352' }],
    }

    const keys = groupCards([cursor, sentryPost, apiRow])
    expect(new Set(keys.values()).size, 'the same error landed on more than one row').toBe(1)
  })
})

/* ------------------------------- 8. honesty ------------------------------- */

describe('honesty about what a poll could not ask', () => {
  test('an alert channel that did not answer makes the poll partial', () => {
    const cards: RawCard[] = []
    const asked: Array<PromiseSettledResult<unknown>> = [
      { status: 'fulfilled', value: [] },
      { status: 'rejected', reason: new Error('channel_not_found') },
    ]
    let thrown: unknown
    try { settle('slack', asked, cards) } catch (e) { thrown = e }

    expect(thrown).toBeInstanceOf(PartialPoll)
    // The rows survive and the sweep authority does not: ingest reads both off
    // this object, and a poll that cannot say what is missing must not delete.
    expect((thrown as PartialPoll).cards).toBe(cards)
  })

  test('everything failing is a failed poll, not an empty one', () => {
    expect(() => settle('slack', [{ status: 'rejected', reason: new Error('401') }], []))
      .toThrow('401')
  })

  test('a thread read that failed degrades one row and says so', () => {
    const hits = parseSlackResults(SEARCH_ONE_THREAD)
    const [, bucket] = only(bucketHits(hits, ME_ID))
    const card = buildThreadCard(bucket, null, ME_ID, GROUPS)!

    // Still one row, still titled from the parent — because the search happened
    // to return it — and honest about having read no replies.
    expect(card.meta!.thread_partial).toBe(true)
    expect(card.meta!.replies).toBe(0)
    expect(card.title).toContain('can you confirm the clearing behavior')
  })
})

/* --------------------------------- helpers -------------------------------- */

/** A bucket for a thread the search found nothing about, as an alert channel makes. */
function alertCard(read: ReturnType<typeof parseChannelRead>, i: number): RawCard {
  const m = read.messages[i]!
  return buildThreadCard(
    {
      channelId: read.channelId,
      channelName: read.channelName,
      parent: m.ts,
      hits: [],
      alert: true,
      seed: m,
      host: null,
      newest: m.epochMs,
    },
    null,
    ME_ID,
    GROUPS,
  )!
}

/** The `#truto` thread's bucket, with no search hits behind it. */
function bucketFor(read: ReturnType<typeof parseThreadRead>) {
  return {
    channelId: 'C04D9HKDWAV',
    channelName: '#truto',
    parent: read.parent!.ts,
    hits: [],
    alert: false,
    seed: null,
    host: null,
    newest: read.parent!.epochMs,
  }
}
