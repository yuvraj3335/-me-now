/**
 * Slack brings work in from a named list of channels, and from nowhere else.
 *
 * Measured on the deployed desk before a line was changed: the mention search
 * was workspace-wide, and a workspace is much bigger than the work. Four of the
 * twenty slots a poll gets went to `#github-updates`, `#pr-reviews` and a Slack
 * list rendering as `#FC:F096Q3LBF7C:Sprint Tasks` — places the operator does
 * not work — while the customer channels he does work in competed for what was
 * left.
 *
 * Two changes, and only one of them is a guarantee. The query now names the
 * eighteen channels, which is an economy: it stops the cap being spent on rows
 * nobody will act on. The refusal is in `bucketHits`, beside the direct-message
 * rule, which is what makes the list true regardless of what Slack does with a
 * query string. This file is mostly about the second one, because the first is
 * allowed to stop working and the second is not.
 *
 * The hits below are built rather than captured, because what is under test is
 * a decision and not a dialect — `test/slack-threads.test.ts` and
 * `test/slack-parse.test.ts` own the parsers, and `SEARCH_WITH_DM` in
 * `test/fixtures/slack.ts` carries the real search spelling of both refusals.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  bareChannel, isAllowedSlackChannel, SLACK_ALERT_CHANNELS, SLACK_CHANNELS,
} from '../src/server/env'
import {
  bucketHits, CHANNEL_SCOPE, parseSlackResults, searchArgs, type SlackHit,
} from '../src/server/sources/slack'
import { ME_ID } from './fixtures/slack'
import { slackCard } from '../src/server/fetch/index'
import type { SearchHit } from '../src/server/sources/search'

/** The eighteen, exactly as the operator wrote them. This is the specification. */
const THE_LIST = [
  '#truto', '#clonepartner', '#sprinto', '#maximor-truto', '#spendflo-truto',
  '#15five-truto', '#komplai-truto', '#evergrowth-truto', '#thoropass-truto',
  '#open-truto', '#stax-truto', '#naq-truto', '#docsbot-truto', '#truto-balkanid',
  '#ex-superhawk-truto', '#truto-zen', '#framer-clonepartner', '#crisp-chats',
]

/** The four that were really on the desk on 2026-08-31 and should not have been. */
const THE_INTRUDERS: Array<[string, string]> = [
  ['#github-updates', 'C0GHUPD8TE5'],
  ['#pr-reviews', 'C0PRREVW111'],
  ['#FC:F096Q3LBF7C:Sprint Tasks', 'F096Q3LBF7C'],
  ['#intent-alerts', 'C07UWPPLSGN'],
]

let seq = 0
/** One search hit, with only the fields a refusal is allowed to read. */
const hit = (channelName: string, channelId: string, over: Partial<SlackHit> = {}): SlackHit => {
  const ts = `178781${String(1000 + seq++).slice(-4)}.100000`
  return {
    channelId,
    channelName,
    isDm: channelId.startsWith('D'),
    fromName: 'Nidhi',
    fromId: 'U0BBZV4HQHH',
    ts,
    epochMs: Number(ts.split('.')[0]) * 1000,
    permalink: `https://truto.slack.com/archives/${channelId}/p${ts.replace('.', '')}`,
    text: `<@${ME_ID}> can you look at this`,
    ...over,
  }
}

/* --------------------------- 1. what gets through ------------------------- */

