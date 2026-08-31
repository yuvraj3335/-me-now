/**
 * One Slack message, in the one shape everything downstream of the poll wants.
 *
 * A Desk Slack row is a thread *parent*, and the replies under it are usually
 * where the work actually is. Wake already reads those replies on every poll and
 * stores them on the card (`meta.parent` and `meta.thread` — see
 * `buildThreadCard` in `src/server/sources/slack.ts`), so the sheet that writes a
 * brief does not need a network call to offer them; it needs them in a shape
 * that carries, per message:
 *
 *   * enough to build a `slack://` link **to that message** — a team, a channel
 *     and the message's own `ts`, because `slack://channel` missing any of the
 *     three opens Slack on whatever was last shown, which looks exactly like a
 *     link that worked;
 *   * enough to become a `PackItem` — a `kind` and a `ref` that is stable and
 *     unique per message.
 *
 * It lives in `src/shared/` for the same mechanical reason `sessionRepo.ts`
 * does: the server mints these out of stored cards and the browser parses a
 * pasted link into one, and two implementations of one shape is how the two
 * halves come to disagree about what a Slack message is.
 */

/* ------------------------------- timestamps ------------------------------- */

/**
 * A Slack ts is "<epoch seconds>.<6 digits>", where the fraction is a sequence
 * number rather than real sub-second time. Parsing it as a float introduces a
 * rounding error, so take the first three digits as milliseconds directly.
 *
 * This is the original from `sources/slackParse.ts`, moved here unchanged —
 * that module now imports it — because the pasted-link parser needs it and
 * `src/shared/` may not import from `src/server/`. Its "no ts is now" fallback
 * is preserved exactly: it is what the thread and channel parsers have always
 * done with a message whose header was unreadable.
 */
export function slackTsToMs(ts: string): number {
  if (!ts) return Date.now()
  const [secs, frac = ''] = ts.split('.')
  const ms = Number(frac.slice(0, 3).padEnd(3, '0'))
  return Number(secs) * 1000 + (Number.isFinite(ms) ? ms : 0)
}

/**
 * The same conversion, refusing to guess.
 *
 * `slackTsToMs` answers `Date.now()` for a ts it cannot read, which is right
 * inside a parser — a message with an unreadable header is still a message and
 * the poll must not lose the whole thread over it. It is wrong on the wire: a
 * rendered time of "just now" on a message from March is a fact the reader has
 * no way to doubt. So anything this cannot read is `null`, and the UI renders
 * nothing.
 */
export function slackTsMs(ts: unknown): number | null {
  if (typeof ts !== 'string' || !/^\d+(\.\d+)?$/.test(ts)) return null
  const [secs, frac = ''] = ts.split('.')
  return Number(secs) * 1000 + Number(frac.slice(0, 3).padEnd(3, '0'))
}

/* -------------------------------- identity -------------------------------- */

/**
 * A direct message, on the tell the adapter has always used.
 *
 * The refusal that matters lives in `bucketHits` (`sources/slack.ts`): a hit in
 * a `D…` conversation never becomes a bucket, so it never becomes a card, so
 * nothing served out of stored cards can be one. This is the same rule written
 * once so that `bucketHits`, the route that reads cards back out, and the
 * pasted-link parser cannot drift — a pasted `…/archives/D0…/p…` is exactly the
 * way somebody would route around a refusal that only existed at ingest.
 */
export const isDmChannel = (channelId: string | null | undefined): boolean =>
  !!channelId && /^D/i.test(channelId)

/** A bot author. Slack ids are `U…` for a person, `W…` for a guest, `B…` for a bot. */
export const isBotAuthor = (whoId: string | null | undefined): boolean =>
  !!whoId && /^B/.test(whoId)

/* --------------------------------- links ---------------------------------- */

/** The workspace archive this deployment mints links against when it knows none. */
const DEFAULT_ORIGIN = 'https://truto.slack.com'

/**
 * The durable, shareable https form.
 *
 * Byte-compatible with what `parseChannelMessages` and `buildThreadCard` mint,
 * and therefore with `SLACK_ARCHIVE` in `src/server/dedup.ts`, which parses a
 * thread reference back out of one. `thread_ts` is appended when the message is
 * a reply, because that is what Slack's own permalinks carry and what
 * `parentTs` reads to decide which conversation a message belongs to.
 */
export function slackArchiveUrl(o: {
  channelId: string
  ts: string
  threadTs?: string | null
  origin?: string | null
}): string {
  const base = `${o.origin || DEFAULT_ORIGIN}/archives/${o.channelId}/p${o.ts.replace('.', '')}`
  return o.threadTs && o.threadTs !== o.ts ? `${base}?thread_ts=${o.threadTs}` : base
}

