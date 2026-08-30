/**
 * Slack over the official MCP server (https://mcp.slack.com/mcp).
 *
 * Three things here are not guesses and matter a lot:
 *   1. The search tool answers with *Markdown*, not JSON, so this file contains
 *      a real parser for that shape rather than a JSON.parse and a prayer.
 *   2. The signed-in user id is published in the tool's own description
 *      ("Current logged in user's user_id is U…"), so Wake discovers who you are
 *      from the server instead of needing it configured.
 *   3. Search cannot see the alert channels at all. A bot message comes back
 *      from search with empty text, and a `<!subteam^…>` token inside an
 *      attachment is not indexed — so the three channels where Sentry, Datadog
 *      and Alertmanager actually post are read as *history*, with a second
 *      parser written against that second, different format.
 */
import { McpSession, HttpTransport, McpUnauthorized } from '../mcp/client'
import { tokenGetter, resolveToken } from '../mcp/creds'
import {
  MCP_SERVERS, ME, LOOKBACK_DAYS,
  SLACK_ALERT_CHANNELS, SLACK_TEAM_ID, SLACK_USERGROUPS, type AlertChannel,
} from '../env'
import { extractRefs, extractAlertRefs } from '../dedup'
import { NotConnected, settle, type RawCard, type Ref, type SourceAdapter } from './types'

let session: McpSession | null = null
const getSession = () =>
  (session ??= new McpSession('slack', new HttpTransport(MCP_SERVERS.slack!.url, tokenGetter('slack'))))

/** Drop a cached handshake so the next call re-discovers tools against the current token. */
export function resetSlackSession() {
  session = null
  toolCache = null
}

/* --------------------------- tool discovery --------------------------- */

type Tools = { search?: string; readThread?: string; readChannel?: string; myUserId?: string }
let toolCache: { at: number; tools: Tools } | null = null

/**
 * A discovery worth remembering. Both halves have to be there: search answers
 * the mention question and `read_channel` answers the alert one, and a cache
 * holding only the first is a cache that keeps re-deciding the poll can skip
 * three channels.
 */
const have = (t: Tools | undefined) => !!(t?.search && t.readChannel)

export async function discoverTools(): Promise<Tools> {
  // A miss is not a fact worth remembering. Slack MCP hides the search tool
  // when the token lacks `search:read.public` / `.private`; caching that
  // empty list for thirty minutes is how a reconnect that just granted
  // those scopes still looked like "no search tool".
  if (toolCache && have(toolCache.tools) && Date.now() - toolCache.at < 30 * 60_000) return toolCache.tools
  try {
    const all = await getSession().listTools(!have(toolCache?.tools))
    const byName = (re: RegExp) => all.find(t => re.test(t.name))?.name

    const search =
      byName(/^slack_search_public_and_private$/) ??
      byName(/search.*(public.*private|messages)/i) ??
      byName(/^slack_search(_public)?$/i) ??
      byName(/search/i)

    const readChannel =
      byName(/^slack_read_channel$/) ??
      byName(/read_channel|conversations_history|channel_history/i)

    // The server tells us who we are in prose; that beats hard-coding an id.
    const desc = all.map(t => t.description ?? '').join('\n')
    const myUserId = ME.slackUserId || desc.match(/user_id is (U[A-Z0-9]+)/i)?.[1]

    const tools: Tools = { search, readChannel, readThread: byName(/read_thread|thread_replies/i), myUserId }
    if (have(tools)) toolCache = { at: Date.now(), tools }
    return tools
  } catch (e) {
    resetSlackSession()
    throw e
  }
}

/* ------------------------------ parsing ------------------------------- */

export type SlackHit = {
  channelId: string
  channelName: string
  /** Purely the discriminator a direct message is thrown away on. */
  isDm: boolean
  fromName: string
  fromId: string
  ts: string
  epochMs: number
  permalink: string
  text: string
  /** The workspace, when the payload happened to name one. See `teamIdIn`. */
  teamId?: string
}

/**
 * Parse the Markdown block the Slack MCP returns. Written against the real
 * response; every field is optional-safe because a missing one must degrade to a
 * usable card rather than throw away the whole poll.
 */
/**
 * A Slack ts is "<epoch seconds>.<6 digits>", where the fraction is a sequence
 * number rather than real sub-second time. Parsing it as a float introduces a
 * rounding error, so take the first three digits as milliseconds directly.
 */
export function slackTsToMs(ts: string): number {
  if (!ts) return Date.now()
  const [secs, frac = ''] = ts.split('.')
  const ms = Number(frac.slice(0, 3).padEnd(3, '0'))
  return Number(secs) * 1000 + (Number.isFinite(ms) ? ms : 0)
}

