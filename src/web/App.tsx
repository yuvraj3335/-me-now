import { MotionConfig, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  BarChart3, Inbox, Mail as MailIcon, MoreHorizontal, RefreshCw, Settings2, Sparkles, SquareCheck,
} from 'lucide-react'
import { useLiveState, useStore, refresh } from './lib/api'
import { registerSW } from './lib/push'
import { Home } from './pages/Home'
import { Work } from './pages/Work'
import { Pulse } from './pages/Pulse'
import { Settings } from './pages/Settings'
import { Agent } from './pages/Agent'
import { Mail } from './pages/Mail'
import { spring, Sheet } from './components/primitives'
import { STATIC_MODE, useStill } from './lib/motion'
import { Palette, contributedCommands, subscribePalette, paletteVersion, type Command } from './components/palette'
import { LaunchSheet } from './components/launch'
import { useAgentBadge } from './lib/agent'
import { useMailBadge } from './lib/mailBadge'

/**
 * Seven destinations on a laptop, four on a phone.
 *
 * `bleed` is the difference between a reading column and a working surface. Now,
 * Work, Pulse and Settings are things you read, so they stay at 760px. Mail is a
 * list beside a thread and Agent is history beside a conversation beside an
 * inspector; squeezing either into a column wastes two thirds of the screen.
 */
const TABS = [
  { path: '/', label: 'Now', Icon: Inbox, Page: Home, bleed: false, mobile: true },
  { path: '/mail', label: 'Mail', Icon: MailIcon, Page: Mail, bleed: true, mobile: true },
  { path: '/agent', label: 'Agent', Icon: Sparkles, Page: Agent, bleed: true, mobile: true },
  { path: '/work', label: 'Work', Icon: SquareCheck, Page: Work, bleed: false, mobile: false },
  { path: '/pulse', label: 'Pulse', Icon: BarChart3, Page: Pulse, bleed: false, mobile: false },
  { path: '/settings', label: 'Settings', Icon: Settings2, Page: Settings, bleed: false, mobile: false },
] as const

