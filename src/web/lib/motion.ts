import { useEffect, useState } from 'react'
import { useReducedMotion } from 'motion/react'

/**
 * `?static=1` renders every animated mark at its end state. Screenshot tooling
 * and headless panes often never fire requestAnimationFrame, which freezes
 * motion at its `initial` value and makes a correct chart look broken.
 */
export const STATIC_MODE =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('static')

/**
 * Whether this document is currently being painted.
 *
 * A hidden tab does not schedule animation frames, so an animation started in
 * one never advances: an entrance stays frozen at `initial`, and an exit never
 * completes, which means `AnimatePresence` never unmounts the row it is
 * animating away. Both failures outlive the hidden state, because the frame
 * that would have finished them was owed while nobody was looking.
 *
 * This is the same class of bug the page transition in `App.tsx` already avoids
 * by refusing to animate out at all; `useStill` folds the condition in so every
 * other animated mark gets it too, rather than each one rediscovering it.
 */
function useHiddenDocument(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const sync = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  return hidden
}

/**
 * True when nothing should animate. Note this is deliberately not
 * `useReducedMotion()` alone: that hook reads the media query and does not see
 * MotionConfig, so the static flag has to be OR'd in explicitly, and neither
 * of them knows whether frames are actually being produced.
 *
 * Every animated mark uses this to pick `initial={false}`, because an
 * animate-in that never runs must leave the mark visible rather than at zero
 * height, zero width or zero path length — and to drop its `exit`, because an
 * animate-out that never runs leaves the thing on screen for good.
 */
export function useStill(): boolean {
  // Every hook runs on every render: `||` would short-circuit past one.
  const reduced = !!useReducedMotion()
  const hidden = useHiddenDocument()
  return reduced || STATIC_MODE || hidden
}
