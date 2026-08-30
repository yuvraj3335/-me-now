/**
 * The desk, as a table.
 *
 * One `<table>`, one sticky header row, and one `<tbody>` per non-empty pile,
 * all sharing one `<colgroup>`. The shared colgroup is the whole trick: it is
 * what lets grouping and column alignment coexist without either becoming a
 * mode, so the eye reads straight down one column instead of re-parsing every
 * entry.
 *
 * Four things changed here, and each was measured on the live page.
 *
 * **`SOURCE` is not a column heading any more.** The word is 45px wide and the
 * thing it labelled is a 6px dot, so the column was padded to 68 to fit its own
 * label, `WHEN` ended up 22px away from it, and `columnsFor` then dropped the
 * repo name at every laptop width to pay for it — the laptop showed fewer facts
 * per row than the phone. The dots move to an unlabelled slot immediately left
 * of When, and `Where` survives.
 *
 * **`<th>` and `<td>` share an x in every column, including the first.** The
 * kind glyph gets a fixed slot rather than pushing the word, so `KIND` at x=224
 * sits over `Session` at x=224 instead of 23px to its left, on the one column
 * the eye lands on first.
 *
 * **A pile with zero rows is not rendered.** No heading, no count, no sentence.
 * A titled chapter with a zero beside it and an apology under it cost 109px of
 * the fold to report that there was nothing in it, and three of them stacked
 * cost 331px of a filtered phone to say nothing at all.
 *
 * **The 2px row stripe is gone, and a 2px state edge has taken its place.** The
 * stripe was an 855px vertical bracket painting the identical colour on every
 * visible row — brighter than the rules it crossed, encoding nothing. The edge
 * is the same two pixels spent on the two or three rows that have had something
 * land on them since he last looked, and it is drawn from the same expression as
 * the `+N` beside the title, so the two can never disagree.
 *
 * Below 1024px there is no table: the row becomes one 44px line, because six
 * columns in 390px is not a table, it is a diagram of one.
 */

import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import type { CardStatus } from '../../shared/status'
import { STATUS_LABEL, STATUS_ORDER } from '../../shared/status'
import type { Card, SourceName } from '../lib/types'
import { ago } from '../lib/time'
import { Button } from './primitives'
import { SourceDot, SOURCE_LABEL } from './sources'
import { cardKind, headTruncate, KindGlyph, whereOf } from './kinds'
import { SwipeDrawer, useSwipe } from './swipe'

export type RowAction = {
  /** Done on every group; Snooze on the two live ones; Bring it back on a snoozed one. */
  onDone: (c: Card) => void
  onSnooze: (c: Card) => void
  onBack: (c: Card) => void
  onOpen: (c: Card) => void
  /** The swipe's Status picker, and its Delete — which on a card is `Won't do`. */
  onStatus: (c: Card, status: CardStatus) => void
  onWontDo: (c: Card) => void
}

/** The five, as the drawer's picker wants them. Built once, not per row. */
const STATUS_CHOICES = STATUS_ORDER.map(id => ({ id, label: STATUS_LABEL[id] }))

/**
 * The count, and the edge, from one expression.
 *
 * `+2` renders iff there is something new and the row is marked iff there is
 * something new, so the two can never tell different stories about the same
 * thread. The server computes the number; this decides nothing except where to
 * put it.
 *
 * The edge is `inset` box-shadow on the row's first cell rather than a border on
 * the `<tr>`, because under `border-collapse` a row's own border does not paint
 * at all. This is the 2px state edge the file's docblock reserved when it
 * deleted the old stripe: that one painted the identical colour on all twenty
 * rows and encoded nothing. This paints two or three.
 */
const EDGE = { boxShadow: 'inset 2px 0 0 var(--color-accent)' } as const
const edgeIf = (card: Card) => (card.activity.count > 0 ? EDGE : undefined)

function Count({ card }: { card: Card }) {
  if (card.activity.count <= 0) return null
  return (
    <span className="text-accent-ink tnum text-sm shrink-0" title="new since you last looked">
      +{card.activity.count}
    </span>
  )
}

/**
 * Which columns exist, decided by how much room the list actually has.
 *
 * `Where` is the only optional one now, and it yields to the detail pane rather
 * than to `Why`. The previous rule dropped `Why` — the column the file's own
 * comment said must never be lost — for every width between 1024 and 1087,
 * because eight columns had to fit beside a pane that appeared at 1024. The pane
 * appears at 1280 instead, so between 1024 and 1280 the table has the whole
 * shell and every column fits.
 */
export type Columns = {
  why: boolean
  where: boolean
}

/** The shell's own fixed columns, which the table never gets to use. */
const RAIL = 200
/** One page pad, both sides. `.pad-x` in styles.css is the only source of it. */
const PAGE_PAD = 48

