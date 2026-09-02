/**
 * What a row *is*, told three ways at once and with no new colours.
 *
 * Twenty rows used to be visually identical: a pull request, a Claude Code
 * session and a Sentry issue differed by the hue of one 7px dot — and a dot
 * cannot tell a PR from an issue at all, because both are GitHub. Meanwhile the
 * colour that dot spent was restated immediately below it as a text chip on its
 * own line, costing 30px on every row.
 *
 * So identity is three axes over the palette that already exists:
 *
 *   1. **The glyph is the kind.** A pull request and an issue are different
 *      marks; a conversation and a machine's page are different marks.
 *   2. **The colour is the source.** Same five hues, already theme-split.
 *   3. **The `Where` column is monospace**, and its texture differs by kind
 *      because the underlying data does: `trutohq/truto` is not `#eng-platform`
 *      is not `truto`.
 *
 * A fourth, on the row itself rather than here: a 2px left edge for state.
 */

import {
  BellRing, CircleDot, GitPullRequest, GitPullRequestArrow, Mail, MessageCircle, MessageSquare,
  SquareCheck, SquareTerminal, TriangleAlert, type LucideIcon,
} from 'lucide-react'
import type { Card, CardSource, SourceName } from '../lib/types'
import { bucketOf } from '../lib/bucket'
import { SOURCE_COLOR } from './sources'

export type Kind = {
  /** The word in the Kind column. Short enough to scan, long enough to mean something. */
  word: string
  Icon: LucideIcon
  /** Which source's hue the glyph takes — the *lead* source of the group. */
  source: SourceName
  /**
   * A hue that is not a source's, for the one row type that has no source.
   *
   * A task of his own arrives through no pipe, so `source` has no honest answer
   * for it and every value it could be given is a lie the Kind column would
   * paint in colour. This overrides the lookup rather than widening
   * `SourceName`, which is a union five other files switch exhaustively over —
   * a sixth member there would be six new unreachable branches to satisfy the
   * compiler and one real behaviour change.
   */
  tint?: string
}

const FALLBACK: Kind = { word: 'Item', Icon: CircleDot, source: 'github' }

/**
 * A task of his own, which is the one row on the desk that nobody sent.
 *
 * Neutral on purpose, and deliberately not the accent: the Tasks tab is the one
 * surface where *every* row is this kind, so a hue here would be 50 marks
 * carrying no information — and if it were amber it would be 50 marks in the
 * colour this product reserves for "this one". The word is the whole signal,
 * and on that tab even the word is a constant; where it earns its place is the
 * detail pane and the palette, where a task and a card sit in the same list.
 */
export const TASK_KIND: Kind = {
  word: 'Task',
  Icon: SquareCheck,
  source: 'claude',
  tint: 'var(--color-fg-dim)',
}

/**
 * The kind of one source's contribution.
 *
 * `card.kind` is the adapter's own word (`review`, `my_pr`, `assigned`,
 * `mention`, `thread`, `alert`, `email`, `error`, `session`), and for GitHub it
 * describes *why* rather than *what* — `assigned` is an issue or a pull request
 * depending on `meta.is_pr`. Both facts are already on the card.
 *
 * Slack splits three ways now. A person typed a thread, a monitor emitted an
 * alert, and a visitor on the website opened a Crisp conversation — three
 * different things want three different reactions from him. `Alert` and
 * Sentry's `Alert` share a word deliberately — they are the same event told by
 * two systems, and the dedup engine merges them into one row wherever it can
 * prove it.
 */
export function kindOf(source: SourceName, kind: string, meta: Record<string, any> = {}): Kind {
  switch (source) {
    case 'slack':
      if (kind === 'alert') return { word: 'Alert', Icon: BellRing, source }
      // A visitor talking to support through Crisp, relayed into Slack. Its
      // own word and its own glyph, same as a thread or an alert get — see
      // `crispMeta` for the one further wrinkle: an unresolved one overrides
      // both below, in `cardKind`.
      if (kind === 'crisp') return { word: 'Chat', Icon: MessageCircle, source }
      return { word: 'Thread', Icon: MessageSquare, source }
    case 'gmail':
      return { word: 'Mail', Icon: Mail, source }
    case 'sentry':
      return { word: 'Alert', Icon: TriangleAlert, source }
    case 'claude':
      return { word: 'Session', Icon: SquareTerminal, source }
    case 'github': {
      // A review request is its own thing: it is the only GitHub row where
      // somebody is blocked on him rather than the other way round, and the
      // glyph alone would need a legend nobody reads.
      if (kind === 'review') return { word: 'Review', Icon: GitPullRequestArrow, source }
      return meta.is_pr
        ? { word: 'PR', Icon: GitPullRequest, source }
        : { word: 'Issue', Icon: CircleDot, source }
    }
    default:
      return FALLBACK
  }
}

