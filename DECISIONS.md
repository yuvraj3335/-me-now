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

## 3. No model in the CARD data path — narrowed, and still enforced

This decision used to read "no Claude model anywhere", enforced structurally by
having no Anthropic dependency and no API key. Wake now has an agent, so that
sentence is no longer true and keeping it would be a lie by omission.

What survives is the half that was actually load-bearing: **nothing a model
produces can reach a card**. The ingest path, the reference extraction, the
union-find dedup and the pile rules are the same deterministic code they were,
and the agent's tables (`conversations`, `turns`, `turn_events`, `approvals`, …)
are disjoint from `cards` and `card_state`. No agent tool writes to them. So the
guarantee you actually rely on at 7am — that your Now pile is a rule firing and
not a generated sentence — is intact, and "why is this on me" is still answerable
by reading code.

**Updated again.** Wake now does carry the Anthropic SDK and a key — see #14 for
why the engine changed. The guarantee that survives is the same one, and it is
structural rather than promised: the agent's tables (`conversations`, `turns`,
`turn_events`, `approvals`, `agent_tool_calls`, `launch_packs`, …) are disjoint
from `cards` and `card_state`, and no tool in `src/server/agent/tools.ts` writes
to either. A test asserts no tool is shell-shaped; nothing asserts a model
cannot reach a card, because nothing gives it a way to try.

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

## 7. Writes are gated and audited, not impossible

This used to say Wake was read-only, enforced by a denylist in the MCP client
that refused any tool whose *name* looked like a mutation. That was the right
call for a read-only aggregator and the wrong shape for an operations console:
the whole point of the agent is to be able to fix something.

A name-matching denylist was also the wrong mechanism. It refuses
`accounts_update` and waves through `truto proxy -X DELETE`, because it reads
identifiers rather than intent.

What replaced it is a classifier over the actual command
(`src/server/truto/classify.ts`), with four tiers:

| Tier | Example | Treatment |
|---|---|---|
| read | `integrations list` | runs |
| provider read | `unified crm contacts` | runs, and is **disclosed** as reaching a live customer account |
| mutation | `integrations update` | blocks for approval |
| high-risk | `proxy -m delete`, `batch` | blocks for approval, marked as touching a third party |

Two properties matter more than the tiers:

- **Unknown fails closed.** An unrecognised command is a mutation. A classifier
  that guesses "probably a read" on something it has not seen is the one bug
  that would let an unreviewed write through.
- **The gate is in the code path, not the prompt.** `truto_apply` calls
  `requestApproval` and *blocks* — the model does not choose to ask. A model that
  decided to skip the question still cannot get past it.

Around the gate sits the sequence the brief asked for: preflight read, redacted
backup, diff, approval, staleness re-check against a fingerprint, apply once,
verification read, audit row. If the preflight fails, nothing is applied — that
path has been exercised against a real 404 and refused rather than proceeding.

**Outbound communication used to be impossible rather than gated. That changed
for mail, and only for mail.**

A console with an inbox that cannot reply is a reader, not a console. So Send
exists, and it is gated by something stronger than a prompt: a confirmation
token bound to a hash of the exact message — account, recipients, subject, body.
Edit the body after approving and the hash no longer matches, so the approval is
dead and a new one has to be granted against the new text. Tokens are
single-use, expire, and are checked in exactly one function (`security.ts`).

The read-only denylist in the MCP client stays, because the card ingest must
never write. Sending goes through `callWriteTool`, a door with a name on it, and
a test asserts exactly one module calls it. Writing that test is what found
`modify_message` — Gmail's own mutation for marking read and relabelling — sailing
through a denylist that only knew words like "send" and "delete".

Slack remains un-sendable: Wake requests no Slack write scope, so `slack_draft`
produces a draft and says so. Never "posted".

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

## 14. Two engines, and the reasons they are not one

> **Superseded by #26.** There is one engine now, and it is not Wake's: the
> in-app agent is gone and "Open in Claude" is a link. The reasoning below is
> kept because it was right about the thing that mattered — a chat and a
> launcher are different products — and wrong about the conclusion it drew from
> that, which was to build both.

**Reversed.** The first version drove the in-app chat with `claude -p`, on the
argument that authentication, caching and compaction came free. They do. But a
chat and a launcher are different products, and running both on one engine made
each one worse:

- **The chat needs a gate Wake owns.** A mutating tool has to *block* on a human,
  durably, resumably, mid-turn. Driving Claude Code as a subprocess meant that
  gate lived behind an MCP server Wake ran for itself, minting a per-turn token,
  answering JSON-RPC, and returning a `405` to a GET it had no use for — a lot of
  machinery whose only job was to let Wake wait on a click inside its own
  process. Owning the loop makes it a promise.
