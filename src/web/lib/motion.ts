import { useEffect, useState, type RefObject } from 'react'
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

/**
 * Whether the viewport currently matches a media query, kept live.
 *
 * `Sheet` needs to know which of two entrances it is playing — a slide up
 * from the bottom edge on a phone, a scale-and-fade in place on a laptop —
 * and that is a fact about the viewport, not about `sm:` reaching an element
 * that was never given the class to react to it. A `matchMedia` listener is
 * what keeps the answer live across a resize or an orientation change; a
 * value read once at mount would leave a sheet opened before a rotation
 * still playing the phone entrance after it.
 */
export function useMediaQuery(query: string): boolean {
  const supported = typeof window !== 'undefined' && 'matchMedia' in window
  const [matches, setMatches] = useState(() => (supported ? window.matchMedia(query).matches : false))
  useEffect(() => {
    if (!supported) return
    const mq = window.matchMedia(query)
    const sync = () => setMatches(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [query, supported])
  return matches
}

/**
 * The pointer-tracked sheen on a `.glass` panel.
 *
 * `--glass-x`/`--glass-y` and `--glass-shine-o` are read by `.glass::before`
 * in `styles.css`; this is the only place anything writes them. Unset, the
 * variables default to the panel's own centre at zero opacity, so a `.glass`
 * surface nothing calls this on — and most of them, since it is wired in only
 * here and on `Menu` — paints exactly as it did before this existed.
 *
 * Fine pointers only. iOS fires a synthetic `pointermove` at the touch point
 * on first contact, so listening on a coarse pointer would light the sheen
 * exactly once, at the spot a thumb just pressed, and never move again — a
 * highlight that is wrong more often than it is right. `disabled` folds in
 * the caller's `useStill()`: a panel told nothing should be animating has no
 * business repainting a gradient on every pointer frame either.
 *
 * Written straight to the element's inline style rather than through React
 * state, because state would re-render the panel — and everything inside it —
 * on every pixel of pointer travel. `requestAnimationFrame` throttles to at
 * most one write per painted frame regardless of how fast events arrive.
 */
export function useGlassSheen<T extends HTMLElement>(ref: RefObject<T | null>, disabled: boolean): void {
  useEffect(() => {
    const el = ref.current
    if (!el || disabled) return
    if (typeof window === 'undefined' || !window.matchMedia('(any-pointer: fine)').matches) return

    let raf = 0
    const move = (e: PointerEvent) => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const r = el.getBoundingClientRect()
        el.style.setProperty('--glass-x', `${e.clientX - r.left}px`)
        el.style.setProperty('--glass-y', `${e.clientY - r.top}px`)
      })
    }
    const enter = () => el.style.setProperty('--glass-shine-o', '1')
    const leave = () => el.style.setProperty('--glass-shine-o', '0')

    el.addEventListener('pointermove', move)
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointerleave', leave)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointerleave', leave)
      el.style.removeProperty('--glass-x')
      el.style.removeProperty('--glass-y')
      el.style.removeProperty('--glass-shine-o')
    }
  }, [ref, disabled])
}
