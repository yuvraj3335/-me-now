/**
 * The gates, exercised rather than described.
 *
 * Two claims this project makes are only worth anything if they hold in code:
 * a tool that needs a human BLOCKS, and nothing reaches the outside world
 * through a shell. Both are tested here against the real implementations, with
 * the subprocess binaries pointed at paths that do not exist so an accidental
 * call fails loudly instead of touching a live platform.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { db, now, uid } from '../src/server/db'
import { TOOLS, type ToolCtx } from '../src/server/agent/tools'
import { listPending, resolveApproval, requestApproval, expireOrphans } from '../src/server/agent/approvals'
import { cancelTurn, isRunning } from '../src/server/agent/turns'
import { eventsSince } from '../src/server/agent/events'
import { McpSession, McpError } from '../src/server/mcp/client'

let convId: string
let turnId: string

const ctx = (): ToolCtx => ({
  turnId,
  convId,
  mode: 'support',
  profile: 'test-profile',
  repoPath: null,
  signal: new AbortController().signal,
  sawInjection: false,
})

beforeAll(() => {
  convId = uid()
  turnId = uid()
  db.query(`INSERT INTO conversations (id, title, mode, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(convId, 'gates', 'support', now(), now())
  db.query(
    `INSERT INTO turns (id, conv_id, state, mode, prompt, started_at, heartbeat_at)
     VALUES (?,?,'running','support','p',?,?)`,
  ).run(turnId, convId, now(), now())
})

/** Wait for the tool to have raised its card, then answer it. */
async function answer(state: 'approved' | 'denied', text?: string) {
  for (let i = 0; i < 100; i++) {
    const pending = listPending(convId)
    if (pending.length) return resolveApproval(pending[0]!.id, state, text)
    await Bun.sleep(5)
  }
  throw new Error('no approval was ever raised — the tool did not block')
}

describe('a tool that needs a human blocks', () => {
  test('the call does not return until the card is answered', async () => {
    const call = TOOLS.ask_user!.handler({ question: 'Which environment?', options: [{ label: 'prod' }] }, ctx())

    let settled = false
    void call.then(() => { settled = true })
    await Bun.sleep(30)
    // The claim under test: the model's turn is *waiting*, not polling.
    expect(settled).toBe(false)

    await answer('approved', 'staging')
    expect(await call).toEqual({ answered: true, answer: 'staging' })
  })

  test('a denial is reported as a denial, not swallowed', async () => {
    const call = requestApproval({
      turnId, convId, kind: 'mutation', tool: 'truto_apply', title: 'change something',
    })
    await answer('denied')
    expect((await call).state).toBe('denied')
  })

  test('the approval is written before the card is shown, so a reload can answer it', async () => {
    const call = requestApproval({ turnId, convId, kind: 'question', tool: 'ask_user', title: 'q' })
    await Bun.sleep(20)
    // Durable half: a fresh page load reads this row, not an in-memory promise.
    expect(listPending(convId).length).toBeGreaterThan(0)
    expect(eventsSince(turnId, 0).some(e => e.type === 'question')).toBe(true)
    await answer('approved', 'yes')
    await call
  })
})

describe('the writable tools refuse to run blind', () => {
  test('truto_apply will not proceed without an identity', async () => {
    // whoami runs BEFORE the approval card, so a write can never be approved
    // against an unknown team. With no CLI on the path it fails here, which is
    // the correct order failing loudly.
    await expect(
      TOOLS.truto_apply!.handler(
        { argv: ['webhooks', 'create'], why: 'because', verify: ['webhooks', 'list'] },
        ctx(),
      ),
    ).rejects.toThrow(/could not resolve Truto identity/)
  })

  test('truto_run refuses a mutation outright rather than asking', async () => {
    const r: any = await TOOLS.truto_run!.handler({ argv: ['integrations', 'update', 'x'] }, ctx())
    expect(r.error).toContain('classifies as Mutation')
    expect(r.note).toContain('truto_apply')
  })

  test('a read-only mode cannot reach the mutation path at all', async () => {
    const r: any = await TOOLS.truto_apply!.handler(
      { argv: ['webhooks', 'create'], why: 'x', verify: ['webhooks', 'list'] },
      { ...ctx(), mode: 'triage' },
    )
    expect(r.error).toContain('read-only')
  })

  test('claude_launch reports an unusable binary instead of pretending', async () => {
    const r: any = await TOOLS.claude_launch!.handler(
      { template: 'blank', instruction: 'do a thing' },
      { ...ctx(), mode: 'engineering' },
    )
    expect(r.launched).toBe(false)
    expect(r.error).toMatch(/not runnable|not signed in/)
  })

  test('mail_draft says Gmail is unavailable rather than preparing a send', async () => {
    const r: any = await TOOLS.mail_draft!.handler(
      { account: 'me@example.com', to: ['x@y.z'], subject: 's', body: 'b' },
      ctx(),
    )
    expect(r.prepared).toBe(false)
    expect(r.error).toBeTruthy()
  })

  test('slack_draft never claims to have posted', async () => {
    const r: any = await TOOLS.slack_draft!.handler({ message: 'hello' }, ctx())
    expect(r.drafted).toBe(true)
    expect(r.note).toContain('Do not say it was posted')
  })
})

