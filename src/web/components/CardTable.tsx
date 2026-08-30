/**
 * Now, as a table.
 *
 * One `<table>`, one sticky header row, and three `<tbody>` groups — Now, Open,
 * Parked — sharing one `<colgroup>`. The shared colgroup is the whole trick: it
 * is what lets grouping and column alignment coexist without either becoming a
 * mode, so the eye reads straight down one column instead of re-parsing every
 * entry. A fourth group, `Done and not mine`, sits collapsed at the bottom.
 *
 * What this replaces: twenty 129px cards, of which 32px was an `opacity: 0`
 * action bar occupying layout on every row whether or not it was visible and
 * 30px was a chip row restating the dot in the gutter. Five of twenty rows fit a
 * 1440×900 viewport. At 44px, fourteen do.
 *
 * Below 1024px there is no table: the row becomes two lines, because six columns
 * in 390px is not a table, it is a diagram of one.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, Clock, Sunrise } from 'lucide-react'
import type { Card, SourceName } from '../lib/types'
import { ago } from '../lib/time'
import { Button } from './primitives'
import { SourceDot, SOURCE_LABEL } from './sources'
import { cardKind, headTruncate, KindGlyph, whereOf } from './kinds'

export type RowAction = {
  /** `Done` on every pile; `Later` on Now and Open; `Wake now` on Parked. */
  onDone: (c: Card) => void
  onLater: (c: Card) => void
  onWake: (c: Card) => void
  onOpen: (c: Card) => void
}

/**
 * Which columns exist, decided by how much room the list actually has.
 *
 * Not by the viewport: the rail and the detail pane are both fixed columns of
 * the shell, so a 1440px screen gives the table about 790px, and the eight
 * columns at their nominal widths want more than that. Deciding on the viewport
 * instead of on the list is how the table came out 992px wide inside a 792px
 * container and slid underneath the pane.
 *
 * Columns disappear from the middle out — Who, then Where, then Why — and Title
 * never drops below 280px, because a title cut to forty characters is a title
 * that has to be opened to be read.
 */
export type Columns = {
  why: boolean
  who: boolean
  where: boolean
}

/** The shell's own fixed columns, which the table never gets to use. */
const RAIL = 200
const PAGE_PAD = 32

/** The pane is narrower on a small laptop, where 400px is a third of the screen. */
export const paneWidth = (w: number) => (w >= 1440 ? 400 : 352)

/**
 * Column widths, in the order they appear.
 *
 * Sized to their content rather than to a round number: `Session` plus a 16px
 * glyph is 88px, `trutohq/truto` in mono is 112px, and two 26px row actions plus
 * their gap is 72px. `Source` and `When` are wider than their *content* needs
 * because their column headings are wider than they are — 60px of dots under a
 * 44px column made `SOURCE` and `WHEN` collide into `SOURCEWHEN`.
 */
const W = { kind: 88, why: 120, who: 88, where: 108, source: 68, when: 56, actions: 72 }
const TITLE_MIN = 280

export function columnsFor(width: number): Columns {
  const list = width - RAIL - paneWidth(width) - PAGE_PAD
  const cols: Columns = { why: true, who: true, where: true }
  const spend = () =>
    W.kind + W.source + W.when + W.actions +
    (cols.why ? W.why : 0) + (cols.who ? W.who : 0) + (cols.where ? W.where : 0)

  for (const drop of ['who', 'where', 'why'] as const) {
    if (list - spend() >= TITLE_MIN) break
    cols[drop] = false
  }
  return cols
}

