/**
 * The detail pane's width, which he now gets to set.
 *
 * The bounds are the interesting part, and they are not taste. Below 320 the
 * fact table's two columns stop leaving the value anything to be and the action
 * bar wraps to three lines; above 640 the list beside it loses `Where` and then
 * starts eating the elastic Title column, which is four pixels above its floor
 * at 1440. So the clamp is what keeps a drag from taking the list apart, and a
 * stored value is a number from a previous version of the app, from another
 * tab, or from a reader who has been experimenting — none of which the pane may
 * trust.
 */

import { describe, expect, test } from 'bun:test'
import {
  clampPane, PANE_DEFAULT_W, PANE_MAX_W, PANE_MIN_W, readPane, writePane,
} from '../src/web/lib/pane'
import { columnsFor, maxPaneFor, PANE_MIN } from '../src/web/components/CardTable'

/** A `localStorage` that is only a map, and one that is only a fault. */
const fake = (seed?: string) => {
  let held = seed
  return {
    getItem: () => held ?? null,
    setItem: (_k: string, v: string) => { held = v },
    read: () => held,
  }
}
const hostile = {
  getItem: () => { throw new Error('SecurityError: the operation is insecure') },
  setItem: () => { throw new Error('QuotaExceededError') },
}

describe('a dragged width cannot take the list apart', () => {
  test('it is held between the two measured bounds', () => {
    expect(clampPane(10)).toBe(PANE_MIN_W)
    expect(clampPane(-4_000)).toBe(PANE_MIN_W)
    expect(clampPane(9_000)).toBe(PANE_MAX_W)
    expect(clampPane(PANE_DEFAULT_W)).toBe(PANE_DEFAULT_W)
  })

  test('the default sits inside them, which is what makes a reset a reset', () => {
    expect(PANE_DEFAULT_W).toBeGreaterThanOrEqual(PANE_MIN_W)
    expect(PANE_DEFAULT_W).toBeLessThanOrEqual(PANE_MAX_W)
  })

  test('a fractional drag lands on a whole pixel', () => {
    expect(clampPane(412.6)).toBe(413)
  })
})

describe('the bound knows how much room there is', () => {
  /*
   * The failure this exists for, measured: at 1280 — the exact width at which
   * the pane first appears — a pane dragged to its 640 ceiling left the list 392
   * pixels for 396 pixels of fixed columns. Under `table-fixed` the one unsized
   * column takes what the others leave, so Title was allocated *minus four*,
   * rendered as zero, and every row on the desk showed a blank title inside a
   * table wider than its own column. The width is persisted, so dragging wide on
   * a 1920 monitor reproduced it on the 1280 laptop with no visible cause.
   */
  const TITLES = [1280, 1366, 1440, 1600, 1920, 2560]

  test('no width the pane can reach leaves the title column empty', () => {
    for (const w of TITLES) {
      const pane = clampPane(9_000, maxPaneFor(w))
      // 200 = RAIL, 48 = PAGE_PAD, 396 = every column that is not the title.
      const title = w - 200 - pane - 48 - 396
      expect(title, `${w}px: a fully dragged pane left the title ${title}px`)
        .toBeGreaterThanOrEqual(200)
    }
  })

  test('the pane still gets its 320 floor, and its 640 ceiling', () => {
    expect(clampPane(9_000, maxPaneFor(1280))).toBeLessThan(PANE_MAX_W)
    expect(clampPane(9_000, maxPaneFor(2560))).toBe(PANE_MAX_W)
    // A viewport that could not spare even the minimum does not get a pane
    // narrower than its minimum — that is a broken pane, not a smaller one.
    expect(clampPane(400, 100)).toBe(PANE_MIN_W)
  })

  test('the default width is still reachable at the width the pane appears', () => {
    // A bound tight enough to refuse the default would be a pane that resets to
    // a width it cannot be.
    expect(clampPane(PANE_DEFAULT_W, maxPaneFor(PANE_MIN))).toBe(PANE_DEFAULT_W)
  })

  test('a remembered width from a wider monitor is taken back, not honoured', () => {
    const stored = readPane(fake(String(PANE_MAX_W)))
    expect(stored).toBe(PANE_MAX_W)
    expect(clampPane(stored, maxPaneFor(1280))).toBeLessThan(PANE_MAX_W)
    // And the columns the list keeps are still a consistent set.
    expect(columnsFor(1280, clampPane(stored, maxPaneFor(1280))).why).toBe(true)
  })
})

describe('what was remembered is checked before it is believed', () => {
  test('a width from a previous session comes back', () => {
    expect(readPane(fake('468'))).toBe(468)
  })

  test('nothing remembered is the default, not zero', () => {
    expect(readPane(fake())).toBe(PANE_DEFAULT_W)
  })

  test('a value that is not a width is the default', () => {
    // `localStorage` is shared with every past and future build of this app. A
    // pane four pixels wide because a string parsed to 4 is a product that looks
    // broken with no way to tell why.
    for (const junk of ['', 'wide', '{"w":400}', 'NaN', '-1', '0']) {
      expect(readPane(fake(junk)), junk).toBe(PANE_DEFAULT_W)
    }
  })

  test('a width outside the bounds is pulled back inside them', () => {
    expect(readPane(fake('4000'))).toBe(PANE_MAX_W)
    expect(readPane(fake('40'))).toBe(PANE_MIN_W)
  })

  test('a storage that throws is not a crash', () => {
    // Safari in private mode throws on both. A remembered pane width is a
    // convenience and it is not worth a blank page.
    expect(readPane(hostile)).toBe(PANE_DEFAULT_W)
    expect(() => writePane(400, hostile)).not.toThrow()
  })

  test('what is written is what comes back, already clamped', () => {
    const store = fake()
    writePane(9_000, store)
    expect(store.read()).toBe(String(PANE_MAX_W))
    expect(readPane(store)).toBe(PANE_MAX_W)
  })
})
