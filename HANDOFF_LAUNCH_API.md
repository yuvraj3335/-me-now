# Contract: the launch sheet → a live Claude Code session

**Owner of this file:** the terminal agent. **Audience:** whoever owns
`src/web/components/launch.tsx`, `src/web/lib/launch.ts` and
`src/web/components/sessions.tsx`.

This is the contract you code against. Everything below is implemented and on
the branch; nothing here is aspirational.

---

## What changed, in one paragraph

"Open in Claude" used to build `https://claude.ai/new?q=<brief>` in the browser
and hand it to an `<a href>`. That is the Claude **chat** surface: a different
product, a new conversation every time, no repository, no tools, no session to
resume. It now starts or resumes a **real Claude Code process on this box**, in
the selected repository, under `--permission-mode bypassPermissions`, with the
brief as its first message — and the operator drives that process from a real
terminal in the browser, on a laptop or a phone.

`src/shared/handoff.ts` and `handoffConfig()` still exist and `/state` still
serves them, so nothing you have breaks today. They are no longer how a brief is
delivered.

---

## Routes

All of these are on the existing `/api/claude` mount (`src/server/claudecode/router.ts`),
except the socket, which is registered on the root app in `src/server/index.ts`
so the upgrade can happen before Hono's `/api` sub-app.

### `POST /api/claude/terminals`

Start a session, or reattach to one that is already running.

Request body — every field optional, but it must resolve to a directory:

| field | type | meaning |
|---|---|---|
| `packId` | `string` | Start from a Wake brief. `cwd`, `sessionId`, `permissionMode` and the brief text all come from the pack row unless overridden below. Marks the pack `opened` and writes the `claude.handoff` audit row, exactly as `POST /packs/:id/open` does. |
| `brief` | `string` | The edited brief. Overrides the pack's stored copy, and — like `openPack` — is written back to the pack file on disk, so the file and what the session received stay one text. |
| `sessionId` | `string` | Resume **this** Claude Code session. Must already exist on this machine (`getSession`). Its own recorded `cwd` wins over `cwd` below. |
| `cwd` | `string` | Repository name or absolute path. Must be in the registry (`resolveCwd`). |
| `permissionMode` | `'bypassPermissions' \| 'acceptEdits'` | Default `bypassPermissions`. |
| `cols`, `rows` | `number` | Initial size. Defaults 120×34. The browser resizes over the socket anyway. |

Response `200`:

```jsonc
{
  "id":             "9d10634a-f90c-52ee-a66d-fcd8b6f7e204", // === sessionId
  "sessionId":      "9d10634a-f90c-52ee-a66d-fcd8b6f7e204",
  "cwd":            "/home/yuvraj/work/truto",
  "repo":           "truto",
  "permissionMode": "bypassPermissions",
  "resumed":        false,   // true = --resume <id>, false = a new --session-id
  "started":        true,    // false = it was already running; we reattached
  "briefSent":      true,    // the brief went in as the process's first message
  "trusted":        true,    // false ⇒ Claude Code shows its trust dialog first
  "route":          "/terminal/9d10634a-f90c-52ee-a66d-fcd8b6f7e204",
  "socket":         "/api/claude/terminals/9d10634a-.../socket",
  "cols": 120, "rows": 34,
  "createdAt":      1788168122250,
  "clients":        0
}
```

Errors:

| status | when |
|---|---|
| `400` | the repository is not in the registry; the session id is not on this box; the permission mode is not one of the two; nothing named a directory |
| `503` | `tmux`, `python3` or the `claude` binary is missing on this machine |

`400`/`503` bodies are `{ "error": "<a sentence naming what was refused>" }`,
the same shape as every other route in this router.

### `GET /api/claude/state` — one new field

```jsonc
{
  /* …everything it already served… */
  "terminal": {
    "available": { "ok": true, "tmux": true, "python": true, "claude": true, "missing": null },
    "running":   [ /* Terminal[], the sessions up right now */ ]
  }
}
```

`available.ok === false` means this machine cannot start a session at all —
render the Open control **off with `available.missing` as the reason** rather
than letting it answer 503 after the brief has been written.

### `GET /api/claude/terminals`

```jsonc
{
  "terminals": [ /* the object above, one per running session */ ],
  "available": { "ok": true, "tmux": true, "python": true, "claude": true }
}
```

### `GET /api/claude/terminals/:id`

`200` always, so a page can render "not running any more" instead of a 404 wall:

```jsonc
{ "terminal": { /* … */ } | null, "session": { /* SessionRow */ } | null }
```

### `DELETE /api/claude/terminals/:id`

Ends the process. The transcript survives, so the session can be resumed later.

```jsonc
{ "ok": true, "closed": true }
```

### `GET /api/claude/terminals/:id/socket` — WebSocket

- **server → client**: **binary** frames are raw pty bytes, feed them straight to
  xterm's `term.write(bytes)`. **text** frames are JSON:
  `{"t":"open","cols":N,"rows":M}`, `{"t":"exit","code":N}`, `{"t":"error","message":"…"}`.
