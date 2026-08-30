/**
 * A whole turn, end to end, without an Anthropic key.
 *
 * There is no API key on either machine this runs on, so the streaming loop
 * could otherwise only be reasoned about. Pointing the SDK at a local server
 * that speaks the real event format exercises the parts Wake actually owns: the
 * stream is parsed, a tool is executed, its result is fed back, a second reply
 * ends the turn, and every visible step lands in the durable log in order.
 *
 * It also pins the failure mode that matters most — a turn that ends without a
 * result must be recorded as an error, never as success.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { db, kvSet, now, uid } from '../src/server/db'
import { eventsSince } from '../src/server/agent/events'
import { startTurn, cancelTurn, isRunning } from '../src/server/agent/turns'

type Reply =
  | { kind: 'tool'; text: string; tool: string; input: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'error'; status: number; body: unknown }

let script: Reply[] = []
let seen: any[] = []
let server: ReturnType<typeof Bun.serve>

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function stream(reply: Reply): string {
  if (reply.kind === 'error') return ''
  const out = [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'test',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ]
  // Split so the pump has more than one delta to coalesce, as a real stream does.
  for (const chunk of reply.text.match(/.{1,8}/gs) ?? []) {
    out.push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }))
  }
  out.push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))

  if (reply.kind === 'tool') {
    out.push(
      sse('content_block_start', {
        type: 'content_block_start', index: 1,
        content_block: { type: 'tool_use', id: 'toolu_test', name: reply.tool, input: {} },
      }),
      sse('content_block_delta', {
        type: 'content_block_delta', index: 1,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) },
      }),
      sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
    )
  }

  out.push(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: reply.kind === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 7 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  )
  return out.join('')
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push(await req.json())
      const reply = script.shift()
      if (!reply) return new Response('no scripted reply', { status: 500 })
      if (reply.kind === 'error') {
        return Response.json(reply.body, { status: reply.status })
      }
      return new Response(stream(reply), {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      })
    },
  })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
  // The durable key path, so this works regardless of module import order.
  kvSet('agent:anthropic_key', 'sk-ant-testkeytestkeytestkey1234567890')
})

afterAll(() => server.stop(true))

function conversation(mode = 'triage'): string {
  const id = uid()
  db.query(`INSERT INTO conversations (id, title, mode, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(id, 'New conversation', mode, now(), now())
  return id
}

/** Turns run in the background; the row's state is the finish line. */
async function settle(turnId: string, ms = 15_000): Promise<Record<string, any>> {
  const started = Date.now()
  for (;;) {
    const row = db.query<Record<string, any>, [string]>(`SELECT * FROM turns WHERE id = ?`).get(turnId)!
    if (row.state !== 'running') return row
    if (Date.now() - started > ms) throw new Error(`turn stayed running: ${JSON.stringify(row)}`)
    await Bun.sleep(20)
  }
}