/**
 * The kind of a whole card, taken from the source that speaks for it — read as
 * the thing it *is* rather than as the pipe that carried it.
 *
 * `lead.source` was the wrong question here for the same reason it was the
 * wrong question in the tab strip. A `#sentry-alerts` row is minted
 * `source: 'slack'`, so `TRUTO-39 · Error` sat on the Sentry tab drawing a
 * Slack-coloured `BellRing`: the strip said Sentry, the mark said Slack, and
 * the row itself is an issue. One fact, claimed in two places, has to be
 * computed once — so the mark asks `bucketOf` too.
 *
 * `alerts` is not a real source and `kindOf` does not know the word — it
 * speaks in pipe names, on purpose, so a unit test can call it with a literal
 * `SourceName` and mean something. Every row on the Alerts tab draws as
 * `sentry` would regardless of which monitor or which channel actually
 * carried it, which is the whole ruling read as a colour: a Datadog page and a
 * Sentry issue are one kind of thing now, and one kind of thing does not
 * finish the sentence with two different glyphs.
 *
 * Only the *identity* moves. `card.meta` and the lead's own meta are still what
 * they were, because they are the row's facts and the row really did arrive
 * through Slack; `whereOf` still answers `sentry-alerts` from them, which is
 * where it came from and is not in conflict with what it is.
 */
export function cardKind(card: Card): Kind {
  // A task of his own, before anything asks which pipe carried it — nothing
  // did. See `lib/taskRow.ts`: the row has no members at all, so the lookup
  // below would answer `Item` in GitHub's blue for every row on the Tasks tab.
  if (card.kind === 'task' && !card.sources.length) return TASK_KIND
  const lead = card.sources[0]
  if (!lead) return kindOf('github', card.kind, card.meta)
  const bucket = bucketOf(lead)
  const meta = { ...lead.meta, ...card.meta }
  const kind = bucket === 'alerts'
    ? kindOf('sentry', card.kind || lead.kind, meta)
    : kindOf(bucket, card.kind || lead.kind, meta)

  // A visitor still waiting spends none of the amber accent and all of the
  // urgency: the glyph keeps its shape — this is still a `Chat` — and borrows
  // `--color-bad` the way `tint` already does for `TASK_KIND`, and the word
  // itself becomes the state rather than the kind, the one place on a row
  // where a kind word is allowed to say that instead.
  const crisp = crispMeta(card)
  if (crisp?.unresolved) return { ...kind, word: 'waiting', tint: 'var(--color-bad)' }
  return kind
}

/**
 * A Crisp conversation's own state, or `null` for every card that is not one.
 *
 * Read off the lead member rather than `card.kind` alone, because a merged
 * card's own `kind` is whichever member's the dedup engine kept, and a Crisp
 * row is identified the same way a Sentry one is — by what it says about
 * itself, not by guessing from prose. `reply_total` defaults to 0 rather than
 * going unprinted, because "waiting, 0 replies" is the honest answer for a
 * visitor's opening message and a banner with no number reads as broken.
 */
export function crispMeta(card: Card): { unresolved: boolean; replies: number } | null {
  const lead = card.sources[0]
  if (!lead || lead.source !== 'slack') return null
  if (card.kind !== 'crisp' && lead.kind !== 'crisp') return null
  const meta = { ...lead.meta, ...card.meta }
  return {
    unresolved: meta.crisp_state === 'unresolved',
    replies: typeof meta.reply_total === 'number' ? meta.reply_total : 0,
  }
}

/** The glyph, in its source's hue. Sized for a row (16px) or a pane (14px). */
export function KindGlyph({ kind, size = 16 }: { kind: Kind; size?: number }) {
  const { Icon } = kind
  return (
    <Icon size={size} strokeWidth={1.8} aria-hidden
      style={{ color: kind.tint ?? SOURCE_COLOR[kind.source] }} />
  )
}

/**
 * One mark per source, from the same set the Kind column draws from.
 *
 * A source's rows can be more than one kind — GitHub is a pull request, an issue
 * and a review request — so this names the one that stands for the whole source:
 * whichever mark the eye has already learned from the rows. Nothing new is
 * invented, which is the point. A second vocabulary for the same five things
 * would be a legend to memorise.
 */
