/**
 * Alert channels, from wire to card.
 *
 * Every fixture here is a verbatim `slack_read_channel` payload captured live
 * from the workspace, not a paraphrase, because every bug this file exists to
 * prevent is a shape bug: a regex that looks right and silently returns nothing.
 * Where a test needs a narrower window it *slices* real blocks out of a real
 * payload rather than inventing one — `only()` below.
 *
 * The behaviour under test is the operator's rule, in one line: what is firing
 * is on the desk, once, and what fixed itself is not there at all.
 */
import { describe, expect, test } from 'bun:test'
import {
  alertCards, bucketHits, buildThreadCard, foldThreadIntoAlert, parseChannelMessages,
  parseSlackResults,
} from '../src/server/sources/slack'
import { extractAlertRefs } from '../src/server/dedup'
import { alertChannels } from '../src/server/slackScope'
import type { RawCard } from '../src/server/sources/types'

// Derived from the seeded `slack_channels` table (migration 15) rather than a
// literal array — `alertChannels()` reads it in insertion order, which is
// sentry, datadog, grafana, the same order this file has always destructured.
const [SENTRY_CH, DATADOG_CH, GRAFANA_CH] = alertChannels()

/** Verbatim: #sentry-alerts, three messages, the TRUTO-38 pair and one lone triage. */
const SENTRY_WIRE = `Channel: #sentry-alerts (C0BERTMS9K4)

=== Message from Cursor <botuser-T04CWR1AM1R-B092446N6LB@slack-bots.com> (U092446PCTV) at 2026-08-30 18:27:14 IST === 
Message TS: 1788094634.851449
_TRUTO-38_ — \`TypeError: Cannot read properties of undefined (reading 'payload_transform')\`
<https://truto.sentry.io/issues/7700748352/>

_Root cause:_ \`POST /environment-integration-webhook/:id\` read \`integration.config.webhook.payload_transform\` without checking whether \`config.webhook\` exists. Integrations without a webhook block threw an unhandled TypeError (Sentry 500). The per-account path (\`UnifiedWebhookRun\`) already returns 400 for this case.

_Classification:_ (a) application bug

_Fix:_ Guard with \`isNil\` and return \`BadRequestError('Webhook support is not yet enabled for this integration.')\`. Vitest: 2 passed.
<https://cursor.com/agents/bc-023e1f21-047f-43a9-a705-ba322dc74bb0|Open in Cursor> · Cursor Grok 4.5 · <https://cursor.com/custom-agents/f9a02a73-867a-11f1-a7d1-d6b4613131ce|Create PR Based on Sentry Issue Created - truto> · <https://github.com/trutohq/truto/pull/2037|View PR>
App notification from App (https://truto.sentry.io/issues/7700748352/): :red_circle: <https://truto.sentry.io/issues/7700748352/?referrer=slack|*TypeError*>
processRequest(index)
\`\`\`Cannot read properties of undefined (reading 'payload_transform')\`\`\`
State: *New*   First Seen: *4 minutes ago*
Resolve button
Archive button
Project: <https://truto.sentry.io/issues/?project=4511647571574784|truto>    Alert: TRUTO-38    Short ID: TRUTO-38

=== Message from Sentry <botuser-T04CWR1AM1R-B0BEVJZV9BN@slack-bots.com> (U0BFL7HM40Y) at 2026-08-30 18:22:59 IST === 
Message TS: 1788094379.882969
:red_circle: <https://truto.sentry.io/issues/7700748352/?referrer=slack&amp;notification_uuid=35f355ed-a668-4817-8944-3f1365672acd&amp;environment=production&amp;workflow_id=3657647&amp;alert_type=issue|*TypeError*>
processRequest(index)
\`\`\`Cannot read properties of undefined (reading 'payload_transform')\`\`\`
State: *New*   First Seen: *Just now*
Resolve button
Archive button
notes: <!subteam^S06HDT77E1M|@truto-eng>
Project: <https://truto.sentry.io/issues/?project=4511647571574784|truto>    Alert: <https://sentry.io/organizations/truto/monitors/alerts/3657647/|Notify #sentry-alerts via Slack>    Short ID: TRUTO-38

=== Message from Cursor <botuser-T04CWR1AM1R-B092446N6LB@slack-bots.com> (U092446PCTV) at 2026-08-30 18:07:35 IST === 
Message TS: 1788093455.464419
_TRUTO-36_ — \`SyntaxError: Unexpected end of JSON input\`
<https://truto.sentry.io/issues/7700727844/>

_Root cause:_ Same as TRUTO-37 — curl \`PUT /agents/lock/some-critical-lock\` with an empty body reached \`Lock.fetch\` via unintended \`/agents/*\` DO routing (\`routeAgentRequest(full env)\`), then unguarded \`request.json()\` threw. Culprit \`Lock.fetch\`, \`environment=production\`, 2 events (same probe as TRUTO-37).

_Classification:_ (a) application bug — duplicate of TRUTO-37.

_No new PR:_ Fix already open as <https://github.com/trutohq/truto/pull/2036> (restrict \`routeAgentRequest\` to ASSISTANT; 400 on invalid Lock JSON). Mark TRUTO-36 as a duplicate of TRUTO-37 in Sentry.
<https://cursor.com/agents/bc-0755499f-e751-4976-9e6f-b9df0a9c817e|Open in Cursor> · Cursor Grok 4.5 · <https://cursor.com/custom-agents/f9a02a73-867a-11f1-a7d1-d6b4613131ce|Create PR Based on Sentry Issue Created - truto>
App notification from App (https://truto.sentry.io/issues/7700727844/): :red_circle: <https://truto.sentry.io/issues/7700727844/?referrer=slack|*SyntaxError*>
Lock.fetch(index)
\`\`\`Unexpected end of JSON input\`\`\`
State: *New*   First Seen: *6 minutes ago*
Resolve button
Archive button
Project: <https://truto.sentry.io/issues/?project=4511647571574784|truto>    Alert: TRUTO-36    Short ID: TRUTO-36`

