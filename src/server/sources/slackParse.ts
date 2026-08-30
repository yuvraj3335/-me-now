/**
 * The three shapes mcp.slack.com actually answers with.
 *
 * Slack's MCP does not return JSON. Search, thread reads and channel reads each
 * answer with a different Markdown-ish text block, and each block was captured
 * live on 2026-08-30 before a line of this was written — see FIXTURES.md. Every
 * regex here is against a real payload rather than against a schema somebody
 * documented.
 *
 * Three details cost real bugs and are worth stating once:
 *
 *   1. The search tool spells the timestamp `Message_ts:` and the thread and
 *      channel readers spell it `Message TS:`. Both are handled everywhere,
 *      because "which tool produced this text" is not a question a parser should
 *      have to ask.
 *   2. A message body is taken by index, not by a `/m`-flagged regex. With `/m`
 *      a `$` terminator matches the end of the first *line*, which silently
 *      truncates every multi-line message to its opening sentence.
 *   3. Every field is optional-safe. A missing one degrades to a usable row; it
 *      never throws away the whole poll.
 */

import { SLACK_WORKSPACE } from '../env'

/* ------------------------------- timestamps ------------------------------- */

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

/* ---------------------------------- hits ---------------------------------- */

export type SlackHit = {
  channelId: string
  channelName: string
  isDm: boolean
  fromName: string
  fromId: string
  ts: string
  epochMs: number
  permalink: string
  text: string
}

/** One message inside a thread or a channel, as the readers describe it. */
export type SlackMessage = {
  ts: string
  epochMs: number
  who: string
  whoId: string
  text: string
}

export type SlackThreadRead = {
  parent: SlackMessage | null
  replies: SlackMessage[]
  /**
   * The count from the `=== THREAD REPLIES (N total) ===` header.
   *
   * Authoritative even when the page returned fewer than N — `pagination_info`
   * says so explicitly — so "how many replies are on this" is answered by the
   * header rather than by counting what happened to arrive.
   */
  replyTotal: number
}

export type SlackChannelRead = {
  channelId: string
  channelName: string
  messages: SlackMessage[]
}

/* ------------------------------- shared bits ------------------------------ */

/**
 * `From: Nidhi <nidhi@truto.one> (U0BBZV4HQHH)` in the readers, and
 * `From: Nidhi <nidhi@truto.one> (ID: U0BBZV4HQHH)` in search. The email is
 * optional; the parenthesised id may carry the `ID:` prefix or not.
 */
function parseWho(raw: string): { who: string; whoId: string } {
  const whoId = raw.match(/\((?:ID:\s*)?([UWB][A-Z0-9]+)\)/)?.[1] ?? ''
  const who = raw
    .replace(/\s*<[^>]*>\s*/, ' ')
    .replace(/\s*\((?:ID:\s*)?[A-Z0-9]+\)\s*/, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { who: who || 'someone', whoId }
}

/**
 * `Reactions:` and `Files:` sit inside the body with no separator of their own.
 * They are metadata about the message rather than something somebody said, and a
 * card whose excerpt reads `Files: image.png (ID: F0BSY2UPBL5, image/png, …)` is
 * quoting the transport back at the reader.
 */
const NOT_BODY = /^(Reactions|Files|Attachments):/i

/** Everything after the `Message TS:` line, to the end of the block. */
function bodyAfterTs(block: string): string {
  const idx = block.search(/^Message[ _][Tt][Ss]:/m)
  if (idx === -1) return ''
  const nl = block.indexOf('\n', idx)
  if (nl === -1) return ''
  const after = block.slice(nl + 1)
  // Belt and braces: the callers already split on these, but a reader that
  // gains a fourth block type must not start eating the next message.
  const stop = after.search(/^(?:---|===)/m)
  return (stop === -1 ? after : after.slice(0, stop))
    .split('\n')
    .filter(l => !NOT_BODY.test(l.trim()))
    .join('\n')
    .trim()
}

const tsIn = (block: string) => block.match(/^Message[ _][Tt][Ss]:\s*([\d.]+)\s*$/m)?.[1] ?? ''

/** One `From:` / `Message TS:` / body block, whichever reader produced it. */
function parseMessageBlock(block: string, whoRaw?: string): SlackMessage | null {
  const ts = tsIn(block)
  if (!ts) return null
  const { who, whoId } = parseWho(whoRaw ?? block.match(/^From:\s*(.+)$/m)?.[1] ?? '')
  return { ts, epochMs: slackTsToMs(ts), who, whoId, text: bodyAfterTs(block) }
}

/* ------------------------------ search results ---------------------------- */

/**
 * Parse the Markdown block the Slack search tool returns.
 */
export function parseSlackResults(md: string): SlackHit[] {
  const out: SlackHit[] = []
  for (const block of md.split(/^###\s+Result\s+\d+\s+of\s+\d+\s*$/m).slice(1)) {
    const field = (re: RegExp) => block.match(re)?.[1]?.trim()

    const channelRaw = field(/^Channel:\s*(.+)$/m) ?? ''
    const channelId = channelRaw.match(/\(ID:\s*([A-Z0-9]+)\)/)?.[1] ?? ''
    const channelName = channelRaw.replace(/\s*\(ID:.*?\)\s*/, '').trim()

    const fromRaw = field(/^From:\s*(.+)$/m) ?? ''
    const { who, whoId } = parseWho(fromRaw)

    const ts = field(/^Message[ _][Tt][Ss]:\s*([\d.]+)$/m) ?? ''
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
      isDm: isDirectMessage({ channelId, channelName: channelRaw }),
      fromName: who,
      fromId: whoId,
      ts,
      epochMs: slackTsToMs(ts),
      permalink,
      text,
    })
  }
  return out
}

