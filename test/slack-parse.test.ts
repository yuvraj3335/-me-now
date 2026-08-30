import { describe, expect, test } from 'bun:test'
import { parseChannelMessages, parseSlackResults, readsLikeAsk } from '../src/server/sources/slack'

/** Verbatim from a live mcp.slack.com search — the format this parser exists for. */
const REAL = `# Search Results for: to:me after:2026-08-15

## Messages (5 results)
### Result 1 of 5
Channel: DM (ID: D0BT1ED811Q)
Participants: Ramesh Sutaliya (ID: U09038ZHE3H), Yuvraj Muley (ID: U09617LRRDF)
From: Ramesh Sutaliya <ramesh.sutaliya@spendflo.com> (ID: U09038ZHE3H) 
Time: 2026-08-27 11:03:21 IST
Message_ts: 1787808801.580799
Permalink: [link](https://truto.slack.com/archives/D0BT1ED811Q/p1787808801580799)
Text: 
Hi Yuvraj,
we are going to give a internal demo with product today, can you check with <@U08HCR8KXQB|Varad> and provide the details.

---

### Result 2 of 5
Channel: #eng-platform (ID: C0123ABCD)
Participants: Uday Bhaskar Gajavalli (ID: U061JB3L41W), Yuvraj Muley (ID: U09617LRRDF)
From: Uday Bhaskar Gajavalli <uday@truto.one> (ID: U061JB3L41W) 
Time: 2026-08-26 11:34:19 IST
Message_ts: 1787724259.189389
Permalink: [link](https://truto.slack.com/archives/C0123ABCD/p1787724259189389)
Text: 
see https://github.com/trutohq/truto/pull/2034 when you get a sec

---

`

test('parses the real Slack markdown response', () => {
  const hits = parseSlackResults(REAL)
  expect(hits).toHaveLength(2)

  const [dm, ch] = hits
  expect(dm!.channelId).toBe('D0BT1ED811Q')
  expect(dm!.isDm).toBe(true)
  expect(dm!.fromName).toBe('Ramesh Sutaliya')
  expect(dm!.fromId).toBe('U09038ZHE3H')
  expect(dm!.ts).toBe('1787808801.580799')
  expect(dm!.epochMs).toBe(1787808801580)
  expect(dm!.permalink).toBe('https://truto.slack.com/archives/D0BT1ED811Q/p1787808801580799')
  expect(dm!.text).toContain('internal demo')

  expect(ch!.isDm).toBe(false)
  expect(ch!.channelName).toBe('#eng-platform')
  expect(ch!.text).toContain('github.com/trutohq/truto/pull/2034')
})

test('flags a real ask without a model', () => {
  expect(readsLikeAsk('can you check with Varad and provide the details.')).toBe('a direct request')
  expect(readsLikeAsk('any update on the zoom oauth app?')).toBe('someone is chasing an update')
  expect(readsLikeAsk('I don’t have plan ready yet')).toBeNull()
})

/* ---------------- slack_read_channel — the other format ---------------- */

/**
 * Verbatim from a live `slack_read_channel` on #sentry-alerts, captured with
 * `oldest` and `latest` both set. Three messages: Cursor's triage of TRUTO-38,
 * the Sentry alert it is about, and Cursor's triage of TRUTO-36.
 *
 * A search result and a channel read are two different formats and this parser
 * exists for the second one. Everything odd below is real and load-bearing: the
 * header line ends with a space after the final `===`, the author id in
 * parentheses is a user id here and a bot id elsewhere, `Message TS:` is always
 * the line after the header, entities arrive encoded, and there is no
 * `Permalink:` field at all.
 */
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
 * Verbatim from #truto-grafana-alerts, sliced to its first message. Alertmanager
 * renders with **no address and no user id** — the parenthesised token is a bot
 * id — and its entire message is one `Attachment:` line.
 */
