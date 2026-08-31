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
  BellRing, CircleDot, GitPullRequest, GitPullRequestArrow, Mail, MessageSquare,
  SquareTerminal, TriangleAlert, type LucideIcon,
} from 'lucide-react'
import type { Card, CardSource, SourceName } from '../lib/types'
import { SOURCE_COLOR } from './sources'

export type Kind = {
  /** The word in the Kind column. Short enough to scan, long enough to mean something. */
  word: string
  Icon: LucideIcon
  /** Which source's hue the glyph takes — the *lead* source of the group. */
  source: SourceName
}

const FALLBACK: Kind = { word: 'Item', Icon: CircleDot, source: 'github' }

/**
 * The kind of one source's contribution.
 *
 * `card.kind` is the adapter's own word (`review`, `my_pr`, `assigned`,
 * `mention`, `thread`, `alert`, `email`, `error`, `session`), and for GitHub it
 * describes *why* rather than *what* — `assigned` is an issue or a pull request
 * depending on `meta.is_pr`. Both facts are already on the card.
 *
 * Slack splits two ways now, and the split is the point of reading the alert
 * channels at all: a person typed the one, a monitor emitted the other, and
 * they want different things from him. `Alert` and Sentry's `Alert` share a
 * word deliberately — they are the same event told by two systems, and the
 * dedup engine merges them into one row wherever it can prove it.
 */
export function kindOf(source: SourceName, kind: string, meta: Record<string, any> = {}): Kind {
  switch (source) {
    case 'slack':
      return kind === 'alert'
        ? { word: 'Alert', Icon: BellRing, source }
        : { word: 'Thread', Icon: MessageSquare, source }
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

/** The kind of a whole card, taken from the source that speaks for it. */
export function cardKind(card: Card): Kind {
  const lead = card.sources[0]
  if (!lead) return kindOf('github', card.kind, card.meta)
  return kindOf(lead.source, card.kind || lead.kind, { ...lead.meta, ...card.meta })
}

/** The glyph, in its source's hue. Sized for a row (16px) or a pane (14px). */
export function KindGlyph({ kind, size = 16 }: { kind: Kind; size?: number }) {
  const { Icon } = kind
  return <Icon size={size} strokeWidth={1.8} style={{ color: SOURCE_COLOR[kind.source] }} aria-hidden />
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

/**
 * Who this row is about, or null when nobody is.
 *
 * `who` is the person waiting on him and it is the right answer whenever there
 * is one. `actor` is the fallback and it is only reachable on a conversation:
 * on an alert the actor is the bot that posted it, so `Sentry-alerts — Sentry`
 * would be the row telling him the same thing twice and calling a monitor a
 * person. The adapters already write `who: undefined` on every alert; this does
 * not depend on their having remembered to.
 */
export function waitingOn(card: Card): string | null {
  if (card.who) return card.who
  const lead = card.sources[0]
  if (card.kind === 'alert' || lead?.kind === 'alert') return null
  return card.actor ?? lead?.actor ?? null
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
 * differs, paired with the person. Every source answers — Slack the channel,
 * GitHub the repository, Sentry and Claude the project, Gmail the mailbox it
 * landed in — because `whereOf` already answers for all five. Either half may be
 * missing and the line is then just the other one; both missing is `null`, and
 * the cell decides what nothing looks like.
 */
export function contextLine(card: Card): string | null {
  const where = whereOf(card.sources[0], card)
  const customer = where ? shortName(where) : null
  const who = waitingOn(card)
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