describe('a hit becomes a bucket only from a channel on the list', () => {
  test('every one of the eighteen opens a bucket', () => {
    // Named one at a time rather than in a single call, so a failure says which
    // channel stopped working instead of "one of eighteen".
    for (const name of THE_LIST) {
      const c = SLACK_CHANNELS.find(x => x.name === bareChannel(name))!
      expect(c, `${name} is not in SLACK_CHANNELS`).toBeTruthy()
      const buckets = bucketHits([hit(name, c.id ?? 'C0UNKNOWN01')], ME_ID)
      expect(buckets.size, `${name} stopped reaching the desk`).toBe(1)
    }
  })

  test('and the channels that were taking the slots do not', () => {
    for (const [name, id] of THE_INTRUDERS) {
      expect(bucketHits([hit(name, id)], ME_ID).size, `${name} is still on the desk`).toBe(0)
    }
  })

  test('one poll of both is only the half that is his', () => {
    // The real shape of a poll: the list and the workspace arrive interleaved in
    // one answer, and the filter has to hold per row rather than per call.
    const hits = [
      hit('#truto', 'C04D9HKDWAV'),
      hit('#github-updates', 'C0GHUPD8TE5'),
      hit('#spendflo-truto', 'C05CJ0CUV35'),
      hit('#pr-reviews', 'C0PRREVW111'),
    ]
    expect([...bucketHits(hits, ME_ID).keys()].map(k => k.split(':')[0]))
      .toEqual(['C04D9HKDWAV', 'C05CJ0CUV35'])
  })

  test('a direct message is still refused, and by its own rule', () => {
    // Two rules that would each refuse this on their own. The DM one is asked
    // first and it is the one that must not be lost: a `D…` conversation would
    // be refused by the channel list only because nobody can put a DM on it, and
    // "unreachable by accident" is not a refusal.
    for (const id of ['D0BT1ED811Q', 'D0BQQQQ1111']) {
      expect(bucketHits([hit('DM', id)], ME_ID).size).toBe(0)
      expect(isAllowedSlackChannel('DM', id), 'a DM must not be on the list either').toBe(false)
    }
  })

  test('a message he wrote himself is still refused', () => {
    // Unchanged by any of this, and asserted here because the new refusal sits
    // between the DM rule and this one — a `continue` in the wrong place would
    // take it out silently.
    const mine = hit('#truto', 'C04D9HKDWAV', { fromId: ME_ID })
    expect(bucketHits([mine], ME_ID).size).toBe(0)
  })
})

/* ------------------------- 2. how a name is matched ----------------------- */

describe('the name is matched the way a person writes it', () => {
  test('the hash is rendering, and case is not a fact', () => {
    for (const spelling of ['#truto', 'truto', 'TRUTO', '#TRUTO', '  #Truto  ']) {
      expect(isAllowedSlackChannel(spelling), `${spelling} did not read as #truto`).toBe(true)
    }
  })

  test('a stored card reads the same as a fresh hit', () => {
    // `meta.channel` on a stored card is a display name and has been written
    // both ways by the two card builders — `buildThreadCard` stores whatever
    // the search said, `alertMeta` stores `#${ch.name}`.
    expect(isAllowedSlackChannel('#spendflo-truto', 'C05CJ0CUV35')).toBe(true)
    expect(isAllowedSlackChannel('spendflo-truto', 'C05CJ0CUV35')).toBe(true)
  })

  test('the id answers when the name cannot', () => {
    /*
     * `parseSlackResults` substitutes the channel id for the name when the
     * `Channel:` line carried no readable one, so a hit can arrive with a good
     * id and a name that is really an id. A name-only rule refuses that row —
     * and it is a row from a channel he works in.
     */
    const noName = hit('C04D9HKDWAV', 'C04D9HKDWAV')
    expect(isAllowedSlackChannel(noName.channelName, noName.channelId)).toBe(true)
    expect(bucketHits([noName], ME_ID).size).toBe(1)
  })

  test('and the name answers when the id is unknown', () => {
    // The `WAKE_SLACK_CHANNELS` case: an operator types names, so every id is
    // unknown. An id-first rule that did not fall back would refuse the whole
    // list the moment he edited it.
    expect(isAllowedSlackChannel('#truto', 'C0RENAMED99')).toBe(true)
    expect(isAllowedSlackChannel('', 'C0RENAMED99')).toBe(false)
  })

  test('a renamed channel is still his, because the id did not move', () => {
    // The other direction, and the reason the id is asked first: Slack lets a
    // channel be renamed and the desk should not lose a fortnight of work to it.
    expect(isAllowedSlackChannel('#truto-core', 'C04D9HKDWAV')).toBe(true)
  })

  test('a near miss is a miss', () => {
    for (const name of ['#truto-eng', '#trutox', '#not-truto', '#crisp', '']) {
      expect(isAllowedSlackChannel(name), `${name} was let through`).toBe(false)
    }
  })
})

/* ---------------------- 3. the list is configuration ---------------------- */

/** A file with its comments removed — the prose here names channels on purpose. */
const codeOf = (f: string) =>
  readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n')

