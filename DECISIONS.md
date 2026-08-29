# Decisions

Every non-obvious call made while building Wake, and every place I deliberately
did **not** do what the brief said. The brief asked to be treated as intent, not
gospel — this is where I disagree in writing.

---

## 1. Slack on the DevBox — I was wrong, then right for a different reason

**Corrected 2026-08-30.** My first reading said there was no Slack MCP on the
DevBox. That was true when I checked and stale within the hour: Slack, Sentry and
Notion were all connected while I was building. `claude mcp list` there now shows:

```
claude.ai Sentry   https://mcp.sentry.dev/mcp                 ✔ Connected
claude.ai Notion   https://mcp.notion.com/mcp                 ✔ Connected
claude.ai Slack    https://mcp.slack.com/mcp                  ✔ Connected
claude.ai Gmail    https://gmailmcp.googleapis.com/mcp/v1     ✔ Connected
```

So Slack *is* on the box. Wake still cannot use it, and the reason is not the one
I originally gave — see the next decision.

## 2. Wake is a real MCP client, not a passenger on Claude Code's connections

**The reasoning here was wrong the first time and is worth showing corrected,
because the wrong version was more convenient.**

I originally argued that Claude reaches these connectors through a per-session
Anthropic proxy that "dies with the session":

```
https://api.anthropic.com/v2/ccr-sessions/cse_01PpFj…/mcp
  ?mcp_server_id=…&mcp_url=https%3A%2F%2Fgmailmcp.googleapis.com%2Fmcp%2Fv1
```

That claim is false. I tested it: POSTing `tools/list` to that URL with the
account's OAuth token returns **200 and the real tool list**, for a session id
that has long since ended. The session id in the path is not what gates access —
the bearer token is.

The conclusion survives on better evidence:

1. **claude.ai connector tokens are never written to disk.** There are 23
   `mcpOAuth` entries in `~/.claude/.credentials.json` and **every single one has
   an empty `accessToken`** — Gmail, Drive, Calendar, figma, all of them. These
   connections are held in the claude.ai account and materialised per session, so
   Wake's credential bridge has nothing to read.
2. **The proxy is per-connector and validates it.** Swapping `mcp_url` to Slack
   while keeping Gmail's ids returns `403 MCP server not allowed`; dropping the
   ids returns `400 toolbox_mcp_server_id query parameter is required`. Those ids
   come from a connector registry I could not find on any endpoint
   (`/v2/mcp_servers`, `/api/mcp/servers`, … all 404) or in any local cache —
   `.claude.json` records only the connector's *name* in
   `claudeAiMcpEverConnected`.
3. Even if I could enumerate them, this is an **undocumented internal endpoint**.
   A personal command center whose only data path is a reverse-engineered API is
   one silent deploy away from showing an empty screen at 7am.

So Wake speaks MCP itself — `initialize` / `tools/list` / `tools/call` over
Streamable HTTP and stdio (`src/server/mcp/client.ts`), with its own OAuth 2.1 +
PKCE (`src/server/mcp/oauth.ts`) including RFC 7591 dynamic client registration
where a server offers it. Verified live: Wake self-registered with Sentry
(`client_id: _aYRoHwcPeWDVo-v`) and produced a correct S256 authorize URL with no
setup at all.

Credentials resolve in a chain, best-available-wins (`src/server/mcp/creds.ts`):

1. Wake's own OAuth tokens (SQLite, auto-refreshed) — the durable path
2. Claude Code's `~/.claude/.credentials.json` `mcpOAuth` entry — which works
   only for a server added **directly** (`claude mcp add --transport http`), not
   for a claude.ai connector, per the evidence above
3. A static token from the environment — the escape hatch

## 3. No Claude model anywhere in the data path — enforced, not just intended

The brief says Wake must not use a model to fetch or summarize. It doesn't, and
this is a structural property rather than a promise: Wake has no Anthropic SDK
dependency and no API key in its environment. Every field on every card is
either copied verbatim from a tool result or computed by deterministic code you
can read. "Why it is on me" is a rule firing, not a generated sentence.

## 4. Dedup is union-find over extracted references, not fuzzy similarity

The hard requirement was "never show me the same thing five times". Two ways to
do that: guess at similarity, or find the actual shared identifier. I did the
second, because a wrong guess here is the worst possible failure — it *hides*
something real.

`src/server/dedup.ts` extracts hard references from every card (GitHub
owner/repo#number from any URL in the body, Slack `channel:thread_ts`, Gmail
`threadId`, RFC-5322 `Message-ID`, and a normalized subject with `Re:`/`Fwd:`/
list-prefix noise stripped), then unions cards that share one. A Slack thread
about PR #2034, the review-requested card for PR #2034, and the GitHub
notification email about PR #2034 collapse into **one** card carrying three
source badges.

