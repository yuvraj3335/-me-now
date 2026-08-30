/**
 * Claude Code sessions on this box. Metadata only — Wake reads the JSONL
 * transcripts for titles, timing and PR links, and never sends them anywhere.
 *
 * Laptop sessions are deliberately not synced, and Cursor / the Claude chat app
 * are deliberately not included, per the brief.
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { basename } from 'node:path'
import {
  CLAUDE_PROJECTS_DIR, FETCH_LEGACY_RUN_DIR, FETCH_RUN_DIR, LOOKBACK_DAYS,
} from '../env'
import { extractRefsFromElidable, subjectRef } from '../dedup'
import { NotConnected, type RawCard, type SourceAdapter } from './types'
import { titleWithoutBrief, withoutBrief } from '../claudecode/nestedBrief'

/** Transcripts run to several MB; only the tail is needed for current state. */
const TAIL_BYTES = 512 * 1024
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
}

/**
 * Scan only the record types we care about. The prefix test avoids JSON.parse on
 * the overwhelming majority of lines (assistant/attachment blobs), which is what
 * keeps a poll over ~200 transcripts cheap.
 */
function parseSession(path: string, id: string, project: string, mtime: number): SessionInfo {
  const info: SessionInfo = {
    id, project, cwd: null, title: null, lastPrompt: null, pr: null,
    lastTs: mtime, userTurns: 0,
  }

  let text: string
  try { text = readTail(path, TAIL_BYTES) } catch { return info }

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

/** Session metadata in the shape the launcher's picker and tools want. */
export function listSessions(limit = 30, windowDays = 30) {
  return scanSessions(limit, windowDays).map(({ file, info }) => {
    const cwd = info.cwd ?? file.project.replace(/^-/, '/').replace(/-/g, '/')
    const prompt = cleanPrompt(info.lastPrompt)
    return {
      id: info.id,
      title: titleOf(info.title, prompt, basename(cwd) || file.project),
      cwd,
      project: basename(cwd) || file.project,
      lastPrompt: prompt,
      turns: info.userTurns,
      lastTs: info.lastTs,
      path: file.path,
      pr: info.pr,
    }
  })
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
    for (const { file: f, info: s } of scanSessions(MAX_SESSIONS, window)) {

      // A stub or a one-shot question is not work you are in the middle of.
      if (s.userTurns < MIN_TURNS && !s.title) continue

      const cwd = s.cwd ?? f.project.replace(/^-/, '/').replace(/-/g, '/')
      const projectName = basename(cwd) || f.project
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
          resume_cmd: `claude --resume ${s.id}`,
          turns: s.userTurns,
          pr: s.pr,
        },
      })
    }
    return cards
  },
}
