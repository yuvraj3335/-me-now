import { motion } from 'motion/react'
import { useStill } from '../lib/motion'
import { useEffect, useState } from 'react'
import { Flame, TrendingDown, TrendingUp } from 'lucide-react'
import { actions } from '../lib/api'
import type { Analytics } from '../lib/types'
import { duration } from '../lib/time'
import { Bars, DayClock, StackedAging, Trend, WeekdayBars } from '../components/charts'
import { SOURCE_COLOR } from '../components/sources'
import { Chip, Empty } from '../components/primitives'

const RANGES = [7, 30, 90]

export function Pulse() {
  const reduce = useStill()
  const [days, setDays] = useState(30)
  const [a, setA] = useState<Analytics | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    actions.analytics(days)
      .then(d => { if (live) { setA(d); setErr(null) } })
      .catch(e => { if (live) setErr((e as Error).message) })
    return () => { live = false }
  }, [days])

  if (err) return <Empty>Couldn’t load analytics: {err}</Empty>
  if (!a) return <div className="pt-32"><Empty>Reading your history…</Empty></div>

  const up = a.pace.delta >= 0
  const pct = Math.round(Math.abs(a.pace.delta) * 100)

  return (
    <div className="pb-24">
      <header className="pt-8 pb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] sm:text-[30px] font-medium tracking-[-0.025em] leading-none">Pulse</h1>
          <p className="mt-2 text-[13px] text-fg-mute">How fast you’re actually moving</p>
        </div>
        <div className="flex gap-1">
          {RANGES.map(d => (
            <Chip key={d} active={days === d} onClick={() => setDays(d)}>{d}d</Chip>
          ))}
        </div>
      </header>

      {/* Hero row. Three numbers, no boxes — the type does the separating. */}
      <section className="grid grid-cols-3 gap-4 sm:gap-8 py-6">
        <Stat
          value={a.pace.thisWeek}
          label="done this week"
          foot={
            a.pace.lastWeek || a.pace.thisWeek ? (
              <span className={`inline-flex items-center gap-1 ${up ? 'text-ok' : 'text-fg-mute'}`}>
                {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                {pct}% vs last
              </span>
            ) : <span className="text-fg-mute">no history yet</span>
          }
          accent
        />
        <Stat
          value={a.rhythm.streak}
          label={`day streak`}
          foot={<span className="inline-flex items-center gap-1 text-fg-mute">
            <Flame size={12} /> best {a.rhythm.bestStreak}
          </span>}
        />
        <Stat
          value={a.responseTime.count ? duration(a.responseTime.p50) : '—'}
          label="median reply"
          foot={<span className="text-fg-mute">
            {a.responseTime.count ? `p90 ${duration(a.responseTime.p90)}` : 'not enough data'}
          </span>}
        />
      </section>

      {/* Two columns wide enough to compare, one narrow enough to still read —
          "did today's ageing spike match today's low throughput" is a question
          about two numbers at once, not two numbers a scroll apart. */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-x-12 lg:gap-y-4 lg:items-start">
        <Panel title="Throughput" hint="tasks finished each day">
          <Bars
            data={a.throughput.done}
            label={d => `${d.day.slice(5)} · ${d.value} done`}
          />
        </Panel>

        <Panel title="Response time" hint="how long something waits before you touch it">
          <Trend data={a.responseTime.daily} format={v => duration(v)} />
        </Panel>

        <Panel title="The pile" hint="what arrived vs what you cleared">
          <div className="grid sm:grid-cols-2 gap-8">
            <div>
              <SubLabel>Arrived</SubLabel>
              <Bars data={a.throughput.appeared} color="var(--color-fg-mute)" height={96} />
            </div>
            <div>
              <SubLabel>Cleared</SubLabel>
              <Bars data={a.throughput.cleared} color="var(--color-ok)" height={96} />
            </div>
          </div>
        </Panel>

        <Panel title="Your rhythm" hint="when the work actually happens">
          <div className="grid sm:grid-cols-2 gap-8 items-center">
            <DayClock data={a.rhythm.byHour} />
            <div>
              <SubLabel>By weekday</SubLabel>
              <WeekdayBars data={a.rhythm.byWeekday} />
            </div>
          </div>
        </Panel>

        {a.aging.length > 0 && (
          <Panel title="Ageing" hint="what is piling up, and how stale it is">
            <StackedAging
              rows={a.aging}
              buckets={a.agingBuckets}
              colorOf={s => SOURCE_COLOR[s as keyof typeof SOURCE_COLOR] ?? 'var(--color-fg-mute)'}
            />
            <div className="flex gap-3 mt-4 text-[11px] text-fg-mute">
              {a.agingBuckets.map((b, i) => (
                <span key={b} className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-[2px] bg-fg-mute"
                        style={{ opacity: 0.28 + (i / Math.max(1, a.agingBuckets.length - 1)) * 0.72 }} />
                  {b}
                </span>
              ))}
            </div>
          </Panel>
        )}

        {a.goals.length > 0 && (
          <Panel title="Goals" hint="tasks completed against each">
            <div className="space-y-4">
              {a.goals.map((g, i) => {
                const pctDone = g.total ? g.done / g.total : 0
                return (
                  <div key={g.id}>
                    <div className="flex items-baseline justify-between mb-1.5">
                      <span className="text-[13.5px] text-fg-dim">{g.title}</span>
                      <span className="tnum text-[12.5px] text-fg-mute">
                        {g.done}/{g.total}
                      </span>
                    </div>
                    <div className="h-[3px] bg-ink-800 rounded-full overflow-hidden">
                      <motion.div className="h-full rounded-full"
                        style={{ background: g.color ?? 'var(--color-accent)' }}
                        initial={reduce ? false : { width: 0 }} animate={{ width: `${pctDone * 100}%` }}
                        transition={{ delay: 0.1 + i * 0.06, duration: 0.7, ease: [0.22, 1, 0.36, 1] }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </Panel>
        )}
      </div>

      <p className="mt-12 text-[12px] text-fg-mute leading-relaxed">
        Every number here is counted from your own activity log — nothing is estimated,
        and nothing was generated.
      </p>
    </div>
  )
}

function Stat({
  value, label, foot, accent,
}: { value: number | string; label: string; foot?: React.ReactNode; accent?: boolean }) {
  const still = useStill()
  return (
    <div>
      <motion.div
        initial={still ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 28 }}
        className={`text-[32px] sm:text-[38px] leading-none font-medium tnum tracking-[-0.03em]
          ${accent ? 'text-accent-ink' : 'text-fg'}`}
      >
        {value}
      </motion.div>
      <div className="mt-2 text-[12.5px] text-fg-dim">{label}</div>
      <div className="mt-1 text-[11.5px]">{foot}</div>
    </div>
  )
}

function Panel({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  const still = useStill()
  return (
    <motion.section
      className="mt-12"
      initial={still ? false : { opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex items-baseline gap-2.5 mb-5">
        <h2 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h2>
        <span className="text-[12.5px] text-fg-mute">{hint}</span>
      </div>
      {children}
    </motion.section>
  )
}

const SubLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[11px] uppercase tracking-[0.08em] text-fg-mute mb-3">{children}</div>
)