export const SOURCE_GLYPH: Record<SourceName, LucideIcon> = {
  slack: MessageSquare,
  gmail: Mail,
  github: GitPullRequest,
  sentry: TriangleAlert,
  claude: SquareTerminal,
}

/**
 * A source, identified without a word.
 *
 * The filter row's chips carried a 6px dot and their name on `title`, and a
 * phone has no hover: five coloured dots that are only distinguishable once you
 * have tapped one. The mark says which source before it is read, and the failed
 * state is the same mark at a quarter weight, with the reason still on `title` —
 * present, legible as a source, and visibly not answering.
 */
export function SourceMark({
  source, failed, size = 14,
}: { source: SourceName; failed?: boolean; size?: number }) {
  const Icon = SOURCE_GLYPH[source]
  return (
    <Icon
      size={size}
      strokeWidth={1.8}
      className={`shrink-0 ${failed ? 'opacity-40' : ''}`}
      style={{ color: SOURCE_COLOR[source] }}
      aria-hidden
    />
  )
}

/* -------------------------------- channels -------------------------------- */

/**
 * The workspace's own name, which every shared channel is named after twice.
 *
 * Shared channels get the convention `<partner>-<workspace>`, and internal ones
 * get `<workspace>-<topic>`, so on a desk read entirely from one workspace the
 * token `truto` is on most rows and identifies none of them. It is the column's
 * background, printed.
 */
const WORKSPACE = 'truto'

/**
 * A channel name with the part that is on every row taken out.
 *
 * `#truto-15-5-truto` is the worst case and it is real: the workspace token at
 * both ends, wrapping two characters of actual information. `#spendflo-truto`
 * and `#truto-api-alerts` each carry it at one end. What is left is what tells
 * one row from another.
 *
 * The guard is `tokens.length > 1`: `#truto` itself strips to nothing, and a
 * blank is worse than a redundant word, so a name made only of the workspace
 * token survives whole.
 *
 * **Display only.** The stored `channel_id` is the identity — it is what the
 * `slack://` link and the permalink are built from — and it is never rewritten.
 * Two different channels can clean to the same label and that is fine; the
 * label is not what anything is keyed on.
 */
