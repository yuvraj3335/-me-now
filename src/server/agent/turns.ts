/**
 * The turn manager.
 *
 * A turn is one run of the Wake Agent, narrated into the durable event log.
 * Everything the UI shows is a replay of that log, so a turn survives a reload,
 * a lost connection and a server restart — the browser is a viewer, never the
 * owner.
 *
 * The engine is the Anthropic SDK (`engine.ts`), not the `claude` binary. That
 * split is deliberate and load-bearing: because Wake runs the tool loop itself,
 * a mutating tool can *block* on a human inside the call. See DECISIONS.md #14.
 */

import { db, now, uid } from '../db'
import { AGENT_STALL_MS, AGENT_TIMEOUT_MS } from '../env'
import { emit, foldSegments } from './events'
import { cancelForTurn } from './approvals'
import { getMode, type ModeId } from './modes'
import { runEngine } from './engine'
import { keyStatus } from './key'
import { routeSkills } from '../skills/route'
import { loadSkill } from '../skills/catalog'
import { SAFETY_PROMPT } from './guard'
import { getRepo } from '../registry/scan'
import { remoteStatus } from './remote'
import { mailCapabilities } from '../mail/gmail'
import { launcherStatus } from '../claudecode/launch'

type Running = { ctl: AbortController }
const running = new Map<string, Running>()

export const isRunning = (turnId: string) => running.has(turnId)

/* ------------------------------ the prompt -------------------------------- */

function buildSystemPrompt(opts: {
  mode: ModeId
  routing: ReturnType<typeof routeSkills>
  profile: string | null
  repoPath: string | null
}): string {
  const mode = getMode(opts.mode)
  const parts: string[] = [
    `You are Wake's operations agent for Truto. Current mode: ${mode.label} — ${mode.blurb}`,
    '',
    '## What this mode is for',
    mode.workflow,
    '',
    SAFETY_PROMPT,
    '',
    '## Working method',
    `Search the repository registry (repo_search) before naming any repository, and the skill index
(skill_search / skill_load) before following a playbook. Do not load skills you do not need.

State which Truto team and profile you are operating in before touching platform data.

Prefer one precise call over three speculative ones. When a tool returns an
error, read it — the CLI's messages are specific and usually name the fix.

You cannot edit files or run arbitrary commands. When a task needs that, build a
launch pack (claude_launch) and hand it to Claude Code on this machine, which
has the repositories, the Truto CLI and its own permission model.`,
  ]

  /* Skills chosen before the first token, with the rule that chose them. */
  const preload = [opts.routing.baseline, opts.routing.specialist, ...opts.routing.forced].filter(
    (v): v is string => !!v,
  )
  if (preload.length) {
    parts.push('', '## Skills loaded for you')
    for (const id of preload) {
      const s = loadSkill(id)
      if (!s) continue
      parts.push(
        '',
        `### ${s.id}`,
        s.references.length ? `References available via skill_reference: ${s.references.join(', ')}` : '',
        s.body,
      )
    }
    parts.push('', `These were selected because: ${opts.routing.rules.join('; ')}.`)
  }

  if (opts.routing.repoRules.length) {
    parts.push(
      '',
      `## Mandatory rule files`,
      `A launch pack for this work must name these: ${opts.routing.repoRules.join(', ')}. They override a session's defaults.`,
    )
  }

  if (opts.profile) parts.push('', `## Truto profile\nThis conversation is pinned to profile "${opts.profile}".`)
  if (opts.repoPath) {
    const r = getRepo(opts.repoPath)
    if (r) {
      parts.push(
        '',
        `## Repository`,
        `${r.name} at ${r.path} (branch ${r.branch}, ${r.dirty} uncommitted file(s)).`,
        r.role === 'worktree' ? `This is a WORKTREE of ${r.upstream}, not a separate product.` : '',
        `Rule files: ${r.claude_md.join(', ') || 'none'}.`,
        `Verification: ${Object.entries(r.commands).map(([k, v]) => `${k} = ${v}`).join(', ') || 'none detected'}.`,
      )
    }
  }

  /* Honest connector status — the brief forbids hiding an unavailable source. */
  const gaps: string[] = []
  const remote = remoteStatus()
  if (!remote.platform.configured && mode.tools.some(t => t.startsWith('platform_'))) gaps.push('Platform MCP')
  if (!remote.monitoring.configured && mode.tools.some(t => t.startsWith('monitoring_'))) gaps.push('truto-monitoring MCP')
  const mail = mailCapabilities()
  if (!mail.connected && mode.tools.some(t => t.startsWith('mail_'))) {
    gaps.push(`Gmail (${mail.reason ?? 'not connected'})`)
  }
  const launcher = launcherStatus()
  if (!launcher.ok && mode.tools.includes('claude_launch')) gaps.push(`Claude Code (${launcher.reason})`)

  if (gaps.length) {
    parts.push(
      '',
      `## Unavailable in this deployment`,
      `${gaps.join('; ')}. If a question needs one of these, say so plainly — do not describe what it would have returned.`,
    )
  }

  return parts.filter(p => p !== '').join('\n')
}