export function parseSlackResults(md: string): SlackHit[] {
  const out: SlackHit[] = []
  for (const block of md.split(/^###\s+Result\s+\d+\s+of\s+\d+\s*$/m).slice(1)) {
    const field = (re: RegExp) => block.match(re)?.[1]?.trim()

    const channelRaw = field(/^Channel:\s*(.+)$/m) ?? ''
    const channelId = channelRaw.match(/\(ID:\s*([A-Z0-9]+)\)/)?.[1] ?? ''
    const channelName = channelRaw.replace(/\s*\(ID:.*?\)\s*/, '').trim()

    const fromRaw = field(/^From:\s*(.+)$/m) ?? ''
    const fromId = fromRaw.match(/\(ID:\s*([A-Z0-9]+)\)/)?.[1] ?? ''
    const fromName = fromRaw.replace(/\s*<[^>]*>\s*/, ' ').replace(/\s*\(ID:.*?\)\s*/, '').trim()

    const ts = field(/^Message_ts:\s*([\d.]+)$/m) ?? ''
    const permalink = block.match(/^Permalink:.*?\((https?:\/\/[^)]+)\)/m)?.[1] ?? ''

    // Text runs to the end of the block or to the --- separator. Done by index
    // rather than by regex: with the /m flag a `$` terminator matches the end of
    // the first *line*, which silently truncates every multi-line message.
    let text = ''
    const tIdx = block.search(/^Text:[ \t]*$/m)
    if (tIdx !== -1) {
      const after = block.slice(block.indexOf('\n', tIdx) + 1)
      const sep = after.search(/^---\s*$/m)
      text = (sep === -1 ? after : after.slice(0, sep)).trim()
    } else {
      text = (block.match(/^Text:[ \t]*(.*)$/m)?.[1] ?? '').trim()
    }

    if (!ts && !permalink) continue
    out.push({
      channelId,
      channelName: channelName || (channelId.startsWith('D') ? 'DM' : channelId),
      isDm: /^DM\b/i.test(channelRaw) || channelId.startsWith('D'),
      fromName: fromName || 'someone',
      fromId,
      ts,
      epochMs: slackTsToMs(ts),
      permalink,
      text,
      teamId: teamIdIn(fromRaw),
    })
  }
  return out
}

/**
 * The workspace id, read out of a bot's own address.
 *
 * Slack renders a bot author as `Name <botuser-T04CWR1AM1R-B0BEVJ…@slack-bots.com>`,
 * and that middle token is the team. It is the only place a read or a search
 * says which workspace it answered for, and a `slack://` link cannot be built
 * without it. Absent on Alertmanager and on human authors, so every caller
 * falls back to `SLACK_TEAM_ID`.
 */
const TEAM_ADDRESS = /botuser-(T[A-Z0-9]+)-[A-Z0-9]+@slack-bots\.com/
export const teamIdIn = (text: string): string | undefined => TEAM_ADDRESS.exec(text)?.[1]

/**
 * Slack encodes `&`, `<` and `>` in message text. `&amp;` is decoded last on
 * purpose: doing it first turns a literal `&amp;lt;` into a `<` nobody typed.
 */
const decodeEntities = (t: string) =>
  t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * Parse a `slack_read_channel` payload. A *different* format from the search
 * results above, and the difference is the point: history is bot-inclusive,
 * carries attachments, and is the only way to see what Datadog and Alertmanager
 * actually said.
 *
 * Written against captured payloads, so the odd-looking parts are all real:
 * the header line ends with a trailing space after the final `===`; the
 * parenthesised author id is a user id **or** a bot id, and Alertmanager has
 * neither an address nor a user id; and there is no `Permalink:` field at all,
 * so the archive URL is synthesised from the channel and the ts.
 */
