/**
 * A live Claude Code session, on this box, reachable from a phone.
 *
 * This file corrects an earlier call that was right about
 * the facts and wrong about the conclusion: `claude.ai/new?q=` really does open a
 * *new* conversation and really cannot target an existing one — so Wake stopped
 * there and shipped a link to the Claude **chat** product, plus a `claude
 * --resume …` line for the operator to find a terminal and paste. Which meant
 * the button labelled "Open in Claude" opened the one surface that has neither
 * his repository, nor his tools, nor the session he was actually in.
 *
 * The missing step was never a URL. It was a terminal.
 *
 *     browser --ws--> Bun --pipes--> ptybridge.py --pty--> tmux --> claude
 *
 * Each link in that chain is there because the one before it cannot do the job:
 *
 *   **tmux** owns the session's life. It is what makes closing the tab harmless,
 *   what makes a laptop and a phone two views of one screen, and what makes a
 *   Wake restart a non-event for work already running. Wake holding the process
 *   itself would tie a conversation's lifetime to a web server's, which is the
 *   `claude -p` mistake in a nicer coat.
 *
 *   **ptybridge.py** owns the pseudo-terminal, because `tmux attach` refuses to
 *   run without a tty and node-pty delivers no bytes under Bun. See that file.
 *
 *   **Bun** owns nothing but the relay and the rules. Which repositories may be
 *   named, which sessions may be resumed, and what a caller is allowed to put on
 *   a command line — all of which is this file's real subject.
 *
 * The security posture is a whitelist in three parts, and it is worth stating
 * plainly because "start a process" is the most dangerous verb in this product:
 *
 *   1. The **command** is never supplied by a caller. It is `CLAUDE_BIN` and a
 *      fixed set of flags built here. There is no field in any request body that
 *      reaches argv except the brief, which `claude` reads as a prompt.
 *   2. The **directory** comes from `resolveCwd` — the registry — or, for a
 *      resume, from the session's own transcript, bounded to `WORKSPACE_ROOT`.
 *   3. The **session** must already exist, read through the same
 *      `sources/claudeSessions.ts` the Sessions page reads.
 *
 * And one thing Wake deliberately does *not* do: it never writes
 * `hasTrustDialogAccepted` into `~/.claude.json`. A directory Claude Code has
 * not seen before makes it ask whether the project is trusted, and the answer to
 * that question is the operator's. What Wake does instead is say so on the way
 * in — `trusted: false` on the response — so the screen he lands on tells him
 * there is a prompt waiting rather than leaving him staring at one.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  CLAUDE_BIN, CLAUDE_CONFIG_PATH, PYTHON_BIN, TERMINAL_COLS, TERMINAL_NAME_PREFIX,
  TERMINAL_ROWS, TERMINAL_SIZE_DIR, TERMINAL_TMUX_SOCKET, TMUX_BIN, WORKSPACE_ROOT,
} from '../env'
import { getRepo } from '../registry/scan'
import { getSession, isSessionActive } from '../sources/claudeSessions'
import {
  DEFAULT_PERMISSION_MODE, PERMISSION_MODES, resolveCwd, type PermissionMode,
  DEFAULT_SESSION_MODEL, SESSION_MODELS, type SessionModel,
} from './launch'

/* ------------------------------- identity --------------------------------- */

/**
 * A Claude Code session id, and nothing else.
 *
 * Every id in this file — the one in a request body, the one in a tmux name, the
 * one in a URL — is a session uuid, because `--session-id` lets Wake *choose*
 * the id it is about to create. That is the single decision that makes the whole
 * feature line up: the id the browser routes on, the id in the transcript's
 * filename, the id `liveSessions()` reports and the id the Sessions page already
 * shows are one string, so nothing has to be reconciled anywhere.
 *
 * The shape is checked rather than trusted. This value becomes a tmux target and
 * a filename, so "looks like a uuid" is the boundary between a session id and an
 * argument.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isSessionId = (v: unknown): v is string =>
  typeof v === 'string' && SESSION_ID.test(v)

/** The tmux session that holds one Claude Code session. */
export function tmuxNameFor(sessionId: string): string | null {
  return isSessionId(sessionId) ? `${TERMINAL_NAME_PREFIX}${sessionId.toLowerCase()}` : null
}

/**
 * The inverse, used to read `list-sessions` back.
 *
 * Anything on Wake's tmux socket that does not spell out a session id is not a
 * terminal this API knows how to describe, and is skipped rather than guessed
 * at. In practice nothing else is ever there — the socket is Wake's alone — but
 * a list that can only contain well-formed rows is a list no caller can be
 * surprised by.
 */
export function sessionIdFromTmuxName(name: string): string | null {
  if (!name.startsWith(TERMINAL_NAME_PREFIX)) return null
  const id = name.slice(TERMINAL_NAME_PREFIX.length)
  return isSessionId(id) ? id : null
}

