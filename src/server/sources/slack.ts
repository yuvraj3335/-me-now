/**
 * Slack over the official MCP server (https://mcp.slack.com/mcp).
 *
 * Four things here are not guesses and matter a lot:
 *
 *   1. The tools answer with *Markdown*, not JSON, so `slackParse.ts` contains
 *      real parsers for those shapes rather than a JSON.parse and a prayer.
 *   2. The signed-in user id is published in the tool's own description
 *      ("Current logged in user's user_id is U…"), so Wake discovers who you are
 *      from the server instead of needing it configured.
 *   3. **A thread is one row.** A parent, its replies, and a message posted into
 *      it tomorrow are one piece of work, and the desk showed them as three
 *      because the row was keyed on each message's own ts. The permalink carries
 *      `?thread_ts=<parent>` on every hit — proven across 40 live rows — so the
 *      key is the parent, and every hit in a thread collapses into it.
 *   4. **Alert channels are read, not searched.** Sentry pages the team with
 *      `notes: <!subteam^S06HDT77E1M|@truto-eng>`, which lives in Block Kit, and
 *      Slack's search index does not cover Block Kit. Searching for the
 *      usergroup returns nothing from the one channel where the usergroup is
 *      actually used. Reading the channel returns the text search cannot see.
 *
 * And one refusal: **no direct messages, ever, by any path.** They are half the
 * live desk today, they are not work anybody assigned, and the ban is structural
 * — the query is gone, the kind is gone, and `isDirectMessage` drops a DM-shaped
 * hit in one place before it can become a card.
 */
import { McpSession, HttpTransport, McpUnauthorized } from '../mcp/client'
import { tokenGetter, resolveToken } from '../mcp/creds'
import {
  MCP_SERVERS, ME, LOOKBACK_DAYS,
  SLACK_ALERT_CHANNELS, SLACK_ALERT_CHANNEL_LIMIT, SLACK_FIREHOSE,
  SLACK_THREAD_READS, SLACK_USERGROUPS,
} from '../env'
import { extractRefs } from '../dedup'
import { NotConnected, settle, type RawCard, type Ref, type SourceAdapter } from './types'
import {
  archiveLink, clean, hostOf, isDirectMessage, namesUsergroup, namesUser,
  parentTs, parseChannelRead, parseSlackResults, parseThreadRead, slackTsToMs,
  type SlackChannelRead, type SlackHit, type SlackMessage, type SlackThreadRead,
} from './slackParse'

// Re-exported so the shape of a Slack message is imported from the adapter that
// owns it, rather than every caller learning the parser module's path.
export {
  clean, isDirectMessage, parentTs, parseChannelRead, parseSlackResults,
  parseThreadRead, slackTsToMs,
} from './slackParse'
export type { SlackHit, SlackMessage, SlackThreadRead } from './slackParse'

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

export async function discoverTools(): Promise<Tools> {
  // A miss is not a fact worth remembering. Slack MCP hides the search tool
  // when the token lacks `search:read.public` / `.private`; caching that
  // empty list for thirty minutes is how a reconnect that just granted
  // those scopes still looked like "no search tool".
  if (toolCache?.tools.search && Date.now() - toolCache.at < 30 * 60_000) return toolCache.tools
  try {
    const all = await getSession().listTools(!toolCache?.tools.search)
    const byName = (re: RegExp) => all.find(t => re.test(t.name))?.name

    const search =
      byName(/^slack_search_public_and_private$/) ??
      byName(/search.*(public.*private|messages)/i) ??
      byName(/^slack_search(_public)?$/i) ??
      byName(/search/i)

    // The server tells us who we are in prose; that beats hard-coding an id.
    const desc = all.map(t => t.description ?? '').join('\n')
    const myUserId = ME.slackUserId || desc.match(/user_id is (U[A-Z0-9]+)/i)?.[1]

    const tools: Tools = {
      search,
      readThread: byName(/read_thread|thread_replies/i),
      readChannel: byName(/read_channel|conversations?_history|channel_history/i),
      myUserId,
    }
    if (tools.search) toolCache = { at: Date.now(), tools }
    return tools
  } catch (e) {
    resetSlackSession()
    throw e
  }
}

