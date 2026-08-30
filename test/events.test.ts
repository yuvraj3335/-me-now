/**
 * The event log is what the UI replays, so a fold that loses a field loses it
 * everywhere — live stream and reopened conversation alike.
 */

import { describe, expect, test, beforeAll } from 'bun:test'
import { db, now, uid } from '../src/server/db'
import { emit, eventsSince, foldSegments } from '../src/server/agent/events'

let turnId: string

beforeAll(() => {
  const convId = uid()
  turnId = uid()
  db.query(
    `INSERT INTO conversations (id, title, mode, created_at, updated_at) VALUES (?,?,?,?,?)`,
  ).run(convId, 't', 'support', now(), now())
  db.query(
    `INSERT INTO turns (id, conv_id, state, mode, prompt, started_at, heartbeat_at)
     VALUES (?,?,'running','support','p',?,?)`,
  ).run(turnId, convId, now(), now())
})

describe('turn events', () => {
  test('seq is gap-free and starts at 1', () => {
    emit(turnId, 'start', { mode: 'support' })
    emit(turnId, 'text', { text: 'hello ' })
    emit(turnId, 'text', { text: 'world' })
    const seqs = eventsSince(turnId, 0).map(e => e.seq)
    expect(seqs).toEqual([1, 2, 3])
  })

  test('the cursor returns only what follows it', () => {
    expect(eventsSince(turnId, 2).map(e => e.seq)).toEqual([3])
    expect(eventsSince(turnId, 99)).toHaveLength(0)
  })

  test('adjacent text events fold into one segment', () => {
    const segs = foldSegments(turnId)
    const text = segs.filter(s => s.kind === 'text')
    expect(text).toHaveLength(1)
    expect(text[0]!.text).toBe('hello world')
  })

  test('a tool result attaches to the call it answers', () => {
    emit(turnId, 'tool_use', { id: 'c1', name: 'truto_run', input: { argv: ['whoami'] } })
    emit(turnId, 'tool_result', { id: 'c1', ok: true, result: { team: 'Truto' } })
    const call = foldSegments(turnId).find(s => s.kind === 'tool' && s.id === 'c1')
    expect(call?.ok).toBe(true)
    expect((call?.result as any).team).toBe('Truto')
  })

  test("an approval's own kind does not overwrite the segment kind", () => {
    // The regression: the payload carries kind:'engineering', and spreading it
    // after `kind: e.type` produced a segment the renderer had no case for, so
    // the approval card silently vanished from the UI.
    emit(turnId, 'approval', {
      id: 'a1',
      kind: 'engineering',
      tool: 'claude_launch',
      title: 'Start a session',
      risk: 'engineering',
    })
    const seg = foldSegments(turnId).find(s => s.id === 'a1')
    expect(seg?.kind).toBe('approval')
    expect(seg?.tool).toBe('claude_launch')
    expect(seg?.title).toBe('Start a session')
  })

  test('resolving an approval updates the card in place', () => {
    emit(turnId, 'approval_resolved', { id: 'a1', state: 'denied', answer: null })
    const cards = foldSegments(turnId).filter(s => s.id === 'a1')
    // Updated in place, not appended as a second card.
    expect(cards).toHaveLength(1)
    expect(cards[0]!.state).toBe('denied')
  })

  test('every folded segment carries a kind the renderer can dispatch on', () => {
    const known = new Set(['text', 'thinking', 'tool', 'tool_result', 'approval', 'question', 'notice', 'error'])
    for (const s of foldSegments(turnId)) {
      expect(known.has(String(s.kind)), `unrenderable segment kind: ${s.kind}`).toBe(true)
    }
  })
})
