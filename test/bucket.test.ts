/**
 * A row belongs to what it is *about*, and every production alert is one kind
 * of thing.
 *
 * Live on the deployed desk: the Slack tab read 47 and about forty of those rows
 * were `TRUTO-39 · Error`, `TRUTO-2Y · SyntaxError`, `TRUTO-APP-1BY ·
 * FetchError` — Sentry issues that happen to arrive through `#sentry-alerts` and
 * are therefore minted `source: 'slack'`. The Sentry tab read 13. The nine real
 * human threads on the Slack tab were buried under the forty.
 *
 * The first pass here fixed that by parsing a Sentry identity out of a Slack
 * alert and left `#truto-api-alerts` (Datadog) and `#truto-grafana-alerts`
 * (Grafana) exactly where they were — alerts with no Sentry identity, still on
 * the Slack tab, still noise. This pass is the second half: there is no Sentry
 * tab any more, there is an Alerts tab, and every monitor's own page lands on
 * it regardless of which one wrote it or which channel carried it.
 *
 * The one thing that must NOT move, which a plausible one-line implementation
 * gets wrong: a **human thread that names an issue in prose** — "duplicate of
 * TRUTO-37" — is a conversation with somebody waiting in it, so bucketing on a
 * bare reference match moves real threads off the tab where that person is.
 * `kind === 'alert'` is the whole gate, and Slack's own poller only ever writes
 * that for a monitor's own post.
 *
 * The second half of this file covers the phone row's heading, which is derived
 * from the same two facts a bucket is (which system, whose row) and has nowhere
 * else to be tested: `test/kinds.test.ts` predates it and belongs to another
 * pass.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { bucketOf, bucketsOf, inBucket, pipesFor, primaryPipe, type Bucket } from '../src/web/lib/bucket'
import { cardKind, contextLine, senderOrg, waitingOn } from '../src/web/components/kinds'
import type { Card, CardSource } from '../src/web/lib/types'

/** A member of a group, with only the fields the bucket is allowed to read. */
const member = (over: Partial<CardSource> & { source: CardSource['source'] }): CardSource => ({
  kind: 'thread',
  url: 'https://truto.slack.com/archives/C0BERTMS9K4/p1787814333427979',
  ts: 1787814333000,
  title: 'a row',
  why: 'posted somewhere',
  meta: {},
  ...over,
})

const card = (over: Partial<Card> & { sources: CardSource[] }): Card => ({
  group_key: 'g',
  pile: 'open',
  status: 'not_started',
  priority: 2,
  due_at: null,
  title: over.sources[0]?.title ?? 'a row',
  why: 'because',
  url: over.sources[0]?.url ?? 'https://example.test',
  kind: over.sources[0]?.kind ?? 'thread',
  ts: 1787814333000,
  // The desk's sort key. One number with `ts`, set on every card the server
  // sends — see `activityAt` in `src/server/api.ts`.
  activity_at: 1787814333000,
  first_seen_at: 1787814333000,
  activity: { count: 0, tagged: false, at: null },
  meta: {},
  state: null,
  tasks: [],
  ...over,
})

/* ------------------------------ what moves -------------------------------- */

describe('an alert is on the Alerts tab, whatever monitor wrote it', () => {
  test('a #sentry-alerts card', () => {
    const s = member({
      source: 'slack',
      kind: 'alert',
      title: 'TRUTO-39 · Error',
      meta: { alert: true, channel: '#sentry-alerts', short_id: 'TRUTO-39' },
    })
    expect(bucketOf(s)).toBe('alerts')
    expect(inBucket(card({ sources: [s] }), 'alerts')).toBe(true)
    expect(inBucket(card({ sources: [s] }), 'slack'), 'it is still claimed by Slack')
      .toBe(false)
  })

  // Identity is no longer read at all — no short id, no issue link, nothing
  // parsed out of the title. `kind === 'alert'` is the whole gate, so a
  // Datadog or a Grafana page lands here exactly like Sentry's own does.
  test('a Datadog monitor', () => {
    const s = member({
      source: 'slack', kind: 'alert',
      title: '[Triggered] api.truto.one 5xx rate',
      meta: {
        alert: true, channel: '#truto-api-alerts',
        monitor: '4821991', alert_state: 'firing', family: 'datadog',
      },
    })
    expect(bucketOf(s)).toBe('alerts')
  })

  test('a Grafana alert', () => {
    const s = member({
      source: 'slack', kind: 'alert',
      title: 'Hyperdrive connection saturation',
      meta: {
        alert: true, channel: '#truto-grafana-alerts',
        monitor: 'Hyperdrive connection saturation', alert_state: 'firing', family: 'grafana',
      },
    })
    expect(bucketOf(s)).toBe('alerts')
  })

  test('a real Sentry API card is on it too, with nothing to decide', () => {
    const s = member({
      source: 'sentry', kind: 'error', title: 'FetchError',
      url: 'https://truto.sentry.io/issues/6114328841/',
      meta: { project: 'truto-app', short_id: 'TRUTO-APP-1BY' },
    })
    expect(bucketOf(s)).toBe('alerts')
  })
})

