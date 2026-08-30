import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { actions, optimistic, refresh, reload, useStore } from '../lib/api'
import type { Card as CardT } from '../lib/types'
import { atHour, ago, greeting } from '../lib/time'
import { Card } from '../components/Card'
import { CardSheet } from '../components/CardSheet'
import { TaskSheet } from '../components/TaskSheet'
import { Empty, spring } from '../components/primitives'
import { useStill } from '../lib/motion'
import { SOURCE_LABEL } from '../components/sources'
import { openLaunch } from '../lib/launch'
import { cardContext, cardTitle, repoHintFor, templateFor } from '../lib/cardContext'
import { registerPaletteActions } from '../components/palette'

/**
 * Stable empty arrays.
 *
 * `state?.now ?? []` builds a fresh array on every render, which makes every
 * `useMemo` keyed on it recompute, which makes the effect that registers this
 * page's palette actions re-run, which re-renders the shell — a loop that took
 * React's "maximum update depth" error to notice. A shared constant is
 * referentially stable, so nothing downstream sees a change that did not happen.
 */
const NO_CARDS: CardT[] = []

export function Home() {
  const still = useStill()
  const { state, syncing } = useStore()
  const [openCard, setOpenCard] = useState<CardT | null>(null)
  const [taskFrom, setTaskFrom] = useState<CardT | null>(null)
  const [showParked, setShowParked] = useState(false)
  /**
   * `null` until someone actually navigates.
   *
   * Defaulting to 0 meant the first row was highlighted before anyone chose it,
   * and — worse — a stray `e` completed something the reader had not selected.
   * Keyboard actions apply to a selection, and there is no selection until a
   * key makes one.
   */
  const [cursor, setCursor] = useState<number | null>(null)

  const now = state?.now ?? NO_CARDS
  const open = state?.open ?? NO_CARDS
  const parked = state?.parked ?? NO_CARDS

  const today = useMemo(
    () => new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    [],
  )

  /** Remove locally first so the list closes under the thumb immediately. */
  const drop = (g: string) =>
    optimistic(s => {
      for (const k of ['now', 'open', 'parked'] as const) {
        s[k] = s[k].filter(c => c.group_key !== g)
      }
      return s
    })

  const done = async (c: CardT) => { drop(c.group_key); await actions.doneCard(c.group_key); void reload() }
  const snooze = async (c: CardT) => { drop(c.group_key); await actions.snooze(c.group_key, atHour(1, 9)); void reload() }

  // One context entry per place the card was seen, each with its own facts —
  // see lib/cardContext.ts for what the one-line version used to produce.
  const launch = (c: CardT) =>
    openLaunch(cardContext(c), {
      template: templateFor(c),
      repoHint: repoHintFor(c),
      title: cardTitle(c),
    })

  /**
   * j/k over the visible rows, Enter to open.
   *
   * Scoped to keydown on the document but ignored while a field has focus, so
   * typing "j" in the composer on another page cannot move a selection here.
   */
  const rows = useMemo(() => [...now, ...open], [now, open])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!rows.length) return

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor(c => (c === null ? 0 : Math.min(c + 1, rows.length - 1)))
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor(c => (c === null ? 0 : Math.max(c - 1, 0)))
        return
      }
      if (e.key === 'Escape') return setCursor(null)

      // Everything below acts on the selection, so it does nothing until j or k
      // has made one.
      const card = cursor === null ? null : rows[cursor]
      if (!card) return
      if (e.key === 'Enter') { e.preventDefault(); setOpenCard(card) }
      else if (e.key === 'e') { e.preventDefault(); void done(card) }
      else if (e.key === 's') { e.preventDefault(); void snooze(card) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [rows, cursor])

  // A shrinking list must not leave the cursor past the end.
  useEffect(() => {
    setCursor(c => (c === null ? null : Math.min(c, Math.max(rows.length - 1, 0))))
  }, [rows.length])

  useEffect(() =>
    registerPaletteActions(() =>
      rows.slice(0, 20).map(c => ({
        id: `card:${c.group_key}`,
        label: c.title,
        hint: c.why,
        group: 'Cards',
        run: () => setOpenCard(c),
      })),
    ), [rows])

  const cardProps = (c: CardT) => ({
    card: c,
    focused: cursor !== null && rows[cursor]?.group_key === c.group_key,
    onOpen: setOpenCard,
    onDone: done,
    onSnooze: snooze,
    onTask: setTaskFrom,
    onLaunch: launch,
  })

  return (
    <div className="pb-24">
      <header className="pt-8 pb-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[26px] sm:text-[30px] font-medium tracking-[-0.025em] leading-none">
              {greeting()}
            </h1>
            <p className="mt-2 text-[13px] text-fg-mute">{today}</p>
          </div>
          <button
            onClick={() => void refresh()}
            title="Refresh all sources"
            className="p-2 -mr-2 text-fg-mute hover:text-fg-dim transition-colors"
          >
            <RefreshCw size={15} className={syncing ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      {/* The hero. The count is the only place a large number appears, and the
          only routine use of the accent — that is what makes it read as urgent
          without any red, badges or alarm styling. */}
      <section className="pt-1 pb-1">
        <div className="flex items-baseline gap-3 mb-1">
          <motion.span
            key={now.length}
            initial={still ? false : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={spring}
            className={`text-[40px] leading-none font-medium tnum tracking-[-0.03em]
              ${now.length ? 'text-accent-ink' : 'text-fg-mute'}`}
          >
            {now.length}
          </motion.span>
          <div>
            <h2 className="text-[15px] font-medium tracking-[-0.01em]">Now</h2>
            <p className="text-[12.5px] text-fg-mute">
              {now.length ? 'someone is waiting on you' : 'nobody is waiting on you'}
            </p>
          </div>
        </div>

        <div className={now.length ? 'mt-4' : 'mt-1'}>
          <AnimatePresence initial={false} mode="popLayout">
            {now.map(c => <Card key={c.group_key} {...cardProps(c)} />)}
          </AnimatePresence>
          {!now.length && (
            <p className="text-[13px] text-fg-mute py-5 leading-relaxed">
              Clear. Nothing is waiting on a reply from you.
            </p>
          )}
        </div>
      </section>

      <Section title="Open" count={open.length} hint="you started these">
        <AnimatePresence initial={false} mode="popLayout">
          {open.map(c => <Card key={c.group_key} {...cardProps(c)} />)}
        </AnimatePresence>
        {!open.length && <Empty>Nothing in flight.</Empty>}
      </Section>

      {parked.length > 0 && (
        <section className="mt-10">
          <button
            onClick={() => setShowParked(v => !v)}
            className="flex items-center gap-1.5 text-[13px] text-fg-mute hover:text-fg-dim
                       transition-colors py-1 min-h-9"
          >
            <motion.span animate={{ rotate: showParked ? 90 : 0 }} transition={spring}>
              <ChevronRight size={14} />
            </motion.span>
            Parked
            <span className="tnum text-fg-mute/70">{parked.length}</span>
          </button>
          <AnimatePresence initial={false}>
            {showParked && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                <div className="pt-3">
                  {parked.map(c => (
                    <Card key={c.group_key} card={c} onOpen={setOpenCard} onDone={done} onSnooze={snooze}
                      onTask={setTaskFrom} onLaunch={launch} />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}

      <SyncLine />

      <CardSheet
        card={openCard}
        onClose={() => setOpenCard(null)}
        onMakeTask={c => { setOpenCard(null); setTaskFrom(c) }}
      />
      <TaskSheet
        open={!!taskFrom}
        onClose={() => setTaskFrom(null)}
        fromCard={taskFrom}
      />
    </div>
  )
}

/**
 * One line, at the bottom, naming when each source last answered and which one
 * did not. It replaces the old habit of finding that out in Settings — the
 * question "is this list complete?" belongs next to the list.
 */
function SyncLine() {
  const { state } = useStore()
  const rows = state?.lastSync ?? []
  if (!rows.length) return null

  return (
    <p className="mt-10 text-[11.5px] text-fg-mute flex flex-wrap items-center gap-x-2 gap-y-1">
      {rows.map((r, i) => (
        <span key={r.source} className="inline-flex items-center gap-1.5">
          {i > 0 && <span className="text-ink-600">·</span>}
          <span className={r.ok ? '' : 'text-warn'}>
            {SOURCE_LABEL[r.source as keyof typeof SOURCE_LABEL] ?? r.source}
            {' '}
            {r.ok ? ago(r.at) : 'needs connect'}
          </span>
        </span>
      ))}
    </p>
  )
}

function Section({
  title, count, hint, children,
}: { title: string; count: number; hint: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h2>
        <span className="tnum text-[13px] text-fg-mute">{count}</span>
        <span className="text-[12.5px] text-fg-mute/70 ml-auto">{hint}</span>
      </div>
      {children}
    </section>
  )
}
