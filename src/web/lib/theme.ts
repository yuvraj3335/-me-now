/**
 * Light, dark, or whatever the machine says.
 *
 * Three states rather than a boolean, because "follow the system" is a real
 * choice and not the absence of one: a phone that goes dark at sunset should
 * take the app with it unless you have said otherwise.
 *
 * The chosen theme is stamped on <html> as `data-theme`, and "system" is
 * expressed by removing the attribute entirely — which is what lets the
 * stylesheet's `prefers-color-scheme` block apply without fighting an explicit
 * value. See styles.css for the palettes themselves.
 *
 * The very first paint is handled by an inline script in index.html, not here.
 * By the time this module runs, React has already rendered once, and a theme
 * applied at that point is a visible flash of the wrong colours.
 */

import { useCallback, useSyncExternalStore } from 'react'

export type Theme = 'system' | 'light' | 'dark'

const KEY = 'wake:theme'
const listeners = new Set<() => void>()

const isTheme = (v: unknown): v is Theme => v === 'system' || v === 'light' || v === 'dark'

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return isTheme(v) ? v : 'system'
  } catch {
    // Private mode, or storage disabled. Following the system is the right
    // fallback: it is what the stylesheet does with no attribute set.
    return 'system'
  }
}

function apply(t: Theme) {
  const root = document.documentElement
  if (t === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', t)
}

export function setTheme(t: Theme) {
  try {
    if (t === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, t)
  } catch {
    /* the choice still applies to this tab; it just will not survive a reload */
  }
  apply(t)
  listeners.forEach(l => l())
}

/**
 * The theme as chosen, plus the one actually being shown.
 *
 * Both are needed: the toggle highlights the choice, and a label saying
 * "following your system — dark right now" is only true if something asked.
 */
export function useTheme(): { theme: Theme; resolved: 'light' | 'dark'; set: (t: Theme) => void } {
  const theme = useSyncExternalStore(
    useCallback((l: () => void) => {
      listeners.add(l)
      // A system-level switch changes the resolved theme without changing the
      // choice, so the label has to re-read.
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', l)
      return () => {
        listeners.delete(l)
        mq.removeEventListener('change', l)
      }
    }, []),
    readTheme,
    () => 'system' as Theme,
  )

  const resolved: 'light' | 'dark' =
    theme !== 'system'
      ? theme
      : typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'

  return { theme, resolved, set: setTheme }
}
