# Wake

What's on me, what I'm working on, how fast I'm moving, and what I shouldn't forget.

On a phone and a laptop. It reads Slack, GitHub, Gmail, Sentry and the Claude
Code sessions on the box, collapses them into one card per real thing, and never
writes back to any of them from that path. The writes it owns are mine: tasks,
notes, deadlines, goals, reminders, snoozes, voice notes — and, behind a gate,
one email at a time.

Around the piles sit three more surfaces:

- **Mail** — a real client over `yuvraj@truto.one`. Boxes, labels, search, threads,
  compose, reply, forward, drafts, send.
- **Open in Claude** — packs a card, a mail thread, a Sentry issue or a Slack
  thread into one self-contained brief, and opens it in Claude: the app on a
  phone, a tab on a laptop, signed in as you already are.
- **Voice** — dictate into any field, or record a note that lives on disk beside
  the written ones.

**Wake runs no model.** It holds no API key, starts no process, and has no chat
of its own. The card pipeline is deterministic code — a rule firing, not a
generated sentence — and the one place a model is involved is the link you click
(`DECISIONS.md` #3, #15).

Light and dark, following the system unless you say otherwise. Every text/ground
pair clears WCAG AA in both.

---

## Status, priority, due date

The desk is one flat, searchable, filterable table. Every row carries three
stored facts you set yourself:

| | |
|---|---|
| **Status** | Not started · In progress · In review · Done · Won't do |
| **Priority** | Urgent · High · Normal · Low. Normal renders nothing — a mark the eye skips on every row is not information |
| **Due** | A real date and time, or nothing |

Only `Not started` is ever assumed. `In progress` and `In review` are claims
about work that only you can make, so nothing infers them; `Done` and `Won't do`
take the row off the desk and are reached again through the status filter.

Underneath, Wake still computes an urgency rank from the card and your state —
whether somebody else is blocked on you, whether you started it, whether it is
waiting on a date — and that is what orders the table before you sort it. It is
derived every time rather than filed once, so it cannot drift out of sync with
what the sources actually say.

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

## Open in Claude

The one thing to know before reading any of the code: **Wake packs context, and
then gets out of the way.**

Pick a card, a mail thread, a Sentry issue. Pick a session, a repository, a
template — customer incident, sync-job failure, mapping, blank. Browse the skill
catalogs and add or drop what you want. Type what you need, or dictate it. Choose
how it should run. Wake renders one self-contained brief: how to run it, what you
need, the repository it concerns, the skills to load first, and every object
quoted and fenced as data — one entry per place the thing was seen, so a card
deduped across Slack, GitHub and Sentry arrives as three sets of identifiers
rather than one blob.

The templates are briefs, not one-liners. Each says what to establish before
touching anything, which subagents to put on it — architect, senior engineer, UI,
UX, designer, QA lead — what evidence it will not accept a conclusion without,
and what to hand back. They say *what*, never *how*: "read the
environment-integration override" stays true across CLI releases, and a command
line with flags in it does not.

**Then it shows you the brief and lets you edit it.** That is the step that
matters: what goes is what you approved, not what Wake happened to render. The
character count is live and honest, dictation drops text at the cursor, and the
stored copy, the file on disk and the link all become the edited version. Then it
hands you a link.

That link is `https://claude.ai/new?q=<the brief>`. On a phone it is a universal
link, so it opens the Claude app; on a laptop it opens a tab. Either way it is
your own Claude login — Wake never sees it, holds no key, and starts nothing.

### Sessions, and what picking one actually does

`/sessions` lists every Claude Code session on the box, grouped by the directory
it ran in, with a `live` badge on anything running right now. Sessions are filed
on disk under a *flattened* form of that directory — every non-alphanumeric
becomes a dash — so `-Users-me-work-truto-app` is both `truto-app` and
`truto/app` and there is no telling which. Wake groups by the `cwd` the
transcript itself recorded and falls back to the raw filed name, never to a
reconstructed path.

`turns` is counted from the tail of the transcript Wake reads, not from the whole
thing, which is why every surface says **turns in view**.

Picking a session in the launch sheet **targets it as context — it does not
resume it.** `claude.ai/new?q=` opens a *new* conversation and there is no URL
that reaches an existing one, so what the picker buys you is: the session's
directory and branch fill in, its last exchanges are attached as a quoted object,
and the brief carries a `claude --resume <id> --permission-mode <mode>` line you
can copy into a terminal on the machine the transcript is actually on. The UI
says that in those words. See `DECISIONS.md` #35.

**Bypass permissions is the default.** A brief is written, read and approved
before it is sent; asking again at the terminal asks the same question twice. The
other position is `acceptEdits`. The link cannot carry either — there is no
parameter for it — so the mode appears in the brief in words and in the copyable
command, and the sheet says so rather than implying a setting that silently does
nothing.

**Deleting a session is irreversible and touches files Wake did not write.** It
removes four paths under your Claude Code home: the transcript, its sidecar
directory, `session-env/<id>` and `file-history/<id>` — the last of which is
Claude Code's edit-undo history for real source files. So it names all four,
takes a typed confirmation bound by a server-side token to that exact session id,
and is refused outright while the session is running: unlinking a live transcript
does not stop the process, it leaves it appending to a file with no name.

It used to spawn `claude -p` on the DevBox instead: a headless process with no
terminal attached, whose output nobody could see and whose permission prompts
nobody could answer. It was a session in name only. See `DECISIONS.md` #15.

A brief longer than 12k characters is trimmed to fit the URL — and *says so
inside itself*, so the session asks rather than answering half a thread
confidently. The whole thing stays on disk either way, one click from the panel.

## Architecture

```
Slack MCP ─┐
Sentry MCP ─┤   MCP client (Streamable HTTP, OAuth 2.1 + PKCE)
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

## What a brief is assembled from

```
card / mail thread / Sentry issue ─┐
a Claude Code session, as context  │
templates (10 of them)             ├── one Markdown brief ── claude.ai/new?q=…
the repository it concerns         │        │
the skills worth loading (named)   │        └── the same text, on disk
the permission mode, in words      ┘
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

"Open in Claude" needs nothing installed and no key. `WAKE_HANDOFF_URL` (default
`https://claude.ai/new`) and `WAKE_HANDOFF_MAX_CHARS` (12,000) are the only knobs.

Truto identity in Settings needs the `truto` CLI with at least one profile —
`WAKE_TRUTO_BIN` points at it. `WAKE_WORKSPACE_ROOT` (default `~/work`) bounds
which repositories a brief may name.

Voice recording and live dictation are the browser's own. Transcribing a stored
note needs a service (`WAKE_STT_URL`); without one the audio is kept and the UI
says transcription is unavailable.

- **Connecting sources** → [SETUP.md](SETUP.md)
- **Deploying to the DevBox** → [deploy/DEPLOY.md](deploy/DEPLOY.md)

Every push to `main` runs typecheck, tests and a build on GitHub Actions, and the
DevBox picks the commit up within a minute — but only if those same three pass
again on the box. A red build is a deploy that does not happen.
- **Why it is built this way** → [DECISIONS.md](DECISIONS.md)