/**
 * Verbatim: #truto-api-alerts. Two monitors (444839 flapping Warn→Recovered,
 * 17338583 firing and paging two groups) and one scheduled digest. The long
 * percent-encoded Log Explorer query strings are shortened — nothing parses
 * them; every token that is parsed is byte-for-byte what the wire sent, down to
 * the log-sample fence the tool truncates mid-line and never closes.
 */
const DATADOG_WIRE = `Channel: #truto-api-alerts (C05UPHVT2CQ)

=== Message from Datadog <botuser-T04CWR1AM1R-B05U31SMQNQ@slack-bots.com> (U05UPHTF70Q) at 2026-08-30 21:49:02 IST === 
Message TS: 1788106742.250329

Attachment: Recovered: Number of Unified or Proxy API errors more than 10 in last 5 minutes (https://us3.datadoghq.com/monitors/444839?from_ts=1788105779000&to_ts=1788106979000&event_id=8788641826233093636&link_source=monitor_notif&link_monitor_id=444839&link_event_id=8788641826233093636&link_event_ts=1788106679)
@slack-truto-api-alerts

Less than or exactly 20.0 log events matched in the last 5m against the monitored query: <https://us3.datadoghq.com/logs?query=env%3Aproduction|\`env:production status:error\`>
Notified: @slack-truto-api-alerts
Attachment: View in Log Explorer (https://us3.datadoghq.com/logs?query=env%3Aproduction&link_monitor_id=444839)

=== Message from Datadog <botuser-T04CWR1AM1R-B05U31SMQNQ@slack-bots.com> (U05UPHTF70Q) at 2026-08-30 21:48:01 IST === 
Message TS: 1788106681.917399

Attachment: Warn: Number of Unified or Proxy API errors more than 10 in last 5 minutes (https://us3.datadoghq.com/monitors/444839?from_ts=1788105719000&to_ts=1788106919000&event_id=8788640818269252118&link_source=monitor_notif&link_monitor_id=444839&link_event_id=8788640818269252118&link_event_ts=1788106619)
@slack-truto-api-alerts

More than 20.0 log events matched in the last 5m against the monitored query: <https://us3.datadoghq.com/logs?query=env%3Aproduction|\`env:production status:error\`>
Notified: @slack-truto-api-alerts
Attachment: View in Log Explorer (https://us3.datadoghq.com/logs?query=env%3Aproduction&link_monitor_id=444839)
\`\`\`Time | Host | Message
-----------------------------
16:16:45 UTC | api.truto.one | 2026-08-30T16:16:45.474Z ERROR 3.108.123.60 (a3351a049a873ba3) GET <https://api.truto.one/unified/user-directory/users?limit=100&amp;integrated_account_id=94cd8a9f-1220-4ccd-b853-335a928edcd3> 530
-----------------------------
16:16:40 UTC | api.truto.one | 2026-08-30T16:16:40.741Z ...

=== Message from Datadog <botuser-T04CWR1AM1R-B05U31SMQNQ@slack-bots.com> (U05UPHTF70Q) at 2026-08-30 21:31:25 IST === 
Message TS: 1788105685.345009

Attachment: Triggered: D1 Error - DB Load (https://us3.datadoghq.com/monitors/17338583?from_ts=1788105023000&link_event_ts=1788105623)
@slack-truto-api-alerts <!subteam^S06HDT77E1M> <!subteam^S09475M3UM8> Check this ASAP!

More than 1 log events matched in the last 5m against the monitored query: <https://us3.datadoghq.com/logs?query=x|\`env:production \\@logs.message:"D1_ERROR: D1 DB is overloaded. Requests queued for too long."\`>
Notified: @slack-truto-api-alerts
Attachment: View in Log Explorer (https://us3.datadoghq.com/logs?query=x)

=== Message from Truto Notifications (B0B366FQZ9B) at 2026-08-30 15:00:12 IST === 
Message TS: 1788082212.129779
*:red_circle: Non-200 API Errors in the Last 24 Hours (Excluding Errors already reported in Last 48 Hours)*
Environment: Default (ac15abdc-b38e-47d0-97a2-69194017c177)
Includes direct API (4xx/5xx) and sync job errors.
Showing 5 errors (ordered by count). 
\`\`\`integrated account                    integration name  status code  count
N/A                                   N/A               500          4    
N/A                                   N/A               404          1    
4a9f1387-4a19-4652-be78-0ab73c40d0f1  crisp             405          1    
615fda53-78c7-43d3-88f6-54fc218c5c37  membes            405          1    
09424f07-e2a7-46e5-ab79-e5b8f37fd6db  slack             405          1    \`\`\`
Number of Affected integrated accounts: 3`

