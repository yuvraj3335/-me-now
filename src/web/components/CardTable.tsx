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
 * Between 640 and 1024 it is still a table, at the narrower widths a laptop
 * window and a tablet can read those columns at. See `PhoneTable`.
 *
 * Below 640 it is not, and that boundary is the one thing in this file measured
 * on a real phone rather than in a resized window. Four columns at a width they
 * can be read at need 552px; a 375px screen gives the page column 343. The
 * table therefore scrolled sideways, and `WHO` was cut off mid-word at the fold
 * before a finger ever moved — a column reachable only by remembering that the
 * table moves is not a column. So the four facts survive and the grid does not:
 * a row-card, title on one line and status, customer and deadline on the next.
 * See `RowCard` and `CardList`. Nothing on that layout scrolls sideways, which
 * is the rule `App.tsx` states for the whole page column and this one used to
 * ask an exception to.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Card, CardStatus } from '../lib/types'
import { STATUS_LABEL, STATUS_ORDER } from '../lib/types'
import { fromLocalInput, toLocalInput } from '../lib/time'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown } from 'lucide-react'
import { CountBadge, rowStateClass, useRail } from './primitives'
import { cardKind, contextLine, KindGlyph } from './kinds'
import { SOURCE_LABEL } from './sources'
import { PriorityGlyph, StatusChip, isSettled } from './status'
import { SwipeDrawer, useSwipe } from './swipe'
import { dueWords, ROW_META, ROW_SECOND, ROW_TITLE, TABLE_HEAD } from '../lib/typography'
import { navStrip } from '../lib/overlay'

export type RowAction = {
  /** Open the detail. The row's own click, and the phone row's whole left half. */
  onOpen: (c: Card) => void
  /** Where the work stands, changed from the row. */
  onStatus: (c: Card, status: CardStatus) => void
  /** A due date, or null to clear one. */
  onDue: (c: Card, at: number | null) => void
  /**
   * Make a task from this row and land it in Work, with no sheet in between.
   *
   * The sheet still exists and is still what the detail pane offers — that is
   * the path for a task you want to shape. This is the other one: the row is
   * already the title, the provenance is already on it, and the only thing a
   * sheet would add is a confirmation of something you can see. The undo is in
   * the toast, which is where every other irreversible-looking thing on this
   * page puts it.
   *
   * Optional, because the desk's own Tasks tab is made of tasks and a task
   * cannot be made from a task. `SwipeDrawerProps.onTask` has always said so;
   * this is the caller side of the same fact, and the drawer's width follows
   * from it — see `actionsOn` below.
   */
  onTask?: (c: Card) => void
}

/**
 * How many actions this row's drawer will paint.
 *
 * It has to be computed rather than written as `4`, and the reason is a
 * measurement rather than tidiness: `swipeActionWidth` gives four actions a
 * narrower box than three so a four-action drawer does not cover the whole of a
 * 375px row. A row offering three actions while the hook is told four opens a
 * 264px window with 198px of buttons in it, and the 66px of empty drawer sits
 * where the finger let go.
 */
const actionsOn = (actions: RowAction) => (actions.onTask ? 4 : 3)

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
 * The drawer's four actions, in the vocabulary the desk already has.
 *
 * `Delete` on a card is `Won't do` — the way Wake has always dismissed work —
 * so nothing here invents a fourth verb or a second kind of removal. The row is
 * still reachable through the Status filter afterwards, which is the whole
 * reason `Won't do` and not a real delete.
 */