export function parseChannelMessages(payload: unknown, channelId: string): SlackHit[] {
  const raw =
    typeof payload === 'string' ? payload
    : typeof (payload as { messages?: unknown } | null)?.messages === 'string'
      ? (payload as { messages: string }).messages
      : null
  // Same rule as `runSearch`: a payload we cannot read is a failed query, not an
  // empty channel. Returning nothing here would let `settle` call the run ok and
  // the sweep would then delete every alert card on the desk.
  if (raw === null) throw new Error(`slack channel read returned ${typeof payload}, not text`)

  const channelName = /^Channel:\s*(#?[^\s(]+)\s*\([A-Z0-9]+\)\s*$/m.exec(raw)?.[1] ?? ''
  const teamId = teamIdIn(raw)

  // The capture groups come back interleaved with the bodies, which is exactly
  // the shape wanted: [preamble, name, id, when, body, name, id, when, body, …].
  // The id group is optional and arrives `undefined` for Alertmanager.
  const parts = raw.split(/^=== Message from (.+?)(?: \(([UB][A-Z0-9]+)\))? at (.+?) ===[ \t]*$/gm)

  const out: SlackHit[] = []
  for (let i = 1; i + 3 < parts.length; i += 4) {
    const fromRaw = parts[i] ?? ''
    const fromId = parts[i + 1] ?? ''
    const block = parts[i + 3] ?? ''

    const ts = /^Message TS: ([\d.]+)$/m.exec(block)?.[1] ?? ''
    if (!ts) continue
    const body = decodeEntities(block.replace(/^Message TS: [\d.]+$/m, '')).trim()

    out.push({
      channelId,
      channelName,
      isDm: false,
      // `Sentry <botuser-…@slack-bots.com>` — the address is an id, not a name.
      fromName: fromRaw.replace(/\s*<[^>]*>\s*/, ' ').trim() || 'someone',
      fromId,
      ts,
      epochMs: slackTsToMs(ts),
      permalink: `https://truto.slack.com/archives/${channelId}/p${ts.replace('.', '')}`,
      text: body,
      teamId: teamIdIn(fromRaw) ?? teamId,
    })
  }
  return out
}

/**
 * One alert channel, as history.
 *
 * `oldest` and `latest` are sent together, always. With `oldest` alone the
 * server anchors the window to the *oldest* end of the range and answers with
 * the channel's founding join messages — measured, not theorised: it made
 * #sentry-alerts look dead since July on a day it had posted twenty minutes
 * earlier. There is no bot-inclusion flag here and there must not be: the
 * search tool has one, this one does not, and history is bot-inclusive by
 * construction.
 */
export async function readAlertChannel(tool: string, channelId: string, sinceMs: number): Promise<SlackHit[]> {
  const r = await getSession().callJson<unknown>(tool, {
    channel_id: channelId,
    oldest: String(Math.floor(sinceMs / 1000)),
    latest: String(Math.floor(Date.now() / 1000)),
    // The tool's own ceiling. A hundred messages over the lookback window is
    // more than any of the three channels produces, so `pagination_info` is
    // ignored rather than chased: a paging loop inside one settled query is a
    // second way to answer half a question and call it whole.
    limit: 100,
    // `concise` discards attachments, which is 100% of what Datadog and
    // Alertmanager say — under it their messages render as an empty string.
    response_format: 'detailed',
  })
  return parseChannelMessages(r, channelId)
}

/**
 * Slack's own markup, out. Exported because the search path in
 * `sources/search.ts` reads the same text and must normalise it the same way:
 * without it a Fetch row's title is `<@U09617LRRDF|Yuvraj Muley> can you look`,
 * which is the raw wire format sitting on the desk.
 */

/**
 * "Anything that reads like a task or ask aimed at me" — the brief asked for
 * this, and it is done with rules rather than a model, so you can read exactly
 * why any given message was flagged. Deliberately tuned to under-claim.
 */
const ASK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(can|could|would)\s+you\b/i, 'a direct request'],
  [/\b(pls|please)\b/i, 'a direct request'],
  [/\bneed\s+(you|this|your)\b/i, 'someone needs something from you'],
  [/\b(any\s+update|update\s+on|status\s+on|eta\b)/i, 'someone is chasing an update'],
  [/\b(blocked|blocker|waiting\s+on\s+you|stuck)\b/i, 'someone is blocked'],
  [/\b(review|take\s+a\s+look|have\s+a\s+look|ptal)\b/i, 'a review request'],
  [/\?\s*$/m, 'a question for you'],
]

export function readsLikeAsk(text: string): string | null {
  for (const [re, why] of ASK_PATTERNS) if (re.test(text)) return why
  return null
}

export const clean = (t: string) =>
  t.replace(/<@([A-Z0-9]+)\|([^>]+)>/g, '@$2')
   .replace(/<@([A-Z0-9]+)>/g, '@$1')
   .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
   .replace(/<(https?:\/\/[^>]+)>/g, '$1')
   .replace(/\s+/g, ' ')
   .trim()

/* ------------------------------- alerts -------------------------------- */

/**
 * Every literal below came out of a captured payload. The comments say which
 * detail is load-bearing, because each one is a shape that a reasonable-looking
 * regex gets wrong and then silently returns nothing for.
 */

