/**
 * Claude Code sessions on this box. Metadata only — Wake reads the JSONL
 * transcripts for titles, timing and PR links, and never sends them anywhere.
 *
 * Laptop sessions are deliberately not synced, and Cursor / the Claude chat app
 * are deliberately not included, per the brief.
 */
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import {
  CLAUDE_HOME, CLAUDE_PROJECTS_DIR, FETCH_LEGACY_RUN_DIR, FETCH_RUN_DIR, LOOKBACK_DAYS,
} from '../env'
import { extractRefsFromElidable, subjectRef } from '../dedup'
import { sessionInRepo } from '../../shared/sessionRepo'
import { NotConnected, type RawCard, type SourceAdapter } from './types'
import { titleWithoutBrief, withoutBrief } from '../claudecode/nestedBrief'

/** Transcripts run to several MB; only the tail is needed for current state. */
const TAIL_BYTES = 512 * 1024
/**
 * A smaller tail for the *list*.
 *
 * A list needs four things off each transcript — where it ran, the branch, the
 * last prompt and roughly how much has happened — and all four are within a few
 * kilobytes of the end. Measured over a year of history on this machine — 221
 * transcripts — the full tail costs 1,532ms and this one costs 284ms. The card
 * pile and `sessionExcerpt` keep the full tail, because they quote content
 * rather than describe it.
 */
const LIST_TAIL_BYTES = 96 * 1024
const MAX_SESSIONS = 24
/**
 * Sessions age out faster than other sources. The full lookback over every
 * transcript surfaced 60 sessions at once, which buries the handful you are
 * actually mid-way through — and nobody is waiting on any of them.
 */
const SESSION_WINDOW_DAYS = 7
/** One prompt and no follow-up is a question, not work in progress. */
const MIN_TURNS = 2
/** "However far back this machine goes" — used when a session is named by id. */
const ALL_HISTORY_DAYS = 3650
/**
 * The tail the conversation page reads.
 *
 * Bigger than the list's because this one renders content, smaller than the
 * excerpt's 512K because it is parsed into structure on the way and a phone is
 * scrolling the result. 256K is roughly the last hundred exchanges on this
 * machine's transcripts, which is more than anyone scrolls back through.
 */
const TURNS_TAIL_BYTES = 256 * 1024

function readTail(path: string, bytes: number): string {
  const size = statSync(path).size
  const start = Math.max(0, size - bytes)
  const len = size - start
  if (len <= 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    const text = buf.toString('utf8')
    // A partial first line would fail to parse; drop it when we seeked.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(fd)
  }
}

type SessionInfo = {
  id: string
  project: string
  cwd: string | null
  title: string | null
  lastPrompt: string | null
  pr: { url: string; repo: string; number: number } | null
  lastTs: number
  userTurns: number
  /** The git branch the last recorded turn was on. */
  branch: string | null
  /** The Claude Code version that wrote the last turn, e.g. `2.1.247`. */
  version: string | null
  /** Where the session was started from: `claude-desktop`, `cli`, … */
  entrypoint: string | null
  /** The mode that session was actually running under, e.g. `bypassPermissions`. */
  permissionMode: string | null
}

/**
 * Scan only the record types we care about. The prefix test avoids JSON.parse on
 * the overwhelming majority of lines (assistant/attachment blobs), which is what
 * keeps a poll over ~200 transcripts cheap.
 */
function parseSession(
  path: string, id: string, project: string, mtime: number, tailBytes = TAIL_BYTES,
): SessionInfo {
  const info: SessionInfo = {
    id, project, cwd: null, title: null, lastPrompt: null, pr: null,
    lastTs: mtime, userTurns: 0,
    branch: null, version: null, entrypoint: null, permissionMode: null,
  }

  let text: string
  try { text = readTail(path, tailBytes) } catch { return info }

  for (const line of text.split('\n')) {
    if (line.length < 12 || line.charCodeAt(0) !== 123 /* { */) continue
    const isMeta =
      line.includes('"custom-title"') || line.includes('"last-prompt"') ||
      line.includes('"pr-link"') || line.includes('"summary"')
    const isUser = line.includes('"type":"user"') || line.includes('"type": "user"')
    if (!isMeta && !isUser) continue

    let d: any
    try { d = JSON.parse(line) } catch { continue }

    switch (d.type) {
      case 'custom-title': if (d.customTitle) info.title = d.customTitle; break
      case 'summary': if (d.summary) info.title ??= d.summary; break
      case 'last-prompt': if (d.lastPrompt) info.lastPrompt = d.lastPrompt; break
      case 'pr-link':
        if (d.prUrl) info.pr = { url: d.prUrl, repo: d.prRepository ?? '', number: d.prNumber ?? 0 }
        break
      case 'user':
        info.userTurns++
        if (d.cwd) info.cwd = d.cwd
        // Only a turn that carries a real prompt records these; a `tool_result`
        // user record has none of them. So each is assigned when present rather
        // than defaulted, and the last turn that knew wins — which is the
        // branch you are on and the mode you are running under *now*.
        if (d.gitBranch) info.branch = d.gitBranch
        if (d.version) info.version = d.version
        if (d.entrypoint) info.entrypoint = d.entrypoint
        if (d.permissionMode) info.permissionMode = d.permissionMode
        break
    }
  }
  return info
}

