/**
 * The type rungs, named once.
 *
 * Every one of these strings was already in the product, retyped at each site —
 * `text-eyebrow uppercase text-fg-mute` appeared eleven times, and three of the
 * eleven had quietly lost the `uppercase`. Naming a rung is not an abstraction
 * over Tailwind; it is the thing that makes "a row title" a decision made once
 * rather than a class list copied.
 *
 * It is a declared set, like the colour tokens in `styles.css`: every rung is
 * here whether or not a page currently reaches for it, because the point is
 * that the next page picks one rather than inventing a class string. A rung
 * with no caller today is not dead code, it is a scale with a gap in it.
 *
 * No new sizes. The seven `--text-*` tokens in `styles.css` are the whole scale,
 * and the hierarchy here comes from weight and contrast against that fixed set:
 * a 14/500 `fg` title over a 13/400 `fg-dim` second line is a 100-weight and
 * 6-point contrast gap inside one pixel of size, which is what makes a dense
 * table readable at a glance instead of merely small.
 */

export const PAGE_TITLE   = 'text-lg font-medium'
export const EYEBROW      = 'text-eyebrow uppercase text-fg-mute'
export const TABLE_HEAD   = 'text-eyebrow uppercase text-fg-mute font-medium text-left align-middle py-2 pr-4 truncate'
export const ROW_TITLE    = 'text-base font-medium text-fg'
export const ROW_SECOND   = 'text-sm text-fg-dim'
export const ROW_META     = 'text-sm text-fg-mute tnum'
export const DETAIL_TITLE = 'text-md font-medium tracking-[-0.01em]'
export const DETAIL_BODY  = 'text-base text-fg-dim'
export const MONO         = 'font-mono text-sm text-fg-dim'
export const HERO_NUM     = 'text-xl font-medium tnum text-fg'
export const HERO_WORD    = 'text-md font-medium text-fg'

/** Alignment by what a column holds, so a number column is never left-ragged. */
export const COL = { text: 'text-left', num: 'text-right tnum', actions: 'text-right' } as const

const DAY = 864e5

/**
 * A due date in the fewest words that still commit to something.
 *
 * Three registers, because a deadline means three different things depending on
 * where it sits relative to now. Past is the only one that carries a number of
 * days, because that number is the pressure. Today drops the date and keeps the
 * time, since on the day itself the date is the part he already knows. Anything
 * further out is a date with no time at all: a table cell is 96px, and `Sep 3`
 * against `Sep 3, 6:00pm` is the difference between scanning a column and
 * reading it.
 *
 * `null` in, `null` out — a card with no due date renders nothing here, and the
 * cell decides what nothing looks like.
 */
export function dueWords(dueAt: number | null, now = Date.now()): string | null {
  if (dueAt === null || dueAt === undefined) return null

  const midnight = (t: number) => {
    const d = new Date(t)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((midnight(dueAt) - midnight(now)) / DAY)

  if (dueAt < now) {
    // Overdue by less than a day is still `Overdue`, without a `0d` that reads
    // as "not overdue at all".
    const late = Math.floor((now - dueAt) / DAY)
    return late >= 1 ? `Overdue ${late}d` : 'Overdue'
  }
  if (days === 0) {
    return `Today ${new Date(dueAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`
  }
  return new Date(dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
