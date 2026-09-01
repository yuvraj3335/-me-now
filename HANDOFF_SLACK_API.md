# Handoff — the Slack messages a brief can carry

Written by the server-data agent for the launch-sheet agent. This is the
contract; the code behind it lives in `src/server/api.ts`,
`src/shared/slackThread.ts` and `src/server/sources/slack.ts`.

Nothing here fetches from Slack. Every field is read out of what the poll
already stored on the card, so the sheet can open with no network in the way and
no 502 to render.

---

## 1. `GET /api/cards/:group/slack`

The Slack conversations Wake already holds for one desk row: the thread parent,
and the replies under it.

* `:group` is the card's `group_key`, **percent-encoded** — group keys contain
  `:` and `/` (`slackthread:C04D9HKDWAV:1787812499.720579`,
  `gh:trutohq/truto#2034`).
* Always `200`. A group with no Slack in it answers `{ "threads": [] }` — not a
  404, not a placeholder thread.

### Response

```jsonc
{
  "threads": [
    {
      "channel":      "#truto",              // string | null — display name
      "channel_id":   "C04D9HKDWAV",         // string
      "team_id":      "T04CWR1AM1R",         // string | null
      "thread_ts":    "1787812499.720579",   // string — the parent's ts
      "reply_total":  10,                    // number — Slack's own header total
      "partial":      false,                 // true when the poll's thread read failed
      "alert":        false,                 // true for an alert row (see §1.3)
      "url":          "https://truto.slack.com/archives/C04D9HKDWAV/p1787812499720579",
      "app_url":      "slack://channel?team=T04CWR1AM1R&id=C04D9HKDWAV&message=1787812499.720579",
      "parent":       SlackThreadItem | null,
      "replies":      SlackThreadItem[]      // [] when nothing has been said under it
    }
  ]
}
```

`threads` is an array because a merged group can hold more than one Slack card —
a `#sentry-alerts` row and the human thread that collided with it are two
entries with two `channel_id` / `thread_ts` pairs.

### `SlackThreadItem`

One message. Every field needed to build a `slack://` deep link **for that
message**, and every field needed to become a `PackItem`.

```jsonc
{
  "kind":       "slack",                     // a launch.ts SlotKind, ready for PackItem.kind
  "ref":        "C04D9HKDWAV:1787814333.427979",  // PackItem.ref — channel:ts, unique per message
  "ts":         "1787814333.427979",         // string — Slack ts, NOT epoch ms
  "at":         1787814333427,               // number | null — epoch ms, for rendering a time
  "who":        "Yuvraj Muley",              // string | null
  "who_id":     "U09617LRRDF",               // string | null — U…, W… or B… (bot)
  "bot":        false,                       // boolean — who_id is a bot id
  "excerpt":    "all they care is they …",   // string — already cleaned, ≤ 280 chars, "" if wordless
  "tagged":     false,                       // boolean — this message names the operator
  "mine":       false,                       // boolean — the operator wrote it
  "parent":     false,                       // boolean — this is the thread parent
  "channel":    "#truto",                    // string | null
  "channel_id": "C04D9HKDWAV",               // string
  "team_id":    "T04CWR1AM1R",               // string | null
  "thread_ts":  "1787812499.720579",         // string | null — the parent this hangs off
  "url":        "https://truto.slack.com/archives/C04D9HKDWAV/p1787814333427979?thread_ts=1787812499.720579",
  "app_url":    "slack://channel?team=T04CWR1AM1R&id=C04D9HKDWAV&message=1787814333.427979"
}
```

* **`app_url` points at THIS message**, not at the channel and not at the
  parent — `message=` carries the item's own `ts`. It is `null` when the card
  never learned a `team_id`, because `slack://channel` without a team opens
  Slack on whatever was last shown, which looks exactly like a link that worked.
  Same rule, same string format as `slackAppUrl` in `src/web/lib/appLinks.ts`.
* **`url` is the durable https form** and is what a person can copy or share. It
  is also the form `SLACK_ARCHIVE` in `src/server/dedup.ts` parses back out.
* `excerpt` is already `plain()`-cleaned and capped by the poll. Do not re-clean.

### 1.3 What is and is not in here

* **Direct messages never appear.** The refusal is `bucketHits` in
  `src/server/sources/slack.ts` — a hit whose channel starts with `D` never
  becomes a bucket and so never becomes a card. This route reads stored cards
  only, and re-applies the same predicate (`isDmChannel` in
  `src/shared/slackThread.ts`) on the way out, so there is no way to route
  around it.
