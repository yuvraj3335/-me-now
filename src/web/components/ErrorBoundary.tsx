/**
 * The last thing between a thrown error and a blank screen.
 *
 * There was no error boundary in this product at all, which meant every throw
 * during render — and every rejected `lazy()` import, which React re-throws
 * during render — unmounted the entire root. What he saw was a white page with
 * one line in a console he was not looking at, on a phone, where there is no
 * console to look at. "Whatever fails should show him a message, not silence"
 * is the rule this file exists for.
 *
 * The commonest way to get here is real and is not his fault: **the build moved
 * under him.** `/assets/*` names are content-hashed, so a tab or a home-screen
 * app holding a shell from before a deploy asks for a chunk that no longer
 * exists. That is one reload away from being fixed, and the reload has to take
 * the service worker's caches with it — otherwise the same stale shell is
 * served straight back and the reload changes nothing, which is worse than the
 * first failure because it teaches him the button does not work.
 *
 * So the recovery is: drop every cache, unregister the workers, then reload. It
 * is safe to do unconditionally — nothing in those caches is data. `/api` is
 * never cached (see `sw.js`), so there is nothing here to lose.
 *
 * What it deliberately does NOT do is retry silently or hide the error. A
 * boundary that swallows a fault and re-renders is how a broken screen becomes
 * a screen that is subtly wrong, and this product's whole claim is that what is
 * on it is true.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

/** A failed dynamic import, in the several shapes browsers phrase it. */
const isStaleBuild = (e: Error): boolean =>
  /dynamically imported module|Importing a module script failed|error loading dynamically imported/i
    .test(e.message)

/**
 * Reload, dropping the caches first — but only when they are the problem.
 *
 * The cache and the worker are what make Wake open at all on a dropped
 * connection, so throwing them away is not free. It is exactly right for a
 * stale build, where the cached shell IS the fault and a plain reload serves the
 * same broken page straight back. It is wrong for anything else: a render crash
 * that has nothing to do with a deploy would cost the offline shell, and
 * pressing Reload while the tunnel is down would then land on the browser's own
 * error page — strictly worse than the state it was pressed from.
 */
async function clearAndReload(stale: boolean) {
  if (stale) {
    try {
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map(k => caches.delete(k)))
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map(r => r.unregister()))
      }
    } catch {
      // A blocked cache API is not a reason to refuse to reload; the reload is
      // the part that might work on its own.
    }
  }
  window.location.reload()
}

type Props = { children: ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Still logged, because the message on screen is deliberately short and the
    // stack is what makes a report actionable.
    console.error('wake: unhandled error', error, info.componentStack)
  }

  /*
   * Going somewhere else clears it.
   *
   * When this catches, `App` unmounts entirely — no nav, no tab bar, no route
   * subscription — so the only control on screen is Reload. Browser Back still
   * works, though, and without this it left the address bar saying `/work` while
   * the viewport still said something broke: the URL and the screen disagreeing,
   * with no way to resolve it but a reload.
   *
   * Clearing on `popstate` re-mounts `App` at the new route. If the fault is
   * deterministic it is caught again immediately, which is the honest outcome;
   * what it stops is a screen that is stuck for a reason that has gone away.
   */
  componentDidMount() {
    window.addEventListener('popstate', this.clear)
  }

  componentWillUnmount() {
    window.removeEventListener('popstate', this.clear)
  }

  clear = () => {
    if (this.state.error) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const stale = isStaleBuild(error)

    return (
      <div role="alert" className="p-6 max-w-prose">
        <h1 className="text-lg font-medium text-fg">
          {stale ? 'Wake updated while this was open.' : 'Something broke on this screen.'}
        </h1>
        <p className="text-base text-fg-dim mt-2 leading-snug">
          {stale
            ? 'This tab is running a build that is no longer on the box, so part of the app could not load. Reloading picks up the current one.'
            : 'The rest of the app is still fine — this is one screen, not the server. Reloading is the fastest way back.'}
        </p>
        {/*
          The message is on screen, not only in a console. It is the one place a
          phone can show what actually happened, and "it went white" is not a
          report anybody can act on.
        */}
        <pre className="text-sm text-fg-mute mt-3 whitespace-pre-wrap break-words">
          {error.message}
        </pre>
        {/*
          The classes are written out rather than reached for through `Button`:
          this component has to render when the rest of the app is what failed,
          so it depends on nothing but React. `relative` is not decoration — the
          44px touch collar is positioned, and without a containing block it
          lands in the nearest positioned ancestor's corner instead of around
          this button.
        */}
        <button
          onClick={() => void clearAndReload(stale)}
          className="hit relative mt-4 h-10 px-3 rounded-panel bg-accent text-on-accent text-sm font-medium"
        >
          Reload
        </button>
      </div>
    )
  }
}