/** Datadog writes `<!subteam^S06HDT77E1M>` bare — a pattern requiring `|@handle` misses every page. */
const SUBTEAM = /<!subteam\^(S[A-Z0-9]+)(?:\|@([a-z0-9-]+))?>/g
/** The same group id, rendered as a user mention. Only search results do this. */
const SUBTEAM_ALT = /<@(S[A-Z0-9]+)>/g
/**
 * Base36, and `-APP` must win the alternation or `TRUTO-APP-1BY` becomes
 * `TRUTO-A`. The boundary is spelled out rather than `\b` because `_` is a word
 * character and the triage bot writes the id italic — `_TRUTO-38_` — so under
 * `\b` the one id a message is *about* is the one it cannot see.
 */
const SHORT_ID = /(?<![0-9A-Za-z])TRUTO(?:-APP)?-[0-9A-Z]+(?![0-9A-Za-z])/g
const ATTACHMENT = /^Attachment: (.+?) \((https?:\/\/\S+)\)$/gm
/** Datadog puts the transition word in the attachment *title*, not the body. */
const DD_STATE = /^Attachment: (Triggered|Re-Triggered|Warn|Alert|Recovered): (.+?) \((https?:\/\/\S+)\)$/m
const DD_MONITOR = /\/monitors\/(\d+)/
/**
 * Alertmanager's whole message is one attachment, led by an emoji. The emoji is
 * captured rather than matched against a firing list: `:white_check_mark:` is
 * the one state that means "not on him", and anything else — including an emoji
 * nobody has seen yet — is better shown than silently dropped.
 */