/* ------------------------------ asks ---------------------------------- */

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

/* ------------------------------ the calls ----------------------------- */

/**
 * `include_bots` is not optional here.
 *
 * Every alert that matters — Sentry, Grafana, the API digest, Cursor's
 * follow-ups — is posted by an app, and a search that quietly excludes bots is a
 * search that cannot see any of them. It was never passed, which is why the four
 * alert channels have never appeared on this desk.
 */
export async function runSearch(tool: string, query: string, limit = 20): Promise<SlackHit[]> {
  const r = await getSession().callJson<any>(tool, {
    query,
    sort: 'timestamp',
    sort_dir: 'desc',
    limit,
    include_bots: true,
    include_context: false,
    response_format: 'detailed',
  })
  const md = typeof r === 'string' ? r : (r?.results ?? r?.messages ?? '')
  return typeof md === 'string' ? parseSlackResults(md) : []
}

/**
 * Both readers answer `{ messages: "<markdown>" }` today and a bare string when
 * the session normalises the envelope away, so every caller has to accept both.
 */
const markdownOf = (r: unknown): string => {
  if (typeof r === 'string') return r
  const o = r as Record<string, unknown> | null
  for (const k of ['messages', 'results', 'text', 'content']) {
    const v = o?.[k]
    if (typeof v === 'string') return v
  }
  return ''
}

/** One thread in full: the parent, every reply, and the authoritative count. */
export async function readThread(channelId: string, threadTs: string): Promise<SlackThreadRead> {
  const t = await discoverTools()
  if (!t.readThread) throw new Error('Slack exposes no thread-read tool')
  const r = await getSession().callJson<any>(t.readThread, {
    channel_id: channelId,
    message_ts: threadTs,
    limit: 50,
    response_format: 'detailed',
  })
  return parseThreadRead(markdownOf(r))
}

/**
 * The newest messages in one channel, bots included (a channel read returns them).
 *
 * The failure carries the channel's name, and that is not decoration. A channel
 * read that fails makes the whole Slack poll partial, which costs the sweep its
 * authority until it is fixed — so the sentence the reader gets in Settings has
 * to be the one that says which channel to go and look at. `channel_not_found`
 * on its own is a fact about none of the four.
 */
export async function readChannel(channelId: string, limit = SLACK_ALERT_CHANNEL_LIMIT) {
  const t = await discoverTools()
  if (!t.readChannel) throw new Error('Slack exposes no channel-read tool')
  const named = SLACK_ALERT_CHANNELS.find(c => c.id === channelId)?.name ?? channelId
  try {
    const r = await getSession().callJson<any>(t.readChannel, {
      channel_id: channelId,
      limit,
      response_format: 'detailed',
    })
    return parseChannelRead(markdownOf(r), channelId)
  } catch (e) {
    throw new Error(`#${named} could not be read — ${(e as Error).message}`)
  }
}

/* ------------------------------ assembly ------------------------------ */

/** One entry in a card's `meta.thread`. Capped so a card stays a card. */
export type ThreadEntry = {
  ts: string
  who: string
  who_id: string
  text: string
  /** This message names him personally, or pages a usergroup he is in. */
  tagged: boolean
  /** He wrote it. His own messages are never activity on him. */
  mine: boolean
}

const ENTRY_CHARS = 280
const ENTRY_CAP = 20

/**
 * Everything one thread produced, before it becomes a card.
 *
 * `hits` are the search results that pointed at this thread — there may be
 * several, and there may be none when the thread came from a channel read
 * instead. `seed` is whichever message we already hold that is the best
 * candidate parent, so a thread whose read fails still has a title.
 */
export type ThreadBucket = {
  channelId: string
  channelName: string
  parent: string
  hits: SlackHit[]
  /** Set when this thread came from an alert channel rather than from search. */
  alert: boolean
  /** The message we already have for the parent ts, if the source gave us one. */
  seed: SlackMessage | null
  /** The real workspace origin, when a permalink handed us one. */
  host: string | null
  newest: number
}

