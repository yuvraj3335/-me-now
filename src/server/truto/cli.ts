/**
 * The typed Truto CLI adapter.
 *
 * Every invocation is an argument array handed to `Bun.spawn`. There is no
 * shell, no string interpolation and no `sh -c` anywhere in this file, so a
 * customer name containing a semicolon is an argument rather than a second
 * command. That is the whole reason this layer exists instead of a `bash` tool.
 *
 * Output limits, timeouts and redaction are applied here rather than at the
 * caller, because a caller that forgets is a caller that leaks.
 */

import { db, now } from '../db'
import { CLI_MAX_OUTPUT, CLI_MAX_PARSE, CLI_TIMEOUT_MS, TRUTO_BIN } from '../env'
import { childEnv, redact } from '../redact'
import { classify, hazardNote, type Classification } from './classify'

export type CliResult = {
  ok: boolean
  exitCode: number | null
  argv: string[]
  /** Parsed when the output was JSON/NDJSON, else null. */
  json: unknown
  /** Set when `json` is null for a reason worth acting on. */
  parseNote: string | null
  stdout: string
  stderr: string
  ms: number
  truncated: boolean
  classification: Classification
  hazard: string | null
}

/** Flags Wake always adds. Table output is for humans and unparseable for us. */
function withDefaults(argv: string[], profile: string | null, format: 'json' | 'ndjson'): string[] {
  const out = [...argv]
  const has = (...names: string[]) => out.some(a => names.includes(a) || names.some(n => a.startsWith(`${n}=`)))

  if (profile && !has('-p', '--profile')) out.push('-p', profile)
  if (!has('-o', '--output')) out.push('-o', format)
  if (!out.includes('--no-color')) out.push('--no-color')
  // Without this the CLI prints its full help on any error, which buries the
  // actual message under 80 lines of usage text.
  if (!out.includes('--no-help-on-error')) out.push('--no-help-on-error')
  return out
}

function clip(s: string): { text: string; truncated: boolean } {
  if (s.length <= CLI_MAX_OUTPUT) return { text: s, truncated: false }
  return {
    text: s.slice(0, CLI_MAX_OUTPUT) + `\n…[truncated by Wake at ${CLI_MAX_OUTPUT} bytes]`,
    truncated: true,
  }
}