/** Strip the harness noise that leaks into a raw prompt so titles read cleanly. */
function cleanPrompt(s: string | null): string | null {
  if (!s) return null
  // A session started from a Wake brief has that brief as its last prompt, and
  // this is the one function every card's title and excerpt goes through. Cut it
  // here and Wake stops printing its own paperwork back to itself in three
  // places at once: the row title, the detail pane's body, and the next brief
  // that quotes this session. The nested-brief defence existed and ran only on
  // the way out; this is the way in.
  const own = withoutBrief(s)
  if (!own) return null
  const cleaned = own
    .replace(/<[^>]+>/g, ' ')
    .replace(/^Caveat:.*?response\.?/is, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 2 ? cleaned : null
}

/**
 * Turn a raw prompt into a title. A blunt slice(0, 80) produced things like
 * "…HTTP 500 + \"retryable\" — permanent invalid_" — cut mid-word, and leading
 * list markers left titles starting with "- ". Cut on a word boundary instead,
 * and prefer the first sentence when there is a short one.
 */
/**
 * A session's name, in order of preference, with Wake's own words removed from
 * every candidate. A transcript started from a brief records that brief's title,
 * and it arrived on the desk as `Acme sync stopped Packed by Wake`.
 */
function titleOf(recorded: string | null, prompt: string | null, project: string): string {
  const named = recorded ? titleWithoutBrief(recorded) : ''
  if (named) return named
  const fromPrompt = prompt ? titleFromPrompt(prompt) : ''
  if (fromPrompt) return fromPrompt
  return `Session in ${project}`
}

function titleFromPrompt(prompt: string, limit = 72): string {
  let t = prompt.replace(/^[\s*\-–—•>#.]+/, '').trim()

  const firstSentence = t.match(/^(.{16,}?[.!?])(\s|$)/)?.[1]
  if (firstSentence && firstSentence.length <= limit) return firstSentence.replace(/[.!?]$/, '')

  if (t.length <= limit) return t
  const cut = t.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  // Only honour the word boundary if it is not absurdly early.
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:–—-]+$/, '') + '…'
}

/** Cut on a word boundary, and say so — never silently mid-word. */
function clip(s: string | null | undefined, max: number): string | undefined {
  if (!s) return undefined
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:–—-]+$/, '') + '…'
}

/* ------------------------- Wake's own transcripts -------------------------- */

/**
 * Claude Code files a transcript by the directory the run started in, with every
 * separator flattened to a dash: `/home/me/work/app` becomes `-home-me-work-app`
 * and `.claude-worktrees` becomes `-claude-worktrees`.
 */
const projectDirOf = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/**
 * The directories Wake's own Fetch collections run in.
 *
 * Fetch spawns `claude` and that run writes a transcript like any other, so
 * without this the desk read Wake's own collections back as "you left this
 * open" — one new card per connector per press, and the two that were live on
 * the deployed board were Wake quoting its own Slack question.
 *
 * The test is the directory, not the prompt. Prompt text is rewritten;
 * `FETCH_RUN_DIR` is where the process is started from, and a card cannot be
 * made from a transcript this never lists.
 */
const RUN_CWDS = [FETCH_RUN_DIR, FETCH_LEGACY_RUN_DIR]
const RUN_PROJECTS = new Set(RUN_CWDS.map(projectDirOf))

/**
 * Whether a transcript is one of Wake's own runs.
 *
 * Two ways of asking the same question, because they fail differently: the
 * project directory is free (a filename), and the recorded `cwd` is
 * authoritative (the transcript's own word for where it ran).
 */
