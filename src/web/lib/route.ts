/**
 * Wake's router.
 *
 * Six routes still do not justify a routing dependency. Three things do justify
 * more than the fifteen lines this replaces:
 *
 *  1. **The query string is state.** A source filter that is not in the URL
 *     cannot be bookmarked, and it does not survive the reload that happens
 *     mid-triage. The old `go()` dropped `location.search` outright, which also
 *     killed the screenshot harness's own `?static=1` on the first tab click.
 *  2. **The fragment is the open detail.** `#card/<group_key>` is why the
 *     phone's Back button closes the detail instead of leaving Wake, and it is
 *     why the laptop's pane and the phone's full-screen view are one piece of
 *     state read twice rather than two `useState`s that can disagree.
 *  3. **A filter change is a replace; opening a row is a push.** Twenty filter
 *     clicks must not be twenty presses of Back to get out of Now, and one
 *     press of Back must close one detail.
 *
 * A module-level store rather than context: a card is opened from the table, the
 * palette and a notification's deep link, and the shell renders above all three.
 */

import { useSyncExternalStore } from 'react'

export type Route = {
  /** `location.pathname`. */
  path: string
  /** `location.search`, including its leading `?`, or ''. */
  search: string
  /** The fragment with its `#` removed, or ''. */
  hash: string
}

const blank: Route = { path: '/', search: '', hash: '' }

const read = (): Route =>
  typeof window === 'undefined'
    ? blank
    : {
        path: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash.replace(/^#/, ''),
      }

let current = read()
const listeners = new Set<() => void>()

/** Re-read the address bar; notify only when something actually moved. */
function sync() {
  const next = read()
  if (next.path === current.path && next.search === current.search && next.hash === current.hash) return
  current = next
  for (const l of listeners) l()
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', sync)
  // Some browsers fire only this for a fragment change made outside history.
  window.addEventListener('hashchange', sync)
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
const snapshot = () => current

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** One query parameter, live. `null` when it is absent. */
export function useParam(key: string): string | null {
  const { search } = useRoute()
  return new URLSearchParams(search).get(key)
}

/**
 * The parameters that survive a navigation between destinations.
 *
 * Deliberately short. `?src=` is Now's filter and means nothing on Mail, so it
 * is dropped; `?static` is the screenshot harness telling every animated mark to
 * render at its end state, and losing it on the first tab click is what made
 * captures of every page but the first one look broken.
 */
const CARRIED = ['static']

const base = () => `${window.location.pathname}${window.location.search}`

/** Go to a destination. Clears the filter and any open detail. */
export function navigate(path: string) {
  const from = new URLSearchParams(window.location.search)
  const keep = new URLSearchParams()
  for (const k of CARRIED) {
    const v = from.get(k)
    if (v !== null) keep.set(k, v)
  }
  const qs = keep.toString()
  const url = `${path}${qs ? `?${qs}` : ''}`

  // Tapping the destination you are already on scrolls to the top rather than
  // stacking an identical history entry.
  if (url === base() && !window.location.hash) {
    return window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  window.history.pushState({}, '', url)
  sync()
  window.scrollTo(0, 0)
}

/**
 * Set or clear one query parameter, in place.
 *
 * `replaceState`, because a filter is a view of the page you are on and not a
 * place you went to.
 */
export function setParam(key: string, value: string | null) {
  const params = new URLSearchParams(window.location.search)
  if (value === null || value === '') params.delete(key)
  else params.set(key, value)
  const qs = params.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
  )
  sync()
}

/* --------------------------- the open detail ------------------------------ */

const CARD = 'card/'

/** Which card the address bar says is open, if any. */
export function detailKeyOf(hash: string): string | null {
  if (!hash.startsWith(CARD)) return null
  try {
    return decodeURIComponent(hash.slice(CARD.length)) || null
  } catch {
    return null
  }
}

export function useDetailKey(): string | null {
  return detailKeyOf(useRoute().hash)
}

/**
 * Open a card's detail.
 *
 * A push, so one press of Back closes it — on a phone that is the OS Back
 * button, and the detail is a full-screen view rather than a sheet, so Back
 * closing it is the behaviour the whole platform already trained. Moving from
 * one row to the next replaces instead of pushing: twenty rows read in sequence
 * is one thing you were doing, not twenty places you went.
 */
export function openDetail(key: string) {
  const url = `${base()}#${CARD}${encodeURIComponent(key)}`
  const method = window.history.state?.wakeDetail ? 'replaceState' : 'pushState'
  window.history[method]({ wakeDetail: true }, '', url)
  sync()
}

export function closeDetail() {
  // If Wake pushed the entry, unwind it, so the history stack does not grow a
  // step that Back would use to re-open what was just closed.
  if (window.history.state?.wakeDetail) return window.history.back()
  window.history.replaceState({}, '', base())
  sync()
}