/* -------------------------------- thread read ----------------------------- */

const PARENT_HEADER = /^===\s*THREAD PARENT MESSAGE\s*===[ \t]*$/m
const REPLIES_HEADER = /^===\s*THREAD REPLIES\s*\((\d+)\s+total\)\s*===[ \t]*$/m
const REPLY_HEADER = /^---\s*Reply\s+\d+\s+of\s+\d+\s*---[ \t]*$/m

/**
 * Parse `slack_read_thread` — the one call that supplies, in a single answer,
 * everything a thread row needs: the parent's text (which search often never
 * returns, because he was named in a reply rather than in the parent), the
 * authoritative reply count, and every reply's author and body.
 */
export function parseThreadRead(md: string): SlackThreadRead {
  const empty: SlackThreadRead = { parent: null, replies: [], replyTotal: 0 }
  if (!md) return empty

  const repliesAt = md.search(REPLIES_HEADER)
  const replyTotal = Number(REPLIES_HEADER.exec(md)?.[1] ?? 0) || 0

  const parentStart = md.search(PARENT_HEADER)
  const parentBlock =
    parentStart === -1
      ? ''
      : md.slice(parentStart, repliesAt === -1 ? undefined : repliesAt)

  const repliesBlock = repliesAt === -1 ? '' : md.slice(repliesAt)
  const replies = repliesBlock
    .split(REPLY_HEADER)
    .slice(1)
    .map(b => parseMessageBlock(b))
    .filter((m): m is SlackMessage => !!m)

  return { parent: parseMessageBlock(parentBlock), replies, replyTotal }
}

/* -------------------------------- channel read ---------------------------- */

/**
 * `=== Message from Cursor <botuser-…@slack-bots.com> (U092446PCTV) at 2026-08-30 18:27:14 IST ===`
 *
 * The header is one line with the author, the address and the local time all
 * inside it, and it may carry a trailing space. The time is decoration here —
 * `Message TS:` on the next line is the fact — so the trailing ` at <when>` is
 * stripped off the author rather than parsed.
 */
const CHANNEL_MESSAGE_HEADER = /^===\s*Message from\s+(.+?)\s*===[ \t]*$/m
const AT_WHEN = /\s+at\s+\d{4}-\d{2}-\d{2}[ T][\d:]+(?:\s+\S+)?\s*$/