- **The launcher must be Claude Code, exactly.** The whole value of "open this in
  Claude Code" is that the session is real: it lands in `~/.claude/projects`, it
  has the repositories and the CLI, and `claude --resume <id>` in a terminal
  picks it up with full interactive permissions. Wrapping that in Wake's own
  loop would produce something that looked like Claude Code and was not.

So there are two, deliberately:

| | Wake Agent | Open in Claude Code |
|---|---|---|
| engine | `@anthropic-ai/sdk` | the `claude` binary on this machine |
| credential | a key Wake holds (Settings → Agent) | whatever `claude` is already signed in with |
| loop | Wake's, in `agent/engine.ts` | Claude Code's |
| gate | blocks inside the tool call | Claude Code's own permission model |
| can edit files | no | yes, under its own permissions |

`ANTHROPIC_API_KEY` is stripped from every child environment (`redact.ts`)
precisely so the two stay separate: Claude Code prefers an API key over its own
login when one is present, and leaving Wake's key in the environment would move
every launched session onto Wake's billing without anyone deciding that.

The launcher mints the session id itself and passes `--session-id`, so the
resume command shown in the UI is the id that was used rather than one scraped
out of a log line that may never arrive. Verified end to end: pack → launch →
transcript on disk at that id → `claude --resume <id>` answers.

Two things had to be discovered by running rather than by reading:

- **Claude Code's login is not always a file.** On Linux it is
  `~/.claude/.credentials.json`; on macOS it is the login keychain. The first
  version of the availability check read only the file and therefore declared
  every Mac signed out. It now probes the keychain for the item's *existence*
  (`find-generic-password` without `-w`, which does not prompt and returns no
  secret) and reports "cannot tell" rather than "no" when it genuinely cannot.
- **`--permission-prompt-tool` does not exist in this version (2.1.233)**, which
  is another reason the chat's gate had to be Wake's own.

## 15. The agent gets no shell — and no MCP server is needed to say so