const asEntry = (m: SlackMessage, me: string, groups: readonly string[]): ThreadEntry => {
  const mine = !!me && m.whoId === me
  return {
    ts: m.ts,
    who: m.who,
    who_id: m.whoId,
    text: clean(m.text).slice(0, ENTRY_CHARS),
    /*
     * A message he wrote is never "somebody named you".
     *
     * `tagged` is what draws the `@you` mark beside a line in the detail pane
     * and what `newestTagger` reads to fill the `Who` column, so a line of his
     * own carrying it is the pane telling him he is waiting on himself. He is
     * on `@truto-eng`, so every time he pages his own team the raw text does
     * name a group he is in — which is true, and is not the question this field
     * is asked.
     */
    tagged: !mine && (namesUser(m.text, me) || !!namesUsergroup(m.text, groups)),
    mine,
  }
}

/**
 * Whichever rendering of the parent actually has words in it.
 *
 * Both are the same message: a bucket's `seed` is only ever set from the ts
 * that is the thread's parent. They differ because two different tools rendered
 * them. A channel read carries the Block Kit an alert's whole body lives in; a
 * thread read of the same message can come back as a `From:` header and an
 * `Attachments:` line, which `bodyAfterTs` drops as transport, leaving an empty
 * body. Preferring the thread read unconditionally is how an alert that
 * `alertIsOnHim` had just deliberately admitted arrived untitled and was then
 * refused outright at the title gate.
 */
function pickParent(read: SlackMessage | null, seed: SlackMessage | null): SlackMessage | null {
  if (read && clean(read.text)) return read
  if (seed && clean(seed.text)) return seed
  return read ?? seed
}

/**
 * A thread, as a card.
 *
 * Exported and pure so the tests can drive it with the captured fixtures rather
 * than with a mocked transport: everything interesting about a Slack row is
 * decided here, and none of it needs a network.
 */
