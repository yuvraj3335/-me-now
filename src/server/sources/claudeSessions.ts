/**
 * Claude Code sessions on this box. Metadata only — Wake reads the JSONL
 * transcripts for titles, timing and PR links, and never sends them anywhere.
 *
 * Laptop sessions are deliberately not synced, and Cursor / the Claude chat app
 * are deliberately not included, per the brief.
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { basename } from 'node:path'
import { CLAUDE_PROJECTS_DIR, LOOKBACK_DAYS } from '../env'
import type { RawCard, SourceAdapter } from './types'

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
  const cleaned = s
    .replace(/<[^>]+>/g, ' ')
    .replace(/^Caveat:.*?response\.?/is, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 2 ? cleaned : null
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
    let projects: string[]
    try { projects = readdirSync(CLAUDE_PROJECTS_DIR) } catch { return [] }

    const cutoff = Date.now() - Math.min(LOOKBACK_DAYS, SESSION_WINDOW_DAYS) * 864e5
    const files: Array<{ path: string; id: string; project: string; mtime: number }> = []

    for (const p of projects) {
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

    const cards: RawCard[] = []
    for (const f of files.slice(0, MAX_SESSIONS)) {
      const s = parseSession(f.path, f.id, f.project, f.mtime)

      // A stub or a one-shot question is not work you are in the middle of.
      if (s.userTurns < MIN_TURNS && !s.title) continue

      const cwd = s.cwd ?? f.project.replace(/^-/, '/').replace(/-/g, '/')
      const projectName = basename(cwd) || f.project
      const prompt = cleanPrompt(s.lastPrompt)
      const title = s.title ?? prompt?.slice(0, 80) ?? `Session in ${projectName}`

      const ageDays = (Date.now() - s.lastTs) / 864e5
      cards.push({
        source: 'claude',
        source_id: s.id,
        kind: 'session',
        title,
        // Nobody else is blocked on a session, so these are never "now".
        why: ageDays < 1 ? 'you were just working on this' : `you left this ${Math.round(ageDays)}d ago`,
        excerpt: prompt?.slice(0, 240),
        // No web URL exists for a local session; the UI offers the resume command.
        url: s.pr?.url ?? `wake:claude/${s.id}`,
        ts: s.lastTs,
        pile: 'open',
        // A session that opened a PR is the same thing as that PR's card.
        refs: s.pr?.repo && s.pr.number
          ? [{ t: 'gh', v: `${s.pr.repo}#${s.pr.number}`.toLowerCase() }]
          : [],
        meta: {
          project: projectName,
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
