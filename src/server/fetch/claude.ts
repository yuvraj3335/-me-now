/**
 * The one place Wake starts a process that can reach a model.
 *
 * Wake holds no Anthropic key and runs no model in-process; migration 4 deleted
 * the tables that once made it an agent, and DECISIONS #26 said "Wake starts
 * nothing". This file reopens exactly one sentence of that decision, and
 * DECISIONS #31 writes down why: Fetch has to work when *Wake's* Slack login is
 * missing or refused, and the credential that reaches Slack in that state is the
 * box's, not Wake's. The operator has already signed this machine into those
 * connectors. Fetch borrows that reach for one bounded read.
 *
 * Everything that makes this safe is structural rather than hoped for:
 *
 *   - `--print`, so there is no interactive session and no permission prompt
 *     that nobody is there to answer. That was the whole of the old objection.
 *   - `--allowed-tools`, an explicit read-only allowlist. No name in it can
 *     send, reply, create, update, delete, trash, label, post, draft or spam,
 *     and a test asserts that by scanning this file rather than by trusting it.
 *   - `--max-turns`, so a collection cannot become an investigation.
 *   - a wall-clock timeout that kills the process; whatever landed is kept.
 *   - argv as an array and the prompt over stdin, so no shell parses either.
 *   - one shot. No session id, no resume, no second turn, no transcript.
 *
 * And the model's prose never becomes product copy. The only thing read out of
 * the envelope is a JSON array of objects with a fixed shape; anything that
 * fails validation is dropped, silently, and the row simply does not land.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { audit } from '../db'
import {
  CLAUDE_BIN, FETCH_MAX_ROWS, FETCH_MAX_TURNS, FETCH_MODEL, FETCH_RUN_DIR, FETCH_TIMEOUT_MS,
} from '../env'
import { redact } from '../redact'

/**
 * One object the collector is allowed to return.
 *
 * `evidence` is a quoted line from the source, and it is the only thing Wake
 * will accept as a reason. Wake turns evidence into `why` with its own rules —
 * see `whyFrom` in ./index.ts — because "why is this on me" is a rule firing,
 * not a sentence somebody generated. There is no `why` and no `refs` in this
 * shape on purpose: a fabricated `gh:` reference outranks every other reference
 * type and would win a group's label.
 */
export type Found = {
  /** The source's own identifier, in the shape its tools return. */
  id: string
  title: string
  evidence: string | null
  who: string | null
  url: string | null
  /** ISO 8601, or null. */
  when: string | null
  /** Which standing question this answers. Anything else reads as `open`. */
  bucket: 'waiting' | 'open'
}

/**
 * The read-only allowlist, per connector, by real tool name.
 *
 * Named individually rather than as `mcp__claude_ai_Slack` (which would allow
 * the whole server, writes included) or a wildcard. If a name here is wrong the
 * connector returns nothing and says so; that is the correct failure.
 *
 * The bar a name has to clear is blunt on purpose: no verb or noun in it may
 * look like a write. `list_labels` was here and is not any more — it is a read,
 * and it is also not something a collection needs, so the narrower list is the
 * better answer than a cleverer test.
 */
export const READ_TOOLS: Record<string, string[]> = {
  slack: [
    'mcp__claude_ai_Slack__slack_search_public_and_private',
    'mcp__claude_ai_Slack__slack_read_channel',
    'mcp__claude_ai_Slack__slack_read_thread',
    'mcp__claude_ai_Slack__slack_search_users',
    'mcp__claude_ai_Slack__slack_read_user_profile',
  ],
  gmail: [
    'mcp__claude_ai_Gmail__search_threads',
    'mcp__claude_ai_Gmail__get_thread',
    'mcp__claude_ai_Gmail__get_message',
  ],
  sentry: [
    'mcp__claude_ai_Sentry__search_issues',
    'mcp__claude_ai_Sentry__search_events',
    'mcp__claude_ai_Sentry__find_projects',
    'mcp__claude_ai_Sentry__get_sentry_resource',
  ],
}