/** The viewport width, as a number the column rules can read. */
export function useViewport(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    on()
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

/* --------------------------------- header --------------------------------- */

const HEAD = 'text-eyebrow uppercase text-fg-mute font-medium text-left align-middle px-2 py-2 truncate'

export function TableHead({ cols }: { cols: Columns }) {
  return (
    <thead className="sticky top-0 z-10 bg-ink-900">
      <tr className="border-b border-edge">
        <th className={HEAD} scope="col">Kind</th>
        <th className={HEAD} scope="col">Title</th>
        {cols.why && <th className={HEAD} scope="col">Why</th>}
        {cols.who && <th className={HEAD} scope="col">Who</th>}
        {cols.where && <th className={HEAD} scope="col">Where</th>}
        <th className={HEAD} scope="col">Source</th>
        <th className={`${HEAD} text-right`} scope="col">When</th>
        <th className={HEAD} scope="col"><span className="sr-only">Actions</span></th>
      </tr>
    </thead>
  )
}

/**
 * The one `<colgroup>` every group shares.
 *
 * Fixed widths and `table-fixed` on the table, so a long title cannot push the
 * When column left on one row and not on the next — which is the entire content
 * of "columns that hold their x-position down the page".
 */
export function TableCols({ cols }: { cols: Columns }) {
  return (
    <colgroup>
      <col style={{ width: W.kind }} />
      {/* No width: under `table-fixed` the one unsized column absorbs whatever
          the others leave, which is what makes Title elastic and every other
          column hold its x-position. A `min-width` here is what overflowed the
          table out from under its own container. */}
      <col />
      {cols.why && <col style={{ width: W.why }} />}
      {cols.who && <col style={{ width: W.who }} />}
      {cols.where && <col style={{ width: W.where }} />}
      <col style={{ width: W.source }} />
      <col style={{ width: W.when }} />
      <col style={{ width: W.actions }} />
    </colgroup>
  )
}

/** How many cells wide the table currently is, for a full-width group row. */
export const colSpanOf = (cols: Columns) =>
  5 + (cols.why ? 1 : 0) + (cols.who ? 1 : 0) + (cols.where ? 1 : 0)

/* ------------------------------ group headers ----------------------------- */

/**
 * `Now 0`, `Open 3 of 19`.
 *
 * The 40px accent numeral is gone. It said one fact — how many things are
 * waiting — that the group header already says, and it said it in the loudest
 * type and the only routine use of the accent in the product, at the top of the
 * first screen of his day, in order to report a zero.
 *
 * The count carries the accent only when it is greater than zero. That is the
 * entire urgency signal, and it is enough.
 */
export function GroupHead({
  title, shown, total, cols, right, first,
}: {
  title: string; shown: number; total: number; cols: Columns
  right?: React.ReactNode
  /** The first group sits under the header row, so it needs less air above it. */
  first?: boolean
}) {
  const filtered = shown !== total
  const urgent = title === 'Now' && shown > 0
  return (
    <tr>
      <td colSpan={colSpanOf(cols)} className={`px-2 pb-2 ${first ? 'pt-4' : 'pt-6'}`}>
        <div className="flex items-baseline gap-2">
          <h2 className="text-md font-medium tracking-[-0.01em]">{title}</h2>
          <span className={`tnum text-md ${urgent ? 'text-accent-ink' : 'text-fg-mute'}`}>
            {filtered ? `${shown} of ${total}` : shown}
          </span>
          {right && <span className="ml-auto">{right}</span>}
        </div>
      </td>
    </tr>
  )
}

/** One muted noun phrase, at the x-position of the Title column, one row tall. */
export function EmptyRow({ cols, children }: { cols: Columns; children: React.ReactNode }) {
  return (
    <tr>
      <td />
      <td colSpan={colSpanOf(cols) - 1} className="px-2 h-11 text-sm text-fg-mute align-middle">
        {children}
      </td>
    </tr>
  )
}

/* ---------------------------------- rows ---------------------------------- */

const CELL = 'px-2 py-3 align-middle truncate'

/**
 * The state edge: `--accent` when somebody is waiting, `--edge` when it is
 * started and nobody is, nothing once it has been acknowledged.
 */
function edgeFor(card: Card): string {
  if (card.state?.acked_at) return 'transparent'
  return card.pile === 'now' ? 'var(--color-accent)' : 'var(--color-edge)'
}

export function CardRow({
  card, cols, selected, focused, actions,
}: {
  card: Card
  cols: Columns
  selected: boolean
  focused: boolean
  actions: RowAction
}) {
  const ref = useRef<HTMLTableRowElement>(null)
  const kind = cardKind(card)
  const lead = card.sources[0]
  const where = whereOf(lead, card)
  const sources = [...new Set(card.sources.map(s => s.source))] as SourceName[]
  const parked = card.pile === 'parked'

  // Keyboard focus scrolls the row into view; without this, `j` past the fold
  // moves a selection nobody can see.
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: 'nearest' }) }, [focused])

  return (
    <tr
      ref={ref}
      onClick={() => actions.onOpen(card)}
      aria-selected={selected}
      className={`group cursor-pointer border-b border-rule transition-colors duration-100
        ${focused ? 'bg-ink-700' : selected ? 'bg-ink-800' : 'hover:bg-ink-800'}`}
    >
      <td className={CELL} style={{ boxShadow: `inset 2px 0 0 ${focused ? 'var(--color-accent)' : edgeFor(card)}` }}>
        <span className="flex items-center gap-2">
          <KindGlyph kind={kind} />
          <span className="text-sm text-fg-dim">{kind.word}</span>
        </span>
      </td>

      <td className={`${CELL} text-base font-medium text-fg`} title={card.title}>{card.title}</td>

      {cols.why && <td className={`${CELL} text-sm text-fg-dim`} title={card.why}>{card.why}</td>}
      {cols.who && <td className={`${CELL} text-sm text-fg-dim`}>{card.who ?? ''}</td>}
      {/* Head-truncated to what the column actually holds, and NOT also
          `truncate`d: doing both gave `…utohq/tru…`, cut at each end, which is
          the one form that identifies nothing. */}
      {cols.where && (
        <td className={`${CELL} text-sm text-fg-dim font-mono overflow-hidden`} title={where ?? undefined}>
          {where ? headTruncate(where, 13) : ''}
        </td>
      )}

      <td className={CELL}>
        <span className="flex items-center gap-1">
          {sources.length > 3
            ? <span className="text-xs text-fg-mute tnum">••• +{sources.length - 3}</span>
            : sources.map(s => <SourceDot key={s} source={s} size={6} />)}
        </span>
      </td>

      <td className={`${CELL} text-sm text-fg-mute tnum text-right`}>{ago(card.ts)}</td>

      <td className="px-2 py-1 align-middle" onClick={e => e.stopPropagation()}>
        <span className="flex items-center gap-1 justify-end">
          <Button
            size="sm" variant="ghost"
            title={parked ? 'Wake now' : 'Later'}
            ariaLabel={parked ? 'Wake now' : 'Later'}
            onClick={() => (parked ? actions.onWake(card) : actions.onLater(card))}
          >
            {parked ? <Sunrise size={14} /> : <Clock size={14} />}
          </Button>
          <Button size="sm" variant="ghost" title="Done" ariaLabel="Done" onClick={() => actions.onDone(card)}>
            <Check size={14} />
          </Button>
        </span>
      </td>
    </tr>
  )
}

