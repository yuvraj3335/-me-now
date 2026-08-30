/**
 * The Wake Agent's tool loop.
 *
 * Wake owns this loop rather than delegating it, and that is the whole reason
 * the product can gate anything: a tool that needs a human *blocks inside the
 * call*, and the model's turn simply waits. Nothing here asks the model to
 * please stop and check — it physically cannot proceed.
 *
 * The engine is the Anthropic SDK with a key Wake holds (`key.ts`). It is not
 * the `claude` binary; that one is a different feature ("Open in Claude Code"),
 * with different authentication and a different job. See DECISIONS.md #14.
 *
 * Everything visible is narrated into `turn_events` before it reaches a browser,
 * so the stream is a replay of a durable log rather than a pipe from the model.
 */

import Anthropic from '@anthropic-ai/sdk'
import { db, now, uid } from '../db'
import { AGENT_MAX_STEPS, AGENT_MAX_TOKENS, AGENT_MODEL, AGENT_TOOL_RESULT_MAX } from '../env'
import { emit } from './events'
import { agentKey, AGENT_KEY_MISSING } from './key'
import { getMode, type ModeId } from './modes'
import { redactJson } from './redact'
import { TOOLS, isAllowed, toolsForMode, type ToolCtx } from './tools'
import { inspect } from './guard'

export type EngineResult = {
  state: 'done' | 'error' | 'cancelled'
  text: string
  error?: string
  usage: { input: number; output: number; cacheRead: number; steps: number }
}

/**
 * Text arrives as hundreds of tiny deltas. One event log row per delta would
 * turn a paragraph into 300 rows and 300 SSE frames; one row per *block* would
 * make the reader wait for the whole paragraph. Flushing on either a character
 * count or a short interval keeps both the log and the stream honest.
 */
const FLUSH_CHARS = 180
const FLUSH_MS = 220

class TextPump {
  private buf = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly sink: (text: string) => void) {}

  push(chunk: string) {
    this.buf += chunk
    if (this.buf.length >= FLUSH_CHARS) return this.flush()
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), FLUSH_MS)
    this.timer.unref?.()
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.buf) return
    const out = this.buf
    this.buf = ''
    this.sink(out)
  }
}

type Block = Anthropic.ContentBlockParam
type Msg = Anthropic.MessageParam

export type EngineOpts = {
  turnId: string
  convId: string
  mode: ModeId
  profile: string | null
  repoPath: string | null
  system: string
  /** Prior turns, already trimmed by the caller. */
  history: Msg[]
  prompt: string
  signal: AbortSignal
  model?: string | null
}

export async function runEngine(opts: EngineOpts): Promise<EngineResult> {
  const key = agentKey()
  const usage = { input: 0, output: 0, cacheRead: 0, steps: 0 }
  if (!key) {
    return { state: 'error', text: '', error: AGENT_KEY_MISSING, usage }
  }

  const client = new Anthropic({ apiKey: key, maxRetries: 2 })
  const mode = getMode(opts.mode)

  const tools: Anthropic.Tool[] = toolsForMode(opts.mode).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }))

  const messages: Msg[] = [...opts.history, { role: 'user', content: opts.prompt }]

  const ctx: ToolCtx = {
    turnId: opts.turnId,
    convId: opts.convId,
    mode: opts.mode,
    profile: opts.profile,
    repoPath: opts.repoPath,
    signal: opts.signal,
    /**
     * Set the first time any tool result trips the injection detector. Later
     * approval cards in the same turn carry it, so the human deciding on a write
     * is told that something in this investigation tried to steer the agent.
     */
    sawInjection: false,
  }

  let finalText = ''

  for (let step = 0; step < AGENT_MAX_STEPS; step++) {
    if (opts.signal.aborted) return { state: 'cancelled', text: finalText, usage }
    usage.steps = step + 1

    const pump = new TextPump(text => emit(opts.turnId, 'text', { text }))
    let assistant: Anthropic.Message

    try {
      const stream = client.messages.stream(
        {
          model: opts.model || AGENT_MODEL,
          max_tokens: AGENT_MAX_TOKENS,
          system: opts.system,
          tools,
          messages,
        },
        { signal: opts.signal },
      )

      for await (const ev of stream) {
        if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') pump.push(ev.delta.text)
          else if (ev.delta.type === 'thinking_delta') pump.flush()
        }
      }
      pump.flush()
      assistant = await stream.finalMessage()
    } catch (e) {
      pump.flush()
      if (opts.signal.aborted) return { state: 'cancelled', text: finalText, usage }
      return { state: 'error', text: finalText, error: describe(e), usage }
    }

    usage.input += assistant.usage?.input_tokens ?? 0
    usage.output += assistant.usage?.output_tokens ?? 0
    usage.cacheRead += assistant.usage?.cache_read_input_tokens ?? 0
    emit(opts.turnId, 'usage', { ...usage })

    // Thinking is emitted from the assembled message rather than from deltas:
    // a partial thinking block is not something anyone benefits from reading.
    for (const block of assistant.content) {
      if (block.type === 'thinking' && block.thinking) {
        emit(opts.turnId, 'thinking', { text: block.thinking })
      } else if (block.type === 'text') {
        finalText += block.text
      }
    }

    const calls = assistant.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )
    if (!calls.length) {
      return { state: 'done', text: finalText, usage }
    }

    messages.push({ role: 'assistant', content: assistant.content as Block[] })

    // Tools run in sequence, not in parallel. Two mutating tools racing to a
    // blocking approval would put two cards on screen with no defined order,
    // and an investigation reads better as a sequence anyway.
    const results: Block[] = []
    for (const call of calls) {
      if (opts.signal.aborted) return { state: 'cancelled', text: finalText, usage }
      results.push(await invoke(call, ctx, mode.label))
    }
    messages.push({ role: 'user', content: results })
  }

  emit(opts.turnId, 'notice', {
    text: `Stopped after ${AGENT_MAX_STEPS} steps without reaching an answer. Ask a narrower question, or say "continue".`,
  })
  return { state: 'done', text: finalText, usage }
}