export function buildThreadCard(
  b: ThreadBucket,
  read: SlackThreadRead | null,
  me: string,
  groups: readonly string[] = SLACK_USERGROUPS,
): RawCard | null {
  /*
   * The last gate on the DM ban, and the only one every path has to pass.
   *
   * `bucketHits` drops a DM-shaped search hit and Fetch drops one on its own two
   * routes, but each of those guards a pipe rather than the desk. This is the
   * one function every Slack card in the product is built by, so a fourth pipe
   * added later — an alert channel misconfigured with a `D` id, a caller that
   * assembles a bucket by hand — cannot route around a refusal the brief calls
   * structural.
   */
  if (isDirectMessage({ channelId: b.channelId, channelName: b.channelName })) return null

  const parentMsg = pickParent(read?.parent ?? null, b.seed)
  const replies = read?.replies ?? []

  // The parent is the row's title even when the parent was never in the search
  // results, which is the common case: he gets named in a reply, and the search
  // returns the reply. Without the thread read the title would be somebody
  // answering a question the desk never showed.
  const parent = parentMsg ? asEntry(parentMsg, me, groups) : null
  const replyEntries = replies.map(m => asEntry(m, me, groups))
  // The newest twenty, not the first twenty: the pane reads downward and the
  // material anyone came for is at the bottom.
  const entries = replyEntries.slice(-ENTRY_CAP)

  const all = parent ? [parent, ...replyEntries] : replyEntries
  if (!all.length && !b.hits.length) return null

  /*
   * Named-ness is decided on the RAW text, before `clean` turns
   * `<@U09617LRRDF|Yuvraj Muley>` into `@Yuvraj Muley` and `<!subteam^S…|…>`
   * into a handle. Once the markup is gone the id is gone with it, and "is this
   * on me" would be a string match on a display name anybody can change.
   *
   * And it is decided on what somebody ELSE wrote, which is why authorship
   * travels alongside the text here rather than the text travelling alone. The
   * seed rides along too: when the thread read produced the parent, the seed is
   * the same message as the channel read rendered it, and that rendering is the
   * only one carrying Block Kit — the `notes: <!subteam^…|@truto-eng>` line and
   * the `Short ID: TRUTO-38` that union this row with the Sentry issue.
   */
  type Said = { text: string; mine: boolean }
  const wrote = (whoId: string | undefined) => !!me && whoId === me
  const said: Said[] = [
    ...(parentMsg ? [{ text: parentMsg.text, mine: wrote(parentMsg.whoId) }] : []),
    ...(b.seed && b.seed !== parentMsg ? [{ text: b.seed.text, mine: wrote(b.seed.whoId) }] : []),
    ...replies.map(r => ({ text: r.text, mine: wrote(r.whoId) })),
    ...b.hits.map(h => ({ text: h.text, mine: wrote(h.fromId) })),
  ]
  const theirs = said.filter(s => !s.mine)
  const personally = theirs.some(s => namesUser(s.text, me))
  const usergroup = theirs.map(s => namesUsergroup(s.text, groups)).find(Boolean) ?? null

  /*
   * What he said himself is not work waiting on him.
   *
   * One of the two searches asks for his own usergroup and he is on that team,
   * so every `@truto-eng` announcement he posts comes back as a hit of his own.
   * Decided on his own text it landed as `now` — the pile that means somebody is
   * waiting — with an empty `Who`, because the only tagged message in it was his:
   * the desk handing him back what he had just said. The shipped code dropped
   * every hit he authored, which a thread cannot do any more (he is frequently
   * the parent of a thread other people are waiting in), so the refusal moves up
   * to the thread: nobody else has said anything here, and nothing names him.
   */
  if (!personally && !usergroup && said.length && said.every(s => s.mine)) return null

  const tagged = all.filter(e => e.tagged)
  const channel = b.channelName || b.channelId
  const bare = channel.replace(/^#/, '')

  // `kind` and `pile` answer two different questions: where it came from, and
  // whether somebody is waiting on him. An alert nobody named him in is still
  // worth seeing, and it is not "now".
  const kind = b.alert ? 'alert' : personally ? 'mention' : 'thread'
  const why = personally
    ? `you were mentioned in #${bare}`
    : usergroup
      ? `${usergroup} in #${bare}`
      : `posted in #${bare}`
  const pile: RawCard['pile'] = personally || usergroup ? 'now' : 'open'

  // When there is no parent to fall back on, prefer a hit somebody else wrote:
  // a row whose title and author are his own message is the desk handing him
  // back what he already said.
  const first = b.hits.find(h => !me || h.fromId !== me) ?? b.hits[0]
  const author = parentMsg?.who ?? first?.fromName ?? 'someone'

  /*
   * What this row is called, and why it may refuse to be one.
   *
   * The row is the *thread*, so the title falls through the thread: the parent
   * first, then a hit somebody else wrote, then the newest reply that is not
   * his own. A parent that is an uncaptioned screenshot still has a real
   * conversation under it, and dropping that row would lose work.
   *
   * But when every one of those renders empty there is nothing to put in the
   * Title column, and the row used to fill it with `Message from Sentry` — a
   * line that says only which robot spoke, so the only way to find out what it
   * is is to open it. An untitled row is worse than an absent one (DESIGN §7),
   * so the card is refused instead.
   */
  const title = (
    parent?.text ||
    (first ? clean(first.text) : '') ||
    entries.filter(e => !e.mine).slice(-1)[0]?.text ||
    entries.slice(-1)[0]?.text ||
    ''
  ).slice(0, 120)
  if (!title) return null

  // Every reply is read for references too, not just the parent: a `TRUTO-38`
  // posted in a reply is what unions this row with the Sentry issue, and the
  // whole point of collapsing a thread into one row is that its replies belong
  // to it.
  const refText = said.map(s => s.text).join('\n')

  /*
   * The excerpt is the conversation, once.
   *
   * `said` is the wider net that named-ness and references are decided over, and
   * it holds the same message more than once on purpose — the thread reader's
   * rendering of the parent, the channel reader's, and the search index's
   * projection are three views of one message and each carries something the
   * others do not. That is right for a scan and wrong for anything a person
   * reads: the excerpt used to open with the parent's text, twice.
   */
  const excerpt = clean(
    (parentMsg
      ? [parentMsg.text, ...replies.map(r => r.text)]
      : b.hits.map(h => h.text)
    ).join('\n'),
  ).slice(0, 400)

  const key = `${b.channelId}:${b.parent}`
  /*
   * Every reference in the conversation except one: a Slack permalink.
   *
   * A permalink somebody pastes in a thread is a pointer to another
   * conversation, not a claim that this row *is* that conversation. Nidhi's
   * parent quotes `…/archives/C0AHHQMF08L/p1787777335863559`, and reading that
   * as a thread reference gave this row a second identity — so any other thread
   * where anybody quoted the same link was unioned into it, and one desk row
   * spoke for two conversations while the other's title, why and Who
   * disappeared into `sources`. This row's thread identity is the key above, and
   * it is the only one it gets. Nothing else changes: the `TRUTO-38` in a reply
   * is exactly what this scan is here for.
   */
  const refs: Ref[] = [
    { t: 'slackthread', v: key },
    ...extractRefs(refText).filter(r => r.t !== 'slackthread'),
  ]

  const newestReply = replies.length ? Math.max(...replies.map(r => r.epochMs)) : null
  const taggedAt = tagged.length ? Math.max(...tagged.map(e => slackTsToMs(e.ts))) : null
  const ts = Math.max(
    parentMsg?.epochMs ?? 0,
    newestReply ?? 0,
    ...b.hits.map(h => h.epochMs),
  ) || Date.now()

  // The permalink of the *parent*, which is where the conversation starts. A
  // hit's own permalink points at a reply, and "seen in" pointing three messages
  // down a thread is how a link stops being a link to the thing.
  const url =
    b.hits.find(h => h.ts === b.parent)?.permalink ||
    archiveLink(b.channelId, b.parent, b.host ?? undefined)

  // The ask is in the message that named him, not somewhere in a fourteen-reply
  // thread: running the rule table over the whole conversation would find a
  // question mark in almost every thread and say every row was a question.
  const askIn = tagged.filter(e => !e.mine).slice(-1)[0]?.text ?? parent?.text ?? ''
  const ask = readsLikeAsk(askIn)

  return {
    source: 'slack',
    source_id: key,
    kind,
    title,
    why,
    actor: author,
    actor_id: parentMsg?.whoId ?? first?.fromId,
    // A person waiting on him — the one who named him, or the one who started
    // the thread. Never a bot: an alert channel's author is an app, and a `Who`
    // column that prints "Sentry" is a column that has to be re-read.
    who: b.alert ? undefined : (newestTagger(all, me) ?? (parent?.mine ? undefined : author)),
    excerpt,
    url,
    ts,
    pile,
    refs,
    meta: {
      channel,
      channel_id: b.channelId,
      is_dm: false,
      thread_ts: b.parent,
      // The header's total, not what the page happened to return.
      replies: read?.replyTotal ?? replies.length,
      last_reply_at: newestReply,
      tagged_at: taggedAt,
      parent,
      thread: entries,
      ...(read ? {} : { thread_partial: true }),
      ...(usergroup ? { usergroup } : {}),
      ask: ask ?? null,
    },
  }
}

/** Whoever most recently named him, which is the person actually waiting. */
function newestTagger(entries: ThreadEntry[], me: string): string | undefined {
  const tagged = entries.filter(e => e.tagged && !e.mine && !!me)
  if (!tagged.length) return undefined
  return tagged.reduce((a, b) => (slackTsToMs(b.ts) > slackTsToMs(a.ts) ? b : a)).who
}

/**
 * Group everything one poll saw into threads, dropping what may never land.
 *
 * The two refusals live here, once each, so no future caller can route around
 * them: a direct message never becomes a bucket, and a firehose channel only
 * does when he is named in the message itself.
 */
export function bucketHits(
  hits: SlackHit[],
  me: string,
  firehose: readonly string[] = SLACK_FIREHOSE,
): Map<string, ThreadBucket> {
  const out = new Map<string, ThreadBucket>()
  for (const h of hits) {
    if (isDirectMessage(h)) continue
    const bare = (h.channelName || '').replace(/^#/, '').toLowerCase()
    if (firehose.some(f => bare === f.toLowerCase()) && !namesUser(h.text, me)) continue

    const parent = parentTs(h)
    const key = `${h.channelId}:${parent}`
    const b = out.get(key) ?? {
      channelId: h.channelId,
      channelName: h.channelName,
      parent,
      hits: [],
      alert: false,
      seed: null,
      host: null,
      newest: 0,
    }
    b.hits.push(h)
    b.host ??= hostOf(h.permalink)
    b.newest = Math.max(b.newest, h.epochMs)
    // The search returned the parent itself: a thread read that fails still has
    // a real title rather than a reply standing in for one.
    if (h.ts === parent) {
      b.seed = { ts: h.ts, epochMs: h.epochMs, who: h.fromName, whoId: h.fromId, text: h.text }
    }
    out.set(key, b)
  }
  return out
}

/**
 * Whether a message read from an alert channel is on him.
 *
 * This is the correction in DESIGN §7, and it exists because the channel was
 * read live before the rule was written. `#truto-api-alerts` is not a digest.
 * It is Datadog posting a `Warn:` and a `Recovered:` six minutes apart, every
 * few minutes, forever, naming `@slack-truto-api-alerts` — a channel handle,
 * not him and not `@truto-eng`. One card per message there would put a
 * metronome on the desk and make it a replica of the channel, which is the one
 * thing the desk is not for.
 *
 * So an alert channel is held to the same rule the rest of Slack already is,
 * plus the one thing that makes reading these channels worth doing at all: a
 * Sentry reference. `TRUTO-38` appears in both the Sentry post and Cursor's
 * follow-up, which is what unions the two messages and the Sentry API row into
 * a single card instead of three.
 *
 * Everything else in those channels is something he reads in Slack.
 */
export function alertIsOnHim(
  text: string,
  me: string,
  groups: readonly string[] = SLACK_USERGROUPS,
): boolean {
  // Nothing to title a row with is not something to put on a desk, whatever
  // else the message names.
  if (!clean(text)) return false
  if (namesUser(text, me)) return true
  if (namesUsergroup(text, groups)) return true
  return extractRefs(text).some(r => r.t === 'sentry')
}

/**
 * Fold one alert channel's messages into the buckets a poll already holds.
 *
 * Alert channels arrive as whole messages rather than as search hits, so they
 * seed their own buckets: the parent's text is in hand and no thread read is
 * needed to title the row. A channel read carries no `thread_ts` either, and it
 * returns top-level messages, so a message's own ts *is* its parent.
 *
 * Exported and pure for the same reason `buildThreadCard` is — the admission
 * rule is the whole point of this function, and a rule that can only be
 * exercised through a mocked transport is a rule that quietly stops being
 * applied.
 */
export function bucketAlerts(
  buckets: Map<string, ThreadBucket>,
  read: SlackChannelRead,
  fallback: { id: string; name: string },
  me: string,
  cutoff: number,
  groups: readonly string[] = SLACK_USERGROUPS,
): Map<string, ThreadBucket> {
  const channelId = read.channelId || fallback.id
  for (const m of read.messages) {
    if (m.epochMs < cutoff) continue
    const key = `${channelId}:${m.ts}`

    /*
     * A row the search already earned keeps its place, and gains the Block Kit
     * text search cannot see — which is the only reason it is worth reading this
     * channel rather than searching it.
     *
     * The channel read's rendering of the message wins, rather than whichever
     * one happened to arrive first. Both are the same message, but the search
     * index is a projection of it: `notes: <!subteam^S06HDT77E1M|@truto-eng>`
     * and `Short ID: TRUTO-38` live in Block Kit and search never returns them.
     * A `??=` here meant a Sentry alert that also named him in plain text was
     * seeded by the search hit — so the row carried neither the usergroup nor
     * the `sentry:` references that union it with the Sentry issue's own card,
     * and one incident became two desk rows because of a question mark.
     */
    const existing = buckets.get(key)
    if (existing) {
      existing.alert = true
      if (clean(m.text) || !existing.seed) existing.seed = m
      continue
    }

    if (!alertIsOnHim(m.text, me, groups)) continue

    buckets.set(key, {
      channelId,
      channelName: read.channelName || `#${fallback.name}`,
      parent: m.ts,
      hits: [],
      alert: true,
      seed: m,
      host: null,
      newest: m.epochMs,
    })
  }
  return buckets
}

/* ------------------------------ adapter ------------------------------- */

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

    const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10)
    const me = t.myUserId ?? ''
    const cutoff = Date.now() - LOOKBACK_DAYS * 864e5

    // Two questions, and no `to:me`. What is asked for is his name and his
    // team's, in channels; a direct message is not work somebody assigned.
    const queries = [
      ...(me ? [`<@${me}> after:${since}`] : []),
      ...SLACK_USERGROUPS.map(g => `<!subteam^${g}> after:${since}`),
    ]

    /*
     * Searches and alert-channel reads settle together, and both are load-bearing
     * for honesty: a channel that did not answer is a channel whose alerts are
     * missing, so it makes the poll partial and the sync line say failed. Thread
     * reads are deliberately NOT in here — see below.
     */
    const asked = await Promise.allSettled([
      ...queries.map(q => runSearch(t.search!, q)),
      ...SLACK_ALERT_CHANNELS.map(c => readChannel(c.id)),
    ])

    const hits: SlackHit[] = []
    for (let i = 0; i < queries.length; i++) {
      const r = asked[i]
      if (r?.status === 'fulfilled') hits.push(...(r.value as SlackHit[]))
    }

    const buckets = bucketHits(hits, me)

    // Alert channels arrive as whole messages rather than as search hits, so
    // they seed their own buckets — but only the ones that are actually on him.
    // See `alertIsOnHim`: the rest of those channels is a metronome.
    SLACK_ALERT_CHANNELS.forEach((c, i) => {
      const r = asked[queries.length + i]
      if (r?.status !== 'fulfilled') return
      bucketAlerts(buckets, r.value as Awaited<ReturnType<typeof readChannel>>, c, me, cutoff)
    })

    /*
     * Which threads get read, and why it is not simply "the newest twenty".
     *
     * A thread whose parent we do not hold cannot be titled without a read — the
     * row would be a reply standing in for the conversation it belongs to. A
     * thread whose parent we already have loses only its reply count. The four
     * alert channels post constantly and always arrive parent-first, so a plain
     * newest-first cap would spend the whole budget on messages that need it
     * least and degrade every mention.
     */
    const ordered = [...buckets.values()].sort(
      (a, b) => Number(!!a.seed) - Number(!!b.seed) || b.newest - a.newest,
    )
    const toRead = t.readThread ? ordered.slice(0, SLACK_THREAD_READS) : []

    const reads = new Map<string, SlackThreadRead>()
    await Promise.all(
      toRead.map(async b => {
        // A thread read that fails degrades ONE row: the earliest hit becomes
        // the parent and the card says so with `meta.thread_partial`. It is not
        // a failed poll, because everything else this poll asked for arrived.
        try {
          reads.set(`${b.channelId}:${b.parent}`, await readThread(b.channelId, b.parent))
        } catch {
          /* degraded, deliberately, and visibly on the row */
        }
      }),
    )

    const cards: RawCard[] = []
    for (const [key, b] of buckets) {
      const card = buildThreadCard(b, reads.get(key) ?? null, me)
      if (card) cards.push(card)
    }

    // A search that exploded is not a search that found nothing. Tool discovery
    // is cached for thirty minutes, so without this a Slack whose queries start
    // failing after one successful discovery reports `ok, 0 rows` — and the
    // sweep then deletes every Slack card on the desk.
    return settle('slack', asked, cards)
  },
}
