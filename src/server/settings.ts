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
import { db, audit } from './db'
import { GMAIL_ACCOUNTS, HANDOFF_MAX_CHARS, ME, PUBLIC_URL, WORKSPACE_ROOT } from './env'
import { handoffTarget } from './claudecode/handoff'
import { listSessions } from './sources/claudeSessions'
import { probeMail } from './mail/gmail'
import { sttStatus, storageUsed, verifyStorage } from './voice/store'
import { listSkills } from './skills/catalog'
import { listRepos } from './registry/scan'
import { listProfiles, whoami } from './truto/cli'
import { TEMPLATES } from './claudecode/templates'
import { discoverTools, listUserChannels } from './sources/slack'
import { ScopeError, getChannel, listChannels, updateChannel, upsertListed } from './slackScope'

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

/**
 * The Slack channel scope, as an API — `slack_channels` (`db.ts` migration
 * 15), read and written through `slackScope.ts`. This replaces a config array
 * in `env.ts` that had to be hand-edited and redeployed to add or drop a
 * channel, and was edited twice inside one week, once dropping the team
 * channel entirely.
 */

/** The latest `last_listed_at` across every row, or null if nothing ever was. */
function listedAt(): number | null {
  const at = listChannels().reduce<number | null>(
    (max, c) => (c.last_listed_at && (max === null || c.last_listed_at > max) ? c.last_listed_at : max),
    null,
  )
  return at
}

settings.get('/slack/channels', async c => {
  let canList = false
  try {
    canList = !!(await discoverTools()).listChannels
  } catch {
    // Discovery failing is not this route's failure to report — `canList:
    // false` is still the honest answer, and the seeded rows stay editable.
  }
  return c.json({ channels: listChannels(), listedAt: listedAt(), canList })
})

settings.put('/slack/channels/:id', async c => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
  const patch: { mode?: string; label?: string | null } = {}
  if ('mode' in body) patch.mode = body.mode as string
  if ('label' in body) patch.label = body.label === null ? null : (body.label as string)

  try {
    const before = getChannel(id)
    const row = updateChannel(id, patch)
    audit('slack.channel_scope', {
      target: id,
      detail: { name: row.name, before: before && { mode: before.mode, label: before.label }, after: { mode: row.mode, label: row.label } },
    })
    return c.json(row)
  } catch (e) {
    if (e instanceof ScopeError) return c.json({ error: e.message }, 400)
    throw e
  }
})

settings.post('/slack/channels/refresh', async c => {
  const t = await discoverTools()
  if (!t.listChannels) {
    return c.json({
      error: 'the connected Slack MCP exposes no channel-listing tool — the seeded channels are still editable, there is just nothing new to discover',
    }, 501)
  }
  const listed = await listUserChannels()
  const { added } = upsertListed(listed)
  audit('slack.channel_refresh', { detail: { listed: listed.length, added } })
  return c.json({ channels: listChannels(), listedAt: listedAt(), added })
})

function safe(v: string | null): string[] {
  try {
    const p = JSON.parse(v ?? '[]')
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}
