import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { actions, optimistic, refresh, reload, useStore } from '../lib/api'
import type { Card as CardT } from '../lib/types'
import { atHour, greeting } from '../lib/time'
import { Card } from '../components/Card'
import { CardSheet } from '../components/CardSheet'
import { TaskSheet } from '../components/TaskSheet'
import { Empty, spring } from '../components/primitives'
import { useStill } from '../lib/motion'

export function Home() {
  const still = useStill()
  const { state, syncing } = useStore()
  const [openCard, setOpenCard] = useState<CardT | null>(null)
  const [taskFrom, setTaskFrom] = useState<CardT | null>(null)
  const [showParked, setShowParked] = useState(false)

  const now = state?.now ?? []
  const open = state?.open ?? []
  const parked = state?.parked ?? []

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
              ${now.length ? 'text-accent' : 'text-fg-mute'}`}
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
            {now.map(c => (
              <Card key={c.group_key} card={c} onOpen={setOpenCard} onDone={done} onSnooze={snooze} />
            ))}
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
          {open.map(c => (
            <Card key={c.group_key} card={c} onOpen={setOpenCard} onDone={done} onSnooze={snooze} />
          ))}
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
                    <Card key={c.group_key} card={c} onOpen={setOpenCard} onDone={done} onSnooze={snooze} />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}

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
