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
 *
 * `SLACK_CHANNELS` below does NOT apply to these three, and that is a decision
 * rather than an oversight — so please do not "fix" it by folding them into one
 * list. These are not searched, they are read as history, so there is no
 * workspace-wide query here for an allowlist to narrow. They are also the whole
 * route by which Sentry, Datadog and Grafana paging reaches the desk, and the
 * standing instruction on this deployment is not to disconnect a source that
 * works. Deleting them from the poll would silence every page; adding them to
 * the searched list would ask a question that has already been measured
 * answering nothing.
 */
export const SLACK_ALERT_CHANNELS: AlertChannel[] = [
  { id: 'C0BERTMS9K4', name: 'sentry-alerts',        family: 'sentry'  },
  { id: 'C05UPHVT2CQ', name: 'truto-api-alerts',     family: 'datadog' },
  { id: 'C0B53TSLGLA', name: 'truto-grafana-alerts', family: 'grafana' },
]

/**
 * A channel the desk is allowed to carry work from.
 *
 * `name` carries no leading `#`, because Slack's own name for a channel does
 * not either — the hash is rendering. `id` is optional, and the difference is
 * where the fact came from: the list this deployment ships with was read off
 * the workspace, and anything typed into the env var is a name and nothing more.
 */
export type SlackChannel = { name: string; id?: string }

