import { MotionConfig, motion } from 'motion/react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  BarChart3, Inbox, Mail as MailIcon, PenLine, RefreshCw, RotateCcw, Settings2,
  SquareCheck, Terminal,
} from 'lucide-react'
import { useLiveState, useStore, refresh } from './lib/api'
import { registerSW } from './lib/push'
import { Home } from './pages/Home'
import { Work } from './pages/Work'
import { Pulse } from './pages/Pulse'
import { Settings } from './pages/Settings'
import { Mail } from './pages/Mail'
import { STATIC_MODE, useStill } from './lib/motion'
import { Palette, contributedCommands, subscribePalette, paletteVersion, type Command } from './components/palette'
import { LaunchSheet } from './components/launch'
import { ToastBar } from './components/toast'
import { openLaunch } from './lib/launch'
import { useMailBadge } from './lib/mailBadge'
import { navigate, setParam, useRoute } from './lib/route'

/**
 * Five destinations, on the laptop and on the phone alike.
 *
 * The More sheet is gone. At 390px five tabs are 78px each, comfortably above
 * the 44pt target, and a modal to reach Settings cost two taps and a dismissal
 * at exactly the moment something was broken and he was already annoyed.
 * "Refresh sources" left with it: it is not a destination, and it is already a
 * control in Now's header and a command in the palette.
 *
 * `flush` marks a page that lays out the whole shell column itself — Now, which
 * is a table beside a detail pane, and Mail, which is a list beside a thread.
 * Everything else gets the shell's own padding.
 */
const TABS = [
  { path: '/', label: 'Now', Icon: Inbox, Page: Home, flush: true },
  { path: '/mail', label: 'Mail', Icon: MailIcon, Page: Mail, flush: true },
  { path: '/work', label: 'Work', Icon: SquareCheck, Page: Work, flush: false },
  { path: '/pulse', label: 'Pulse', Icon: BarChart3, Page: Pulse, flush: false },
  { path: '/settings', label: 'Settings', Icon: Settings2, Page: Settings, flush: false },
] as const

export default function App() {
  const { path } = useRoute()
  const { loading, error } = useLiveState()
  const store = useStore()
  const [palette, setPalette] = useState(false)

  useEffect(() => { void registerSW() }, [])

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

  const active = TABS.find(t => t.path === path) ?? TABS[0]
  const nowCount = store.state?.now.length ?? 0
  const mailBadge = useMailBadge()

  const badgeFor = (p: string) => (p === '/' ? nowCount : p === '/mail' ? mailBadge : 0)

  const commands = useCommands()

  // `?static` renders every motion element at its end state, and `useStill`
  // folds in the reader's own reduced-motion preference. Headless panes and
  // background tabs never fire requestAnimationFrame, which would otherwise
  // freeze every animated mark at its initial value.
  const staticMode = STATIC_MODE
  const still = useStill()

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
        <span className="text-base font-medium tracking-[-0.02em] px-3 mb-6 select-none">Wake</span>
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
          so a table header, a section title and a page title all land on x=224. */}
      <main className={`relative z-10 min-w-0 sm:flex-1 pad-top ${active.flush ? '' : 'pad-x'}`}>
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
          <active.Page />
        </motion.div>
      </main>

      {/* Mobile nav: all five destinations. 78px each at 390px, which clears
          the 44pt target with room, and nothing worth reaching is behind a
          sheet you have to know about. */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-30 pad-bottom bg-ink-900 border-t border-edge">
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
 * They used to register when Mail mounted, which meant that from Now — the one
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
        label: 'Open in Claude',
        hint: 'a blank brief',
        group: 'Wake',
        icon: <Terminal size={14} />,
        run: () => openLaunch([], { template: 'blank' }),
      },
      {
        /**
         * The restore list. It is a collapsed group at the foot of Now rather
         * than a modal — a pile of his cards belongs on the page that holds his
         * piles — so the command opens Now with that group expanded. Reachable
         * with no card to start from, which is the point: the card is gone.
         */
        id: 'cards:done',
        label: 'Done and not mine',
        hint: 'bring something back',
        group: 'Wake',
        icon: <RotateCcw size={14} />,
        run: () => { navigate('/'); setParam('done', '1') },
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
  // bar painted the same number on an amber pill and the group heading painted
  // it a third time: one number, three amber marks, on a screen whose budget is
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
        {/* The Now badge is one of the three amber marks in the product. It says
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
