/**
 * What mcp.slack.com actually answered, on 2026-08-30, to the two calls a thread
 * row is built from. Captured before the parsers were written and copied here
 * verbatim —
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

/**
 * A direct message and a group message, as each search spells them, plus the two
 * public channels that tell the two refusals apart.
 *
 * `#dm-tools` is a channel whose *name* begins `dm` and whose id does not — it
 * is what proves the direct-message rule reads the id rather than the name. It
 * is also not on `SLACK_CHANNELS`, so it is refused a second time and for a
 * different reason, which is why `#crisp-chats` is here: something on the list
 * has to survive, or a test that everything was dropped would pass for the
 * wrong reason.
 */
export const SEARCH_WITH_DM = `# Search Results for: <@U09617LRRDF> after:2026-08-16

## Messages (4 results)
### Result 1 of 4
Channel: DM (ID: D0BT1ED811Q)
Participants: Ramesh Sutaliya (ID: U09038ZHE3H), Yuvraj Muley (ID: U09617LRRDF)
From: Ramesh Sutaliya <ramesh.sutaliya@spendflo.com> (ID: U09038ZHE3H)
Time: 2026-08-27 11:03:21 IST
Message_ts: 1787808801.580799
Permalink: [link](https://truto.slack.com/archives/D0BT1ED811Q/p1787808801580799)
Text:
Hi Yuvraj, can you check with <@U08HCR8KXQB|Varad> and provide the details.

---

### Result 2 of 4
Channel: MPIM (ID: D0BQQQQ1111)
From: Sunny Siu <sunny@truto.one> (ID: U061JB3L41W)
Time: 2026-08-27 11:33:21 IST
Message_ts: 1787810601.111111
Permalink: [link](https://truto.slack.com/archives/D0BQQQQ1111/p1787810601111111)
Text:
<@U09617LRRDF> quick one

---

### Result 3 of 4
Channel: #dm-tools (ID: C0DMTOOLS1)
From: Nidhi <nidhi@truto.one> (ID: U0BBZV4HQHH)
Time: 2026-08-27 11:43:21 IST
Message_ts: 1787811201.222222
Permalink: [link](https://truto.slack.com/archives/C0DMTOOLS1/p1787811201222222)
Text:
<@U09617LRRDF> the channel whose name merely starts with dm

---

### Result 4 of 4
Channel: #crisp-chats (ID: C07351C8Z8E)
From: Nidhi <nidhi@truto.one> (ID: U0BBZV4HQHH)
Time: 2026-08-27 11:53:21 IST
Message_ts: 1787811801.333333
Permalink: [link](https://truto.slack.com/archives/C07351C8Z8E/p1787811801333333)
Text:
<@U09617LRRDF> a channel that is actually on the list

---

`

export const ME_ID = 'U09617LRRDF'