/** Verbatim: #truto-grafana-alerts. Two alerts, each fired and then cleared. */
const GRAFANA_WIRE = `Channel: #truto-grafana-alerts (C0B53TSLGLA)

=== Message from Alertmanager (B0B4XH780KV) at 2026-08-30 19:03:41 IST === 
Message TS: 1788096821.345759

Attachment: :white_check_mark: HostSwapping (http://409f0b65787e:9093/#/alerts?receiver=slack-default)
*Chronic swap thrashing on ovh-mongo*
ovh-mongo has averaged 105 pages/sec in+out over the last 6 hours -- the working set permanently exceeds RAM. Check memory consumers with \`ps -eo rss,args --sort=-rss | head\`. On ovh-mongo the dominant consumer is mongod's WiredTiger cache (\`cacheSizeGB\` in /etc/mongod.conf, set to 20 on a 30 GiB box as of Aug 18 2026); shrink it or add RAM. NOTE: the pm2 migration-script fleet moved off ovh-mongo to ovh-clonepartner-1 on Aug 18 2026 and is no longer a consumer there.

=== Message from Alertmanager (B0B4XH780KV) at 2026-08-30 18:54:04 IST === 
Message TS: 1788096244.885839

Attachment: :white_check_mark: VictoriaLogsNoIngest (http://409f0b65787e:9093/#/alerts?receiver=slack-default)
*VictoriaLogs 'elaichi' has ingested nothing for an hour*
The instance is up and answering scrapes but no rows have arrived in 30m, sustained an hour. For elaichi that means audit events are not landing — check the elaichi-log-ingest queue depth and its dead-letter queue before the 14-day retention window closes, because that retention IS the recovery budget. For truto check the log shipper. A genuinely idle instance fires this too; scope the rule if that is expected.

=== Message from Alertmanager (B0B4XH780KV) at 2026-08-30 18:03:41 IST === 
Message TS: 1788093221.332489

Attachment: :fire: HostSwapping (http://409f0b65787e:9093/#/alerts?receiver=slack-default)
*Chronic swap thrashing on ovh-mongo*
ovh-mongo has averaged 105 pages/sec in+out over the last 6 hours -- the working set permanently exceeds RAM. Check memory consumers with \`ps -eo rss,args --sort=-rss | head\`. On ovh-mongo the dominant consumer is mongod's WiredTiger cache (\`cacheSizeGB\` in /etc/mongod.conf, set to 20 on a 30 GiB box as of Aug 18 2026); shrink it or add RAM. NOTE: the pm2 migration-script fleet moved off ovh-mongo to ovh-clonepartner-1 on Aug 18 2026 and is no longer a consumer there.

=== Message from Alertmanager (B0B4XH780KV) at 2026-08-30 17:34:04 IST === 
Message TS: 1788091444.874839

Attachment: :fire: VictoriaLogsNoIngest (http://409f0b65787e:9093/#/alerts?receiver=slack-default)
*VictoriaLogs 'elaichi' has ingested nothing for an hour*
The instance is up and answering scrapes but no rows have arrived in 30m, sustained an hour. For elaichi that means audit events are not landing — check the elaichi-log-ingest queue depth and its dead-letter queue before the 14-day retention window closes, because that retention IS the recovery budget. For truto check the log shipper. A genuinely idle instance fires this too; scope the rule if that is expected.`

