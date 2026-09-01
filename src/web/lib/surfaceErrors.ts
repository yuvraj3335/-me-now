/**
 * The half of "nothing fails silently" that an error boundary cannot reach.
 *
 * A React boundary catches throws during render, lifecycle and constructors. It
 * does not catch anything from an event handler or a rejected promise — which
 * is most of what this product does. Every write on the desk, every undo in a
 * toast, every archive on the Sessions page is an `async` function called with
 * `void`, and before this file a rejection from one of them went nowhere at all:
 * no toast, no console entry a phone could show, nothing.
 *
 * That is the same class of failure as the white screen, arriving from the other
 * side. The boundary answers "the page is gone"; this answers "the thing you
 * pressed did not happen".
 *
 * One listener, registered once, deliberately doing the least it can:
 *
 *   * It **reports**, it does not recover. There is no retry and no rollback,
 *     because this has no idea what was being attempted. The surfaces that can
 *     recover do it themselves, in a `catch`, next to the optimistic edit they
 *     need to undo.
 *   * It does not `preventDefault`, so the rejection still reaches the console
 *     with its stack. The toast is a short sentence for him; the console entry
 *     is what makes a report actionable.
 *   * It says the message and nothing else. "Something went wrong" would be a
 *     worse version of the silence it replaces.
 */

import { toast } from './toast'

/** Whatever a rejection carried, as one line a person can read. */
function reasonOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string') return reason
  return 'something failed and did not say why'
}

let listening = false

export function surfaceErrors() {
  // Registered from a mount effect, and React runs those twice in StrictMode.
  if (listening) return
  listening = true

  window.addEventListener('unhandledrejection', e => {
    console.error('wake: unhandled rejection', e.reason)
    toast(reasonOf(e.reason))
  })
}
