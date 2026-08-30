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
 *      marks; a thread and a DM are different marks.
 *   2. **The colour is the source.** Same five hues, already theme-split.
 *   3. **The `Where` column is monospace**, and its texture differs by kind
 *      because the underlying data does: `trutohq/truto` is not `#eng-platform`
 *      is not `truto`.
 *
 * A fourth, on the row itself rather than here: a 2px left edge for state.
 */

import {
  AtSign, CircleDot, GitPullRequest, GitPullRequestArrow, Mail, MessageSquare,
  Terminal, TriangleAlert, type LucideIcon,
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
 * `mention`, `dm`, `thread`, `email`, `error`, `session`), and for GitHub it
 * describes *why* rather than *what* — `assigned` is an issue or a pull request
 * depending on `meta.is_pr`. Both facts are already on the card.
 */
export function kindOf(source: SourceName, kind: string, meta: Record<string, any> = {}): Kind {
  switch (source) {
    case 'slack':
      return meta.is_dm || kind === 'dm'
        ? { word: 'DM', Icon: AtSign, source }
        : { word: 'Thread', Icon: MessageSquare, source }
    case 'gmail':
      return { word: 'Mail', Icon: Mail, source }
    case 'sentry':
      return { word: 'Alert', Icon: TriangleAlert, source }
    case 'claude':
      return { word: 'Session', Icon: Terminal, source }
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
  claude: Terminal,
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

/* --------------------------------- where ---------------------------------- */

/**
 * The context a row belongs to, in the vocabulary its own system uses.
 *
 * Rendered in mono, which is the point: `trutohq/truto`, `#eng-platform` and
 * `truto` look different before they are read, and that difference is free —
 * the data already had it.
 */
export function whereOf(source: CardSource | undefined, card: Card): string | null {
  const m = { ...(source?.meta ?? {}), ...card.meta }
  switch (source?.source) {
    case 'slack':
      // Slack's search result names the channel as `#truto`, and the poller
      // stores that string verbatim, so prefixing it again rendered `##truto`.
      // Invisible until now: `Where` was dropped at every laptop width.
      return m.is_dm ? 'DM' : m.channel ? String(m.channel).replace(/^#*/, '#') : null
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
