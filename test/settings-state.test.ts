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
})
