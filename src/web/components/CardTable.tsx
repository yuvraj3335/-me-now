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
 * Below 1024px there is no table: four columns in 390px is not a table, it is a
 * diagram of one. The phone row is one 44px line.
 */

import { useEffect, useRef, useState } from 'react'
import type { Card, CardStatus } from '../lib/types'
import { STATUS_LABEL, STATUS_ORDER } from '../lib/types'
import { fromLocalInput, toLocalInput } from '../lib/time'
import { Check } from 'lucide-react'
import { Button, Select } from './primitives'
import { cardKind, KindGlyph } from './kinds'
import { PriorityGlyph, StatusSlot, isSettled } from './status'
import { dueWords, ROW_META, ROW_TITLE, TABLE_HEAD } from '../lib/typography'

export type RowAction = {
  /** Open the detail. The row's own click, and the phone row's whole left half. */
  onOpen: (c: Card) => void
  /** Where the work stands, changed from the row. */
  onStatus: (c: Card, status: CardStatus) => void
  /** A due date, or null to clear one. */
  onDue: (c: Card, at: number | null) => void
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

export function TableHead() {
  return (
    <thead className="sticky top-0 z-10 bg-ink-900">
      <tr className="border-b border-edge">
        <th className={HEAD} scope="col">Title</th>
        <th className={HEAD} scope="col">Status</th>
        <th className={HEAD} scope="col">Kind</th>
        <th className={HEAD} scope="col">Due</th>
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
      {/* A settled card keeps its title legible and struck through rather than
          dimmed away: it is still the thing he is looking at, it is just no
          longer waiting on him. */}
      <td className={`${CELL} ${ROW_TITLE} ${isSettled(card.status) ? 'line-through text-fg-dim' : ''}`}
        title={card.title}>
        {card.title}
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

      <DueCell card={card} onDue={actions.onDue} />
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
function DueCell({ card, onDue }: { card: Card; onDue: (c: Card, at: number | null) => void }) {
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
      <td className="py-1 pr-0 align-middle" onClick={e => e.stopPropagation()}>
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
    <td className="py-1 pr-0 align-middle" onClick={e => e.stopPropagation()}>
      <button
        onClick={() => setEditing(true)}
        title={words ? 'Change the due date' : 'Set a due date'}
        aria-label={words ? `Due ${words}` : 'Set a due date'}
        className={`hit w-full h-7 px-1 text-left rounded-control truncate
                    transition-colors duration-100 hover:bg-ink-700
                    ${overdue ? 'text-sm text-bad tnum' : words ? ROW_META : 'text-sm text-fg-mute'}`}
      >
        {words ?? '—'}
      </button>
    </td>
  )
}

/* ------------------------------ the phone row ----------------------------- */

/**
 * One line, 44px.
 *
 * Status glyph, title, due, and one control. No kind word, no channel, no
 * priority: 358px of usable width already carries two things that want to
 * truncate, and a third makes all of them useless. The glyph carries the state
 * without a word, which is what a glyph is for, and everything else is one tap
 * away in the sheet.
 */
export function CardLine({
  card, selected, actions,
}: { card: Card; selected: boolean; actions: RowAction }) {
  const words = dueWords(card.due_at)
  const overdue = card.due_at !== null && card.due_at < Date.now()

  return (
    <li className={`flex items-center border-b border-rule h-11 ${selected ? 'bg-ink-800' : ''}`}>
      <button onClick={() => actions.onOpen(card)} className="min-w-0 grow h-full text-left">
        <div className="flex items-center h-full">
          {/* The same fixed slot the table uses, so every title on the page
              starts on one x whatever glyph precedes it. */}
          <StatusSlot status={card.status} />
          <span className={`${ROW_TITLE} truncate min-w-0 grow
                            ${isSettled(card.status) ? 'line-through text-fg-dim' : ''}`}>
            {card.title}
          </span>
          {words && (
            <span className={`shrink-0 pl-3 ${overdue ? 'text-sm text-bad tnum' : ROW_META}`}>
              {words}
            </span>
          )}
        </div>
      </button>
      {/* A neutral tick, not the Done glyph. The glyph is painted in `ok`, and
          nineteen green ticks down the right edge of a list reads as nineteen
          finished rows rather than as nineteen ways to finish one. */}
      <span className="pl-2 shrink-0">
        <Button size="sm" variant="ghost" title="Done" ariaLabel="Done"
          onClick={() => actions.onStatus(card, 'done')}>
          <Check size={14} />
        </Button>
      </span>
    </li>
  )
}
