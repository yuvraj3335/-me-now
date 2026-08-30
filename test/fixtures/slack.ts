/**
 * What mcp.slack.com actually answered, on 2026-08-30, to the three calls Wake
 * makes. Captured before the parsers were written and copied here verbatim —
 * abridged only where the original capture was abridged, and never reshaped to
 * suit a test. A fixture somebody tidied is a fixture that stops proving
 * anything.
 *
 * Backticks are escaped because these live in template literals; nothing else
 * about the text has been touched.
 */

/** `slack_read_thread` — channel C04D9HKDWAV, message_ts 1787812499.720579. */
export const THREAD_READ = `=== THREAD PARENT MESSAGE ===
From: Nidhi <nidhi@truto.one> (U0BBZV4HQHH)
Time: 2026-08-27 12:04:59 IST
Message TS: 1787812499.720579
<@U09617LRRDF|Yuvraj Muley>, can you confirm the clearing behavior since I see you added it
<https://truto.slack.com/archives/C0AHHQMF08L/p1787777335863559|https://truto.slack.com/archives/C0AHHQMF08L/p1787777335863559>
Reactions: bethal (1), eyes (1)
Forwarded message from Sunny Siu: <@U061JB3L41W> We want to detect when an integrated account needs to be reauthorized

=== THREAD REPLIES (10 total) ===

--- Reply 1 of 10 ---
From: Yuvraj Muley <yuvraj@truto.one> (U09617LRRDF)
Time: 2026-08-27 12:35:33 IST
Message TS: 1787814333.427979
all they care is they need to a trigger to decide if an account needs to be reauthed

--- Reply 2 of 10 ---
From: Yuvraj Muley <yuvraj@truto.one> (U09617LRRDF)
Time: 2026-08-27 12:36:33 IST
Message TS: 1787814393.507099
and if they are not granting certain scopes when the account was first created *just* reauth will still throw a 403

--- Reply 4 of 10 ---
From: Yuvraj Muley <yuvraj@truto.one> (U09617LRRDF)
Time: 2026-08-27 12:45:40 IST
Message TS: 1787814940.760769
Also, crazy blunder i was sceptical about :smiling_face_with_tear:, I'll fix this
Files: image.png (ID: F0BSY2UPBL5, image/png, 98.8 KB)

--- Reply 7 of 10 ---
From: Riya <riya@truto.one> (U0B5V7G3NQ5)
Time: 2026-08-27 14:20:16 IST
Message TS: 1787820616.819949
Added comments
`

/**
 * `slack_read_channel` — C0BERTMS9K4 (#sentry-alerts), limit 4.
 *
 * The line that makes alert channels READ rather than searched is in here:
 * `notes: <!subteam^S06HDT77E1M|@truto-eng>` lives in Block Kit, and Slack's
 * search index does not cover it.
 */
export const CHANNEL_READ = `Channel: #sentry-alerts (C0BERTMS9K4)

=== Message from Cursor <botuser-T04CWR1AM1R-B092446N6LB@slack-bots.com> (U092446PCTV) at 2026-08-30 18:27:14 IST ===
Message TS: 1788094634.851449
_TRUTO-38_ — \`TypeError: Cannot read properties of undefined (reading 'payload_transform')\`
<https://truto.sentry.io/issues/7700748352/>

_Root cause:_ \`POST /environment-integration-webhook/:id\` read
_Classification:_ (a) application bug
_Fix:_ Guard with \`isNil\` Vitest: 2 passed.
<https://cursor.com/agents/bc-023e1f21|Open in Cursor> · Cursor Grok 4.5 · <https://github.com/trutohq/truto/pull/2037|View PR>
App notification from App (https://truto.sentry.io/issues/7700748352/): :red_circle: <https://truto.sentry.io/issues/7700748352/?referrer=slack|*TypeError*>
processRequest(index)
\`\`\`Cannot read properties of undefined (reading 'payload_transform')\`\`\`
State: *New*   First Seen: *4 minutes ago*
Resolve button
Archive button
Project: <https://truto.sentry.io/issues/?project=4511647571574784|truto>    Alert: TRUTO-38    Short ID: TRUTO-38

=== Message from Sentry <botuser-T04CWR1AM1R-B0BEVJZV9BN@slack-bots.com> (U0BFL7HM40Y) at 2026-08-30 18:22:59 IST ===
Message TS: 1788094379.882969
:red_circle: <https://truto.sentry.io/issues/7700748352/?referrer=slack&amp;notification_uuid=1&amp;workflow_id=3657647&amp;alert_type=issue|*TypeError*>
processRequest(index)
\`\`\`Cannot read properties of undefined (reading 'payload_transform')\`\`\`
State: *New*   First Seen: *Just now*
Resolve button
Archive button
notes: <!subteam^S06HDT77E1M|@truto-eng>
Project: <https://truto.sentry.io/issues/?project=4511647571574784|truto>    Alert: <https://sentry.io/organizations/truto/monitors/alerts/3657647/|Notify #sentry-alerts via Slack>    Short ID: TRUTO-38
`