export function cleanChannel(raw: string): string {
  const tokens = String(raw)
    .replace(/^#+/, '')
    // A channel read out of a rendered line sometimes trails the id it was
    // resolved from — `#sentry-alerts (ID: C0BERTMS9K4)`. The id is worth
    // keeping; it is not worth showing.
    .replace(/\s*\(ID:\s*[A-Z0-9]+\)\s*$/i, '')
    .trim()
    .toLowerCase()
    .split('-')

  while (tokens.length > 1 && tokens[0] === WORKSPACE) tokens.shift()
  while (tokens.length > 1 && tokens[tokens.length - 1] === WORKSPACE) tokens.pop()
  return tokens.join('-')
}

/* --------------------------------- where ---------------------------------- */

/**
 * The context a row belongs to, in the vocabulary its own system uses.
 *
 * Rendered in mono, which is the point: `trutohq/truto`, `eng-platform` and
 * `truto` look different before they are read, and that difference is free —
 * the data already had it.
 */
export function whereOf(source: CardSource | undefined, card: Card): string | null {
  const m = { ...(source?.meta ?? {}), ...card.meta }
  switch (source?.source) {
    case 'slack':
      return m.channel ? cleanChannel(String(m.channel)) : null
    case 'gmail':
      return (source.account ?? m.account) || null
    case 'github':
      return m.repo || null
    case 'sentry':
      return m.project || null
    case 'claude':
      return m.project || null
    default:
      return null
  }
}

/**
 * The half of a context that differs, with a capital on it.
 *
 * `trutohq/truto-app` is one repository among many under one owner, and
 * `yuvraj@truto.one` is one mailbox on one domain — in both, the part before
 * the separator is the same on every row that has one, which is exactly what
 * `cleanChannel` already takes out of a channel name. The capital is the whole
 * of "human": `spendflo` is a slug and `Spendflo` is a customer. A name that
 * starts with a digit — `15five` — is left as it is, because `'1'.toUpperCase()`
 * is `'1'` and there is nothing to do.
 */
const shortName = (v: string) => {
  const tail = v.split('/').pop()!.split('@')[0]!
  return tail.charAt(0).toUpperCase() + tail.slice(1)
}

/* ---------------------------------- mail ---------------------------------- */

/**
 * Hosts that carry mail rather than send it.
 *
 * `gmail.com` is the mailbox a person happens to keep, in exactly the way
 * `truto` is the workspace every channel is named after: on a row it is the
 * column's background, printed. Worse than redundant, it would be untrue —
 * Gmail did not send the mail, a person did — so these answer with nothing and
 * whatever display name the envelope carried speaks on its own.
 */
const MAILBOX_HOSTS = new Set([
  'gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'msn',
  'yahoo', 'ymail', 'icloud', 'me', 'mac', 'aol',
  'proton', 'protonmail', 'gmx', 'zoho', 'fastmail',
])

/**
 * Labels a registry owns rather than a company: the `co` of `co.uk`.
 *
 * There is no public-suffix list in this bundle and there must not be — it is a
 * megabyte to answer a question this file asks about four domains. The rule
 * below wants the label in front of the suffix, and the suffix is two labels
 * deep on exactly these, so this is the whole of the correction.
 */
const REGISTRY_LABELS = new Set(['co', 'com', 'net', 'org', 'edu', 'gov', 'ac', 'or', 'ne'])

/**
 * The organisation behind an address, from its domain.
 *
 * A sending organisation is carried by its domain far better than by the local
 * part: `noreply`, `notify` and `support` are the same three words on everyone's
 * mail, while `md.getsentry.com`, `mail.notion.so` and `mailer.truto.one` each
 * name a company. Taking the registrable label — the one in front of the public
 * suffix — throws the transport subdomain away for free, which is most of what
 * an envelope address is made of.
 *
 * `get<brand>` is undone because it is a convention rather than a name:
 * `getsentry.com` is Sentry's own domain and `getharvest.com` is Harvest's,
 * which is what a company does when it never owned `<brand>.com`. The tail has
 * to be a word in its own right — four letters — or `getty` reads as `ty`. It is
 * not free, and the cost is worth stating: `getaround.com` and `getresponse.com`
 * are brands whose *own* name begins with those three letters, and they come out
 * as `Around` and `Response`. Both are still a label a person can read, which is
 * more than the address they replace was.
 */
export function senderOrg(address: string): string | null {
  const host = address.split('@').pop()!.trim().toLowerCase().replace(/[.>]+$/, '')
  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2) return null

  let i = labels.length - 2
  if (i > 0 && REGISTRY_LABELS.has(labels[i]!)) i -= 1

  let name = labels[i]!
  if (MAILBOX_HOSTS.has(name)) return null
  if (/^get[a-z]{4,}$/.test(name)) name = name.slice(3)

  // One capitalisation rule for the whole column: `spendflo` is a slug and
  // `Spendflo` is a customer, and `shortName` is where that is decided.
  return shortName(name)
}

/**
 * An address rather than a name.
 *
 * Not `includes('@')`, which is the obvious version and is wrong on a real
 * display name: `Sales @ Acme` is a person's own words and would be thrown away
 * for a domain it does not have. An address has no spaces and its domain has a
 * dot, and both halves of that are needed — the space rules the display name
 * back in, and the dot is what makes `senderOrg` have something to answer with.
 */
const looksLikeAddress = (v: string) => /^\S+@\S+\.\S+$/.test(v)

/**
 * Who a mail row is from, in words.
 *
 * The Gmail adapter writes `nameOf(sender)` into both `actor` and `who`, and
 * `nameOf` falls back to the bare address when the envelope carried no display
 * name — so an address arriving here is not somebody's name, it is the *absence*
 * of one, and that is the whole of the signal needed to tell the two apart.
 *
 * A display name is the honest answer and is returned untouched. An address is
 * not an answer at all: it is the essay this column exists to not print, and it
 * clips from the wrong end, so it is replaced by the organisation its domain
 * names. Where the domain names nothing worth saying — a personal mailbox host —
 * the line is empty, which is what "we do not know who sent this" looks like.
 * His own mailbox is never the answer; it is on every one of them.
 */
export function mailFrom(who: string | null): string | null {
  if (!who) return null
  return looksLikeAddress(who) ? senderOrg(who) : who
}