/**
 * The session id a given thing opens into, derived rather than remembered.
 *
 * A pack is opened from three places — the sheet's Open, `POST /terminals` with
 * a `packId`, and a reload of either — and all three used to mint a fresh uuid,
 * so the pack had no identity in tmux and no way to recognise its own session.
 * Hashing the pack's id into a uuid gives it one, for free, with nothing to
 * store and nothing to clean up: the same pack always maps to the same tmux
 * name, so "is this already open" is a question tmux can answer.
 *
 * The digest is truncated to 128 bits and stamped with the version-5 nibbles so
 * the result is a well-formed uuid — `isSessionId` has to accept it, because it
 * is about to become a `--session-id`, a filename and a tmux target.
 */
export function derivedSessionId(seed: string): string {
  const h = new Bun.CryptoHasher('sha256').update(`wake:session:${seed}`).digest('hex')
  const b = (i: number, n: number) => h.slice(i, i + n)
  const ver = `5${b(13, 3)}`
  const variant = ((parseInt(b(16, 2), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return `${b(0, 8)}-${b(8, 4)}-${ver}-${variant}${b(18, 2)}-${b(20, 12)}`
}

/** Where the session lives in the app, and where its bytes come from. */
export const terminalRoute = (id: string) => `/terminal/${id}`
export const terminalSocketPath = (id: string) => `/api/claude/terminals/${id}/socket`

/* ------------------------------ the command ------------------------------- */

/**
 * The argv Wake will run, built from a closed set of parts.
 *
 * Exported because it is the single place a caller's input becomes a command
 * line, so it is the single thing worth testing directly. Everything variable in
 * it is either an id whose shape has been checked, a mode from a two-item list,
 * or the brief.
 *
 * **The brief is fenced off with `--`, and that sentence used to be wrong.**
 * This comment claimed a positional argument "cannot become a flag however it is
 * written", and it was not true. Measured against the installed binary:
 *
 *     $ claude -p --wake-probe-flag
 *     error: unknown option '--wake-probe-flag'
 *     $ claude -p --model … -- --wake-probe-flag
 *     (parsed as the prompt; the run failed on the model instead)
 *
 * `POST /api/claude/sessions/new` takes free text and passes it here, so a first
 * message beginning with a dash was reaching Claude Code's option parser. The
 * cheap half of that is a message that starts with a list marker killing the
 * session before it starts, with "the session exited immediately" as the only
 * explanation. The expensive half is that `--allow-dangerously-skip-permissions`
 * is a real single-token flag on this binary, which makes "the command is never
 * supplied by a caller" — invariant 1 in this file's own header — false for
 * anyone who can post a brief.
 *
 * `--` ends option parsing, which is the fix, and it is the whole fix: after it
 * every remaining argument is positional whatever it spells. There is still no
 * field anywhere in this API for "extra arguments".
 *
 * **The brief goes in as argv rather than typed into the composer.** Both work —
 * pasting the pack file through `tmux load-buffer` was measured landing a full
 * multi-line markdown brief with its newlines intact. Argv wins because Claude
 * Code owns the ordering: the trust dialog and the "this session is 6d old"
 * resume dialog both come *first*, and the queued prompt is submitted after they
 * are answered. Pasting requires Wake to decide, by reading the screen, whether
 * a dialog is up — and getting that wrong means a brief typed into a menu and an
 * Enter that picks whatever was highlighted. Screen-scraping another product's
 * chrome to decide when to press a key is not a thing to build on purpose.
 *
 * **Wake submits it; it does not leave a draft.** The read-and-approve moment
 * already happened and was already paid for — the sheet renders the brief, he
 * edits it, and pressing Open is the approval. Leaving the text sitting unsent
 * in the composer would ask the same question a second time, and on a phone it
 * asks it through a soft keyboard. "The brief is the first message the session
 * receives" is the requirement; a draft is not a message.
 */
/**
 * The most a brief may be, because `execve` has an opinion about it.
 *
 * A single argument is capped at `MAX_ARG_STRLEN` — 32 pages, so 131,072 bytes
 * on every Linux this runs on — and the brief is one argument. Past that the
 * exec fails with E2BIG, tmux reports it as "no reason given", and the operator
 * gets "the session did not start" about a message he can see on his own screen.
 *
 * A packed brief is a few kilobytes and cannot reach this; `POST /sessions/new`
 * takes free text and can. The bound is stated in characters rather than bytes
 * on purpose — it is what the composer counts, so the refusal and the thing he
 * is looking at are in the same units — and it is set well under the real limit
 * so that a brief of multi-byte characters cannot cross it either.
 */
export const MAX_BRIEF_CHARS = 100_000

export function claudeArgv(o: {
  sessionId: string
  resume: boolean
  permissionMode: PermissionMode
  model?: SessionModel
  brief?: string | null
}): string[] {
  const argv = [CLAUDE_BIN, '--permission-mode', o.permissionMode]
  // `default` is the absence of the flag rather than a value for it: Claude Code
  // chooses for itself when `--model` is missing, which is what respects
  // whatever the operator has configured. See `parseSessionModel`.
  if (o.model && o.model !== 'default') argv.push('--model', o.model)
  argv.push(o.resume ? '--resume' : '--session-id', o.sessionId)
  // An empty brief is no brief. `claude ""` would submit a blank first turn.
  // `--` goes in with it rather than unconditionally: with no brief there is no
  // positional argument to fence, and a bare trailing `--` is noise in a
  // command line somebody may read out of an audit line.
  if (o.brief && o.brief.trim()) argv.push('--', o.brief)
  return argv
}

/* -------------------------------- tmux ------------------------------------ */

/**
 * Wake's own tmux, configured by a file rather than by the operator's.
 *
 * `-f` matters more than it looks. Without it the server would read
 * `~/.tmux.conf`, and a personal config that sets a status bar, rebinds a key or
 * turns on mouse mode would change what the browser renders and what a keystroke
 * does — silently, and only on this machine. The conf is written on every start
 * so a change here takes effect on the next new server rather than whenever the
 * file happened to be created.
 */
const confPath = () => `${TERMINAL_SIZE_DIR}/tmux.conf`

const TMUX_CONF = [
  // Escape must arrive as Escape. tmux's default 500ms wait exists to
  // disambiguate a real Escape from the start of an arrow-key sequence, and it
  // is exactly wrong here: cancelling out of a Claude Code prompt is one of the
  // handful of keys this feature exists to deliver, and the browser has already
  // told us which one was pressed.
  'set -s escape-time 0',
  // No status bar. tmux steals a row for it, the browser is not a tmux client
  // the operator drives, and a green strip across the bottom of a session he
  // reached from a phone is chrome for a program he did not ask to see.
  'set -g status off',
  // The window follows whichever client last interacted. With a laptop and a
  // phone attached at once the alternative — sizing to the smallest — would let
  // an idle phone in a pocket squeeze the laptop he is typing on.
  'set -g window-size latest',
  // `screen-256color` rather than `tmux-256color`: the second is the better
  // terminfo and is not present on every box, and a missing entry makes tmux
  // refuse to start the server at all. RGB is declared as a feature instead,
  // which is what actually carries Claude Code's true-colour output.
  'set -g default-terminal "screen-256color"',
  'set -as terminal-features ",*:RGB"',
  // Enough scrollback to read back a long tool run, bounded so a forgotten
  // session cannot grow without limit.
  'set -g history-limit 20000',
  // Claude Code asks for this by name — it prints "add 'set -g focus-events on'
  // … for focus tracking" into its own pane when it is off. It is how the TUI
  // knows the reader has looked away, and xterm.js sends the events.
  'set -g focus-events on',
  // Mouse mode stays off, deliberately. It would put tmux between a tap and the
  // program, and its wheel binding enters copy-mode — a second modal state, on a
  // phone, that nothing on screen explains how to leave. Scrollback belongs to
  // xterm.js, which already has a viewport a thumb can drag.
].join('\n') + '\n'

function tmuxArgs(args: string[]): string[] {
  return [TMUX_BIN, '-L', TERMINAL_TMUX_SOCKET, '-f', confPath(), ...args]
}

type Ran = { ok: boolean; out: string; err: string }

/**
 * A PATH the session can actually work in.
 *
 * Wake runs as a systemd *user* unit, and a user unit does not get a login
 * shell's PATH — it gets systemd's default, which is `/usr/local/bin:/usr/bin`
 * and little else. Everything Wake itself needs is named by absolute path
 * (`CLAUDE_BIN`, `TMUX_BIN`, `bun`), so nothing here ever noticed; but the tmux
 * server inherits this environment and so does every process Claude Code starts
 * underneath it.
 *
 * What that cost, measured on the deployed site: `node` lives in `~/.volta/bin`,
 * so Claude Code's own `UserPromptSubmit` hook failed with
 * `/bin/sh: 1: node: not found` — twice, in red, above the first answer of every
 * session started from Wake. The hooks are non-blocking, so the session worked
 * and simply looked broken, which is the worse failure of the two.
 *
 * The tmux *server* takes its environment once, from whichever call happens to
 * start it, so this is applied on every tmux invocation rather than only on
 * `new-session`. Order matters: the operator's own directories go in front, so a
 * volta shim wins over a system node, exactly as it does in his shell.
 */
const TOOL_DIRS = [
  `${homedir()}/.truto/bin`,
  `${homedir()}/.bun/bin`,
  `${homedir()}/.volta/bin`,
  `${homedir()}/.local/bin`,
]

function sessionEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  const seen = new Set<string>()
  const path = [...TOOL_DIRS, ...(env.PATH ?? '').split(':')]
    .filter(p => p && !seen.has(p) && (seen.add(p), true))
    .join(':')
  return { ...env, PATH: path }
}

function tmux(args: string[], stdin?: string): Ran {
  ensureDir()
  const [bin, ...rest] = tmuxArgs(args)
  const r = Bun.spawnSync([bin!, ...rest], {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: sessionEnv(),
  })
  return {
    ok: r.exitCode === 0,
    out: r.stdout.toString(),
    err: r.stderr.toString().trim(),
  }
}

/**
 * Written once per process, synchronously, before the first tmux call.
 *
 * Both halves of that matter. `Bun.write` returns a promise, and this function
 * is called from a synchronous path that spawns `tmux -f <conf>` immediately
 * afterwards — so an unawaited write is a race in which tmux reads a file that
 * is not there yet and silently starts a server with its defaults, status bar
 * and all. And rewriting it on every `list-sessions` — which is every `/state` —
 * is a file write per page load for a constant.
 */
let confWritten = false

function ensureDir() {
  mkdirSync(TERMINAL_SIZE_DIR, { recursive: true })
  // The flag is not enough on its own: `-f <conf>` naming a file that is not
  // there makes tmux refuse to start the server at all, and the flag would keep
  // claiming the file had been written for the life of the process. A stat is
  // cheaper than the write it usually saves, and it is the only thing standing
  // between a cleared data directory and every terminal surface answering
  // "nothing is running" forever.
  if (confWritten && existsSync(confPath())) return
  try {
    writeFileSync(confPath(), TMUX_CONF, 'utf8')
    confWritten = true
  } catch { /* tmux falls back to its own defaults, which still work */ }
}

/* ----------------------------- what is running ---------------------------- */

export type TerminalInfo = {
  /** The Claude Code session id. The terminal has no identity of its own. */
  id: string
  sessionId: string
  cwd: string
  repo: string | null
  permissionMode: PermissionMode
  /**
   * The model it was started on, or `null` for a session that predates the
   * option — which is not the same as `default`, and must not be shown as it.
   */
  model: SessionModel | null
  /** True when this was `--resume <id>` rather than a fresh `--session-id`. */
  resumed: boolean
  /** False means it was already running and we simply pointed the browser at it. */
  started: boolean
  /** Whether a brief was delivered as this call's doing. */
  briefSent: boolean
  /** False means Claude Code will ask about this directory before it starts. */
  trusted: boolean
  route: string
  socket: string
  cols: number
  rows: number
  createdAt: number
  /** Browsers attached right now. Two is normal: a laptop and a phone. */
  clients: number
}

/**
 * Six fields per session, read out of tmux rather than remembered.
 *
 * There is no `terminals` table on purpose. tmux already holds the only copy of
 * this state that can be right — a row saying "running" survives a process that
 * did not — and a second copy would be a thing to reconcile on every boot. The
 * same reasoning `liveSessions()` gives for reading Claude Code's own per-process
 * files instead of tracking sessions itself.
 */
/*
 * Eight fields, and two of them are Wake's own words written into tmux.
 *
 * `@wake-mode` and `@wake-model` are tmux user options, set on the session at
 * `new-session` and read back here. They exist because this row used to *assert*
 * `permissionMode: DEFAULT_PERMISSION_MODE` for every session tmux reported,
 * whatever it had actually been started with — so a session started under
 * `acceptEdits` was described as bypassing permissions on the one screen that is
 * meant to say what it may do without asking. The comment there conceded the
 * point and left the lie in place.
 *
 * Storing them in tmux rather than in a table keeps the rule this file is built
 * on: tmux already holds the only copy of this state that can be right, a row
 * saying "running" outlives a process that did not, and a second copy is a thing
 * to reconcile on every boot. A user option lives and dies with the session it
 * is set on, which is exactly the lifetime of the fact.
 */
const LIST_FORMAT = [
  '#{session_name}', '#{session_attached}', '#{window_width}',
  '#{window_height}', '#{session_created}', '#{session_path}',
  '#{@wake-mode}', '#{@wake-model}',
].join('\t')

function infoFrom(line: string): TerminalInfo | null {
  const [name, attached, width, height, created, path, mode, model] = line.split('\t')
  const id = name ? sessionIdFromTmuxName(name) : null
  if (!id) return null
  const cwd = path ?? ''
  return {
    id,
    sessionId: id,
    cwd,
    repo: getRepo(cwd)?.name ?? null,
    // What Wake started it with, read back off the session rather than assumed.
    // A session started before this option existed reports nothing, and the
    // default is then a guess rather than a claim — which is what it always was,
    // except that now it is only a guess in the one case where it has to be.
    permissionMode: PERMISSION_MODES.includes(mode as PermissionMode)
      ? mode as PermissionMode
      : DEFAULT_PERMISSION_MODE,
    model: SESSION_MODELS.includes(model as SessionModel) ? model as SessionModel : null,
    resumed: false,
    started: false,
    briefSent: false,
    trusted: isTrusted(cwd),
    route: terminalRoute(id),
    socket: terminalSocketPath(id),
    cols: Number(width) || TERMINAL_COLS,
    rows: Number(height) || TERMINAL_ROWS,
    // tmux reports seconds; every other timestamp in Wake is epoch ms.
    createdAt: (Number(created) || 0) * 1000,
    clients: Number(attached) || 0,
  }
}

/**
 * "no server running" is the resting state. Everything else tmux says is news.
 *
 * `list-sessions` exits non-zero for both, and this function used to answer the
 * empty list to either — so a socket directory that had gone unwritable, a tmux
 * that could not read its own config, or a server that refused to start looked
 * exactly like a quiet morning. Every terminal would silently disappear from
 * `/state`, the Open control would go on being offered, and nothing anywhere
 * would say why. That is the failure mode this product is least allowed to have,
 * living in the one function every terminal surface reads through.
 */
const NO_SERVER = /no server running|error connecting to|no such file or directory/i

export type TerminalScan = { terminals: TerminalInfo[]; error: string | null }

export function scanTerminals(): TerminalScan {
  if (!available().tmux) return { terminals: [], error: null }
  const r = tmux(['list-sessions', '-F', LIST_FORMAT])
  if (!r.ok) {
    return {
      terminals: [],
      error: NO_SERVER.test(r.err) || !r.err ? null : `tmux could not be read: ${r.err}`,
    }
  }
  return {
    terminals: r.out.split('\n').map(l => l.trim()).filter(Boolean)
      .map(infoFrom).filter((t): t is TerminalInfo => t !== null),
    error: null,
  }
}

export const listTerminals = (): TerminalInfo[] => scanTerminals().terminals

export function getTerminal(id: string): TerminalInfo | null {
  if (!isSessionId(id)) return null
  return listTerminals().find(t => t.id === id) ?? null
}

export const isRunning = (id: string): boolean => getTerminal(id) !== null

/* ------------------------------ availability ------------------------------ */

export type Available = {
  ok: boolean
  tmux: boolean
  python: boolean
  claude: boolean
  /** A sentence naming what is missing, or null when nothing is. */
  missing: string | null
}

/**
 * Whether this machine can start a session at all, answered before anything is
 * spawned.
 *
 * A 503 that names the missing binary is a diagnosable outage; a spawn that
 * fails somewhere inside tmux is a stack trace in a log nobody is reading. The
 * check is cheap — a `which` and a stat — and the answer is on `/state`, so the
 * button can be off rather than broken.
 */
export function available(): Available {
  // A stat rather than a subprocess. This runs on every `/state` and on every
  // start, and spawning `test -x` to answer "is there a file here" is a process
  // per page load for a question the kernel answers in place.
  const has = (bin: string) => {
    if (!bin) return false
    if (!bin.includes('/')) return Bun.which(bin) !== null
    try { accessSync(bin, constants.X_OK); return true } catch { return false }
  }
  const tmuxOk = has(TMUX_BIN)
  const pythonOk = has(PYTHON_BIN)
  const claudeOk = has(CLAUDE_BIN)
  const missing = [
    tmuxOk ? null : 'tmux',
    pythonOk ? null : 'python3',
    claudeOk ? null : 'the claude binary (WAKE_CLAUDE_BIN)',
  ].filter(Boolean)
  return {
    ok: tmuxOk && pythonOk && claudeOk,
    tmux: tmuxOk,
    python: pythonOk,
    claude: claudeOk,
    missing: missing.length
      ? `this machine cannot start a Claude Code session: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not available`
      : null,
  }
}

/* --------------------------------- trust ---------------------------------- */

/**
 * Has Claude Code been told this directory is trusted.
 *
 * One read of `~/.claude.json`, never a write. A `false` here is not a refusal —
 * the session starts fine — it is the difference between the operator landing on
 * a screen that says "answer the trust prompt" and landing on an unexplained
 * dialog he did not ask for. Unreadable config answers `false`, which errs
 * towards warning about a prompt that does not appear rather than staying quiet
 * about one that does.
 */
export function isTrusted(cwd: string): boolean {
  if (!cwd) return false
  try {
    const cfg = JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>
    }
    return cfg.projects?.[cwd]?.hasTrustDialogAccepted === true
  } catch {
    return false
  }
}

/* ------------------------------ where it runs ----------------------------- */

/**
 * The directory a resumed session runs in.
 *
 * A resume does not take a directory from the caller — it takes the one the
 * transcript recorded — but "not from the caller" is not the same as "safe", so
 * it is bounded anyway. `resolveCwd` covers the registry, and the second clause
 * covers the case the registry legitimately cannot: a session started in a
 * *subdirectory* of a repository (`truto-app/packages/web`) is real work in a
 * real checkout, and `getRepo` has never heard of it.
 *
 * The bound is `WORKSPACE_ROOT`, which is the same root the registry scans and
 * the same one `env.ts` says nothing outside may be named. `resolve` collapses
 * any `..` before the prefix test, so a recorded path cannot climb out of it.
 */
export function resolveSessionCwd(cwd: string | null | undefined):
  { ok: true; path: string; repo: string | null } | { ok: false; error: string } {
  const raw = cwd?.trim()
  if (!raw) return { ok: false, error: 'that session does not record where it ran, so there is nowhere to resume it' }

  const path = resolve(raw)
  const root = resolve(WORKSPACE_ROOT)

  /*
   * The workspace root is refused before anything else looks at it.
   *
   * `resolveCwd` answers the root as `{ ok: true, repo: null }` — deliberately,
   * because a *brief* is allowed not to be about one repository. Asking it first
   * therefore let the root straight through, which is how a live session ended
   * up at `cwd: /home/yuvraj/work` with no repo: the drawer that holds every
   * checkout and is itself none of them.
   */
  if (path === root) {
    return {
      ok: false,
      error: `that session recorded the workspace root (${WORKSPACE_ROOT}) as its directory, which is not a repository — there is nothing there to resume it in`,
    }
  }

  const direct = resolveCwd(raw)
  if (direct.ok) return direct

  // Under the workspace but unknown to the registry: a subdirectory of a real
  // checkout is real work, and bounding it by the root is what keeps it safe.
  if (path.startsWith(`${root}/`)) {
    return { ok: true, path, repo: getRepo(path)?.name ?? null }
  }
  return {
    ok: false,
    error: `that session ran in "${raw}", which is outside the workspace (${WORKSPACE_ROOT}) — Wake will not start a session there`,
  }
}

/* -------------------------------- starting -------------------------------- */

export type OpenInput = {
  /** Resume this session. It must already exist on this machine. */
  sessionId?: string | null
  /**
   * The id to give a *new* session, instead of a fresh random one.
   *
   * Not a way to reach an existing conversation — that is `sessionId`, and it
   * goes through the transcript allowlist and the liveness gate. This is the
   * opposite direction: the caller knows what it is about to create, so a second
   * request that is about the same thing lands on the same session rather than
   * starting a second Claude Code in the same repository.
   *
   * It exists because pressing Open twice did exactly that. `POST
   * /packs/:id/open` calls `openTerminal` with no id, `openTerminal` minted a
   * `randomUUID()` per call, and a double tap on a phone — where the first tap
   * gives no feedback until tmux has answered — started two sessions on one
   * brief and delivered the brief to both. `POST /sessions/new` fired twice did
   * the same. Deriving the id from the thing being opened makes the whole path
   * idempotent with no table to reconcile: the second call finds the tmux
   * session already up and reattaches to it.
   *
   * Shape-checked like every other id here, and ignored if it is not a uuid —
   * this becomes a tmux target and a filename, exactly as `sessionId` does.
   */
  newSessionId?: string | null
  /** A repository name or absolute path, for a new conversation. */
  cwd?: string | null
  /** The first message. Delivered as the process's prompt argument. */
  brief?: string | null
  permissionMode?: PermissionMode
  /** Which model to start on. `default` (or absent) passes no `--model` at all. */
  model?: SessionModel
  cols?: number
  rows?: number
  /** The pack file, when there is one, so a resend pastes the same artifact. */
  briefPath?: string | null
}

export type OpenFailure = { error: string; status: 400 | 409 | 503 }

const size = (v: unknown, fallback: number, max: number) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 8 && n <= max ? n : fallback
}