export function parseChannelRead(md: string, fallbackId = ''): SlackChannelRead {
  const head = md.match(/^Channel:\s*(#?[^\s(]+)\s*\(([A-Z0-9]+)\)/m)
  const channelId = head?.[2] ?? fallbackId
  const channelName = head?.[1] ?? (fallbackId ? fallbackId : '')

  // A capturing split hands back [preamble, author1, body1, author2, body2, …],
  // which is how the header's author survives being used as a separator.
  const parts = md.split(CHANNEL_MESSAGE_HEADER)
  const messages: SlackMessage[] = []
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const m = parseMessageBlock(parts[i + 1]!, (parts[i] ?? '').replace(AT_WHEN, ''))
    if (m) messages.push(m)
  }
  return { channelId, channelName, messages }
}

/* --------------------------------- identity ------------------------------- */

/**
 * The parent of the thread a hit belongs to.
 *
 * Proven uniform across 40 live rows: the permalink Slack returns carries
 * `?thread_ts=<parent>` on a reply *and* on a standalone message, where it
 * equals the message's own ts. So one rule covers both, and a row keyed on the
 * message's own ts — which is what shipped — puts a parent and each of its
 * replies on the desk as three separate pieces of work.
 *
 * A permalink Slack did not give us (a channel read has none) falls back to the
 * message's own ts, which is correct: a channel read returns top-level messages.
 */
export function parentTs(hit: { permalink?: string; ts: string }): string {
  const link = hit.permalink
  if (link) {
    try {
      const t = new URL(link).searchParams.get('thread_ts')
      if (t && /^\d+\.\d+$/.test(t)) return t
    } catch {
      /* not a URL we can read; the message's own ts is still true */
    }
  }
  return hit.ts
}

/**
 * A direct or group message, in one place.
 *
 * DMs are banned from the desk outright, and the ban is worth exactly one
 * function: three call sites each deciding what "DM" means is how one of them
 * ends up deciding it slightly differently. Three independent tells, because
 * each of the two readers and the search tool describes a DM its own way.
 *
 * The `#` check is load-bearing: a public channel arrives as `#dm-tools`, and a
 * name test without it would drop a real channel for starting with two letters.
 */
export function isDirectMessage(h: {
  channelId?: string | null
  channelName?: string | null
  isDm?: boolean
}): boolean {
  if (h.isDm === true) return true
  if ((h.channelId ?? '').startsWith('D')) return true
  const name = (h.channelName ?? '').trim()
  if (name.startsWith('#')) return false
  return /^(dm|mpim|group dm|multi[- ]person dm)\b/i.test(name)
}

/**
 * A channel read hands back no permalink at all, so build one. The workspace
 * host is not in the payload either; it is configuration, defaulting to the one
 * workspace this deployment is signed into.
 */
export function archiveLink(channelId: string, ts: string, host?: string): string {
  const base = host || `https://${SLACK_WORKSPACE}.slack.com`
  return `${base}/archives/${channelId}/p${ts.replace('.', '')}`
}

/** The `https://<workspace>.slack.com` origin a real permalink was minted from. */
export function hostOf(permalink: string): string | null {
  try {
    return new URL(permalink).origin
  } catch {
    return null
  }
}

/* --------------------------------- markup --------------------------------- */

/**
 * Slack's own markup, out. Exported because the search path in
 * `sources/search.ts` reads the same text and must normalise it the same way:
 * without it a Fetch row's title is `<@U09617LRRDF|Yuvraj Muley> can you look`,
 * which is the raw wire format sitting on the desk.
 */
export const clean = (t: string) =>
  t.replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1')
   .replace(/<!subteam\^([A-Z0-9]+)>/g, '@$1')
   .replace(/<@([A-Z0-9]+)\|([^>]+)>/g, '@$2')
   .replace(/<@([A-Z0-9]+)>/g, '@$1')
   .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
   .replace(/<(https?:\/\/[^>]+)>/g, '$1')
   .replace(/\s+/g, ' ')
   .trim()

/** Whether a message names him personally, in Slack's own markup. */
export const namesUser = (text: string, userId: string) =>
  !!userId && new RegExp(`<@${userId}(\\||>)`).test(text)

/**
 * Which of his usergroups a message pages, as the handle people read.
 *
 * `<!subteam^S06HDT77E1M|@truto-eng>` carries both halves; the id is what is
 * configured and the handle is what a row should say, so the text is the source
 * for the display name rather than a second config entry that can go stale.
 */
export function namesUsergroup(text: string, ids: readonly string[]): string | null {
  for (const id of ids) {
    const m = new RegExp(`<!subteam\\^${id}(?:\\|([^>]+))?>`).exec(text)
    if (m) return m[1] ?? `@${id}`
  }
  return null
}