export const isWakeRun = (o: { project?: string; cwd?: string | null }): boolean =>
  (!!o.project && RUN_PROJECTS.has(o.project)) || (!!o.cwd && RUN_CWDS.includes(o.cwd))

/* --------------------------- shared session scan -------------------------- */

export type SessionFile = { path: string; id: string; project: string; mtime: number }

/** Whether the transcript directory this source reads exists and is readable. */
export function claudeProjectsReadable(): boolean {
  try { readdirSync(CLAUDE_PROJECTS_DIR); return true } catch { return false }
}

/**
 * Transcript files in the window, newest first. Nothing is opened here — a
 * readdir and a stat each — which is what lets `sessionExcerpt` look one up by
 * id over all of history without parsing two hundred transcripts to find it.
 *
 * **One level deep, deliberately, and this needs saying because the shape of
 * `~/.claude/projects` invites the opposite.** Of 545 `.jsonl` files on this box
 * only 113 sit at `<project>/<id>.jsonl`; the other 432 are two and four levels
 * further down, under `<project>/<id>/subagents/agent-*.jsonl` — and a few of
 * those have `subagents/` of their own.
 *
 * Those are not sessions. They are the private transcripts of subagents spawned
 * *inside* one session, and recursing to collect them would put five rows on the
 * Sessions page for one conversation, none of them resumable and none of them
 * anything he started. It is the same rule `parseSessionTurns` already keeps
 * when it drops `isSidechain` records (DECISIONS #40): a subagent's conversation
 * is not a second conversation.
 *
 * The directory is still reached where it *should* be — `sessionFilePaths`
 * returns `<project>/<id>` beside `<project>/<id>.jsonl`, so deleting a session
 * takes its subagents with it rather than orphaning them. Both halves are pinned
 * in `test/sessions.test.ts`.
 */
export function sessionFiles(windowDays: number): SessionFile[] {
  let projects: string[]
  try { projects = readdirSync(CLAUDE_PROJECTS_DIR) } catch { return [] }

  // The caller's window is honoured as given. Clamping it to LOOKBACK_DAYS here
  // meant `sessionExcerpt`'s "all history" and the launcher's 30 both silently
  // became 14, so a three-week-old session the user could see on disk came back
  // as "no such session on this machine".
  const cutoff = Date.now() - windowDays * 864e5
  const files: SessionFile[] = []

  for (const p of projects) {
    // Wake's own collections, before a single file is opened. Every caller of
    // this function — the card pile, the launcher's picker, the excerpt lookup —
    // gets the exclusion, because none of them wants to offer you a transcript
    // of Wake asking Slack a question on your behalf.
    if (isWakeRun({ project: p })) continue
    let entries: string[]
    try { entries = readdirSync(`${CLAUDE_PROJECTS_DIR}/${p}`) } catch { continue }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const path = `${CLAUDE_PROJECTS_DIR}/${p}/${f}`
      let mtime: number
      try { mtime = statSync(path).mtimeMs } catch { continue }
      if (mtime < cutoff) continue
      files.push({ path, id: f.replace(/\.jsonl$/, ''), project: p, mtime })
    }
  }

  files.sort((a, b) => b.mtime - a.mtime)
  return files
}

export function scanSessions(limit = MAX_SESSIONS, windowDays = SESSION_WINDOW_DAYS): Array<{ file: SessionFile; info: SessionInfo }> {
  return sessionFiles(windowDays)
    .slice(0, limit)
    .map(file => ({ file, info: parseSession(file.path, file.id, file.project, file.mtime) }))
    // The second half of the same exclusion, against the transcript's own record
    // of where it ran rather than against the name of the directory it is filed
    // under. The filename encoding is Claude Code's; `cwd` is the fact. It runs
    // after the cap rather than before it because `sessionFiles` has already
    // dropped these by path — parsing every transcript on the machine to keep
    // the cap exact would undo what the cap is for.
    .filter(({ info }) => !isWakeRun({ cwd: info.cwd }))
}