/** Whether this machine has the binary at all. Fetch degrades rather than throws. */
export const boxCanAsk = () => !!CLAUDE_BIN && existsSync(CLAUDE_BIN)

export type BoxRun = { rows: Found[]; costUsd: number | null; turns: number | null }

/**
 * Run one collection and return only what validates.
 *
 * Throws on transport failure — an empty answer and a failed one are different
 * facts, and Fetch records them as different `sync_runs` rows.
 */
export async function askTheBox(connector: string, prompt: string): Promise<BoxRun> {
  const tools = READ_TOOLS[connector]
  if (!tools) throw new Error(`no read-only tool list for ${connector}`)
  if (!boxCanAsk()) throw new Error('this machine has no claude binary for Wake to borrow')

  const argv = [
    CLAUDE_BIN,
    '--print',
    '--model', FETCH_MODEL,
    '--output-format', 'json',
    '--max-turns', String(FETCH_MAX_TURNS),
    '--allowed-tools', tools.join(','),
  ]

  // A directory of Wake's own, not the repository and not the home directory.
  // Not the repository, because nothing here should be able to read the checkout
  // it happens to be launched from. Not the home directory, because a run leaves
  // a transcript behind and the Claude Code source reads that bucket — Fetch was
  // filling the desk with its own collections, one row per connector per press.
  mkdirSync(FETCH_RUN_DIR, { recursive: true })

  const proc = Bun.spawn(argv, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: FETCH_RUN_DIR,
  })
  proc.stdin.write(prompt)
  await proc.stdin.end()

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; proc.kill() }, FETCH_TIMEOUT_MS)

  let out = ''
  let err = ''
  try {
    ;[out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
  } finally {
    clearTimeout(timer)
  }

  if (timedOut) throw new Error(`timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`)

  let envelope: any
  try {
    envelope = JSON.parse(out)
  } catch {
    throw new Error(redact((err || out || 'no output').trim().slice(0, 300)))
  }
  if (envelope?.is_error) {
    throw new Error(redact(String(envelope.result ?? envelope.subtype ?? 'refused').slice(0, 300)))
  }

  const rows = parseRows(typeof envelope?.result === 'string' ? envelope.result : '')

  audit('fetch.collect', {
    actor: 'fetch',
    target: connector,
    detail: {
      rows: rows.length,
      turns: envelope?.num_turns ?? null,
      costUsd: envelope?.total_cost_usd ?? null,
      tools: tools.length,
    },
  })

  return {
    rows,
    costUsd: typeof envelope?.total_cost_usd === 'number' ? envelope.total_cost_usd : null,
    turns: typeof envelope?.num_turns === 'number' ? envelope.num_turns : null,
  }
}

/**
 * The validator, and the reason none of this can become prose on a page.
 *
 * A model asked for JSON returns JSON inside a markdown fence about half the
 * time, so the fence is stripped; anything else is not repaired, explained or
 * rendered — it is dropped and the connector reports that it returned nothing
 * usable.
 */
export function parseRows(result: string): Found[] {
  const body = result.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(body)
  const raw = (fenced?.[1] ?? body).trim()
  if (!raw.startsWith('[')) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: Found[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const title = clip(o.title, 200)
    const id = clip(o.id, 200)
    if (!title || !id) continue
    out.push({
      id,
      title,
      evidence: clip(o.evidence, 400),
      who: clip(o.who, 80),
      url: httpOnly(clip(o.url, 500)),
      when: clip(o.when, 40),
      bucket: o.bucket === 'waiting' ? 'waiting' : 'open',
    })
    if (out.length >= FETCH_MAX_ROWS) break
  }
  return out
}

const clip = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = redact(v.replace(/\s+/g, ' ').trim())
  return s ? s.slice(0, max) : null
}

/** A link Wake will render has to be a link a browser can open. */
const httpOnly = (v: string | null): string | null =>
  v && /^https?:\/\//i.test(v) ? v : null
