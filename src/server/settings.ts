/**
 * Settings, as an API.
 *
 * The page it backs is meant to read like a product rather than a README, so
 * everything here answers a question in a sentence: is this connected, through
 * which credential, and what is the one thing to do about it. The shell command
 * that fixes a source is still available — behind a disclosure — because when it
 * is the answer, it is the whole answer.
 *
 * Nothing in this file ever returns a secret. The Anthropic key comes back as a
 * presence, a source and four characters.
 */

import { Hono } from 'hono'
import { audit, db } from './db'
import { keyStatus, setKey } from './agent/key'
import { AGENT_MODEL, GMAIL_ACCOUNTS, ME, PUBLIC_URL, WORKSPACE_ROOT } from './env'
import { remoteStatus } from './agent/remote'
import { launcherStatus } from './claudecode/launch'
import { listSessions } from './sources/claudeSessions'
import { probeMail } from './mail/gmail'
import { sttStatus, storageUsed, verifyStorage } from './voice/store'
import { listSkills } from './skills/catalog'
import { listRepos } from './registry/scan'
import { listProfiles, whoami } from './truto/cli'
import { MODE_LIST } from './agent/modes'

export const settings = new Hono()

settings.get('/', async c => {
  const skills = listSkills()
  const byCatalog: Record<string, number> = {}
  for (const s of skills) byCatalog[s.catalog] = (byCatalog[s.catalog] ?? 0) + 1

  const launcher = launcherStatus()
  const mail = await probeMail()

  return c.json({
    agent: {
      key: keyStatus(),
      model: AGENT_MODEL,
      modes: MODE_LIST.length,
      // Two engines, named so the difference is visible rather than folded away.
      engine: 'Anthropic API (key held by Wake)',
    },
    claudeCode: {
      ...launcher,
      recentSessions: listSessions(50, 30).length,
    },
    mail: {
      connected: mail.connected,
      reason: mail.reason,
      accounts: mail.accounts,
      canSend: mail.canSend,
      canDraft: mail.canDraft,
      discovered: mail.discovered,
    },
    voice: { stt: sttStatus(), storage: storageUsed(), ...verifyStorage() },
    skills: { total: skills.length, byCatalog },
    workspace: { root: WORKSPACE_ROOT, repos: listRepos().length },
    remote: remoteStatus(),
    identity: { emails: ME.emails, github: ME.githubLogin, gmailAccounts: GMAIL_ACCOUNTS },
    publicUrl: PUBLIC_URL,
  })
})

/** Truto identity, resolved live. Never the token — only who it says you are. */
settings.get('/truto', async c => {
  const profiles = await listProfiles().catch(() => [])
  const requested = c.req.query('profile') ?? profiles[0] ?? null
  if (!requested) {
    return c.json({ profiles, active: null, error: 'no Truto CLI profiles on this machine' })
  }
  try {
    const id = await whoami(requested)
    return c.json({ profiles, active: { profile: requested, team: id.team, user: id.user, apiUrl: id.apiUrl } })
  } catch (e) {
    return c.json({ profiles, active: null, error: (e as Error).message })
  }
})

settings.post('/agent/key', async c => {
  const { key } = await c.req.json<{ key: string }>().catch(() => ({ key: '' }))
  const r = setKey(String(key ?? ''))
  if (!r.ok) return c.json({ error: r.error }, 400)
  audit('settings.agent_key', { target: key ? 'set' : 'cleared' })
  return c.json({ ok: true, key: keyStatus() })
})

/** The security audit trail, and the tool calls behind it. */
settings.get('/audit', c => {
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)
  return c.json({
    events: db
      .query<Record<string, any>, [number]>(
        `SELECT id, kind, actor, turn_id, target, ok, error, at FROM audit_events ORDER BY id DESC LIMIT ?`,
      )
      .all(limit),
    commands: db
      .query<Record<string, any>, [number]>(
        `SELECT id, turn_id, profile, argv, class, exit_code, ms, ok, at FROM cli_audit ORDER BY id DESC LIMIT ?`,
      )
      .all(limit)
      .map(r => ({ ...r, argv: safe(r.argv) })),
    tools: db
      .query<Record<string, any>, [number]>(
        `SELECT id, turn_id, name, mutates, ok, ms, error, at FROM agent_tool_calls ORDER BY at DESC LIMIT ?`,
      )
      .all(limit),
  })
})

function safe(v: string | null): string[] {
  try {
    const p = JSON.parse(v ?? '[]')
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}