- **client → server**: **text** JSON only.
  `{"t":"i","d":"<what was typed>"}` · `{"t":"r","cols":N,"rows":M}` · `{"t":"ping"}`.

The upgrade is refused with `403` if the browser sends an `Origin` that is not in
`ALLOWED_ORIGINS`. A WebSocket upgrade is a GET, so `originGuard()` does not
cover it, and a cross-site socket would otherwise ride the Cloudflare Access
cookie into a live shell.

### `POST /api/claude/packs/:id/open` — unchanged, plus one field

Still returns `{ packId, url, cwd, packPath, sent, total, trimmed }`. It now
**also starts the session** and adds:

```jsonc
{ "terminal": { /* the Terminal object */ } }   // or
{ "terminalError": "…" }                        // it recorded, but could not start
```

So the button you have today already starts a real session. What it must stop
doing is *also* navigating to `link.url` — see below.

---

## The client helper

Module: **`src/web/lib/terminal.ts`**

```ts
export type Terminal = { /* exactly the response object above */ }

export type OpenTerminal = {
  packId?: string
  brief?: string
  sessionId?: string | null
  cwd?: string | null
  permissionMode?: 'bypassPermissions' | 'acceptEdits'
  cols?: number
  rows?: number
}

export const terminalApi: {
  open  (b: OpenTerminal):  Promise<Terminal>
  list  ():                 Promise<{ terminals: Terminal[]; available: Available }>
  get   (id: string):       Promise<{ terminal: Terminal | null; session: Session | null }>
  close (id: string):       Promise<{ ok: true; closed: boolean }>
}

/** Where the session lives in this app. */
export const terminalRoute:     (id: string) => string   // `/terminal/<id>`
export const terminalSocketUrl: (id: string) => string   // ws(s)://…/socket

/** Open (or resume) and go there. This is the one you want. */
export function openTerminalAndGo(b: OpenTerminal): Promise<Terminal>
```

`openTerminalAndGo` calls `POST /terminals`, then `navigate(t.route)` from
`src/web/lib/route.ts`. It throws with the server's own sentence on refusal, so
a `catch` can put that straight in a toast.

---

## The terminal page

Route: **`/terminal/<sessionId>`** — a real path, registered in `src/web/App.tsx`.

It renders full-viewport, outside the nav rail and the phone tab bar, with a
back control and a `Wake › Sessions › <repo> › <session>` chevron path. Deep
links work: opening that URL cold reattaches to the live session.

---

## What you need to change

1. **`src/web/components/launch.tsx` ~line 1050.** Replace the `<a href={link.url}>`
   with a control that does:

   ```ts
   await openTerminalAndGo({ packId, brief })
   resetLaunch()
   ```

   Drop the `launchApi.open(packId, brief)` call — `openTerminalAndGo` does the
   same recording, and doing both starts two sessions.

2. **The trimming chrome around it** (`link.trimmed`, `handoff.maxChars`, the
   `N / 12,000` counter) no longer describes anything. A brief handed to a local
   process is not trimmed; there is no URL budget. `test/ui-contract.test.ts:532`
   asserts `launch.tsx` contains `handoffFor(brief,` — that assertion is now
   asserting the bug, and is yours to amend.

3. **"Copy resume command"** (`launch.tsx` ~line 717) and `resumeCommand()` in
   `src/web/lib/launch.ts`. The whole point of this work is that nothing prints a
   line for him to paste into a terminal he has to go and find. Replace both with
   `openTerminalAndGo({ sessionId })`.

4. **`src/web/components/sessions.tsx`.** A live session's row should offer
   *Open* → `openTerminalAndGo({ sessionId: s.id })`. `s.live` already tells you
   which ones are running, and sessions Wake starts set that flag themselves —
   Claude Code writes its own `~/.claude/sessions/<pid>.json`, so `liveSessions()`
   sees them with no change to `src/server/sources/claudeSessions.ts`.

5. **`src/server/sources/claudeSessions.ts`** sets `meta.resume_cmd` on every
   session card, and `CardDetail` renders it. Same failure mode as (3). That file
   is another agent's; flagged here so it is not forgotten.

6. **`src/server/claudecode/templates.ts`** — the `continue-session` template's
   instruction still says the session is "not resuming" and that this is a "new
   conversation". Both were true of the link and are now false: the session
   really is resumed, in place, under its own id. `test/launch.test.ts` asserts
   those two phrases, so the template and that test move together. Also another
   agent's file.

---

## Two facts you can rely on

- **`id` is the Claude Code session uuid.** Not a Wake handle. Wake passes
  `--session-id <uuid>` when it starts a new one, so the id in the URL, the id in
  the transcript filename, the id in `liveSessions()` and the id in the Sessions
  list are all the same string.
- **A session survives everything the browser does.** It lives in a detached
  `tmux` on a private socket, so closing the tab, reloading, losing signal or
  restarting Wake itself all leave it running. Two devices may attach at once and
  see the same screen.
