# Connecting the sources

Two sources work with no setup at all. The other three need one authorization
each, and there are two ways to do every one of them — pick whichever is less
annoying.

## Already working

| Source | Why it needs nothing |
|---|---|
| **GitHub** | Uses the token `gh` already holds on the box (`gh auth token`). Scopes needed: `repo`, `read:org` — both already granted. |
| **Claude Code** | Reads `~/.claude/projects/**/*.jsonl` directly. Metadata only: title, project, last activity, and any PR the session opened. Nothing leaves the machine. |

Laptop sessions are deliberately **not** synced, and Cursor and the Claude chat
app are deliberately excluded.

## How Wake finds a token

Every source resolves credentials the same way, best-available-wins:

1. **Wake's own OAuth store** — Settings → Connect. Durable, auto-refreshing.
2. **Claude Code's token store** — `~/.claude/.credentials.json`. Whatever
   `claude mcp login <name>` put there is picked up automatically.
3. **The environment** — `WAKE_SLACK_TOKEN`, `WAKE_SENTRY_TOKEN`, …

So you never have to care which route you took. Settings shows which one
answered.

---

## Slack

**The quick way — no Slack app needed.** Claude Code ships a registered Slack
client, so borrowing its login is the shortest path. On the DevBox:

```bash
ssh -L 3118:localhost:3118 yuvraj-devbox
```

The port-forward matters: `claude mcp login` redirects to
`localhost:3118/callback`, and on a headless box that callback has to reach the
browser on your laptop. Then, inside that session:

```bash
claude mcp add --transport http slack https://mcp.slack.com/mcp && claude mcp login slack
```

Wake picks the token up on its next poll — nothing to restart.

> **This must be a directly-added HTTP server, not a claude.ai connector**, and
> the distinction is easy to get wrong because both show up as "Connected" in
> `claude mcp list`. Connector tokens live in your claude.ai account and are
> never written to disk — all 23 `mcpOAuth` entries on this box have an empty
> `accessToken` — so Wake has nothing to read. A directly-added server does its
> OAuth locally and stores a real Slack bearer token. Once added, leave it: if
> you remove the direct entry and keep only the connector, Wake goes dark again.

**The durable way — your own Slack app.** Slack publishes no dynamic client
registration, so Wake needs an app's credentials. Create one at
<https://api.slack.com/apps>, add the redirect URL that Settings shows you
(`https://<your-wake>/api/connections/callback`), then paste the client id and
secret into Settings → Slack → Connect. Requested scopes are read-only:

```
channels:history channels:read groups:history groups:read
im:history mpim:history mpim:read users:read search:read team:read
```

**What Wake pulls:** DMs and messages addressed to you (`to:me`), explicit
`@`-mentions, and anything that reads like an ask — a question, "can you", "any
update", "blocked", "PTAL". That last one is a rule, not a model, and the card
tells you which rule fired. Threads are read on demand when you open a card, not
on every poll.

## Sentry

Sentry's MCP supports dynamic client registration, so **Settings → Sentry →
Connect is all it takes** — Wake registers itself, no app and no CLI. Verified:
it self-registered as `client_id: _aYRoHwcPeWDVo-v` with a correct PKCE
authorize URL. Or the same CLI route:

```bash
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp && claude mcp login sentry
```

**What Wake pulls:** unresolved issues assigned to you (Now) and issues waiting
for review (Open).

## Gmail

Gmail is the awkward one, and worth knowing why: `gmailmcp.googleapis.com`
publishes **no** OAuth discovery metadata — both well-known endpoints 404 —
because Google expects the client to arrive already holding a Google token. So
there is no self-serve button for it.

Try the CLI route first:

```bash
claude mcp add --transport http gmail https://gmailmcp.googleapis.com/mcp/v1 && claude mcp login gmail
```

If that succeeds, Wake picks the token up through chain step 2 and Gmail lights
up on the next poll.

If it does not, put a Google OAuth access token with `gmail.readonly` in the
environment instead:

```bash
# in ~/work/wake/.env
WAKE_GMAIL_TOKEN=ya29....
```

Both `yuvraj@redroot.one` and `engineering@redroot.one` are configured as
separate accounts (`WAKE_EMAILS`). Per-account tokens use the key
`gmail:<address>`; a single `WAKE_GMAIL_TOKEN` covers whichever inbox it belongs
to, so one working inbox does not have to wait for the second.

**What Wake pulls:** unread threads from the last two weeks, excluding
promotions and social. A thread with you in `To:` lands in Now; one you are
merely cc'd on lands in Open.

## Notifications on your phone

Settings → *Turn on notifications*.

On **iPhone** you must add Wake to your Home Screen first — share sheet → *Add to
Home Screen*. Apple only delivers Web Push to an installed PWA; a Safari tab can
never receive it, no matter what the permission prompt says. Wake tells you this
in Settings rather than leaving a toggle that silently does nothing.

*Send a test* confirms the round trip and reports how many devices are
registered.
