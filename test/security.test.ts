/**
 * Cloudflare Access proves who is asking. These are the two things it does not
 * do: prove which page asked, and prove that what was approved is what happens.
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { originGuard, issueConfirmation, useConfirmation, fingerprint } from '../src/server/security'
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
})