/** The width at which a table stops being a diagram of one. */
export const TABLE_MIN = 1024
/**
 * The width at which the detail pane earns its column.
 *
 * At 1024 a 352px pane left the table 424px for six columns, which is how `Why`
 * came to be dropped on an iPad in landscape. Below 1280 the detail is the
 * full-screen push view the phone already uses, which is a better read anyway.
 */
export const PANE_MIN = 1280

export const paneWidth = (w: number) => (w >= 1440 ? 400 : 360)

/**
 * Column widths, in the order they appear.
 *
 * Sized to their content, and measured rather than guessed: `Session` behind a
 * 20px glyph slot needs 96, `trutohq/truto` head-truncated in mono needs 112,
 * two source dots need 20, the `WHEN` heading needs 56, and one 32px row action
 * needs 64. `Why` is 160 because that is what its own longest sentence measures:
 * `your open pull request` is 140px with the cell's padding.
 *
 * These add up to 396 at 1440, which leaves `Where` its 112 and Title 284 — four
 * pixels above the floor. That margin is the whole reason `SOURCE` stopped being
 * a heading: its label was 45px wide to caption a 6px dot, and `columnsFor` was
 * dropping the repo name at every laptop width to pay for it.
 */
const W = { kind: 96, why: 160, where: 112, dots: 20, when: 56, actions: 64 }

/** What Title wants. It is the only elastic column. */
const TITLE_MIN = 280

/**
 * What Title must never be given less than, which is a different question.
 *
 * `TITLE_MIN` is the width at which the column is comfortable, and it is what
 * decides whether `Where` still fits beside it. This is the floor under the
 * whole table: the pane is draggable now, and under `table-fixed` the one
 * unsized column gets whatever the others leave — which at 1280 with the pane
 * dragged to its 640 ceiling is *minus four pixels*. Every row on the desk
 * rendered a blank Title inside a table four pixels wider than its own column,
 * from a width that had been persisted on a bigger monitor and restored with no
 * visible cause. 200px is about twenty-five characters: enough to tell one row
 * from another, which is the least a title can be and still be one.
 */
const TITLE_FLOOR = 200

/** Everything in a row that is not the title, at the width it always takes. */
const FIXED = W.kind + W.dots + W.when + W.actions + W.why

/**
 * The widest the detail pane may be at this viewport.
 *
 * `clampPane` bounds the pane against itself, 320 to 640, with no reference to
 * how much shell there is to take the room from — so the bound held on a 1920px
 * monitor and took the list apart on the 1280px laptop the same `localStorage`
 * value came back on. The pane may take room from the list; it may not take the
 * list apart. `Where` is not in the sum because `columnsFor` has already given
 * it up by the time this bites.
 */
export function maxPaneFor(width: number): number {
  return width - RAIL - PAGE_PAD - FIXED - TITLE_FLOOR
}

/**
 * `pane` is passed in now rather than derived, because the pane is draggable.
 *
 * It still defaults to what the breakpoint would have chosen, so a caller that
 * does not care about the pane — and the tests that pin the width table — ask
 * the same question they always did.
 */
export function columnsFor(width: number, pane = width >= PANE_MIN ? paneWidth(width) : 0): Columns {
  const list = width - RAIL - pane - PAGE_PAD
  return { why: true, where: list - FIXED - W.where >= TITLE_MIN }
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

/**
 * No left padding on any cell.
 *
 * The page pad is applied once, by `.pad-x` on the container. A cell that pads
 * itself again is what put the `<th>`s at 225 while the page title sat at 216.
 */
const HEAD = 'text-eyebrow uppercase text-fg-mute font-medium text-left align-middle py-2 pr-4 truncate'

export function TableHead({ cols }: { cols: Columns }) {
  return (
    /*
     * `z-20`, because the drawer is `z-10` and so was this.
     *
     * Two positioned elements at the same z-index in one stacking context are
     * painted in tree order, and a `<tbody>` comes after a `<thead>` — so an
     * open drawer on a row scrolling up under the sticky header painted its
     * solid 264px block straight over KIND / TITLE / WHY. The header is the one
     * that has to win: it is the fixed thing the rows move under.
     */
    <thead className="sticky top-0 z-20 bg-ink-900">
      <tr className="border-b border-edge">
        <th className={HEAD} scope="col">Kind</th>
        <th className={HEAD} scope="col">Title</th>
        {cols.why && <th className={HEAD} scope="col">Why</th>}
        {cols.where && <th className={HEAD} scope="col">Where</th>}
        {/* The source column has no heading. Its label was seven times wider
            than the dot it labelled and cost the repo name to fit. */}
        <th className={HEAD} scope="col" aria-label="Source" />
        <th className={`${HEAD} text-right`} scope="col">When</th>
        <th className={`${HEAD} pr-0`} scope="col" aria-label="Actions" />
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
          the others leave, which is what makes Title elastic. */}
      <col />
      {cols.why && <col style={{ width: W.why }} />}
      {cols.where && <col style={{ width: W.where }} />}
      <col style={{ width: W.dots }} />
      <col style={{ width: W.when }} />
      <col style={{ width: W.actions }} />
    </colgroup>
  )
}