const drawerFor = (card: Card, actions: RowAction) => ({
  onTask: actions.onTask && (() => actions.onTask!(card)),
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

/** The shell's own rail, plus one page pad both sides. Neither is the table's. */
export const SHELL_FIXED = 200 + 48

/**
 * The phone's own columns, measured for a 375px screen rather than derived
 * from the laptop's.
 *
 * `Status` holds the same control the table does and its longest option is
 * still `Not started`. `Where` holds `15five — Roopi`, which is what the phone
 * row was missing altogether. `Due` holds `Overdue 12d`. Title takes what is
 * left and is the only elastic column, exactly as on the laptop.
 *
 * 368 fixed plus a 184 floor under Title is 552, and 552 is now the number
 * `COLUMNS_MIN` is built out of rather than a width to be reached by scrolling.
 * The columns are drawn where they can be read, and a viewport that cannot hold
 * all four at once is given row-cards instead — rather than every column being
 * squeezed to 68px so that all four fit and none of them says anything.
 *
 * Status is 144 and not the 132 it shipped at, and the twelve pixels were a
 * coarse pointer's. `styles.css` raises every `<select>` to 16px under
 * `@media (pointer: coarse)` — the fix for iOS zooming the page on focus and
 * never zooming back — so a native control rendered here two points larger than
 * any desktop window ever would: `Not started` measured 90.4px against the 86px
 * of text room a 132px column left, and the phone read `Not start…` on every
 * row. The control is a `StatusPicker` now, which is a button rather than a
 * `<select>` and so is not touched by that rule at all; the closed chip is 134px
 * including the cell's gap, at every pointer. The column keeps 144 anyway. The
 * margin is what the last two passes at this number were both short of. It used
 * to be free because the table scrolled; now it is paid for once, in the
 * viewport at which the table starts being drawn at all.
 */
export const PHONE_W = { status: 144, where: 136, due: 88 }

/** What Title wants on a phone. Below this a two-word title starts eliding. */
export const PHONE_TITLE_MIN = 184

/** The width the table refuses to go under, and therefore is not drawn below. */
export const PHONE_MIN =
  PHONE_TITLE_MIN + PHONE_W.status + PHONE_W.where + PHONE_W.due

/**
 * The width at which columns are worth having at all.
 *
 * Derived, not chosen, and that is the whole repair. It used to be a flat 640 —
 * Tailwind's `sm`, the width the stylesheet draws the tab bar below — on the
 * stated grounds that "from 640 up the 552 fits inside the page column with room
 * to spare, nothing scrolls". That sentence measured the table against the
 * *viewport*, and the table has never been given the viewport. The rail takes
 * 200 and the page pads 24 each side, so at 640 the page column is 392 and a
 * 552px table hung 160px off the end of it — at 768, an iPad held upright, it
 * still hung 32 off. The band that shipped to remove a sideways-scrolling table
 * was itself a sideways-scrolling table, one breakpoint up, and `WHO` was cut
 * off mid-word again in exactly the way the last pass wrote three paragraphs
 * about ending.
 *
 * So it is spelled as the arithmetic it always was: the table's own floor plus
 * the shell's fixed furniture, which is 800. Below it the desk is a list of
 * row-cards, over it a table whose four columns are all on screen at once. A
 * number cannot drift away from its reason if it is not written down twice —
 * change `PHONE_W` and this follows.
 */
export const COLUMNS_MIN = PHONE_MIN + SHELL_FIXED

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
 * Measured on the rendered page, not guessed. `Status` holds the closed
 * `StatusPicker`, whose longest state is `Not started`: 68px of text, a 13px
 * glyph and the 6px beside it, 16px of chip padding, then 15px of chevron and
 * the cell's own 16px trailing gap — 134. It was a 28px `<select>` at 116 and
 * came out `Not start…` on every second row; a truncated status is not a
 * status, and a chip clipped mid-word is not a chip. `Kind`
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
       the header.
       A bar rather than a panel, too: rows scroll *under* this, which is
       exactly the condition `.glass-bar` is thinner and blurred harder for. */
    <thead className="sticky top-0 z-20 glass-bar">
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

/* ------------------------------ the status control ------------------------ */

/**
 * Where the panel goes, measured from the trigger rather than guessed.
 *
 * The same arithmetic `Menu` does in `primitives.tsx`, and deliberately so —
 * see `StatusPicker` for why this cannot simply *be* a `Menu`. It flips above
 * the trigger when what is below it cannot hold all five options, because a
 * picker that opens into two visible rows and a scrollbar is worse than one
 * that opens upward: the five statuses are a set you read at once, and the two
 * that would fall off the bottom are `Done` and `Won't do`.
 */
const PICKER_MIN_W = 176
const PICKER_GAP = 6
const PICKER_MARGIN = 8

/** Five 44px rows plus the panel's own padding — the room it actually needs. */
const PICKER_H = 5 * 44 + 8

type PickerAt = { left: number; width: number; top?: number; bottom?: number }

function anchorFor(el: HTMLElement): PickerAt {
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  /*
   * Measured to the top of the tab bar, not to the bottom of the viewport —
   * see `place()` in `primitives.tsx`, which had the same bug for the same
   * reason. It matters more here: this picker is the phone desk's only visible
   * status control, it is on every row including the ones at the bottom of the
   * list, and it does not scroll, so a downward panel that overshoots puts
   * `Done` and `Won't do` on top of the tab bar. `navStrip` is 0 from `sm` up.
   *
   * `vh` itself stays real, because the flipped-up branch positions with a
   * viewport-relative `bottom`.
   */
  const below = (vh - navStrip()) - r.bottom - PICKER_GAP - PICKER_MARGIN
  const above = r.top - PICKER_GAP - PICKER_MARGIN
  const width = Math.min(Math.max(r.width, PICKER_MIN_W), vw - PICKER_MARGIN * 2)
  const left = Math.min(Math.max(r.left, PICKER_MARGIN), vw - width - PICKER_MARGIN)

  return below < PICKER_H && above > below
    ? { left, width, bottom: vh - r.top + PICKER_GAP }
    : { left, width, top: r.bottom + PICKER_GAP }
}

/**
 * Where work stands, as a control you can read *before* you press it.
 *
 * This replaces a native `<select>`, and the failure it ends was reported off a
 * screenshot of the deployed desk at 375px: a column of identical grey boxes
 * reading `Not started`, `Not started`, `In progress`. The word was there and
 * the state was not — nothing on a closed control carried the ring or the hue
 * that every other surface in this product says a status with, so the one
 * column a person taps to see where things stand answered only by being read,
 * row by row, in 13px type, at 7am. Closed, this is a `StatusChip`: the same
 * glyph and the same wash `status.tsx` paints everywhere else, which is what
 * makes a status legible at arm's length rather than at reading distance.
 *
 * Open, the five options are chips too, at `md`, on 44px rows — that is the
 * same failure one press deeper if they are not. The colour is how you aim at
 * `In review` without reading four labels first, and a picker whose options are
 * plain words hands the whole hue vocabulary back at exactly the moment it is
 * being used.
 *
 * **It is not a `Menu`, and that is a cost paid on purpose.** `Menu` already
 * solves the portal, the placement, the outside press and the keyboard, and
 * this repeats all four. What it cannot do is draw a coloured option: its rows
 * are `{ id, label }` and the label is a string. The alternative was a second
 * status→colour table living in a picker, which is precisely the drift
 * `status.tsx` was written to end — `Work.tsx` kept one of those and shipped
 * three states behind the desk. So the mechanism is duplicated and the
 * vocabulary is not.
 *
 * `fixed`, and portalled. An absolutely positioned panel is clipped by the
 * nearest scroll container and every caller here is inside one: the phone list,
 * the desk's page column, the detail pane's own scrolling body.
 *
 * The keyboard is taken over completely while it is open, in the **capture**
 * phase. The desk binds `j`, `k`, `Enter`, `Escape` and `e` to `document`, and
 * `e` finishes a card with no confirmation — a picker that let those through
 * would settle the cursor's card while somebody was choosing a status for a
 * different one. `stopPropagation` in capture runs before every bubble listener
 * on the same node and does not cancel a default action, so Enter and Space
 * still press the focused row the way they do on any button.
 */
export function StatusPicker({
  value, onChange, className = '', of,
}: {
  value: CardStatus
  onChange: (s: CardStatus) => void
  className?: string
  /**
   * What this control is the status *of*, for a reader who cannot see the row.
   *
   * On the desk the picker sits in a table cell with a row header beside it, so
   * the column and the title are already announced and the bare word is enough.
   * On Work it is a list, and twenty of these announcing "Status — Not started"
   * with nothing to tell them apart is a list you cannot navigate. The old
   * tap-toggle this replaced named its row; nothing should have got worse in
   * that direction on the way past.
   */
  of?: string
}) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<PickerAt | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  /** The five rows, in painted order — the list the arrow keys walk. */
  const rows = () =>
    [...(panel.current?.querySelectorAll<HTMLButtonElement>('[data-status-row]') ?? [])]

  // A pick and an Escape put focus back on the trigger; an outside press does
  // not, because whatever was pressed out there is where the person is going.
  const close = () => {
    setOpen(false)
    anchor.current?.querySelector('button')?.focus()
  }

  useEffect(() => {
    if (!open) return
    const sync = () => { if (anchor.current) setAt(anchorFor(anchor.current)) }
    sync()
    window.addEventListener('resize', sync)
    // Capture: the scroller that moves the trigger is an ancestor, and scroll
    // does not bubble from an element to the window.
    window.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') return setOpen(false)   // let focus leave; it is done
      e.stopPropagation()
      const list = rows()
      const here = list.findIndex(r => r === document.activeElement)
      const go = (n: number) => {
        e.preventDefault()
        list[Math.min(Math.max(n, 0), list.length - 1)]?.focus()
      }
      if (e.key === 'Escape') { e.preventDefault(); close() }
      else if (e.key === 'ArrowDown') go(here + 1)
      else if (e.key === 'ArrowUp') go(here - 1)
      else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(list.length - 1)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  // The row a card is already on takes focus, not the first one — the answer to
  // "where is this now" is where the keyboard should start from. A task rather
  // than an animation frame: a hidden document schedules no frames.
  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => {
      const list = rows()
      const target = list.find(r => r.getAttribute('aria-selected') === 'true') ?? list[0]
      target?.focus()
    }, 0)
    return () => clearTimeout(id)
  }, [open])

  return (
    <span
      ref={anchor}
      className={`inline-flex min-w-0 ${className}`}
      /* This sits in a row whose own click opens the detail, and choosing a
         status is not asking to read the card — the same two handlers the
         native `Select` this replaces had to carry. */
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        /* The word is printed on the chip, but it is printed *inside* a control
           whose accessible name would otherwise be that word alone — `Not
           started` says nothing about what pressing it does. */
        aria-label={of ? `Status — ${STATUS_LABEL[value]} — ${of}` : `Status — ${STATUS_LABEL[value]}`}
        title={`Status — ${STATUS_LABEL[value]}`}
        className="hit relative inline-flex items-center gap-0.5 min-w-0 max-w-full
                   rounded-full transition-colors duration-100 hover:bg-raise"
      >
        <StatusChip status={value} />
        <ChevronDown size={13} aria-hidden
          className={`shrink-0 text-fg-mute transition-transform duration-100
            ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && at && createPortal(
        <div
          ref={panel}
          role="listbox"
          aria-label="Status"
          style={{ left: at.left, top: at.top, bottom: at.bottom, width: at.width }}
          /* `z-[55]`, the same rank `Menu` takes: above a `Sheet` because that
             is one of the surfaces it opens over, below the palette because
             ⌘K is allowed to cover everything. */
          className="fixed z-[55] py-1 rounded-panel border border-edge glass"
        >
          {STATUS_ORDER.map(s => (
            <button
              key={s}
              type="button"
              data-status-row
              role="option"
              aria-selected={s === value}
              onClick={() => { close(); onChange(s) }}
              /* A real 44px height rather than `.hit`'s collar: these are stacked
                 rows, so every collar would overlap its neighbours' and the last
                 one painted would take the taps. `styles.css` states that rule
                 for menu rows in so many words. */
              className={`w-full min-h-11 flex items-center gap-2 px-2 text-left outline-none
                          transition-colors duration-100 hover:bg-raise focus-visible:bg-raise
                          ${s === value ? 'bg-raise' : ''}`}
            >
              <StatusChip status={s} size="md" />
              {/* The tick is not decoration. A wash behind a chip says which
                  status this row *is*; it does not say which one is currently
                  set, and at five chips all wearing their own colour the
                  selected one is not otherwise distinguishable. */}
              <Check size={14} aria-hidden
                className={`ml-auto shrink-0 text-accent-ink ${s === value ? '' : 'invisible'}`} />
            </button>
          ))}
        </div>,
        document.body,
      )}
    </span>
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
  const swipe = useSwipe(card.group_key, actionsOn(actions))
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
      /* `row-pane` rather than `border-b border-rule`: the separator IS the
         material now — a specular highlight along the top of every row and the
         lens shade along the bottom, which stacked reads as panes of glass laid
         against one another. Keeping both would have been two lines per row.
         See `.row-pane` in `styles.css` for why it is painted on the cells. */
      className={`group cursor-pointer row-pane
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
        <StatusPicker value={card.status} onChange={s => actions.onStatus(card, s)} />
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
          offset={swipe.offset} live={swipe.live} width={swipe.width} onClose={swipe.close}
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
  const box = useRef<HTMLTableCellElement>(null)
  const words = dueWords(card.due_at)
  const overdue = card.due_at !== null && card.due_at < Date.now()

  // A different card in the same row position is a different question.
  useEffect(() => setEditing(false), [card.group_key])

  /**
   * The way out, now that the field does not take focus by itself.
   *
   * This used to be `autoFocus` plus `onBlur`, which is one mechanism doing two
   * jobs: it opened the platform's date UI under the finger the instant the
   * cell was pressed, and — because a field that never receives focus never
   * blurs — it was also the only thing that closed the editor again. Dropping
   * the focus grab without this would have left a cell that opens into an input
   * and can never be got out of. A press anywhere else closes it, in the
   * capture phase so the press that opens some *other* cell still lands, and
   * Escape closes it for the laptop. `onBlur` stays for the reader who tabs
   * away.
   */
  useEffect(() => {
    if (!editing) return
    const away = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node)) return
      setEditing(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditing(false) }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [editing])

  if (editing) {
    // Built from local parts. `toISOString().slice(0,10)` is the UTC day, which
    // is yesterday's date for any evening in IST.
    const day = card.due_at ? toLocalInput(card.due_at).slice(0, 10) : ''
    const clock = card.due_at ? toLocalInput(card.due_at).slice(11) : '18:00'
    return (
      <td ref={box} className="py-1 pr-0 align-middle relative" onClick={e => e.stopPropagation()}>
        {children}
        <input
          type="date"
          aria-label="Due date"
          value={day}
          onChange={e => onDue(card, fromLocalInput(e.target.value ? `${e.target.value}T${clock}` : ''))}
          onBlur={() => setEditing(false)}
          onKeyDown={e => { if (e.key === 'Escape' || e.key === 'Enter') setEditing(false) }}
          className="w-full h-7 px-1 rounded-control border border-edge glass-well
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
                    transition-colors duration-100 hover:bg-raise
                    ${overdue ? 'text-sm text-bad tnum' : words ? ROW_META : 'text-sm text-fg-mute'}`}
      >
        {words ?? '—'}
      </button>
    </td>
  )
}

/* ----------------------------- the phone table ---------------------------- */

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
 * How close together two taps have to be to be one gesture, and how far apart
 * they may land.
 *
 * 280ms is the window every platform's own double-tap uses, and it is also the
 * price: on a touch pointer the *first* tap cannot open anything until the
 * window has closed, because until then it is still possibly the first half of
 * a peek. That cost is paid once, deliberately, and only by touch — see
 * `useDoubleTap`.
 *
 * 24px of slop rather than the long press's 8: two deliberate taps from a thumb
 * do not land on the same pixel, and this is a row 44px tall, so a pair that
 * drifts half a finger is still obviously one gesture.
 */
const DOUBLE_TAP_MS = 280
const DOUBLE_TAP_SLOP = 24

/**
 * Double-tap, which replaces the long press this product used to peek with.
 *
 * The long press was the wrong gesture on the one device it existed for. A
 * finger resting on a row for 450ms is what *scrolling* looks like before the
 * scroll starts, so the peek fired on hesitation; it collided with iOS's own
 * selection magnifier, which is why the row needed `WebkitTouchCallout: none`
 * to defend it; and it was undiscoverable, because nothing on a row says it can
 * be held. Double-tap is the gesture a phone already spends on "show me more of
 * this", and the row is already a tap target, so it is the same target twice.
 *
 * **What it must not be**, and each is a real failure otherwise:
 *
 *  * It must not fire on a **swipe**. It cannot: the drawer eats the click in
 *    the capture phase, so `onClick` below never runs on a gesture that opened
 *    the drawer, and a `pointerdown` cancels any open that was already pending.
 *  * It must not **zoom the page**. Two rapid taps are exactly what iOS Safari
 *    magnifies on. Two things stop it, because one of them is not enough: every
 *    row computes a non-`auto` `touch-action` (`pan-y`, or `manipulation` in
 *    the table band — see `styles.css`), which is what actually suppresses
 *    double-tap zoom, and the second tap additionally calls `preventDefault`,
 *    which is the belt to that pair of braces.
 *  * A **single tap must still open the pane**. It does, one window later.
 *
 * **Why only touch.** A mouse pays nothing for opening a row — the pane is a
 * click away and closing it is another click — so making every laptop click
 * wait 280ms to find out whether a second one is coming would be a real cost
 * for a preview that device does not need. A pointer that is not a finger opens
 * immediately and never peeks, and that is the whole of the difference.
 */
function useDoubleTap(onPeek: () => void, onOpen: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const last = useRef<{ x: number; y: number; t: number } | null>(null)
  const touch = useRef(false)
  /**
   * Set while this row's peek is on screen, so the tap that puts it away is not
   * also the tap that opens the card.
   *
   * `RowPeek` is `pointer-events-none` — that is the promise that it can never
   * trap a thumb — so the tap that dismisses it lands on the row underneath.
   * Without this that tap armed the pane, and dismissing a peek meant opening
   * the very card the peek exists to avoid opening, acknowledging it on the
   * way. A ref rather than the `peeking` prop because the panel's own
   * `pointerdown` listener has already closed it by the time the `click`
   * arrives: the render says `false` while the gesture is still the peek's.
   */
  const peeked = useRef(false)

  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  // A row that leaves between the two taps must not open from the grave.
  useEffect(() => clear, [])

  return {
    onPointerDown(e: React.PointerEvent) {
      // Secondary buttons belong to the context menu, same rule the swipe keeps.
      if (e.button > 0) return
      touch.current = e.pointerType === 'touch'
      /*
       * Any new press cancels the open the previous tap armed, and that one
       * line is what keeps the swipe honest. If this press becomes the second
       * tap, the click below peeks instead; if it becomes a swipe, the drawer
       * eats the click and *nothing* happens — where without this the row would
       * open by itself a quarter-second after a swipe the reader had already
       * moved on from.
       */
      clear()
    },
    onPointerCancel() { clear() },
    onClick(e: React.MouseEvent) {
      // The tap that dismisses a peek does that and nothing else.
      if (peeked.current) {
        peeked.current = false
        e.preventDefault()
        return
      }

      if (!touch.current) { onOpen(); return }

      const prev = last.current
      const near = prev
        && e.timeStamp - prev.t <= DOUBLE_TAP_MS
        && Math.abs(e.clientX - prev.x) <= DOUBLE_TAP_SLOP
        && Math.abs(e.clientY - prev.y) <= DOUBLE_TAP_SLOP

      if (near) {
        // The second tap of a pair is the one the browser would have zoomed on.
        e.preventDefault()
        last.current = null
        clear()
        peeked.current = true
        onPeek()
        return
      }

      last.current = { x: e.clientX, y: e.clientY, t: e.timeStamp }
      clear()
      timer.current = setTimeout(() => {
        timer.current = null
        last.current = null
        onOpen()
      }, DOUBLE_TAP_MS)
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
  card, selected, focused, actions, onPeek, peeking,
}: {
  card: Card
  selected: boolean
  focused: boolean
  actions: RowAction
  /** Show the peek for this row. The pane is still a tap away and unaffected. */
  onPeek: (c: Card | null) => void
  /** Whether this row is the one being peeked. The panel is drawn on it. */
  peeking: boolean
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
  const swipe = useSwipe(card.group_key, actionsOn(actions), 'manipulation')
  const tap = useDoubleTap(() => onPeek(card), () => actions.onOpen(card))
  const row = useRef<HTMLTableRowElement | null>(null)
  const peekAbove = usePeekAbove(peeking, row)

  return (
    <tr
      ref={n => { row.current = n; swipe.bind.ref(n) }}
      /* Both gestures read the same pointer stream. The swipe goes first in
         every one of these because it is the one that can claim the pointer;
         the tap only ever cancels its own pending open. */
      onPointerDown={e => { swipe.bind.onPointerDown(e); tap.onPointerDown(e) }}
      onPointerMove={swipe.bind.onPointerMove}
      onPointerUp={swipe.bind.onPointerUp}
      onPointerCancel={e => { swipe.bind.onPointerCancel(e); tap.onPointerCancel() }}
      /* The drawer still eats the click a swipe produces, and that is also what
         stops a swipe being read as half of a double tap: `onClick` never runs. */
      onClickCapture={swipe.bind.onClickCapture}
      data-swipe={swipe.bind['data-swipe']}
      /* `WebkitTouchCallout` beside the gesture's own style. The long press it
         was defending against is gone, but the callout is not about the peek —
         a press-and-hold on a row of text still raises iOS's selection
         magnifier over a row whose whole job is to be tapped. */
      style={{ ...swipe.bind.style, WebkitTouchCallout: 'none' }}
      onClick={tap.onClick}
      aria-selected={selected}
      /* See `CardRow`: the row's own specular pair replaces the hairline. */
      className={`cursor-pointer row-pane
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
        <StatusPicker value={card.status} onChange={s => actions.onStatus(card, s)} />
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
          offset={swipe.offset} live={swipe.live} width={swipe.width} onClose={swipe.close}
          {...drawerFor(card, actions)}
        />
        {/* The peek hangs off this same 0px cell, for the same reason the
            drawer does: `touch-action` is not the only thing a `<tr>` refuses
            to be — it is not a reliable containing block either, and the Title
            cell cannot hold it because `CELL` carries `truncate`, whose
            `overflow: hidden` would clip the panel to one line of one column.
            `right-0` on a cell pinned to the right edge of what is visible puts
            the panel's right edge there too.

            `top-0` rather than `bottom-full`: hanging it above the row reads
            better everywhere except the one row it has to work on, because the
            scroller's `overflow-x-auto` computes `overflow-y: auto` with it, so
            a panel lifted above the *first* row is clipped by the box it grew
            out of. Anchored to the row's own top edge it starts exactly where
            the row starts, at every scroll position, and it carries the title
            itself so the row it covers is still named. */}
        {peeking && (
          <RowPeek
            card={card}
            onClose={() => onPeek(null)}
            className={`absolute right-0 z-30 w-[min(88vw,26rem)] ${peekAbove ? 'bottom-full mb-1' : 'top-0'}`}
          />
        )}
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
                peeking={peek?.group_key === c.group_key}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/**
 * Roughly how tall the peek gets: a source line, two lines of title, the why,
 * and three clipped lines of excerpt. Only used to choose a side, so it is a
 * bound rather than a measurement — being 20px out picks the same side.
 */
const PEEK_H = 200

/**
 * Which side of the row the peek hangs off.
 *
 * `top-0` reads best and is what a row near the top gets. It is wrong for a row
 * near the *bottom*: the panel grows downward from the row's own top edge, so on
 * the last screenful it runs under the phone's tab bar — measured at 390px, a
 * row at y=666 put 55px of panel, which is exactly the excerpt, behind the six
 * tabs. Moving the whole thing above the tab bar is what the old portal did and
 * is the thing this pass removed, so the answer is not to move it off the row;
 * it is to hang it off the row's other edge, where on a low row there is a whole
 * screen of room.
 *
 * Measured when the peek opens rather than on every render, because the only
 * moment the answer matters is the moment it appears.
 */
function usePeekAbove(peeking: boolean, of: { current: HTMLElement | null }): boolean {
  const [above, setAbove] = useState(false)
  useEffect(() => {
    if (!peeking) return
    const r = of.current?.getBoundingClientRect()
    if (!r) return
    setAbove(r.top + PEEK_H > window.innerHeight - navStrip())
  }, [peeking, of])
  return peeking && above
}

/**
 * What a double tap answers with, on the row it was aimed at.
 *
 * Deliberately *not* the detail. The pane is what a tap opens and it is a place
 * you go — it takes the screen, it acknowledges the card, and coming back is a
 * dismissal. The peek is a look: it says who this is with, why it is on the
 * desk, and the first three lines of what was actually said, and then it goes
 * away on the next thing you do. Nothing about it is a decision, so nothing
 * about it is committed — it does not acknowledge, it does not select, and it
 * does not change the URL.
 *
 * **It is drawn on its own row, and that is the change.** This used to be a
 * `fixed` panel portalled to `document.body` and parked above the tab bar,
 * which put the answer at the bottom of the screen no matter which row was
 * asked — twenty rows, one place, and a reader whose thumb was at the top of
 * the list had to look somewhere else to read what it said. Anchored to the
 * row's own top edge it needs no portal, no `z-50`, and no arithmetic about
 * `--nav-h` at all: it cannot cover the tab bar because it is nowhere near it.
 *
 * `pointer-events-none` is the promise that survives unchanged: the panel
 * cannot be tapped, so it can never be a thing you have to get out of. Any
 * pointer that goes down anywhere — including through it, onto the row
 * underneath — dismisses it, as does Escape and as does any scroll, captured so
 * that a scroll inside the table counts too.
 *
 * The caller supplies the positioning, because the two layouts hang it off
 * different boxes: the row-card is `relative` and takes `inset-x-0`, and the
 * table row cannot be a containing block at all, so it hangs off the same 0px
 * sticky cell the drawer already uses. Everything below the position is one
 * component, so a peeked row says the same thing at every width.
 */
function RowPeek({ card, onClose, className }: {
  card: Card
  onClose: () => void
  /** Where it hangs. See the note above on why this is the caller's. */
  className: string
}) {
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

  return (
    <div
      role="tooltip"
      className={`${className} pointer-events-none flex flex-col gap-2
                 rounded-panel border border-edge glass p-3`}
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
    </div>
  )
}

/* ------------------------------ the phone list ---------------------------- */

/**
 * One card of the desk, below `sm`, as a row rather than as four columns.
 *
 * **What this replaces, and why it had to go.** The phone rendered the same
 * table the laptop does at its own narrower widths, in a scroller of its own:
 * `Title · Status · Where · Due` needs 552px and a 375px screen gives the page
 * column 343, so the answer was to move the table under the finger. Screenshot
 * at 375: `WHO` cut off mid-word at the right edge, before any finger moved.
 * Every argument for that layout is still true — status, deadline, customer and
 * person really are the four facts that decide whether a row is opened at 7am —
 * and every one of them was reachable only by remembering that the table moves
 * and then moving it. A column that has to be discovered is not a column.
 *
 * So the four facts stay and the grid goes. The title takes the first line at
 * full width, and the second line carries the status, who it is with, and when
 * it is wanted. Nothing is clipped by a viewport edge and nothing scrolls
 * sideways — the page column cannot, `App.tsx` sees to that, and this no longer
 * asks it to.
 *
 * The title clips at two lines rather than one, which is the one deliberate
 * clip left. `truncate` on a 343px line ends most Slack threads inside their
 * first clause; two lines is about 90 characters, and the long press behind
 * this row shows the rest without committing to anything. `titleOf` admits a
 * collector's own hard cut on the way through.
 *
 * The status is the `StatusPicker`, so the phone's only visible status is also
 * the control that changes it — a chip a thumb lands on and nothing happens is
 * a trap, and `Done · Status · Delete` behind the swipe is the second route
 * rather than the only one.
 *
 * The swipe is the desk's, unchanged, at its default `pan-y`: there is no
 * competing horizontal scroller on this layout any more, so the row keeps the
 * horizontal axis outright and the `data-atend` handover the phone *table*
 * needs has nothing to arbitrate here.
 */
function RowCard({
  card, selected, focused, actions, onPeek, peeking,
}: {
  card: Card
  selected: boolean
  focused: boolean
  actions: RowAction
  /** Show the peek for this row. The card is still a tap away and unaffected. */
  onPeek: (c: Card | null) => void
  /** Whether this row is the one being peeked. The panel is drawn on it. */
  peeking: boolean
}) {
  const ref = useRef<HTMLLIElement | null>(null)
  const words = dueWords(card.due_at)
  const overdue = card.due_at !== null && card.due_at < Date.now()
  const kind = cardKind(card)
  const where = contextLine(card)
  const name = titleOf(card)
  const swipe = useSwipe(card.group_key, actionsOn(actions))
  const tap = useDoubleTap(() => onPeek(card), () => actions.onOpen(card))
  const peekAbove = usePeekAbove(peeking, ref)

  // The `j`/`k` cursor reaches this layout too, and a selection nobody can see
  // is worse than none — the same line the table row spends on the same problem.
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: 'nearest' }) }, [focused])

  return (
    <li
      ref={n => { ref.current = n; swipe.bind.ref(n) }}
      onPointerDown={e => { swipe.bind.onPointerDown(e); tap.onPointerDown(e) }}
      onPointerMove={swipe.bind.onPointerMove}
      onPointerUp={swipe.bind.onPointerUp}
      onPointerCancel={e => { swipe.bind.onPointerCancel(e); tap.onPointerCancel() }}
      /* The drawer still eats the click a swipe produces, and that is also what
         stops a swipe being read as half of a double tap: `onClick` never runs. */
      onClickCapture={swipe.bind.onClickCapture}
      data-swipe={swipe.bind['data-swipe']}
      /* `WebkitTouchCallout` beside the gesture's own style. The long press it
         was defending against is gone, but the callout is not about the peek —
         a press-and-hold on a row of text still raises iOS's selection
         magnifier over a row whose whole job is to be tapped. */
      style={{ ...swipe.bind.style, WebkitTouchCallout: 'none' }}
      onClick={tap.onClick}
      /* `aria-current`, where both tables say `aria-selected`, and the swap is
         not cosmetic: `aria-selected` is only defined on a handful of roles —
         row, option, tab, gridcell — and a plain `<li>` is none of them, so on
         this layout it is an attribute assistive technology drops on the floor.
         `aria-current` is global and means exactly this: the one item in a set
         that is currently being shown. */
      aria-current={selected ? 'true' : undefined}
      /* `relative`, because the drawer pins itself to `right: 0` of whatever
         contains it and this row is that container. No `overflow-hidden`: the
         drawer already clips itself to the width the finger has revealed, and
         clipping here would eat the status control's 44px collar instead. */
      /*
       * A pane, not a strip between two hairlines.
       *
       * The rule that separated rows is gone on this layout and the separation
       * is now the gap between them — which is the shape the material asks for
       * and, on a phone, the shape that makes a row a target rather than a line
       * of text. `overflow-hidden` is what keeps the swipe drawer inside the
       * corner radius; it is safe here and not on the pre-material row because
       * the drawer is the only thing that reaches the row's right edge, and it
       * is `inset` rather than outset.
       *
       * `row-skip` lets the browser not paint this row while it is off screen —
       * see `styles.css`. It is the single biggest thing on a 74-row list and it
       * needs the fixed height hint that the class carries, which is why it goes
       * on the `<li>` and not on the `<ul>`.
       */
      /*
       * `px-3`, which the row did not have and every other list in the product
       * does: Mail's thread row is `px-3 py-2`, a session is `p-3`, a task is
       * padded by its own body. This one was flush, which was right while a row
       * was a strip of page between two hairlines and is wrong now that it is a
       * visible pane — a title starting on the pane's own left border reads as
       * text that has overflowed rather than as text that is inside something.
       *
       * It does move the desk's content 12px in from the page x, which the pad
       * note in `styles.css` argues against. That rule was written for a flat
       * page where an inset was decoration; inside a pane it is the pane's
       * padding, every other list already spends it, and the alternative is one
       * list in the product that looks like the pane forgot to hold it.
       */
      className={`press-row row-skip relative cursor-pointer overflow-hidden
        rounded-card border border-edge glass-edge px-3 py-2
        ${rowStateClass({ selected, focused, unseen: card.activity.count > 0 })}`}
    >
      <SwipeDrawer
        offset={swipe.offset} live={swipe.live} width={swipe.width} onClose={swipe.close}
        {...drawerFor(card, actions)}
      />

      {/* The row is already the containing block the drawer needs, so the peek
          costs nothing extra here: `inset-x-0 top-0` is the row's own top edge,
          full width, and there is no scroller on this layout to clip it. */}
      {peeking && (
        <RowPeek
          card={card}
          onClose={() => onPeek(null)}
          className={`absolute inset-x-0 z-30 ${peekAbove ? 'bottom-full mb-1' : 'top-0'}`}
        />
      )}

      <div className="flex items-start gap-2 min-w-0">
        {/* Named for the source rather than the kind: the shape is what a
            sighted reader tells them apart by, and the hue that carries the
            source is exactly the half a screen reader cannot see. */}
        <span role="img" aria-label={SOURCE_LABEL[kind.source]} title={SOURCE_LABEL[kind.source]}
          className="w-5 shrink-0 flex items-center h-6">
          <KindGlyph kind={kind} size={14} />
        </span>
        <span className={`grow min-w-0 ${ROW_TITLE} line-clamp-2
          ${isSettled(card.status) ? 'line-through text-fg-dim' : ''}`}>
          {name}
        </span>
        <span className="shrink-0 mt-0.5 flex items-center gap-2">
          <PriorityGlyph priority={card.priority} />
          <CountBadge count={card.activity.count} plus title={NEW_TITLE} />
        </span>
      </div>

      {/* Indented onto the title's own left edge rather than the glyph's, so the
          two lines of a row read as one block and twenty rows read as one
          column. The deadline is right-aligned for the same reason the table
          gives it a column: it is the one fact scanned down the page rather
          than read across a row. */}
      <div className="mt-1 pl-7 flex items-center gap-2 min-w-0">
        <StatusPicker value={card.status} onChange={s => actions.onStatus(card, s)} />
        {where && <span className={`${ROW_SECOND} truncate min-w-0`}>{where}</span>}
        <span className={`ml-auto shrink-0 ${overdue ? 'text-sm text-bad tnum'
          : words ? ROW_META : 'text-sm text-fg-mute'}`}>
          {words ?? '—'}
        </span>
      </div>
    </li>
  )
}