const ALERTMANAGER_WIRE = `Channel: #truto-grafana-alerts (C0B53TSLGLA)

=== Message from Alertmanager (B0B4XH780KV) at 2026-08-30 19:03:41 IST === 
Message TS: 1788096821.345759

Attachment: :white_check_mark: HostSwapping (http://409f0b65787e:9093/#/alerts?receiver=slack-default)
*Chronic swap thrashing on ovh-mongo*
ovh-mongo has averaged 105 pages/sec in+out over the last 6 hours -- the working set permanently exceeds RAM. Check memory consumers with \`ps -eo rss,args --sort=-rss | head\`. On ovh-mongo the dominant consumer is mongod's WiredTiger cache (\`cacheSizeGB\` in /etc/mongod.conf, set to 20 on a 30 GiB box as of Aug 18 2026); shrink it or add RAM. NOTE: the pm2 migration-script fleet moved off ovh-mongo to ovh-clonepartner-1 on Aug 18 2026 and is no longer a consumer there.`

describe('parseChannelMessages', () => {
  const hits = parseChannelMessages({ messages: SENTRY_WIRE }, 'C0BERTMS9K4')

  test('splits on the header line, trailing space and all', () => {
    expect(hits).toHaveLength(3)
    expect(hits.map(h => h.ts)).toEqual([
      '1788094634.851449', '1788094379.882969', '1788093455.464419',
    ])
    expect(hits.every(h => h.channelName === '#sentry-alerts')).toBe(true)
    // A channel read is never a direct message, whatever the search path sees.
    expect(hits.every(h => h.isDm === false)).toBe(true)
  })

  test('the permalink is synthesised, because the payload carries none', () => {
    expect(hits[1]!.permalink)
      .toBe('https://truto.slack.com/archives/C0BERTMS9K4/p1788094379882969')
    expect(SENTRY_WIRE).not.toContain('Permalink:')
  })

  test('the Sentry alert keeps the two anchors a card is built from', () => {
    const sentry = hits[1]!
    expect(sentry.fromName).toBe('Sentry')
    expect(sentry.fromId).toBe('U0BFL7HM40Y')
    expect(sentry.epochMs).toBe(1788094379882)
    expect(sentry.text).toContain('notes: <!subteam^S06HDT77E1M|@truto-eng>')
    expect(sentry.text).toContain('Short ID: TRUTO-38')
  })

  test('the workspace comes out of the bot address, for the app link', () => {
    expect(hits[1]!.teamId).toBe('T04CWR1AM1R')
  })

  test('entities are decoded, so the issue URL is a URL', () => {
    expect(hits[1]!.text).toContain('?referrer=slack&notification_uuid=')
    expect(hits[1]!.text).not.toContain('&amp;')
  })

  test('the Cursor twin arrives whole, re-render and footer included', () => {
    const cursor = hits[0]!
    expect(cursor.fromName).toBe('Cursor')
    expect(cursor.text).toContain('_TRUTO-38_')
    expect(cursor.text).toContain('App notification from App (')
    expect(cursor.text).toContain('github.com/trutohq/truto/pull/2037|View PR')
  })

  test('an author with no address and a bot id still parses', () => {
    const [alert] = parseChannelMessages({ messages: ALERTMANAGER_WIRE }, 'C0B53TSLGLA')
    expect(alert!.fromName).toBe('Alertmanager')
    expect(alert!.fromId).toBe('B0B4XH780KV')
    expect(alert!.ts).toBe('1788096821.345759')
    // Nothing in this payload names the workspace, so the caller falls back.
    expect(alert!.teamId).toBeUndefined()
    expect(alert!.text).toContain('Attachment: :white_check_mark: HostSwapping')
  })

  test('a bare string is the same payload as an envelope', () => {
    expect(parseChannelMessages(SENTRY_WIRE, 'C0BERTMS9K4')).toHaveLength(3)
  })

  test('a payload that is not text is a failed read, not an empty channel', () => {
    // Swallowed into `[]` this reaches `settle` as a success, and the sweep then
    // marks every stored alert card gone.
    expect(() => parseChannelMessages({ error: 'nope' }, 'C0BERTMS9K4')).toThrow(/not text/)
    expect(() => parseChannelMessages(null, 'C0BERTMS9K4')).toThrow(/not text/)
  })
})
