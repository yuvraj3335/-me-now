/**
 * Approvals and structured questions.
 *
 * The mechanism is deliberately simple: a tool that needs a human *blocks*.
 * `requestApproval` writes a pending row, emits the event the UI renders as a
 * card, and returns a promise that settles when someone clicks. Because Wake
 * owns the MCP server the agent is calling, the model's turn simply waits
 * inside the tool call — there is no need to teach it a two-phase "ask, then
 * re-call with a token" protocol it could get wrong or skip.
 *
 * The pending row is the durable half. The promise is the live half. If Wake
 * restarts, the promise is gone and so is the Claude Code process that was
 * waiting on it, so `expireOrphans` clears those rows at boot rather than
 * leaving cards that can never be answered.
 */

import { db, now, uid } from '../db'
import { APPROVAL_TIMEOUT_MS } from '../env'
import { emit } from './events'

export type ApprovalKind = 'mutation' | 'provider_read' | 'question' | 'engineering'

export type ApprovalRow = {
  id: string
  turn_id: string
  conv_id: string
  kind: ApprovalKind
  tool: string
  title: string
  detail: string | null
  payload: string
  risk: string
  state: 'pending' | 'approved' | 'denied' | 'expired'
  answer: string | null
  fingerprint: string | null
  created_at: number
  resolved_at: number | null
}

export type Resolution =
  | { state: 'approved'; answer?: string }
  | { state: 'denied'; answer?: string }
  | { state: 'expired' }

type Waiter = {
  resolve: (r: Resolution) => void
  timer: ReturnType<typeof setTimeout>
  fingerprint: string | null
}

const waiters = new Map<string, Waiter>()

export type ApprovalRequest = {
  turnId: string
  convId: string
  kind: ApprovalKind
  tool: string
  title: string
  detail?: string
  payload?: Record<string, unknown>
  risk?: string
  /**
   * A hash of the state this approval was granted against. If it changes before
   * the work is applied, the approval is stale and must not be reused — the
   * brief's "reject stale approval" step.
   */
  fingerprint?: string | null
  /** Options for a structured question. */
  options?: Array<{ label: string; description?: string }>
}

export function requestApproval(req: ApprovalRequest): Promise<Resolution> {
  const id = uid()
  const at = now()

  // Options live in the stored payload, not only in the emitted event: a
  // client that reloads while a question is open reads it back from
  // /approvals, and a question that lost its choices is unanswerable.
  const payload = { ...(req.payload ?? {}), ...(req.options ? { options: req.options } : {}) }

  db.query(
    `INSERT INTO approvals (id, turn_id, conv_id, kind, tool, title, detail, payload, risk, state, fingerprint, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
  ).run(
    id, req.turnId, req.convId, req.kind, req.tool, req.title,
    req.detail ?? null, JSON.stringify(payload),
    req.risk ?? req.kind, req.fingerprint ?? null, at,
  )

  emit(req.turnId, req.kind === 'question' ? 'question' : 'approval', {
    id,
    kind: req.kind,
    tool: req.tool,
    title: req.title,
    detail: req.detail ?? null,
    risk: req.risk ?? req.kind,
    options: req.options ?? null,
    payload,
  })

  return new Promise<Resolution>(resolve => {
    const timer = setTimeout(() => {
      waiters.delete(id)
      db.query(`UPDATE approvals SET state = 'expired', resolved_at = ? WHERE id = ? AND state = 'pending'`)
        .run(now(), id)
      emit(req.turnId, 'approval_resolved', { id, state: 'expired' })
      resolve({ state: 'expired' })
    }, APPROVAL_TIMEOUT_MS)
    // A pending approval must not hold the process open on shutdown.
    timer.unref?.()
    waiters.set(id, { resolve, timer, fingerprint: req.fingerprint ?? null })
  })
}

/** Called by the API when a person clicks approve/deny, or answers a question. */
export function resolveApproval(
  id: string,
  state: 'approved' | 'denied',
  answer?: string,
): { ok: boolean; error?: string } {
  const row = db.query<ApprovalRow, [string]>(`SELECT * FROM approvals WHERE id = ?`).get(id)
  if (!row) return { ok: false, error: 'no such approval' }
  if (row.state !== 'pending') return { ok: false, error: `already ${row.state}` }

  db.query(`UPDATE approvals SET state = ?, answer = ?, resolved_at = ? WHERE id = ?`)
    .run(state, answer ?? null, now(), id)
  emit(row.turn_id, row.kind === 'question' ? 'question_answered' : 'approval_resolved', {
    id,
    state,
    answer: answer ?? null,
  })

  const w = waiters.get(id)
  if (w) {
    clearTimeout(w.timer)
    waiters.delete(id)
    w.resolve({ state, answer })
    return { ok: true }
  }
  // No live waiter: the turn died while this card was on screen. The row is
  // updated so history is honest, but nothing is resumed.
  return { ok: true, error: 'recorded, but the turn waiting on it is no longer running' }
}

export function listPending(convId?: string): ApprovalRow[] {
  return convId
    ? db.query<ApprovalRow, [string]>(
        `SELECT * FROM approvals WHERE state = 'pending' AND conv_id = ? ORDER BY created_at`,
      ).all(convId)
    : db.query<ApprovalRow, []>(`SELECT * FROM approvals WHERE state = 'pending' ORDER BY created_at`).all()
}

/**
 * At boot, any approval still marked pending belongs to a turn that no longer
 * exists. Leaving it would put a card on screen that nothing is listening to.
 */
export function expireOrphans(): number {
  const r = db
    .query(`UPDATE approvals SET state = 'expired', resolved_at = ? WHERE state = 'pending'`)
    .run(now())
  return Number((r as { changes?: number }).changes ?? 0)
}

/** Cancel every pending approval for a turn — used when a turn is cancelled. */
export function cancelForTurn(turnId: string): void {
  for (const row of db
    .query<ApprovalRow, [string]>(`SELECT * FROM approvals WHERE turn_id = ? AND state = 'pending'`)
    .all(turnId)) {
    db.query(`UPDATE approvals SET state = 'denied', resolved_at = ? WHERE id = ?`).run(now(), row.id)
    const w = waiters.get(row.id)
    if (w) {
      clearTimeout(w.timer)
      waiters.delete(row.id)
      w.resolve({ state: 'denied', answer: 'the turn was cancelled' })
    }
  }
}

/** Stable hash of whatever state an approval was granted against. */
export function fingerprint(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16)
}