/* ------------------------------ one tool call ----------------------------- */

async function invoke(
  call: Anthropic.ToolUseBlock,
  ctx: ToolCtx,
  modeLabel: string,
): Promise<Anthropic.ToolResultBlockParam> {
  const tool = TOOLS[call.name]
  const args = (call.input ?? {}) as Record<string, any>
  const started = Date.now()
  const rowId = uid()

  const fail = (message: string) => {
    emit(ctx.turnId, 'tool_result', { id: call.id, ok: false, result: message })
    record(rowId, ctx, call, false, Date.now() - started, message)
    return {
      type: 'tool_result' as const,
      tool_use_id: call.id,
      is_error: true,
      content: JSON.stringify({ error: message }),
    }
  }

  emit(ctx.turnId, 'tool_use', {
    id: call.id,
    name: call.name,
    input: redactJson(args),
    mutates: !!tool?.mutates,
  })

  if (!tool) return fail(`no tool named "${call.name}"`)

  // Checked here and not only when the tool list was built: a model that
  // remembers a name from an earlier turn in another mode would otherwise still
  // be able to call it.
  if (!isAllowed(ctx.mode, call.name)) {
    return fail(`"${call.name}" is not available in ${modeLabel} mode.`)
  }
  if (tool.mutates && getMode(ctx.mode).readOnly) {
    return fail(`${modeLabel} mode is read-only, so "${call.name}" cannot run here.`)
  }

  try {
    const result = await tool.handler(args, ctx)
    const text = JSON.stringify(result ?? null) ?? 'null'

    // The detector runs on what the tool returned, not on what the model asked
    // for: the threat is text a stranger wrote arriving through a tool.
    if (!ctx.sawInjection && inspect(text).suspicious) {
      ctx.sawInjection = true
      emit(ctx.turnId, 'notice', {
        text: 'Something in that tool result reads like an instruction aimed at the agent. It is being treated as data, and any write from here on will say so on its approval card.',
      })
    }

    emit(ctx.turnId, 'tool_result', { id: call.id, ok: true, result: preview(result) })
    record(rowId, ctx, call, true, Date.now() - started, null)
    return {
      type: 'tool_result',
      tool_use_id: call.id,
      content: text.length > AGENT_TOOL_RESULT_MAX
        ? text.slice(0, AGENT_TOOL_RESULT_MAX) +
          `\n…[truncated by Wake at ${AGENT_TOOL_RESULT_MAX} characters — narrow the query for the rest]`
        : text,
    }
  } catch (e) {
    // Returned to the model as a tool error rather than thrown: a failing tool
    // is information the agent can act on, not a reason to tear the turn down.
    return fail(describe(e))
  }
}

function record(
  id: string,
  ctx: ToolCtx,
  call: Anthropic.ToolUseBlock,
  ok: boolean,
  ms: number,
  error: string | null,
) {
  db.query(
    `INSERT INTO agent_tool_calls (id, turn_id, conv_id, name, mutates, ok, ms, error, at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, ctx.turnId, ctx.convId, call.name, TOOLS[call.name]?.mutates ? 1 : 0, ok ? 1 : 0, ms, error, now())
}

/** A bounded, redacted copy of a tool result for the event log and the UI. */
function preview(value: unknown): unknown {
  const json = JSON.stringify(redactJson(value))
  if (json === undefined) return null
  return json.length <= 8_000 ? JSON.parse(json) : { _preview: json.slice(0, 8_000) + '…' }
}

/**
 * API errors carry the actionable part in `.error.message`; the default
 * `toString` buries it under a status line, and "400 Bad Request" tells nobody
 * that the model name was wrong.
 */
function describe(e: unknown): string {
  if (e instanceof Anthropic.APIError) {
    const body = (e as any).error?.error?.message ?? (e as any).error?.message
    const base = body ? String(body) : e.message
    if (e.status === 401) return `Anthropic rejected the API key (401). ${base}`
    if (e.status === 429) return `Anthropic rate-limited this key (429). ${base}`
    return `Anthropic API ${e.status ?? ''}: ${base}`.trim()
  }
  return (e as Error)?.message ?? String(e)
}