/**
 * `slack_read_channel` — C05UPHVT2CQ (#truto-api-alerts).
 *
 * The capture that produced DESIGN §7. There is no digest in this channel:
 * there is a `Warn:` and a `Recovered:` six minutes apart, every few minutes,
 * forever, naming `@slack-truto-api-alerts` — a channel handle, not him and not
 * `@truto-eng`. A card per message here is a Datadog metronome on the desk.
 *
 * The third message is the one that would still land: a real digest that pages
 * the team. It is here so the rule is proven to admit as well as refuse.
 */
export const CHANNEL_READ_METRONOME = `Channel: #truto-api-alerts (C05UPHVT2CQ)

=== Message from Datadog <botuser-T04CWR1AM1R-B05UPHTF70Q@slack-bots.com> (U05UPHTF70Q) at 2026-08-30 22:11:32 IST ===
Message TS: 1788108092.130049
Attachment: Recovered: Number of requests is high (https://us3.datadoghq.com/monitors/453870)
@slack-truto-api-alerts

Less than or exactly 30000.0 log events matched in the last 5m
Notified: @slack-truto-api-alerts
Attachment: View in Log Explorer (https://us3.datadoghq.com/logs)

=== Message from Datadog <botuser-T04CWR1AM1R-B05UPHTF70Q@slack-bots.com> (U05UPHTF70Q) at 2026-08-30 22:05:32 IST ===
Message TS: 1788107732.884019
Attachment: Warn: Number of requests is high (https://us3.datadoghq.com/monitors/453870)
@slack-truto-api-alerts

More than 30000.0 log events matched in the last 5m
Notified: @slack-truto-api-alerts

=== Message from Datadog <botuser-T04CWR1AM1R-B05UPHTF70Q@slack-bots.com> (U05UPHTF70Q) at 2026-08-30 21:00:00 IST ===
Message TS: 1788103800.000100
Nightly API digest for <!subteam^S06HDT77E1M|@truto-eng>: 4 endpoints over budget
`

/**
 * A message whose body renders empty — a reaction-only post, or an image with
 * no caption. `Reactions:` and `Files:` are transport, so nothing is left.
 */
export const CHANNEL_READ_WORDLESS = `Channel: #sentry-alerts (C0BERTMS9K4)

=== Message from Sentry <botuser-T04CWR1AM1R-B0BEVJZV9BN@slack-bots.com> (U0BFL7HM40Y) at 2026-08-30 18:22:59 IST ===
Message TS: 1788094379.882969
Reactions: eyes (1)
Files: chart.png (ID: F0BSY2UPBL6, image/png, 12.0 KB)
`

/**
 * `slack_search_public_and_private` for `<@U09617LRRDF> after:…`.
 *
 * The three permalinks are the live ones from FIXTURES §3: a parent and two of
 * its replies, all three carrying the same `thread_ts`. This is the payload that
 * put three rows on the desk for one conversation.
 */
export const SEARCH_ONE_THREAD = `# Search Results for: <@U09617LRRDF> after:2026-08-16

## Messages (3 results)
### Result 1 of 3
Channel: #truto (ID: C04D9HKDWAV)
From: Nidhi <nidhi@truto.one> (ID: U0BBZV4HQHH)
Time: 2026-08-27 12:04:59 IST
Message_ts: 1787812499.720579
Permalink: [link](https://truto.slack.com/archives/C04D9HKDWAV/p1787812499720579?thread_ts=1787812499.720579&cid=C04D9HKDWAV)
Text:
<@U09617LRRDF|Yuvraj Muley>, can you confirm the clearing behavior since I see you added it

---

### Result 2 of 3
Channel: #truto (ID: C04D9HKDWAV)
From: Uday Bhaskar Gajavalli <uday@truto.one> (ID: U061JB3L41W)
Time: 2026-08-27 12:12:44 IST
Message_ts: 1787812964.247529
Permalink: [link](https://truto.slack.com/archives/C04D9HKDWAV/p1787812964247529?thread_ts=1787812499.720579&cid=C04D9HKDWAV)
Text:
<@U09617LRRDF> what did we land on here

---

### Result 3 of 3
Channel: #truto (ID: C04D9HKDWAV)
From: Riya <riya@truto.one> (ID: U0B5V7G3NQ5)
Time: 2026-08-27 12:44:09 IST
Message_ts: 1787814249.215859
Permalink: [link](https://truto.slack.com/archives/C04D9HKDWAV/p1787814249215859?thread_ts=1787812499.720579&cid=C04D9HKDWAV)
Text:
<@U09617LRRDF> ptal when you get a minute

---

`