/** The same read, narrowed to the blocks that match. Real messages, fewer of them. */
function only(wire: string, keep: (block: string) => boolean): string {
  const [head, ...blocks] = wire.split('=== Message from')
  return [head!, ...blocks.filter(keep)].join('=== Message from')
}

const cardsFrom = (wire: string, ch: typeof SENTRY_CH): RawCard[] =>
  alertCards(ch!, parseChannelMessages({ messages: wire }, ch!.id))

const byShortId = (cards: RawCard[], id: string) =>
  cards.filter(c => (c.meta as any)?.short_id === id)

describe('#sentry-alerts — two bots, one issue, one row', () => {
  const cards = cardsFrom(SENTRY_WIRE, SENTRY_CH)

  test('the Sentry alert and the Cursor triage are the same card', () => {
    // Two top-level messages five minutes apart, both about TRUTO-38.
    expect(SENTRY_WIRE.split('=== Message from').length - 1).toBe(3)
    expect(byShortId(cards, 'TRUTO-38')).toHaveLength(1)
  })

  test('the identity is the oldest message, so a follow-up does not make a new row', () => {
    const [card] = byShortId(cards, 'TRUTO-38')
    expect(card!.source_id).toBe(`${SENTRY_CH!.id}:1788094379.882969`)
  })

  test('what a reader sees comes from the newest, so a follow-up updates it', () => {
    const [card] = byShortId(cards, 'TRUTO-38')
    // The triage, not the alert: the alert says what broke, the triage says why.
    expect(card!.excerpt).toContain('Root cause:')
    expect(card!.excerpt).toContain('Classification: (a) application bug')
    expect(card!.url).toBe(`https://truto.slack.com/archives/${SENTRY_CH!.id}/p1788094634851449`)
    expect((card!.meta as any).thread_ts).toBe('1788094634.851449')
  })

  test('the title is the error class, prefixed with the id you can look up', () => {
    expect(byShortId(cards, 'TRUTO-38')[0]!.title).toBe('TRUTO-38 · TypeError')
  })

  test('a page puts it on the desk now; a post that named nobody does not', () => {
    const paged = byShortId(cards, 'TRUTO-38')[0]!
    expect((paged.meta as any).paged).toBe(true)
    expect(paged.pile).toBe('now')
    expect(paged.why).toBe('your team was paged in #sentry-alerts')

    // TRUTO-36 arrived as a triage only — no Sentry post, so no subteam token.
    const quiet = byShortId(cards, 'TRUTO-36')[0]!
    expect((quiet.meta as any).paged).toBe(false)
    expect(quiet.pile).toBe('open')
  })

  test('it merges with the Sentry API row and not with the fixing PR', () => {
    const [card] = byShortId(cards, 'TRUTO-38')
    // The short id is what the group is labelled with; the numeric id is what
    // performs the merge against the row the Sentry API returns.
    expect(card!.refs).toContainEqual({ t: 'sentry', v: 'TRUTO-38' })
    expect(card!.refs).toContainEqual({ t: 'sentry', v: '7700748352' })
    // The Cursor footer links PR 2037. That is a different unit of work.
    expect(SENTRY_WIRE).toContain('github.com/trutohq/truto/pull/2037')
    expect(card!.refs.some(r => r.t === 'gh')).toBe(false)
  })

  test('an id the prose merely mentions is not the card identity', () => {
    // The TRUTO-36 triage says "Same as TRUTO-37" three times and links PR 2036.
    expect(SENTRY_WIRE).toContain('duplicate of TRUTO-37')
    expect(byShortId(cards, 'TRUTO-37')).toHaveLength(0)
    const [card] = byShortId(cards, 'TRUTO-36')
    expect(card!.refs).not.toContainEqual({ t: 'sentry', v: 'TRUTO-37' })
  })

  test('a base36 id survives whole, italics and all', () => {
    // `_TRUTO-38_` has no word boundary on either side — `_` is a word
    // character — so `\bTRUTO…\b` cannot see the one id the message is about.
    const app = cardsFrom(SENTRY_WIRE.replaceAll('TRUTO-38', 'TRUTO-APP-1BY'), SENTRY_CH)
    expect(byShortId(app, 'TRUTO-APP-1BY')).toHaveLength(1)
    expect(byShortId(app, 'TRUTO-A')).toHaveLength(0)
    expect(extractAlertRefs('_TRUTO-2D_ — `SyntaxError`'))
      .toContainEqual({ t: 'sentry', v: 'TRUTO-2D' })
  })
})

