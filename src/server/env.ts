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

/**
 * The signed-in Slack user, as a constant rather than a discovery.
 *
 * Slack MCP publishes it in the search tool's own description, which is still
 * read at `discoverTools`. But the alert-channel reads happen whether or not a
 * search tool ever answered, and "who am I" decides which messages are my own
 * and never worth showing back to me — so it needs a default that does not
 * depend on a handshake succeeding first.
 */
export const ME_SLACK_DEFAULT = 'U09617LRRDF'

/** Who I am, so "is this addressed to me?" is answerable without a model. */
export const ME = {
  githubLogin: str('WAKE_GITHUB_LOGIN', 'yuvraj3335'),
  // The one real identity: the Truto work address mail is actually sent to.
  // A second, unowned address here is not a second inbox to design around —
  // it is Wake claiming to be someone it is not.
  emails: str('WAKE_EMAILS', 'yuvraj@truto.one')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  slackUserId: str('WAKE_SLACK_USER_ID', ME_SLACK_DEFAULT),
  /** The organisation Fetch's second standing question is about. */
  org: str('WAKE_ORG', 'TrutoEngineering'),
  githubOrg: str('WAKE_GITHUB_ORG', 'trutohq'),
  /** The display name people type when they mean him. */
  name: str('WAKE_NAME', 'Yuvraj Muley'),
}

export const GMAIL_ACCOUNTS = str('WAKE_GMAIL_ACCOUNTS', ME.emails.join(','))
  .split(',').map(s => s.trim()).filter(Boolean)

/**
 * The workspace, needed to build a `slack://` link the desktop and phone apps
 * answer. It is readable out of any `botuser-<TEAM>-<BOT>@slack-bots.com`
 * address in a channel read, so this is the fallback for the reads that carry
 * no bot address at all — Alertmanager renders without one.
 */
export const SLACK_TEAM_ID = str('WAKE_SLACK_TEAM_ID', 'T04CWR1AM1R')

/**
 * The user groups whose mention means the page was aimed at my team.
 *
 * Two ids, because Datadog pages both: `S06HDT77E1M` is @truto-eng and
 * `S09475M3UM8` is the second on-call group, whose handle Slack renders
 * nowhere. A page naming either one is the difference between an alert that is
 * on me now and one that is merely posted where I can see it.
 */
export const SLACK_USERGROUPS = str('WAKE_SLACK_USERGROUPS', 'S06HDT77E1M,S09475M3UM8')
  .split(',').map(s => s.trim()).filter(Boolean)

export type AlertChannel = {
  id: string
  name: string                       // no leading '#'
  /** 'sentry' | 'datadog' | 'grafana' — selects the body parser + card builder. */
  family: 'sentry' | 'datadog' | 'grafana'
}

/**
 * The channels read directly rather than searched.
 *
 * Search cannot see this content: bot search results come back with empty text,
 * and a `<!subteam^…>` token inside an attachment is not indexed at all — a
 * search for `truto-eng in:#truto-api-alerts` returns zero rows on a day when
 * Datadog paged the group twice. So these three are read as history.
 *
 * `#intent-alerts` (C07UWPPLSGN) is deliberately absent. Its newest message is
 * over a year old, it is website-visitor marketing, and every read of it would
 * sit in `settle`'s denominator where a failure marks the whole Slack run
 * not-ok for nothing.
 */
export const SLACK_ALERT_CHANNELS: AlertChannel[] = [
  { id: 'C0BERTMS9K4', name: 'sentry-alerts',        family: 'sentry'  },
  { id: 'C05UPHVT2CQ', name: 'truto-api-alerts',     family: 'datadog' },
  { id: 'C0B53TSLGLA', name: 'truto-grafana-alerts', family: 'grafana' },
]

/**
 * How many threads one poll is allowed to read in full.
 *
 * Each read is a round trip, and a fortnight of mentions is a bounded but not
 * tiny number of distinct conversations. The ones that need it most go first —
 * a thread whose parent the search did not return cannot be titled without one
 * — so the cap degrades reply counts on the oldest threads rather than titles
 * on the newest. Twenty covers every measured poll on this deployment with room
 * over.
 */
export const SLACK_THREAD_READS = num('WAKE_SLACK_THREAD_READS', 20)

/** Preferred over `find_organizations`, which costs a round trip to learn one word. */
export const SENTRY_ORG = str('WAKE_SENTRY_ORG', 'truto')

/** Poll cadence. Jittered per source so they never stampede together. */
export const POLL_INTERVAL_MS = num('WAKE_POLL_INTERVAL_MS', 3 * 60_000)
export const REMINDER_TICK_MS = num('WAKE_REMINDER_TICK_MS', 30_000)

/** How far back a source looks on each poll. */
export const LOOKBACK_DAYS = num('WAKE_LOOKBACK_DAYS', 14)

export const VAPID_SUBJECT = str('WAKE_VAPID_SUBJECT', 'mailto:yuvraj@truto.one')

