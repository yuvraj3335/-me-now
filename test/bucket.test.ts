/**
 * A row belongs to the source it is *about*.
 *
 * Live on the deployed desk: the Slack tab read 47 and about forty of those rows
 * were `TRUTO-39 · Error`, `TRUTO-2Y · SyntaxError`, `TRUTO-APP-1BY ·
 * FetchError` — Sentry issues that happen to arrive through `#sentry-alerts` and
 * are therefore minted `source: 'slack'`. The Sentry tab read 13. The nine real
 * human threads on the Slack tab were buried under the forty.
 *
 * The interesting half of this is not "move alerts to Sentry" — it is the three
 * things that must NOT move, each of which a plausible one-line implementation
 * gets wrong:
 *
 *   * A **Datadog** or **Grafana** alert is an alert with no Sentry identity, so
 *     bucketing on `kind === 'alert'` alone empties the Slack tab of the two
 *     channels it exists to read.
 *   * A **human thread that names an issue in prose** — "duplicate of TRUTO-37"
 *     — is a conversation with somebody waiting in it, so bucketing on a bare
 *     reference match moves real threads off the tab where that person is.
 *   * `TRUTO-APP-1BY` is one issue, not `TRUTO-A`. Sentry short ids are base36
 *     and the `-APP` branch has to win the alternation.
 *
 * The second half of this file covers the phone row's heading, which is derived
 * from the same two facts a bucket is (which system, whose row) and has nowhere
 * else to be tested: `test/kinds.test.ts` predates it and belongs to another
 * pass.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { bucketOf, bucketsOf, inBucket, pipesFor } from '../src/web/lib/bucket'
import { cardKind, contextLine, senderOrg, waitingOn } from '../src/web/components/kinds'
import type { Card, CardSource, SourceName } from '../src/web/lib/types'

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
  first_seen_at: 1787814333000,
  activity: { count: 0, tagged: false, at: null },
  meta: {},
  state: null,
  tasks: [],
  ...over,
})

/* ------------------------------ what moves -------------------------------- */

describe('a Sentry issue is on the Sentry tab, whatever carried it', () => {
  test('a #sentry-alerts card with a short id', () => {
    const s = member({
      source: 'slack',
      kind: 'alert',
      title: 'TRUTO-39 · Error',
      meta: { alert: true, channel: '#sentry-alerts', short_id: 'TRUTO-39' },
    })
    expect(bucketOf(s)).toBe('sentry')
    expect(inBucket(card({ sources: [s] }), 'sentry')).toBe(true)
    expect(inBucket(card({ sources: [s] }), 'slack'), 'it is still claimed by Slack')
      .toBe(false)
  })

  test('and one whose id is the -APP project', () => {
    // The whole reason the regex is copied rather than re-derived: under a
    // pattern that tries the bare branch first, `TRUTO-APP-1BY` matches as
    // `TRUTO-APP` — a reference to an issue that does not exist — and under
    // `TRUTO-\d+` it does not match at all, because short ids are base36.
    for (const short of ['TRUTO-APP-1BY', 'TRUTO-2Y', 'TRUTO-W', 'TRUTO-2D']) {
      const s = member({
        source: 'slack', kind: 'alert', title: `${short} · FetchError`,
        meta: { alert: true, channel: '#sentry-alerts', short_id: short },
      })
      expect(bucketOf(s), `${short} did not read as a Sentry issue`).toBe('sentry')
    }
  })

  test('a card that carries a link to the issue rather than an id', () => {
    const s = member({
      source: 'slack',
      kind: 'alert',
      title: 'TypeError: undefined is not a function',
      url: 'https://truto.sentry.io/organizations/truto/issues/6114328841/',
      meta: { alert: true, channel: '#sentry-alerts', short_id: null },
    })
    expect(bucketOf(s)).toBe('sentry')
  })

  test('the id in a title is enough when the adapter recorded none', () => {
    // A row minted before `short_id` existed, or by a channel this parser has
    // not been taught. The title is the row naming itself, which is a different
    // thing from the row quoting somebody.
    const s = member({
      source: 'slack', kind: 'alert', title: 'TRUTO-38 · SyntaxError',
      meta: { alert: true, channel: '#sentry-alerts', short_id: null },
    })
    expect(bucketOf(s)).toBe('sentry')
  })

  test('a real Sentry API card is Sentry, with nothing to decide', () => {
    const s = member({
      source: 'sentry', kind: 'error', title: 'FetchError',
      url: 'https://truto.sentry.io/issues/6114328841/',
      meta: { project: 'truto-app', short_id: 'TRUTO-APP-1BY' },
    })
    expect(bucketOf(s)).toBe('sentry')
  })
})

/* ----------------------------- what stays put ----------------------------- */

