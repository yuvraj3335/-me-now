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

The adapter is multi-account from the start rather than retrofitted, so a second
address costs configuration rather than code. On this deployment there is exactly
one: `yuvraj@truto.one`. Multi-account is a capability the code keeps, not a
claim about whose mail this is.

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
- **Pagination is per account.** Accounts advance independently, and one shared
  cursor would silently drop the slower one's older mail. This deployment has a
  single account, `yuvraj@truto.one`; the per-account cursor is what keeps a
  second one from being a rewrite.

Attachments are listed as metadata and never downloaded. Wake has no reason to
hold a copy of a customer's PDF.

## 22. Gmail is not connected on this deployment, and the product says so

The DevBox reaches Gmail through a **claude.ai connector**, and all 23 `mcpOAuth`
entries on that box have an empty `accessToken` (#2). So Wake cannot read
`yuvraj@truto.one`, and no amount of adapter code changes it.

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

## 30. Four answers to a production QA pass

A read-only QA pass against `yuvraj-wake.truto.dev` produced eleven findings.
Nine were straightforward. These four were decisions.

### An animation that never runs is a bug, not a missing flourish

The pass reported a modal whose primary button sat 438px below a 720px fold with
nothing able to scroll to it, and a card that stayed on the list after Done
while the count beside it had already dropped. Both were one cause: the tab was
not being painted, so no animation frame ever arrived. `Sheet` applied
`y: '100%'` and never got the frame that would take it back to zero; `Card`'s
`exit` never completed, and `AnimatePresence` holds a removed child until it
does.

This is the failure `?static` was added for and the one the route transition in
`App.tsx` already refuses to have — but both of those are opt-in, and neither
helps a reader whose tab went to the background. So `useStill()` now folds in
`document.hidden` alongside reduced motion and the static flag, and a contract
test in `test/ui-contract.test.ts` requires every `initial=` and `exit=` in
`src/web` to be gated on it. Two more instances turned up the moment the test
existed: the command palette, which would have stayed on screen after Escape,
and Work's "show done" collapse.

The rule is not "animate less". It is that the end state has to be reachable
without an animation, because sometimes there isn't one.

### A source nobody connected is a third state

`lastSync` recorded Slack as `ok: 1, count: 0` — a poll that ran, succeeded and
found nothing — for a Slack that had no token at all, because `fetch()` answered
a missing credential with `[]`. The Home page dutifully rendered "Slack now".

Adapters now throw `NotConnected` instead, and a run records `connected`
alongside `ok`. That splits one boolean into the three states a reader actually
has: not connected, connected but the last poll failed, and synced. The middle
one is the one that was missing in both directions — Gmail spent the QA window
genuinely connected with every mailbox request failing, and the Home page said
"Gmail needs connect" while Settings showed it in the same green as a healthy
GitHub.

A consequence worth naming: a disconnected source now keeps its stored cards
rather than having them marked gone, because that is what the ingest already
does for a source that failed. Losing your Slack cards because a token expired
overnight was never the intent.

### A truncated title is still a title

A session titled from its own first prompt is cut at 72 characters and keeps the
ellipsis, so Wake never shows a clipped title as a whole one. The cost was a
missed merge: PR #2034 and the Claude session opened for it carried
`subject:…so 2fa cannot be bypassed` and `subject:…so 2fa cannot be…`, which
share no reference, so the same work occupied two rows of a count whose whole
job is to say how much is open.

`groupCards` now links an elided subject to the full one it is an opening of.
Not by canonicalising every subject to its first N characters — that is exactly
the fuzzy merge decision #4 exists to refuse, and it would collapse
"pick permissions when minting a token" into "…when revoking a token". Only a
subject that was *actually* cut participates, only against a prefix of at least
32 characters, and only when the candidates are mutually consistent: if two
different titles both start with the prefix, nothing merges. Ambiguity leaves
two honest cards.

### Done gets an undo, not a confirmation

`e` marks a card done with no modifier and no dialog, and there was no way back:
the sheet is unreachable once a card is off every pile, a re-sync does not lift
the suppression, and `POST /cards/:group/restore` existed but nothing linked to
it. The QA pass lost a card to its own script and could not return it.

The fix is not a confirm step. Done is the action taken fifty times a day and it
should stay one key; what it needed was to be reversible. So: an undo bar for
the few seconds it is likely to be wanted, and `GET /cards/done` behind a
"Done and not mine" palette command for everything after that. Restores are
logged, like every other state change.

The undo and the restore are deliberately not the same operation. `restore` with
no body clears everything keeping a card off a list, which is what "bring this
back" means when you have picked it out of a list of things you hid. The undo
bar passes `{ undo: 'done' }` and clears only that, because undoing a Done must
not also un-park a card that was parked before it, or discard a pile someone
chose an hour ago. An undo that does more than the thing it undid is its own
small surprise.

## 31. Fetch borrows the box's reach, and reopens one sentence of #26

**Partially reverses #26.** Wake now starts a process that can reach a model:
one bounded, read-only, allowlisted collection per press of a control called
Fetch. Nothing else about #26 changes — Wake still holds no API key, still runs
no model in-process, and "Open in Claude" is still a link.

### Why it had to be reopened

`now: 0` on this deployment is not an empty desk, it is a broken pipe. Measured
on 2026-08-30:

```
slack   ok:false hasWakeToken:true  400 "App is not enabled for Slack MCP server access"
gmail   ok:false connected:0        needsClientId — Google publishes no OAuth metadata
sentry  ok:true  count:0            both queries failing silently on a missing argument
github  ok:true  count:4            every row is `is:pr author:me`
claude  ok:true  count:22           sessions nobody is waiting on
```

Two of the three sources that put something in the Now pile were dark, and the
third had never worked. Slack's token is real and was accepted; the *app* is not
entitled, which is a toggle in somebody else's console. Gmail's credential is one
Wake cannot obtain at all. So the page rendered the word "Nothing" in a calm grey
and was wrong — and no amount of alignment work fixes that, because the problem
was never the type scale.

The credential that reaches Slack in that state exists. It is on the box: the
operator has signed this machine into claude.ai's Slack, Gmail and Sentry
connectors, and `claude mcp list` says **Connected** for all three. Wake does not
need those tokens. It needs one read through them.

### Why the old reasoning does not cover this

#26 struck down `launchPack`, which spawned `claude -p <brief>` to *start a
working session* on the box. The argument was that a headless process has no
terminal, so its permission prompts have nobody to answer them, its output goes
to a supervisor that throws most of it away, and on a phone it does nothing you
can see. Every clause of that is about an **interactive session**.

Fetch is not one. It is a collection with a fixed question, a fixed output shape,
no writes, and nothing to approve. There is no prompt to answer because there is
nothing it can do that would need approving.

### What bounds it, structurally

In `src/server/fetch/claude.ts`, which is the only file under `src/server` that
names the binary or spawns it:

* `--print` — non-interactive by construction.
* `--allowed-tools` with an explicit read-only allowlist, by real tool name. Not
  a server-wide grant (`mcp__claude_ai_Slack` would include the write tools) and
  not a wildcard. `list_labels` was removed from it rather than exempted from the
  check, because a narrower list is a better answer than a cleverer test.
* `--max-turns 6` and a 150-second wall clock that kills the process.
* argv as an array, prompt over stdin: no shell parses either.
* One shot. No `--resume`, no `--continue`, no session id, no transcript.
* The question is a constant. `promptFor(name: Connector)` takes nothing else,
  and `POST /api/fetch` reads no request body — there is no path from anything a
  person can type to that string.

And the model's prose never reaches a pixel. The only thing read out of the
envelope is a JSON array of objects with a fixed shape; anything else is dropped
silently. `why` is not in that shape: the collector returns *evidence* — a quoted
line — and Wake's own rule table turns evidence into `why`, which is the half of
#3 that was ever load-bearing. `refs` is not in that shape either, because a
fabricated `gh:` reference outranks every other reference type and would decide a
group's visible key.

### The test was amended, not deleted

`test/ui-contract.test.ts` asserted that no file under `src/server` contained
`CLAUDE_BIN` or spawned `claude`. It now asserts the invariant that ban was
standing in for: exactly one spawn site, `--print`, a turn ceiling, a wall clock
that kills, an allowlist with no write-shaped name in it, no wildcard, and no
resume flag. Two tests, both named, both with the reason in the body. Deleting it
would have made this the fourth silent reversal in this file.

### What is honestly worse

**It costs money and it is slow.** Measured on the box: one Slack collection was
55 seconds and $0.44 — not the "single-digit seconds, well under a cent" the plan
assumed. Two connectors go through the box on this deployment, so a press is
roughly a dollar and up to a minute. That is why Fetch is a manual control and
never a timer, why it blocks nothing while it runs, and why the sync mark says
what landed rather than a spinner saying please wait.

**It depends on somebody else's tool names.** `mcp__claude_ai_Slack__…` is not a
published contract. If a name changes, that connector returns nothing and reports
"asked, did not answer" — which is a state Fetch renders rather than hides, and
is the correct failure.

**Two pipes are two things to reason about.** The mitigation is that they land
through the same door: `groupCards`, the same `card_state` suppression, the same
undo. The one place they are not symmetric is the sweep — `ingest.ts` marks gone
every card of a healthy source it did not return, and Fetch asks questions the
poller never asks, so `found_by` scopes that sweep to the pipe that owns the
sighting. Without that single condition, every Fetch row is deleted within three
minutes and the feature looks like it does nothing.

### Two bugs this uncovered on the way

Closing the "credential present and failing" hole in the four adapters made two
silent failures visible immediately, and both are fixed here:

* **Sentry had never worked.** `search_issues` requires `organizationSlug`, Wake
  never sent it, and a bare `catch { continue }` turned
  `Invalid arguments … organizationSlug: Invalid input` into a green,
  up-to-the-second sync of zero issues. The slug is now discovered through
  `find_organizations`. The tool also answers in *Markdown*, not JSON, so even
  with the slug not one issue would have landed; there is a parser now, written
  against the real response, the same way Slack's was.
* **A swallowed failure deleted the desk.** Every adapter dropped its rejections
  and reported `ok, 0 rows`, and the sweep then marked every card of that source
  gone. Rate-limiting GitHub's four searches would have wiped the desk and
  reported "synced". A partial poll now keeps its rows and loses its authority.

## 32. A card has a status, and it is stored

**Partially reverses #9.** Piles are computed, never filed — that was the rule,
and most of it still holds. What broke it is that "done" and "not mine" were
already filed, as two timestamps pretending to be a classification, and the
product had no way at all to say *in progress* or *in review*. A desk where the
only two things you can assert about a piece of work are "gone" and "not gone"
is a desk that makes you keep the middle in your head.

`card_state` now carries `status`, one of five values: `not_started`,
`in_progress`, `in_review`, `done`, `wont_do`.

### What survives from #9

The pile is still computed, from the snooze, the manual override and the
adapter's own claim. It is not a folder and it is not a status. The two are
orthogonal, and deliberately so: **there is no `parked` status**, because a park
is a statement about *when he wants to see it*, not about whether the work has
begun. "In progress, and parked until Monday" is the normal state of half the
desk, and one column could not have held both facts.

### What changes

Whether something is finished or disowned is `card_state.status`. `done_at` and
`not_mine` survive as derived values, written by the same code path that writes
the status and never independently — `done_at` for the hidden-list sort and for
undo records written before this shipped, `not_mine` because `pile()` still
reads it. They are maintained, not trusted. The intent is to drop both once no
stored `undo_json` predates migration 9.

### The back-fill, and what it refuses to guess

`done_at IS NOT NULL` became `done`. `not_mine = 1` became `wont_do`. A park
kept its park and its snooze moved to `due_at`, because a park always was a
snooze with a wake time. Everything else became `not_started`.

`acked_at` was left implying nothing, and that was the one real decision in the
migration. An ack suppressed a notification; it never claimed the work had
begun. Reading it as `in_progress` would have been the system asserting, about
most of the desk, something only he can assert — and `in_progress` and
`in_review` are worth having precisely because they are his claims. They start
empty. The read path agrees: `statusOf` in `src/server/api.ts` derives a status
from `done_at` and `not_mine` when a group has no state row at all, and does not
consult `acked_at` there either.

### Why the old events are still emitted

`POST /cards/:group/status` still logs `card_done`, `card_not_mine` and
`card_acked` alongside the new `card_status`. Pulse is built out of events, not
columns — the Cleared chart, both response-time percentiles, both heatmaps and
the streak are all counts of those three kinds. A status column is a snapshot
and a snapshot is not a history. Dropping the events would have emptied five
charts silently, with nothing failing.

---

## 33. Priority is an integer, and normal renders nothing

`0` urgent, `1` high, `2` normal, `3` low. Named once, in
`src/server/sources/types.ts` and `src/web/lib/types.ts`, so it cannot become
three lookup tables that disagree about whether high is 1 or 3.

A card starts at `2`, and **a card at `2` draws no mark at all**. Not a grey
chip, not a dash. Almost every row is normal, so a glyph there is a column the
eye has to skip on every line to find the two rows that matter — which is the
opposite of what a priority is for. Only `0` and `1` get a mark.

Priority is also the one field an undo will not touch. `undo_json` snapshots
every field an undoable action replaced, and no undoable action writes priority,
so including it would only give Undo a way to clobber a value the action it is
undoing never saw.

---

## 34. The alert channels are read, not searched

Wake was blind to bot traffic: `slack_search_messages` does not reliably surface
app posts, and the three channels that carry production alerts are almost
entirely app posts. They are read directly with `slack_read_channel` now, and
the tool's shape drove several choices that look arbitrary and are not.

* **`include_bots` goes to search and never to the channel read.** It is not in
  that tool's schema; channel history is bot-inclusive by construction.
* **`oldest` and `latest` are always sent together.** With `oldest` alone the
  server anchors to the *oldest* end of the range and returns founding join
  messages from the day the channel was created. This is the most dangerous
  behaviour in the tool, because the result looks like data.
* **`response_format` is `detailed`.** `concise` discards attachments, and for
  Datadog and Alertmanager the attachment *is* the message.
* **Only `#sentry-alerts` emits a subteam token**, so `paged` is a fact about
  that channel and is false elsewhere rather than unknown.
* **`#intent-alerts` is not on the list.** Its newest message is fourteen months
  old and it is marketing intent, not production. A dead channel in the list
  sits in `settle`'s denominator, where one failed read can mark the whole Slack
  poll not-ok for nothing.
* **A recovery emits no card.** `Recovered:` and the green-tick digests are the
  end of an incident, and a desk that fills up with things that have stopped
  being true is a desk nobody reads.

A Sentry alert in Slack and the same issue from the Sentry API are one row,
keyed on the short id (`TRUTO-38`), because they are one thing.

---

## 35. The hand-off still opens a new conversation

**Confirms #26 after re-checking it.** The session picker lists real Claude Code
transcripts, and it would be natural to assume that picking one resumes it.
It does not, and cannot:

* `claude.ai/new?q=` opens a *new* conversation. There is no documented URL that
  targets an existing one, and none was found by inspection.
* `claude --help` at v2.1.233 has `--resume <id>`, which is a terminal command
  on the box — not something a link from a phone can reach.

So the picker supplies **context**, not continuity: the chosen session's repo,
cwd and last exchanges go into the brief, and the brief prints a copyable
`claude --resume <uuid> --permission-mode bypassPermissions` line for the
terminal. That is the honest version of the feature. Naming it "resume" in the
UI would have been the third time this product implied a process it does not
start.

---

## 36. A credential that cannot refresh is not connected

`resolveToken` used to return the stored access token when a refresh failed. The
reasoning was that a stale token is better than none. It is not: the caller then
made a real request with a known-dead credential and got a 401, which surfaced
as `sync failed · 401 from https://mcp.slack.com/mcp` — a sentence that blames
the sync for a problem in the grant, and offers no way to fix it.

A refusal is now classified before anything else happens:

* **Terminal** — a 4xx whose body names `invalid_grant`, `invalid_client`,
  `unauthorized_client` or `invalid_request`. The grant is dead. The stored
  tokens are cleared, `last_auth_error` records the provider's own word for it,
  and Settings says `reconnect — invalid_grant`.
* **Transient** — a 5xx, a network failure, a timeout, unparseable JSON. Nothing
  is cleared, because nothing has been established. The call returns null and
  the next poll tries again.

Two columns carry this: `oauth_tokens.last_auth_ok_at` and `.last_auth_error`.
`ok` alone could never have said it — a source can poll successfully at the same
moment its refresh token is dead, and it will keep doing so until the access
token expires.

Refreshes are also single-flighted per server. Five adapters poll in parallel,
`headers()` resolves a token on every JSON-RPC request, and where the provider
rotates refresh tokens the losers of that race hold an invalidated one — so the
stored row could end up an older generation than the provider last issued, which
is the same dead-credential failure arriving by a different road.

---

## 37. The desk is paged in the browser, not on the wire

Every table in the product pages now, and `GET /api/state` still returns the
whole desk.

That looks backwards until you ask what the search box is for. Search spans
every row he has, not the fifty in front of him — a desk you can only search a
page at a time is a filing cabinet. Paging server-side would mean either
shipping the query to the server and giving up the instant local filter, or
searching one page and calling it a search.

The number makes it easy: the desk is around a hundred groups, and each is a
short object. Filtering, then searching, then slicing a page out of the result
is a few milliseconds of work on a phone, and the whole payload is smaller than
one of the icons the page already loads.

The order is load-bearing and is the same everywhere: **filter, then search,
then page**. Paging first would page a list the reader cannot see the rest of,
and the page number resets to 1 whenever any axis above it changes — otherwise
narrowing a filter lands you on an empty page 4 with no way of knowing why.
The page lives in the URL, like every other axis, so reload and Back both work.

Mail is the exception, and it is a real one rather than an oversight: it already
pages server-side, against a mailbox that is far too large to hold, and it
stays that way.

## 38. A thread is one row, and a swipe acts without opening it

Two halves, one release, because they are the same complaint: the desk was
showing him *messages* when what is on him is *conversations*, and the only way
to act on one was to open it.

### The desk was counting replies as work

Measured on the deployed database, not inferred:

| | |
|---|---|
| `#truto` thread `1787812499.720579` | **3 rows** |
| `#truto` thread `1787900782.835249` | **3 rows** |
| `#spendflo-truto` thread `1784530611.515999` | **2 rows**, parent not on the desk at all |

A question and the two answers under it were three separate rows, in three
separate places in the sort, each with its own Done button, and finishing one of
them did nothing to the other two.

The cause is one line. A Slack permalink carries the conversation it belongs to —

```
…/archives/C04D9HKDWAV/p1787812499720579?thread_ts=1787812499.720579   the parent
…/archives/C04D9HKDWAV/p1787812964247529?thread_ts=1787812499.720579   a reply
…/archives/C04D9HKDWAV/p1787814249215859?thread_ts=1787812499.720579   a reply
```

— and the poller was storing `meta.thread_ts` as the *message's own* ts. Every
message was therefore its own thread. A standalone message carries a `thread_ts`
equal to its own ts, so the rule is uniform and there is no second case:
`parentTs = permalink.thread_ts ?? hit.ts`. Verified against all forty live rows.

Cards are keyed on the parent now, so replies land on the row that already
exists. The old rows stop being returned and are swept — but the *state* on them
would be orphaned, and a card he marked done a week ago would come back the
morning this shipped. Migration 12 recovers the parent from each stored card's
own permalink and merges the state forward under the same "already handled wins"
rule `migrateState` has always used.

This is about the *mention* path only. An alert row is keyed on a monitor or a
Sentry short id (#34), which is a different and already-correct identity, and its
`thread_ts` still points at the newest message rather than the oldest — the row's
identity comes from the oldest so it does not churn when Cursor follows up, and
everything a reader sees, `Open` included, comes from the newest.

The two identities do collide in exactly one place, and it is the most ordinary
thing anyone does in an alert channel: reply under the Sentry post with
"`@yuvraj` can you take this". A thread bucket's key and an alert card's
`source_id` are the same string, `<channel>:<ts>`, so the mention search and the
channel read describe one message from two sides. The alert keeps the row — it
is the side carrying `alert`, `short_id`, `paged`, `alert_state` and the
`sentry:TRUTO-38` reference that merges it with the Sentry API's own row — and
the thread is folded into it, bringing the human replies, who is waiting, and
the `@you` mark. Skipping either side instead is not neutral: skipping the alert
made it vanish from the desk the moment a person triaged it, because the poll is
authoritative and the sweep then marked the stored row gone.

### The parent is read, not guessed

He is usually named in a reply rather than in the question, so the search that
finds a thread frequently does not contain the thing the row has to be titled
with. One `slack_read_thread` per distinct thread answers all of it at once: the
parent's text, `=== THREAD REPLIES (10 total) ===` as an authoritative count, and
every reply's author and timestamp. Capped at twenty threads a poll, spent first
on the ones whose parent we do not already hold — a thread we can title loses
only its count, and a thread we cannot title loses the row.

The read needed a parser of its own. `readThread` was handing thread markdown to
`parseSlackResults`, which splits on `### Result N of M` — a separator that
appears nowhere in that payload — so it had been returning an empty array for
every thread ever read, silently. That is now three parsers for three formats,
each written against a capture (see `FIXTURES.md`), and there is a test that
feeds the thread payload to the search parser to prove they are not
interchangeable.

A thread read that fails degrades **one row** and says so on it with
`meta.thread_partial`. A failed search or alert-channel read is still a failed
poll, because a channel that did not answer is a channel whose alerts are
missing. Those are different facts and they must not share a fate, which is why
the thread reads are deliberately outside the settled array.

"Degrades" has to mean something, though: the hits become the conversation. The
search already returned the message that named him — that is why the row exists —
so reading the replies off the failed read alone left the pane showing the
question with nothing under it and no `@you` anywhere. The two sources union by
`ts`, which also recovers a hit that fell outside a truncated read, and the mark
is drawn beside the excerpt as well as beside the list, because one message is
the shape a degraded row most often takes and the list declines to draw at one.

### `+2`, and the amber edge, are one fact

A row wears a count of the messages that landed since he last opened it —
excluding his own, because ten of the eleven messages on that `#truto` thread
were his and none of them are news. The badge appears when the count is above
zero and the row's left edge goes amber under exactly the same expression, so
they can never disagree. It is computed once, in `activityOf`, and the browser
does no arithmetic on it at all.

The browser does no arithmetic, but it does have to *draw* the same set, and
that is one expression — `isFreshLine` — rather than a second, shorter rule at
the one place that paints it. The pane once compared a line's timestamp to the
baseline and nothing else, so his own replies came out in the brighter "new" ink
beside a row reading `+0`, and a thread merging into a week-old group lit all
twelve of its pre-existing replies. Both clamps live on the line now, which is
why a card's `sources` carry their own `first_seen_at`.

Three things bound what counts, and all three are the same sentence: nothing a
card brought with it when it arrived is something he has missed. A member's
history counts from when *that member* landed, not from when the group did — a
Slack thread merging into a pull request's group inherits a `first_seen_at` from
weeks ago. A card's own `ts` is an event only on the poll it arrived on, because
a Claude session's `ts` is its transcript's mtime and his own work would
otherwise come back to him as an amber edge. And events are keyed by *when*, so a
Slack card's `ts` and the newest entry in its own thread are one event rather
than two.

Opening the row clears it. The pane's resting state — the top row it shows before
anything is clicked — deliberately does not, and that is the whole subtlety: a
pane that acknowledged what it happened to be displaying would clear every count
on the desk every morning, with nothing to see.

Gmail counts under the same rule from the other end. A mail thread was already
one card, but the later messages in it were thrown away, so a conversation that
had moved on looked exactly like one that had not. `search_threads` was already
returning them.

One consequence worth stating: an ack is no longer counted as work. That was
harmless while nothing emitted one; now the pane emits one every time a thread
with a reply on it is read, and a thread that gets answered on twelve different
days would have reported twelve clears while still sitting on the desk. Pulse
asked the same question in three places — the throughput chart's `cleared`, the
"when I actually work" clock and the streak — so the answer is written once, as
`FINISHED_KINDS`, or a week of only reading reports a seven-day streak with
nothing finished.

The 2px left edge is the one `CardTable`'s own docblock deleted, back for exactly
the reason it was deleted: it used to paint every visible row, which encoded
nothing. It paints two or three.

### A swipe, because a thumb has no hover

Every row that has a status slides left under a finger, a trackpad or a mouse
drag to reveal three solid, labelled actions: `Done`, `Status`, `Delete`. Words,
not glyphs, because a thumb-sized box with a picture in it is a guess.

Two things about the implementation are not incidental. The drawer is a
right-anchored clip window whose *width* tracks the pointer, rather than a
translated row: a desk row is a `<tr>`, and translating its cells takes the title
out from under the table and grows a horizontal scrollbar on a page that is
required not to have one. And the gesture locks to whichever axis wins first, so
the page still scrolls under a finger that is not swiping and a task can still be
dragged up and down to reorder.

`touch-action` is in the stylesheet rather than inline, and that is not taste
either. The property does not apply to a table row at all — rows, row groups,
columns and column groups are excluded by the property's own definition — so an
inline `touchAction` on the desk's `<tr>` is dropped by every browser while
looking entirely correct in the source. It goes on the cells. And a
`Reorder.Item` writes `touch-action: pan-x` inline, which no other inline style
can outrank, so the task row carries the one `!important` in the product.

`Status` opens the five-way picker in place, from `STATUS_ORDER` (#32), so the
control cannot offer a value the route refuses. A task gets the three it has and
a goal the two it has, both labelled from the same table, so the product does not
grow a second vocabulary that happens to agree today.

`Delete` removes a task or a goal outright, with an undo — which, since there is
no soft delete for either, is a re-creation carrying every field including the
frozen provenance and the stickies. That is why `POST /tasks` and `POST /goals`
take a `restore` flag: an undo is not work that happened, and a restored task
that lost its `completed_at` would come back finished with no finish time and
sort below work completed weeks earlier.

On a card `Delete` sets `Won't do`, which is how Wake already dismisses work — it
leaves the desk, stays reachable through the Status filter, and undoes. A red
button that irreversibly destroyed a card would be the only irreversible action
in the product, and inventing a fourth word for it would have been a fourth word.

---

## 39. The hand-off starts a session, and #35 was the wrong conclusion

**Reverses #35, and #26 with it.** Every fact in #35 still holds. What was wrong
was what we did about them.

#35 established that `claude.ai/new?q=` opens a *new* conversation, that no URL
targets an existing one, and that `claude --resume <id>` is a terminal command on
the box. All true, all still true. The conclusion drawn was that the picker
therefore supplies **context**, and that the brief should print a `claude
--resume <uuid> --permission-mode bypassPermissions` line for the operator to
paste. That was called "the honest version of the feature".

It was honest about the mechanism and dishonest about the product. The button
said **Open in Claude**, and what it opened was the Claude **chat** surface — a
different product from Claude Code, with no repository, no tools, no MCP servers,
no skills and nothing to resume. The one thing "Open in Claude" is for is the
one thing it could not do. And the paste line is the tell: a feature whose final
act is asking the operator to go and find a terminal is a feature that has given
up, and on a phone at 7am there is no terminal to find.

### What was actually missing

Not a URL. A terminal.

```
browser --ws--> Bun --pipes--> ptybridge.py --pty--> tmux --> claude
```

Four processes, each because the one before it cannot do the job:

* **tmux** owns the session's lifetime. This is what makes closing the tab
  harmless, what lets a laptop and a phone attach to one screen at once, and what
  makes restarting Wake a non-event for work already running — though only after
  `deploy/wake.service` was corrected, because tmux daemonises into its parent's
  cgroup and systemd's default `KillMode=control-group` therefore killed every
  session on every restart. This paragraph claimed the property for a week
  before it was true, and `wake-deploy.timer` restarts on every push, so the
  cost was landing on whatever he happened to be in the middle of. `mixed` is
  not sufficient — measured — because the group-wide SIGKILL still follows the
  main process out. `KillMode=process` is the one that signals the main process
  and nothing else. Holding the process
  in Bun would tie a conversation's life to a web server's, which is the `claude
  -p` mistake of #26 in a nicer coat.
* **`ptybridge.py`** owns the pseudo-terminal. `tmux attach` refuses to run
  without a tty, and node-pty — measured on this box — installs, builds, spawns
  and then delivers no bytes at all under Bun. Nine lines of CPython do what the
  native module could not.
* **Bun** owns the relay and the rules, and nothing else.

### Why this is not #26 coming back

#26 refused `claude -p`: a headless process, no terminal attached, output nobody
could see, permission prompts nobody could answer. Every one of those objections
is about *visibility*, and every one of them is answered here rather than argued
around. The operator sees the TUI. He types into it. He answers its dialogs —
including the two Claude Code actually shows, the one-time "is this a project you
trust?" and the "this session is 6d old and 177.2k tokens" resume menu, both of
which are the strongest argument for a real terminal rather than a spawn.

Wake still holds no model key and still runs no model of its own. It starts the
operator's `claude`, under his login, in his repository.

### What bounds it

"Start a process" is the most dangerous verb in this product, so the allowlist is
three parts and none of them is a caller's:

1. **The command** is `CLAUDE_BIN` plus a fixed set of flags built in
   `terminal.ts`. No request field reaches argv except the brief, which `claude`
   reads as a positional prompt and cannot become an option.
2. **The directory** comes from `resolveCwd` — the registry — or, for a resume,
   from the session's own transcript, bounded to `WORKSPACE_ROOT` with `..`
   collapsed first.
3. **The session** must already exist, read through the same
   `sources/claudeSessions.ts` the Sessions page reads. A caller cannot invent an
   id and have Wake create one.

Validation runs *before* the availability check, so a box without tmux still
refuses an unknown repository by name — and so the refusals are testable without
a machine that can start real sessions.

### Two things that fell out for free

`--session-id <uuid>` means Wake **chooses** the id before the process exists. So
the id in the URL, the id in the transcript filename, the id `liveSessions()`
reports and the id the Sessions page shows are one string, and nothing has to be
reconciled. It also means a session Wake starts appears as **live** in the
existing Sessions surface with no change to that source at all: Claude Code
writes its own `~/.claude/sessions/<pid>.json`, and `liveSessions()` was already
reading it.

### What Wake still refuses to do

Write `hasTrustDialogAccepted` into `~/.claude.json`. A directory Claude Code has
not seen makes it ask whether the project is trusted, and that answer is the
operator's. Wake reads the flag, says `trusted: false` on the way in so the
screen he lands on tells him a prompt is waiting, and leaves the answering to
him. Silently accepting trust on someone's behalf would be a worse version of
exactly the thing #26 was right about.

### The sentence that is now gone

The brief used to end its session section with a fenced command line. It says
this instead:

> This is a Claude Code session already underway on my machine, and this message
> is its next turn.

Which is a claim the product can now keep.

---

## 40. Wake lists the sessions Claude Code is running, and nothing else

**Reverses the archive half of #13, and finishes what #39 started.**

The complaint was one sentence: *"Wake shows archived coding sessions, and when
I start one from Wake, Claude Code on my phone says it has been archived."*

Both halves were true, and they were the same bug seen from two ends.

### What Wake was actually listing

Transcripts. `listAllSessions` walked `~/.claude/projects/*/*.jsonl` inside a
thirty-day window and returned every file it found — a hundred and thirty of
them on this box. A transcript is a *record*: it outlives the process that wrote
it by weeks and its mtime says only that something was written, which a finished
session satisfies exactly as well as a running one.

So the list was a graveyard with a handful of live sessions scattered through
it, and nothing on a row said which was which. He tapped one. Wake handed the id
to Claude Code. Claude Code — correctly — said the session was archived.

### The `claude_session_archive` table was the wrong answer to the right question

Migration 13 added Wake's own archive table on the stated grounds that "Claude
Code has no archive, so Wake invents one". The `Active / Archived / All`
segmented control on the Sessions page filtered on it.

That control is why the bug survived. `Active` only ever hid the rows **Wake**
had archived; it knew nothing about whether Claude Code still had the session
open. Two vocabularies for one word, disagreeing, with the losing one on screen.

### What this version actually writes, measured

The instinct was to go and find Claude Code's archive flag and read it. It does
not have one:

* Zero `archived`-shaped JSON keys across **54,713** transcript records in eleven
  project directories. The only matches for "archiv" anywhere under `~/.claude`
  are prose inside message bodies.
* No sidecar beside a `.jsonl`, no per-session `.json`, nothing in
  `~/.claude/settings.json`.
* `~/.claude/sessions/<pid>.json` is a **live-process** registry — pid, session
  id, cwd, and a messaging socket — not an archive.

Claude Code 2.1.251 publishes the **inverse**, and publishes it as its own
first-class idea:

```
claude agents --json          Print active sessions (interactive and background)
claude agents --json --all    …also include completed background sessions
claude agents --json --cwd P  …only sessions started under P
```

"Active" is Claude Code's word, and `--all` exists precisely because the default
is narrower than everything. Seventeen active on this box against a hundred and
thirty transcripts; thirteen of the seventeen under `work/truto`.

So the rule inverts. Wake does not look for the dead and hide them. It asks what
is alive and shows that.

### The list

`listActiveSessions()` reads the same per-process files `claude agents` reads,
without paying for a subprocess, and only those ids get a transcript opened at
all — seventeen tails instead of a hundred and thirty, which is why it costs
23ms.

That equivalence is checked rather than assumed. Run side by side on this box,
`liveSessions()` and `claude agents --json` return the **same seventeen ids**,
with nothing in either that is not in the other. So this is not Wake's opinion
about what is alive that happens to agree with Claude Code's — it is Claude
Code's answer, read from Claude Code's own files. The window widens to all of history rather than narrowing, because a
session started six weeks ago and *still open* is the one you must not drop.

Wake's archive table survives with its authority reduced to what it can honestly
claim. "I am done looking at this one" is a real thing to want about a session
that is still technically up, so an archived id is removed from the list. It can
only ever subtract now. It cannot put a dead session back on screen, and it
cannot disagree with Claude Code about what is alive.

`Active / Archived / All` is gone. Not defaulted — gone. Being on the list means
active, so the control had nothing left to select between, and a filter he has
to remember to leave switched on is not a product rule.

### Why "just resume it" is not available, and what Send does instead

The obvious continuation — spawn `claude --resume <id> --print` when he sends —
does not work for the sessions this list contains, and the failure is explicit
rather than subtle:

```
$ claude --resume 6fb66aa9-… --print "…"
Error: Session 6fb66aa9-… is running as a background session (6fb66aa9).
Run `claude attach 6fb66aa9` to open it, or `claude stop 6fb66aa9` first to
resume it here. Add --fork-session to branch off a copy instead.
```

Claude Code refuses to resume a session another process is holding open, which
is every session on an active-only list. `--fork-session` would take the offer
and produce a *different* id, which is the archived-twin problem wearing a new
hat.

The way in was already here. #39 built Wake its own tmux server and starts
sessions under it with `--session-id`, and `sendBrief` already pastes into that
tmux through `load-buffer` / `paste-buffer`. That is Wake typing into a terminal
**Wake owns** — not Claude Code's control socket, which stays untouched for the
same reason it always has.

So `POST /sessions/:id/send` has three refusals, and each is a different true
thing rather than one vague one:

1. **Not running.** The id names a transcript. This is the refusal the whole
   pass exists for: Wake used to hand exactly this id to `--resume` or to a
   `claude.ai` link and let Claude Code be the one to break the news. It says so
   itself now, and offers a new session.
2. **Running, but not under Wake's tmux.** He has it open in a terminal
   somewhere. Wake can read that transcript and cannot type into it. The only
   way in would be the control socket, and that line does not move.
3. **Wake's, and tmux would not take the paste.**

`POST /sessions/new` takes a repository and never an id, so the composer's
"A new conversation" cannot resume anything by construction.

### The conversation

`sessionExcerpt` already walked these records and returns one blob for a brief
to quote. `parseSessionTurns` returns the structure instead — role, text,
timestamp, and the tools a turn reached for — and the two stay separate rather
than one pretending to be the other. It drops three things on purpose:
`isSidechain` records, because a subagent's conversation filed in the same
transcript renders as five interleaved ones; `tool_result` user records, because
a tool's output is not something he said and showing it as his own message is
how a transcript starts reading like a terminal; and assistant turns with no
prose, whose tools ride on the next turn that has some.

Polling takes `after=<epoch ms>` rather than an index, because the page reads a
256K tail and an index into a tail is invalidated by the tail moving.

### What #35 got right, and the sentence that is now wrong

#35's facts stand: `claude.ai/new?q=` opens a new conversation, and no URL
targets an existing one. What is struck is the conclusion drawn twice — that the
picker therefore supplies context and the product should print a `claude
--resume <uuid>` line. On an active-only list that line is either impossible
(the session is held open) or an invitation to open a corpse, and on a phone at
7am there is still no terminal to paste it into.

"Open in the Claude app" survives as a real `<a>`, because an iOS universal link
has to be an anchor. It is labelled a **new** conversation, which is the only
thing it has ever been, and it never carries a session id.

---

## 41. Five statuses are five colours, and tasks are the same five

**Reverses the colour half of #32 and #33.**

`status.tsx` opened with an argument it had clearly thought about:

> Five statuses and four priorities is nine states on a row that already has a
> source hue and a kind glyph on it. Painting each of them would put nine
> competing colours on a screen budgeted for three, so the *ring* carries the
> state and colour is spent only where it says something a shape cannot.

The reasoning is sound and the result was not. Held at arm's length on a phone:

* `not_started` and `wont_do` were painted with the **same token**
  (`--color-fg-mute`). Not similar — identical. Two of the five states were one
  picture.
* `in_progress` took `--color-fg`, which is also the colour of the title
  immediately beside it, so the commonest state on the desk was the same ink as
  the words next to it.
* Five open/filled/dashed/tick/slash rings at 14px, in one grey, resolve to
  "there is a circle here" at anything past reading distance.

So the count was right and the budget was spent in the wrong place. The nine
competing colours it feared were never going to happen, because the source hue
and the kind glyph are not on the same axis as the status and the eye does not
add them up.

The shape stays — that is what still works without colour, and it is what a
screen reader gets through `StatusSlot`'s label. Each state additionally takes
one of five `--color-status-*` tokens, spent twice: the glyph, and a 14% wash
behind the chip. A wash rather than a filled pill because the row is still
mostly text and five saturated pills down a column is a paint chart. Every value
is above this file's own contrast floor in both themes, picked against each
page rather than converted between them — the dark sky is 2:1 on white, which is
the failure `--color-accent-ink` already exists to prevent.

`in_progress` is **sky**, not amber. That much of #32 survives intact and is now
pinned by a test: amber is unread, the badge, and the one primary button, and a
status every second row wears would drown all three.

### One painter, because there were two

`Work.tsx` kept its own private mute/fg/ok circles and its own `todo|doing|done`
vocabulary. That is why Work was three states behind the desk: the enum was
never shared, so it could not drift — it simply never arrived. Tasks now store
the same five `CardStatus` values, migrated `todo→not_started`,
`doing→in_progress`, `done→done`, and read the legacy three on the way out so a
row written by the old build never renders blank. Goals stay binary; a goal has
no review.

`StatusGlyph` / `StatusChip` in `status.tsx` are the only things allowed to map
a status to a colour, and a contract test enforces it by refusing any other file
that reaches for two or more of the tokens. One token alone is fine and is not
what it is looking for — the Sessions row borrows `status-live` for its live
dot, which is a session being up rather than a card being in progress.

The swipe drawer's picker was the last place this mattered and the worst one:
five words in `fg-mute` with the current one in `fg`, offered mid-swipe, one
thumb, holding a row open. It is painted now, through the same function, so
there is still exactly one table.

## 42. The templates are read out of his own history, and the phone boundary was arithmetic nobody did

Two jobs in one pass: make the launch templates his rather than a generic
support desk, and make the tables work on a phone. They turned out to share a
failure — a number and a method both written down from memory of how the work
goes, next to a system that could have been asked.

### Where I ran, and the half of the corpus I did not have

The brief said this session had to run on the Mac, because "Wake on the DevBox
does not have the laptop's Claude or Cursor history," and to stop and start
again if I found myself on the box. I am on the box, and the premise is false
here: `~/.claude/projects` on the DevBox holds 501 transcript files, 99 of them
mainline sessions with real user turns — 573 turns and about 6,800 commands,
2026-08-18 to 2026-08-31. That is more Claude history than the brief attributed
to the Mac. The stop instruction was conditioned on the corpus being absent; the
corpus is present, he is offline and cannot restart anything, so I read it here.

What is genuinely missing is the Cursor half. `~/.cursor/projects` exists on this
box with the right five project directories and **one file in all of them** — the
`agent-transcripts` trees are not here. So the ~500 Cursor conversations the brief
describes did not inform any of this, and neither did anything before 18 August.
Every claim below rests on Claude Code sessions from a two-week window. Where the
Cursor corpus would most likely have changed my mind is the older customer work:
the integration-build and catalog jobs barely appear in what I could read, which
is why I did not add a template for them.

### What the history actually says, and where the old templates were wrong

Nine clusters, read by nine agents against per-session digests of his verbatim
turns plus the commands each session ran. The findings that changed the file:

**Profiles carry the environment, so "which environment" is a lookup, not a
question.** They read `yuvraj-<customer>-<env>` — `yuvraj-15five-production`,
`yuvraj-spendflo-staging`, `yuvraj-komplai-production`, `yuvraj-maximor-development`.
He never types the profile string; he types "sprinto profile", "15 five profile",
"there profle", and once "PenFlow" for Spendflo. Matching that to a real profile is
the agent's first job. `whoami` is the third-most-used command in the corpus (38
calls) because it is how the environment gets *pinned* rather than assumed — and he
names two or three environments at a time ("staging and production env", "komplai
dev profile and prod profile"), so the sweep is plural. The old template said
"Customer, Truto profile, environment, account", which is the right list in an
order that does not survive contact: it reads as one environment, chosen once.

**The environment's mapping row is read before the base row.** This is the single
most repeated way these investigations went wrong, and the old template listed
"integration config, environment-integration override, unified-model mapping" —
base first, override second, mapping last. The transcripts do the reverse:
`env-integrations list` → `show-override`, then `env-unified-model-mappings get`,
and only then the catalog row. Reading the base while the override is what runs
produces a confident wrong answer, every time.

**A mapping is executed, not read.** `truto jsonata eval --expression-file` against
the expression pulled *down from the environment* and a crafted payload is what he
accepts. "The mapping looks right" survives nowhere in the corpus.

**Logs are walked day by day.** Not "the logs over the failing window" as the old
template had it — the actual sessions loop a date range a day at a time to find the
day behaviour changed, because that date is the finding.

**Skills: ten of eleven templates named skills that cannot be loaded.** They said
`truto-cli-toolbelt`, `truto-safe-admin-operator`, `truto-mapping-tester`,
`truto-sync-job-validator`, `truto-account-health-auditor`,
`truto-customer-issue-debugger`. Those exist only under `~/work/Cursor-skills/.cursor/skills`,
which is read by neither Wake's own index (`~/work/truto-skills/skills`) nor a
launched Claude Code (`~/.claude/skills`). Both of those hold `truto-cli`, and the
corpus shows `truto-cli` opened in eight sessions and `truto-cli-toolbelt` in none.
The packed briefs prove the cost directly: a session handed three of the dead names
loaded an unrelated skill instead. `resolveSkillId` passes an unknown name through
untouched rather than dropping it, which is why nothing ever complained. Every row
now names skills from the catalog the receiving session actually reads.

**Pasted evidence is a lead, not a finding — and that belongs in the packer.** His
hand-written briefs say it outright: "treat every prior conclusion in this brief as
a lead to verify, not a fact." Wake pastes other people's conclusions for a living,
so a teammate's hunch arrives looking exactly like a diagnosis. The untrusted fence
already stops quoted text being *obeyed* — that is injection safety and it was
never the gap. What was missing is what the words are *worth*. It is one line in
`launch.ts` rather than a clause in eleven templates, because eleven templates
cannot afford it and the packer says it once for all of them.

### The new row, and the ones I did not add

`qa-branch` is new, and it is the largest cluster in the corpus with no template:
"test absolutely everything for this like a senior QA engineer", local before UAT,
snapshot first, never production, and — in every single one of his QA briefs — an
order to delete the artefacts the run created. `review-pr` answers "is this right";
this answers "does it hold up when you run it", and they were one row doing both
badly. It also carries the rule he states almost verbatim across four QA sessions:
if you are not fully certain, label it a likely issue rather than stating it as
fact.

Two evidenced jobs I deliberately left out.

**A second voice row for the explain register.** The history is unambiguous that
there are two registers, not one: the customer draft the `humanizer` already
describes (~120 words, verdict first — "They pair by order, not by a line id."),
and an explain-it-to-me register that is the opposite (verbose, from scratch, step
by step, and no analogies at all — "don't give me, uh, examples, like, um, a farm").
`humanizer.test.ts` allows exactly one `voice` row and says why: two of them
selected together are two registers arguing inside one brief. That reasoning is
right, and the explain register is a follow-up turn inside a session rather than a
thing you launch, so it stays out. What I did take from that cluster is two more
banned phrases — "good catch" and "you're right", which he banned himself in
consecutive turns on an otherwise finished draft.

**A design-pass row.** Rich evidence (roles, screenshot indexing by environment,
"convert the adjective to a number", browser E2E before pushing), but those
sessions start with him typing two thousand characters of prompt, not with a card.
Wake templates are triggered by a packed object. This one has no object.

### The phone boundary was 640 because that is what Tailwind calls a phone

`COLUMNS_MIN` decided where the desk stops drawing a table, and it was 640 with a
paragraph explaining that "from 640 up the 552 fits inside the page column with
room to spare, nothing scrolls". It does not. The table needs `PHONE_MIN` = 552,
and the shell keeps 248 of every viewport before the page column starts — a 200px
rail from `sm` up plus 24px of `.pad-x` each side. So at 640 the page column is
392 and the table hung 160px off the end of it; at 768, an iPad held upright, it
still hung 32 over. The band that shipped specifically to remove a sideways-
scrolling table was itself a sideways-scrolling table, one breakpoint up, with
`WHO` cut off mid-word again in exactly the way the previous pass wrote three
paragraphs about ending.

The sentence measured the table against the *viewport*, and the table has never
been given the viewport. That is the whole bug, and it is why the fix is not a
better number: `COLUMNS_MIN = PHONE_MIN + SHELL_FIXED`, which is 800. The three
measurements it depends on now sit above it in the file instead of 600 lines below,
because a threshold written out of sight of its own inputs is the thing that
happened here. `test/phone-desk.test.ts` pinned the literal `640`; it now pins the
derivation and reads the widths back out of the source, and its own name — "the
desk changes layout where the columns stop fitting" — was already correct about
what it was supposed to be checking.

Nothing else moved. Below the boundary the desk was already a list of row-cards
and that was already right; the band 640–799 simply joins it, and every rule
`phone-desk.test.ts` pins about reaching the table's columns still applies from
800 up.