/**
 * Who this row is about, or null when nobody is.
 *
 * `who` is the person waiting on him and it is the right answer whenever there
 * is one. The fallback to `actor` is where this got interesting, because it used
 * to be general and `actor` is not: it is whatever the source calls the thing
 * that produced the row, and exactly one source puts a *person* there that `who`
 * might have missed.
 *
 *   * **Slack** is the one that can: its `actor` is the thread's parent author,
 *     who is a person, so a group whose card-level `who` did not survive the
 *     merge still has one sitting beside it. That is the path `15five — Roopi`
 *     takes. Not on an alert, though: there the actor is the bot that posted it,
 *     and `Sentry-alerts — Sentry` is the row telling him the same thing twice
 *     and calling a monitor a person. And one case is still wrong and cannot be
 *     fixed here — a thread *he* started that never named him writes
 *     `who: undefined` precisely because the author is him, and nothing in the
 *     browser knows which of the five names on the desk is his. That belongs on
 *     the server, where `me` actually is.
 *   * **Sentry** puts a project slug there, and its own adapter says why in as
 *     many words: nobody is waiting on a Sentry issue, it is waiting on him.
 *     Fallen back to, it printed `Truto-api — truto-api` — one fact, twice, in
 *     two capitalisations, in a 132px cell.
 *   * **GitHub** fills `who` itself and leaves it empty *precisely when the
 *     author is him*, so on `is:pr author:me` the fallback answered "who is
 *     waiting on me" with his own login.
 *   * **Gmail** and **Claude Code** lose nothing by being excluded: mail's actor
 *     is byte-identical to its `who`, and a session has no actor at all.
 *
 * So the fallback belongs to a Slack conversation and to nothing else. It is
 * asked of `bucketOf` rather than of `lead.source` for the reason `cardKind` is:
 * a Sentry issue that arrived through `#sentry-alerts` is a Sentry row.
 */
export function waitingOn(card: Card): string | null {
  if (card.who) return card.who
  const lead = card.sources[0]
  if (!lead) return null
  if (bucketOf(lead) !== 'slack') return null
  if (card.kind === 'alert' || lead.kind === 'alert') return null
  return card.actor ?? lead.actor ?? null
}

/**
 * `customer — who`, which is what a row is at a glance on a phone.
 *
 * The phone had no channel column and no person column, so a row from
 * `#15five-truto` said neither which customer it belonged to nor who was waiting
 * on him — the two facts that decide whether a message is opened at 7am. It also
 * cannot afford `#truto-15-5-truto` or `trutohq/truto-app`: this is one 132px
 * cell, and a string that truncates carries less than a shorter true one.
 *
 * So: the context in its own system's vocabulary, shortened to the part that
 * differs, paired with the person. Slack answers with the channel, GitHub with
 * the repository, Sentry and Claude with the project, because `whereOf` already
 * answers for all four. Either half may be missing and the line is then just the
 * other one; both missing is `null`, and the cell decides what nothing looks
 * like.
 *
 * **Mail is the exception, and it earned one on the live desk.** `whereOf`
 * answers a Gmail row with the mailbox it landed in, and the mailbox is his own
 * address — the same word on all twenty-nine of them, so the half of the line
 * that is supposed to name a customer named nobody, while the half beside it was
 * a raw envelope address clipped from the wrong end. Four real rows read
 * `Yuvraj — noreply@md.get…`, `Yuvraj — notify@mail.notio…`, and so on: 132px
 * spent saying his own name and a prefix. A mail row says who sent it instead —
 * see `mailFrom` — and there is no customer half to pair it with, because the
 * only address on a mail card is the sender's own and it is spent naming them.
 */
export function contextLine(card: Card): string | null {
  const lead = card.sources[0]
  const who = waitingOn(card)

  // `bucketOf`, not `lead.source`, for the reason `cardKind` asks it: the line
  // and the glyph beside it have to be answering about the same row.
  if (lead && bucketOf(lead) === 'gmail') {
    // The group's own `who` first — on a merged card that is the better answer —
    // then the mail member's, which is where a sender actually lives.
    return mailFrom(who ?? lead.who ?? lead.actor ?? null)
  }

  const where = whereOf(lead, card)
  const customer = where ? shortName(where) : null
  if (customer && who) return `${customer} — ${who}`
  return customer ?? who ?? null
}

/**
 * Truncate from the head, not the tail.
 *
 * `trutohq/truto-app` cut from the right is `trutohq/tru…`, which is the half
 * that is the same on every row. Cut from the left it is `…/truto-app`, which is
 * the half that differs.
 *
 * The budget is characters, and it has to match the column's real width or CSS
 * truncates the result a second time and cuts it at *both* ends — which is
 * exactly what `…endflo-tru…` on the live page was. Mono at 13px advances 0.6em,
 * so the 112px column with its 16px trailing pad holds twelve.
 */
export function headTruncate(v: string, max: number): string {
  return v.length <= max ? v : `…${v.slice(-(max - 1))}`
}