/**
 * Start a session, resume one, or point at the one that is already running.
 *
 * Three outcomes rather than two, and the third is the one that makes a phone
 * and a laptop work: asking for a session that is already up is not an error and
 * does not restart anything. It reattaches, which is what "reopening a brief"
 * has to mean once sessions outlive browsers.
 */
export function openTerminal(input: OpenInput): TerminalInfo | OpenFailure {
  /*
   * What was asked for is checked before whether this machine can do it.
   *
   * The availability check used to come first, which meant a box without tmux
   * answered "tmux is not available" to a request naming a repository that does
   * not exist — the less useful of the two true things, and the one he cannot
   * act on. It also meant no allowlist refusal was reachable without a working
   * tmux, so the tests that pin those refusals could not run without a machine
   * that can start real Claude Code sessions. Validate, then check, then spawn.
   */
  const mode = input.permissionMode ?? DEFAULT_PERMISSION_MODE
  const model = input.model ?? DEFAULT_SESSION_MODEL
  const cols = size(input.cols, TERMINAL_COLS, 500)
  const rows = size(input.rows, TERMINAL_ROWS, 300)

  // Refused here, in characters he can count, rather than at `execve` — which
  // answers E2BIG, which tmux reports as "no reason given", which arrives as
  // "the session did not start" about a message on his own screen.
  if (input.brief && input.brief.length > MAX_BRIEF_CHARS) {
    return {
      status: 400,
      error: `that brief is ${input.brief.length.toLocaleString()} characters and a session's first message ` +
        `cannot be more than ${MAX_BRIEF_CHARS.toLocaleString()} — the operating system will not carry it. ` +
        'Send the short version and attach the rest as context.',
    }
  }

  /* --- resuming a session that exists ------------------------------------ */
  if (input.sessionId) {
    const id = String(input.sessionId).toLowerCase()
    if (!isSessionId(id)) return { error: `"${input.sessionId}" is not a session id`, status: 400 }

    const running = getTerminal(id)
    if (running) {
      // Already up. Deliver the brief into the live composer and reattach —
      // there is no argv to put it in on a process that is already running.
      const sent = input.brief ? sendBrief(id, input.brief, input.briefPath) : false
      return { ...running, resumed: true, started: false, briefSent: sent }
    }

    // The allowlist for a resume is the Sessions surface itself: if that page
    // cannot see the session, this route will not start one. Which also means a
    // caller cannot invent an id and have Wake create a directory for it.
    const session = getSession(id)
    if (!session) return { error: `no session ${id} on this machine`, status: 400 }

    /*
     * And a transcript is not a conversation.
     *
     * `getSession` searches `ALL_HISTORY_DAYS` of transcripts, so on its own it
     * answers yes for every session that has ever run on this box — five
     * hundred of them here against nine that are up. That is the right
     * allowlist for *which directory* a resume may run in and the wrong one for
     * *whether* it may run at all, and the gap between those two was the whole
     * of the bug this gate closes: a card for a session that finished last week
     * still carries its id, `CardDetail` still offers to open it, and the id
     * went to `claude --resume`, which answered — on his phone, which is where
     * it was read — that the session had been archived.
     *
     * `isSessionActive` is the answer the rest of the product already gives to
     * this question. The list gives it, the launcher's picker gives it, and
     * `POST /sessions/:id/send` gives it in this same sentence; this route was
     * the one path that *starts* something and did not ask. Claude Code
     * publishes no archive flag to read — measured again on 2.1.251, zero
     * archive-shaped keys under `~/.claude` — so "is a process holding this
     * open" is the only honest question available, and it is the one every
     * other surface is already answering.
     *
     * The reattach above is deliberately in front of this and stays that way:
     * `getTerminal` reads tmux rather than memory, so a session Wake is holding
     * is reachable across a Wake restart, and that path never reaches `--resume`
     * at all.
     */
    if (!isSessionActive(id)) {
      return { error: 'that session is not running any more — start a new one', status: 409 }
    }

    const where = resolveSessionCwd(session.cwd)
    if (!where.ok) return { error: where.error, status: 400 }

    const ready = available()
    if (!ready.ok) return { error: ready.missing!, status: 503 }

    return spawn({ id, cwd: where.path, repo: where.repo, resume: true, mode, model, cols, rows, brief: input.brief })
  }

  /* --- a new conversation ------------------------------------------------ */
  const where = resolveCwd(input.cwd)
  if (!where.ok) return { error: where.error, status: 400 }

  /*
   * A session has to start *in* something, and the workspace root is not a
   * repository.
   *
   * `resolveCwd` answers `{ path: WORKSPACE_ROOT, repo: null }` for a brief that
   * named no repository, and for a brief that is right: "not about one
   * repository" is a real answer when the objects are a mail thread and a Slack
   * question. It is not a real answer for a process. Claude Code started in
   * `~/work` is sitting in a directory that contains eleven checkouts and is
   * itself none of them — no git, no project, nothing its tools can reason
   * about — and the first thing it does is guess which one he meant.
   *
   * Found on the deployed site: a session at `cwd: /home/yuvraj/work`,
   * `repo: null`, reached by pressing Open in Claude from a session row whose
   * own `cwd` was not in the registry. The sheet had fallen back to "Not about
   * one repository" and the fallback had been taken literally.
   *
   * So the refusal is here rather than in `resolveCwd`: the packer keeps its
   * answer, and only the thing that spawns a process insists on a real
   * directory. It names what to do about it, because the repository picker is
   * the first control on the sheet and he has just scrolled past it.
   */
  if (!where.repo) {
    return {
      status: 400,
      error: 'a session has to start in a repository, and none was chosen — ' +
        `"not about one repository" packs a brief but leaves nothing to open it in. ` +
        'Pick a repository at the top of the sheet.',
    }
  }

  // Wake chooses the id rather than discovering it afterwards. Without
  // `--session-id` the only way to learn what was created is to watch
  // `~/.claude/sessions` and guess by cwd and start time, which is a race with
  // every other session the operator might start in the same second.
  //
  // A caller that already knows what it is opening gets to name the id, which is
  // what makes a second press of the same button land on the first session
  // instead of beside it. See `newSessionId`.
  const id = isSessionId(input.newSessionId) ? input.newSessionId.toLowerCase() : randomUUID()

  const already = getTerminal(id)
  if (already) {
    // The same brief is not delivered twice. It went in as argv on the first
    // press and it is either on screen or in the composer; pasting it again
    // would submit the operator's message a second time to a session that is
    // already answering it.
    return { ...already, resumed: false, started: false, briefSent: false }
  }

  const ready = available()
  if (!ready.ok) return { error: ready.missing!, status: 503 }

  return spawn({
    id, cwd: where.path, repo: where.repo,
    resume: false, mode, model, cols, rows, brief: input.brief,
  })
}