Wake used to run its own MCP server at `/mcp/<token>` so the Claude Code
subprocess could call back into it. With the chat on the SDK (#14) that server
had no consumer, so it is deleted rather than left as a token-minting endpoint
nothing uses.

The tool surface is typed and enumerable (`src/server/agent/tools.ts`). There is
no `bash` tool, no editor, and every Truto invocation is an argument array handed
to `Bun.spawn` — no shell, no interpolation — so a customer name with a semicolon
in it is an argument rather than a second command. Tests assert it: no tool is
named anything shell-shaped, no file in `src/server` spawns a shell or
interpolates a command string, and every tool is reachable from some mode. That
last one is how two dead tools were found the first time round — `truto_apply`
and `slack_thread` both existed, looked implemented, and could never be called.

Work that genuinely needs an editor does not get one here. It gets packed and
handed to Claude Code, which has one and applies its own permissions to it.

## 16. Modes change the tool surface, not a label

Nine modes, each with an allowlist of Wake's own tools. The second allowlist —
Claude Code's built-ins — is gone with the subprocess: there is no `Edit`,
`Write` or `Bash` in any mode now, in any configuration. `engineering` is the
mode that scopes a change and hands it to a session; it is not a mode that
edits.

`triage` is read-only and cannot reach a mutating tool even with an approval,
and it cannot draft outbound mail either. The allowlist is checked at call time,
not only when the list is built, because a model that remembers a tool name from
an earlier turn in another mode would otherwise still be able to call it.

## 17. Skills are indexed by metadata and loaded one at a time

The corpus is 28 skills across three catalogs and far more Markdown than belongs
in any prompt. Startup indexes `id / name / whenToUse / path` only; a body is
read when a turn needs it.

Routing lives in code (`src/server/skills/route.ts`) rather than in a system
prompt, because the brief's rules are mandatory and a prompt can be ignored:
CLI work always loads `truto-cli-toolbelt` first, anything that could mutate also
loads `truto-safe-admin-operator`, a `*Service.ts` change forces
`ginger-migration-guardrails`, and an API-contract change forces
`platform-change-checklist`. Each rule has a test that fails if it is edited out.

Which skills were chosen, and the rule that chose them, are shown in the UI and
persisted per turn — "why is it doing this" should be answerable from the screen.

## 18. Turns are durable; the browser is a viewer

Every visible thing a turn does is written to `turn_events` with a gap-free
per-turn `seq` before it reaches a browser, and the SSE endpoint is a cursor over
that table. One code path serves a fresh connection, a reconnect after a dropped
network, and a phone that slept through half a turn — all of them `?after=<seq>`.

A turn that ends without a result event is recorded as an **error**, not as done.
The first version defaulted to done, which meant a killed process reported
success — the exact false-success this system exists to prevent.

## 19. Worktrees are resolved from git, not from a list of names

The brief listed eleven worktrees by name. Names drift. A linked worktree's
`.git` is a file reading `gitdir: <canonical>/.git/worktrees/<name>`, so the
upstream repository is a fact to read rather than a convention to maintain. All
ten present worktrees resolve correctly, and the registry refuses to let one pass
itself off as a separate product.

The registry also carries a curated topic list per repository, because README
first lines are written for someone who already knows the product: nothing in
truto's README says "salesforce" or "sync job", and a customer report says little
else.

## 20. An unavailable connector says so

Platform MCP and truto-monitoring MCP are consumed, not reimplemented — they
already own the OpenAPI catalog and the monitoring entities respectively, and a
second copy would diverge. When either is unconfigured, the tool returns
`available: false` with the reason, and the system prompt names the gap
explicitly. Describing what a connector *would* have returned is worse than
saying it is down.

## 21. Mail is a client, not a card feed

Cards already showed unread mail. That is the right shape for "is someone
waiting on me" and the wrong shape for "answer this", so Mail is a real client
beside the piles rather than a filter over them: boxes, labels, search,
per-account pagination, threads, sanitized bodies, compose, reply, reply-all,
forward, drafts, send.

Three calls inside it worth naming:

- **Plain text is preferred; HTML is a fallback.** Email HTML is the most
  hostile input this app handles, so it is sanitized to a short allowlist on the
  way *into* the database (`mail/sanitize.ts`) rather than on the way out —
  scripts, styles, frames and every event handler are gone before anything is
  stored, and the rendered subset can only be tags on that list.
- **Remote images do not load until asked.** A tracking pixel reports that you
  opened the mail and roughly from where. The original source is kept in a data
  attribute so "load images" is one click and not a refetch.
- **Pagination is per account.** Two inboxes advance independently, and one
  shared cursor silently drops the slower one's older mail.

Attachments are listed as metadata and never downloaded. Wake has no reason to
hold a copy of a customer's PDF.

## 22. Gmail is not connected on this deployment, and the product says so

The DevBox reaches Gmail through a **claude.ai connector**, and all 23 `mcpOAuth`
entries on that box have an empty `accessToken` (#2). So Wake cannot read that
mailbox, and no amount of adapter code changes it.

Mail therefore ships complete and shows the real reason, with the exact fix —
add Gmail as a directly-added HTTP server, or set `WAKE_GMAIL_TOKEN`. The
alternative was a demo inbox, which is worse than an empty one: it teaches you
to trust a screen that is not reading your mail.

The same rule runs deeper than the empty state. `probeMail` asks the server what
tools it actually offers and matches by shape, so a connection that can read but
not send disables Send and says which tools were advertised — rather than failing
at the moment someone presses it.

## 23. Voice keeps the recording, whatever else fails

Three separate things, deliberately not one feature:

- **Instruct** — live dictation into a field, using the browser's own recogniser.
  It exists in Chrome and Safari and does not exist in Firefox, so where it is
  missing the button says so instead of sitting there inert.
- **Voice notes** — recorded with `MediaRecorder`, written to disk under the data
  directory, indexed in SQLite. The file is written *before* anything is
  transcribed, which is the whole design: a note with no transcript is a note, a
  note with an invented transcript is something you act on wrongly later.
- **Listen** — playback with a real scrub bar, served with HTTP range support so
  seeking works rather than restarting.

Nothing here sends. A transcript lands in a field and a human still presses the
button; a test reads the source and fails if a dictation handler ever gains the
power to submit, launch or send.

Anthropic has no transcription endpoint, so transcribing a *stored* note needs a
service Wake does not bundle. Unset, it says so.

## 24. Cloudflare Access proves who; it does not prove which page

Access is the front door and it is not enough on its own. Its cookie rides along
on a cross-site form post from any tab the same browser has open, so every
state-changing request is checked against `Sec-Fetch-Site` and `Origin`
(`security.ts`). Reads are untouched; the OAuth callback is the single exemption,
because an identity provider redirecting to it has no same-origin referrer by
construction.

The audit trail is a **separate table** from the analytics log. `events` is
written by the card pipeline on every poll and drives Pulse; `audit_events`
records what this system did to the outside world and who asked. Mixing them
makes both unreadable, and lets a retention policy written for one quietly
delete the other.

## 25. Schema changes are numbered migrations

The boot block was one `CREATE IF NOT EXISTS` script, which is fine until a
change is not idempotent — an `ALTER`, a backfill, a `DROP`. Everything new goes
through a numbered, recorded, single-transaction migration
(`schema_migrations`), because a half-applied schema is worse than an unapplied
one: the next boot skips the half it believes ran.

The existing tables stayed under their existing names. Renaming `conversations`
to `agent_conversations` would have been churn against a live database for no
gain — they are already namespaced by the section they live in.

---

## 26. No agent, and the hand-off is a link

**Reverses #14 and most of #3, #15–#18.** Wake had a chat of its own: nine
modes, a typed tool surface, durable turns, blocking approvals, and an Anthropic
API key it held in SQLite. All of it is gone.

Two reasons, and the second one is the real one.

**A personal command center should not ask you for an API key.** Wake exists so
that at 7am one screen tells you what is on you. A second credential to obtain,
paste, rotate and pay for is friction placed between a person and their own
inbox, and every one of those turns is billed to a key that sits on a DevBox.

**The launcher was a session in name only.** `launchPack` spawned
`claude -p <brief> --output-format stream-json` on the box. That process had no
terminal, so its permission prompts had no one to answer them; its output went
to a supervisor that scraped a result event and threw the rest away; and the
`claude --resume <id>` it handed back only helped if you were about to SSH in.
On a phone — which is where this app is actually read — it did nothing you could
see. #14 argued the launcher had to be Claude Code *exactly* because the session
must be real. That was right, and spawning a headless subprocess was not how you
get one.

What replaced it is one URL:

```
https://claude.ai/new?q=<the packed brief>
```

- On a laptop it opens a tab. On a phone it is a universal link, so it opens the
  Claude app.
- It is authenticated because *you* are. Wake holds no credential for it, sends
  none, and cannot see the conversation.
- Nothing runs on the DevBox, so there is no process to supervise, no pid to
  record, and nothing for a restart to orphan. `recoverPacks` is gone because
  there is nothing left to recover.

The packing is untouched, because packing was always the valuable half: the
template, the repository, the named skills, and every Slack thread and Sentry
issue quoted inside a fence that says it is data. That is the part a person
cannot be bothered to do by hand, and it is the part that survives.

**What is honestly worse.** The brief travels in a query string, so it is capped
— 12,000 characters, which holds a real thread but not a huge one. Rather than
truncate silently, a trimmed brief carries a line saying how much was cut and
telling the session to ask before assuming anything is missing; the whole text
stays on disk and is one click away. Silent truncation was the alternative and it
is much worse: a session that receives half a thread and no indication of it
answers the wrong question with confidence.

**What survived the deletion, and why.** Redaction, CLI classification and the
untrusted-content fence are all still here (`redact.ts`, `truto/classify.ts`,
`untrusted.ts`). None of them were ever about the agent. Wake still shells out to
the Truto CLI, still writes text to disk and into a URL, and still quotes
strangers — so not leaking a token, and not handing an instruction to something
that will act on it, are exactly as load-bearing as they were.

## 27. Light mode, and a contrast floor that is checked rather than felt

Wake was dark-only, and its muted text was `#5c5c66` on `#0a0a0c` — **3.0:1**.
WCAG AA wants 4.5:1 for body text. That token carries most of the meaning on this
app: every timestamp, every "why this is on you", every source badge, at 11 to
12.5px. It was not a matter of taste; it was under the floor.

Both palettes now clear AA against their own ground, and the numbers are written
into `styles.css` beside the values so the next edit has something to check
rather than an opinion. Muted text went 3.0 → 5.8 in dark and is 4.9 in light.

Three states, not a switch: an explicit choice stamps `data-theme` on `<html>`,
and *no attribute* means follow the system — which is why the
`prefers-color-scheme` block is guarded with `:not([data-theme])`. Without that
guard, choosing light on a machine set to dark loses the argument every time.

The accent is two tokens, which looks like over-engineering and is not. `#e9a23b`
as **text** on white is 2.0:1, so light mode needs a darker amber; but darkening
the **surface** turns the primary button brown. So `accent` is the surface amber
(bright in both, dark ink on top) and `accent-ink` is the text one. A test
asserts every token exists in all three blocks, because a colour added to one and
forgotten in another does not error — it silently inherits the other theme's
value, which is how a light page ends up with one black card on it.

The first paint is set by an inline script in `index.html`, before the
stylesheet. Applying the theme from React means one frame of the wrong palette on
every cold load: a white flash on a phone opened at 7am, which is the one moment
this app exists for.

## 28. CI on GitHub, CD on the box — because the box has no inbound door

"Redeploy when main moves" has an obvious shape — a GitHub Action that SSHes in —
and it does not work here. The DevBox sits behind a Cloudflare tunnel with Access
in front of it and accepts no inbound connections. Making it work would mean a
service token, an SSH key in GitHub secrets, and a new hole in the one thing
protecting a box that holds live customer credentials.

So the halves are split:

- **CI runs on GitHub** (`.github/workflows/ci.yml`): typecheck, tests, build, on
  every push and PR.
- **CD runs on the box** (`deploy/wake-deploy.timer`): a `oneshot` unit every
  minute that does nothing unless `origin/main` has moved. When it has, it backs
  up the database, fast-forwards, and runs the *same three checks* before
  restarting.

Pull-based deployment needs no secrets, opens no ports, and survives the tunnel
being down. The verification is deliberately duplicated rather than trusted from
CI: what matters is that the code works on the machine it will run on, with that
machine's Bun and that machine's database.

Two refusals are deliberate. It is `git merge --ff-only`, so a diverged checkout
stops the deploy instead of silently discarding an edit someone made on the box.
And the restart is last, so a failing build leaves the previous `dist/` in place
and the service untouched — a bad push costs a red log line rather than a dark
screen on someone's phone.

## 29. The brief is a draft, and the draft was bad

Wake renders the brief; **you** approve it. The review step is an editable field,
not a preview — dictation included, because a sentence of context is exactly the
thing you think of on the way to the button.

The link is built in the browser from what is in that field, using the same
`handoffFor` the server runs (`src/shared/handoff.ts`). One implementation, not
two: the alternative drifts, and the failure mode is the worst kind — the editor
says it all fits and the link quietly carries less. It also keeps the Open control
a real `<a>` with a live `href`, which is what hands a universal link to the
Claude app on a phone.

Whatever is in the field at the moment you tap becomes the record: the row, the
file on disk, and the link. A stored copy of the draft Wake happened to render
first is not an audit trail.

### Why it needed a rewrite

A real brief came back like this, and every fault is visible at once:

```
# fix(mfa): make the login MFA token purpose-strict so 2FA cannot be...
Packed by Wake at … · template `blank` · cwd `/home/yuvraj/work`
## Instruction
Every identifier you need is in the context below — …
## Context
### 1. Wake card — fix(mfa): …
- ref: `subject:fix(mfa): make the login mfa token purpose-strict…`
> The block below is quoted from an external system.
```text
you were just working on this
# fix(mfa): … Packed by Wake at … template `blank` … ## Instruction Solve this...
Claude Code: fix(mfa): …
Claude Code: fix(mfa): …
```
```

No skills. The workspace root instead of the repository. A generic instruction.
A UI label quoted as evidence. The title restated three times. And, worst, an
entire earlier Wake brief nested inside the quote.

All of it came from one line:

```js
[c.why, c.excerpt, ...c.sources.map(s => `${LABEL[s.source]}: ${s.title}`)].join('\n')
```

Five separate faults, now five separate fixes (`web/lib/cardContext.ts`):

1. **`why` is a UI label**, not evidence. "you were just working on this" is what
   the card says to *you*; it belongs on the entry as `why it is here`, not in
   the quoted block.
2. **The source titles were the card's own title**, repeated once per source.
3. **The excerpt of a Claude Code session is that session's last prompt** — and
   when the session was started from Wake, that prompt *is* a Wake brief. So the
   brief nested inside itself, carrying a stale title and no facts.
   `stripNestedBrief` cuts on the header Wake writes, which is a marker Wake
   controls rather than a heuristic, and says plainly that it removed something.
4. **A card seen in three places collapsed into one blob** — wasting the entire
   point of the dedup engine. It is now one context entry per source.
5. **Everything a source knew was thrown away**: the channel, the PR number, the
   Sentry project, the session's working directory. Those are stated as facts a
   session can act on rather than buried in prose. The session's own `cwd` is why
   a brief no longer says `/home/yuvraj/work` about work in `truto`.

Two more, from the same output. Template inference had no `claude` branch, so a
session card fell through to `blank` — and `blank` names no skills, which is why
the brief arrived with none. And skills are chosen in the composer now rather
than fixed by the template, because a blank brief about a sync job still wants
the sync-job validator. The catalog prefix is stripped when they are written out:
`B/` is Wake's own index talking, and a session has never heard of it.
