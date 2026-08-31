/**
 * The desk, as a table.
 *
 * Four columns and nothing else: **Title · Status · Kind · Due**. One `<table>`,
 * one sticky header, one `<tbody>`, one `<colgroup>`. The shared colgroup is the
 * whole trick — it is what makes the eye read straight down a column instead of
 * re-parsing every row.
 *
 * The seven-column version this replaces put Why, Where, a source-dot slot and
 * a When column on every row. Every one of those is a fact about a card he has
 * not opened yet, and the price was paid on all twenty rows to answer a question
 * asked about one. They live in the detail pane now, which is the surface that
 * exists to answer them and where there is room to answer them properly.
 *
 * Three of the four columns are also *controls*, which is the second half of the
 * change. Status is a dropdown and Due is a date picker, both operable from the
 * row without opening anything — so triage is one pass down a column rather than
 * twenty opens and twenty closes. They stop their own clicks from propagating,
 * because changing a status is not asking to read the card.
 *
 * There is no `columnsFor` any more. The pane is user-resizable, so no column
 * arithmetic may assume a pane width — the old rule guessed 400 or 360 and
 * disagreed with the rendered `xl:w-90`/`2xl:w-100` between 1440 and 1535. The
 * page clamps the *pane* against this file's floors instead, which is the only
 * direction that can be correct.
 *
 * Two marks ride on top of those four columns, and they are one fact told
 * twice: a `+N` badge immediately after the title, and a warm wash across the
 * whole row. Both render from `card.activity.count > 0` — one expression, read
 * in two places — so the badge and the highlight can never disagree about how
 * much has landed since he last looked. Neither is drawn here: `rowStateClass`
 * paints the ground and `CountBadge` paints the number, both from
 * `primitives.tsx`, because a `<tr>`, an `<li>` and Mail's `<button>` rows were
 * all telling this story in slightly different colours. What that replaces is a
 * 2px amber bar inset on the row's first cell, which read as a rendering seam in
 * the corner of one column and, on the phone list, sat under a thumb.
 *
 * And every row swipes left. `Done`, `Status` and `Delete` under a finger, a
 * trackpad or a mouse drag, without opening anything — see `components/swipe.tsx`
 * for why the drawer is a clip window pinned to the last cell rather than a
 * translated row. The phone row lends the finger to its own table first — the
 * horizontal axis shows the columns until there are no more to show, and is the
 * drawer's after that. `CardLine` and `useSwipe` argue it where it is decided.
 *
 * Below 1024px it is still a table, and that is the reversal this file's last
 * comment argued against. "Four columns in 390px is a diagram of a table" was
 * true of four columns *squeezed* into 390px; what shipped instead was one
 * column — a glyph, a truncated title, a tick — so a phone showed no status, no
 * deadline, no channel and no person, which are the four facts that decide
 * whether a row is opened at 7am. The phone gets real columns at real widths in
 * a scroller of their own, and everything that does not fit is reached by moving
 * the table rather than by squeezing it. See `PhoneTable`.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Card, CardStatus } from '../lib/types'
import { STATUS_LABEL, STATUS_ORDER } from '../lib/types'
import { fromLocalInput, toLocalInput } from '../lib/time'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { CountBadge, Select, rowStateClass, useRail } from './primitives'
import { cardKind, contextLine, KindGlyph } from './kinds'
import { SOURCE_LABEL } from './sources'
import { PriorityGlyph, isSettled } from './status'
import { SwipeDrawer, useSwipe } from './swipe'
import { dueWords, ROW_META, ROW_SECOND, ROW_TITLE, TABLE_HEAD } from '../lib/typography'

export type RowAction = {
  /** Open the detail. The row's own click, and the phone row's whole left half. */
  onOpen: (c: Card) => void
  /** Where the work stands, changed from the row. */
  onStatus: (c: Card, status: CardStatus) => void
  /** A due date, or null to clear one. */
  onDue: (c: Card, at: number | null) => void
}

/** The five, as the drawer's picker wants them. Built once, not per row. */
const STATUS_CHOICES = STATUS_ORDER.map(id => ({ id: id as string, label: STATUS_LABEL[id] }))

/**
 * What `+2` says on this page, said once.
 *
 * `CountBadge` is shared with the phone tab bar, so the two badges in the
 * product are one badge; `plus` is the only difference and it is the difference
 * between a delta and a total. The desk means "two things arrived since you last
 * looked", which is a delta, so the sign is on. The server computes the number
 * in `activityOf` and nothing here recounts it.
 */
const NEW_TITLE = 'new since you last looked'

/**
 * The drawer's three actions, in the vocabulary the desk already has.
 *
 * `Delete` on a card is `Won't do` — the way Wake has always dismissed work —
 * so nothing here invents a fourth verb or a second kind of removal. The row is
 * still reachable through the Status filter afterwards, which is the whole
 * reason `Won't do` and not a real delete.
 */
