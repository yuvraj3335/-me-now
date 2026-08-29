import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { BarChart3, Inbox, Settings2, SquareCheck } from 'lucide-react'
import { useLiveState, useStore } from './lib/api'
import { registerSW } from './lib/push'
import { Home } from './pages/Home'
import { Work } from './pages/Work'
import { Pulse } from './pages/Pulse'
import { Settings } from './pages/Settings'
import { spring } from './components/primitives'
import { STATIC_MODE } from './lib/motion'

const TABS = [
  { path: '/', label: 'Now', Icon: Inbox, Page: Home },
  { path: '/work', label: 'Work', Icon: SquareCheck, Page: Work },
  { path: '/pulse', label: 'Pulse', Icon: BarChart3, Page: Pulse },
  { path: '/settings', label: 'Settings', Icon: Settings2, Page: Settings },
] as const

/** Tiny history router — four routes do not justify a routing dependency. */
function useRoute(): [string, (p: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const go = (p: string) => {
    if (p === window.location.pathname) return window.scrollTo({ top: 0, behavior: 'smooth' })
    window.history.pushState({}, '', p)
    setPath(p)
    window.scrollTo(0, 0)
  }
  return [path, go]
}

export default function App() {
  const [path, go] = useRoute()
  const { loading, error } = useLiveState()
  const store = useStore()

  useEffect(() => { void registerSW() }, [])

  // A notification's deep link lands on a Wake route; honour it on wake-up.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'navigate' && typeof e.data.path === 'string') go(e.data.path)
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [])

  const active = TABS.find(t => t.path === path) ?? TABS[0]
  const nowCount = store.state?.now.length ?? 0

  // `?static` renders every motion element at its end state. Needed for
  // screenshot QA in headless panes, where requestAnimationFrame never fires
  // and animations would otherwise freeze at their initial value.
  const staticMode = STATIC_MODE

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
            onClick={() => go(t.path)} badge={t.path === '/' ? nowCount : 0} />
        ))}
      </nav>

      <main className="relative z-10 px-4 sm:px-6 max-w-[760px] mx-auto pad-top">
        {error && !store.state && (
          <p className="mt-24 text-center text-[13px] text-bad">{error}</p>
        )}
        {loading && !store.state && (
          <p className="mt-24 text-center text-[13px] text-fg-mute">Waking up…</p>
        )}
        <AnimatePresence mode="wait">
          <motion.div
            key={active.path}
            initial={staticMode ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <active.Page />
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Mobile nav: a bottom bar, thumb-height, clear of the home indicator. */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-30 pad-bottom
                      bg-ink-900/90 backdrop-blur-xl border-t border-white/[0.06]">
        <div className="flex">
          {TABS.map(t => (
            <TabItem key={t.path} {...t} active={active.path === t.path}
              onClick={() => go(t.path)} badge={t.path === '/' ? nowCount : 0} />
          ))}
        </div>
      </nav>
    </div>
    </MotionConfig>
  )
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
      {badge > 0 && <span className="ml-0.5 tnum text-[11px] text-accent">{badge}</span>}
    </button>
  )
}

function TabItem({
  label, Icon, active, onClick, badge,
}: { label: string; Icon: any; active: boolean; onClick: () => void; badge: number }) {
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