describe('#truto-api-alerts — a monitor is one row, and a recovered one is none', () => {
  const cards = cardsFrom(DATADOG_WIRE, DATADOG_CH)
  const monitors = (cs: RawCard[]) => cs.map(c => (c.meta as any).monitor).filter(Boolean)

  test('a monitor that fired and then recovered is not on the desk', () => {
    // 444839 in this window: Warn at 21:48, Recovered at 21:49. It fixed itself.
    expect(DATADOG_WIRE).toContain('Attachment: Warn: Number of Unified or Proxy API errors')
    expect(DATADOG_WIRE).toContain('Attachment: Recovered: Number of Unified or Proxy API errors')
    expect(monitors(cards)).not.toContain('444839')
  })

  test('a bare Recovered on its own is no row either', () => {
    const recovered = only(DATADOG_WIRE, b => b.includes('Attachment: Recovered:'))
    expect(cardsFrom(recovered, DATADOG_CH)).toHaveLength(0)
  })

  test('a firing monitor is one row keyed on the monitor, not on the message', () => {
    const d1 = cards.filter(c => (c.meta as any).monitor === '17338583')
    expect(d1).toHaveLength(1)
    expect(d1[0]!.source_id).toBe('ddmonitor:17338583')
    expect(d1[0]!.title).toBe('D1 Error - DB Load')
    expect(d1[0]!.refs).toContainEqual({ t: 'url', v: 'https://us3.datadoghq.com/monitors/17338583' })
  })

  test('a bare subteam token still counts as a page', () => {
    // Datadog writes `<!subteam^S06HDT77E1M>` with no `|@handle`, so a pattern
    // that requires the pipe misses every page this channel has ever sent.
    expect(DATADOG_WIRE).toContain('<!subteam^S06HDT77E1M> <!subteam^S09475M3UM8>')
    const d1 = cards.find(c => (c.meta as any).monitor === '17338583')!
    expect((d1.meta as any).paged).toBe(true)
    expect(d1.pile).toBe('now')
    // And the token itself is not left sitting in the excerpt.
    expect(d1.excerpt).not.toContain('<!subteam')
  })

  test('a digest is one card, never one card per error row inside it', () => {
    const digests = cards.filter(c => (c.meta as any).alert_state === 'digest')
    expect(digests).toHaveLength(1)
    // Five error rows in the fenced table; still one card.
    expect(DATADOG_WIRE).toContain('Showing 5 errors (ordered by count).')
    expect(digests[0]!.title)
      .toBe('Non-200 API Errors in the Last 24 Hours (Excluding Errors already reported in Last 48 Hours) · Default')
    // Several of these land in the same minute, one per environment, under one
    // title — without the environment they are four identical-looking rows.
    expect(digests[0]!.pile).toBe('open')
  })
})