* **Bot messages are kept.** The poll's search sends `include_bots: true`
  (`searchArgs` in `slack.ts`, pinned by a test), alert-channel history is
  bot-inclusive by construction, and this route drops nothing. A bot line
  arrives with `bot: true` and `who_id` starting `B`.
* **His own messages are kept**, flagged `mine: true`. Picking your own message
  as context is legitimate; hiding it is not this route's call.
* Only the newest 20 replies are stored per card (`ENTRY_CAP`). `reply_total` is
  Slack's own header count and can exceed `replies.length`. Say `10 replies` from
  `reply_total`, never from the array length.
* An **alert** row (`alert: true`) has `parent: null` — its members are separate
  top-level messages in an alert channel, not a parent and its replies — and
  every message is in `replies`, oldest first.

### 1.4 Turning items into pack items

```ts
const item: PackItem = {
  kind: entry.kind,                 // 'slack'
  ref:  entry.ref,                  // 'C04D9HKDWAV:1787814333.427979'
  title: entry.who ?? 'Slack message',
  url:  entry.url,
  excerpt: entry.excerpt,
  why: entry.parent ? 'the thread this row is about' : 'a reply on that thread',
  meta: {
    channel: entry.channel,
    at: entry.at,
    open_in_app: entry.app_url,
  },
}
```

The parent's `ref` is byte-identical to what `refFor` in
`src/web/lib/cardContext.ts` already mints for a Slack card
(`${channel_id}:${thread_ts}`), so `openLaunch`'s duplicate collapse works
without a special case: adding the card and then the parent yields one item.

---

## 2. A pasted Slack link

### 2.1 The pure function

**Module:** `src/shared/slackThread.ts` (importable from both the server and the
browser — same directory `sessionRepo.ts` already lives in).

```ts
import { parseSlackLink, type SlackLinkResult, type SlackThreadItem } from '../../shared/slackThread'

export type SlackLinkResult =
  | { ok: true;  item: SlackThreadItem }
  | { ok: false; reason: string }

export function parseSlackLink(
  input: string,
  opts?: { teamId?: string | null },
): SlackLinkResult
```

Accepted, both real formats this codebase already mints and parses:

| input | notes |
|---|---|
| `https://truto.slack.com/archives/C04D9HKDWAV/p1787812499720579` | the archive form `SLACK_ARCHIVE` parses |
| `…/p1787814333427979?thread_ts=1787812499.720579&cid=C04D9HKDWAV` | a reply — `thread_ts` is carried through |
| `slack://channel?team=T04CWR1AM1R&id=C04D9HKDWAV&message=1787812499.720579` | the app form `slackAppUrl` mints |
| `slack://channel?team=…&id=…&message=1787812499720579` | undotted ts, normalised |

Refused, with `reason` written for a person:

* a DM (`https://…/archives/D0…/p…`, `slack://channel?…&id=D0…`)
* a channel link with no message (`slack://channel?team=…&id=C0…`)
* anything that is not a Slack link

`opts.teamId` supplies the workspace for the https form, which carries none. Omit
it and `team_id` / `app_url` come back `null`; the item is still valid.

### 2.2 The route (use this one from the sheet)

```
POST /api/slack/link      { "url": "<what he pasted>" }
  200 { "item": SlackThreadItem }
  400 { "error": "<the reason, in words>" }
```

Better than calling the pure function in the browser, and the reason is worth
knowing: the route fills `team_id` from the workspace this Wake is configured
for, and it looks the message up in what the poll already stored — so pasting a
link to a thread Wake *has* listed comes back with the real author, the real
excerpt and `tagged` / `mine` already decided, rather than an empty shell.

---

## 3. What changed on `/api/state` (change two)

Every grouped card now carries **`activity_at`** (number, epoch ms), and the desk
is sorted by it: `pinned → pile rank → activity_at DESC`.

```jsonc
{ "activity_at": 1787814333427, "ts": 1787814333427, /* … */ }
```

`ts` is set to the same number. They are one clock on purpose — the age a row
prints and the reason it is where it is must not be two different facts.
`activity_at` is never earlier than the old `ts`; it only ever moves forward onto
a real event.

Per source, what feeds it — this is the documented rule:

