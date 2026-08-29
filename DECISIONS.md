# Decisions

Every non-obvious call made while building Wake, and every place I deliberately
did **not** do what the brief said. The brief asked to be treated as intent, not
gospel — this is where I disagree in writing.

---

## 1. The brief's first premise is wrong: there is no Slack MCP on the DevBox

> "Slack — the Slack MCP is already configured on the DevBox. Use it."

It is not. `claude mcp list` on `yuvraj-devbox` returns:

```
claude.ai Gmail           https://gmailmcp.googleapis.com/mcp/v1     ✔ Connected
claude.ai Google Drive    https://drivemcp.googleapis.com/mcp/v1     ✔ Connected
claude.ai Google Calendar https://calendarmcp.googleapis.com/mcp/v1  ✔ Connected
plugin:figma:figma        https://mcp.figma.com/mcp                  ! Needs auth
plugin:woz:code           (stdio)                                    ✔ Connected
playwright                (stdio)                                    ✔ Connected
```

No Slack. What *does* exist is a half-finished OAuth record in
`~/.claude/.credentials.json` under the key `slack|38801a7d845718b3`, pointing at
`https://mcp.slack.com/mcp` with an **empty** access token — someone started
`claude mcp login slack` on this box and never finished it. The Slack MCP you're
thinking of is configured in your **claude.ai account** (it shows up in Claude
Code sessions on your laptop), not on the DevBox.

This mattered enough to change the architecture, so it is decision #2.

## 2. Wake is a real MCP client, not a passenger on Claude Code's connections

The tempting shortcut was to have Wake piggyback on Claude Code's existing MCP
connections on the box. I rejected it. Look at how Claude actually reaches Gmail:

```
https://api.anthropic.com/v2/ccr-sessions/cse_01PpFjQczsTCKHmG9h8V8Fuc/mcp
  ?mcp_server_id=…&mcp_url=https%3A%2F%2Fgmailmcp.googleapis.com%2Fmcp%2Fv1
```

That is an **Anthropic session proxy**, scoped to a Claude Code session id. It is
not a stable integration point: it dies with the session, it is undocumented, and
it would make a 24/7 website depend on a chat client's login state. A command
center that goes dark because a CLI session expired is not a command center.

So Wake speaks MCP itself — `initialize` / `tools/list` / `tools/call` over
Streamable HTTP and stdio (`src/server/mcp/client.ts`), with its own OAuth 2.1 +
PKCE implementation (`src/server/mcp/oauth.ts`), including RFC 7591 dynamic client
registration where a server offers it.

Credentials resolve in a chain, best-available-wins (`src/server/mcp/creds.ts`):

1. Wake's own OAuth tokens (SQLite, auto-refreshed) — the durable path
2. Claude Code's `~/.claude/.credentials.json` `mcpOAuth` entry — the bridge, so
   `claude mcp login slack` on the box is enough to light Slack up with no Slack
   app of your own
3. A static token from the environment — the escape hatch

You get whichever is available without changing any code.

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
