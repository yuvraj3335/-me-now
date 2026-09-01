import { MotionConfig, motion } from 'motion/react'
import { Suspense, lazy, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  BarChart3, Inbox, Mail as MailIcon, MessagesSquare, PenLine, RefreshCw, RotateCcw, Settings2,
  SquareCheck, SquareTerminal,
} from 'lucide-react'
import { useLiveState, useStore, refresh } from './lib/api'
import { registerSW } from './lib/push'
import { surfaceErrors } from './lib/surfaceErrors'
import { Home } from './pages/Home'
import { Work } from './pages/Work'
import Sessions from './pages/Sessions'
import { SessionPage, sessionRouteOf } from './pages/Session'
import { Pulse } from './pages/Pulse'
import { Settings } from './pages/Settings'
import { Mail } from './pages/Mail'

/**
 * The terminal is loaded on arrival, not on boot.
 *
 * xterm.js is a real VT emulator and it costs 346KB of the bundle — more than
 * half of everything else in this product put together. Every other destination
 * here is read on a phone over a tunnel, often on the first load of the morning,
 * and none of them needs a terminal emulator to render a table. Splitting it out
 * is the difference between the desk paying for the terminal and the terminal
 * paying for itself, and `/terminal/<id>` is the only route that pulls it in.
 */
const TerminalPage = lazy(() => import('./pages/Terminal'))
import { STATIC_MODE, useStill } from './lib/motion'
import { Palette, contributedCommands, subscribePalette, paletteVersion, type Command } from './components/palette'
import { LaunchSheet } from './components/launch'
import { ToastBar } from './components/toast'
import { WakeMark } from './components/WakeMark'
import { openLaunch } from './lib/launch'
import { useMailBadge } from './lib/mailBadge'
import { navigate, setParam, terminalIdOf, useRoute } from './lib/route'

/**
 * Six destinations, on the laptop and on the phone alike.
 *
 * The More sheet is gone. At 390px six tabs are 65px each, still above the 44pt
 * target, and a modal to reach Settings cost two taps and a dismissal at exactly
 * the moment something was broken and he was already annoyed. "Refresh sources"
 * left with it: it is not a destination, and it is already a control in the
 * desk's header and a command in the palette.
 *
 * `flush` marks a page that lays out the whole shell column itself — Desk, which
 * is a table beside a detail pane, Mail, which is a list beside a thread, and
 * Work, which is a list beside its notes. All three pad each of their own
 * columns with the same `.pad-x`, which is what puts the second column's left
 * edge on one vertical across the product instead of on a 360px inset that only
 * Work used. Everything else gets the shell's own padding.
 *
 * Sessions carries `MessagesSquare` and not `SquareTerminal`, and that is a
 * statement about the destination rather than a change of taste. The tab used
 * to wear a terminal because the only thing Wake could do with a session was
 * attach a VT emulator to it; what is behind it now is a conversation — turns,
 * a composer, body text in a proportional font — and an icon promising a
 * terminal on the one tab that deliberately has no terminal on it is the first
 * thing that would be read and the first thing that would be wrong. The
 * terminal still exists, at `/terminal/<id>`, which is not a tab.
 */
const TABS = [
  { path: '/', label: 'Desk', Icon: Inbox, Page: Home, flush: true },
  { path: '/mail', label: 'Mail', Icon: MailIcon, Page: Mail, flush: true },
  { path: '/work', label: 'Work', Icon: SquareCheck, Page: Work, flush: true },
  { path: '/sessions', label: 'Sessions', Icon: MessagesSquare, Page: Sessions, flush: false },
  { path: '/pulse', label: 'Pulse', Icon: BarChart3, Page: Pulse, flush: false },
  { path: '/settings', label: 'Settings', Icon: Settings2, Page: Settings, flush: false },
] as const