/**
 * One reply, whose parent predates the lookback and is therefore not in the
 * results at all — the `#spendflo-truto` shape from FIXTURES §3.
 */
export const SEARCH_ORPHAN_REPLY = `# Search Results for: <@U09617LRRDF> after:2026-08-16

## Messages (1 results)
### Result 1 of 1
Channel: #truto (ID: C04D9HKDWAV)
From: Riya <riya@truto.one> (ID: U0B5V7G3NQ5)
Time: 2026-08-27 14:20:16 IST
Message_ts: 1787820616.819949
Permalink: [link](https://truto.slack.com/archives/C04D9HKDWAV/p1787820616819949?thread_ts=1787812499.720579&cid=C04D9HKDWAV)
Text:
<@U09617LRRDF> added comments

---

`

/** A direct message and a group message, as each search spells them. */
export const SEARCH_WITH_DM = `# Search Results for: <@U09617LRRDF> after:2026-08-16

## Messages (3 results)
### Result 1 of 3
Channel: DM (ID: D0BT1ED811Q)
Participants: Ramesh Sutaliya (ID: U09038ZHE3H), Yuvraj Muley (ID: U09617LRRDF)
From: Ramesh Sutaliya <ramesh.sutaliya@spendflo.com> (ID: U09038ZHE3H)
Time: 2026-08-27 11:03:21 IST
Message_ts: 1787808801.580799
Permalink: [link](https://truto.slack.com/archives/D0BT1ED811Q/p1787808801580799)
Text:
Hi Yuvraj, can you check with <@U08HCR8KXQB|Varad> and provide the details.

---

### Result 2 of 3
Channel: MPIM (ID: D0BQQQQ1111)
From: Sunny Siu <sunny@truto.one> (ID: U061JB3L41W)
Time: 2026-08-27 11:33:21 IST
Message_ts: 1787810601.111111
Permalink: [link](https://truto.slack.com/archives/D0BQQQQ1111/p1787810601111111)
Text:
<@U09617LRRDF> quick one

---

### Result 3 of 3
Channel: #dm-tools (ID: C0DMTOOLS1)
From: Nidhi <nidhi@truto.one> (ID: U0BBZV4HQHH)
Time: 2026-08-27 11:43:21 IST
Message_ts: 1787811201.222222
Permalink: [link](https://truto.slack.com/archives/C0DMTOOLS1/p1787811201222222)
Text:
<@U09617LRRDF> the channel whose name merely starts with dm

---

`

/** `#github-updates` — matches the query, is about nobody, and names nobody. */
export const SEARCH_FIREHOSE = `# Search Results for: <!subteam^S06HDT77E1M> after:2026-08-16

## Messages (2 results)
### Result 1 of 2
Channel: #github-updates (ID: C0GHUPD8888)
From: GitHub <github@truto.one> (ID: B0GH1111)
Time: 2026-08-30 10:00:00 IST
Message_ts: 1788000000.000100
Permalink: [link](https://truto.slack.com/archives/C0GHUPD8888/p1788000000000100)
Text:
<!subteam^S06HDT77E1M> pushed 3 commits to main

---

### Result 2 of 2
Channel: #github-updates (ID: C0GHUPD8888)
From: GitHub <github@truto.one> (ID: B0GH1111)
Time: 2026-08-30 10:05:00 IST
Message_ts: 1788000300.000200
Permalink: [link](https://truto.slack.com/archives/C0GHUPD8888/p1788000300000200)
Text:
<@U09617LRRDF> was requested as a reviewer on trutohq/truto#2037

---

`

export const ME_ID = 'U09617LRRDF'
export const TRUTO_ENG = 'S06HDT77E1M'
