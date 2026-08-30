import { motion } from 'motion/react'
import { useStill } from '../lib/motion'
import { useEffect, useState } from 'react'
import { Flame, TrendingDown, TrendingUp } from 'lucide-react'
import { actions } from '../lib/api'
import type { Analytics } from '../lib/types'
import { duration } from '../lib/time'
import { Bars, DayClock, StackedAging, Trend, TREND_MIN_POINTS, WeekdayBars } from '../components/charts'
import { SOURCE_COLOR, SOURCE_LABEL } from '../components/sources'
import { Empty, Segmented } from '../components/primitives'
import { setParam, useParam } from '../lib/route'

const RANGES = ['7', '30', '90'] as const

export function Pulse() {
  const reduce = useStill()
  const days = Number(useParam('days') ?? 30) || 30
  const [a, setA] = useState<Analytics | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    actions.analytics(days)
      .then(d => { if (live) { setA(d); setErr(null) } })
      .catch(e => { if (live) setErr((e as Error).message) })
    return () => { live = false }
  }, [days])

  if (err) return <Empty>Analytics unavailable — {err}</Empty>
  if (!a) return <div className="pt-16"><Empty>Reading your history</Empty></div>

  /**
   * One answer per fact.
   *
   * The median-reply tile used to read `10.3h · p90 11.6h` while the panel
   * directly under it, fed by the same object, said "Not enough history yet" —
   * because the tile counted every latency and the chart counted days that had
   * one. They now agree by construction: both ask the chart's own question.
   */
  const trendDays = a.responseTime.daily.filter(d => d.value !== null).length
  const hasTrend = trendDays >= TREND_MIN_POINTS

  const period = `last ${a.pace.days}d`

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 pt-4 pb-2">
        <h1 className="text-lg font-medium">Pulse</h1>
        <Segmented
          className="ml-auto"
          options={RANGES.map(d => ({ id: d, label: `${d}d` }))}
          value={String(days) as (typeof RANGES)[number]}
          onChange={d => setParam('days', d === '30' ? null : d)}
          ariaLabel="Range"
        />
      </header>

      {/* Three numbers, no boxes — the type does the separating. Each one names
          the window it was measured over, because the range control now moves
          them and a number that changes without saying why is a number nobody
          trusts. */}
      <section className="grid grid-cols-3 gap-6 py-4">
        <Stat
          value={a.pace.period}
          label={`tasks done · ${period}`}
          foot={
            /* A percentage change from zero is not a fact; the two counts are. */
            a.pace.delta === null
              ? <span className="text-fg-mute">
                  {a.pace.previous === 0 && a.pace.period === 0
                    ? 'nothing in either period'
                    : `against ${a.pace.previous} the period before`}
                </span>
              : <span className={`inline-flex items-center gap-1 ${a.pace.delta >= 0 ? 'text-ok' : 'text-fg-mute'}`}>
                  {a.pace.delta >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                  {Math.round(Math.abs(a.pace.delta) * 100)}% against {a.pace.previous}
                </span>
          }
          accent
        />
        <Stat
          value={a.rhythm.streak}
          label="day streak · all time"
          foot={<span className="inline-flex items-center gap-1 text-fg-mute">
            <Flame size={12} /> best {a.rhythm.bestStreak}
          </span>}
        />
        <Stat
          value={hasTrend ? duration(a.responseTime.p50) : '—'}
          label={`median reply · ${period}`}
          foot={<span className="text-fg-mute">
            {hasTrend
              ? `p90 ${duration(a.responseTime.p90)} · ${a.responseTime.count} replies`
              : `${a.responseTime.count} replies on ${trendDays} day${trendDays === 1 ? '' : 's'} — not enough to trend`}
          </span>}
        />
      </section>

      {/* Two columns wide enough to compare, one narrow enough to still read —
          "did today's ageing spike match today's low throughput" is a question
          about two numbers at once, not two numbers a scroll apart. */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-x-12 lg:gap-y-4 lg:items-start">
        <Panel title="Throughput">
          <Bars
            data={a.throughput.done}
            label={d => `${d.day.slice(5)} · ${d.value} done`}
          />
        </Panel>

        <Panel title="Response time">
          <Trend data={a.responseTime.daily} format={v => duration(v)} />
        </Panel>

        <Panel title="The pile">
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

        <Panel title="Your rhythm">
          <div className="grid sm:grid-cols-2 gap-8 items-center">
            <DayClock data={a.rhythm.byHour} />
            <div>
              <SubLabel>By weekday</SubLabel>
              <WeekdayBars data={a.rhythm.byWeekday} />
            </div>
          </div>
        </Panel>

        {a.aging.length > 0 && (
          <Panel title="Ageing">
            <StackedAging
              rows={a.aging}
              buckets={a.agingBuckets}
              /* The same names every other surface uses: this legend said
                 `Claude` and `Github` where the rest of the product says
                 `Claude Code` and `GitHub`. */
              labelOf={(s: string) => SOURCE_LABEL[s as keyof typeof SOURCE_LABEL] ?? s}
              colorOf={s => SOURCE_COLOR[s as keyof typeof SOURCE_COLOR] ?? 'var(--color-fg-mute)'}
            />
            {/* One ramp with its labels under it, rather than five swatches that
                in dark mode are five near-identical greys. */}
            <div className="mt-4 flex items-end gap-1">
              {a.agingBuckets.map((b, i) => (
                <span key={b} className="flex-1">
                  <span className="block h-1.5 rounded-chip bg-fg-dim"
                        style={{ opacity: 0.3 + (i / Math.max(1, a.agingBuckets.length - 1)) * 0.7 }} />
                  <span className="block mt-1 text-xs text-fg-mute">{b}</span>
                </span>
              ))}
            </div>
          </Panel>
        )}

        {a.goals.length > 0 && (
          <Panel title="Goals">
            <div className="space-y-4">
              {a.goals.map((g, i) => {
                const pctDone = g.total ? g.done / g.total : 0
                return (
                  <div key={g.id}>
                    <div className="flex items-baseline justify-between mb-1.5">
                      <span className="text-sm text-fg-dim">{g.title}</span>
                      <span className="tnum text-xs text-fg-mute">
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
        className={`text-xl font-medium tnum ${accent ? 'text-accent-ink' : 'text-fg'}`}
      >
        {value}
      </motion.div>
      <div className="mt-2 text-sm text-fg-dim">{label}</div>
      <div className="mt-0.5 text-sm">{foot}</div>
    </div>
  )
}

/**
 * A heading and a chart.
 *
 * `hint` is gone from the signature for the same reason it is gone from `Field`:
 * six panels each carried a sentence explaining what its own chart was — `tasks
 * finished each day` under `Throughput`, `what is piling up, and how stale it
 * is` under `Ageing` — and a chart that needs a sentence is the wrong chart.
 * Removing the prop is what keeps them from coming back without a code change.
 * The short labels inside the panels stay: `ARRIVED`, `BY WEEKDAY` and
 * `4 replies on 1 day — not enough to trend` state facts, they do not instruct.
 */
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  const still = useStill()
  return (
    <motion.section
      className="mt-10"
      initial={still ? false : { opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <h2 className="text-md font-medium tracking-[-0.01em] mb-4">{title}</h2>
      {children}
    </motion.section>
  )
}

const SubLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="text-eyebrow uppercase text-fg-mute mb-2">{children}</div>
)