/* ----------------------------- what stays put ----------------------------- */

describe('and everything else stays where it came from', () => {
  test('a human thread that merely names TRUTO-38 is a conversation', () => {
    // This is the one the whole ruling turns on. Roopi writing "is TRUTO-38 the
    // same thing?" is a person waiting on him, and moving it to the Alerts tab
    // is how it stops being answered. `kind` is what holds it on Slack — a
    // reference in the title, even one the adapter would recognise on an
    // alert, is prose rather than an alert's own post.
    const s = member({
      source: 'slack',
      kind: 'mention',
      title: 'is TRUTO-38 the same thing as the one from yesterday?',
      meta: { channel: '#15five-truto', thread_ts: '1787814333.427979' },
    })
    expect(bucketOf(s)).toBe('slack')
    expect(inBucket(card({ sources: [s], kind: 'mention' }), 'alerts')).toBe(false)
  })

  test('a Crisp conversation is a conversation, not an alert', () => {
    // A visitor is not a monitor, and Crisp's `kind` says so. See `kinds.tsx`
    // for the rest of what makes a Crisp row its own thing.
    const s = member({
      source: 'slack', kind: 'crisp', title: 'Priya',
      meta: { channel: 'crisp-chats', family: 'crisp', crisp_state: 'unresolved' },
    })
    expect(bucketOf(s)).toBe('slack')
  })

  test('every other source buckets to itself', () => {
    const each = [
      member({ source: 'gmail', kind: 'email', meta: { account: 'yuvraj@truto.one' } }),
      member({ source: 'github', kind: 'review', meta: { repo: 'trutohq/truto', is_pr: true } }),
      member({ source: 'claude', kind: 'session', meta: { project: 'truto' } }),
    ]
    expect(each.map(bucketOf)).toEqual(['gmail', 'github', 'claude'])
  })
})

/* ------------------------------ whole cards ------------------------------- */

describe('a card is on every tab one of its members claims', () => {
  test('a merged Slack alert and Sentry issue is on Alerts alone', () => {
    const c = card({
      kind: 'alert',
      sources: [
        member({
          source: 'slack', kind: 'alert', title: 'TRUTO-39 · Error',
          meta: { alert: true, channel: '#sentry-alerts', short_id: 'TRUTO-39' },
        }),
        member({
          source: 'sentry', kind: 'error', title: 'Error',
          meta: { project: 'truto', short_id: 'TRUTO-39' },
        }),
      ],
    })
    expect(bucketsOf(c)).toEqual(['alerts'])
    expect(inBucket(c, 'slack')).toBe(false)
  })

  test('a pull request discussed in a thread is on both', () => {
    const c = card({
      sources: [
        member({ source: 'github', kind: 'review', meta: { repo: 'trutohq/truto', is_pr: true } }),
        member({ source: 'slack', kind: 'thread', meta: { channel: '#truto-eng' } }),
      ],
    })
    expect(bucketsOf(c)).toEqual(['github', 'slack'])
  })

  test('the unfiltered tab takes everything, including a card with no members', () => {
    // AMENDED: no source filter is `null` now, not the string `'all'`.
    //
    // The tab is labelled `Tasks` and the value behind it is the absence of a
    // source rather than a sixth source name — which is what `'all'` read as
    // everywhere a real `SourceName` was expected. The rule is unchanged: no
    // filter takes every row, including one carrying no members at all.
    expect(inBucket(card({ sources: [] }), null)).toBe(true)
    expect(inBucket(card({ sources: [] }), 'slack')).toBe(false)
  })

  test('asking twice gives the same answer', () => {
    // `bucketOf` used to end in a regex whose `/g` flag carried `lastIndex`
    // between calls, so the same expression tested twice against the same
    // string answered true and then false — a filter that drops every second
    // matching row and looks like a data problem. Nothing here parses
    // anything any more, but the property is cheap to keep pinned.
    const s = member({
      source: 'slack', kind: 'alert', title: 'TRUTO-39 · Error',
      meta: { alert: true, channel: '#sentry-alerts', short_id: 'TRUTO-39' },
    })
    expect([bucketOf(s), bucketOf(s), bucketOf(s)]).toEqual(['alerts', 'alerts', 'alerts'])
  })
})

