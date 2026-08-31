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

import { describe, expect, test } from 'bun:test'
import { bucketOf, bucketsOf, inBucket } from '../src/web/lib/bucket'
import { contextLine, waitingOn } from '../src/web/components/kinds'
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
    // the mailbox rather than its domain, the project as it is.
    const gh = card({
      who: 'Nihar',
      sources: [member({ source: 'github', kind: 'review', meta: { repo: 'trutohq/truto-app' } })],
    })
    expect(contextLine(gh)).toBe('Truto-app — Nihar')

    const mail = card({
      who: 'Aman',
      sources: [member({ source: 'gmail', kind: 'email', account: 'yuvraj@truto.one', meta: {} })],
    })
    expect(contextLine(mail)).toBe('Yuvraj — Aman')

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