describe('turn lifecycle', () => {
  test('cancelling a turn that is not running is reported honestly', () => {
    expect(isRunning('nope')).toBe(false)
    expect(cancelTurn('nope')).toBe(false)
  })

  test('orphaned approvals are expired at boot rather than left on screen', async () => {
    void requestApproval({ turnId, convId, kind: 'question', tool: 'ask_user', title: 'orphan' })
    await Bun.sleep(10)
    expect(expireOrphans()).toBeGreaterThan(0)
    expect(listPending(convId)).toHaveLength(0)
  })
})

describe('no shell, anywhere', () => {
  const serverFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap(entry => {
      const p = join(dir, entry)
      return statSync(p).isDirectory() ? serverFiles(p) : p.endsWith('.ts') ? [p] : []
    })

  test('nothing spawns a shell', () => {
    for (const file of serverFiles('src/server')) {
      const body = readFileSync(file, 'utf8')
      expect(body, `${file} spawns a shell`).not.toMatch(/Bun\.spawn(Sync)?\(\s*\[?\s*['"`](sh|bash|zsh|\/bin\/sh)['"`]/)
      expect(body, `${file} uses sh -c`).not.toContain("'-c'")
    }
  })

  test('every spawn is an argument array, not an interpolated string', () => {
    for (const file of serverFiles('src/server')) {
      const body = readFileSync(file, 'utf8')
      // A template literal as the first argument to spawn is the shape that
      // turns a customer name with a semicolon into a second command.
      expect(body, `${file} interpolates a command`).not.toMatch(/Bun\.spawn(Sync)?\(\s*`/)
    }
  })

  test('no tool is named anything shell-shaped', () => {
    for (const t of Object.values(TOOLS)) {
      expect(t.name).not.toMatch(/^(bash|sh|shell|exec|eval|run_command|terminal)$/i)
    }
  })
})

describe('the ingest path stays read-only', () => {
  const session = new McpSession('test', {
    request: async () => ({ content: [] }),
    notify: async () => {},
    close: async () => {},
  })

  test('a mutation-shaped tool name is refused by the client itself', async () => {
    for (const name of ['send_message', 'create_draft', 'delete_thread', 'modify_message', 'post_message', 'mark_read']) {
      await expect(session.callTool(name)).rejects.toThrow(McpError)
    }
  })

  test('read tools pass', async () => {
    for (const name of ['search_threads', 'get_thread', 'list_labels']) {
      await expect(session.callTool(name)).resolves.toBeDefined()
    }
  })

  test('the write door exists, is named, and is used by exactly one module', () => {
    // A denylist with an unnamed bypass is worse than no denylist. This asserts
    // the bypass has one caller, so a future edit that widens it is visible.
    const callers = serverFilesWithWrite()
    expect(callers).toEqual(['src/server/mail/gmail.ts'])
  })
})

function serverFilesWithWrite(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(entry => {
      const p = join(dir, entry)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
  return walk('src/server')
    .filter(f => !f.endsWith('mcp/client.ts'))
    .filter(f => /callWrite(Tool|Json)\s*(<[^>]*>)?\(/.test(readFileSync(f, 'utf8')))
}
