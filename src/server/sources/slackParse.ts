/**
 * The one shape mcp.slack.com answers with that `slack.ts` does not already read.
 *
 * Slack's MCP does not return JSON, and it does not return *one* format either:
 * search results, channel history and thread reads are three different
 * Markdown-ish blocks. Two of the three live next door in `slack.ts` —
 * `parseSlackResults` and `parseChannelMessages` — because that file is where
 * the queries that produce them are asked. This file holds the third, the thread
 * read, plus the two identity questions that only a thread makes sense of.
 *
 * Every regex here is written against a payload captured live on 2026-08-30 (see
 * `FIXTURES.md`) rather than against a schema somebody documented. Three details
 * cost real bugs and are worth stating once:
 *
 *   1. The search tool spells the timestamp `Message_ts:` and the thread and
 *      channel readers spell it `Message TS:`. Both are handled here, because
 *      "which tool produced this text" is not a question a parser should have to
 *      ask.
 *   2. A message body is taken by index, not by a `/m`-flagged regex. With `/m` a
 *      `$` terminator matches the end of the first *line*, which silently
 *      truncates every multi-line message to its opening sentence.
 *   3. Every field is optional-safe. A missing one degrades to a usable row; it
 *      never throws away the whole poll.
 */

/* ------------------------------- timestamps ------------------------------- */

/**
 * A Slack ts is "<epoch seconds>.<6 digits>", where the fraction is a sequence
 * number rather than real sub-second time. Parsing it as a float introduces a
 * rounding error, so take the first three digits as milliseconds directly.
 *
 * It lives here rather than in `slack.ts` — which re-exports it, and is where
 * everything else in the product still imports it from — for one mechanical
 * reason: `slack.ts` imports this module, so a copy in each would be two
 * implementations of one rule and an import the other way would be a cycle.
 */
export function slackTsToMs(ts: string): number {
  if (!ts) return Date.now()
  const [secs, frac = ''] = ts.split('.')
  const ms = Number(frac.slice(0, 3).padEnd(3, '0'))
  return Number(secs) * 1000 + (Number.isFinite(ms) ? ms : 0)
}

/* --------------------------------- messages ------------------------------- */

/** One message inside a thread, as the reader describes it. */
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

/**
 * `From: Nidhi <nidhi@truto.one> (U0BBZV4HQHH)` in the readers, and
 * `From: Nidhi <nidhi@truto.one> (ID: U0BBZV4HQHH)` in search. The email is
 * optional; the parenthesised id may carry the `ID:` prefix or not.
 */
function parseWho(raw: string): { who: string; whoId: string } {
  /*
   * A guest from another workspace carries more inside the parentheses than an
   * id: `rameshsutaliya (U09038ZHE3H, external: spendflo)`. The id pattern
   * closed on `)`, so it matched nothing there and the strip left the whole
   * parenthetical in place — which is how `Varad (U08HCR8KXQB, external:` came
   * to be the Who column, the From row and the author of every line in the
   * thread list on a customer channel. Both halves stop at the id and drop
   * whatever else Slack chose to put beside it.
   */
  const whoId = raw.match(/\((?:ID:\s*)?([UWB][A-Z0-9]+)[,)]/)?.[1] ?? ''
  const who = raw
    .replace(/\s*<[^>]*>\s*/, ' ')
    .replace(/\s*\((?:ID:\s*)?[A-Z0-9]+[^)]*\)\s*/, ' ')
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
  // Belt and braces: the caller already split on these, but a reader that gains
  // a third block type must not start eating the next message.
  const stop = after.search(/^(?:---|===)/m)
  return (stop === -1 ? after : after.slice(0, stop))
    .split('\n')
    .filter(l => !NOT_BODY.test(l.trim()))
    .join('\n')
    .trim()
}

const tsIn = (block: string) => block.match(/^Message[ _][Tt][Ss]:\s*([\d.]+)\s*$/m)?.[1] ?? ''

/** One `From:` / `Message TS:` / body block. */
function parseMessageBlock(block: string, whoRaw?: string): SlackMessage | null {
  const ts = tsIn(block)
  if (!ts) return null
  const { who, whoId } = parseWho(whoRaw ?? block.match(/^From:\s*(.+)$/m)?.[1] ?? '')
  return { ts, epochMs: slackTsToMs(ts), who, whoId, text: bodyAfterTs(block) }
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
 *
 * It is not `parseSlackResults` with a different separator. That parser splits
 * on `### Result N of M`, which appears nowhere in this payload — pointed at a
 * thread read it returns an empty array, silently, which is exactly what the
 * shipped `readThread` was doing.
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
 * Whether a message names him personally, in Slack's own markup.
 *
 * Decided on the raw text, before `clean` turns `<@U09617LRRDF|Yuvraj Muley>`
 * into `@Yuvraj Muley`. Once the markup is gone the id is gone with it, and "is
 * this on me" would be a string match on a display name anybody can change.
 */
export const namesUser = (text: string, userId: string) =>
  !!userId && new RegExp(`<@${userId}(\\||>)`).test(text)
