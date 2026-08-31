/**
 * Cloudflare Access proves who is asking. These are the two things it does not
 * do: prove which page asked, and prove that what was approved is what happens.
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  originGuard, issueConfirmation, useConfirmation, fingerprint, sweepConfirmations,
} from '../src/server/security'
import { db } from '../src/server/db'
import { ALLOWED_ORIGINS, PUBLIC_URL } from '../src/server/env'

const app = new Hono()
app.use('*', originGuard())
app.get('/api/read', c => c.json({ ok: true }))
app.post('/api/write', c => c.json({ ok: true }))
app.post('/api/connections/callback', c => c.json({ ok: true }))

const call = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://localhost:8585${path}`, init))

describe('origin guard', () => {
  test('reads are never blocked', async () => {
    expect((await call('/api/read', { headers: { origin: 'https://evil.example' } })).status).toBe(200)
  })

  test('a write from another origin is refused', async () => {
    const r = await call('/api/write', { method: 'POST', headers: { origin: 'https://evil.example' } })
    expect(r.status).toBe(403)
    expect((await r.json()).error).toContain('evil.example')
  })

  test('a write from Wake’s own origin passes', async () => {
    const r = await call('/api/write', { method: 'POST', headers: { origin: ALLOWED_ORIGINS[0]! } })
    expect(r.status).toBe(200)
  })

  test('Sec-Fetch-Site is honoured before Origin', async () => {
    // A browser that sends it gives the cleanest answer available, and it is
    // sent even on requests that carry no Origin.
    const r = await call('/api/write', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', origin: ALLOWED_ORIGINS[0]! },
    })
    expect(r.status).toBe(403)
  })

  test('same-origin passes with no Origin header at all', async () => {
    const r = await call('/api/write', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
    expect(r.status).toBe(200)
  })

  test('the OAuth callback is exempt, and nothing else is', async () => {
    expect((await call('/api/connections/callback', { method: 'POST', headers: { origin: 'https://slack.com' } })).status).toBe(200)
    expect((await call('/api/write', { method: 'POST', headers: { origin: 'https://slack.com' } })).status).toBe(403)
  })

  test('the public URL is always allowed', () => {
    expect(ALLOWED_ORIGINS).toContain(PUBLIC_URL)
  })
})

describe('confirmation tokens', () => {
  const draft = { account: 'me@example.com', to: ['x@y.z'], subject: 'hi', body: 'the body' }

  test('a token spends exactly once', () => {
    const { token } = issueConfirmation('mail.send', draft)
    expect(useConfirmation(token, 'mail.send', draft).ok).toBe(true)
    const second = useConfirmation(token, 'mail.send', draft)
    expect(second.ok).toBe(false)
    expect(second.ok === false && second.reason).toContain('already used')
  })

  test('changing the body invalidates the approval', () => {
    // The case the whole mechanism exists for: approve, edit, send.
    const { token } = issueConfirmation('mail.send', draft)
    const r = useConfirmation(token, 'mail.send', { ...draft, body: 'the body, plus a sentence' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('changed after it was approved')
  })

  test('changing a recipient invalidates it too', () => {
    const { token } = issueConfirmation('mail.send', draft)
    expect(useConfirmation(token, 'mail.send', { ...draft, to: ['someone@else.com'] }).ok).toBe(false)
  })

  test('a token cannot be spent on a different kind of action', () => {
    const { token } = issueConfirmation('mail.send', draft)
    const r = useConfirmation(token, 'slack.post', draft)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('different action')
  })

  test('an unknown token is refused rather than ignored', () => {
    expect(useConfirmation('not-a-token', 'mail.send', draft).ok).toBe(false)
  })

  test('the fingerprint is order-independent for the same value', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ a: 1, b: 2 }))
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }))
  })

  /*
   * The sweep has to collect the rows it was written for.
   *
   * `DELETE … WHERE expires_at < ? AND state != 'used'` excluded exactly the
   * spent tokens the scheduler's own comment calls noise, so `confirmations`
   * gained one permanent row per approved send and per approved delete and
   * never lost it. Nothing about that is visible from the product, which is
   * why it needs a test rather than a screenshot.
   */
  test('a spent token is swept once it has expired', () => {
    const { token } = issueConfirmation('mail.send', { ...draft, subject: 'sweep me' })
    expect(useConfirmation(token, 'mail.send', { ...draft, subject: 'sweep me' }).ok).toBe(true)

    const row = () => db
      .query<{ n: number }, [string]>(`SELECT count(*) AS n FROM confirmations WHERE id = ?`)
      .get(token)!.n

    expect(row(), 'the spent token was not stored at all').toBe(1)

    // Past the sweep's own 24h grace. An expired token cannot be spent again
    // whatever its state, which is what makes deleting it safe.
    db.query(`UPDATE confirmations SET expires_at = ? WHERE id = ?`)
      .run(Date.now() - 48 * 3.6e6, token)

    sweepConfirmations()
    expect(row(), 'a used token survived the sweep that exists to remove it').toBe(0)
  })

  test('a live token is left alone by the sweep', () => {
    const { token } = issueConfirmation('mail.send', { ...draft, subject: 'still live' })
    sweepConfirmations()
    expect(useConfirmation(token, 'mail.send', { ...draft, subject: 'still live' }).ok, 'the sweep ate a live approval')
      .toBe(true)
  })
})