export default function App() {
  const { path } = useRoute()
  const { loading, error } = useLiveState()
  const store = useStore()
  const [palette, setPalette] = useState(false)

  useEffect(() => { void registerSW() }, [])

  // A rejected promise from any handler in the product says so, rather than
  // going nowhere. See `lib/surfaceErrors.ts` — this is the half of "nothing
  // fails silently" that an error boundary structurally cannot cover.
  useEffect(() => { surfaceErrors() }, [])

  // A notification's deep link lands on a Wake route; honour it on wake-up.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'navigate' && typeof e.data.path === 'string') navigate(e.data.path)
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(o => !o)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  /**
   * One conversation, which is a place inside Sessions rather than a seventh tab.
   *
   * `/sessions/<id>` and `/sessions/new` are real paths for the same three
   * reasons `/terminal/<id>` is: a session is deep-linkable, it is what a push
   * notification about a session should point at, and the phone's Back button
   * has to close it. They are deliberately *not* rows in `TABS` — six
   * destinations is the shell's whole contract and a route that renders inside
   * one of them is not a seventh destination, it is that destination showing
   * something specific.
   *
   * Which is why the tab still lights up: `active` falls through to Sessions
   * for anything under it, so the bar answers "where am I" with the truth
   * instead of highlighting Desk while a conversation is on screen.
   *
   * Unlike the terminal, this stays inside the shell. The terminal takes the
   * whole viewport because a VT emulator has to; a conversation does not, and
   * taking the tab bar away would make leaving one cost a gesture nobody was
   * told about.
   */
  const conversation = sessionRouteOf(path)
  const active = TABS.find(t => t.path === path)
    ?? (conversation ? TABS.find(t => t.path === '/sessions') : undefined)
    ?? TABS[0]
  /**
   * A live Claude Code session, which is a place rather than a tab.
   *
   * Read here and rendered below every hook, because hooks may not be skipped —
   * the early return has to come after the last one, not before the first.
   */
  const terminalId = terminalIdOf(path)
  /**
   * What is actually waiting, not what is on the desk.
   *
   * The desk holds every open card — around a hundred — and a badge that reads
   * `99+` every morning says nothing. The server still computes the urgent
   * split, and that is the number worth carrying on a phone's home screen.
   */
  const waiting = store.state?.now.length ?? 0
  const mailBadge = useMailBadge()

  const badgeFor = (p: string) => (p === '/' ? waiting : p === '/mail' ? mailBadge : 0)

  const commands = useCommands()

  // `?static` renders every motion element at its end state, and `useStill`
  // folds in the reader's own reduced-motion preference. Headless panes and
  // background tabs never fire requestAnimationFrame, which would otherwise
  // freeze every animated mark at its initial value.
  const staticMode = STATIC_MODE
  const still = useStill()

  /**
   * The terminal takes the whole viewport, and takes it *outside* the shell.
   *
   * Not a seventh tab and not a page inside `<main>`. A terminal has to own the
   * full height to be worth reading on a phone, it sizes its own columns against
   * whatever box it is given, and the phone tab bar would sit on top of the
   * composer — the one line the operator has to be able to see and type in. The
   * chevron path in its own header is what replaces the rail: see
   * `pages/Terminal.tsx`.
   *
   * `ToastBar` comes along because refusals from the terminal API — an unknown
   * repository, a session that is not on this box — are reported the same way
   * they are everywhere else in the product.
   */
  if (terminalId) {
    return (
      <MotionConfig reducedMotion={staticMode ? 'always' : 'user'}>
        {/* A word rather than a spinner. The chunk arrives in well under a
            second on this tunnel, and a spinner that flashes for 200ms is
            noise where a line of text is an answer. */}
        <Suspense fallback={<p className="p-6 text-sm text-fg-mute">Opening the session…</p>}>
          <TerminalPage id={terminalId} />
        </Suspense>
        <ToastBar />
      </MotionConfig>
    )
  }

  return (
    <MotionConfig
      // Honour the OS "reduce motion" setting for real users. The stylesheet
      // already neutralises CSS transitions; this covers the JS-driven ones.
      reducedMotion={staticMode ? 'always' : 'user'}
      transition={staticMode ? { duration: 0 } : undefined}
    >
    <div className="min-h-dvh sm:flex">

      {/* Desktop nav: a left rail, not a bar riding on top of the page. A
          horizontal strip scrolls with the document underneath it — its own
          `sticky` only re-pins it at the top of the *viewport*, which does
          nothing once the page has scrolled the reader's eye somewhere else
          on a long one (Pulse). A rail as tall as the viewport has nowhere
          to scroll away to.

          Opaque, with a 1px edge. Elevation in this product is an edge on a
          flat surface, never a blur and never a shadow. */}
      <nav className="hidden sm:flex sm:flex-col sm:sticky sm:top-0 sm:h-dvh sm:w-50 sm:shrink-0
                      sm:px-3 sm:py-6 sm:border-r sm:border-edge z-30 bg-ink-900">
        {/* A mark and a word, not a word in the body font. The rail used to set
            `Wake` in the same family and weight as the nav item beneath it, so
            the product had no mark at all on either device. */}
        <span className="flex items-center gap-2 px-3 mb-6 select-none">
          <WakeMark size={18} className="text-accent shrink-0" />
          <span className="text-base font-medium tracking-[-0.02em]">Wake</span>
        </span>
        <div className="flex flex-col gap-1">
          {TABS.map(t => (
            <NavItem key={t.path} label={t.label} Icon={t.Icon} active={active.path === t.path}
              onClick={() => navigate(t.path)} badge={badgeFor(t.path)} />
          ))}
        </div>
        <button
          onClick={() => setPalette(true)}
          className="mt-auto inline-flex items-center gap-2 h-8 px-3 rounded-control text-xs
                     text-fg-mute hover:text-fg-dim hover:bg-ink-800 transition-colors duration-100"
          title="Command palette"
        >
          <kbd className="font-sans">⌘K</kbd>
          <span>Search</span>
        </button>
      </nav>

      {/* One page pad, applied once, by the class that owns it. A flush page
          lays out its own columns and pads each of them with the same `.pad-x`,
          so a table header, a section title and a page title all land on x=224.

          `overflow-x-clip` says a page column never scrolls sideways, and it is
          load-bearing. `.hit` gives every small control a touch target reaching
          6px past its own box on a coarse pointer, and an absolutely positioned
          box IS scrollable overflow — Chrome folds the column's end padding into
          it and hands the document 6px it cannot show. On `/work` the amber
          `+ Task` is the rightmost thing in the column, so a phone's layout
          viewport widened to 396 on a 390 screen, the fixed tab bar followed it
          out to 396, and every width scrolled. Clipping at the button was
          measured and does not work: `overflow: clip` leaves the box in the
          overflow region, `overflow-clip-margin` with it, and `contain: paint`
          removes it by killing the target it exists for. Clipping here removes
          the overflow and leaves the target hittable, because the target never
          reaches this edge — only its claim on the scroll region did. `clip`,
          not `hidden`: this must not become a scroll container.

          `relative z-10` is the page's ceiling, and it is deliberate. It makes
          main a stacking context, so nothing a page draws — a sticky table
          head, a swipe drawer, a resize grip — can ever paint over the rails or
          the tab bar, whatever z-index it picks. The shell owns 30 and up.

          The price is that a page's overlay cannot climb out either: a `fixed
          inset-0 z-50` sheet rendered by a page is ranked 50 *among main's
          children* and main still paints at 10, so the phone tab bar covered
          the bottom 53px of every sheet in the product — the footer, which is
          where the control that commits lives. That is paid, once, by every
          overlay leaving the page subtree instead: `Sheet`, `Menu`, `Peek` and
          the desk's push sheet all portal to `document.body`. Do not answer a
          future covered-overlay report by raising a number here; the answer is
          that the overlay is still being drawn inside the page. */}
      <main className={`relative z-10 min-w-0 sm:flex-1 pad-top overflow-x-clip ${active.flush ? '' : 'pad-x'}`}>
        {error && !store.state && (
          <p className="mt-24 pad-x text-sm text-bad">{error}</p>
        )}
        {/*
          The page fades in; it does not fade out.

          An exit animation with `mode="wait"` holds the outgoing page until that
          animation finishes, and it only finishes if frames are being produced.
          A background tab, a headless pane and a reader whose system asks for
          reduced motion all stop producing them, and the app then silently
          stops navigating — the old page simply stays. Two hundred milliseconds
          of fade-out is not worth a class of bug where the product appears
          frozen, so the new page mounts immediately in every case.
        */}
        <motion.div
          key={active.path}
          initial={still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.14 }}
        >
          {/* The page keyed on the session, so moving from one conversation to
              another starts clean rather than showing the previous one's turns
              until the fetch lands. */}
          {conversation
            ? <SessionPage key={conversation.id ?? 'new'} id={conversation.id} />
            : <active.Page />}
        </motion.div>
      </main>

      {/* Mobile nav: all six destinations. 65px each at 390px, which clears the
          44pt target, and nothing worth reaching is behind a sheet you have to
          know about. */}
      {/* `data-navbar` is how a positioned panel finds out how much of the
          bottom of the screen is already spoken for. `--nav-h` is the same fact
          in the stylesheet, and everything that can stay in CSS uses that; a
          menu that has to *decide* whether to open upward needs the number, and
          a custom property carrying a `calc()` with an `env()` inside it does
          not resolve to one through `getPropertyValue`. So the bar is measured
          instead — it reports 0 the moment it is `display: none`, which is
          exactly the answer wanted from `sm` up. See `navStrip`. */}
      <nav data-navbar
        className="sm:hidden fixed bottom-0 inset-x-0 z-30 pad-bottom glass border-t border-edge">
        <div className="flex">
          {TABS.map(t => (
            <TabItem key={t.path} label={t.label} Icon={t.Icon} active={active.path === t.path}
              onClick={() => navigate(t.path)} badge={badgeFor(t.path)} />
          ))}
        </div>
      </nav>

      <Palette open={palette} onClose={() => setPalette(false)} commands={commands} />
      <LaunchSheet />
      <ToastBar />
    </div>
    </MotionConfig>
  )
}