/**
 * The link the desktop and phone apps register, pointed at ONE message.
 *
 * The same string `slackAppUrl` in `src/web/lib/appLinks.ts` builds, and
 * deliberately the same rule about what is optional: `message` may be absent and
 * the app then opens the channel, but team and channel may not — with either
 * missing, Slack opens on whatever was last shown, which is indistinguishable
 * from a link that worked. So a missing team is `null` here rather than a
 * plausible URL.
 *
 * `message` is the message's *own* ts, never the parent's. A reply's app link
 * that lands on the parent is a link to the wrong thing said three messages ago.
 */
export function slackAppLink(o: {
  teamId: string | null | undefined
  channelId: string | null | undefined
  ts?: string | null
}): string | null {
  if (!o.teamId || !o.channelId) return null
  return `slack://channel?team=${o.teamId}&id=${o.channelId}${o.ts ? `&message=${o.ts}` : ''}`
}

/* --------------------------------- entries -------------------------------- */

/**
 * One message a brief can carry.
 *
 * `kind` and `ref` are the two fields `PackItem` needs, filled here rather than
 * at the call site: `ref` is `<channel>:<ts>`, which is what
 * `refFor` in `src/web/lib/cardContext.ts` already mints for a whole Slack card
 * (`channel_id:thread_ts`). So the parent's ref out of this route and the card's
 * own ref are the same string, and `openLaunch`'s duplicate collapse works
 * without knowing that these two things are related.
 */
export type SlackThreadItem = {
  /** A `SlotKind` from `src/web/lib/launch.ts`. Always `'slack'`. */
  kind: 'slack'
  /** `<channel_id>:<ts>` — unique per message, stable, and a `PackItem.ref`. */
  ref: string
  /** The Slack ts string, e.g. `1787814333.427979`. Not epoch ms. */
  ts: string
  /** Epoch ms, or null when the ts was unreadable. */
  at: number | null
  who: string | null
  who_id: string | null
  bot: boolean
  /** Already cleaned and capped by the poll. `''` when the message had no words. */
  excerpt: string
  /** This message names the operator personally. */
  tagged: boolean
  /** The operator wrote it. Kept, not hidden — his own words are context too. */
  mine: boolean
  /** This is the thread parent. */
  parent: boolean
  channel: string | null
  channel_id: string
  team_id: string | null
  /** The parent this message hangs off, when one is known. */
  thread_ts: string | null
  url: string
  /** `slack://…&message=<this message's ts>`, or null with no team. */
  app_url: string | null
}

/** The stored shape one of these is built from — `ThreadEntry` in `sources/slack.ts`. */
export type StoredThreadEntry = {
  ts: string
  who?: string | null
  who_id?: string | null
  text?: string | null
  tagged?: boolean
  mine?: boolean
}

/**
 * A stored entry, as one item. Pure: every field is copied or computed, and
 * nothing here reads a network or a clock.
 */
export function itemFromEntry(
  e: StoredThreadEntry,
  ctx: {
    channelId: string
    channel?: string | null
    teamId?: string | null
    threadTs?: string | null
    origin?: string | null
    parent?: boolean
  },
): SlackThreadItem {
  const teamId = ctx.teamId ?? null
  return {
    kind: 'slack',
    ref: `${ctx.channelId}:${e.ts}`,
    ts: e.ts,
    at: slackTsMs(e.ts),
    who: e.who || null,
    who_id: e.who_id || null,
    bot: isBotAuthor(e.who_id),
    excerpt: e.text ?? '',
    tagged: !!e.tagged,
    mine: !!e.mine,
    parent: !!ctx.parent,
    channel: ctx.channel || null,
    channel_id: ctx.channelId,
    team_id: teamId,
    thread_ts: ctx.threadTs ?? null,
    url: slackArchiveUrl({
      channelId: ctx.channelId, ts: e.ts, threadTs: ctx.threadTs, origin: ctx.origin,
    }),
    // The message's own ts, so the app lands on the reply he picked.
    app_url: slackAppLink({ teamId, channelId: ctx.channelId, ts: e.ts }),
  }
}

/* ------------------------------ pasted links ------------------------------ */

export type SlackLinkResult =
  | { ok: true; item: SlackThreadItem }
  | { ok: false; reason: string }

/**
 * The archive form, in the same shape `SLACK_ARCHIVE` in `src/server/dedup.ts`
 * reads it: ten digits of epoch seconds and six of Slack's uniqueness tail.
 * Deliberately as strict as that one — a looser digit count would happily read
 * `p17878124` as a timestamp in 1970 and hand back a link to nothing.
 */
const ARCHIVE = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})\b/i