/** Tiny history router — six routes do not justify a routing dependency. */
function useRoute(): [string, (p: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // Stable across renders: it is a dependency of the palette's command list,
  // and a fresh closure each render would rebuild that list every time.
  const go = useCallback((p: string) => {
    if (p === window.location.pathname) return window.scrollTo({ top: 0, behavior: 'smooth' })
    window.history.pushState({}, '', p)
    setPath(p)
    window.scrollTo(0, 0)
  }, [])
  return [path, go]
}

/** Exposed so any component can navigate without threading a prop through. */
export const navigate = (p: string) => {
  window.history.pushState({}, '', p)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function App() {
  const [path, go] = useRoute()
  const { loading, error } = useLiveState()
  const store = useStore()
  const [more, setMore] = useState(false)
  const [palette, setPalette] = useState(false)

  useEffect(() => { void registerSW() }, [])

  // A notification's deep link lands on a Wake route; honour it on wake-up.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'navigate' && typeof e.data.path === 'string') go(e.data.path)
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
  const agentBadge = useAgentBadge()
  const mailBadge = useMailBadge()

  const badgeFor = (p: string) =>
    p === '/' ? nowCount : p === '/mail' ? mailBadge : p === '/agent' ? agentBadge : 0

  const commands = useCommands(go)

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
    <div className="min-h-dvh">
      <div className="dawn-light" aria-hidden />

      {/* Desktop nav: a quiet top rail. */}
      <nav className="hidden sm:flex sticky top-0 z-30 items-center gap-1 px-6 h-14
                      bg-ink-900/85 backdrop-blur-xl">
        <span className="text-[14px] font-medium tracking-[-0.02em] mr-5 select-none">Wake</span>
        {TABS.map(t => (
          <NavItem key={t.path} {...t} active={active.path === t.path}
            onClick={() => go(t.path)} badge={badgeFor(t.path)} />
        ))}
        <button
          onClick={() => setPalette(true)}
          className="ml-auto inline-flex items-center gap-1.5 h-7 px-2 rounded-lg text-[11.5px]
                     text-fg-mute hover:text-fg-dim hover:bg-ink-800 transition-colors"
          title="Command palette"
        >
          <kbd className="font-sans">⌘K</kbd>
        </button>
      </nav>

      <main className={`relative z-10 px-4 sm:px-6 pad-top ${active.bleed ? 'bleed' : 'column'}`}>
        {error && !store.state && (
          <p className="mt-24 text-center text-[13px] text-bad">{error}</p>
        )}
        {loading && !store.state && (
          <p className="mt-24 text-center text-[13px] text-fg-mute">Waking up…</p>
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
          initial={still ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <active.Page />
        </motion.div>
      </main>

      {/* Mobile nav: three destinations and a More sheet. Six icons in a thumb
          bar is a row of 48px targets nobody can hit; the three that matter at
          7am stay, the rest move one tap away. */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-30 pad-bottom
                      bg-ink-900/90 backdrop-blur-xl border-t border-white/[0.06]">
        <div className="flex">
          {TABS.filter(t => t.mobile).map(t => (
            <TabItem key={t.path} {...t} active={active.path === t.path}
              onClick={() => go(t.path)} badge={badgeFor(t.path)} />
          ))}
          <TabItem
            path="/more" label="More" Icon={MoreHorizontal}
            active={TABS.some(t => !t.mobile && t.path === active.path)}
            onClick={() => setMore(true)} badge={0}
          />
        </div>
      </nav>

      <Sheet open={more} onClose={() => setMore(false)} title="More">
        <div className="space-y-1">
          {TABS.filter(t => !t.mobile).map(t => (
            <button
              key={t.path}
              onClick={() => { setMore(false); go(t.path) }}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-[10px] text-left
                         text-[14.5px] text-fg-dim hover:bg-ink-800 transition-colors"
            >
              <t.Icon size={16} className="text-fg-mute" />
              {t.label}
            </button>
          ))}
          <button
            onClick={() => { setMore(false); void refresh() }}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-[10px] text-left
                       text-[14.5px] text-fg-dim hover:bg-ink-800 transition-colors"
          >
            <RefreshCw size={16} className="text-fg-mute" />
            Refresh sources
          </button>
        </div>
      </Sheet>

      <Palette open={palette} onClose={() => setPalette(false)} commands={commands} />
      <LaunchSheet />
    </div>
    </MotionConfig>
  )
}

/** Navigation, global actions, and whatever the current page contributed. */
function useCommands(go: (p: string) => void): Command[] {
  const version = useSyncExternalStore(subscribePalette, paletteVersion, paletteVersion)
  return useMemo(() => {
    const nav: Command[] = TABS.map(t => ({
      id: `go:${t.path}`,
      label: t.label,
      group: 'Go to',
      icon: <t.Icon size={14} />,
      run: () => go(t.path),
    }))
    const global: Command[] = [
      {
        id: 'refresh',
        label: 'Refresh all sources',
        group: 'Wake',
        icon: <RefreshCw size={14} />,
        run: () => void refresh(),
      },
    ]
    // `version` is the dependency that makes a page's contributions appear.
    void version
    return [...nav, ...contributedCommands(), ...global]
  }, [go, version])
}

function NavItem({
  label, Icon, active, onClick, badge,
}: { label: string; Icon: any; active: boolean; onClick: () => void; badge: number }) {
  return (
    <button onClick={onClick}
      className={`relative inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px]
        transition-colors ${active ? 'text-fg' : 'text-fg-mute hover:text-fg-dim'}`}>
      {active && (
        <motion.span layoutId="nav-pill" transition={spring}
          className="absolute inset-0 bg-ink-800 rounded-lg -z-10" />
      )}
      <Icon size={14} />
      {label}
      {badge > 0 && <span className="ml-0.5 tnum text-[11px] text-accent">{badge > 99 ? '99+' : badge}</span>}
    </button>
  )
}

function TabItem({
  label, Icon, active, onClick, badge,
}: { label: string; Icon: any; active: boolean; onClick: () => void; badge: number; path?: string }) {
  return (
    <button onClick={onClick}
      className={`relative flex-1 flex flex-col items-center gap-1 pt-2.5 pb-2 min-h-[54px]
        transition-colors ${active ? 'text-fg' : 'text-fg-mute'}`}>
      <span className="relative">
        <Icon size={19} strokeWidth={active ? 2.1 : 1.7} />
        {badge > 0 && (
          <span className="absolute -top-1 -right-2 min-w-[15px] h-[15px] px-1 rounded-full
                           bg-accent text-ink-950 text-[10px] font-semibold leading-[15px]
                           text-center tnum">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span className="text-[10.5px] tracking-[0.01em]">{label}</span>
    </button>
  )
}
