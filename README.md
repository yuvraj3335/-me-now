# Wake

What's on me, what I'm working on, how fast I'm moving, and what I shouldn't forget.

On a phone and a laptop. It reads Slack, GitHub, Gmail, Sentry and the Claude
Code sessions on the box, collapses them into one card per real thing, and never
writes back to any of them from that path. The writes it owns are mine: tasks,
notes, deadlines, goals, reminders, snoozes, voice notes — and, behind a gate,
one email at a time.

Around the piles sit four more surfaces:

- **Mail** — a real client over both inboxes. Boxes, labels, search, threads,
  compose, reply, forward, drafts, send.
- **Agent** — an operations agent for Truto: customer investigations, account
  audits, mapping and sync-job debugging. It runs on the Anthropic API with a key
  Wake holds, and reaches the world only through typed, classified tools.
  Mutations stop and ask.
- **Open in Claude Code** — packs a card, a mail thread, a Sentry issue or a
  Slack thread into a brief and starts a Claude Code session on this machine,
  where the repositories, the Truto CLI and the skill catalogs already are. It
  hands back a session id and the command to rejoin it.
- **Voice** — dictate into any field, or record a note that lives on disk beside
  the written ones.

No model touches a card. The card pipeline is the same deterministic code it
always was, and the agent's tables are disjoint from it — so the Now pile is
still a rule firing, not a generated sentence (`DECISIONS.md` #3).

---

## The three piles

| Pile | What it means |
|---|---|
| **Now** | Someone else is blocked on you — a DM, a mention, a review request, an assigned issue, unread mail addressed to you |
| **Open** | You started it and nobody is waiting — your open PRs, live Claude Code sessions, tasks in flight |
| **Parked** | You snoozed it. It comes back on its own when the snooze expires |

Piles are computed from the card plus your state, never filed by hand — so they
cannot drift out of sync with reality. A manual move always wins, and "not mine"
is permanent.

## One card per thing

The same piece of work shows up in a Slack thread, a GitHub PR, a notification
email and a Claude session. Wake shows it **once**, with a badge naming every
place it was seen.

That merge is deterministic, not a similarity guess: cards are joined by
union-find over hard references — a PR number, a Slack `channel:thread_ts`, a
Gmail thread id, an RFC-5322 Message-ID, or a distinctive normalized title.
Cards sharing no such reference are left alone, because a wrong merge *hides*
something real. See `DECISIONS.md` #4.

Acknowledgement, snoozing and notification state live on the merged group, not
on the individual card. That is what makes two promises hold:

- something you have already seen never comes back as new
- **one reminder per thing** — enforced in the schema by a partial `UNIQUE`
  index, so a duplicate source physically cannot create a second notification

## Two engines, and why they are not one

This is the one thing to know before reading any of the code.

| | **Ask Wake** | **Open in Claude Code** |
|---|---|---|
| what it is | the chat inside this app | a launcher |
| engine | `@anthropic-ai/sdk` | the `claude` binary on this machine |
| credential | a key Wake holds (Settings → Agent) | whatever `claude` is signed in with |
| owns the tool loop | Wake | Claude Code |
| how a write is gated | the tool **blocks** on a human | Claude Code's own permission model |
| can edit files | no | yes |

Wake owns its own loop because that is the only way a mutating tool can *block*
mid-turn on a click, durably and resumably. It launches the real binary for
engineering work because the value of that hand-off is that the session is
real — it lands in `~/.claude/projects`, and `claude --resume <id>` picks it up in
a terminal with full permissions. Wake's key is stripped from every child
environment so the two never quietly become one. See `DECISIONS.md` #14.

## Architecture

```
Slack MCP ─┐
Sentry MCP ─┤   MCP client (Streamable HTTP + stdio, OAuth 2.1 + PKCE)
Gmail MCP ─┘         │
GitHub  ──── gh token│         ┌─ normalize → one card shape
Claude sessions ── fs│ ────────┤─ extract hard references
                               └─ union-find → group → SQLite
                                        │
                       Hono API ────────┴──── React PWA (installable, web push)
```

- **Runtime** Bun + TypeScript
- **Server** Hono, SQLite via `bun:sqlite` (WAL)
- **UI** React 19, Vite, Tailwind v4, motion
- **Charts** d3-scale + d3-shape, drawn as SVG — deliberately not a chart
  component library (`DECISIONS.md` #6)
- **Push** Web Push (VAPID) with a real service worker

Wake speaks MCP itself rather than borrowing Claude Code's connections, because
those route through an Anthropic session proxy that dies with the session — no
basis for a site that must be up at 7am. It will still *read* Claude Code's
token store as one link in its credential chain, which is why
`claude mcp login slack` on the box is enough to light Slack up.

## The agent

Nine **modes**, each of which changes the tool surface rather than a label:
triage, customer support, account health, API debugging, mappings, sync jobs,
webhooks & workflows, platform engineering, incident command. There is no editor
and no shell in any of them; triage is read-only and cannot reach a mutating
tool or draft outbound mail at all.

```
browser ──SSE(?after=seq)── Hono ──┬── turn_events (durable, gap-free seq)
                                   │
                                   ├── Anthropic SDK ── Wake's own tool loop
                                   │        typed tools ┤ registry · skills
                                   │                    ├ truto CLI (classified)
                                   │                    ├ slack/gmail/sentry/github
                                   │                    ├ mail read + gated draft
                                   │                    ├ claude_launch (hand-off)
                                   │                    └ platform & monitoring MCP
                                   └── approvals (a tool BLOCKS on a human)
```

- **Repository registry** — every git repo under `~/work`, with its rule files,
  its real test/typecheck commands, and worktrees resolved to their canonical
  upstream from git rather than from a list of names.
- **Skill catalogs** — indexed by metadata only; a body is read when a turn needs
  it. Mandatory routing (toolbelt before CLI work, safe-admin before a mutation,
  ginger guardrails on a `*Service.ts` change) lives in code with tests, not in a
  prompt.
- **Durable turns** — reload the page, drop the network, restart the server: the
  stream resumes from the last sequence you saw.

## What it will and will not do

Wake requests only read scopes from its sources, and there is **no shell tool** —
every Truto invocation is an argument array, so a customer name containing a
semicolon is an argument rather than a second command.

Commands are classified before they run, and **anything unrecognised is treated
as a mutation**:

| | |
|---|---|
| read | runs |
| provider read | runs, disclosed as reaching a live customer account |
| mutation | blocks for approval |
| high-risk | blocks for approval, marked as touching a third party |

A mutation goes through preflight read → backup → diff → approval → staleness
re-check → apply → **verification read**, and reports itself as unverified if the
verification did not run. The gate is a blocking call inside the tool, not an
instruction in a prompt.

It **cannot** post to Slack, commit, push, open a PR, or deploy. It can prepare
an email, and that is where preparing ends: the draft lands in the Mail composer
behind a confirmation bound to a hash of the exact message. Change a word and the
approval stops matching, so it cannot carry text nobody approved.

Everything Wake does to the outside world lands in `audit_events` — a table
deliberately separate from the analytics log that drives Pulse.

## Running it

```bash
bun install && bun run build && bun run start
```

Development, with the UI on :5173 proxying the API on :8585:

```bash
bun run dev
```

Tests:

```bash
bun test
```

`?static=1` on any URL renders every animated mark at its end state — useful for
screenshots, and the same code path a reduced-motion reader gets.

The chat needs an Anthropic API key — Settings → Agent, or `ANTHROPIC_API_KEY`.
Without one it says so plainly rather than appearing to work.

"Open in Claude Code" needs the `claude` CLI signed in on the machine, and the
Truto tools need the `truto` CLI with at least one profile. Neither is bundled
and neither takes a key from Wake — `WAKE_CLAUDE_BIN` and `WAKE_TRUTO_BIN` point
at them, and `WAKE_WORKSPACE_ROOT` (default `~/work`) bounds where a session may
be opened. Platform MCP and truto-monitoring MCP are optional; unset, their tools
report themselves unavailable rather than guessing.

Voice recording and live dictation are the browser's own. Transcribing a stored
note needs a service (`WAKE_STT_URL`); without one the audio is kept and the UI
says transcription is unavailable.

- **Connecting sources** → [SETUP.md](SETUP.md)
- **Deploying to the DevBox** → [deploy/DEPLOY.md](deploy/DEPLOY.md)
- **Why it is built this way** → [DECISIONS.md](DECISIONS.md)
