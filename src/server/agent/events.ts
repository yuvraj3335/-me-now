/**
 * The durable turn event log.
 *
 * Every visible thing a turn does becomes a row here before it reaches a
 * browser. That ordering is the whole design: the SSE endpoint is a tail over
 * this table rather than a pipe from the model, so a reload, a dropped
 * connection, a phone waking up, or a Wake restart all resume from `?after=<seq>`
 * and miss nothing.
 *
 * `seq` is per-turn and gap-free, assigned under the same transaction that
 * writes the row. Two concurrent appends cannot collide on it, which is what
 * makes the cursor meaningful rather than approximate.
 */

import { db, now } from '../db'

export type TurnEventType =
  | 'start' | 'text' | 'thinking' | 'tool_use' | 'tool_result'
  | 'approval' | 'approval_resolved' | 'question' | 'question_answered'
  | 'skills' | 'usage' | 'notice' | 'error' | 'done' | 'cancelled' | 'resume'

export type TurnEvent = {
  seq: number
  type: TurnEventType
  payload: Record<string, unknown>
  at: number
}

type Subscriber = (e: TurnEvent) => void
const subscribers = new Map<string, Set<Subscriber>>()

/**
 * Append and publish. The DB write happens first so a subscriber can never
 * observe an event that a reconnect would then fail to replay.
 */
export function emit(turnId: string, type: TurnEventType, payload: Record<string, unknown> = {}): TurnEvent {
  const at = now()

  const seq = db.transaction(() => {
    const row = db
      .query<{ n: number | null }, [string]>(`SELECT MAX(seq) AS n FROM turn_events WHERE turn_id = ?`)
      .get(turnId)
    const next = (row?.n ?? 0) + 1
    db.query(`INSERT INTO turn_events (turn_id, seq, type, payload, at) VALUES (?,?,?,?,?)`)
      .run(turnId, next, type, JSON.stringify(payload), at)
    db.query(`UPDATE turns SET last_seq = ?, heartbeat_at = ? WHERE id = ?`).run(next, at, turnId)
    return next
  })()

  const event: TurnEvent = { seq, type, payload, at }
  for (const fn of subscribers.get(turnId) ?? []) {
    try {
      fn(event)
    } catch {
      // A broken subscriber (a closed SSE stream mid-write) must not abort the
      // turn that was merely reporting progress.
    }
  }
  return event
}

export function subscribe(turnId: string, fn: Subscriber): () => void {
  const set = subscribers.get(turnId) ?? new Set()
  set.add(fn)
  subscribers.set(turnId, set)
  return () => {
    set.delete(fn)
    if (!set.size) subscribers.delete(turnId)
  }
}

export function eventsSince(turnId: string, afterSeq: number): TurnEvent[] {
  return db
    .query<{ seq: number; type: string; payload: string; at: number }, [string, number]>(
      `SELECT seq, type, payload, at FROM turn_events WHERE turn_id = ? AND seq > ? ORDER BY seq`,
    )
    .all(turnId, afterSeq)
    .map(r => ({
      seq: r.seq,
      type: r.type as TurnEventType,
      payload: safeParse(r.payload),
      at: r.at,
    }))
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }
  } catch {
    return { raw: s }
  }
}

/**
 * Fold a turn's events into the message segments the UI renders. Used when a
 * conversation is reopened, so a reloaded page matches what was streamed live
 * rather than showing a bare block of text.
 */
export function foldSegments(turnId: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  let text = ''

  const flushText = () => {
    if (text.trim()) out.push({ kind: 'text', text })
    text = ''
  }

  for (const e of eventsSince(turnId, 0)) {
    switch (e.type) {
      case 'text':
        text += String(e.payload.text ?? '')
        break
      case 'thinking':
        flushText()
        out.push({ kind: 'thinking', text: String(e.payload.text ?? '') })
        break
      case 'tool_use':
        flushText()
        out.push({
          kind: 'tool',
          id: e.payload.id,
          name: e.payload.name,
          input: e.payload.input,
          // `mutates` is what the engine actually emits and what the tool card
          // reads. The old `cls` was never emitted by anything, so a reopened
          // conversation lost the write marker and fell back to a hard-coded
          // list of tool names.
          mutates: e.payload.mutates ?? false,
        })
        break
      case 'tool_result': {
        // Attach to the call it answers rather than appending a loose block, so
        // the UI can render one card per tool call.
        const call = [...out].reverse().find(s => s.kind === 'tool' && s.id === e.payload.id)
        if (call) {
          call.result = e.payload.result
          call.ok = e.payload.ok
        } else {
          out.push({ kind: 'tool_result', ...e.payload })
        }
        break
      }
      case 'approval':
      case 'question':
        flushText()
        // Payload spread FIRST: an approval's payload carries its own `kind`
        // (the approval kind, e.g. "engineering"), which would otherwise
        // overwrite the segment kind and make the card render as nothing.
        out.push({ ...e.payload, kind: e.type })
        break
      case 'approval_resolved':
      case 'question_answered': {
        const target = [...out]
          .reverse()
          .find(s => (s.kind === 'approval' || s.kind === 'question') && s.id === e.payload.id)
        if (target) {
          target.state = e.payload.state
          target.answer = e.payload.answer
        }
        break
      }
      case 'notice':
      case 'error':
        flushText()
        out.push({ ...e.payload, kind: e.type })
        break
      default:
        break
    }
  }
  flushText()
  return out
}