describe('a full turn', () => {
  test('streams, calls a tool, feeds the result back, and finishes', async () => {
    seen = []
    script = [
      { kind: 'tool', text: 'Let me look at your piles. ', tool: 'wake_cards', input: { pile: 'now' } },
      { kind: 'text', text: 'Nothing is waiting on you.' },
    ]

    const convId = conversation('triage')
    const { turnId } = startTurn({ convId, prompt: 'what needs me?' })
    const row = await settle(turnId)

    expect(row.state).toBe('done')
    expect(row.num_turns).toBe(2)
    expect(row.input_tokens).toBe(22)

    const types = eventsSince(turnId, 0).map(e => e.type)
    expect(types[0]).toBe('start')
    expect(types).toContain('text')
    expect(types).toContain('tool_use')
    expect(types).toContain('tool_result')
    expect(types.at(-1)).toBe('done')

    // The tool result must actually reach the model, or the second reply is
    // answering a question it was never given the evidence for.
    const secondRequest = seen[1]
    expect(secondRequest.messages.at(-1).content[0].type).toBe('tool_result')
    expect(secondRequest.messages.at(-1).content[0].tool_use_id).toBe('toolu_test')

    // And the folded assistant message is what a reopened conversation renders.
    const message = db
      .query<Record<string, any>, [string]>(
        `SELECT * FROM messages WHERE conv_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1`,
      )
      .get(convId)!
    expect(message.body).toContain('Nothing is waiting on you.')
    const segments = JSON.parse(message.segments)
    expect(segments.some((s: any) => s.kind === 'tool' && s.name === 'wake_cards')).toBe(true)

    const call = db
      .query<Record<string, any>, [string]>(`SELECT * FROM agent_tool_calls WHERE turn_id = ?`)
      .get(turnId)!
    expect(call.name).toBe('wake_cards')
    expect(call.ok).toBe(1)
  })

  test('the first user message becomes the title', async () => {
    seen = []
    script = [{ kind: 'text', text: 'ok' }]
    const convId = conversation()
    const { turnId } = startTurn({ convId, prompt: 'why did the Acme sync stop on Tuesday?' })
    await settle(turnId)
    const conv = db.query<Record<string, any>, [string]>(`SELECT * FROM conversations WHERE id = ?`).get(convId)!
    expect(conv.title).toBe('why did the Acme sync stop on Tuesday?')
  })

  test('a tool the mode does not allow is refused without ending the turn', async () => {
    seen = []
    script = [
      // triage is read-only and has no truto_apply.
      { kind: 'tool', text: '', tool: 'truto_apply', input: { argv: ['integrations', 'update', 'x'] } },
      { kind: 'text', text: 'I cannot make that change from this mode.' },
    ]
    const convId = conversation('triage')
    const { turnId } = startTurn({ convId, prompt: 'change the integration' })
    const row = await settle(turnId)

    expect(row.state).toBe('done')
    const result = eventsSince(turnId, 0).find(e => e.type === 'tool_result')!
    expect(result.payload.ok).toBe(false)
    expect(String(result.payload.result)).toContain('not available in Triage mode')
    // The refusal goes back to the model as a tool error, not as a crash.
    expect(seen[1].messages.at(-1).content[0].is_error).toBe(true)
  })

  test('history carries the previous answer into the next turn', async () => {
    seen = []
    script = [{ kind: 'text', text: 'The cause was a stale credential.' }, { kind: 'text', text: 'Yes.' }]
    const convId = conversation()
    await settle(startTurn({ convId, prompt: 'what was the cause?' }).turnId)
    await settle(startTurn({ convId, prompt: 'are you sure?' }).turnId)

    const second = seen[1]
    expect(second.messages).toHaveLength(3)
    expect(second.messages[0]).toEqual({ role: 'user', content: 'what was the cause?' })
    expect(second.messages[1].role).toBe('assistant')
    expect(second.messages[1].content).toContain('stale credential')
    // Crucially, no tool blocks are replayed: reconstructing tool_use/tool_result
    // id pairs across restarts is what produces an unrecoverable 400.
    expect(JSON.stringify(second.messages)).not.toContain('tool_use_id')
  })

  test('an API error is reported with the message the API gave', async () => {
    seen = []
    script = [{ kind: 'error', status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]
    const convId = conversation()
    const { turnId } = startTurn({ convId, prompt: 'hello' })
    const row = await settle(turnId)

    // Not 'done'. A turn that produced no answer is an error, always.
    expect(row.state).toBe('error')
    expect(row.error).toContain('401')
    expect(row.error).toContain('invalid x-api-key')
    expect(eventsSince(turnId, 0).some(e => e.type === 'error')).toBe(true)
  })

  test('cancelling stops the turn and records it as cancelled', async () => {
    seen = []
    // A tool that blocks on a human is the realistic thing to cancel.
    script = [{ kind: 'tool', text: 'One question first. ', tool: 'ask_user', input: { question: 'which environment?' } }]
    const convId = conversation()
    const { turnId } = startTurn({ convId, prompt: 'fix it' })

    for (let i = 0; i < 200 && !db.query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM approvals WHERE turn_id = ? AND state = 'pending'`).get(turnId)!.n; i++) {
      await Bun.sleep(10)
    }
    expect(isRunning(turnId)).toBe(true)
    expect(cancelTurn(turnId)).toBe(true)

    const row = await settle(turnId)
    expect(row.state).toBe('cancelled')
    // Nothing may be left on screen that no longer has a listener.
    expect(db.query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM approvals WHERE turn_id = ? AND state = 'pending'`).get(turnId)!.n).toBe(0)
  })

  test('the SSE cursor resumes exactly where a reader left off', async () => {
    seen = []
    script = [{ kind: 'text', text: 'first' }]
    const convId = conversation()
    const { turnId } = startTurn({ convId, prompt: 'hello' })
    await settle(turnId)

    const all = eventsSince(turnId, 0)
    const afterTwo = eventsSince(turnId, 2)
    expect(afterTwo[0]!.seq).toBe(3)
    expect(afterTwo).toHaveLength(all.length - 2)
    // Gap-free: the resume cursor is only meaningful if seq has no holes.
    expect(all.map(e => e.seq)).toEqual(all.map((_, i) => i + 1))
  })
})

describe('without a key', () => {
  test('starting a turn refuses, naming the other engine so the two are not confused', () => {
    db.query(`DELETE FROM kv WHERE k = 'agent:anthropic_key'`).run()
    const convId = conversation()
    expect(() => startTurn({ convId, prompt: 'hello' })).toThrow(/no Anthropic API key/)
    kvSet('agent:anthropic_key', 'sk-ant-testkeytestkeytestkey1234567890')
  })
})
