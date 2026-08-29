import { useReducedMotion } from 'motion/react'

/**
 * `?static=1` renders every animated mark at its end state. Screenshot tooling
 * and headless panes often never fire requestAnimationFrame, which freezes
 * motion at its `initial` value and makes a correct chart look broken.
 */
export const STATIC_MODE =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('static')

/**
 * True when nothing should animate. Note this is deliberately not
 * `useReducedMotion()` alone: that hook reads the media query and does not see
 * MotionConfig, so the static flag has to be OR'd in explicitly.
 *
 * Every animated mark uses this to pick `initial={false}`, because an
 * animate-in that never runs must leave the mark visible rather than at zero
 * height, zero width or zero path length.
 */
export function useStill(): boolean {
  return !!useReducedMotion() || STATIC_MODE
}