/**
 * Where a session ran, and what to call that place.
 *
 * The transcript's own `cwd` is the fact. The directory it is *filed* under is
 * Claude Code's encoding of that fact, and the encoding is lossy: every
 * non-alphanumeric becomes a dash, so `-Users-yuvrajmuley-work-truto-app` is
 * `/Users/yuvrajmuley/work/truto-app` and `/Users/yuvrajmuley/work/truto/app`
 * equally, and there is no way to tell from the name which. The old
 * `replace(/^-/,'/').replace(/-/g,'/')` picked the second every time, which
 * filed every dashed repository under a directory that does not exist — and the
 * live `/state` response has sessions filed under `-Users-yuvrajmuley-work-truto`
 * whose recorded `cwd` is `/Users/yuvrajmuley/work/wake`, so the name is not
 * even reliably the same directory.
 *
 * With no recorded `cwd` the raw filed name is returned unchanged. It is not a
 * path and does not pretend to be one; a wrong path is worse than an ugly name.
 */
function placeOf(info: SessionInfo, file: SessionFile): { cwd: string; project: string } {
  const cwd = info.cwd ?? file.project
  return { cwd, project: info.cwd ? basename(cwd) || file.project : file.project }
}

export type SessionRow = {
  id: string
  title: string
  cwd: string
  project: string
  lastPrompt: string | null
  /**
   * User turns **in the tail that was read**, not in the session. Transcripts
   * run to several megabytes and only `TAIL_BYTES` of each is opened, so this
   * is a floor. Every surface that renders it says `turns in view`.
   */
  turns: number
  lastTs: number
  path: string
  pr: { url: string; repo: string; number: number } | null
  branch: string | null
  version: string | null
  entrypoint: string | null
  permissionMode: string | null
}

function rowOf(file: SessionFile, info: SessionInfo): SessionRow {
  const { cwd, project } = placeOf(info, file)
  const prompt = cleanPrompt(info.lastPrompt)
  return {
    id: info.id,
    title: titleOf(info.title, prompt, project),
    cwd,
    project,
    lastPrompt: prompt,
    turns: info.userTurns,
    lastTs: info.lastTs,
    path: file.path,
    pr: info.pr,
    branch: info.branch,
    version: info.version,
    entrypoint: info.entrypoint,
    permissionMode: info.permissionMode,
  }
}

/** Session metadata in the shape the launcher's picker and tools want. */
export function listSessions(limit = 30, windowDays = 30): SessionRow[] {
  return scanSessions(limit, windowDays).map(({ file, info }) => rowOf(file, info))
}

/**
 * Every session in the window, not the newest `limit` files in it.
 *
 * `scanSessions` slices *before* parsing (242-244), which is right for the card
 * pile — it wants the newest handful and nothing else. It is wrong for a page
 * whose whole job is "show me my sessions in this repository": the newest 24
 * files on this machine come from three or four directories, so every other
 * repository looked empty however far back you looked.
 *
 * The cost of removing the slice is bounded rather than ignored. Files arrive
 * newest-first, and the loop stops as soon as `limit` rows have been *accepted*
 * — so a repo filter still walks until it has filled a page, and an unfiltered
 * read still parses only a page's worth of tails.
 *
 * `repo` names one repository and everything inside it — `sessionInRepo`, the
 * same function the browser filters with, from `src/shared/sessionRepo.ts`.
 * Two wrong answers were shipped before it: a substring test over `cwd` +
 * `project`, which answered `?repo=truto` with `truto-app`, `truto-monitoring`
 * and `truto-skills`; and then an exact match on the recorded directory, which
 * cured that by making `truto-app/packages/web` a repository called `web`. The
 * rule is exact-or-under, it is written down once, and `test/sessions.test.ts`
 * asserts that this function's answer *equals* what that predicate selects from
 * the same rows — which is what stops this side drifting from the other again.
 */
export function listAllSessions(
  opts: { windowDays?: number; repo?: string; limit?: number } = {},
): SessionRow[] {
  const { windowDays = 30, repo, limit = 200 } = opts
  // Empty is "no repository asked about", not "a repository named nothing".
  // Case is folded inside the predicate, so the wanted name is kept as typed.
  const wanted = repo?.trim() || null

  const out: SessionRow[] = []
  for (const file of sessionFiles(windowDays)) {
    const info = parseSession(file.path, file.id, file.project, file.mtime, LIST_TAIL_BYTES)
    // The second half of the Wake-run exclusion, against the transcript's own
    // record of where it ran rather than the name it is filed under.
    if (isWakeRun({ cwd: info.cwd })) continue
    const row = rowOf(file, info)
    if (wanted && !sessionInRepo(row, wanted)) continue
    out.push(row)
    if (out.length >= limit) break
  }
  return out
}