/**
 * Navigation, global actions, and whatever the current page contributed.
 *
 * The mail commands live here rather than inside the Mail page's own effect.
 * They used to register when Mail mounted, which meant that from the desk — the
 * moment a palette is worth having — there was no mail command at all. Both
 * carry their destination in the URL, so the shell does not have to reach into
 * a page it does not own.
 */
function useCommands(): Command[] {
  const version = useSyncExternalStore(subscribePalette, paletteVersion, paletteVersion)
  return useMemo(() => {
    const nav: Command[] = TABS.map(t => ({
      id: `go:${t.path}`,
      label: t.label,
      group: 'Go to',
      icon: <t.Icon size={14} />,
      run: () => navigate(t.path),
    }))
    const global: Command[] = [
      {
        id: 'mail:compose',
        label: 'Compose mail',
        group: 'Wake',
        icon: <PenLine size={14} />,
        run: () => { navigate('/mail'); setParam('compose', '1') },
      },
      {
        id: 'refresh',
        label: 'Poll every source',
        group: 'Wake',
        icon: <RefreshCw size={14} />,
        run: () => void refresh(),
      },
      {
        /**
         * The hand-off with nothing attached yet.
         *
         * Every other route to "Open in Claude" starts from an object — a card,
         * a mail thread — which is the better version of it. This is the one for
         * when the thing you want to hand over is not on any list: it opens the
         * same sheet on the Blank template, where a repository and a brief can
         * be chosen the same way.
         */
        id: 'launch:blank',
        label: 'Send to Claude Code',
        hint: 'a blank brief',
        group: 'Wake',
        icon: <SquareTerminal size={14} />,
        run: () => openLaunch([], { template: 'blank' }),
      },
      {
        /**
         * What he finished, in the same table it left. Not a modal and not a
         * fourth chapter at the foot of the page: it is the desk with its Status
         * filter set, so every other filter still applies and the control that
         * put a card away is the control that takes it back out. Reachable with
         * no card to start from, which is the point — the card is off the list.
         */
        id: 'cards:status-done',
        label: 'Done',
        hint: 'see what you finished',
        group: 'Wake',
        icon: <RotateCcw size={14} />,
        run: () => { navigate('/'); setParam('status', 'done') },
      },
    ]
    // `version` is the dependency that makes a page's contributions appear.
    void version
    return [...nav, ...contributedCommands(), ...global]
  }, [version])
}