function spawn(o: {
  id: string
  cwd: string
  repo: string | null
  resume: boolean
  mode: PermissionMode
  model: SessionModel
  cols: number
  rows: number
  brief?: string | null
}): TerminalInfo | OpenFailure {
  const name = tmuxNameFor(o.id)
  if (!name) return { error: `"${o.id}" is not a session id`, status: 400 }

  const argv = claudeArgv({
    sessionId: o.id, resume: o.resume, permissionMode: o.mode, model: o.model, brief: o.brief,
  })

  // Detached, so the session's life is tmux's business rather than this
  // request's. `-x`/`-y` matter for a detached session: with no client attached
  // tmux would size the window to 80x24 and Claude Code would lay its boxes out
  // against that until the first browser arrives.
  const r = tmux([
    'new-session', '-d', '-s', name,
    '-x', String(o.cols), '-y', String(o.rows), '-c', o.cwd,
    ...argv,
  ])
  if (!r.ok) return { error: `tmux refused to start the session: ${r.err || 'no reason given'}`, status: 409 }

  // Written after the session exists, and not fatal if it fails: these are how
  // the terminal describes itself later, and a session that runs without them
  // is a session Wake can only describe less precisely. Both values come from
  // closed lists, so there is nothing here a caller chose the spelling of.
  tmux(['set-option', '-t', name, '@wake-mode', o.mode])
  tmux(['set-option', '-t', name, '@wake-model', o.model])

  const started = getTerminal(o.id)
  if (!started) {
    return {
      error: 'the session exited immediately — check that the claude binary runs on this machine',
      status: 409,
    }
  }
  return {
    ...started,
    permissionMode: o.mode,
    model: o.model,
    resumed: o.resume,
    started: true,
    briefSent: !!(o.brief && o.brief.trim()),
    repo: o.repo,
  }
}