/* -------------------------------- history --------------------------------- */

/**
 * Prior turns, as plain user/assistant text.
 *
 * Tool blocks are deliberately not replayed. Re-sending them would mean
 * reconstructing exact tool_use/tool_result id pairs across restarts, and the
 * failure mode is a 400 that kills the conversation rather than a slightly
 * thinner context — the same class of bug that stuck Truto's own assistant.
 * What a follow-up needs is what was concluded, and that is the text.
 */
const HISTORY_MESSAGES = 24
const HISTORY_CHARS = 60_000

function historyFor(convId: string) {
  // Newest first, so the character budget is spent on the most recent exchange
  // and the older tail is what falls off.
  const newestFirst = db
    .query<{ role: string; body: string }, [string, number]>(
      `SELECT role, body FROM messages WHERE conv_id = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(convId, HISTORY_MESSAGES)

  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  let chars = 0
  for (const r of newestFirst) {
    const body = (r.body ?? '').trim()
    if (!body) continue
    if (chars + body.length > HISTORY_CHARS) break
    chars += body.length
    out.unshift({ role: r.role === 'user' ? 'user' : 'assistant', content: body })
  }

  // Roles must alternate. A turn that was cancelled or errored before producing
  // text still writes an assistant row, with an empty body that the loop above
  // skips — which leaves two user messages adjacent. Merging beats dropping:
  // the second message is the one the user actually asked.
  const merged: typeof out = []
  for (const m of out) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`
    else merged.push(m)
  }
  // The API also rejects a leading assistant message.
  while (merged.length && merged[0]!.role === 'assistant') merged.shift()
  return merged
}

/* -------------------------------- starting -------------------------------- */

export type StartTurn = { convId: string; prompt: string; mode?: ModeId }

export function startTurn(opts: StartTurn): { turnId: string } {
  const conv = db
    .query<Record<string, any>, [string]>(`SELECT * FROM conversations WHERE id = ?`)
    .get(opts.convId)
  if (!conv) throw new Error('no such conversation')
  if (!keyStatus().present) {
    throw new Error(
      'The Wake Agent has no Anthropic API key. Add one in Settings → Agent — it is a different credential from the `claude` CLI that "Open in Claude Code" uses.',
    )
  }

  const mode: ModeId = opts.mode ?? conv.mode
  const turnId = uid()
  const at = now()

  const routing = routeSkills({ mode, prompt: opts.prompt, repoPath: conv.repo_path })

  db.query(
    `INSERT INTO turns (id, conv_id, state, mode, prompt, started_at, heartbeat_at)
     VALUES (?,?,'running',?,?,?,?)`,
  ).run(turnId, opts.convId, mode, opts.prompt, at, at)

  // History is read BEFORE the new user message is stored, so the prompt is not
  // duplicated as both history and the live turn.
  const history = historyFor(opts.convId)

  // Persist the user's message immediately so a crash before the first token
  // still leaves a conversation that reads correctly.
  const seq =
    (db.query<{ n: number | null }, [string]>(`SELECT MAX(seq) AS n FROM messages WHERE conv_id = ?`)
      .get(opts.convId)?.n ?? -1) + 1
  db.query(`INSERT INTO messages (id, conv_id, seq, role, body, created_at) VALUES (?,?,?,'user',?,?)`)
    .run(uid(), opts.convId, seq, opts.prompt, at)
  db.query(`UPDATE conversations SET updated_at = ?, mode = ? WHERE id = ?`).run(at, mode, opts.convId)

  emit(turnId, 'start', { mode, prompt: opts.prompt })
  emit(turnId, 'skills', {
    routed: [routing.baseline, routing.specialist, ...routing.forced].filter(Boolean),
    rules: routing.rules,
  })

  void run(turnId, opts.convId, mode, opts.prompt, conv, routing, history)
  return { turnId }
}

