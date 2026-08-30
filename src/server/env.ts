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

/**
 * Resolved per call rather than captured at import. The file is read on a timer
 * for the lifetime of the process, so where it lives is an I/O concern, not a
 * startup constant — and reading it late means a token that appears after boot
 * (someone runs `claude mcp login` while Wake is up) is picked up without a
 * restart.
 */
export const claudeCredentialsPath = () =>
  `${str('WAKE_CLAUDE_HOME', `${homedir()}/.claude`)}/.credentials.json`

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

/* -------------------------------------------------------------------------- */
/* Workspace                                                                  */
/* -------------------------------------------------------------------------- */

/** Root the repository registry scans. Nothing outside it can be named in a brief. */
export const WORKSPACE_ROOT = str('WAKE_WORKSPACE_ROOT', `${homedir()}/work`)

export const TRUTO_BIN = str('WAKE_TRUTO_BIN', `${homedir()}/.truto/bin/truto`)

export const CLI_TIMEOUT_MS = num('WAKE_CLI_TIMEOUT_MS', 120_000)
/** Hard cap on captured subprocess output, per stream. */
export const CLI_MAX_OUTPUT = num('WAKE_CLI_MAX_OUTPUT', 512 * 1024)

/** Skill catalogs, manifest-first. Named in a brief; never inlined into one. */
export const SKILL_PATHS = {
  truto: str('WAKE_SKILLS_TRUTO', `${homedir()}/work/truto-skills`),
  cursor: str('WAKE_SKILLS_CURSOR', `${homedir()}/work/Cursor-skills/.cursor/skills`),
  repo: str('WAKE_SKILLS_REPO', `${homedir()}/work/truto/.claude/skills`),
}

/**
 * Ceiling on output Wake will parse into memory. Separate from CLI_MAX_OUTPUT,
 * which only bounds what is shown and logged — `integrations list` legitimately
 * returns megabytes of valid JSON.
 */
export const CLI_MAX_PARSE = num('WAKE_CLI_MAX_PARSE', 8 * 1024 * 1024)

/* -------------------------------------------------------------------------- */
/* Open in Claude                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A brief may only name a repository the registry scanned. The registry is the
 * allowlist — which is what stops a template's `cwd` slot from becoming an
 * arbitrary directory in text a session will act on.
 */
export const PACK_DIR = str('WAKE_PACK_DIR', `${DATA_DIR}/packs`)

/**
 * Where "Open in Claude" sends you.
 *
 * `claude.ai/new` prefills a fresh conversation from `?q=`. It is a universal
 * link, so a phone opens the Claude app and a laptop opens a tab — both already
 * signed in, because the credential is yours and Wake never sees it.
 *
 * Configurable because this is somebody else's URL shape, and a personal tool
 * whose only hand-off is hard-coded is one product change away from a dead
 * button.
 */
export const HANDOFF_URL = str('WAKE_HANDOFF_URL', 'https://claude.ai/new')
export const HANDOFF_PARAM = str('WAKE_HANDOFF_PARAM', 'q')

/**
 * How much of a brief the link may carry.
 *
 * A prefilled prompt travels in the query string, and every hop between here and
 * Claude has its own limit — the browser, Cloudflare, the origin. 12k characters
 * is comfortably inside all of them and holds a real Slack thread. Anything
 * longer is trimmed *and said to be trimmed*, in the brief itself and on screen.
 */
export const HANDOFF_MAX_CHARS = num('WAKE_HANDOFF_MAX_CHARS', 12_000)

/* -------------------------------------------------------------------------- */
/* Voice                                                                      */
/* -------------------------------------------------------------------------- */

export const VOICE_DIR = str('WAKE_VOICE_DIR', `${DATA_DIR}/voice`)
export const VOICE_MAX_BYTES = num('WAKE_VOICE_MAX_BYTES', 25 * 1024 * 1024)
export const VOICE_MAX_SECONDS = num('WAKE_VOICE_MAX_SECONDS', 10 * 60)

/**
 * Speech-to-text, if something on the network offers it. Anthropic has no
 * transcription endpoint, so there is no default and no bundled model: unset,
 * Wake keeps the audio and says transcription is unavailable rather than
 * inventing a transcript.
 */
export const STT_URL = str('WAKE_STT_URL')
export const STT_MODEL = str('WAKE_STT_MODEL', 'whisper-1')
export const STT_KEY = str('WAKE_STT_KEY')

/* -------------------------------------------------------------------------- */
/* Mail                                                                       */
/* -------------------------------------------------------------------------- */

/** How long a fetched thread stays usable before Mail refetches it. */
export const MAIL_CACHE_TTL_MS = num('WAKE_MAIL_CACHE_TTL_MS', 5 * 60_000)
export const MAIL_PAGE_SIZE = num('WAKE_MAIL_PAGE_SIZE', 25)

/* -------------------------------------------------------------------------- */
/* Safety                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Origins allowed to make a state-changing request. Cloudflare Access proves
 * *who* is asking; it says nothing about which page asked, so a cross-site form
 * post from a tab the same browser has open would otherwise carry the Access
 * cookie with it.
 */
export const ALLOWED_ORIGINS = [
  PUBLIC_URL,
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  // Vite's dev server proxies /api, so its origin is the browser's origin there.
  ...(IS_DEV ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []),
  ...str('WAKE_EXTRA_ORIGINS').split(',').map(s => s.trim()).filter(Boolean),
]

/** How long a bound confirmation token stays usable. */
export const CONFIRM_TTL_MS = num('WAKE_CONFIRM_TTL_MS', 10 * 60_000)