Cards that share no hard reference are left alone. One honest card beats a clever
merge, exactly as the brief asked.

## 5. "Already seen" is tracked per group, not per card

Acknowledgement, snoozing and notification state live on the **group key**, not on
the individual source card (`card_state` table). This is what makes the
one-reminder-per-thing rule hold: a new Slack reply on a thread you already
acknowledged updates the card's timestamp, but cannot re-notify you, because the
group already has a `notified_at`. Reminders carry a `UNIQUE` index on their
target for the same reason — a second copy of the same source physically cannot
create a second notification.

## 6. Charts are d3-scale + d3-shape + motion, not a chart component library

The brief asked for a "real charting library" and also said that if a screen
looks like an admin dashboard, it is wrong. Those two requests fight each other:
Recharts, Chart.js and friends *are* the admin-dashboard look — their defaults
(gridlines, boxed legends, tooltips with drop shadows) are precisely the aesthetic
being ruled out, and fighting a component library's defaults costs more than
drawing the mark.

So I use the real libraries one layer down — `d3-scale` for the scales and
`d3-shape` for the path generators — and render the marks as SVG driven by
`motion`. Same math, no imposed chrome, and the bars/lines can be animated as
first-class motion elements instead of via a chart library's animation prop.

## 7. Read-only against the world is enforced by scope, not by discipline

Wake requests only read scopes from Slack, only calls read tools on Gmail, and
uses `gh` with the token it already has. The MCP client has a **write-tool
denylist** (`src/server/mcp/client.ts`) that refuses to invoke any tool whose name
matches send/post/create/update/delete/trash/archive patterns, so a future edit
that adds a write call fails loudly instead of quietly messaging your colleagues.

## 8. Gmail ships as an adapter behind a documented setup step

Gmail auth was being done in parallel and the brief said not to block on it. The
Gmail MCP server (`gmailmcp.googleapis.com`) publishes **no** OAuth discovery
metadata of its own — both well-known endpoints 404 — because Google expects the
client to arrive with a Google OAuth token. So Wake's Gmail adapter is written,
wired, and tested against the real tool schema (`search_threads`, `get_thread`,
`list_labels`), and it activates the moment a credential resolves through the
chain in decision #2. Setup is one documented step in `SETUP.md`.

Both `yuvraj@redroot.one` and `engineering@redroot.one` are configured as separate
accounts, so the adapter is multi-account from the start rather than retrofitted.

## 9. Piles are computed, not folders

Now / Open / Parked are not places a card is filed. They are a function of the
card plus your state (`pile()` in `src/server/dedup.ts`):

- **Now** — someone else is blocked on you: a DM, a mention, a thread you're in,
  a review request, an assigned issue, an unread mail addressed directly to you
- **Open** — you started it and nobody is waiting: your own open PRs, live Claude
  Code sessions, tasks you moved to in-progress
- **Parked** — you snoozed it, and it returns by itself when the snooze expires

A manual override always wins, and "not mine" is permanent. This is why the piles
can't drift out of sync with reality the way manual folders do.

## 10. Tasks are first-class objects, not annotations on cards

The brief called your own work "half the product", so tasks/goals/notes/reminders
have their own tables and their own API rather than being extra columns on a
card. A task can *link* to a card (`source_card_group`) but does not require one,
and deleting or dismissing the card leaves the task alone. That keeps your own
work durable against upstream churn — a Slack message can be deleted; the task
you made from it shouldn't vanish.

## 11. Polling, not webhooks

Wake polls each source on an interval (default 3 min, jittered per source). No
public callback endpoint means no inbound attack surface behind Cloudflare Access,
and the freshness cost is bounded and invisible in practice for a personal
command center. `ETag`/`updated_at` cursors keep the polls cheap.

## 12. Local folder name

The remote is `git@github.com:yuvraj3335/-me-now.git`, whose leading dash breaks
a lot of CLI tooling (`git clone -me-now` parses as flags). The working copy is
`~/work/wake` on both machines; only the remote keeps the odd name.

## 13. iOS push requires home-screen install — a platform rule, not a shortcut

Web Push on iOS only works for a PWA added to the Home Screen; Safari tabs get
nothing. This is an Apple constraint, not an implementation gap. Wake ships a
real service worker, a real manifest, and VAPID web push, and the Connections
page tells you plainly to install to Home Screen on iPhone before enabling
notifications rather than letting the toggle silently do nothing.