/* ------------------------------ the phone row ----------------------------- */

/**
 * Two lines: the title, then everything else as one muted run.
 *
 * 60px, and the actions are 32px painted with a 44px target — never `opacity-0`,
 * because `group-hover` does not fire on touch, which made four buttons on
 * twenty rows permanently invisible, permanently 560px of dead scroll, and still
 * tappable, since opacity does not disable pointer events.
 */
export function CardLine({
  card, selected, actions,
}: { card: Card; selected: boolean; actions: RowAction }) {
  const kind = cardKind(card)
  const where = whereOf(card.sources[0], card)
  const parked = card.pile === 'parked'
  // The age is pinned to the title line rather than left at the end of the meta
  // run: `why` is the longest of these by far, and putting `when` behind it
  // meant the one fact he scans for was the first one truncated away.
  const meta = [kind.word, card.who, where, card.why].filter(Boolean).join(' · ')

  return (
    <li
      className={`flex items-center gap-3 border-b border-rule px-4 min-h-[60px]
        ${selected ? 'bg-ink-800' : ''}`}
      style={{ boxShadow: `inset 2px 0 0 ${edgeFor(card)}` }}
    >
      <button onClick={() => actions.onOpen(card)} className="min-w-0 grow text-left py-2">
        <span className="flex items-baseline gap-2">
          <KindGlyph kind={kind} size={14} />
          <span className="text-base font-medium text-fg truncate grow">{card.title}</span>
          <span className="text-sm text-fg-mute tnum shrink-0">{ago(card.ts)}</span>
        </span>
        <span className="mt-0.5 block text-sm text-fg-mute truncate">{meta}</span>
      </button>
      <span className="flex items-center gap-1 shrink-0">
        <Button
          size="md" variant="ghost"
          title={parked ? 'Wake now' : 'Later'}
          ariaLabel={parked ? 'Wake now' : 'Later'}
          onClick={() => (parked ? actions.onWake(card) : actions.onLater(card))}
        >
          {parked ? <Sunrise size={15} /> : <Clock size={15} />}
        </Button>
        <Button size="md" variant="ghost" title="Done" ariaLabel="Done" onClick={() => actions.onDone(card)}>
          <Check size={15} />
        </Button>
      </span>
    </li>
  )
}

/** The sources a group was seen in, spelled out. Used by the Done group. */
export const sourceWords = (card: Card) =>
  [...new Set(card.sources.map(s => SOURCE_LABEL[s.source]))].join(' + ')