/**
 * The sessions Claude Code is running **right now**, newest first.
 *
 * This is the Sessions list, and it is a different question from the one
 * `listAllSessions` answers. That one walks transcripts, and a transcript is a
 * *record* — it survives the process that wrote it by weeks. Listing those was
 * the bug: Wake showed thirty dead conversations, he tapped one, and Claude
 * Code on his phone said the session was archived. It was right. Wake had
 * handed it a corpse.
 *
 * So the list is built from the other end. `liveSessions()` reads the
 * per-process files Claude Code keeps while a session is actually up, and only
 * those ids get a transcript read at all. The set is small by construction —
 * seventeen on this box against a hundred and thirty transcripts — which is
 * also why the window is all of history rather than thirty days: a session
 * started six weeks ago and still open is exactly the one you must not drop.
 *
 * There is no archive flag to consult, and this is not a guess. Claude Code
 * 2.1.251 writes none: fifty-four thousand transcript records on this box carry
 * no `archived` key, and there is no sidecar next to the JSONL. What it does
 * publish is the inverse, and it is authoritative — `claude agents --json`
 * prints *active* sessions and needs `--all` to include finished ones. This
 * function is that same answer read from the same files, without the subprocess.
 */
export function listActiveSessions(opts: { repo?: string; limit?: number } = {}): SessionRow[] {
  const { repo, limit = 100 } = opts
  const wanted = repo?.trim() || null
  const live = liveSessions()
  if (live.size === 0) return []

  // One readdir for the whole set rather than one per id: `sessionFiles` is the
  // expensive half of this and it does not get cheaper by being called 17 times.
  const byId = new Map(sessionFiles(ALL_HISTORY_DAYS).map(f => [f.id, f]))

  const out: SessionRow[] = []
  for (const [id, l] of live) {
    const file = byId.get(id)
    // Live with no transcript yet — a session started seconds ago. It is real
    // and it is his, so it is listed from what the process file already knows
    // rather than withheld until the first turn lands.
    if (!file) {
      if (isWakeRun({ cwd: l.cwd })) continue
      const row: SessionRow = {
        id, title: l.name || basename(l.cwd) || 'New session', cwd: l.cwd,
        project: basename(l.cwd) || l.cwd, lastPrompt: null, turns: 0,
        lastTs: l.startedAt, path: '', pr: null, branch: null,
        version: null, entrypoint: null, permissionMode: null,
      }
      if (!wanted || sessionInRepo(row, wanted)) out.push(row)
      continue
    }
    const info = parseSession(file.path, file.id, file.project, file.mtime, LIST_TAIL_BYTES)
    if (isWakeRun({ cwd: info.cwd })) continue
    const row = rowOf(file, info)
    if (wanted && !sessionInRepo(row, wanted)) continue
    out.push(row)
  }

  out.sort((a, b) => b.lastTs - a.lastTs)
  return out.slice(0, limit)
}

/**
 * Whether Claude Code will still let you work in this session.
 *
 * The one gate every path that *starts* something goes through — the launcher's
 * picker, the pack, the session page's composer. `false` means the id may not
 * be resumed, packed, or named in a link, because the thing on the other end of
 * it is a transcript rather than a conversation.
 */
export const isSessionActive = (id: string): boolean => liveSessions().has(id)

/* --------------------------------- turns ---------------------------------- */

export type SessionTurn = {
  role: 'user' | 'assistant'
  text: string
  ts: number
  /** Tools the assistant reached for in this turn, for the collapsed chip. */
  tools: string[]
}

/**
 * One session's transcript as a conversation.
 *
 * `sessionExcerpt` already walked these records, but it returns one blob of
 * text for a brief to quote. A page that renders turns needs them apart — who
 * said it, when, and what the tool calls were — so this returns the structure
 * and `sessionExcerpt` keeps the string. Two readers of one file, neither
 * pretending to be the other.
 *
 * What is deliberately dropped:
 *
 * * **Sidechains.** `isSidechain` marks a subagent's own conversation, which is
 *   filed in the same transcript. Rendering those inline turns one conversation
 *   into five interleaved ones.
 * * **`tool_result` user records.** Claude Code files a tool's *output* as a
 *   user turn. It is not something he said, and showing it as his own message
 *   is how a transcript starts reading like a terminal.
 * * **Empty assistant turns.** A turn that was only a tool call has no prose;
 *   its tools ride on the next turn that does rather than drawing a blank bubble.
 *
 * The tail is read rather than the file: transcripts reach several megabytes and
 * this is on the path of a phone opening a page. `after` is an epoch
 * millisecond, so polling asks for what it has not seen without holding an index
 * that a tail read would invalidate.
 */