/** `#Truto `, `truto` and `TRUTO` are one channel. Slack stores names lower-case. */
export const bareChannel = (s: string | null | undefined): string =>
  (s ?? '').trim().replace(/^#+/, '').toLowerCase()

/**
 * The channels a mention is allowed to come from.
 *
 * The mention search is workspace-wide, and a workspace is much bigger than the
 * work. Measured on this deployment on 2026-08-31: a fortnight of `<@me>`
 * spends four of its twenty slots on `#github-updates`, `#pr-reviews` and a
 * Slack list rendering as `#FC:F096Q3LBF7C:Sprint Tasks` — places the operator
 * does not work, taking slots from the customer channels he does. Narrowing the
 * same query to this list reached a further day back inside the same cap.
 *
 * Names first, because a name is what he gave and what he will edit. Ids
 * beside them, because the name is also the half that moves: a renamed channel
 * keeps its id, and `parseSlackResults` substitutes the id for the name when a
 * payload carries no readable one — so a hit can arrive with a good id and a
 * useless name, and never the other way round. `isAllowedSlackChannel` reads
 * the id first for exactly that reason and falls back to the name.
 *
 * The ids were read off this workspace with `slack_search_channels` and checked
 * again on 2026-09-01 when the list was narrowed — all sixteen resolved to the
 * same ids they already carried. Twelve of the seventeen are private, and both
 * kinds answer to `in:#name` in a search. `WAKE_SLACK_CHANNELS` replaces
 * the whole list with plain comma-separated names — a person can type names and
 * cannot be expected to type ids, and a name match on its own is the behaviour
 * this list had before it carried any.
 */
/*
 * NARROWED to the seventeen he named, and two came off.
 *
 * `#truto` (`C04D9HKDWAV`) and `#crisp-chats` (`C07351C8Z8E`) were on this list
 * and are not on his. `#truto` is not a small removal — it was the third-busiest
 * source of Slack rows on the box, ten of them at the time of the change — so it
 * is worth being explicit that it went because he listed the channels he wants
 * to hear from and that was not among them, not because anything about it was
 * wrong.
 *
 * **This is the fetch scope, not a push filter, and that is a decision.** The
 * ask was "Slack should only ping me from these channels", and the obvious place
 * for that is `push.ts` — except no Slack message has ever produced a push.
 * `push.ts` has exactly two internal triggers, a reminder he set and a due date
 * he set; `ingest.ts` never calls `notify()` at all. So a filter there would be
 * narrowing an empty set and would read as done while changing nothing. The
 * layer where his sentence has an effect today is what Slack surfaces to Wake in
 * the first place, which is this list.
 *
 * `Customer (private)` is on his list and is NOT here, because it could not be
 * resolved. Searched against the connected token as both `public_channel` and
 * `private_channel`, for `customer`, `customers` and `cust`: the only matches
 * anywhere in the workspace are `#truto-customer-events` and
 * `#elaichi-customer-events`, both public and neither plausibly the one he
 * means. A private channel the token cannot see cannot be given an id, and
 * guessing at one would silently point this list at the wrong conversation. It
 * is left out and said out loud rather than quietly dropped — add it with
 * `WAKE_SLACK_CHANNELS`, or name it here once its real name is known.
 */
export const DESK_CHANNELS: SlackChannel[] = [
  { name: 'clonepartner',        id: 'C09BRBLNXNH' },
  { name: 'sprinto',             id: 'C050LJAMFSN' },
  { name: 'maximor-truto',       id: 'C0A8B267EE9' },
  { name: 'spendflo-truto',      id: 'C05CJ0CUV35' },
  { name: '15five-truto',        id: 'C0AHHQMF08L' },
  { name: 'komplai-truto',       id: 'C0A437E7UAU' },
  { name: 'evergrowth-truto',    id: 'C0A25L2QEB0' },
  { name: 'thoropass-truto',     id: 'C05P80HPYSK' },
  { name: 'open-truto',          id: 'C08SS821JHG' },
  { name: 'stax-truto',          id: 'C09TKFVP6AY' },
  { name: 'naq-truto',           id: 'C09REMSHL14' },
  { name: 'docsbot-truto',       id: 'C093QFW4U3E' },
  { name: 'truto-balkanid',      id: 'C07PMS3UYKB' },
  { name: 'ex-superhawk-truto',  id: 'C0AACN2HYM7' },
  { name: 'truto-zen',           id: 'C07AVEG7ZHN' },
  { name: 'framer-clonepartner', id: 'C06UP5J326B' },
]

/**
 * `WAKE_SLACK_CHANNELS`, which now takes an id beside a name if you have one.
 *
 * `truto, spendflo-truto` still works and is still the form a person types. But
 * a name-only override silently gave up the half of the match that matters most:
 * `isAllowedSlackChannel` reads the id first precisely because a renamed channel
 * keeps its id and `parseSlackResults` substitutes an id for a name when the
 * payload has no readable one — so a hit can arrive with a good id and a useless
 * name, and an operator who narrowed the list by env had no way to catch it.
 *
 * So `spendflo-truto:C05CJ0CUV35` is accepted too, and the two forms mix freely
 * in one variable. Anything after a second colon is ignored rather than treated
 * as an id, because that is a typo and a wrong id is worse than none.
 */
const TYPED_CHANNELS: SlackChannel[] = str('WAKE_SLACK_CHANNELS')
  .split(',')
  .map(entry => {
    const [rawName, rawId] = entry.split(':')
    const name = bareChannel(rawName)
    const id = (rawId ?? '').trim().toUpperCase()
    return id ? { name, id } : { name }
  })
  .filter(c => !!c.name)

export const SLACK_CHANNELS: SlackChannel[] =
  TYPED_CHANNELS.length ? TYPED_CHANNELS : DESK_CHANNELS

/**
 * Everything the desk carries: the list above, plus the three alert channels.
 *
 * The alert channels belong in the *answer* even though they are not in the
 * searched list, and the reason is a real collision the poll already handles.
 * Somebody replying `<@yuvraj> can you take this` under a Sentry post is the
 * standard triage move; the mention search returns that reply, and
 * `foldThreadIntoAlert` folds it into the alert row so the row can say who is
 * waiting. Refusing `#sentry-alerts` here would leave every alert nobody's,
 * which is the opposite of what the allowlist is for.
 */
const CARRIED: SlackChannel[] = [...SLACK_CHANNELS, ...SLACK_ALERT_CHANNELS]
const CARRIED_NAMES = new Set(CARRIED.map(c => bareChannel(c.name)))
const CARRIED_IDS = new Set(CARRIED.map(c => c.id).filter((v): v is string => !!v))

/**
 * May a message from this channel become a card?
 *
 * The id is asked first because it is the durable half — a channel that gets
 * renamed keeps it, and a search hit whose `Channel:` line had no readable name
 * arrives here with the id standing in for one. The name is the fallback, and
 * it has to stay: an operator's `WAKE_SLACK_CHANNELS` carries names and no ids
 * at all, so an id-only rule would refuse everything he configured.
 *
 * Both halves are `#`-insensitive and case-insensitive, because `meta.channel`
 * on a stored card is a display name and has been spelled both ways.
 */
export function isAllowedSlackChannel(
  name: string | null | undefined,
  id?: string | null,
): boolean {
  if (id && CARRIED_IDS.has(id)) return true
  return CARRIED_NAMES.has(bareChannel(name))
}

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
/* The terminal — where a brief actually lands                                */
/* -------------------------------------------------------------------------- */

/**
 * The three binaries a live session needs, and why each one is here.
 *
 * `tmux` holds the session. It is the only piece that survives Wake restarting,
 * the browser closing and the network going away, and it is what lets a laptop
 * and a phone look at one screen at the same time. Writing that ourselves would
 * be a worse tmux.
 *
 * `python3` is the pseudo-terminal — see `ptybridge.py` for why a native module
 * is not an option on this runtime.
 *
 * `CLAUDE_BIN` is the same one Fetch borrows, and it is still allowed to be
 * empty. Empty means "this machine cannot start a session", which the terminal
 * routes answer with a 503 naming the missing piece rather than a stack trace.
 */
export const TMUX_BIN = str('WAKE_TMUX_BIN', 'tmux')
export const PYTHON_BIN = str('WAKE_PYTHON_BIN', 'python3')

/**
 * A tmux server of Wake's own, not the operator's.
 *
 * `tmux -L wake` is a separate socket with a separate server and a separate
 * session namespace. It buys two things that are worth the flag on every call:
 * `list-sessions` can only ever return sessions Wake started, so "which sessions
 * may this API touch" is answered by the socket rather than by a name filter
 * somebody could spoof; and a `kill-server` here can never take down the tmux
 * he is personally working in.
 */
export const TERMINAL_TMUX_SOCKET = str('WAKE_TMUX_SOCKET', 'wake')

/**
 * The prefix a Wake-started tmux session's name carries.
 *
 * Belt as well as braces. The socket already isolates them; this makes a name
 * that arrived in a request visibly wrong rather than merely unmatched, and it
 * is what `sessionIdFromTmuxName` reads back.
 */
export const TERMINAL_NAME_PREFIX = 'wake-'

/**
 * The size a session is born at, before a browser says otherwise.
 *
 * Not a guess about a screen — a floor. tmux fixes a detached session's window
 * at whatever it was created with, and Claude Code lays out its boxes against
 * that, so a session created at 80x24 renders a cramped screen for the seconds
 * before the first attach resizes it. 120x34 is a laptop, which is the shape
 * most of these are read on first.
 */
export const TERMINAL_COLS = num('WAKE_TERMINAL_COLS', 120)
export const TERMINAL_ROWS = num('WAKE_TERMINAL_ROWS', 34)

/** Where the size files a resize is passed through live. One per attachment. */
export const TERMINAL_SIZE_DIR = str('WAKE_TERMINAL_SIZE_DIR', `${DATA_DIR}/terminals`)

/**
 * Claude Code's own config, read for exactly one fact: has this directory been
 * trusted yet.
 *
 * Read-only, and deliberately so. A directory Claude Code has never seen makes
 * it show a one-time "Is this a project you trust?" dialog before the session
 * starts, and the honest thing to do about that is *say so* on the way in — not
 * to write `hasTrustDialogAccepted: true` into somebody's config on their
 * behalf. Answering a trust prompt is the operator's to do, and the terminal is
 * a real terminal, so he can.
 */
export const CLAUDE_CONFIG_PATH = str('WAKE_CLAUDE_CONFIG', `${homedir()}/.claude.json`)

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
/* Gmail — what earns a card                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The poller's query, as settings rather than as a string inside the adapter.
 *
 * What was there read `is:unread newer_than:14d -category:promotions
 * -category:social`, which is "every unread mail of the last fortnight" wearing
 * a filter. Measured against this mailbox on 2026-08-31 it matched more than the
 * fifty threads one page can hold, and the thirty the poller took were Cloudflare
 * maintenance windows, LinkedIn nudges, Sentry digests, billing updates, a
 * Notion trend mail and two weekly reports. Thirty of the desk's hundred-and-eight
 * rows, and not one of them was a person writing to him.
 *
 * Three things came back from measuring that mailbox directly, and each one is a
 * line below rather than a paragraph in a commit message:
 *
 *   The categories do the work. `eng@truto.one` and `integrations@truto.one` are
 *   Google Groups, so their mail is `category:forums`, and the vendor and product
 *   mail around it is `category:updates`. Excluding those two alongside
 *   promotions and social took the same fortnight from 50+ threads to 26. The
 *   old query excluded neither, which is why the desk looked like a mailing list.
 *
 *   `is:important` is not usable here, and this is the interesting one. It is
 *   Gmail's own marker and it is supposed to be tuned by his behaviour, but on
 *   this mailbox it matched 42 unread threads and what it liked was Zoho CRM
 *   quota warnings, Mercury 2FA notices, an Anthropic receipt and eighteen
 *   copies of "Security alert: new trusted device added to your Claude account".
 *   Twenty-two of the 26 threads left after the category exclusions carry
 *   IMPORTANT. Requiring it would have kept the noise and dropped the people, so
 *   it is deliberately absent — see `GMAIL_EXCLUDE_SENDERS` for what replaced it.
 *
 *   `category:primary` is not the complement of the other four and must not be
 *   used as one. With the tabbed inbox switched off it matched effectively
 *   everything unread — the same 50 the bare query returned — while the negative
 *   forms read the underlying `CATEGORY_` labels and narrow properly.
 *
 * All of it is a flag because a query is a judgement about somebody else's mail,
 * and the person whose mail it is should be able to widen it at 7am without
 * waiting for a deploy.
 */

/**
 * A comma-separated setting that can be emptied.
 *
 * `str()` reads an empty value as absent and hands back the default, which is
 * right for a URL and wrong for a list of exclusions: `WAKE_GMAIL_EXCLUDE_SENDERS=`
 * in an env file is a person saying "stop excluding anything", and answering
 * that with the default is the tool arguing with them. Widening has to be as
 * available as narrowing or the settings below are decoration.
 */
const gmailList = (k: string, d: string): string[] =>
  (process.env[k] ?? d).split(',').map(s => s.trim()).filter(Boolean)

/** Gmail's own buckets for mail sent to a crowd. Cleared with an empty value. */
export const GMAIL_EXCLUDE_CATEGORIES = gmailList(
  'WAKE_GMAIL_EXCLUDE_CATEGORIES',
  'promotions,social,updates,forums',
).map(s => s.toLowerCase())

/**
 * Address conventions a machine announces itself with — not a list of senders.
 *
 * The distinction is the whole point. A blocklist of domains is a list somebody
 * maintains forever and it is wrong the first morning a new noisy vendor appears;
 * `noreply` is a promise the sender makes about itself, in the address, before
 * anyone has heard of them. Gmail matches these as `from:` tokens, so
 * `no-reply-EeEWwHBV22C0_3tdrmTqIQ@mail.anthropic.com` is caught by the same
 * three words as `noreply@mailer.truto.one`, and a vendor onboarded next week is
 * caught on their first send.
 *
 * Measured: adding these took the fortnight from 26 threads to 5.
 *
 * What it trades away is the automated mail that is genuinely urgent — a
 * password reset, a failed payment. That is the honest cost, and it is bounded
 * two ways: those senders reach him by other means, and the Mail page still
 * lists the whole inbox untouched. Emptying this setting puts them all back.
 */
export const GMAIL_EXCLUDE_SENDERS = gmailList(
  'WAKE_GMAIL_EXCLUDE_SENDERS',
  'noreply,no-reply,donotreply',
)

/** Anything else, appended verbatim. The escape hatch for a query nobody predicted. */
export const GMAIL_QUERY_EXTRA = str('WAKE_GMAIL_QUERY_EXTRA')

/**
 * Threads one poll may read, per query.
 *
 * Clamped rather than trusted: `gmailmcp.googleapis.com` answers
 * `page_size must be greater than 0 and less than or equal to 50` and fails the
 * whole request, which is a poll lost to a number somebody typed.
 */
export const GMAIL_PAGE_SIZE = Math.max(1, Math.min(num('WAKE_GMAIL_PAGE_SIZE', 30), 50))

/**
 * Whether a thread he has already answered is fetched on its own.
 *
 * It has to be a second query, and that is a fact about Gmail rather than a
 * preference. Gmail evaluates a search per *message* even when it returns
 * threads, so `is:unread from:me` asks for one message that is both unread and
 * sent by him and answers zero — verified against this mailbox, where
 * `from:me newer_than:365d` returns plenty and `is:unread ... from:me` returns
 * nothing. The two halves cannot travel in one query, so they travel in two and
 * are unioned by thread id in the adapter.
 *
 * On the day it was written this costs one round trip for zero rows: he had sent
 * nothing from this address in a fortnight. It is on by default anyway, because
 * the poll it matters for is the one after he finally replies to a customer.
 */
export const GMAIL_RESCUE_REPLIED = str('WAKE_GMAIL_RESCUE_REPLIED', '1') !== '0'

/**
 * The query that decides what becomes a card.
 *
 * `in:inbox` is load-bearing and was missing before. His own Gmail filters
 * already archive the group mail he does not read, and without this the poller
 * reached straight past them and put it on the desk anyway — a filter he wrote
 * himself, overruled by a tool that is supposed to be working for him.
 */
export const gmailCardQuery = (days = LOOKBACK_DAYS): string =>
  [
    'is:unread',
    'in:inbox',
    `newer_than:${days}d`,
    ...GMAIL_EXCLUDE_CATEGORIES.map(c => `-category:${c}`),
    ...GMAIL_EXCLUDE_SENDERS.map(s => `-from:${s}`),
    GMAIL_QUERY_EXTRA,
  ].filter(Boolean).join(' ')

/**
 * Threads he has spoken in. Deliberately not `is:unread` — see
 * `GMAIL_RESCUE_REPLIED` for why that combination cannot be asked — so the
 * adapter keeps the ones carrying something unread and drops the rest.
 */
export const gmailRepliedQuery = (days = LOOKBACK_DAYS): string =>
  `from:me newer_than:${days}d -in:trash -in:spam`

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