/** How many cells wide the table currently is, for a full-width group row. */
export const colSpanOf = (cols: Columns) =>
  5 + (cols.why ? 1 : 0) + (cols.where ? 1 : 0)

/* ------------------------------ group headers ----------------------------- */

/**
 * `ON YOU 3`, `WAITING 19`.
 *
 * An eyebrow and a tabular count, not a heading. It used to be `text-md
 * font-medium` — the same weight and colour as the page title, four points
 * smaller, repeated four times per screen, so the eye could not tell which "Now"
 * was the page. One `lg` per screen; a group label is 11px uppercase. The words
 * changed with the rest of the vocabulary; what the three groups compute did
 * not, and the field names in the JSON did not either.
 *
 * The count carries no accent. The same number was amber in three places at
 * once, which is three more than "at most three marks on a screen" allows.
 */
export function GroupHead({
  title, shown, total, cols, right, first,
}: {
  title: string; shown: number; total: number; cols: Columns
  right?: React.ReactNode
  /** The first group sits under the header row, so it needs no air above it. */
  first?: boolean
}) {
  const filtered = shown !== total
  return (
    <tr>
      <td colSpan={colSpanOf(cols)} className={`pb-2 ${first ? 'pt-2' : 'pt-6'}`}>
        <div className="flex items-baseline gap-2">
          <h2 className="text-eyebrow uppercase text-fg-mute">{title}</h2>
          <span className="text-eyebrow uppercase tnum text-fg-mute">
            {filtered ? `${shown} of ${total}` : shown}
          </span>
          {right && <span className="ml-auto">{right}</span>}
        </div>
      </td>
    </tr>
  )
}

/* ---------------------------------- rows ---------------------------------- */

const CELL = 'py-3 pr-4 align-middle truncate'

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
  const swipe = useSwipe(card.group_key, 3)

  // Keyboard focus scrolls the row into view; without this, `j` past the fold
  // moves a selection nobody can see.
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: 'nearest' }) }, [focused])

  return (
    <tr
      ref={n => { ref.current = n; swipe.bind.ref(n) }}
      onPointerDown={swipe.bind.onPointerDown}
      onPointerMove={swipe.bind.onPointerMove}
      onPointerUp={swipe.bind.onPointerUp}
      onPointerCancel={swipe.bind.onPointerCancel}
      onClickCapture={swipe.bind.onClickCapture}
      data-swipe={swipe.bind['data-swipe']}
      style={swipe.bind.style}
      onClick={() => actions.onOpen(card)}
      aria-selected={selected}
      className={`group cursor-pointer border-b border-rule transition-colors duration-100
        ${focused ? 'bg-ink-700' : selected ? 'bg-ink-800' : 'hover:bg-ink-800'}`}
    >
      <td className={CELL} style={edgeIf(card)}>
        {/* A fixed slot, not a gap: the glyph varies in width by two pixels
            between kinds, and letting it push the word is what put four row
            titles on four different x. */}
        <span className="flex items-center">
          <span className="w-5 shrink-0 flex items-center"><KindGlyph kind={kind} size={14} /></span>
          <span className="text-sm text-fg-dim truncate">{kind.word}</span>
        </span>
      </td>

      {/* The count sits immediately after the title, inside its cell, so it
          costs the elastic column ~26px on the rows that have one and nothing
          on the rows that do not. */}
      <td className={`${CELL} text-base font-medium text-fg`} title={card.title}>
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="truncate">{card.title}</span>
          <Count card={card} />
        </span>
      </td>

      {cols.why && <td className={`${CELL} text-sm text-fg-dim`} title={card.why}>{card.why}</td>}
      {/* Head-truncated to what the column actually holds, and NOT also
          `truncate`d: doing both gave `…utohq/tru…`, cut at each end, which is
          the one form that identifies nothing. */}
      {cols.where && (
        <td className={`${CELL} text-sm text-fg-dim font-mono overflow-hidden`} title={where ?? undefined}>
          {where ? headTruncate(where, 12) : ''}
        </td>
      )}

      <td className={CELL}>
        <span className="flex items-center gap-1">
          {sources.length > 2
            ? <SourceDot source={sources[0]!} size={6} />
            : sources.map(s => <SourceDot key={s} source={s} size={6} />)}
        </span>
      </td>

      <td className={`${CELL} text-sm text-fg-mute tnum text-right`}>{ago(card.ts)}</td>

      {/* The drawer is anchored here and paints leftward over the row. A `<tr>`
          cannot be a containing block for a panel that spans it — and it cannot
          clip one either — so the last cell, which is the one at the row's right
          edge, holds it. */}
      <td className="py-1 pr-0 align-middle relative" onClick={e => e.stopPropagation()}>
        <span className="flex items-center justify-end">
          <Button size="sm" variant="ghost" title="Done" ariaLabel="Done" onClick={() => actions.onDone(card)}>
            <Check size={14} />
          </Button>
        </span>
        <SwipeDrawer
          dx={swipe.dx}
          width={swipe.width}
          onClose={swipe.close}
          onDone={() => actions.onDone(card)}
          onDelete={() => actions.onWontDo(card)}
          status={{
            current: card.status,
            options: STATUS_CHOICES,
            onPick: id => actions.onStatus(card, id as CardStatus),
          }}
        />
      </td>
    </tr>
  )
}