/** `1787812499720579` or `1787812499.720579`, from a `slack://` `message` param. */
const APP_TS = /^(\d{10})\.?(\d{6})$/

const RE_TS = /^\d{10}\.\d{6}$/

/**
 * A Slack URL somebody pasted, as the same item shape the card route returns.
 *
 * Both real formats, because both are real in this product: the https archive
 * link is what a card's `url` is and what a person copies out of Slack, and the
 * `slack://` link is what `slackAppUrl` mints and what the desktop app puts on
 * the clipboard from "Copy link" on some platforms.
 *
 * Three refusals, each with a sentence a person can read:
 *
 *   * **A direct message.** `bucketHits` throws DMs away before they can become
 *     a card, and a pasted link is exactly the door that refusal does not cover
 *     on its own — so the same `isDmChannel` predicate is applied here.
 *   * **A channel with no message.** `slack://channel?team=…&id=…` names a place,
 *     not something somebody said. Silently accepting it would put an item in a
 *     brief that quotes nothing.
 *   * **Anything else.** Including a Slack link shape nobody has seen yet: a
 *     guess is worse than a refusal you can read.
 *
 * `opts.teamId` supplies the workspace for the https form, which does not carry
 * one. Without it the item is still valid and `app_url` is null — see
 * `slackAppLink` for why that is null rather than a plausible URL.
 */
export function parseSlackLink(
  input: string,
  opts: { teamId?: string | null } = {},
): SlackLinkResult {
  const raw = (input ?? '').trim()
  if (!raw) return { ok: false, reason: 'paste a Slack message link' }

  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'that is not a link' }
  }

  if (u.protocol === 'slack:') return fromAppLink(u)
  if (u.protocol === 'https:' || u.protocol === 'http:') return fromArchiveLink(u, opts.teamId ?? null)
  return { ok: false, reason: 'that is not a Slack message link' }
}

/** `slack://channel?team=T…&id=C…&message=1787812499.720579` */
function fromAppLink(u: URL): SlackLinkResult {
  // `new URL('slack://channel?…')` puts `channel` in `host` on some engines and
  // in `pathname` on others, because the scheme is not special-cased. Accept
  // either rather than pinning one and going quiet the day it moves.
  const what = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase()
  if (what && what !== 'channel') return { ok: false, reason: 'that Slack link does not name a channel' }

  const channelId = u.searchParams.get('id') ?? ''
  if (!channelId) return { ok: false, reason: 'that Slack link names no channel' }
  if (isDmChannel(channelId)) return { ok: false, reason: 'Wake does not carry direct messages' }

  const teamId = u.searchParams.get('team')
  // `message` is what the app writes; `message_ts` is what a couple of older
  // integrations write for the same thing.
  const rawTs = u.searchParams.get('message') ?? u.searchParams.get('message_ts') ?? ''
  const m = APP_TS.exec(rawTs)
  if (!m) {
    return {
      ok: false,
      reason: 'that link opens a channel rather than a message — open the message and copy its link',
    }
  }
  const ts = `${m[1]}.${m[2]}`

  const threadRaw = u.searchParams.get('thread_ts') ?? ''
  const threadTs = RE_TS.test(threadRaw) ? threadRaw : ts

  return {
    ok: true,
    item: itemFromEntry(
      { ts, who: null, who_id: null, text: '' },
      { channelId, teamId, threadTs, parent: threadTs === ts },
    ),
  }
}

/** `https://<workspace>.slack.com/archives/C…/p1787812499720579[?thread_ts=…]` */
function fromArchiveLink(u: URL, teamId: string | null): SlackLinkResult {
  if (!/(^|\.)slack\.com$/i.test(u.hostname)) {
    return { ok: false, reason: 'that is not a Slack link' }
  }
  const m = ARCHIVE.exec(u.pathname)
  if (!m) {
    return { ok: false, reason: 'that Slack link does not point at a message' }
  }
  // `cid` is what Slack puts on a permalink it minted; the path is what a
  // hand-typed one has. They agree when both are there.
  const channelId = (u.searchParams.get('cid') || m[1]!).toUpperCase()
  if (isDmChannel(channelId)) return { ok: false, reason: 'Wake does not carry direct messages' }

  const ts = `${m[2]}.${m[3]}`
  const threadRaw = u.searchParams.get('thread_ts') ?? ''
  // The same rule as `parentTs`: a permalink's `thread_ts` is the conversation
  // this message belongs to, and a message without one is its own parent.
  const threadTs = RE_TS.test(threadRaw) ? threadRaw : ts

  return {
    ok: true,
    item: itemFromEntry(
      { ts, who: null, who_id: null, text: '' },
      { channelId, teamId, threadTs, origin: u.origin, parent: threadTs === ts },
    ),
  }
}
