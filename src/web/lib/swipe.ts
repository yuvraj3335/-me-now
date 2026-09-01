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
 *
 *     A rubber band was tried, at both ends, and **removed — the architecture
 *     cannot show one.** The drawer is a clip window (see `swipe.tsx`): the row
 *     itself never translates, and the strip inside the window is drawn at
 *     `width - min(width, max(0, -v))`. That expression maps every offset past
 *     `-width` to "fully open" and every offset above `0` to "fully shut", so
 *     both overdrag ranges rendered *identically to the limit they were past*.
 *     Measured: not one pixel of the give reached the screen.
 *
 *     It was not merely invisible, it was negative. A right-drag on a closed row
 *     put the offset above zero, which mounted the drawer — 264px of an
 *     invisible, click-absorbing overlay across a 343px row — in exchange for no
 *     feedback at all. A hard clamp is the honest shape for a window that cannot
 *     stretch.
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
 * horizontal line would make the swipe fail for most humans.
 *
 * 1.5 was too tight, and it is the reason the drawer was reported as *hard to
 * open* rather than as broken. A thumb anchored at the bottom-right of a phone
 * does not travel along a row, it travels along the arc its joint allows: a
 * deliberate 60px swipe that drifts 40px down the screen is 1.5 exactly, which
 * this rejected, and every one of those became a page scroll instead. 1.2 still
 * refuses the case this defends against — a *vertical* scroll begun with a
 * lean, where the vertical component is the larger one and `axisFor` answers
 * `y` on the tie regardless — because that gesture is not 1.2 horizontal, it is
 * less than 1.
 */
export const SWIPE_AXIS_RATIO = 1.2

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

/**
 * The narrower box a four-action drawer uses, and why there are two numbers.
 *
 * Three at 88 is 264px, which the paragraph above is written about: on a 390px
 * phone it leaves the row's glyph and the first few words of its title showing,
 * so it stays obvious which row is about to be acted on.
 *
 * Four at 88 is **352**, and the narrowest row in the product is 343px wide at
 * 375. The drawer would cover the row completely — every action legible, and no
 * way to tell which of twenty rows you were about to finish. That is a worse
 * failure than a cramped label, because it is silent.
 *
 * 66 is chosen so that four of them come to exactly 264: the same total the
 * three-action drawer already has, so the fourth action costs the title nothing
 * and the number is one this file has already defended. It is still well clear
 * of the 44px floor `min-w-11` puts under a touch target, and the longest label
 * on it (`Status`, `Delete`) measures ~40px at `text-sm`.
 */
export const SWIPE_ACTION_W_TIGHT = 66

/** One action's box, given how many are sharing the row. */
export const swipeActionWidth = (n: number) =>
  n >= 4 ? SWIPE_ACTION_W_TIGHT : SWIPE_ACTION_W

/** The revealed width for a row offering `n` actions. */
export const swipeWidth = (n: number) => n * swipeActionWidth(n)

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

/**
 * How the drawer settles once the finger is gone.
 *
 * A spring rather than a duration, because the gesture it is continuing has no
 * duration either — the row was tracking a thumb one-to-one a frame ago, and a
 * fixed 180ms ease-out from wherever that thumb happened to stop is the moment
 * the surface stops feeling attached to the hand.
 *
 * Damping ratio 0.935 — just under critical, measured rather than claimed:
 * `42 / (2√(560 × 0.9))`. That is deliberately not 1. A touch under critical
 * settles visibly faster than a critically-damped spring of the same stiffness
 * and its single overshoot is a fraction of a pixel at these distances, so the
 * drawer never appears past its own labels. What it does mean is that the value
 * keeps moving for a few hundred milliseconds after the drawer looks shut — see
 * the `onUpdate` in `settle`, which unmounts on what is on screen rather than on
 * `onComplete`, because for a while it was leaving an invisible overlay across
 * the row eating taps.
 *
 * `restDelta` is the pixel it is allowed to stop short by. Without it a spring
 * animates for another few hundred milliseconds converging on a difference no
 * screen can draw, and the drawer counts as still moving that whole time.
 */
export const SWIPE_SPRING = {
  type: 'spring',
  stiffness: 560,
  damping: 42,
  mass: 0.9,
  restDelta: 0.5,
} as const

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