/* ------------------------- what the row draws ----------------------------- */

/**
 * One member of every shape the desk can hold, including both halves of the
 * Slack split. The three tests below are all one claim asked three ways: the
 * tab, the mark and the button have to agree about which rows are whose.
 */
const SPECIMENS: CardSource[] = [
  member({ source: 'slack', kind: 'thread', meta: { channel: '#15five-truto' } }),
  member({
    source: 'slack', kind: 'alert', title: 'TRUTO-39 · Error',
    meta: { alert: true, channel: '#sentry-alerts', short_id: 'TRUTO-39', family: 'sentry' },
  }),
  member({
    source: 'slack', kind: 'alert', title: 'p99 latency is high',
    meta: { alert: true, channel: '#truto-api-alerts', family: 'datadog' },
  }),
  member({ source: 'sentry', kind: 'error', title: 'Error', meta: { project: 'truto' } }),
  member({ source: 'github', kind: 'review', meta: { repo: 'trutohq/truto', is_pr: true } }),
  member({ source: 'gmail', kind: 'email', account: 'yuvraj@truto.one' }),
  member({ source: 'claude', kind: 'session', meta: { project: 'truto' } }),
]

describe('the mark on the row is the mark of the tab it is on', () => {
  test('every row draws its bucket, not its pipe', () => {
    // `cardKind` took its hue and glyph from `sources[0].source`, so the forty
    // rows the strip had just moved to the Sentry tab went on drawing a
    // Slack-coloured bell there. Two claims about one row, computed twice.
    //
    // `alerts` is not itself a `SourceName` — `Kind.source` still has to be
    // one, because it feeds `SOURCE_COLOR` and `SOURCE_LABEL`, both keyed by
    // the five real pipes — so every alert draws as `sentry` regardless of
    // which bucket member actually carried it. That is the unification the
    // whole pass is for: one glyph, one hue, whichever monitor it was.
    for (const s of SPECIMENS) {
      const bucket = bucketOf(s)
      const expected = bucket === 'alerts' ? 'sentry' : bucket
      expect(cardKind(card({ sources: [s] })).source, `a ${s.source} ${s.kind} row`)
        .toBe(expected)
    }
  })

  test('a Sentry issue, a Datadog page and a Slack thread — two marks, not three', () => {
    const viaSlack = card({
      sources: [member({
        source: 'slack', kind: 'alert', title: 'TRUTO-39 · Error',
        meta: { alert: true, channel: '#sentry-alerts', short_id: 'TRUTO-39' },
      })],
    })
    const viaSentry = card({
      sources: [member({ source: 'sentry', kind: 'error', title: 'Error', meta: { project: 'truto' } })],
    })
    const viaDatadog = card({
      sources: [member({
        source: 'slack', kind: 'alert', title: '[Triggered] api.truto.one 5xx rate',
        meta: { alert: true, channel: '#truto-api-alerts', family: 'datadog' },
      })],
    })
    const conversation = card({
      sources: [member({ source: 'slack', kind: 'thread', meta: { channel: '#truto-eng' } })],
    })

    expect(cardKind(viaSlack).Icon, 'the same issue told twice draws two marks')
      .toBe(cardKind(viaSentry).Icon)
    expect(cardKind(viaDatadog).Icon, 'a different monitor is still one kind of thing')
      .toBe(cardKind(viaSentry).Icon)
    expect(cardKind(viaSlack).Icon, 'an issue and a conversation share a mark')
      .not.toBe(cardKind(conversation).Icon)
    // The word does not move, and that is not an oversight: every alert is
    // `Alert`, which is why the Kind column and the search haystack that
    // reads it are unchanged by any of this.
    expect(cardKind(viaSlack).word).toBe('Alert')
    expect(cardKind(viaDatadog).word).toBe('Alert')
  })
})