/**
 * Put a brief into a session that is already running.
 *
 * The only path where the composer has to be typed into, because a live process
 * has no argv left to give. `load-buffer` + `paste-buffer` rather than
 * `send-keys`: send-keys would deliver a multi-line markdown brief as a sequence
 * of keystrokes, and every newline in it would submit whatever was above.
 * A tmux buffer arrives as one paste with its newlines intact.
 *
 * `-d` deletes the buffer after pasting, so a brief does not sit in tmux's paste
 * stack where the next session could pick it up.
 *
 * When there is a pack file, it is pasted straight from disk. That is the
 * property `launch.ts` protects and it is worth keeping here: what the sheet
 * showed, what the file holds and what the session received are one artifact
 * rather than three copies that could differ.
 */
export function sendBrief(id: string, brief: string, briefPath?: string | null): boolean {
  const name = tmuxNameFor(id)
  if (!name || !brief.trim()) return false

  const loaded = briefPath
    ? tmux(['load-buffer', '-b', 'wake', briefPath])
    : tmux(['load-buffer', '-b', 'wake', '-'], brief)
  if (!loaded.ok) return false

  if (!tmux(['paste-buffer', '-d', '-b', 'wake', '-t', name]).ok) return false
  // Sent as its own call. A key and its Enter delivered together were measured
  // not registering reliably; the composer needs the paste to settle first.
  return tmux(['send-keys', '-t', name, 'Enter']).ok
}