const drawerFor = (card: Card, actions: RowAction) => ({
  onDone: () => actions.onStatus(card, 'done'),
  onDelete: () => actions.onStatus(card, 'wont_do'),
  status: {
    current: card.status as string,
    options: STATUS_CHOICES,
    onPick: (id: string) => actions.onStatus(card, id as CardStatus),
  },
})

/* ------------------------ what a card's text says ------------------------- */

/**
 * The lengths a collector cuts a title at.
 *
 * Slack's thread card takes the first 120 characters of the parent message and
 * its alert families take 160, both with a bare `.slice` — so a title that ran
 * on stops dead, mid-word, with nothing on the screen to say it was cut:
 * `…on the NetSuite Tax module and recently com`. In a cell that truncates, CSS
 * hides the seam; in the pane's wrapping heading and in the phone's peek the
 * raw cut is what a person reads.
 *
 * A title that happens to be exactly 120 or 160 characters long gains an
 * ellipsis it did not earn, and that trade is deliberate: it is a rounding
 * error against a cut that shows every time a Slack thread has a long parent,
 * and of the two claims the ellipsis is the weaker one — "there may be more" is
 * wrong far less often than "this is all of it".
 *
 * The collectors should say so themselves, and `github.ts` and
 * `claudeSessions.ts` already do — they cut on a word boundary and append the
 * mark. This is the half that renders honestly whatever is already in the
 * database, which is every row on the desk this morning.
 */
const HARD_CUTS = new Set([120, 160])

/** A card's own name, with a collector's hard cut acknowledged. */
export function titleOf(card: Card): string {
  const t = card.title
  if (!HARD_CUTS.has(t.length) || t.endsWith('…')) return t
  // The same trailing trim the collectors that do this properly apply: a cut
  // that landed on a space or a comma should not keep it in front of the mark.
  return `${t.replace(/[\s,;:–—-]+$/, '')}…`
}

/**
 * A Markdown body, read as prose.
 *
 * GitHub hands over the raw body of a pull request — `## The vulnerability`,
 * `**complete login with only their password**`, backticked paths — and the
 * pane draws an excerpt of it into a `whitespace-pre-wrap` block, so every
 * marker is on the screen as a character. Nothing here renders them instead: an
 * excerpt is three clipped lines of a glance, and a heading level inside a
 * three-line clip is not information, it is noise wearing a hash.
 *
 * Two things it deliberately leaves alone, and both are the same judgement. A
 * lone `_` is never emphasis here — `group_key`, `thread_ts`, `is_pr` are the
 * words this product's own text is made of, and eating the middle of an
 * identifier is a worse lie than a stray underscore is noise — and `__` is left
 * for the same reason, since GitHub authors write bold with asterisks. The
 * contents of a fenced block stay; only the fence goes, because the code is
 * usually the sentence the excerpt is about.
 */
