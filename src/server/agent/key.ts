/**
 * The Wake Agent's Anthropic credential.
 *
 * Two sources, in order: what Settings stored, then the environment. Settings
 * wins because a key pasted into the running app should take effect without a
 * deploy — and because the environment on this box is shared with the `truto`
 * CLI and with Claude Code, neither of which should be billed to this key.
 *
 * The value never leaves this module in full. Everything the UI is told about it
 * is a shape: whether one exists, where it came from, and its last four
 * characters, which is enough to tell two keys apart and not enough to use one.
 */

import { kvGet, kvSet, db } from '../db'
import { ANTHROPIC_KEY_ENV } from '../env'

const KV_KEY = 'agent:anthropic_key'

export type KeyStatus = {
  present: boolean
  via: 'settings' | 'env' | 'none'
  last4: string | null
}

export function agentKey(): string | null {
  const stored = kvGet(KV_KEY)?.trim()
  if (stored) return stored
  return ANTHROPIC_KEY_ENV || null
}

export function keyStatus(): KeyStatus {
  const stored = kvGet(KV_KEY)?.trim()
  if (stored) return { present: true, via: 'settings', last4: stored.slice(-4) }
  if (ANTHROPIC_KEY_ENV) return { present: true, via: 'env', last4: ANTHROPIC_KEY_ENV.slice(-4) }
  return { present: false, via: 'none', last4: null }
}

/**
 * Reject anything that is not shaped like an Anthropic key before storing it.
 * A typo saved silently produces a 401 at the worst moment — mid-turn, in front
 * of the person who thought they had just fixed it.
 */
export function setKey(value: string): { ok: boolean; error?: string } {
  const v = value.trim()
  if (!v) {
    db.query(`DELETE FROM kv WHERE k = ?`).run(KV_KEY)
    return { ok: true }
  }
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(v)) {
    return { ok: false, error: 'that does not look like an Anthropic API key (expected sk-ant-…)' }
  }
  kvSet(KV_KEY, v)
  return { ok: true }
}

export const AGENT_KEY_MISSING =
  'The Wake Agent has no Anthropic API key. Add one in Settings → Agent. ' +
  'This is a different credential from the `claude` CLI on this machine, which ' +
  'is what "Open in Claude Code" uses — that one needs nothing from Wake.'