export function parseSessionTurns(
  id: string, opts: { after?: number; limit?: number; tailBytes?: number } = {},
): { found: boolean; cwd?: string; turns: SessionTurn[] } {
  const { after = 0, limit = 200, tailBytes = TURNS_TAIL_BYTES } = opts
  const hit = sessionFiles(ALL_HISTORY_DAYS).find(f => f.id === id)
  if (!hit) return { found: false, turns: [] }

  let text: string
  try { text = readTail(hit.path, tailBytes) } catch { return { found: false, turns: [] } }

  const turns: SessionTurn[] = []
  let cwd: string | undefined
  let pending: string[] = []

  for (const line of text.split('\n')) {
    if (line.length < 12 || line.charCodeAt(0) !== 123 /* { */) continue
    if (!line.includes('"user"') && !line.includes('"assistant"')) continue

    let d: any
    try { d = JSON.parse(line) } catch { continue }
    if (d.type !== 'user' && d.type !== 'assistant') continue
    if (d.isSidechain) continue
    if (d.cwd) cwd = d.cwd

    const content = d.message?.content
    let body = ''
    let isToolResult = false
    if (typeof content === 'string') {
      body = content
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') body += block.text
        else if (block.type === 'tool_use' && block.name) pending.push(String(block.name))
        else if (block.type === 'tool_result') isToolResult = true
      }
    }
    if (isToolResult && !body.trim()) continue

    body = (d.type === 'user' ? cleanPrompt(body) : body)?.trim() ?? ''
    if (!body) continue

    const ts = Date.parse(d.timestamp ?? '') || hit.mtime
    if (ts <= after) { pending = []; continue }

    turns.push({
      role: d.type,
      text: body,
      ts,
      tools: d.type === 'assistant' ? pending : [],
    })
    pending = []
  }

  return { found: true, cwd, turns: turns.slice(-limit) }
}

/**
 * One session, by id, over all of history.
 *
 * By filename, so naming a session costs one `readdir` and one tail read rather
 * than a parse of everything in the window — the same reasoning as
 * `sessionExcerpt`, which is the other place a session is named rather than
 * listed. The window bounds the *list*; it does not decide what you may open
 * once you have named it.
 */
export function getSession(id: string): SessionRow | null {
  const hit = sessionFiles(ALL_HISTORY_DAYS).find(f => f.id === id)
  if (!hit) return null
  const info = parseSession(hit.path, hit.id, hit.project, hit.mtime)
  return isWakeRun({ cwd: info.cwd }) ? null : rowOf(hit, info)
}

/* ------------------------------ live sessions ----------------------------- */

export type LiveSession = { pid: number; name: string | null; cwd: string; startedAt: number }

/**
 * The sessions running on this box right now.
 *
 * Claude Code writes one `sessions/<pid>.json` per live process, carrying the
 * pid, the session id, the cwd it started in and a messaging socket path. It is
 * the only reliable "running right now" signal — a transcript's mtime says a
 * session was *written to* recently, which a finished session also satisfies.
 *
 * The socket is deliberately not touched. Wake reads this directory and nothing
 * else in it; writing to another process's control socket is a way to start
 * work, and Wake starts nothing.
 */
export function liveSessions(): Map<string, LiveSession> {
  const out = new Map<string, LiveSession>()
  let entries: string[]
  try { entries = readdirSync(`${CLAUDE_HOME}/sessions`) } catch { return out }

  for (const e of entries) {
    if (!e.endsWith('.json')) continue
    let d: any
    try { d = JSON.parse(readFileSync(`${CLAUDE_HOME}/sessions/${e}`, 'utf8')) } catch { continue }
    if (!d?.sessionId) continue
    out.set(String(d.sessionId), {
      pid: Number(d.pid) || 0,
      name: typeof d.name === 'string' ? d.name : null,
      cwd: typeof d.cwd === 'string' ? d.cwd : '',
      startedAt: Number(d.startedAt) || 0,
    })
  }
  return out
}

/* -------------------------------- deletion -------------------------------- */

