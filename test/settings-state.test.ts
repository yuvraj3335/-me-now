/**
 * Settings' source word. A held token is never "not connected".
 */
import { describe, expect, test } from 'bun:test'
import { stateWord } from '../src/web/pages/Settings'
import type { SourceStatus } from '../src/web/lib/types'

const base = {
  name: 'slack' as const,
  label: 'Slack',
  detail: '',
  lastSync: null,
  oauthable: true,
  connectable: true,
  hasClaudeBridge: false,
  hasClientId: true,
  needsClientId: false,
}

const row = (patch: Partial<SourceStatus>): SourceStatus => ({
  ...base,
  ok: false,
  hasWakeToken: false,
  ...patch,
})

describe('stateWord', () => {
  test('a token Wake holds is never not connected', () => {
    const word = stateWord(row({
      hasWakeToken: true,
      ok: false,
      lastSync: { ok: 0, connected: 0, at: 1, count: null, error: 'no search tool' },
    }))
    expect(word.text).toBe('sync failed')
    expect(word.tone).toBe('text-warn')
  })

  test('no credential and no successful poll is not connected', () => {
    expect(stateWord(row({ ok: false, hasWakeToken: false })).text).toBe('not connected')
  })

  test('a working poll is synced', () => {
    const word = stateWord(row({
      hasWakeToken: true,
      ok: true,
      lastSync: { ok: 1, connected: 1, at: Date.now() - 60_000, count: 4, error: null },
    }))
    expect(word.text).toMatch(/^synced /)
    expect(word.text).toContain('· 4')
    expect(word.tone).toBe('text-ok')
  })

  /*
   * `last_auth_error` holds two different kinds of thing, and only one of them
   * outranks a working poll.
   *
   * A provider's own refusal — `invalid_grant`, `token_revoked` — is recorded
   * with the tokens cleared, so it always arrives here with `ok: false`. A
   * transient failure is recorded with the grant deliberately left intact
   * (`refresh.test.ts` pins that a 500 keeps the refresh token), and nothing
   * clears the field until some later refresh succeeds — which never happens
   * while the access token is still valid. Reading any non-null value as
   * terminal therefore pinned a healthy source to `reconnect — …` for the rest
   * of that token's life.
   */
  test('a stale transient error does not overrule a source that is working', () => {
    const word = stateWord(row({
      hasWakeToken: true,
      ok: true,
      lastAuthError: 'refresh failed: 500 upstream is having a bad minute',
      lastSync: { ok: 1, connected: 1, at: Date.now() - 60_000, count: 4, error: null },
    }))
    expect(word.text, 'a working source was told to reconnect').not.toContain('reconnect')
    expect(word.text).toMatch(/^synced /)
  })

  test('a refusal still speaks when the source really is refusing', () => {
    const word = stateWord(row({
      hasWakeToken: false,
      ok: false,
      lastAuthError: 'invalid_grant',
    }))
    expect(word.text).toBe('reconnect — invalid_grant')
    expect(word.tone).toBe('text-warn')
  })
})
