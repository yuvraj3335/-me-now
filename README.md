# Wake

What's on me, what I'm working on, how fast I'm moving, and what I shouldn't forget.

One page on a phone and a laptop. It reads Slack, GitHub, Gmail, Sentry and the
Claude Code sessions on the DevBox, collapses them into one card per real thing,
and never writes back to any of them. The only writes it owns are mine: tasks,
notes, deadlines, goals, reminders, snoozes.

It is not a chat, and there is no model in it.

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

## Read-only, structurally

Wake requests only read scopes, and the MCP client refuses to invoke any tool
whose name matches a mutation pattern (`send`, `post`, `create`, `delete`,
`reply`, …). A future edit that tries to write fails loudly instead of quietly
messaging a colleague.

There is no Anthropic dependency and no API key in this project. "Why this is on
you" is a rule firing, and you can read the rule.

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

- **Connecting sources** → [SETUP.md](SETUP.md)
- **Deploying to the DevBox** → [deploy/DEPLOY.md](deploy/DEPLOY.md)
- **Why it is built this way** → [DECISIONS.md](DECISIONS.md)