function parse(stdout: string, format: 'json' | 'ndjson'): unknown {
  const t = stdout.trim()
  if (!t) return null
  if (format === 'ndjson') {
    const rows: unknown[] = []
    for (const line of t.split('\n')) {
      const l = line.trim()
      if (!l) continue
      try {
        rows.push(JSON.parse(l))
      } catch {
        return null // a non-JSON line means this was not really NDJSON
      }
    }
    return rows
  }
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

export type RunOpts = {
  profile?: string | null
  format?: 'json' | 'ndjson'
  timeoutMs?: number
  turnId?: string | null
  approvalId?: string | null
  signal?: AbortSignal
  /** Body passed on stdin, for `--stdin` commands. */
  stdin?: string
}

/**
 * Run one command. This function does NOT enforce approval — that is the tool
 * layer's job, because only it can block on a human. What this does is classify,
 * execute safely, redact, and record.
 */
export async function runTruto(argv: string[], opts: RunOpts = {}): Promise<CliResult> {
  const format = opts.format ?? 'json'
  const classification = classify(argv)
  const full = withDefaults(argv, opts.profile ?? null, format)
  const t0 = Date.now()

  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? CLI_TIMEOUT_MS)

  let stdout = ''
  let stderr = ''
  let exitCode: number | null = null

  try {
    const proc = Bun.spawn([TRUTO_BIN, ...full], {
      stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: childEnv(),
      signal: ctl.signal,
    })
    const [o, e] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    stdout = o
    stderr = e
    exitCode = await proc.exited
  } catch (err) {
    stderr = ctl.signal.aborted
      ? `timed out or cancelled after ${Date.now() - t0}ms`
      : (err as Error).message
    exitCode = null
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }

  const so = clip(redact(stdout))
  const se = clip(redact(stderr))
  const ms = Date.now() - t0

  // Parse the RAW stdout, and do it independently of the display clip. The two
  // limits answer different questions: the display cap keeps a huge dump out of
  // the UI and the event log, while the parse cap keeps it out of memory.
  // Conflating them silently threw away a perfectly good result — `integrations
  // list` is ~2MB of valid JSON and came back as null.
  let json: unknown = null
  let parseNote: string | null = null
  if (exitCode === 0) {
    if (stdout.length > CLI_MAX_PARSE) {
      // Silently returning null here reads as "the command found nothing",
      // which is the opposite of the truth and sends the whole investigation
      // the wrong way. Say what happened and how to narrow it — on this
      // platform the size is almost always embedded `config` blobs, not rows.
      parseNote =
        `Output was ${Math.round(stdout.length / 1e6)}MB, over the ${Math.round(CLI_MAX_PARSE / 1e6)}MB parse limit, so no structured result was produced. ` +
        'Narrow the query: --limit, a --name/--ilike filter, or fetch the one record by id. ' +
        'Size here is usually embedded config blobs rather than row count, so a smaller --limit helps most. ' +
        'Note --select currently 500s on some list endpoints (ambiguous column in the join), so do not rely on it.'
    } else {
      json = parse(stdout, format)
      if (json === null && stdout.trim()) {
        parseNote = `Output was not valid ${format.toUpperCase()}; read stdout directly.`
      }
    }
  }

  const result: CliResult = {
    ok: exitCode === 0,
    exitCode,
    argv: full,
    json,
    parseNote,
    stdout: so.text,
    stderr: se.text,
    ms,
    truncated: so.truncated || se.truncated,
    classification,
    hazard: hazardNote(argv),
  }

  db.query(
    `INSERT INTO cli_audit (turn_id, profile, argv, class, approval_id, exit_code, ms, ok, stdout_head, stderr_head, at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    opts.turnId ?? null,
    opts.profile ?? null,
    JSON.stringify(full),
    classification.cls,
    opts.approvalId ?? null,
    exitCode,
    ms,
    result.ok ? 1 : 0,
    so.text.slice(0, 2_000),
    se.text.slice(0, 2_000),
    now(),
  )

  return result
}

/* ------------------------------- profiles -------------------------------- */

export type Identity = {
  profile: string | null
  team: string | null
  teamId: string | null
  /**
   * `whoami` does not report an environment — the token's scope decides it. Left
   * null rather than filled with a guess, because "which environment am I about
   * to change" is exactly the question a confident wrong answer ruins.
   */
  environment: string | null
  apiUrl: string | null
  user: string | null
}

const IDENTITY_TTL_MS = 60_000
const identityCache = new Map<string, { at: number; value: Identity }>()

/**
 * Resolve who we are before doing anything else. The brief requires this be
 * shown, and it is the difference between debugging a customer's staging
 * environment and their production one.
 */
export async function whoami(profile: string | null, signal?: AbortSignal): Promise<Identity> {
  const key = profile ?? '<active>'
  const hit = identityCache.get(key)
  if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.value

  const r = await runTruto(['whoami'], { profile, signal, timeoutMs: 20_000 })
  if (!r.ok) {
    throw new Error(
      `could not resolve Truto identity for profile ${profile ?? '(active)'}: ${r.stderr.slice(0, 300) || `exit ${r.exitCode}`}`,
    )
  }

  const d = (r.json ?? {}) as Record<string, any>
  // The CLI has moved these fields around between versions, so read defensively
  // rather than pinning to one shape.
  const value: Identity = {
    profile: d.profile ?? profile ?? null,
    team: d.team_name ?? d.team?.name ?? (typeof d.team === 'string' ? d.team : null),
    teamId: d.team_id ?? d.team?.id ?? null,
    environment: d.environment_name ?? d.environment?.name ?? null,
    apiUrl: d.api_url ?? d.apiUrl ?? null,
    user: d.user?.email ?? d.email ?? null,
  }
  identityCache.set(key, { at: Date.now(), value })
  return value
}

export async function listProfiles(signal?: AbortSignal): Promise<string[]> {
  const r = await runTruto(['profiles', 'list'], { signal, timeoutMs: 15_000 })
  if (!r.ok || !r.json) return []
  const rows = Array.isArray(r.json) ? r.json : ((r.json as any).profiles ?? [])
  return rows
    .map((p: any) => (typeof p === 'string' ? p : p?.name))
    .filter((n: unknown): n is string => typeof n === 'string')
}

/** `truto <command> --help`, so the agent reads real syntax instead of guessing flags. */
export async function help(command: string[], signal?: AbortSignal): Promise<string> {
  const safe = command.filter(c => /^[a-z][a-z0-9-]*$/i.test(c)).slice(0, 3)
  const r = await runTruto([...safe, '--help'], { signal, format: 'json', timeoutMs: 15_000 })
  return r.stdout || r.stderr
}