/* --------------------------- what the button asks ------------------------- */

/** The five the strip offers, in its order — `alerts` where it used to be `sentry`. */
const TABS: Bucket[] = ['slack', 'gmail', 'github', 'alerts', 'claude']

describe('a scoped press asks the pipes that feed the tab it was pressed on', () => {
  test('whatever tab a row lands on, that tab asks the pipe it came through', () => {
    // The property the whole of `pipesFor` exists for. `Fetch Alerts` asked
    // only the Sentry collector while most of the rows on the Alerts tab came
    // through the Slack poller, so the control refreshed nothing you could see.
    for (const s of SPECIMENS) {
      expect(pipesFor(bucketOf(s)), `a ${s.source} ${s.kind} row is on the ${bucketOf(s)} tab`)
        .toContain(s.source)
    }
  })

  test('and asks nothing else', () => {
    // Widening is not the safe direction to be wrong in either: a scope that
    // asked every pipe would be an unscoped press wearing a source name.
    //
    // `pipesFor` also still answers the bare pipe name `sentry` — not only the
    // tab name `alerts` — because `Sync`'s own source menu keeps speaking in
    // real pipes regardless of which tab is on screen; see `primaryPipe`.
    expect(pipesFor('alerts')).toEqual(['sentry', 'slack'])
    expect(pipesFor('sentry')).toEqual(['sentry', 'slack'])
    for (const t of TABS.filter(t => t !== 'alerts')) expect(pipesFor(t)).toEqual([t])
  })

  test('the server widens the same scopes the browser does', () => {
    // Fetch runs pipe 1 inside the server, so the table is written twice — once
    // here for Sync, once there for Fetch — and neither can import the other.
    // This is the thing that fails when only one of them is taught a new pipe.
    //
    // The server has never heard the word `alerts` — its `FetchScope` is the
    // five real connectors, and `ALSO_POLLED` is keyed by `sentry`, the
    // connector `alerts` is fed by. `primaryPipe` is the one place that maps a
    // tab back to the pipe name the server table actually uses.
    const src = readFileSync('src/server/fetch/index.ts', 'utf8')
    const table = /const ALSO_POLLED[^{]*\{([\s\S]*?)\n\}/.exec(src)?.[1]
    expect(table, 'ALSO_POLLED is gone or no longer a literal table').toBeTruthy()

    const server = new Map<string, string[]>()
    for (const m of table!.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
      server.set(m[1]!, [...m[2]!.matchAll(/'([a-z]+)'/g)].map(q => q[1]!))
    }

    for (const t of TABS) {
      const pipe = primaryPipe(t)
      expect(server.get(pipe) ?? [], `the two halves disagree about the ${t} tab`)
        .toEqual(pipesFor(t).filter(p => p !== pipe))
    }
  })
})

/* --------------------- what the button says it just did ------------------- */

/**
 * Not a bucket, but the same failure one layer out, and this pass is where both
 * were found: the tab strip stopped lying about which rows were whose, and the
 * two controls above it went on saying nothing at all on a phone.
 */
describe('both controls on the header row answer at every width', () => {
  const sync = readFileSync('src/web/components/sync.tsx', 'utf8')
  const home = readFileSync('src/web/pages/Home.tsx', 'utf8')

  test('the answer is one decision, made once', () => {
    expect(sync, 'the shared result line is gone').toMatch(/export function useResultLine/)
    // The inline line is `hidden sm:inline` in both controls, so below `sm`
    // something else has to speak. The hook is what checks the width and hands
    // the same sentence to the toast bar.
    expect(sync, 'the result no longer reaches a phone')
      .toMatch(/matchMedia[\s\S]{0,200}toast\(/)
  })

  test('and both of them make it', () => {
    for (const [name, src] of [['sync.tsx', sync], ['Home.tsx', home]] as const) {
      expect(src, `${name}: a control on this row went back to answering only on a desktop`)
        .toMatch(/useResultLine\(\)/)
    }
  })
})

/* ------------------------- the phone row's heading ------------------------ */

describe('a phone row says which customer and which person', () => {
  const slackCard = (channel: string, who: string | null) =>
    card({
      who,
      sources: [member({ source: 'slack', kind: 'thread', meta: { channel } })],
    })

  test('a shared channel reads as the customer, capitalised', () => {
    expect(contextLine(slackCard('#15five-truto', 'Roopi'))).toBe('15five — Roopi')
    expect(contextLine(slackCard('#spendflo-truto', 'Uday'))).toBe('Spendflo — Uday')
    expect(contextLine(slackCard('#sprinto-truto', 'Nikhil'))).toBe('Sprinto — Nikhil')
    // `cleanChannel` keeps a name made only of the workspace token, because a
    // blank is worse than a redundant word.
    expect(contextLine(slackCard('#truto', 'Sidharth'))).toBe('Truto — Sidharth')
  })

  test('the sources with no channel answer in their own vocabulary', () => {
    // The half that differs, in each case: the repository rather than its owner,
    // the project as it is. Mail is not in this list any more — it has a
    // describe of its own below, because the mailbox turned out to be the one
    // "own vocabulary" that says nothing.
    const gh = card({
      who: 'Nihar',
      sources: [member({ source: 'github', kind: 'review', meta: { repo: 'trutohq/truto-app' } })],
    })
    expect(contextLine(gh)).toBe('Truto-app — Nihar')

    const session = card({
      sources: [member({ source: 'claude', kind: 'session', meta: { project: 'truto' } })],
    })
    expect(contextLine(session)).toBe('Truto')
  })

  test('an alert is waiting on nobody, and does not name the bot that posted it', () => {
    // `actor` on an alert is Sentry, Datadog or Grafana. `Sentry-alerts — Sentry`
    // would be the row saying one thing twice and calling a monitor a person.
    const alert = card({
      kind: 'alert',
      actor: 'Sentry',
      who: null,
      sources: [member({
        source: 'slack', kind: 'alert', title: 'TRUTO-39 · Error',
        meta: { alert: true, channel: '#sentry-alerts', short_id: 'TRUTO-39' },
      })],
    })
    expect(waitingOn(alert)).toBeNull()
    expect(contextLine(alert)).toBe('Sentry-alerts')
  })

  test('a conversation falls back to whoever spoke', () => {
    const c = card({
      who: null,
      actor: 'Roopi',
      sources: [member({ source: 'slack', kind: 'thread', meta: { channel: '#15five-truto' } })],
    })
    expect(contextLine(c)).toBe('15five — Roopi')
  })

  test('and a row with neither renders nothing rather than a guess', () => {
    const c = card({ who: null, actor: null, sources: [member({ source: 'slack', kind: 'thread' })] })
    expect(contextLine(c)).toBeNull()
  })
})

/* ---------------------------------- mail ---------------------------------- */

/**
 * Twenty-nine rows on the deployed desk read `Yuvraj — <an address>`.
 *
 * `Yuvraj` is the mailbox — his own name, identical on every one of them — so
 * the half of the line that names a customer named nobody, and the half beside
 * it was a raw envelope address clipped from the wrong end by CSS. What survived
 * a 375px screen was `Yuvraj — noreply@md.get…`: 132px spent on his own name and
 * a prefix.
 */
describe('a mail row names the sender, not the mailbox', () => {
  /** The Gmail adapter writes one string into `actor` and `who` alike. */
  const mail = (from: string | null) =>
    card({
      who: from,
      actor: from,
      kind: 'email',
      sources: [member({
        source: 'gmail', kind: 'email', account: 'yuvraj@truto.one',
        who: from, actor: from, meta: { account: 'yuvraj@truto.one' },
      })],
    })

  test('the mailbox is never on the line', () => {
    for (const from of ['Aman', 'noreply@md.getsentry.com', 'notify@mail.notion.so']) {
      expect(contextLine(mail(from)), `${from}: his own mailbox came back`)
        .not.toMatch(/Yuvraj|truto\.one/i)
    }
  })

  test('a display name is the answer, untouched', () => {
    expect(contextLine(mail('Aman'))).toBe('Aman')
    // Decoded upstream by `parseAddress`; nothing here re-cases or re-cuts it.
    expect(contextLine(mail('Burns & McDonnell'))).toBe('Burns & McDonnell')
    // A name that happens to hold an `@` is still a name — the naive test for
    // "is this an address" would have swapped this for a domain it does not have.
    expect(contextLine(mail('Sales @ Acme'))).toBe('Sales @ Acme')
  })

  test('an address answers with the organisation its domain names', () => {
    // The four live rows, verbatim off the deployed desk.
    expect(contextLine(mail('noreply@md.getsentry.com'))).toBe('Sentry')
    expect(contextLine(mail('notify@mail.notion.so'))).toBe('Notion')
    expect(contextLine(mail('support@e.read.ai'))).toBe('Read')
    expect(contextLine(mail('noreply@mailer.truto.one'))).toBe('Truto')
  })

  test('the transport subdomain falls out and the public suffix stays a suffix', () => {
    expect(senderOrg('a@spendflo.com')).toBe('Spendflo')
    expect(senderOrg('a@em.sprinto.com')).toBe('Sprinto')
    expect(senderOrg('a@mail.monzo.co.uk')).toBe('Monzo')
  })

  test('`get<brand>` is a convention, not a name — but only when a word is left', () => {
    expect(senderOrg('a@getsentry.com')).toBe('Sentry')
    expect(senderOrg('a@getharvest.com')).toBe('Harvest')
    // Three letters and a two-letter tail is a name, not a convention.
    expect(senderOrg('a@getty.com')).toBe('Getty')
  })

  test('a mailbox host is not an organisation', () => {
    // `Gmail` would be the column's background printed, and it would also be
    // untrue: Gmail did not send the mail, a person did.
    expect(senderOrg('someone@gmail.com')).toBeNull()
    expect(contextLine(mail('someone@gmail.com'))).toBeNull()
  })

  test('and an unknown sender is nothing, rather than his own address', () => {
    expect(contextLine(mail(null))).toBeNull()
  })
})

/* ------------------------- who the actor stands for ----------------------- */

/**
 * The `actor` fallback used to be general, and `actor` is not a person on three
 * of the five sources. Both rows below were live.
 */
describe('the fallback to `actor` belongs to a Slack conversation', () => {
  test('his own pull request stops printing his own login', () => {
    // The GitHub adapter fills `who` itself and leaves it empty *precisely* when
    // the author is him — so on `is:pr author:me` the fallback answered "who is
    // waiting on me" with `yuvraj3335`.
    const mine = card({
      who: null,
      actor: 'yuvraj3335',
      kind: 'my_pr',
      sources: [member({
        source: 'github', kind: 'my_pr', actor: 'yuvraj3335',
        meta: { repo: 'trutohq/truto-app', is_pr: true },
      })],
    })
    expect(waitingOn(mine)).toBeNull()
    expect(contextLine(mine)).toBe('Truto-app')
  })

  test('a Sentry issue does not print its project twice', () => {
    // `actor` on a Sentry card is the project slug — the same fact `whereOf`
    // already answers with — so the cell drew `Truto-api — truto-api`.
    const issue = card({
      who: null,
      actor: 'truto-api',
      kind: 'error',
      sources: [member({
        source: 'sentry', kind: 'error', actor: 'truto-api',
        meta: { project: 'truto-api', short_id: 'TRUTO-39' },
      })],
    })
    expect(waitingOn(issue)).toBeNull()
    expect(contextLine(issue)).toBe('Truto-api')
  })

  test('and a Slack thread still falls back to whoever spoke', () => {
    const c = card({
      who: null,
      actor: 'Roopi',
      sources: [member({ source: 'slack', kind: 'thread', actor: 'Roopi',
        meta: { channel: '#15five-truto' } })],
    })
    expect(waitingOn(c)).toBe('Roopi')
  })
})