export function plainMarkdown(s: string): string {
  return s
    .replace(/^\s*```+[^\n]*\n?/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^(\s*)[*+]\s+/gm, '$1- ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|~~)(.+?)\1/g, '$2')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`+([^`\n]+)`+/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The width at which a table stops being a diagram of one. */
export const TABLE_MIN = 1024

/**
 * The width at which the detail pane earns its column.
 *
 * At 1024 a 352px pane left the table 424px for its columns. Below 1280 the
 * detail is the bottom sheet the phone already uses, which is a better read
 * anyway.
 */
export const PANE_MIN = 1280

/**
 * The three fixed columns, in the order they appear after Title.
 *
 * Measured on the rendered page, not guessed. `Status` holds a 28px `<select>`
 * whose longest option is `Not started`: 68px of text, 20px of chevron well,
 * 8px of lead padding and the cell's own 16px trailing gap. At 116 that came out
 * `Not start…` on every second row — a truncated status is not a status. `Kind`
 * holds a 20px glyph slot, `Session` at 13px, and a right-aligned priority mark.
 * `Due` holds `Overdue 12d`, the longest thing `dueWords` produces.
 *
 * 336 fixed in total. At 1024 with no pane the list has 776 and Title takes
 * 440; at 1280 with a 360 pane it has 672 and Title takes 336; at 1536 with a
 * 400 pane Title takes 552. Never below `TITLE_MIN` — see the clamp on the pane.
 */
export const W = { status: 140, kind: 100, due: 96 }

/** What Title wants. It is the only elastic column. */
export const TITLE_MIN = 280

/** The shell's own rail, plus one page pad both sides. Neither is the table's. */
export const SHELL_FIXED = 200 + 48

/**
 * The widest the pane may be at this viewport before Title starts collapsing.
 *
 * The page owns the pane's width, so the page is where this has to be answered.
 * It is a floor of 320 rather than a hard cap, because a viewport too narrow to
 * satisfy everything should still open a pane you can read.
 */
export const maxPaneFor = (width: number) =>
  Math.max(320, width - SHELL_FIXED - (W.status + W.kind + W.due) - TITLE_MIN)

/** The viewport width, as a number the layout rules can read. */
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
const HEAD = TABLE_HEAD

/**
 * How the desk is ordered, as the address bar spells it.
 *
 * `null` is the order the server sent — most recently touched first, which is
 * the right answer to "what happened" and the wrong one to "what is due
 * soonest". Those are the only two questions a deadline column is asked, so
 * there are exactly two sorted states and a way back to neither.
 */
export type DueSort = 'due' | '-due' | null

const NEXT_SORT: Record<string, DueSort> = { none: 'due', due: '-due', '-due': null }

/** The state one press of the Due header moves to. */
export const nextDueSort = (sort: DueSort): DueSort => NEXT_SORT[sort ?? 'none'] ?? null

/**
 * Four headings, one of which is a control.
 *
 * Due is sortable and the other three are not, and that asymmetry is the point
 * rather than an omission: a deadline is the only column here whose values have
 * an order that means something. Title, Status and Kind sort into alphabets and
 * enum positions, which answer nothing anybody asks of this table.
 *
 * The glyph is always drawn, including in the unsorted state, because a control
 * that only looks like one once it has been used cannot be found the first time
 * — and `group-hover` does not fire on a touch screen at all.
 */
export function TableHead({
  sort = null, onSort,
}: { sort?: DueSort; onSort?: (next: DueSort) => void }) {
  const Glyph = sort === 'due' ? ArrowUp : sort === '-due' ? ArrowDown : ArrowUpDown
  const word = sort === 'due' ? 'earliest first' : sort === '-due' ? 'latest first' : 'unsorted'

  return (
    /* `z-20`, above the drawer's `z-10`. Two positioned elements at one
       z-index in one stacking context paint in tree order, and a `<tbody>`
       comes after a `<thead>` — so an open drawer painted its solid 264px
       block over Title / Status / Kind / Due as its row scrolled up under
       the header. */
    <thead className="sticky top-0 z-20 bg-ink-900">
      <tr className="border-b border-edge">
        <th className={HEAD} scope="col">Title</th>
        <th className={HEAD} scope="col">Status</th>
        <th className={HEAD} scope="col">Kind</th>
        <th
          className={HEAD}
          scope="col"
          aria-sort={sort === 'due' ? 'ascending' : sort === '-due' ? 'descending' : 'none'}
        >
          <button
            onClick={() => onSort?.(nextDueSort(sort))}
            title={`Sort by due date — ${word}`}
            aria-label={`Sort by due date — ${word}`}
            /* `relative`, because `.hit` hangs its target 6px outside the box
               with `position: absolute` — without a positioned box of its own
               that target resolves against the nearest positioned ancestor and
               becomes a page-sized one. `uppercase` is restated because the UA
               sheet sets `text-transform: none` on a button, so the eyebrow
               casing the header cell carries does not reach through it. */
            className={`hit relative inline-flex items-center gap-1 cursor-pointer uppercase
                        transition-colors duration-100 hover:text-fg-dim
                        ${sort ? 'text-fg-dim' : ''}`}
          >Due<Glyph size={12} aria-hidden /></button>
        </th>
      </tr>
    </thead>
  )
}

/**
 * The one `<colgroup>` the table shares.
 *
 * Fixed widths and `table-fixed`, so a long title cannot push Due left on one
 * row and not on the next — which is the entire content of "columns that hold
 * their x-position down the page".
 */
export function TableCols() {
  return (
    <colgroup>
      {/* No width: under `table-fixed` the one unsized column absorbs whatever
          the others leave, which is what makes Title elastic. */}
      <col />
      <col style={{ width: W.status }} />
      <col style={{ width: W.kind }} />
      <col style={{ width: W.due }} />
    </colgroup>
  )
}

/* ---------------------------------- rows ---------------------------------- */

const CELL = 'py-3 pr-4 align-middle truncate'

export function CardRow({
  card, selected, focused, actions,
}: {
  card: Card
  selected: boolean
  focused: boolean
  actions: RowAction
}) {
  const ref = useRef<HTMLTableRowElement>(null)
  const kind = cardKind(card)
  const swipe = useSwipe(card.group_key, 3)
  // Printed through `titleOf` rather than raw, here and on the `title`
  // attribute beside it, so a collector's hard cut is admitted wherever the
  // name is read — including the tooltip, which is the one place on this row
  // that shows the whole string.
  const name = titleOf(card)

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
      /* Four states, one function, every list in the product. Selected used to
         be `bg-ink-800` — the same token as hover — so the row the pane was
         showing became invisible the moment the pointer was anywhere near the
         table. See `rowStateClass`. */
      className={`group cursor-pointer border-b border-rule
        ${rowStateClass({ selected, focused, unseen: card.activity.count > 0 })}`}
    >
      {/* A settled card keeps its title legible and struck through rather than
          dimmed away: it is still the thing he is looking at, it is just no
          longer waiting on him.

          The count sits immediately after the title, inside its cell, so it
          costs the elastic column about 26px on the rows that have one and
          nothing at all on the rows that do not. */}
      <td className={`${CELL} ${ROW_TITLE} ${isSettled(card.status) ? 'line-through text-fg-dim' : ''}`}
        title={name}>
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate">{name}</span>
          <CountBadge count={card.activity.count} plus title={NEW_TITLE} />
        </span>
      </td>

      {/* Less vertical padding than a text cell, because the control inside it
          is 28px and the row is meant to be 44 either way. */}
      <td className="py-2 pr-4 align-middle">
        <Select
          value={card.status}
          options={STATUS_ORDER.map(s => ({ id: s, label: STATUS_LABEL[s] }))}
          onChange={s => actions.onStatus(card, s)}
          ariaLabel="Status"
          className="w-full"
        />
      </td>

      <td className={CELL}>
        {/* A fixed slot, not a gap: the glyph varies in width by two pixels
            between kinds, and letting it push the word is what put four row
            titles on four different x.

            Priority rides in this cell rather than taking one of its own. A
            52px `Priority` heading over a 14px mark that is absent on most rows
            is the mistake that already cost the source column its label. */}
        <span className="flex items-center">
          <span className="w-5 shrink-0 flex items-center"><KindGlyph kind={kind} size={14} /></span>
          <span className="text-sm text-fg-dim truncate grow">{kind.word}</span>
          <span className="shrink-0 pl-1"><PriorityGlyph priority={card.priority} /></span>
        </span>
      </td>

      {/* The drawer is anchored in the last cell and paints leftward over the
          row. A `<tr>` cannot be a containing block for a panel that spans it —
          and it cannot clip one either — so the cell at the row's right edge
          holds it. */}
      <DueCell card={card} onDue={actions.onDue}>
        <SwipeDrawer
          dx={swipe.dx} width={swipe.width} onClose={swipe.close}
          {...drawerFor(card, actions)}
        />
      </DueCell>
    </tr>
  )
}

/**
 * The date, and the calendar behind it.
 *
 * A real picker, opened in place rather than in a popover. A popover inside a
 * table with a sticky header and a clipped page column has to solve its own
 * positioning, its own dismissal and its own scroll containment to show one
 * control that the platform already draws better; swapping the cell's contents
 * has none of those problems and lands the caret in the calendar directly.
 *
 * `date` rather than `datetime-local` here, and only here. The column is 96px;
 * a `datetime-local` field renders about 190. The detail pane is where a time
 * of day is set, and this preserves whatever time is already on the card so
 * moving a deadline by a day in the table does not silently reset the hour it
 * was set for. A date with no time yet lands at 18:00 — the end of a working
 * day is what "due Thursday" means.
 *
 * Overdue is the one place `bad` is spent on this page. A date that has passed
 * is the single fact on a row that is worse than it was yesterday.
 */
function DueCell({ card, onDue, children }: {
  card: Card
  onDue: (c: Card, at: number | null) => void
  /** The row's swipe drawer, which needs the row's right-hand cell to live in. */
  children?: React.ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const words = dueWords(card.due_at)
  const overdue = card.due_at !== null && card.due_at < Date.now()

  // A different card in the same row position is a different question.
  useEffect(() => setEditing(false), [card.group_key])

  if (editing) {
    // Built from local parts. `toISOString().slice(0,10)` is the UTC day, which
    // is yesterday's date for any evening in IST.
    const day = card.due_at ? toLocalInput(card.due_at).slice(0, 10) : ''
    const clock = card.due_at ? toLocalInput(card.due_at).slice(11) : '18:00'
    return (
      <td className="py-1 pr-0 align-middle relative" onClick={e => e.stopPropagation()}>
        {children}
        <input
          type="date"
          autoFocus
          aria-label="Due date"
          value={day}
          onChange={e => onDue(card, fromLocalInput(e.target.value ? `${e.target.value}T${clock}` : ''))}
          onBlur={() => setEditing(false)}
          onKeyDown={e => { if (e.key === 'Escape' || e.key === 'Enter') setEditing(false) }}
          className="w-full h-7 px-1 rounded-control border border-edge bg-transparent
                     text-sm text-fg outline-none"
        />
      </td>
    )
  }

  return (
    <td className="py-1 pr-0 align-middle relative" onClick={e => e.stopPropagation()}>
      {children}
      <button
        onClick={() => setEditing(true)}
        title={words ? 'Change the due date' : 'Set a due date'}
        aria-label={words ? `Due ${words}` : 'Set a due date'}
        /* `relative`, or the touch box lands on `<main>` — a `<td>` is not a
           positioned ancestor, so a 30px control would claim the whole page. */
        className={`hit relative w-full h-7 px-1 text-left rounded-control truncate
                    transition-colors duration-100 hover:bg-ink-700
                    ${overdue ? 'text-sm text-bad tnum' : words ? ROW_META : 'text-sm text-fg-mute'}`}
      >
        {words ?? '—'}
      </button>
    </td>
  )
}

/* ----------------------------- the phone table ---------------------------- */

/**
 * The phone's own columns, measured for a 375px screen rather than derived
 * from the laptop's.
 *
 * `Status` holds the same control the table does and its longest option is
 * still `Not started`. `Where` holds `15five — Roopi`, which is what the phone
 * row was missing altogether. `Due` holds `Overdue 12d`. Title takes what is
 * left and is the only elastic column, exactly as on the laptop.
 *
 * 368 fixed plus a 184 floor under Title is 552, against the 343 a 375px phone
 * leaves inside the page pad. **That difference is the feature.** The columns
 * are drawn at a width where they can be read and the table is moved to reach
 * them, rather than every column being squeezed to 68px so that all four fit
 * and none of them says anything.
 *
 * Status is 144 and not the 132 it shipped at, and the twelve pixels are a
 * coarse pointer's. `styles.css` raises every `<select>` to 16px under
 * `@media (pointer: coarse)` — the fix for iOS zooming the page on focus and
 * never zooming back — so the phone renders this control two points larger than
 * any desktop window ever will, at any width. Measured with that rule live:
 * `Not started` is 90.4px against the 86px of text room a 132px column leaves
 * after 16px of cell gap and the select's own 28px of padding and chevron well,
 * so the phone read `Not start…` on every row. This file already spends a
 * paragraph on that exact failure at 116px on the laptop — *a truncated status
 * is not a status* — and it came back on the one device the rule applies to.
 * 144 leaves 98px for a 90.4px word. A wider column costs nothing here: the
 * table scrolls, so the price is 12px of travel rather than 12px off Title.
 */
export const PHONE_W = { status: 144, where: 136, due: 88 }

/** What Title wants on a phone. Below this a two-word title starts eliding. */
export const PHONE_TITLE_MIN = 184

/** The width the phone table refuses to go under, and therefore scrolls at. */
export const PHONE_MIN =
  PHONE_TITLE_MIN + PHONE_W.status + PHONE_W.where + PHONE_W.due

/**
 * Five columns, the last of which has no width.
 *
 * The fifth is not a column of data — it is a 0px anchor pinned to the visible
 * right edge, and it exists because the swipe drawer has to hang off something.
 * See the row.
 */
function PhoneCols() {
  return (
    <colgroup>
      {/* Unsized, so Title absorbs whatever the others leave — the same trick
          the laptop's `TableCols` turns on, for the same reason. */}
      <col />
      <col style={{ width: PHONE_W.status }} />
      <col style={{ width: PHONE_W.where }} />
      <col style={{ width: PHONE_W.due }} />
      <col style={{ width: 0 }} />
    </colgroup>
  )
}

/**
 * The phone's headings, and they are not decoration.
 *
 * A table that scrolls sideways needs them more than one that does not: they
 * are the only thing that says what the column you have just scrolled to is.
 * They do not stick *vertically* — a sticky `top` resolves against the nearest
 * scrollport, which here is the horizontal scroller rather than the page, so it
 * would have a zero-length range and pin nothing. The page is what scrolls
 * vertically and a page of rows is `PAGE_SIZE` long, so the heading is a few
 * flicks away rather than gone.
 *
 * Horizontally they travel with their columns, Title included. Title used to be
 * pinned and the heading had to be pinned with it, or the two would part company
 * on the first flick; neither is now, which is one mechanism fewer holding up a
 * column that a thumb could not move anyway.
 */
function PhoneHead() {
  return (
    <thead>
      <tr className="border-b border-edge">
        <th className={HEAD} scope="col">Title</th>
        <th className={HEAD} scope="col">Status</th>
        <th className={HEAD} scope="col">Where</th>
        <th className={HEAD} scope="col">Due</th>
        <th className={HEAD} scope="col" aria-label="Row actions" />
      </tr>
    </thead>
  )
}


/**
 * How long a press has to be held before it is a peek, and how far it may drift.
 *
 * 8px is deliberately *under* `SWIPE_ENGAGE_PX`, so a gesture that is going to
 * become a swipe has already cancelled the peek before the swipe itself
 * engages; a scroll cancels it on the first frame that moves. 450ms is long
 * enough that a tap can never reach it and short enough that a deliberate hold
 * does not feel broken.
 */
const PEEK_MS = 450
const PEEK_SLOP = 8

/**
 * Long-press, which this product did not have.
 *
 * Three things it must not be, and each one is a real failure it would
 * otherwise have: it must not fire on a **scroll** (the finger is down for as
 * long as you like while the page moves), it must not fire on a **swipe** (the
 * drawer is already the row's gesture), and it must not fire on a **tap** — and
 * the tap is the subtle one, because a press that has already peeked still
 * produces a `click` on release, which would open the pane the peek exists to
 * avoid opening. `ate` is what swallows that click, in the capture phase,
 * before the row's own handler sees it.
 */
function useLongPress(onPeek: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const from = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  // A row that leaves mid-press must not peek from the grave.
  useEffect(() => clear, [])

  return {
    onPointerDown(e: React.PointerEvent) {
      // Secondary buttons belong to the context menu, same rule the swipe keeps.
      if (e.button > 0) return
      fired.current = false
      from.current = { x: e.clientX, y: e.clientY }
      clear()
      timer.current = setTimeout(() => {
        timer.current = null
        fired.current = true
        onPeek()
      }, PEEK_MS)
    },
    onPointerMove(e: React.PointerEvent) {
      const start = from.current
      if (!start || !timer.current) return
      if (Math.abs(e.clientX - start.x) > PEEK_SLOP || Math.abs(e.clientY - start.y) > PEEK_SLOP) clear()
    },
    onPointerUp() { from.current = null; clear() },
    onPointerCancel() { from.current = null; clear() },
    /** True — and the click is eaten — when this press already peeked. */
    ate(e: React.MouseEvent) {
      if (!fired.current) return false
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
      return true
    },
  }
}

/**
 * One phone row, as a row of a real table.
 *
 * What it replaces was a single 44px flex line: a kind glyph, a title truncated
 * at whatever was left, and a tick. No status, no deadline, no channel and no
 * person — the four facts that decide whether something is opened at 7am — and
 * nothing to scroll sideways to, because there were no columns to scroll to.
 *
 * The tick is gone with it, and that is a deliberate subtraction rather than an
 * omission: `Done` is now reachable from the Status control in this row's own
 * second column and from the swipe drawer, and a third way to finish one card
 * on one row is two ways too many for 44px.
 *
 * The last cell is 0px wide and `sticky right-0`, and it holds the drawer. That
 * is the whole reason it exists. `SwipeDrawer` anchors itself to `right: 0` of
 * whatever contains it, so in a table that scrolls sideways an ordinary last
 * cell would put `Done`, `Status` and `Delete` at the right edge of the *table*
 * — 200px off the screen, on a row the reader is holding open. Pinned, its right
 * edge is the right edge of what is visible, whatever the table has been
 * scrolled to, and it costs the layout nothing because it has no width.
 */
export function CardLine({
  card, selected, focused, actions, onPeek,
}: {
  card: Card
  selected: boolean
  focused: boolean
  actions: RowAction
  /** Show the peek for this row. The pane is still a tap away and unaffected. */
  onPeek: (c: Card) => void
}) {
  const words = dueWords(card.due_at)
  const overdue = card.due_at !== null && card.due_at < Date.now()
  const kind = cardKind(card)
  const where = contextLine(card)
  const name = titleOf(card)
  const unseen = card.activity.count > 0
  /*
   * A horizontal scroller and a horizontal swipe in one row, and only one of
   * them can have the axis. Here it is the table, and that is the whole of the
   * phone-scroll fix.
   *
   * They are the same gesture to a browser: a finger travelling left across a
   * row either pans the table or opens the drawer, and whichever claims the
   * touch first takes it for the whole stream. This was decided per cell —
   * Title kept `pan-y` for the drawer, the other four overrode to
   * `manipulation` for the table — on the theory that a reader aims at the
   * column whose gesture he wants. He does not, and the split failed in the one
   * direction that matters. Measured on the deployed site at 390px: the
   * scroller could scroll (clientWidth 358 against scrollWidth 540, nothing in
   * the ancestor chain clipping it) and Title — pinned, widest, always on
   * screen, and exactly where a thumb lands — computed `touch-action: pan-y`,
   * which hands the browser the vertical axis only. The columns this table
   * exists to draw at a readable width were the ones a phone could not reach,
   * while a laptop trackpad scrolled it perfectly well through `useSwipe`'s own
   * `wheel` handler and made the whole thing look fixed.
   *
   * One policy for the whole row now, and no cell overrides it: `manipulation`
   * through `[data-swipe='manipulation'] > td`, so the browser pans the table.
   *
   * That was the whole answer for one deploy, and it was half of one — it took
   * `Done · Status · Delete` off the phone completely, so a row could only be
   * acted on by opening it. The missing half is that the two claims are not
   * simultaneous: while there is table to the right a drag means "show me the
   * rest", and once there is not, it cannot mean that any more. `data-atend` on
   * the scroller hands the axis back at exactly that point, in the stylesheet
   * and in `useSwipe` together, so the browser and the handler change their mind
   * on the same frame. Swipe to the end of the columns and keep going: the
   * drawer opens, on the same finger, without lifting it.
   */
  const swipe = useSwipe(card.group_key, 3, 'manipulation')
  const press = useLongPress(() => onPeek(card))

  return (
    <tr
      ref={swipe.bind.ref}
      /* Both gestures read the same pointer stream. The swipe goes first in
         every one of these because it is the one that can claim the pointer;
         the press only ever cancels itself. */
      onPointerDown={e => { swipe.bind.onPointerDown(e); press.onPointerDown(e) }}
      onPointerMove={e => { swipe.bind.onPointerMove(e); press.onPointerMove(e) }}
      onPointerUp={e => { swipe.bind.onPointerUp(e); press.onPointerUp() }}
      onPointerCancel={e => { swipe.bind.onPointerCancel(e); press.onPointerCancel() }}
      onClickCapture={e => { if (press.ate(e)) return; swipe.bind.onClickCapture(e) }}
      data-swipe={swipe.bind['data-swipe']}
      /* `WebkitTouchCallout` beside the gesture's own style: without it iOS
         answers a long press on a row of text with its own selection magnifier,
         over the peek that press was asking for. */
      style={{ ...swipe.bind.style, WebkitTouchCallout: 'none' }}
      onClick={() => actions.onOpen(card)}
      aria-selected={selected}
      className={`cursor-pointer border-b border-rule
        ${rowStateClass({ selected, focused, unseen })}`}
    >
      {/*
        The identity column, and it scrolls with everything else.

        It used to be `sticky left-0`, to keep the name on screen at every
        scroll position. The argument was sound and the result was not, and it
        failed in three ways at once on a real phone. The column would not move
        under a finger, so "scroll the table sideways" was true of four columns
        and false of the one a thumb actually lands on. `Select` is `relative`,
        so the Status picker — a positioned sibling later in the row — slid
        *underneath* the pinned cell and left nothing on screen but its chevron:
        a status column reduced to a `⌄`. And the pinning needed an opaque
        ground and a `z-10` of its own to survive that, which is three
        mechanisms held together to defend one.

        What it was protecting against is real but smaller than the cure: scroll
        to the far right and the name is off screen. That is what every
        horizontally scrolled table does, it is reversible with the same finger
        that caused it, and the row is still identified by its kind glyph — which
        travels with it — and by tapping it.

        The drawer's anchor cell keeps its `sticky right-0` and its `z-20`: that
        one is not a column of data, it is a 0px hook the actions hang off, and
        it is the one thing that is *supposed* to cover the row.
      */}
      <td
        className={`${CELL} ${ROW_TITLE}
                    ${isSettled(card.status) ? 'line-through text-fg-dim' : ''}`}
        title={name}>
        <span className="flex items-center gap-2 min-w-0">
          {/* Named for the source rather than the kind: the shape is what a
              sighted reader tells them apart by, and the hue that carries the
              source is exactly the half a screen reader cannot see. */}
          <span role="img" aria-label={SOURCE_LABEL[kind.source]} title={SOURCE_LABEL[kind.source]}
            className="w-5 shrink-0 flex items-center">
            <KindGlyph kind={kind} size={14} />
          </span>
          <span className="truncate">{name}</span>
          <CountBadge count={card.activity.count} plus title={NEW_TITLE} />
        </span>
      </td>

      <td className="py-2 pr-4 align-middle">
        <Select
          value={card.status}
          options={STATUS_ORDER.map(s => ({ id: s, label: STATUS_LABEL[s] }))}
          onChange={s => actions.onStatus(card, s)}
          ariaLabel="Status"
          className="w-full"
        />
      </td>

      {/* `15five — Roopi`, not `#15five-truto`. See `contextLine`. */}
      <td className={`${CELL} ${ROW_SECOND}`} title={where ?? undefined}>
        {where ?? '—'}
      </td>

      {/* Read-only, unlike the laptop's. A deadline is set in the detail, which
          is one tap away and has room for a time of day; an 88px column on a
          phone has room for neither. */}
      <td className={`${CELL} ${overdue ? 'text-sm text-bad tnum' : words ? ROW_META : 'text-sm text-fg-mute'}`}>
        {words ?? '—'}
      </td>

      {/* `z-20`, above the pinned Title cell's `z-10`: the drawer is the one
          thing on this row that is supposed to cover the row. */}
      <td className="sticky right-0 z-20 w-0 p-0 align-middle">
        <SwipeDrawer
          dx={swipe.dx} width={swipe.width} onClose={swipe.close}
          {...drawerFor(card, actions)}
        />
      </td>
    </tr>
  )
}

/**
 * The phone list, which is the same table at a different width.
 *
 * The scroller is the table's own and nothing else's. `<main>` carries
 * `overflow-x-clip` precisely so that a page column never scrolls sideways —
 * read the comment there before touching it — and this does not fight that
 * rule, it is what the rule leaves room for: the page body still cannot move,
 * and the one box that can is the one whose content is wider than the screen on
 * purpose.
 *
 * `overflow-x-auto` also makes the box a scroll container on the *other* axis,
 * which is CSS and not a choice — `overflow-y: visible` computes to `auto` the
 * moment its partner is not visible. It is harmless here only because the box is
 * given no height: it grows to hold every row, so the vertical scrollport and
 * the vertical content are the same size and the page keeps the scroll. Putting
 * a `max-h` on this would take the list's vertical scrolling away from the page
 * and hand it to a nested box, which is the one thing a phone must never have.
 *
 * `overscroll-x-contain` stops a flick that reaches the end of the table from
 * chaining into the browser's own back-navigation gesture, which is how a reader
 * leaves Wake by scrolling a column.
 *
 * There is no `.rail` fade over it, and that is measured rather than forgotten:
 * the fade is an `::after` on the wrapper, painted after the table in tree
 * order, so an open swipe drawer would be read through 32px of gradient at
 * exactly the end where `Delete` sits. The cut-off column and the scrollbar say
 * the same thing without painting over a control.
 *
 * It does take `useRail`'s other answer, as `data-atend`: `spill` says there is
 * still table past the right edge, and its absence is the moment the horizontal
 * axis stops belonging to the scroller and starts belonging to the row drawer.
 * One listener on the scroller answers it for all twenty rows, because it is one
 * fact about one scroll position — see `useSwipe` and `[data-atend]` in
 * `styles.css`.
 *
 * The rows inside it hand the browser both axes until then; `CardLine` says why.
 */
export function PhoneTable({
  rows, selectedKey, cursorKey, actions,
}: {
  rows: Card[]
  selectedKey: string | null
  /** The row the `j`/`k` cursor is standing on, or null when nobody chose one. */
  cursorKey: string | null
  actions: RowAction
}) {
  const [peek, setPeek] = useState<Card | null>(null)
  const scroller = useRail<HTMLDivElement>()

  return (
    <>
      <div
        ref={scroller.ref}
        /*
         * `data-atend` is how the row drawer and the table stop fighting.
         *
         * They want the same axis under the same finger. The last pass resolved
         * that by giving the axis to the table outright, which scrolled but cost
         * `Done · Status · Delete` on the phone entirely — a row could no longer
         * be acted on without opening it.
         *
         * They are not actually simultaneous. While there is more table to the
         * right, a horizontal drag means "show me the rest"; once there is not,
         * the same drag has nothing left to ask for. So the browser keeps the
         * axis until the table is scrolled out, and the drawer takes it after —
         * one finger, one continuous motion, swipe to the end and keep going.
         * `useSwipe` reads this attribute at `pointerdown`; the stylesheet flips
         * `touch-action` off the same flag so the handoff happens before the
         * gesture starts rather than mid-drag.
         */
        data-hscroll=""
        data-atend={scroller.spill ? undefined : ''}
        className="overflow-x-auto overscroll-x-contain"
      >
        <table className="w-full table-fixed border-collapse" style={{ minWidth: PHONE_MIN }}>
          <PhoneCols />
          <PhoneHead />
          <tbody>
            {rows.map(c => (
              <CardLine
                key={c.group_key} card={c}
                selected={c.group_key === selectedKey}
                focused={c.group_key === cursorKey}
                actions={actions}
                onPeek={setPeek}
              />
            ))}
          </tbody>
        </table>
      </div>
      {peek && <Peek card={peek} onClose={() => setPeek(null)} />}
    </>
  )
}

/**
 * What a long press answers with.
 *
 * Deliberately *not* the detail. The pane is what a tap opens and it is a place
 * you go — it takes the screen, it acknowledges the card, and coming back is a
 * dismissal. The peek is a look: it says who this is with, why it is on the
 * desk, and the first three lines of what was actually said, and then it goes
 * away on the next thing you do. Nothing about it is a decision, so nothing
 * about it is committed — it does not acknowledge, it does not select, and it
 * does not change the URL.
 *
 * `pointer-events-none` is the whole of that promise, expressed once: the panel
 * cannot be tapped, so it can never be a thing you have to get out of. Any
 * pointer that goes down anywhere — including through it, onto the row
 * underneath — dismisses it, as does Escape and as does any scroll, captured so
 * that a scroll inside the table counts too.
 *
 * It sits above the phone's tab bar rather than on the bottom edge, for the
 * same reason the detail sheet does: `--nav-h` is the strip the bar owns and
 * covering it is how a reader ends up with no way out.
 */
function Peek({ card, onClose }: { card: Card; onClose: () => void }) {
  const kind = cardKind(card)
  const where = contextLine(card)

  useEffect(() => {
    const away = () => onClose()
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc)
    window.addEventListener('scroll', away, true)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc)
      window.removeEventListener('scroll', away, true)
    }
  }, [onClose])

  return createPortal(
    <div
      role="tooltip"
      style={{ bottom: 'calc(var(--nav-h) + 8px)' }}
      className="fixed inset-x-2 z-50 pointer-events-none flex flex-col gap-2
                 rounded-panel border border-edge bg-ink-850 p-3"
    >
      <span className="flex items-center gap-2 min-w-0">
        <KindGlyph kind={kind} size={14} />
        <span className={`${ROW_SECOND} truncate`}>{where ?? kind.word}</span>
        {card.activity.count > 0 && (
          <span className="ml-auto flex items-center gap-2 shrink-0">
            <CountBadge count={card.activity.count} plus />
            <span className="text-sm text-fg-mute">{NEW_TITLE}</span>
          </span>
        )}
      </span>

      <span className={`${ROW_TITLE} line-clamp-2`}>{titleOf(card)}</span>
      <span className="text-sm text-fg-mute">{card.why}</span>
      {/* Read as prose: a GitHub body arrives as raw Markdown, and three
          clipped lines of `## The vulnerability` is a glance spent on syntax.
          See `plainMarkdown`. */}
      {card.excerpt && (
        <span className={`${ROW_SECOND} line-clamp-3`}>{plainMarkdown(card.excerpt)}</span>
      )}
    </div>,
    document.body,
  )
}
