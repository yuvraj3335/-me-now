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
/* Agent                                                                      */
/* -------------------------------------------------------------------------- */

/** Root the repository registry scans. Nothing outside it is reachable. */
export const WORKSPACE_ROOT = str('WAKE_WORKSPACE_ROOT', `${homedir()}/work`)

/**
 * Two engines, deliberately not one (DECISIONS.md #14).
 *
 *   - the Wake Agent, the chat inside this app, runs on the Anthropic SDK with
 *     a key Wake holds. Wake owns its tool loop, so approvals can block inside a
 *     tool rather than being asked for in a prompt.
 *   - "Open in Claude Code" launches the `claude` binary already signed in on
 *     this machine. Wake packs context and starts a session; it does not become
 *     Claude Code.
 *
 * Collapsing them would mean either an in-app chat Wake cannot gate, or a
 * launcher that re-implements a CLI that already exists.
 */
export const CLAUDE_BIN = str('WAKE_CLAUDE_BIN', 'claude')
export const TRUTO_BIN = str('WAKE_TRUTO_BIN', `${homedir()}/.truto/bin/truto`)

/** Env is the fallback; Settings writes the durable one into `kv`. */
export const ANTHROPIC_KEY_ENV = str('ANTHROPIC_API_KEY') || str('WAKE_ANTHROPIC_API_KEY')
export const AGENT_MODEL = str('WAKE_AGENT_MODEL', 'claude-opus-5')
/** Steps, not "turns": one step is one model reply plus the tools it asked for. */
export const AGENT_MAX_STEPS = num('WAKE_AGENT_MAX_STEPS', 40)
export const AGENT_MAX_TOKENS = num('WAKE_AGENT_MAX_TOKENS', 16_000)
export const AGENT_TIMEOUT_MS = num('WAKE_AGENT_TIMEOUT_MS', 25 * 60_000)
/** No output for this long while the run is alive means a stalled stream. */
export const AGENT_STALL_MS = num('WAKE_AGENT_STALL_MS', 5 * 60_000)
/** Ceiling on tool output handed back to the model, per call. */
export const AGENT_TOOL_RESULT_MAX = num('WAKE_AGENT_TOOL_RESULT_MAX', 24_000)

/** How long a blocked tool waits on a human before giving up. */
export const APPROVAL_TIMEOUT_MS = num('WAKE_APPROVAL_TIMEOUT_MS', 30 * 60_000)

export const CLI_TIMEOUT_MS = num('WAKE_CLI_TIMEOUT_MS', 120_000)
/** Hard cap on captured subprocess output, per stream. */
export const CLI_MAX_OUTPUT = num('WAKE_CLI_MAX_OUTPUT', 512 * 1024)

/** Skill catalogs, manifest-first. Catalog E is off unless explicitly enabled. */
export const SKILL_PATHS = {
  truto: str('WAKE_SKILLS_TRUTO', `${homedir()}/work/truto-skills`),
  cursor: str('WAKE_SKILLS_CURSOR', `${homedir()}/work/Cursor-skills/.cursor/skills`),
  repo: str('WAKE_SKILLS_REPO', `${homedir()}/work/truto/.claude/skills`),
}
export const ENABLE_META_SKILLS = str('WAKE_ENABLE_META_SKILLS') === '1'

/** truto-monitoring lives behind its own MCP; Wake never copies its data. */
export const MONITORING_MCP_URL = str('WAKE_MONITORING_MCP_URL')
export const PLATFORM_MCP_URL = str('WAKE_PLATFORM_MCP_URL', 'https://api.truto.one/platform/mcp')
export const PLATFORM_MCP_TOKEN = str('WAKE_PLATFORM_MCP_TOKEN')

/**
 * Ceiling on output Wake will parse into memory. Separate from CLI_MAX_OUTPUT,
 * which only bounds what is shown and logged — `integrations list` legitimately
 * returns megabytes of valid JSON.
 */
export const CLI_MAX_PARSE = num('WAKE_CLI_MAX_PARSE', 8 * 1024 * 1024)

/* -------------------------------------------------------------------------- */
/* Open in Claude Code                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A launch may only start inside the workspace root. The registry is the
 * allowlist — a path that is not a repository Wake scanned is not a place a
 * session can be opened, which is what stops a template's `cwd` slot from
 * becoming an arbitrary directory.
 */
export const LAUNCH_TIMEOUT_MS = num('WAKE_LAUNCH_TIMEOUT_MS', 6 * 60 * 60_000)
export const PACK_DIR = str('WAKE_PACK_DIR', `${DATA_DIR}/packs`)

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