describe('#truto-grafana-alerts — fire and check-mark', () => {
  test('a window where everything recovered is an empty desk', () => {
    expect(GRAFANA_WIRE).toContain(':white_check_mark: HostSwapping')
    expect(cardsFrom(GRAFANA_WIRE, GRAFANA_CH)).toHaveLength(0)
  })

  test('a firing alert is one card, titled with the alert name', () => {
    const firing = only(GRAFANA_WIRE, b => !b.includes(':white_check_mark:'))
    const cards = cardsFrom(firing, GRAFANA_CH)
    expect(cards.map(c => c.title).sort()).toEqual(['HostSwapping', 'VictoriaLogsNoIngest'])
    const host = cards.find(c => c.title === 'HostSwapping')!
    expect(host.source_id).toBe('grafana:HostSwapping')
    expect((host.meta as any).monitor).toBe('HostSwapping')
    expect(host.excerpt).toContain('Chronic swap thrashing on ovh-mongo')
    // The attachment URL is an internal Docker hostname. It is not a link and
    // must not travel anywhere that would render it as one.
    expect(host.url).toBe(`https://truto.slack.com/archives/${GRAFANA_CH!.id}/p1788093221332489`)
    expect(host.excerpt).not.toContain('409f0b65787e')
  })

  test('the newest transition decides, whichever order the read arrived in', () => {
    // HostSwapping fired at 18:03 and cleared at 19:03. The clear is newer.
    const host = only(GRAFANA_WIRE, b => b.includes('HostSwapping'))
    expect(cardsFrom(host, GRAFANA_CH)).toHaveLength(0)
  })
})