/**
 * The desk below `sm`: a list of rows, and no scroller of any kind.
 *
 * A real `<ul>`, because this is a list and the thing it replaces was a table
 * pretending a phone could reach its columns. There is no wrapper with an
 * `overflow` on either axis: the page scrolls vertically the way a page does,
 * and nothing here is wider than the column it sits in, so there is nothing to
 * scroll horizontally and nothing to fight the row's own swipe for the axis.
 *
 * A double tap answers with the same `RowPeek` the phone table uses — one
 * component, so a peeked row says the same thing at every width it can be
 * peeked at.
 */
export function CardList({
  rows, selectedKey, cursorKey, actions,
}: {
  rows: Card[]
  selectedKey: string | null
  /** The row the `j`/`k` cursor is standing on, or null when nobody chose one. */
  cursorKey: string | null
  actions: RowAction
}) {
  const [peek, setPeek] = useState<Card | null>(null)

  return (
    /*
     * A stack of panes with air between them.
     *
     * The top rule is gone with the row rules: it was the `<thead>` line doing
     * the one job it still had here — saying where the list starts — and a row
     * that is visibly its own object says that by existing. What replaced it is
     * the gap, which also has to be paid at the top so the first pane does not
     * sit against the filter control.
     *
     * 8px, matching the file's own gap scale. Anything under it and the panes
     * read as one striped block; anything over and a 390px screen loses a row
     * per screenful to air.
     */
    <ul className="flex flex-col gap-2 pt-2">
      {rows.map(c => (
        <RowCard
          key={c.group_key} card={c}
          selected={c.group_key === selectedKey}
          focused={c.group_key === cursorKey}
          actions={actions}
          onPeek={setPeek}
          peeking={peek?.group_key === c.group_key}
        />
      ))}
    </ul>
  )
}