async function run(
  turnId: string,
  convId: string,
  mode: ModeId,
  prompt: string,
  conv: Record<string, any>,
  routing: ReturnType<typeof routeSkills>,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
) {
  const ctl = new AbortController()
  running.set(turnId, { ctl })

  const hardStop = setTimeout(() => ctl.abort(), AGENT_TIMEOUT_MS)
  hardStop.unref?.()

  /**
   * A stalled stream and a turn waiting on a human look identical from the
   * outside — both emit nothing for minutes. The difference is whether an
   * approval is pending, so the watchdog checks that before killing anything.
   * Without the check, every approval left open for five minutes would cancel
   * the very turn it was asked for.
   */
  const stall = setInterval(() => {
    const row = db
      .query<{ heartbeat_at: number }, [string]>(`SELECT heartbeat_at FROM turns WHERE id = ?`)
      .get(turnId)
    if (!row || Date.now() - row.heartbeat_at < AGENT_STALL_MS) return
    const waiting = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM approvals WHERE turn_id = ? AND state = 'pending'`,
      )
      .get(turnId)
    if ((waiting?.n ?? 0) > 0) return
    emit(turnId, 'notice', { text: 'No output for several minutes — stopping the turn.' })
    ctl.abort()
  }, 30_000)
  stall.unref?.()

  let result: Awaited<ReturnType<typeof runEngine>>
  try {
    result = await runEngine({
      turnId,
      convId,
      mode,
      profile: conv.profile ?? null,
      repoPath: conv.repo_path ?? null,
      model: conv.model ?? null,
      system: buildSystemPrompt({ mode, routing, profile: conv.profile ?? null, repoPath: conv.repo_path ?? null }),
      history,
      prompt,
      signal: ctl.signal,
    })
  } catch (e) {
    result = {
      state: ctl.signal.aborted ? 'cancelled' : 'error',
      text: '',
      error: (e as Error).message,
      usage: { input: 0, output: 0, cacheRead: 0, steps: 0 },
    }
  } finally {
    clearTimeout(hardStop)
    clearInterval(stall)
    running.delete(turnId)
  }

  finish(turnId, convId, result)
}

function finish(turnId: string, convId: string, result: Awaited<ReturnType<typeof runEngine>>) {
  cancelForTurn(turnId)

  db.query(
    `UPDATE turns SET state = ?, input_tokens = ?, output_tokens = ?,
                      num_turns = ?, error = ?, finished_at = ? WHERE id = ?`,
  ).run(
    result.state,
    result.usage.input || null,
    result.usage.output || null,
    result.usage.steps || null,
    result.error ? String(result.error).slice(0, 2_000) : null,
    now(),
    turnId,
  )

  if (result.state === 'error' && result.error) {
    emit(turnId, 'error', { text: String(result.error).slice(0, 2_000) })
  }
  if (result.state === 'cancelled') emit(turnId, 'cancelled', {})

  // The assistant message is folded from the event log rather than from the
  // accumulated text, so a reopened conversation shows tool cards and approvals
  // in the order they actually happened.
  const seq =
    (db.query<{ n: number | null }, [string]>(`SELECT MAX(seq) AS n FROM messages WHERE conv_id = ?`)
      .get(convId)?.n ?? -1) + 1
  db.query(
    `INSERT INTO messages (id, conv_id, seq, role, body, segments, created_at) VALUES (?,?,?,'assistant',?,?,?)`,
  ).run(uid(), convId, seq, result.text, JSON.stringify(foldSegments(turnId)), now())

  db.query(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now(), convId)
  emit(turnId, 'done', {
    state: result.state,
    steps: result.usage.steps,
    inputTokens: result.usage.input,
    outputTokens: result.usage.output,
  })

  autoTitle(convId)
}

/** First user message becomes the conversation title, trimmed to a line. */
function autoTitle(convId: string) {
  const conv = db.query<Record<string, any>, [string]>(`SELECT * FROM conversations WHERE id = ?`).get(convId)
  if (!conv || conv.title !== 'New conversation') return
  const first = db
    .query<{ body: string }, [string]>(
      `SELECT body FROM messages WHERE conv_id = ? AND role = 'user' ORDER BY seq LIMIT 1`,
    )
    .get(convId)
  if (!first?.body) return
  const title = first.body.replace(/\s+/g, ' ').trim().slice(0, 70)
  db.query(`UPDATE conversations SET title = ? WHERE id = ?`).run(
    title + (first.body.length > 70 ? '…' : ''),
    convId,
  )
}

export function cancelTurn(turnId: string): boolean {
  const r = running.get(turnId)
  if (!r) return false
  r.ctl.abort()
  // Anything blocking on a human is released too, otherwise "stop" leaves an
  // approval card on screen that nothing is listening to.
  cancelForTurn(turnId)
  return true
}

/**
 * At boot, any turn still marked running belongs to a process this restart
 * killed. Marking them interrupted keeps history honest — the alternative is a
 * conversation that claims to be thinking forever.
 */
export function recoverInterrupted(): number {
  const rows = db.query<{ id: string }, []>(`SELECT id FROM turns WHERE state = 'running'`).all()
  for (const r of rows) {
    db.query(`UPDATE turns SET state = 'interrupted', error = ?, finished_at = ? WHERE id = ?`)
      .run('Wake restarted while this turn was running', now(), r.id)
    emit(r.id, 'error', { text: 'Wake restarted while this turn was running. Ask again to continue.' })
    emit(r.id, 'done', { state: 'interrupted' })
  }
  return rows.length
}
