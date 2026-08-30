/**
 * The gesture that reveals a row's actions, held to its own thresholds.
 *
 * None of this can be observed from the DOM in this suite — there is no layout
 * engine here and there are no fingers — so what is pinned is the arithmetic
 * that decides, on every pointermove, whether the reader is swiping, scrolling,
 * or has not yet done either. Those three answers are the whole feature: get the
 * first wrong and taps stop opening rows, get the second wrong and the page
 * stops scrolling under a thumb, get the third wrong and the row twitches under
 * every touch that lands on it.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import {
  axisFor, clampSwipe, openSwipeKey, setOpenSwipe, snapSwipe, subscribeSwipe,
  SWIPE_ACTION_W, SWIPE_AXIS_RATIO, SWIPE_ENGAGE_PX, swipeWidth,
} from '../src/web/lib/swipe'

describe('neither axis owns the gesture until one of them wins', () => {
  test('a short travel is still a click', () => {
    // Below the threshold nothing moves at all, in any direction. A row that
    // shifts under a tap reads as a misfire even when the tap lands.
    expect(axisFor(0, 0)).toBe('undecided')
    expect(axisFor(-11, 0)).toBe('undecided')
    expect(axisFor(0, 11)).toBe('undecided')
    expect(axisFor(-8, -8)).toBe('undecided')
  })

  test('a clean horizontal drag past the threshold is the swipe', () => {
    expect(axisFor(-SWIPE_ENGAGE_PX, 0)).toBe('x')
    expect(axisFor(-40, 2)).toBe('x')
    // Right is still the x axis — `clampSwipe` is what refuses to draw it.
    expect(axisFor(40, 0)).toBe('x')
  })

  test('a thumb travelling in an arc still counts as horizontal', () => {
    // Requiring a straight line would make the swipe fail for most humans. Just
    // inside the ratio is a swipe; just outside it is not.
    const dy = 10
    expect(axisFor(-(SWIPE_AXIS_RATIO * dy + 1), dy)).toBe('x')
    expect(axisFor(-(SWIPE_AXIS_RATIO * dy - 1), dy)).not.toBe('x')
  })

  test('vertical wins the ties, because scrolling costs more to break', () => {
    expect(axisFor(0, 30)).toBe('y')
    expect(axisFor(-20, 18)).toBe('y')
    expect(axisFor(-15, 15)).toBe('y')
  })

  test('any real vertical travel settles it, so a scroll is never left waiting', () => {
    // This is the half that has to be total. A gesture still `undecided` while
    // the finger is 12px down the page is a page that has not started
    // scrolling, and that reads as a frozen app — whereas an undecided
    // *horizontal* wobble is simply a tap that has not finished, which is what
    // it should be.
    for (let dx = -60; dx <= 60; dx += 3) {
      for (let dy = -60; dy <= 60; dy += 3) {
        if (Math.abs(dy) < SWIPE_ENGAGE_PX) continue
        expect(axisFor(dx, dy), `${dx},${dy}`).not.toBe('undecided')
      }
    }
  })

  test('a drag that is already a swipe stays one as it grows', () => {
    // The component locks the axis on the first answer, but a rule that changed
    // its mind mid-drag would mean the lock was hiding a bug rather than
    // enforcing a decision.
    for (let dx = -SWIPE_ENGAGE_PX; dx >= -400; dx -= 7) {
      expect(axisFor(dx, 4), `${dx}`).toBe('x')
    }
  })
})

describe('the drawer is bounded and it snaps', () => {
  const W = swipeWidth(3)

  test('three actions are three action widths', () => {
    expect(W).toBe(3 * SWIPE_ACTION_W)
    expect(swipeWidth(2)).toBe(2 * SWIPE_ACTION_W)
  })

  test('it opens leftward only', () => {
    // A right swipe on a closed row is a gesture with nothing behind it, and
    // letting the row travel right would promise a second drawer.
    expect(clampSwipe(50, W)).toBe(0)
    expect(clampSwipe(-10, W)).toBe(-10)
    expect(clampSwipe(-9_000, W)).toBe(-W)
  })

  test('a row with no actions cannot be dragged at all', () => {
    expect(clampSwipe(-100, 0)).toBe(0)
  })

  test('there is no resting state between open and shut', () => {
    // Half open is a row whose actions are all half-labelled.
    expect(snapSwipe(-1, W)).toBe(0)
    expect(snapSwipe(-(W / 2 - 1), W)).toBe(0)
    expect(snapSwipe(-(W / 2), W)).toBe(-W)
    expect(snapSwipe(-W, W)).toBe(-W)
    expect(snapSwipe(-W * 3, W)).toBe(-W)
  })
})

describe('exactly one row is open', () => {
  beforeEach(() => setOpenSwipe(null))

  test('opening one closes the last', () => {
    setOpenSwipe('card:a')
    expect(openSwipeKey()).toBe('card:a')
    setOpenSwipe('task:b')
    expect(openSwipeKey()).toBe('task:b')
    setOpenSwipe(null)
    expect(openSwipeKey()).toBeNull()
  })

  test('subscribers hear every change and no non-changes', () => {
    // Every row on the desk subscribes, so a notification for a value that did
    // not move is a re-render of twenty rows for nothing.
    let beats = 0
    const off = subscribeSwipe(() => { beats++ })

    setOpenSwipe('card:a')
    expect(beats).toBe(1)
    setOpenSwipe('card:a')
    expect(beats, 'the store notified about a value that did not change').toBe(1)
    setOpenSwipe('card:c')
    expect(beats).toBe(2)

    off()
    setOpenSwipe(null)
    expect(beats, 'unsubscribing left the listener attached').toBe(2)
  })
})