const GRAFANA_ATT = /^Attachment: :([a-z0-9_+-]+): (\S+) \(/m
const DIGEST_HEAD = /^\*:red_circle: (.+?)\*$/m
/** Present on the per-environment digest and absent on the org-wide one. */
const DIGEST_ENV = /^Environment: (.+?) \(([0-9a-f-]{36})\)$/m
/** `:red_circle: <url|*TypeError*>` — the error class, bold, inside the link label. */
const RED_LINK = /:red_circle: <[^|>]+\|\*(.+?)\*>/
/** The three lines of a Cursor triage worth keeping. */
const TRIAGE_LINE = /^_(Root cause|Classification|Fix|No PR|No new PR|Duplicate|Existing PR|Human follow-up|Impact|Mechanism|Action|Next):_/

/** Datadog's one transition that means the monitor fixed itself. */
const DD_RECOVERED = 'Recovered'
/** Alertmanager's. */
const GRAFANA_RESOLVED = 'white_check_mark'

/**
 * Where the Cursor triage bot quotes the whole Sentry alert back at itself.
 * Everything from here on is a second rendering of a card we already have.
 */
const APP_RERENDER = 'App notification from App ('

/**
 * Slack's emphasis markers, out, on top of what `clean` already does.
 *
 * Separate from `clean` because `clean` is pinned by a test and shared with the
 * search path. Alert bodies are written by bots that lean on `*bold*` and
 * `_italic_` for structure, and a row reading `*Chronic swap thrashing*` is the
 * wire format sitting on the desk.
 */
export const plain = (t: string) =>
  clean(
    t.replace(/<!subteam\^S[A-Z0-9]+\|(@[a-z0-9-]+)>/g, '$1')
     .replace(/<!subteam\^S[A-Z0-9]+>/g, '')
     .replace(/```/g, ' '),
  )
    .replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1$2')

/** Was my group named? The difference between "on me now" and "posted where I can see it". */
export function paged(body: string): boolean {
  const named = new Set<string>()
  for (const m of body.matchAll(SUBTEAM)) if (m[1]) named.add(m[1])
  for (const m of body.matchAll(SUBTEAM_ALT)) if (m[1]) named.add(m[1])
  return SLACK_USERGROUPS.some(g => named.has(g))
}

/**
 * Cut the Cursor bot's re-render of the alert it is triaging.
 *
 * Without this the same issue URL is read twice, and the triage prose — which is
 * the only thing in that message worth reading — is buried under a copy of the
 * alert it explains.
 */
export function stripAppRerender(text: string): string {
  const i = text.indexOf(APP_RERENDER)
  return i === -1 ? text : text.slice(0, i).trimEnd()
}

const firstLine = (t: string) => plain(t.split('\n').map(l => l.trim()).find(Boolean) ?? '')

/** The `_Root cause:_ / _Classification:_ / _Fix:_` triple, or the body's own opening. */
function triageExcerpt(body: string): string {
  const marked = body.split('\n').filter(l => TRIAGE_LINE.test(l.trim())).slice(0, 3)
  return (marked.length ? marked.map(plain).join(' · ') : plain(body)).slice(0, 400)
}

/** The `meta` every alert card carries, per the shared alert contract. */
function alertMeta(ch: AlertChannel, hit: SlackHit, teamId: string, rest: {
  paged: boolean
  short_id: string | null
  alert_state: 'firing' | 'digest'
  monitor: string | null
}) {
  return {
    alert: true,
    channel: `#${ch.name}`,
    channel_id: ch.id,
    thread_ts: hit.ts,
    // Carried so the Open button can hand off to the Slack app rather than a
    // browser tab. `url` stays the https permalink: it is the durable one, and
    // it is what dedup parses a thread reference back out of.
    team_id: teamId,
    bot_id: hit.fromId.startsWith('B') ? hit.fromId : null,
    ...rest,
  }
}

/**
 * #sentry-alerts, where two bots describe one issue.
 *
 * Sentry posts the alert; ~5 minutes later Cursor posts its triage as a second
 * *top-level* message about the same issue. They are one row. The group is keyed
 * on the short id, the card's identity comes from the oldest member so it does
 * not churn every time Cursor follows up, and everything a reader sees comes
 * from the newest.
 */
function sentryAlertCards(ch: AlertChannel, hits: SlackHit[], teamId: string): RawCard[] {
  type Member = { hit: SlackHit; body: string; paged: boolean }
  const groups = new Map<string, Member[]>()
  const ungrouped: Member[] = []

  for (const hit of hits) {
    const body = stripAppRerender(hit.text)
    const member: Member = { hit, body, paged: paged(body) }
    // A short id or a page. Anything else in this channel is chatter, and a
    // channel Wake reads wholesale is a channel it must be choosy inside.
    const short = [...body.matchAll(SHORT_ID)][0]?.[0] ?? null
    if (!short) {
      if (member.paged) ungrouped.push(member)
      continue
    }
    const bucket = groups.get(short)
    if (bucket) bucket.push(member)
    else groups.set(short, [member])
  }

  return [
    ...[...groups].map(([short, members]) => sentryAlertCard(ch, short, members, teamId)),
    ...ungrouped.map(m => sentryAlertCard(ch, null, [m], teamId)),
  ]
}

function sentryAlertCard(
  ch: AlertChannel,
  short: string | null,
  members: Array<{ hit: SlackHit; body: string; paged: boolean }>,
  teamId: string,
): RawCard {
  const sorted = [...members].sort((a, b) => a.hit.epochMs - b.hit.epochMs)
  const oldest = sorted[0]!
  const newest = sorted[sorted.length - 1]!
  const wasPaged = sorted.some(m => m.paged)

  // The error class is rendered only by Sentry's own post — on a Cursor
  // follow-up it lives inside the copy `stripAppRerender` just cut — so it is
  // taken from whichever member still has it rather than from the newest.
  const errorClass = sorted.map(m => RED_LINK.exec(m.body)?.[1]).find(Boolean)
  const name = errorClass ?? firstLine(newest.body)
  const title = (!short || name.startsWith(short) ? name : `${short} · ${name}`).slice(0, 160)

  const sourceId = `${ch.id}:${oldest.hit.ts}`
  // A triage message names other issues in prose ("duplicate of TRUTO-37"). A
  // short id it merely mentions is not this card's identity, and letting it in
  // merges two unrelated Sentry issues into one row. The numeric ids come out of
  // real issue URLs, which the bots only post for the issue they are about, and
  // they are what performs the Slack ⟷ Sentry-API merge — so those stay.
  const own = (r: Ref) => r.t !== 'sentry' || /^\d+$/.test(r.v) || r.v === short
  const refs: Ref[] = [{ t: 'slackthread', v: sourceId }]
  if (short) refs.push({ t: 'sentry', v: short })
  for (const r of sorted.flatMap(m => extractAlertRefs(m.body))) {
    if (own(r) && !refs.some(x => x.t === r.t && x.v === r.v)) refs.push(r)
  }

  return {
    source: 'slack',
    source_id: sourceId,
    kind: 'alert',
    title,
    why: wasPaged ? `your team was paged in #${ch.name}` : `posted in #${ch.name}`,
    actor: newest.hit.fromName,
    actor_id: newest.hit.fromId,
    // Nobody is waiting on an alert. It is waiting on him.
    who: undefined,
    excerpt: triageExcerpt(newest.body),
    url: newest.hit.permalink,
    ts: newest.hit.epochMs,
    pile: wasPaged ? 'now' : 'open',
    refs,
    meta: alertMeta(ch, newest.hit, teamId, {
      paged: wasPaged,
      short_id: short,
      alert_state: 'firing',
      monitor: null,
    }),
  }
}

/**
 * #truto-api-alerts, which carries two unrelated things.
 *
 * Datadog monitor transitions are keyed on the monitor id and only the newest
 * one counts: a monitor that flapped four times is one row, and if its newest
 * transition is `Recovered:` it is no row at all. A desk showing forty
 * self-resolved pages at 7am is the flood this whole exercise exists to remove.
 *
 * The scheduled Truto Notifications digest is the other thing, and it is one
 * card per *message* — never one per error row inside it.
 */
function datadogAlertCards(ch: AlertChannel, hits: SlackHit[], teamId: string): RawCard[] {
  const out: RawCard[] = []
  const newestPerMonitor = new Map<string, SlackHit>()

  for (const hit of hits) {
    const monitor = DD_MONITOR.exec(hit.text)?.[1]
    if (monitor) {
      const cur = newestPerMonitor.get(monitor)
      if (!cur || hit.epochMs > cur.epochMs) newestPerMonitor.set(monitor, hit)
      continue
    }
    const head = DIGEST_HEAD.exec(hit.text)?.[1]
    if (head) out.push(digestCard(ch, hit, head, teamId))
  }

  for (const [monitor, hit] of newestPerMonitor) {
    const state = DD_STATE.exec(hit.text)
    if (state?.[1] === DD_RECOVERED) continue

    const attachments = [...hit.text.matchAll(ATTACHMENT)]
    const first = attachments[0]
    const name = state?.[2] ?? (first?.[1] ?? '').replace(/^[A-Za-z-]+: /, '')
    // The monitor's own canonical URL, taken from the message rather than
    // rebuilt, so the Datadog site this workspace uses stays whatever it is.
    const monitorUrl = (state?.[3] ?? first?.[2] ?? '').split('?')[0]
    const wasPaged = paged(hit.text)

    const refs: Ref[] = monitorUrl ? [{ t: 'url', v: monitorUrl }] : []
    for (const r of extractAlertRefs(hit.text)) {
      if (!refs.some(x => x.t === r.t && x.v === r.v)) refs.push(r)
    }

    out.push({
      source: 'slack',
      // Keyed on the monitor, not on the message: the next transition updates
      // this row rather than adding one beside it.
      source_id: `ddmonitor:${monitor}`,
      kind: 'alert',
      title: (name || firstLine(hit.text)).slice(0, 160),
      why: wasPaged ? `your team was paged in #${ch.name}` : `posted in #${ch.name}`,
      actor: hit.fromName,
      actor_id: hit.fromId,
      who: undefined,
      excerpt: plain(
        hit.text.split('\n')
          .filter(l => !l.startsWith('Attachment: ') && !l.startsWith('Notified: '))
          .join(' '),
      ).slice(0, 400),
      url: hit.permalink,
      ts: hit.epochMs,
      pile: wasPaged ? 'now' : 'open',
      refs,
      meta: alertMeta(ch, hit, teamId, {
        paged: wasPaged,
        short_id: null,
        alert_state: 'firing',
        monitor,
      }),
    })
  }
  return out
}

/** Header lines of a digest — the title and its three fixed preamble lines. */
const DIGEST_PREAMBLE = /^(\*:red_circle: |Scope: |Environment: |Includes direct API|Showing )/

function digestCard(ch: AlertChannel, hit: SlackHit, head: string, teamId: string): RawCard {
  const env = DIGEST_ENV.exec(hit.text)?.[1]
  // The per-environment digest is posted several times within the same minute,
  // once per environment, under one title. Without the environment they are
  // four identical-looking rows.
  const sourceId = `${ch.id}:${hit.ts}`

  return {
    source: 'slack',
    source_id: sourceId,
    kind: 'alert',
    title: plain(env ? `${head} · ${env}` : head).slice(0, 160),
    why: `posted in #${ch.name}`,
    actor: hit.fromName,
    actor_id: hit.fromId,
    who: undefined,
    excerpt: plain(
      hit.text.split('\n').filter(l => !DIGEST_PREAMBLE.test(l)).join(' '),
    ).slice(0, 400),
    url: hit.permalink,
    ts: hit.epochMs,
    pile: 'open',
    refs: [{ t: 'slackthread', v: sourceId }],
    meta: alertMeta(ch, hit, teamId, {
      paged: paged(hit.text),
      short_id: null,
      alert_state: 'digest',
      monitor: null,
    }),
  }
}

/**
 * #truto-grafana-alerts. One bot, no user id, and the entire message inside an
 * attachment — under `concise` these come back as empty strings.
 *
 * Same rule as Datadog: keyed on the alert name, newest transition wins, and a
 * resolved alert is not on him. The attachment URL is an internal Docker
 * hostname and is deliberately not carried anywhere it could become a link.
 */
function grafanaAlertCards(ch: AlertChannel, hits: SlackHit[], teamId: string): RawCard[] {
  const newestPerAlert = new Map<string, { hit: SlackHit; emoji: string }>()
  for (const hit of hits) {
    const m = GRAFANA_ATT.exec(hit.text)
    if (!m?.[2]) continue
    const cur = newestPerAlert.get(m[2])
    if (!cur || hit.epochMs > cur.hit.epochMs) newestPerAlert.set(m[2], { hit, emoji: m[1]! })
  }

  const out: RawCard[] = []
  for (const [name, { hit, emoji }] of newestPerAlert) {
    if (emoji === GRAFANA_RESOLVED) continue
    const wasPaged = paged(hit.text)

    out.push({
      source: 'slack',
      source_id: `grafana:${name}`,
      kind: 'alert',
      title: name,
      why: wasPaged ? `your team was paged in #${ch.name}` : `posted in #${ch.name}`,
      actor: hit.fromName,
      actor_id: hit.fromId,
      who: undefined,
      excerpt: plain(
        hit.text.split('\n').filter(l => !l.startsWith('Attachment: ')).join(' '),
      ).slice(0, 400),
      url: hit.permalink,
      ts: hit.epochMs,
      pile: wasPaged ? 'now' : 'open',
      refs: extractAlertRefs(hit.text),
      meta: alertMeta(ch, hit, teamId, {
        paged: wasPaged,
        short_id: null,
        alert_state: 'firing',
        monitor: name,
      }),
    })
  }
  return out
}

/** One channel's history, as cards. The family selects the parser and the rules. */
export function alertCards(ch: AlertChannel, hits: SlackHit[]): RawCard[] {
  const teamId = hits.find(h => h.teamId)?.teamId ?? SLACK_TEAM_ID
  if (ch.family === 'sentry') return sentryAlertCards(ch, hits, teamId)
  if (ch.family === 'datadog') return datadogAlertCards(ch, hits, teamId)
  return grafanaAlertCards(ch, hits, teamId)
}

/* ------------------------------ adapter ------------------------------- */

export async function runSearch(tool: string, query: string, limit = 20): Promise<SlackHit[]> {
  const r = await getSession().callJson<any>(tool, {
    query,
    sort: 'timestamp',
    sort_dir: 'desc',
    limit,
    // The search tool defaults this to false. Paired live runs on this
    // deployment showed no behavioural delta, but a search that excludes bots
    // by default is a search that can go quiet the day the default is honoured.
    include_bots: true,
    include_context: false,
    response_format: 'detailed',
  })
  const md = typeof r === 'string' ? r : (r as any)?.results
  // A payload we cannot read is a failed query, not an empty workspace. Swallowed
  // into `[]` it reaches `settle` as a success, and the sweep then marks every
  // stored Slack card gone.
  if (typeof md !== 'string') throw new Error(`slack search returned ${typeof r}, not text`)
  return parseSlackResults(md)
}

export const slack: SourceAdapter = {
  name: 'slack',
  label: 'Slack',

  async status() {
    const { token, via } = await resolveToken('slack')
    if (!token) {
      // The shape of the work, in three words, before the click. Slack publishes
      // no registration endpoint, so Connect opens a form for a client id and
      // secret rather than a consent screen, and the row should say so first.
      return { ok: false, detail: 'needs an app of your own' }
    }
    try {
      const t = await discoverTools()
      if (!t.search) {
        return {
          ok: false,
          detail: 'Slack granted a token but no search tool — reconnect to grant search:read.public and search:read.private',
          via,
        }
      }
      // Half a Slack is not a connected Slack. Without channel history the poll
      // throws on every run, and a row reading `connected` above a source that
      // cannot answer is the green-over-nothing this wave exists to remove.
      if (!t.readChannel) {
        return {
          ok: false,
          detail: 'Slack granted a token but no channel-history tool — reconnect to grant channels:history and groups:history',
          via,
        }
      }
      return { ok: true, detail: t.myUserId ? `connected as ${t.myUserId}` : 'connected', via }
    } catch (e) {
      if (e instanceof McpUnauthorized) return { ok: false, detail: 'token rejected — reconnect', via }
      return { ok: false, detail: (e as Error).message, via }
    }
  },

  async fetch() {
    const { token } = await resolveToken('slack')
    if (!token) throw new NotConnected('slack')

    const t = await discoverTools()
    if (!t.search) {
      throw new Error('Slack granted a token but no search tool — reconnect to grant search:read.public and search:read.private')
    }
    // Thrown, never an empty list. An adapter that answers a missing capability
    // with `[]` is an adapter that reports a healthy sync of nothing.
    if (!t.readChannel) {
      throw new Error('Slack granted a token but no channel-history tool — reconnect to grant channels:history and groups:history')
    }

    const sinceMs = Date.now() - LOOKBACK_DAYS * 864e5
    const since = new Date(sinceMs).toISOString().slice(0, 10)
    const me = t.myUserId

    // One question, not two. `to:me` is gone with direct messages as a concept:
    // a DM is a conversation, not a piece of work, and twenty of them on the
    // desk is twenty rows nothing can be done about from here.
    const mention = me ? `<@${me}> after:${since}` : null

    /*
     * One settled array, deliberately. A failed alert-channel read has to make
     * the whole Slack run not-ok: `settle` raises a `PartialPoll`, ingest turns
     * that into `ok:false, authoritative:false`, and the sweep is then skipped —
     * so the alert cards already on the desk survive a poll that could not read
     * their channel. Splitting these into two settled sets is how a green
     * "synced 2m ago" ends up sitting over a channel nobody managed to read.
     */
    const settled = await Promise.allSettled([
      ...(mention ? [runSearch(t.search!, mention, 20)] : []),
      ...SLACK_ALERT_CHANNELS.map(ch => readAlertChannel(t.readChannel!, ch.id, sinceMs)),
    ])

    const cards: RawCard[] = []
    const seen = new Set<string>()

    if (mention && settled[0]?.status === 'fulfilled') {
      for (const h of (settled[0] as PromiseFulfilledResult<SlackHit[]>).value) {
        // Never surface my own messages back to me.
        if (me && h.fromId === me) continue
        // A direct message is thrown away before it can become a card.
        if (h.isDm) continue
        const key = `${h.channelId}:${h.ts}`
        if (seen.has(key)) continue
        seen.add(key)

        const text = clean(h.text)
        const ask = readsLikeAsk(text)

        cards.push({
          source: 'slack',
          source_id: key,
          kind: 'mention',
          title: text.slice(0, 120) || `Message from ${h.fromName}`,
          // Prefer the sharper reason when the message reads like an ask.
          why: ask ?? 'you were mentioned',
          actor: h.fromName,
          actor_id: h.fromId,
          // Slack is one of the two sources where the actor genuinely is a
          // person who is waiting on a reply.
          who: h.fromName || undefined,
          excerpt: text.slice(0, 400),
          url: h.permalink,
          ts: h.epochMs,
          pile: 'now',
          refs: [{ t: 'slackthread', v: key }, ...extractRefs(h.text)],
          meta: {
            channel: h.channelName,
            channel_id: h.channelId,
            thread_ts: h.ts,
            team_id: h.teamId ?? SLACK_TEAM_ID,
            ask: ask ?? null,
          },
        })
      }
    }

    const offset = mention ? 1 : 0
    SLACK_ALERT_CHANNELS.forEach((ch, i) => {
      const res = settled[offset + i]
      if (res?.status !== 'fulfilled') return
      for (const c of alertCards(ch, res.value as SlackHit[])) {
        if (seen.has(c.source_id)) continue
        seen.add(c.source_id)
        cards.push(c)
      }
    })

    // A search that exploded is not a search that found nothing. Tool discovery
    // is cached for thirty minutes, so without this a Slack whose queries start
    // failing after one successful discovery reports `ok, 0 rows` — and the
    // sweep then deletes every Slack card on the desk.
    return settle('slack', settled, cards)
  },
}

/** On-demand thread read, used when a card is opened rather than on every poll. */
export async function readThread(channelId: string, messageTs: string) {
  const t = await discoverTools()
  if (!t.readThread) return null
  const r = await getSession().callJson<any>(t.readThread, {
    channel_id: channelId,
    message_ts: messageTs,
    limit: 50,
    response_format: 'detailed',
  })
  const md = typeof r === 'string' ? r : (r?.results ?? r?.messages ?? '')
  return typeof md === 'string' ? { raw: md, messages: parseSlackResults(md) } : r
}