describe('every alert card, whatever the channel', () => {
  const all = [
    ...cardsFrom(SENTRY_WIRE, SENTRY_CH),
    ...cardsFrom(DATADOG_WIRE, DATADOG_CH),
    ...cardsFrom(only(GRAFANA_WIRE, b => !b.includes(':white_check_mark:')), GRAFANA_CH),
  ]

  test('is an alert, from a channel, with nobody waiting on it', () => {
    expect(all.length).toBeGreaterThan(0)
    for (const c of all) {
      expect(c.kind).toBe('alert')
      expect(c.source).toBe('slack')
      expect((c.meta as any).alert).toBe(true)
      expect((c.meta as any).channel).toMatch(/^#/)
      expect((c.meta as any).channel_id).toMatch(/^C[A-Z0-9]+$/)
      // Nobody is waiting on an alert; it is waiting on him.
      expect(c.who).toBeUndefined()
    }
  })

  test('carries the workspace, so Open can reach the Slack app', () => {
    for (const c of all) expect((c.meta as any).team_id).toBe('T04CWR1AM1R')
  })

  test('carries the channel and the message, so the app link points somewhere', () => {
    for (const c of all) {
      expect((c.meta as any).thread_ts).toMatch(/^\d{10}\.\d{6}$/)
      expect(c.url).toContain(`/archives/${(c.meta as any).channel_id}/p`)
    }
  })
})

/** The single entry of a one-thread bucket map, or a failure that says so. */
function oneBucket<K, V>(m: Map<K, V>): [K, V] {
  const all = [...m]
  expect(all).toHaveLength(1)
  return all[0]!
}

describe('a human triaging an alert in its thread does not delete the alert', () => {
  /*
   * A thread bucket's key and an alert card's `source_id` are both
   * `<channel>:<ts>`, and they are equal exactly when the message a thread hangs
   * off is itself an alert. That is the standard triage move — reply under the
   * Sentry post and name whoever should take it — and one shared `seen` set
   * meant the mention won the identity and the alert row was skipped. The poll
   * is authoritative, so the sweep then marked the stored alert gone: the alert
   * disappeared from the desk the moment a person touched it.
   */
  const MENTION_UNDER_ALERT = `# Search Results for: <@U09617LRRDF> after:2026-08-16

## Messages (1 results)
### Result 1 of 1
Channel: #sentry-alerts (ID: C0BERTMS9K4)
From: Nidhi <nidhi@truto.one> (ID: U0BBZV4HQHH)
Time: 2026-08-30 18:41:02 IST
Message_ts: 1788095462.114300
Permalink: [link](https://truto.slack.com/archives/C0BERTMS9K4/p1788095462114300?thread_ts=1788094379.882969&cid=C0BERTMS9K4)
Text:
<@U09617LRRDF> can you take this one

---

`

  const folded = () => {
    const alert = cardsFrom(SENTRY_WIRE, SENTRY_CH)
      .find(c => (c.meta as any).short_id === 'TRUTO-38')!
    const [, bucket] = oneBucket(bucketHits(parseSlackResults(MENTION_UNDER_ALERT), 'U09617LRRDF'))
    const thread = buildThreadCard(bucket, null, 'U09617LRRDF')!
    // The collision the poll resolves: one string, two readers.
    expect(thread.source_id).toBe(alert.source_id)
    foldThreadIntoAlert(alert, thread)
    return alert
  }

  test('the alert keeps everything only the alert reader knows', () => {
    const c = folded()
    expect((c.meta as any).alert).toBe(true)
    expect((c.meta as any).short_id).toBe('TRUTO-38')
    expect(c.kind).toBe('alert')
    expect(c.refs.some(r => r.t === 'sentry' && r.v === 'TRUTO-38')).toBe(true)
  })

  test('and gains everything only the thread reader knows', () => {
    const c = folded()
    const thread = (c.meta as any).thread as Array<Record<string, any>>
    // Both bots' posts and the human reply, oldest first.
    expect(thread.map(e => e.ts)).toContain('1788095462.114300')
    expect(thread.length).toBeGreaterThan(1)
    expect(thread.map(e => e.ts)).toEqual([...thread.map(e => e.ts)].sort())
    // Somebody genuinely is waiting now, and the row says who.
    expect(c.who).toBe('Nidhi')
    expect((c.meta as any).tagged_at).toBeGreaterThan(0)
    expect(c.pile).toBe('now')
  })
})
