/**
 * "Open in Claude", on the client, now that it opens something.
 *
 * The old client half of this feature was `handoffFor(brief, cfg)` in
 * `src/shared/handoff.ts`: the browser built a `claude.ai/new?q=…` URL and put
 * it on an anchor. That code still exists and `/state` still serves its config,
 * because the sheet that reads it belongs to somebody else this week — but it is
 * no longer how a brief is delivered. This module is.
 *
 * There is deliberately no store here, and no `useSyncExternalStore`. A terminal
 * is not app state to keep in sync; it is a process on a box, and tmux is the
 * only thing that can answer whether it is running. Everything below is a
 * request or a URL.
 *
 * See HANDOFF_LAUNCH_API.md for the wire contract this mirrors.
 */

import { navigate } from './route'

/** The two real `--permission-mode` values a session may be started under. */
export type PermissionMode = 'bypassPermissions' | 'acceptEdits'

/**
 * The `--model` aliases a session may be started on. `default` passes no flag.
 *
 * Declared here rather than imported from `lib/launch`, matching the mode above:
 * this module is the wire contract for `/api/claude/terminals` and is meant to
 * be readable without the composer's state machine. The labels live in
 * `lib/launch`; the server validates the value either way.
 */
export type SessionModel = 'default' | 'opus' | 'sonnet' | 'haiku' | 'fable'

export type Terminal = {
  /**
   * The Claude Code session id — not a handle Wake invented.
   *
   * Wake passes `--session-id` when it starts one, so this is the same string
   * as the transcript's filename, the id in the Sessions list, and the id
   * `liveSessions()` reports. Nothing has to be reconciled anywhere.
   */
  id: string
  sessionId: string
  cwd: string
  repo: string | null
  permissionMode: PermissionMode
  /** `--resume <id>` rather than a fresh session. */
  resumed: boolean
  /** False means it was already running and we simply reattached. */
  started: boolean
  briefSent: boolean
  /**
   * False means Claude Code has never been told this directory is trusted, so
   * it will ask before the session starts. Wake reads that flag and never
   * writes it — answering is the operator's, and the terminal is real enough
   * for him to.
   */
  trusted: boolean
  route: string
  socket: string
  cols: number
  rows: number
  createdAt: number
  /** Browsers attached right now. Two is normal: a laptop and a phone. */
  clients: number
}

export type Available = {
  ok: boolean
  tmux: boolean
  python: boolean
  claude: boolean
  /** A sentence naming what is missing, or null when nothing is. */
  missing: string | null
}

export type OpenTerminal = {
  /** Start from a Wake brief. Everything else is read off the pack row. */
  packId?: string
  /** The edited brief. Becomes the stored copy, the file on disk and the message. */
  brief?: string
  /** Resume this session. It must already exist on this machine. */
  sessionId?: string | null
  /** A repository name or absolute path, for a new conversation. */
  cwd?: string | null
  permissionMode?: PermissionMode
  /** Which model to start on. Absent or `default` passes no `--model` at all. */
  model?: SessionModel
  cols?: number
  rows?: number
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/claude${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await r.json().catch(() => ({}))
  // The server's own sentence, not a status code. Every refusal in
  // `terminal.ts` names what was refused and why, and that is what belongs in a
  // toast — "400" is not something anybody can act on.
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `${r.status}`)
  return body as T
}

export const terminalApi = {
  open: (b: OpenTerminal) => req<Terminal>('/terminals', { method: 'POST', body: JSON.stringify(b) }),
  list: () => req<{ terminals: Terminal[]; available: Available }>('/terminals'),
  /**
   * 200 with nulls rather than a 404, so a page reached from a stale link can
   * say "that session finished" instead of rendering an error wall.
   */
  get: (id: string) =>
    req<{ terminal: Terminal | null; session: { id: string; title: string; cwd: string; project: string; branch: string | null } | null }>(
      `/terminals/${encodeURIComponent(id)}`,
    ),
  close: (id: string) =>
    req<{ ok: true; closed: boolean }>(`/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/** Where a session lives in this app. One place builds it. */
export const terminalRoute = (id: string) => `/terminal/${id}`

/**
 * The socket URL, built from the page's own origin.
 *
 * `location.origin` rather than anything configured: the public URL is a
 * Cloudflare tunnel in front of Caddy, and a hard-coded host would be wrong on
 * `localhost:5173` during development and wrong again the day the tunnel moves.
 * `https:` → `wss:` is the only substitution, and getting it backwards is a
 * mixed-content error the browser refuses without explaining.
 */
export function terminalSocketUrl(id: string, size?: { cols: number; rows: number }): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const q = size ? `?cols=${size.cols}&rows=${size.rows}` : ''
  return `${proto}//${window.location.host}/api/claude/terminals/${encodeURIComponent(id)}/socket${q}`
}

/**
 * Open a session and go there. This is the one to call.
 *
 * Two steps that must not be separated: a route that starts a process and a
 * navigation that shows it. Splitting them across callers is how you get a
 * session running on the box that nobody is looking at — which is `claude -p`
 * again, and the whole reason this product stopped doing that.
 *
 * It throws on refusal, carrying the server's sentence, so a caller's `catch`
 * can put it straight in a toast.
 */
export async function openTerminalAndGo(b: OpenTerminal): Promise<Terminal> {
  const t = await terminalApi.open(b)
  navigate(t.route)
  return t
}
