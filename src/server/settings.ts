/**
 * Settings, as an API.
 *
 * The page it backs is meant to read like a product rather than a README, so
 * everything here answers a question in a sentence: is this connected, through
 * which credential, and what is the one thing to do about it. The shell command
 * that fixes a source is still available — behind a disclosure — because when it
 * is the answer, it is the whole answer.
 *
 * Nothing in this file ever returns a secret, and Wake now holds no model
 * credential of its own to return: "Open in Claude" opens a link under the
 * Claude login you already have.
 */

import { Hono } from 'hono'
import { db } from './db'
import { GMAIL_ACCOUNTS, HANDOFF_MAX_CHARS, ME, PUBLIC_URL, WORKSPACE_ROOT } from './env'
import { handoffTarget } from './claudecode/handoff'
import { listSessions } from './sources/claudeSessions'
import { probeMail } from './mail/gmail'
import { sttStatus, storageUsed, verifyStorage } from './voice/store'
import { listSkills } from './skills/catalog'
import { listRepos } from './registry/scan'
import { listProfiles, whoami } from './truto/cli'
import { TEMPLATES } from './claudecode/templates'

export const settings = new Hono()

settings.get('/', async c => {
  const skills = listSkills()
  const byCatalog: Record<string, number> = {}
  for (const s of skills) byCatalog[s.catalog] = (byCatalog[s.catalog] ?? 0) + 1

  const mail = await probeMail()

  return c.json({
    handoff: {
      url: handoffTarget(),
      maxChars: HANDOFF_MAX_CHARS,
      templates: TEMPLATES.length,
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
    identity: { emails: ME.emails, github: ME.githubLogin, gmailAccounts: GMAIL_ACCOUNTS },
    publicUrl: PUBLIC_URL,
  })
})

/** Truto identity, resolved live. Never the token — only who it says you are. */
settings.get('/truto', async c => {
  let profiles: string[]
  try {
    profiles = await listProfiles()
  } catch (e) {
    // `catch(() => [])` here turned a CLI that did not answer into an empty
    // list, and the empty list into "no Truto CLI profiles on this machine" —
    // a claim about the machine derived from a failure to ask it anything. The
    // row spent a release saying that about a machine with thirty-five of them.
    return c.json({
      profiles: [],
      active: null,
      error: `the Truto CLI did not answer: ${(e as Error).message}`,
    })
  }
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

/** The security audit trail, and the tool calls behind it. */
settings.get('/audit', c => {
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)
  return c.json({
    events: db
      .query<Record<string, any>, [number]>(
        `SELECT id, kind, actor, target, ok, error, at FROM audit_events ORDER BY id DESC LIMIT ?`,
      )
      .all(limit),
    commands: db
      .query<Record<string, any>, [number]>(
        `SELECT id, profile, argv, class, exit_code, ms, ok, at FROM cli_audit ORDER BY id DESC LIMIT ?`,
      )
      .all(limit)
      .map(r => ({ ...r, argv: safe(r.argv) })),
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
