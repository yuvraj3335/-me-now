/**
 * Is anything modal on screen?
 *
 * The Now page binds `j`, `k`, `e` and `s` to the document, and skipped only
 * INPUT / TEXTAREA / contentEditable. A `role="dialog" aria-modal="true"` panel
 * is none of those, and the launch sheet's focus after opening lands on a
 * BUTTON — so `e` (Done) and `s` (Later), both destructive and both unconfirmed,
 * stayed live *through* an open modal. Verified: Open went 19 → 18 with the
 * launch dialog still up, and the `Marked done. ↩ Undo` toast rendered
 * underneath the scrim where it could not be reached.
 *
 * A counter rather than a boolean, because two overlays can legitimately be
 * open at once (a sheet that opens the palette), and the last one to close is
 * the one that should restore the keyboard.
 *
 * Module-level rather than context: the thing that needs the answer is a
 * `document` keydown listener, which is not inside anybody's tree.
 */

import { useEffect } from 'react'

let depth = 0
/** The page's own overflow, captured once when the first overlay opened. */
let restoreOverflow: string | null = null

/** True while any modal surface is mounted and open. */
export const overlayOpen = () => depth > 0

/**
 * Count this overlay while `open`. Every modal surface calls this — `Sheet` and
 * the command palette between them cover all of them — so a new one is counted
 * by construction rather than by remembering.
 */
export function useOverlay(open: boolean) {
  useEffect(() => {
    if (!open) return
    // The body lock is owned here rather than by each sheet. `Sheet` used to
    // capture and restore `body.style.overflow` itself, and `Work.tsx` mounts
    // two of them at once — so two sheets closing in the wrong order restored
    // `hidden` over `''` and froze the page behind them. One owner, one capture,
    // released only when the last overlay closes.
    if (depth === 0 && typeof document !== 'undefined') {
      restoreOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    depth++
    return () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0 && typeof document !== 'undefined') {
        document.body.style.overflow = restoreOverflow ?? ''
        restoreOverflow = null
      }
    }
  }, [open])
}

/**
 * How much of the bottom of the screen the tab bar already owns.
 *
 * A panel that opens *downward* — the `Menu` dropdown, the desk's
 * `StatusPicker` — decides between opening down and flipping up by asking how
 * much room is below its trigger. Both asked `window.innerHeight`, which is the
 * bottom of the *viewport* and not the bottom of the usable page: below `sm`
 * the last `--nav-h` of that viewport is the tab bar. Since both panels render
 * `fixed` at `z-[55]` and the bar is `z-30`, the panel wins the paint and the
 * failure is not that it disappears — it is that a picker offered five statuses
 * with the last two lying across Desk, Mail and Work, and on a phone with a
 * home indicator the bottom row sits in the strip iOS reserves for its own
 * gesture.
 *
 * Measured off the bar itself rather than read from `--nav-h`, because that
 * token is `calc(53px + max(env(safe-area-inset-bottom), 0px))` and a custom
 * property holding a `calc()` does not resolve to a number through
 * `getComputedStyle().getPropertyValue()` — it comes back as the text. The
 * element knows its own height, including whatever the device puts under it,
 * and it is `display: none` from `sm` up, where `getBoundingClientRect()`
 * answers 0 and the desktop rail is not in the way of anything.
 */
export function navStrip(): number {
  if (typeof document === 'undefined') return 0
  const bar = document.querySelector('[data-navbar]')
  return bar ? bar.getBoundingClientRect().height : 0
}
