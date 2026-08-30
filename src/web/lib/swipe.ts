/**
 * A left swipe reveals what a row can do, on a phone and on a laptop alike.
 *
 * The arithmetic lives here rather than inside the component for the same reason
 * the column widths live at the top of `CardTable.tsx`: it is the part that is
 * easy to get subtly wrong and impossible to notice afterwards. A threshold that
 * drifts from 12px to 4px does not break anything visibly — it just quietly
 * turns every tap near the edge of a row into a half-open drawer, and every
 * scroll that begins with a thumb roll into a gesture nobody asked for.
 *
 * Three rules, and they are the whole feature:
 *
 *  1. **Neither axis owns the gesture until one of them wins.** Below the
 *     engagement distance a drag is still a click, so tapping a row still opens
 *     it. Once `axisFor` answers `x` or `y` that answer is final for the rest of
 *     the gesture — a swipe that wanders vertically does not hand the page back
 *     its scroll halfway through, and a scroll that drifts sideways does not
 *     turn into a drawer under the finger.
 *  2. **Vertical wins ties.** The page scrolling and a task reordering are both
 *     vertical, they are both more common than the swipe, and getting them wrong
 *     costs more: a scroll that refuses to scroll reads as a frozen app.
 *  3. **The drawer is bounded and it snaps.** There is no rubber band and no
 *     resting state between open and shut, because a drawer stopped 40% of the
 *     way open is a row whose actions are all half-labelled.
 */

import { useSyncExternalStore } from 'react'

/**
 * How far the pointer travels before the row stops being a click.
 *
 * 12px is roughly a thumb's worth of slop on a phone and well past a mouse's
 * jitter on a laptop. Below it nothing moves at all — not one pixel — because a
 * row that shifts under a tap reads as a misfire even when the tap lands.
 */
export const SWIPE_ENGAGE_PX = 12

/**
 * How much more horizontal than vertical a gesture has to be to count as one.
 *
 * A finger sliding across a phone travels a real arc; requiring a pure
 * horizontal line would make the swipe fail for most humans. 1.5 is loose
 * enough for a thumb and tight enough that a scroll begun with a slight lean
 * never opens anything.
 */
export const SWIPE_AXIS_RATIO = 1.5

/**
 * One action's width.
 *
 * The label is a word, not a glyph, so this is sized by the widest of them
 * (`Not started` does not appear here; `Delete` and `Status` do) plus enough
 * air that a thumb landing anywhere in the box hits the action it can read.
 * Three of these is 264px, which is under half of a 390px phone — the row's own
 * title stays legible behind an open drawer, so it is still obvious which row
 * is about to be acted on.
 */
export const SWIPE_ACTION_W = 88

/** The revealed width for a row offering `n` actions. */
export const swipeWidth = (n: number) => n * SWIPE_ACTION_W

export type SwipeAxis = 'undecided' | 'x' | 'y'

/**
 * Which axis owns this gesture, given how far it has travelled so far.
 *
 * Total once either distance passes the threshold, which matters: an
 * `undecided` that could persist forever would be a gesture that is neither a
 * swipe nor a scroll, and the row would sit inert under a moving finger.
 */
export function axisFor(dx: number, dy: number): SwipeAxis {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax >= SWIPE_ENGAGE_PX && ax > SWIPE_AXIS_RATIO * ay) return 'x'
  // Everything else that has travelled far enough is the page's, not ours.
  if (ay >= SWIPE_ENGAGE_PX) return 'y'
  return 'undecided'
}

/**
 * The offset a row may actually be drawn at.
 *
 * Left only. A right swipe on a closed row is not a second drawer waiting to be
 * discovered, it is a gesture with nothing behind it, and letting the row travel
 * right would promise one.
 */
export function clampSwipe(dx: number, width: number): number {
  if (!(width > 0)) return 0
  return Math.max(-width, Math.min(0, dx))
}

/** Where the drawer lands when the finger lifts: open past halfway, else shut. */
export function snapSwipe(dx: number, width: number): number {
  return clampSwipe(dx, width) <= -width / 2 ? -width : 0
}

/* --------------------------- which row is open ---------------------------- */

/**
 * Exactly one row is open in the whole product, and it is not a piece of any
 * row's own state.
 *
 * A `useState` per row cannot answer "close whichever one is open" without every
 * row subscribing to every other row, and the desk renders twenty of them. This
 * is the same module-level store pattern the toast and the route use, for the
 * same reason: the fact is global, so it lives somewhere global.
 */
let openKey: string | null = null
const listeners = new Set<() => void>()

export function setOpenSwipe(key: string | null) {
  if (openKey === key) return
  openKey = key
  for (const l of listeners) l()
}

export function openSwipeKey(): string | null {
  return openKey
}

/**
 * Exported so the store's notifications can be observed without React.
 *
 * Every row on the desk subscribes to this, so a redundant notification is a
 * redundant render of twenty rows — which is why `setOpenSwipe` returns early
 * on a no-op, and why that is worth a test rather than a comment.
 */
export function subscribeSwipe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export function useOpenSwipe(): string | null {
  return useSyncExternalStore(subscribeSwipe, () => openKey, () => openKey)
}