describe('and everything else stays where it came from', () => {
  test('a Datadog monitor is on Slack', () => {
    // `short_id: null` by construction — `datadogAlertCards` writes it. There is
    // no Sentry issue behind this row, so there is no Sentry tab for it to be
    // on, and #truto-api-alerts is a channel he reads.
    const s = member({
      source: 'slack', kind: 'alert',
      title: '[Triggered] api.truto.one 5xx rate',
      meta: {
        alert: true, channel: '#truto-api-alerts', short_id: null,
        monitor: '4821991', alert_state: 'firing',
      },
    })
    expect(bucketOf(s)).toBe('slack')
  })

  test('a Grafana alert is on Slack', () => {
    const s = member({
      source: 'slack', kind: 'alert',
      title: 'Hyperdrive connection saturation',
      meta: {
        alert: true, channel: '#truto-grafana-alerts', short_id: null,
        monitor: 'Hyperdrive connection saturation', alert_state: 'firing',
      },
    })
    expect(bucketOf(s)).toBe('slack')
  })

  test('a human thread that merely names TRUTO-38 is a conversation', () => {
    // This is the one the whole ruling turns on. Roopi writing "is TRUTO-38 the
    // same thing?" is a person waiting on him, and moving it to the Sentry tab
    // is how it stops being answered. The kind gate is what holds — but the
    // title is also read for ids, so the id being in the title as well must not
    // be enough on its own.
    const s = member({
      source: 'slack',
      kind: 'mention',
      title: 'is TRUTO-38 the same thing as the one from yesterday?',
      meta: { channel: '#15five-truto', thread_ts: '1787814333.427979' },
    })
    expect(bucketOf(s)).toBe('slack')
    expect(inBucket(card({ sources: [s], kind: 'mention' }), 'sentry')).toBe(false)
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
  test('a merged Slack alert and Sentry issue is on Sentry alone', () => {
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
    expect(bucketsOf(c)).toEqual(['sentry'])
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

  test('the All tab takes everything, including a card with no members', () => {
    expect(inBucket(card({ sources: [] }), 'all')).toBe(true)
    expect(inBucket(card({ sources: [] }), 'slack')).toBe(false)
  })

  test('asking twice gives the same answer', () => {
    // A `/g` regex carries `lastIndex` between calls, so the same expression
    // tested twice against the same string answers true and then false. That
    // failure looks exactly like a data problem: every second matching row
    // silently leaves the tab.
    const s = member({
      source: 'slack', kind: 'alert', title: 'TRUTO-39 · Error',
      meta: { alert: true, channel: '#sentry-alerts', short_id: 'TRUTO-39' },
    })
    expect([bucketOf(s), bucketOf(s), bucketOf(s)]).toEqual(['sentry', 'sentry', 'sentry'])
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
    meta: { alert: true, channel: '#sentry-alerts', short_id: 'TRUTO-39' },
  }),
  member({
    source: 'slack', kind: 'alert', title: 'p99 latency is high',
    meta: { alert: true, channel: '#truto-api-alerts', short_id: null },
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
    for (const s of SPECIMENS) {
      expect(cardKind(card({ sources: [s] })).source, `a ${s.source} ${s.kind} row`)
        .toBe(bucketOf(s))
    }
  })

  test('a Sentry issue announced in Slack draws Sentry\'s own mark', () => {
    const viaSlack = card({
      sources: [member({
        source: 'slack', kind: 'alert', title: 'TRUTO-39 · Error',
        meta: { alert: true, channel: '#sentry-alerts', short_id: 'TRUTO-39' },
      })],
    })
    const viaSentry = card({
      sources: [member({ source: 'sentry', kind: 'error', title: 'Error', meta: { project: 'truto' } })],
    })
    const conversation = card({
      sources: [member({ source: 'slack', kind: 'thread', meta: { channel: '#truto-eng' } })],
    })

    expect(cardKind(viaSlack).Icon, 'the same issue told twice draws two marks')
      .toBe(cardKind(viaSentry).Icon)
    expect(cardKind(viaSlack).Icon, 'an issue and a conversation share a mark')
      .not.toBe(cardKind(conversation).Icon)
    // The word does not move, and that is not an oversight: Slack's alert and
    // Sentry's are both `Alert`, which is why the Kind column and the search
    // haystack that reads it are unchanged by any of this.
    expect(cardKind(viaSlack).word).toBe('Alert')
  })
})

/* --------------------------- what the button asks ------------------------- */

/** The five the strip offers, in its order. */
const TABS: SourceName[] = ['slack', 'gmail', 'github', 'sentry', 'claude']

describe('a scoped press asks the pipes that feed the tab it was pressed on', () => {
  test('whatever tab a row lands on, that tab asks the pipe it came through', () => {
    // The property the whole of `pipesFor` exists for. `Fetch Sentry` asked the
    // Sentry collector while every visible row on the Sentry tab came through
    // the Slack poller, so the control refreshed nothing you could see.
    for (const s of SPECIMENS) {
      expect(pipesFor(bucketOf(s)), `a ${s.source} ${s.kind} row is on the ${bucketOf(s)} tab`)
        .toContain(s.source)
    }
  })

  test('and asks nothing else', () => {
    // Widening is not the safe direction to be wrong in either: a scope that
    // asked every pipe would be an unscoped press wearing a source name.
    expect(pipesFor('sentry')).toEqual(['sentry', 'slack'])
    for (const t of TABS.filter(t => t !== 'sentry')) expect(pipesFor(t)).toEqual([t])
  })

  test('the server widens the same scopes the browser does', () => {
    // Fetch runs pipe 1 inside the server, so the table is written twice — once
    // here for Sync, once there for Fetch — and neither can import the other.
    // This is the thing that fails when only one of them is taught a new pipe.
    const src = readFileSync('src/server/fetch/index.ts', 'utf8')
    const table = /const ALSO_POLLED[^{]*\{([\s\S]*?)\n\}/.exec(src)?.[1]
    expect(table, 'ALSO_POLLED is gone or no longer a literal table').toBeTruthy()

    const server = new Map<string, string[]>()
    for (const m of table!.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
      server.set(m[1]!, [...m[2]!.matchAll(/'([a-z]+)'/g)].map(q => q[1]!))
    }

    for (const t of TABS) {
      expect(server.get(t) ?? [], `the two halves disagree about the ${t} tab`)
        .toEqual(pipesFor(t).filter(p => p !== t))
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