function NavItem({
  label, Icon, active, onClick, badge,
}: { label: string; Icon: any; active: boolean; onClick: () => void; badge: number }) {
  // Weight and colour, not a filled rectangle. The active item was a grey pill
  // at `font-weight: 400` — the fill was the only signal, and a filled rectangle
  // around the active nav item is the one shape this design does not use.
  //
  // The count is muted here. It was `text-accent-ink` in the rail while the tab
  // bar painted the same number on an amber pill and a group heading painted it
  // a third time: one number, three amber marks, on a screen whose budget is
  // three marks in total. The phone's badge keeps the accent, because that one
  // is seen without the page.
  return (
    <button onClick={onClick}
      className={`relative w-full flex items-center gap-3 h-8 px-3 rounded-control text-sm text-left
        transition-colors duration-100
        ${active ? 'text-fg font-medium' : 'text-fg-mute hover:text-fg-dim hover:bg-ink-800'}`}>
      <Icon size={14} />
      <span className="grow">{label}</span>
      {badge > 0 && <span className="tnum text-sm text-fg-mute">{badge > 99 ? '99+' : badge}</span>}
    </button>
  )
}

function TabItem({
  label, Icon, active, onClick, badge,
}: { label: string; Icon: any; active: boolean; onClick: () => void; badge: number }) {
  return (
    <button onClick={onClick}
      className={`relative flex-1 flex flex-col items-center gap-1 py-2 min-h-12
        transition-colors duration-100 ${active ? 'text-fg' : 'text-fg-mute'}`}>
      <span className="relative">
        <Icon size={16} strokeWidth={active ? 2.1 : 1.7} />
        {/* This badge is one of the three amber marks in the product. It says
            "something is waiting", which is the only thing amber ever means. */}
        {badge > 0 && (
          <span className="absolute -top-1 -right-2 min-w-4 h-4 px-1 rounded-full
                           bg-accent text-on-accent text-xs font-semibold leading-4
                           text-center tnum">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span className={`text-xs ${active ? 'font-medium' : ''}`}>{label}</span>
    </button>
  )
}
