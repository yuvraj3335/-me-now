import { homedir } from 'node:os'

const str = (k: string, d = '') => process.env[k]?.trim() || d
const num = (k: string, d: number) => {
  const v = Number(process.env[k])
  return Number.isFinite(v) ? v : d
}

export const PORT = num('WAKE_PORT', 8585)
export const HOST = str('WAKE_HOST', '127.0.0.1')
export const DATA_DIR = str('WAKE_DATA_DIR', `${homedir()}/.local/share/wake`)

/** Public origin, used to build OAuth redirect URIs and push deep links. */
export const PUBLIC_URL = str('WAKE_PUBLIC_URL', `http://${HOST}:${PORT}`).replace(/\/$/, '')

/** Where Claude Code keeps its own MCP OAuth tokens — credential-chain step 2. */
export const CLAUDE_HOME = str('WAKE_CLAUDE_HOME', `${homedir()}/.claude`)
export const CLAUDE_PROJECTS_DIR = `${CLAUDE_HOME}/projects`
export const CLAUDE_CREDENTIALS = `${CLAUDE_HOME}/.credentials.json`

/** Who I am, so "is this addressed to me?" is answerable without a model. */
export const ME = {
  githubLogin: str('WAKE_GITHUB_LOGIN', 'yuvraj3335'),
  emails: str('WAKE_EMAILS', 'yuvraj@redroot.one,engineering@redroot.one')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  slackUserId: str('WAKE_SLACK_USER_ID'), // discovered at runtime if unset
}

export const GMAIL_ACCOUNTS = str('WAKE_GMAIL_ACCOUNTS', ME.emails.join(','))
  .split(',').map(s => s.trim()).filter(Boolean)

/** Poll cadence. Jittered per source so they never stampede together. */
export const POLL_INTERVAL_MS = num('WAKE_POLL_INTERVAL_MS', 3 * 60_000)
export const REMINDER_TICK_MS = num('WAKE_REMINDER_TICK_MS', 30_000)

/** How far back a source looks on each poll. */
export const LOOKBACK_DAYS = num('WAKE_LOOKBACK_DAYS', 14)

export const VAPID_SUBJECT = str('WAKE_VAPID_SUBJECT', 'mailto:yuvraj@redroot.one')

/** Static token escape hatch — credential-chain step 3. */
export const STATIC_TOKENS: Record<string, string> = {
  slack: str('WAKE_SLACK_TOKEN'),
  sentry: str('WAKE_SENTRY_TOKEN'),
  gmail: str('WAKE_GMAIL_TOKEN'),
}

/** MCP servers Wake knows how to speak to. */
export const MCP_SERVERS: Record<string, { url: string; label: string; scopes?: string }> = {
  slack: {
    url: str('WAKE_SLACK_MCP_URL', 'https://mcp.slack.com/mcp'),
    label: 'Slack',
    // Read-only by construction (DECISIONS.md #7).
    scopes: 'channels:history,channels:read,groups:history,groups:read,im:history,mpim:history,mpim:read,users:read,search:read,team:read',
  },
  sentry: { url: str('WAKE_SENTRY_MCP_URL', 'https://mcp.sentry.dev/mcp'), label: 'Sentry' },
  gmail: { url: str('WAKE_GMAIL_MCP_URL', 'https://gmailmcp.googleapis.com/mcp/v1'), label: 'Gmail' },
}

export const IS_DEV = str('NODE_ENV') !== 'production'