/* ------------------------------ the phone row ----------------------------- */

/**
 * One line, 44px.
 *
 * It was two lines and 60px: a title, then kind, who, where and why as one
 * muted run beginning 13px to the LEFT of the title it belonged to, and two 32px
 * icon buttons taking 24% of the row's width for actions that are also one tap
 * away in the detail. At 44px nineteen of the twenty Open rows fit a 390×844
 * phone, against thirteen before, and the pile stops needing two screens.
 *
 * Kind and repo move to the detail. `Why` stays, because it is the answer to the
 * question the screen exists to answer.
 */
export function CardLine({
  card, selected, actions,
}: { card: Card; selected: boolean; actions: RowAction }) {
  const kind = cardKind(card)
  const swipe = useSwipe(card.group_key, 3)

  return (
    <li
      ref={swipe.bind.ref}
      onPointerDown={swipe.bind.onPointerDown}
      onPointerMove={swipe.bind.onPointerMove}
      onPointerUp={swipe.bind.onPointerUp}
      onPointerCancel={swipe.bind.onPointerCancel}
      onClickCapture={swipe.bind.onClickCapture}
      data-swipe={swipe.bind['data-swipe']}
      style={{ ...swipe.bind.style, ...(card.activity.count > 0 ? EDGE : null) }}
      /* `overflow-hidden` is the drawer's clip. The table cannot have one — a
         `<tr>` does not clip — but this row can, so a status picker on the
         narrowest phone is bounded by the row rather than by the page. */
      className={`relative overflow-hidden flex items-center border-b border-rule h-11
        ${selected ? 'bg-ink-800' : ''}`}
    >
      <button onClick={() => actions.onOpen(card)} className="min-w-0 grow h-full text-left">
        <div className="flex items-center h-full">
          {/* The same fixed slot the table uses, so every title on the page
              starts on one x whatever glyph precedes it. */}
          <span className="w-5 shrink-0 flex items-center"><KindGlyph kind={kind} size={14} /></span>
          <span className="text-base font-medium text-fg truncate min-w-0 grow">{card.title}</span>
          {card.activity.count > 0 && <span className="pl-2 flex items-center"><Count card={card} /></span>}
          {/*
            `Why` from 640px up, and not below it.

            The brief's phone row is glyph, title, why, age. Measured at 390 with
            real rows, that is 358px holding a 20px slot, a 40px action, a 38px
            age and two competing truncations — both land at about twelve
            characters, and "waiting for r…" over "TypeError: Cannot re…" answers
            neither question. The glyph and its colour already say which source a
            row came from, and `why` is very nearly constant per source: every
            session says the same eight words, every one of his pull requests says
            the same four. So the phone spends the width on the one fact that is
            different on every row, and `why` — which leads the detail — is one
            tap away.
          */}
          <span className="hidden sm:block text-sm text-fg-mute truncate min-w-0 max-w-[38%] pl-3 text-right">
            {card.why}
          </span>
          <span className="text-sm text-fg-mute tnum shrink-0 pl-3">{ago(card.ts)}</span>
        </div>
      </button>
      <span className="pl-2 shrink-0">
        <Button size="sm" variant="ghost" title="Done" ariaLabel="Done" onClick={() => actions.onDone(card)}>
          <Check size={14} />
        </Button>
      </span>
      <SwipeDrawer
        dx={swipe.dx}
        width={swipe.width}
        onClose={swipe.close}
        onDone={() => actions.onDone(card)}
        onDelete={() => actions.onWontDo(card)}
        status={{
          current: card.status,
          options: STATUS_CHOICES,
          onPick: id => actions.onStatus(card, id as CardStatus),
        }}
      />
    </li>
  )
}

/** The sources a group was seen in, spelled out. Used by the Done group. */
export const sourceWords = (card: Card) =>
  [...new Set(card.sources.map(s => SOURCE_LABEL[s.source]))].join(' + ')