/**
 * The four places one session physically lives.
 *
 * Returned as paths rather than deleted here so the confirmation dialog can
 * name them. Every one of these is under `~/.claude`, outside Wake's own
 * `DATA_DIR` — `file-history/<uuid>` in particular is Claude Code's edit-undo
 * history for real source files, which is why this is the one delete in the
 * product that asks you to type something.
 *
 * A path is listed whether or not it exists: "these are the places" is the
 * question this answers, and `deleteSession` reports which ones were actually
 * there.
 */
export function sessionFilePaths(id: string): string[] {
  const hit = sessionFiles(ALL_HISTORY_DAYS).find(f => f.id === id)
  return [
    ...(hit ? [hit.path, hit.path.replace(/\.jsonl$/, '')] : []),
    `${CLAUDE_HOME}/session-env/${id}`,
    `${CLAUDE_HOME}/file-history/${id}`,
  ]
}

export type DeleteResult = { removed: string[]; kept: string[]; error?: string }

/**
 * Delete a session's files. Irreversible, and refused while it is running.
 *
 * Unlinking the transcript of a live session does not stop it — the process
 * keeps its file descriptor and keeps appending to a file with no name, so you
 * lose the history of a conversation that is still going. The live check is
 * what makes that impossible rather than merely discouraged.
 */
export function deleteSession(id: string): DeleteResult {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return { removed: [], kept: [], error: 'that is not a session id' }
  const live = liveSessions().get(id)
  if (live) {
    return {
      removed: [], kept: [],
      error: `that session is running right now (pid ${live.pid}) — close it first`,
    }
  }

  const removed: string[] = []
  const kept: string[] = []
  for (const p of sessionFilePaths(id)) {
    try {
      statSync(p)
    } catch {
      continue // never there is not a failure to remove it
    }
    try {
      rmSync(p, { recursive: true, force: true })
      removed.push(p)
    } catch {
      kept.push(p)
    }
  }
  return { removed, kept }
}

/**
 * The last few exchanges of one transcript, as plain text.
 *
 * Session bodies are your own words. Nothing calls this on a timer; it exists so
 * a brief can quote work already underway when you choose to attach it.
 */
export function sessionExcerpt(id: string, maxChars = 12_000): { found: boolean; cwd?: string; text?: string } {
  // A session named by id is looked up over all of history, by filename. The
  // window exists to keep the *list* short, not to decide what the user is
  // allowed to open once they have named it.
  const hit = sessionFiles(ALL_HISTORY_DAYS).find(f => f.id === id)
  if (!hit) return { found: false }

  let raw: string
  try { raw = readTail(hit.path, TAIL_BYTES) } catch { return { found: false } }

  let cwd: string | undefined
  const lines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.charCodeAt(0) !== 123) continue
    let d: any
    try { d = JSON.parse(line) } catch { continue }
    if (d.type !== 'user' && d.type !== 'assistant') continue
    // The transcript carries its own working directory, so this one file is all
    // that has to be read.
    if (d.cwd) cwd = d.cwd
    const content = d.message?.content
    const text = Array.isArray(content)
      ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
      : typeof content === 'string' ? content : ''
    if (!text.trim()) continue
    lines.push(`${d.type === 'user' ? 'You' : 'Claude'}: ${text.trim()}`)
  }

  const text = lines.join('\n\n')
  return {
    found: true,
    cwd,
    text: text.length > maxChars ? text.slice(-maxChars) : text,
  }
}