/** Static token escape hatch — credential-chain step 3. */
export const STATIC_TOKENS: Record<string, string> = {
  slack: str('WAKE_SLACK_TOKEN'),
  sentry: str('WAKE_SENTRY_TOKEN'),
  gmail: str('WAKE_GMAIL_TOKEN'),
}

/**
 * MCP servers Wake knows how to speak to.
 *
 * `oauth` is the honest half. It used to be inferred — "we know a URL" was read
 * as "Connect can work" — so Gmail rendered a Connect button on two screens that
 * could only ever answer 400, because `gmailmcp.googleapis.com` publishes no
 * OAuth metadata at either well-known and there is no authorize URL to build. A
 * button that cannot work is worse than no button, so the fact is written down
 * here rather than discovered by pressing it.
 *
 *   dcr        — dynamic client registration; Connect really is one click
 *   client-id  — you create an app and paste its id and secret first
 *   none       — Wake cannot obtain a credential for this one at all
 */
export const MCP_SERVERS: Record<string, { url: string; label: string; scopes?: string; oauth: 'dcr' | 'client-id' | 'none' }> = {
  slack: {
    url: str('WAKE_SLACK_MCP_URL', 'https://mcp.slack.com/mcp'),
    label: 'Slack',
    oauth: 'client-id',
    // The grant the operator asked for. Ingest still refuses write tools
    // (DECISIONS.md #7). Slack MCP does not map classic `search:read` onto
    // a search tool — the granular `search:read.*` names are what unlock it.
    // `files:write` is omitted on purpose.
    scopes: 'canvases:read,canvases:write,channels:history,channels:read,channels:write,chat:write,emoji:read,files:read,groups:history,groups:read,groups:write,im:history,im:read,im:write,lists:read,lists:write,mpim:history,mpim:read,mpim:write,reactions:read,reactions:write,search:read,search:read.files,search:read.im,search:read.mpim,search:read.private,search:read.public,search:read.users,team:read,users:read,users:read.email',
  },
  sentry: { url: str('WAKE_SENTRY_MCP_URL', 'https://mcp.sentry.dev/mcp'), label: 'Sentry', oauth: 'dcr' },
  gmail: {
    url: str('WAKE_GMAIL_MCP_URL', 'https://gmailmcp.googleapis.com/mcp/v1'),
    label: 'Gmail',
    // Google hosts the MCP; Google's OIDC document hosts the grant.
    // Connect asks for offline access so the token does not die every hour.
    oauth: 'client-id',
    scopes: 'https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.compose',
  },
}

export const IS_DEV = str('NODE_ENV') !== 'production'

/* -------------------------------------------------------------------------- */
/* Fetch — pipe 2                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The `claude` binary on this machine, used by Fetch and by nothing else.
 *
 * Wake holds no model key and runs no model of its own. What it borrows here is
 * the *box's* reach: the connectors the operator has already signed into from
 * this machine, which is precisely the set Wake's own credentials cannot cover.
 * One bounded, read-only, allowlisted collection per press. See DECISIONS.md #31
 * for why this reopens #26, and `src/server/fetch/claude.ts` for the envelope.
 */
export const CLAUDE_BIN = str('WAKE_CLAUDE_BIN')

/**
 * The directory one collection runs in, and the reason it is not `~`.
 *
 * Claude Code writes a transcript for every run it makes, filed under
 * `~/.claude/projects/` by the directory the run started in. Fetch started in
 * the home directory, so its own collections landed in the bucket a person gets
 * when they open a session from `~` — and the Claude Code source read them
 * straight back onto the desk as work left open. Two of nine session cards on a
 * 7am desk were Wake quoting itself, and the count grew by one per connector per
 * press.
 *
 * A directory of Wake's own makes that structural: the source skips this bucket
 * by path, so a collection cannot become a card however the prompt is worded
 * later. Matching the prompt text would rot on the next rewrite of it.
 */
export const FETCH_RUN_DIR = str('WAKE_FETCH_RUN_DIR', `${DATA_DIR}/fetch-runs`)

/**
 * Where Fetch ran before it had a directory of its own.
 *
 * Kept because the transcripts it wrote are still on disk and still readable,
 * and a swept card that reappears three minutes later is not swept. Every
 * transcript in this bucket on the deployed box was one of Wake's own
 * collections; work that is actually yours happens in a repository.
 */
export const FETCH_LEGACY_RUN_DIR = homedir()

/** Everything that bounds one Fetch. None of it is a hope; all of it is a flag. */
export const FETCH_MODEL = str('WAKE_FETCH_MODEL', 'sonnet')
/** Wall clock per connector. Whatever landed before this is kept. */
export const FETCH_TIMEOUT_MS = num('WAKE_FETCH_TIMEOUT_MS', 150_000)
/** Tool-call ceiling, so "let me look a bit deeper" cannot happen. */
export const FETCH_MAX_TURNS = num('WAKE_FETCH_MAX_TURNS', 6)
/** How far back Fetch looks, and how many rows one connector may land. */
export const FETCH_LOOKBACK_DAYS = num('WAKE_FETCH_LOOKBACK_DAYS', 14)
export const FETCH_MAX_ROWS = num('WAKE_FETCH_MAX_ROWS', 20)

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