/* ---------------------------------------------------------------------------
 * The write door.
 *
 * `DECISIONS.md` §7 said "a test asserts exactly one module calls it". It did
 * not. This is that test, written before the surfaces around mail were touched
 * so the revamp runs into it rather than past it.
 *
 * The rule it holds: `callTool` refuses anything matching the mutation denylist,
 * and `callWriteTool` is the single sanctioned way past that denylist. A second
 * module reaching for the write door is not a refactor — it is a new outbound
 * write, and it needs its own gate and its own audit line first.
 * ------------------------------------------------------------------------- */

import { readdirSync as _readdirSync, readFileSync as _readFileSync, statSync as _statSync } from 'node:fs'
import { join as _join } from 'node:path'

const serverFiles = (dir: string): string[] =>
  _readdirSync(dir).flatMap(entry => {
    const p = _join(dir, entry)
    return _statSync(p).isDirectory() ? serverFiles(p) : /\.ts$/.test(p) ? [p] : []
  })

describe('the MCP write door stays confined to one module', () => {
  /**
   * Where the door itself lives (the class that defines it), and the thin
   * per-account wrapper that forwards to it. Neither decides to write; both are
   * plumbing for the one module that does.
   */
  const PLUMBING = ['src/server/mcp/client.ts', 'src/server/mail/gmail.ts']
  /** The one module allowed to actually open it. */
  const CALLER = 'src/server/mail/service.ts'

  const mentions = serverFiles('src/server').filter(f =>
    /\bcallWrite(?:Tool|Json)?\b/.test(_readFileSync(f, 'utf8')),
  )

  test('no module outside mail/service.ts calls the write door', () => {
    const unexpected = mentions.filter(f => !PLUMBING.includes(f) && f !== CALLER)
    expect(unexpected, 'a new module reached for the outbound write path').toEqual([])
  })

  test('mail/service.ts is still the caller, at its two known sites', () => {
    expect(mentions).toContain(CALLER)
    const calls = _readFileSync(CALLER, 'utf8')
      .split('\n')
      .filter(l => /\bcallWrite\s*</.test(l) || /\bcallWrite\s*\(/.test(l))
    // Send and draft. A third is a new outbound write and has to be decided on,
    // not inherited from a green suite.
    expect(calls.length, 'the number of outbound writes changed').toBe(2)
  })

  test('the denylist still catches the tool the door exists for', () => {
    // `modify_message` is Gmail's mutation for mark-read, archive, star and
    // label. It is the exact shape a "make the inbox real" change reaches for.
    const client = _readFileSync('src/server/mcp/client.ts', 'utf8')
    const re = /const WRITE_TOOL\s*=\s*\n?\s*(\/(?:[^\n\\/]|\\.|\[[^\]]*\])*\/[a-z]*)/.exec(client)
    expect(re, 'the mutation denylist is no longer a literal regex').not.toBeNull()
    // eslint-disable-next-line no-eval
    const denylist = eval(re![1]!) as RegExp
    for (const tool of ['modify_message', 'send_message', 'trash_message', 'create_draft']) {
      expect(denylist.test(tool), `${tool} is no longer refused by callTool`).toBe(true)
    }
    expect(denylist.test('search_threads')).toBe(false)
    expect(denylist.test('get_thread')).toBe(false)
  })

  test('callTool refuses a denylisted name and callWriteTool does not', () => {
    const client = _readFileSync('src/server/mcp/client.ts', 'utf8')
    // The gate is inside callTool, not at the transport: moving it to `invoke`
    // would make callWriteTool refuse too, and moving it out of callTool would
    // make the denylist decorative.
    const callTool = client.slice(client.indexOf('async callTool('), client.indexOf('async callWriteTool('))
    expect(callTool, 'callTool no longer checks the denylist').toMatch(/WRITE_TOOL\.test\(name\)/)
    expect(callTool).toMatch(/throw new McpError/)
  })
})