export const claudeSessions: SourceAdapter = {
  name: 'claude',
  label: 'Claude Code',

  async status() {
    try {
      const n = readdirSync(CLAUDE_PROJECTS_DIR).length
      return { ok: true, detail: `${n} project${n === 1 ? '' : 's'} on this machine`, via: 'filesystem' }
    } catch {
      return { ok: false, detail: `no ${CLAUDE_PROJECTS_DIR} on this machine` }
    }
  },

  async fetch() {
    // A directory that is not there is not an empty one. Both produce zero
    // sessions; only the second is a poll that actually happened.
    if (!claudeProjectsReadable()) throw new NotConnected('claude')

    const cards: RawCard[] = []
    // The card pile is the one caller that wants the poll lookback applied.
    const window = Math.min(LOOKBACK_DAYS, SESSION_WINDOW_DAYS)
    /*
     * Which of these is running right now, from Claude Code's own per-process
     * files rather than from a transcript's mtime.
     *
     * The two are genuinely different facts and the desk needs both. An mtime
     * says a session was *written to* recently, which a finished session
     * satisfies just as well as a live one — so "he came back to this five
     * minutes ago and it is still open" had no representation anywhere in the
     * card pile, and a session becoming live again moved nothing. `activity_at`
     * in `api.ts` reads `meta.live_at` for exactly that trigger.
     */
    const live = liveSessions()

    for (const { file: f, info: s } of scanSessions(MAX_SESSIONS, window)) {
      const running = live.get(s.id) ?? null

      // A stub or a one-shot question is not work you are in the middle of —
      // unless it is open on this machine at this moment, which settles the
      // question the turn count was being used to guess at.
      if (!running && s.userTurns < MIN_TURNS && !s.title) continue

      const { cwd, project: projectName } = placeOf(s, f)
      const prompt = cleanPrompt(s.lastPrompt)
      const title = titleOf(s.title, prompt, projectName)

      const ageDays = (Date.now() - s.lastTs) / 864e5
      const subjectOfTitle = subjectRef(title)
      cards.push({
        source: 'claude',
        source_id: s.id,
        kind: 'session',
        title,
        // Nobody else is blocked on a session, so these are never "now".
        //
        // No number in here. `why` is written at ingest and frozen in the row,
        // so any age baked into it drifts on its own between polls — and it was
        // rounded while the age beside it on the row is floored, so twelve of
        // sixteen rows read "you left this 2d ago … 1d": two ages for one
        // instant, inside one sentence. There is one age per instant, and the
        // When column is where it lives.
        why: ageDays < 1 ? 'you were just working on this' : 'you left this open',
        excerpt: clip(prompt, 400),
        // A local session has no web URL; the card offers the command that
        // rejoins it on the machine it is actually on.
        url: s.pr?.url ?? `wake:claude/${s.id}`,
        ts: s.lastTs,
        pile: 'open',
        // A session that opened a PR is the same thing as that PR's card. The
        // title is included as a second route to the same merge, because only
        // some sessions record a pr-link — without it, two sessions on one PR
        // showed up as two cards.
        refs: [
          ...(s.pr?.repo && s.pr.number
            ? [{ t: 'gh' as const, v: `${s.pr.repo}#${s.pr.number}`.toLowerCase() }]
            : []),
          ...(subjectOfTitle ? [subjectOfTitle] : []),
          // Prompts routinely paste the PR they are about
          // ("approve — Backend: github.com/trutohq/truto/pull/2008"), which is
          // a hard reference to that PR whether or not the session recorded a
          // pr-link.
          //
          // `title` is Wake's own truncation of that prompt, and `prompt` is
          // clipped too. A GitHub URL cut by either is not a reference to
          // anything — `.../pull/2…` once produced `gh:trutohq/truto#2`, a PR
          // that does not exist, which then won the group label over the real
          // one and hid a whole session.
          ...extractRefsFromElidable(`${title}\n${prompt ?? ''}`),
        ],
        meta: {
          project: projectName,
          // Named explicitly rather than left to be re-derived from source_id: a
          // card whose group merged with a PR no longer has the session id in
          // its group key, and the resume command still needs it.
          session_id: s.id,
          cwd,
          branch: s.branch,
          /*
           * Open on this machine right now, and since when.
           *
           * `live_at` is the process's own start time rather than `Date.now()`,
           * which matters for the sort: a live session re-stamped on every poll
           * would pin itself to the top of the desk for as long as it stayed
           * open, and would say "just now" about a conversation nobody has
           * touched since breakfast. The start time is fixed for the life of the
           * process, so the row moves up once — when the session became live —
           * and then sits still.
           */
          live: !!running,
          live_at: running?.startedAt || null,
          // The mode it was actually last running under, so the brief can say
          // so rather than assume. Wake's own default is a separate claim.
          permission_mode: s.permissionMode,
          /*
           * No `resume_cmd` here, deliberately.
           *
           * This used to carry `claude --resume <id>` and the detail pane
           * printed it for him to copy into a terminal he had to go and find.
           * A session is reachable from the browser now — `/terminal/<id>`, on
           * a laptop and on a phone — so a shell line is both redundant and the
           * worse of the two answers, and a card that offers it is a card
           * teaching the wrong route. `session_id` above is what a link is
           * built from, and it is all the UI needs.
           */
          turns: s.userTurns,
          pr: s.pr,
        },
      })
    }
    return cards
  },
}
