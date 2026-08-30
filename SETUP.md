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
secret into Settings → Slack → Connect.

Slack MCP authorizes at `/oauth/v2_user/authorize`, which reads **`scope=`**,
not `user_scope`. Wake sends `scope` on that URL. Add the scopes below as
**User Token Scopes** on the app, then start Connect from Wake — do not use
Slack's own "Install to Workspace" with an empty bot-scope list.

The authorize URL asks for the grant below. Wake still only *calls* read
tools on ingest. Slack MCP does **not** honour classic `search:read` alone
— the granular `search:read.*` names are what expose the search tool.

```
canvases:read canvases:write
channels:history channels:read channels:write chat:write emoji:read files:read
groups:history groups:read groups:write
im:history im:read im:write
lists:read lists:write
mpim:history mpim:read mpim:write
reactions:read reactions:write
search:read search:read.files search:read.im search:read.mpim
search:read.private search:read.public search:read.users
team:read users:read users:read.email
```

`files:write` is not requested.

Also turn **Slack MCP Server** on at
`https://api.slack.com/apps/<APP_ID>/app-assistant`. Leave Agent experience
off. After a scope change, press **Reconnect** in Settings — do not
Disconnect; that wipes the client id.

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

`gmailmcp.googleapis.com` publishes no OAuth metadata. Wake still Connects:
it authorizes against Google's own OIDC document and asks for
`access_type=offline`, so the grant refreshes instead of dying every hour.

`claude mcp login gmail` does **not** request offline access. That token
lasts about an hour and Wake then correctly says it has nothing.

**The durable way — Settings → Gmail → Connect.** Add this redirect URI on
the Google OAuth client (the same app as project `285417044045`):

```
https://<your-wake>/api/connections/callback
```

Wake reuses the client id/secret already stored by `claude mcp login` if
they are on the box. If Connect asks for them, paste them once.

The hourly CLI login still works as a stopgap and is not how you should
run this.

The address in `WAKE_EMAILS` is the account Wake connects (`yuvraj@truto.one`
by default). Add a second, comma-separated address only if you actually own a
second inbox — `WAKE_EMAILS` is Wake's identity, not a place to list every
address that ever emailed you. Per-account tokens use the key
`gmail:<address>`; with one address configured, a single `WAKE_GMAIL_TOKEN`
covers it.

**What Wake pulls:** unread threads from the last two weeks, excluding
promotions and social. A thread with you in `To:` lands in Now; one you are
merely cc'd on lands in Open.

**And what the Mail page needs.** Cards only need a token; the Mail client needs
the same token *and* a server that offers the right tools. Wake asks it
(`tools/list`) rather than assuming, so if the connection can read but not send,
Send is disabled and Settings names the tools that were actually advertised. As
of this deployment Gmail is a claude.ai connector, so none of it is reachable and
Mail says exactly that — see `DECISIONS.md` #22.

## Notifications on your phone

Settings → *Turn on notifications*.

On **iPhone** you must add Wake to your Home Screen first — share sheet → *Add to
Home Screen*. Apple only delivers Web Push to an installed PWA; a Safari tab can
never receive it, no matter what the permission prompt says. Wake tells you this
in Settings rather than leaving a toggle that silently does nothing.

*Send a test* confirms the round trip and reports how many devices are
registered.

---

## Open in Claude

Nothing to connect, no key to add, and nothing installed. Wake packs the context
and hands you a link — `https://claude.ai/new?q=<the brief>` — which opens the
Claude app on a phone and a tab on a laptop, under the login you already have.

Two things shape what a brief can say:

1. **Repositories under `WAKE_WORKSPACE_ROOT`** (default `~/work`). A brief can
   only name a repository the registry scanned — that allowlist is what stops a
   template's directory field from becoming an arbitrary path in text a session
   will act on.
2. **The size cap** (`WAKE_HANDOFF_MAX_CHARS`, 12,000). The brief travels in a
   query string. A longer one is trimmed *and says so inside itself*, so the
   session asks rather than answering half a Slack thread confidently. The whole
   text is always on disk and one click away.

Briefs are written to `<data dir>/packs` as Markdown plus JSON, redacted, and are
readable from the result panel.

If Anthropic ever changes that URL shape, `WAKE_HANDOFF_URL` and
`WAKE_HANDOFF_PARAM` are the two knobs — a personal tool whose only hand-off is
hard-coded is one product change away from a dead button.

## Appearance

Light, dark, or whatever the device says — **Settings → Appearance**. "System" is
the default and is a real choice, not the absence of one: a phone that goes dark
at sunset takes Wake with it.

Every text-on-background pair clears WCAG AA in both themes, and the ratios are
written into `styles.css` next to the values so the next edit has something to
check against.

## Voice

Recording and live dictation are the browser's own APIs, so there is nothing to
connect and nothing leaves the machine. On Firefox there is no built-in speech
recognition, so dictation says so and recording still works.

Transcribing a *stored* note is the one part that needs a service, because
Anthropic has no transcription endpoint. Point `WAKE_STT_URL` at an
OpenAI-compatible `/audio/transcriptions` endpoint and set `WAKE_STT_KEY`.
Without it, notes are kept and playable and simply have no transcript — which is
the honest outcome, and better than a made-up one.

Recordings live in `<data dir>/voice`. They are counted in Settings → Voice, and
Settings will tell you if the index points at a file that is no longer there.
