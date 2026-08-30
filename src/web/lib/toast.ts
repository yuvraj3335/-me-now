/**
 * One line at the bottom of the screen, with at most one thing you can do
 * about it.
 *
 * This exists for a specific gap: Done is a single unconfirmed keystroke, and
 * a destructive action with no visible way back is not a fast action, it is a
 * cliff. The undo lives here rather than in a confirmation dialog because the
 * common case — meaning it — should stay one key, and only the rare case
 * should cost anything.
 *
 * A module-level store rather than context: a toast is raised from a page, a
 * sheet and a keyboard handler, and the bar that renders it lives above all
 * three in the tree.
 */

import { useCallback, useSyncExternalStore } from 'react'

export type Toast = {
  id: number
  text: string
  /** Label and handler for the single optional action. */
  action?: { label: string; run: () => void | Promise<void> }
}

let current: Toast | null = null
let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

/** Long enough to read a sentence and reach for the button, short enough to leave. */
const DWELL_MS = 8_000

export function toast(text: string, action?: Toast['action']) {
  if (timer) clearTimeout(timer)
  current = { id: ++seq, text, action }
  emit()
  const mine = current.id
  timer = setTimeout(() => { if (current?.id === mine) dismissToast() }, DWELL_MS)
}

export function dismissToast() {
  if (timer) { clearTimeout(timer); timer = null }
  if (!current) return
  current = null
  emit()
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    useCallback((l: () => void) => (listeners.add(l), () => listeners.delete(l)), []),
    () => current,
    () => current,
  )
}