| source | what moves `activity_at` |
|---|---|
| Slack thread | the card's `ts` (newest of parent / replies / search hits), every `meta.thread[].ts`, and `meta.last_reply_at` |
| Slack alert | the card's `ts` (newest member), every `meta.thread[].ts` — and any human reply folded in by `foldThreadIntoAlert` |
| Gmail | the card's `ts` (now the newest of the thread date and every `meta.messages[].ts`) and every `meta.messages[].ts` |
| GitHub | the card's `ts`, which is the issue/PR `updated_at` |
| Sentry | the card's `ts`, which is `lastSeen`; plus anything merged onto the same `sentry:` ref, which is how an alert-channel follow-up moves the row |
| Claude Code | the card's `ts` (transcript mtime) and `meta.live_at` — when the session became live, from Claude Code's own per-process files |

New on the Claude card's `meta`: `live` (boolean) and `live_at` (number | null).

**Nothing about `+N` or the amber edge changed.** `activityOf` is untouched: a
group's `activity` is still counted from the baseline, still excludes his own
messages, and a bare timestamp moving forward still creates no event.

---

## 4. Sessions ordering

`src/shared/slackThread.ts` is Slack-only; the sessions rule lives in
**`src/shared/sessionOrder.ts`**:

```ts
export function bySessionActivity(
  a: { live?: boolean; lastTs: number },
  b: { live?: boolean; lastTs: number },
): number
```

Live first, then most recently active. Applied in
`src/web/components/sessions.tsx`. Nothing else needs to do anything.

---

## 5. `meta.resume_cmd` is gone from Claude Code cards

`src/server/sources/claudeSessions.ts` no longer sets `resume_cmd` on a session
card's `meta`. A session is reachable from the browser now — `/terminal/<id>` —
so a `claude --resume …` line for the operator to copy into a terminal he has to
go and find is both redundant and the worse of the two answers. `meta.session_id`
is still there and is what a link is built from.

**Two readers outside my ownership still ask for it**, and both degrade quietly
rather than break — but both are now rendering nothing where they used to render
something, and neither is mine to fix:

* **`src/web/components/CardDetail.tsx:183`** — `const resume =
  claude?.meta?.resume_cmd`, rendered at line 376 behind `{resume && (…)}`. The
  mono line with the copy button simply stops appearing. What belongs there
  instead is an **Open** control:
  ```ts
  const sessionId = claude?.meta?.session_id as string | undefined
  // …
  await openTerminalAndGo({ sessionId })   // src/web/lib/terminal.ts
  ```
  That file is in my do-not-edit list, so this is a request rather than a change.

* **`src/web/lib/cardContext.ts:111`** — `resume_with: m.resume_cmd` inside
  `metaFor`. `pick()` drops undefined values, so the key just disappears from the
  brief's meta; nothing throws. If a brief should still be able to name the
  session, swap it for `session: m.session_id` — the value `refFor` on line 78
  already uses as the Claude source's ref.

Nothing in `test/` asserts on `resume_cmd`.

## 6. Sessions rows can be opened

`src/web/components/sessions.tsx` now carries two controls per row, and they are
two different things:

* **Open** → `openTerminalAndGo({ sessionId: s.id })` — the session itself,
  resumed on this box in its own repository. Offered on every row, not only the
  live ones: `s.live` decides whether the server attaches or starts, which is the
  server's business, and hiding it on an idle session would leave the commonest
  case — coming back to yesterday's work — as the one case with no button. A
  refusal arrives as the server's own sentence and goes straight into a toast.
* **Open in Claude** → `openLaunch(...)`, unchanged. The brief sheet, which is a
  conversation *about* this work rather than the work itself. Demoted to `ghost`
  so the primary action reads as primary.

Both keep their word at `xl` and collapse to a mark below it, under the width
measurements already recorded in that file.

## 7. What I could not do from here

* **`src/web/pages/Home.tsx`** — no change needed. Its Due sort runs over the
  already-server-sorted array and only when `?sort=due|-due` is set, so the new
  order arrives underneath it and Due still takes precedence. Nothing to do.
* **`src/server/ingest.ts`** — not mine to edit. A Sentry *comment* has no
  timestamp anywhere in the MCP payload this codebase reads, so the only way to
  make a comment count change stamp an instant is to compare the incoming
  `meta.comments` against the stored row inside the ingest upsert and carry a
  `meta.commented_at` forward. The card now carries `meta.comments` so that patch
  is a four-line change when somebody owns that file. Until then a Sentry comment
  moves the row only when it also lands in `#sentry-alerts`, which is how the
  Cursor triage bot actually delivers one.