describe('the list is written once, in env.ts, and read everywhere', () => {
  test('env.ts holds exactly the eighteen the operator gave', () => {
    expect(SLACK_CHANNELS.map(c => `#${c.name}`)).toEqual(THE_LIST)
  })

  test('no channel is named at the call site', () => {
    // The failure this guards is not a wrong list — it is a *second* list. A
    // literal here would keep working and would stop agreeing with env.ts the
    // first time somebody edited one of them.
    const code = codeOf('src/server/sources/slack.ts')
    for (const c of SLACK_CHANNELS) {
      expect(code, `${c.name} is inlined in slack.ts`).not.toContain(`in:#${c.name}`)
      expect(code, `${c.name} is inlined in slack.ts`).not.toContain(`'${c.name}'`)
      if (c.id) expect(code, `${c.id} is inlined in slack.ts`).not.toContain(c.id)
    }
    expect(code, 'slack.ts stopped reading the list from config')
      .toMatch(/import \{[\s\S]*?isAllowedSlackChannel[\s\S]*?SLACK_CHANNELS[\s\S]*?\} from '\.\.\/env'/)
  })

  test('and the refusal is not a duplicate of the query', () => {
    // One predicate, asked in one place. A second `startsWith`-shaped test
    // somewhere downstream is how the two come to disagree.
    const code = codeOf('src/server/sources/slack.ts')
    expect((code.match(/isAllowedSlackChannel\(/g) ?? []).length).toBe(1)
  })
})

/* ------------------------- 4. the narrowed query -------------------------- */

describe('the query names the channels, in the syntax Slack actually has', () => {
  test('every configured channel is in it', () => {
    for (const c of SLACK_CHANNELS) expect(CHANNEL_SCOPE).toContain(`in:#${c.name}`)
    expect((CHANNEL_SCOPE.match(/in:#/g) ?? []).length).toBe(SLACK_CHANNELS.length)
  })

  test('repeated `in:` and no boolean operator', () => {
    /*
     * Both halves were checked against mcp.slack.com on 2026-08-31.
     *
     * Repeating `in:` is the OR: `<@me> after:2026-08-13 before:2026-08-15
     * in:#truto in:#sprinto` answered with two #sprinto rows and one #truto row.
     * `OR` is not an operator — the search tool's own description says
     * "space-separated = AND, no boolean operators (AND/OR/NOT)", and writing it
     * into that query changed nothing about the three rows that came back. A
     * spell that works for no reason is one this file will not let in.
     */
    expect(CHANNEL_SCOPE).not.toMatch(/\bOR\b/)
    expect(CHANNEL_SCOPE.split(' ').every(t => t.startsWith('in:#'))).toBe(true)
  })

  test('the alert channels are not in it', () => {
    // They are read as history, never searched — a search for a bot message in
    // one of them has been measured returning nothing. Putting them in the query
    // would be asking a question with a known empty answer.
    for (const ch of SLACK_ALERT_CHANNELS) expect(CHANNEL_SCOPE).not.toContain(`in:#${ch.name}`)
  })

  test('and it is still a bot-inclusive search', () => {
    // Pinned in `test/slack-thread-api.test.ts` too. Repeated here because this
    // pass rewrote the line the query is built on, and a search that excludes
    // bots is a desk where every integration that speaks in a channel stops
    // existing behind a green sync line.
    expect(searchArgs(`<@${ME_ID}> after:2026-08-16 ${CHANNEL_SCOPE}`, 20).include_bots).toBe(true)
  })
})

/* --------------------- 5. the alert channels are untouched ---------------- */

describe('the three alert channels are not what this pass is about', () => {
  test('they are still the three, and still read as history', () => {
    expect(SLACK_ALERT_CHANNELS.map(c => c.name))
      .toEqual(['sentry-alerts', 'truto-api-alerts', 'truto-grafana-alerts'])
    // Sentry, Datadog and Grafana paging reaches the desk through these. The
    // allowlist does not apply to them and they are not on it.
    for (const ch of SLACK_ALERT_CHANNELS) {
      expect(SLACK_CHANNELS.some(c => c.name === ch.name), `${ch.name} joined the searched list`)
        .toBe(false)
    }
  })

  test('a human reply under an alert still opens a bucket', () => {
    /*
     * The collision `foldThreadIntoAlert` exists for: somebody replies
     * `<@yuvraj> can you take this` under a Sentry post, the mention search
     * returns that reply, and the thread it opens is folded into the alert row
     * so the row can say who is waiting. Refusing `#sentry-alerts` here would
     * leave every alert nobody's — which is the opposite of the point.
     *
     * `test/alerts.test.ts` owns the fold itself, end to end, on the captured
     * wire payloads. This is only the door it comes through.
     */
    const [sentry] = SLACK_ALERT_CHANNELS
    expect(isAllowedSlackChannel(`#${sentry!.name}`, sentry!.id)).toBe(true)
    expect(bucketHits([hit(`#${sentry!.name}`, sentry!.id)], ME_ID).size).toBe(1)
  })
})

/* --------------------------- 6. no second door ---------------------------- */

describe('the poll has one door and the refusal is on it', () => {
  const slack = readFileSync('src/server/sources/slack.ts', 'utf8')
  const fetchFn = slack.slice(slack.indexOf('async fetch()'))

  test('every thread card comes from a bucket', () => {
    // What makes "not in the mention search, not through a thread read, not
    // through a merge" one rule rather than three: the reads are ordered from
    // the buckets, the cards are built from the buckets, and the merge can only
    // be handed a card a bucket produced.
    expect((fetchFn.match(/buildThreadCard\(/g) ?? []).length, 'a second card builder appeared')
      .toBe(1)
    expect(fetchFn).toMatch(/for \(const \[key, b\] of buckets\)[\s\S]{0,200}buildThreadCard\(b,/)
    expect(fetchFn).toMatch(/readOrder\(buckets\.values\(\)\)/)
    expect(fetchFn).toMatch(/foldThreadIntoAlert\(alert, card\)/)
  })

  test('the refusal runs before the hits are grouped, not after', () => {
    // In `bucketHits`, so nothing that reads a bucket has to remember to ask.
    const bucket = slack.slice(slack.indexOf('export function bucketHits'))
    expect(bucket.slice(0, bucket.indexOf('const parent = parentTs(h)')))
      .toContain('isAllowedSlackChannel(h.channelName, h.channelId)')
  })

  test('and a hit the parser produced is refused the same way a built one is', () => {
    // Through the real search parser rather than the helper above, so the field
    // the refusal reads is the field the parser fills.
    const md = `# Search Results for: <@${ME_ID}> after:2026-08-16

## Messages (1 results)
### Result 1 of 1
Channel: #github-updates (ID: C0GHUPD8TE5)
From: Nidhi <nidhi@truto.one> (ID: U0BBZV4HQHH)
Time: 2026-08-31 14:57:43 IST
Message_ts: 1788160063.100000
Permalink: [link](https://truto.slack.com/archives/C0GHUPD8TE5/p1788160063100000)
Text:
<@${ME_ID}> Approveeeee

---

`
    const hits = parseSlackResults(md)
    expect(hits, 'the fixture stopped parsing').toHaveLength(1)
    expect(hits[0]!.channelName).toBe('#github-updates')
    expect(bucketHits(hits, ME_ID).size).toBe(0)
  })
})

describe('the other door: a manual Fetch obeys the same list', () => {
  /*
   * `bucketHits` is the only door the *poll* has. Fetch is a second one — the
   * operator presses a button, `searchSlack` runs, and `slackCard` builds rows
   * straight from the hits — so the allowlist has to be stated there too or a
   * single press reintroduces exactly the channels the poll was taught to leave
   * out. Worse than reintroducing them: they arrive `found_by = 'fetch'`, and
   * the poll's sweep only ever clears `found_by = 'poll'`, so nothing takes them
   * off the desk again.
   */
  const hit = (channel: string, id: string): SearchHit => ({
    source: 'slack',
    ref: `${id}:1788160063.100000`,
    title: channel,
    excerpt: 'somebody said a thing',
    actor: 'Nidhi',
    url: `https://truto.slack.com/archives/${id}/p1788160063100000`,
    ts: 1788160063100,
  })

  test('a hit from an allowed channel still becomes a card', () => {
    expect(slackCard(hit('#truto', 'C04D9HKDWAV'))).not.toBeNull()
  })

  test('a hit from a channel off the list does not', () => {
    for (const [name, id] of [['#github-updates', 'C0GHUPD8TE5'], ['#pr-reviews', 'C0PRREV1EWS']] as const) {
      expect(slackCard(hit(name, id)), `${name} reached the desk through Fetch`).toBeNull()
    }
  })

  test('a direct message is still refused by its own rule', () => {
    expect(slackCard(hit('#whatever', 'D06ABCDEF12'))).toBeNull()
  })
})