/* -------------------------------- closing --------------------------------- */

/**
 * End the process, keep the conversation.
 *
 * Killing the tmux session sends the pane's process a HUP and Claude Code exits;
 * the transcript under `~/.claude/projects` is untouched, so the session is still
 * in the Sessions list and can be resumed later. This is deliberately not
 * `DELETE /sessions/:id`, which removes four directories under `~/.claude` and
 * asks a bound confirmation first.
 */
export function closeTerminal(id: string): { ok: true; closed: boolean } {
  const name = tmuxNameFor(id)
  if (!name || !isRunning(id)) return { ok: true, closed: false }
  return { ok: true, closed: tmux(['kill-session', '-t', name]).ok }
}

/* ------------------------------- attaching -------------------------------- */

/**
 * The command one browser runs to look at a session.
 *
 * `attach-session` rather than anything clever, because a tmux client is exactly
 * what a browser tab is: several may exist at once, each may leave without
 * affecting the others, and the session outlives all of them. `-t` names a
 * session whose id was shape-checked before it got here.
 */
export function attachArgv(o: { id: string; cols: number; rows: number; sizeFile: string }): string[] | null {
  const name = tmuxNameFor(o.id)
  if (!name) return null
  return [
    PYTHON_BIN, bridgePath(), String(o.cols), String(o.rows), o.sizeFile,
    ...tmuxArgs(['attach-session', '-t', name]),
  ]
}

/** Beside this module, so it moves with it and is not a path in a config. */
export const bridgePath = () => new URL('./ptybridge.py', import.meta.url).pathname

/** One size file per attachment, named for the socket rather than the session. */
export function sizeFileFor(token: string): string {
  ensureDir()
  return `${TERMINAL_SIZE_DIR}/${token}.size`
}
