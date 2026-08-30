/**
 * Pulse.
 *
 * Three numbers on one baseline, then a two-column grid of charts sharing one
 * gutter. Title only — no subtitles, no captions, no hints, no footer, and
 * nothing centred.
 *
 * Four things changed, all of them measured.
 *
 * **A panel with no data is not rendered.** `Response time` spent 210px printing
 * "Not enough history" into a 572×132 hole, and `Bars` centred "Nothing here
 * yet" in another. An empty series is an em dash on the title row, and the chart
 * is not drawn — which is what `Goals` and `Ageing` already did, correctly.
 *
 * **The hint sentences are gone from the stat feet.** The `hint` prop left
 * `Panel` in an earlier pass and the sentences moved into the numbers'
 * subtitles: `4 replies on 1 day — not enough to trend` is forty characters of
 * explanation under a number.
 *
 * **`whileInView` is gone.** With `viewport={{ once: true }}` the panels below
 * the fold never enter the viewport in a capture, a print, a background tab or a
 * slow observer, so 838px of the phone page was present in the DOM, occupying
 * layout, and painting nothing.
 *
 * **The hero row is responsive.** `grid-cols-3` with no breakpoint gave three
 * 98px columns at 390px, so every label wrapped to three lines and the block had
 * a ragged bottom.
 */

import { motion } from 'motion/react'
import { useStill } from '../lib/motion'
import { useEffect, useState } from 'react'
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

  if (err) return <div className="pt-4"><Header days={days} /><Empty>—</Empty></div>
  if (!a) return <div className="pt-4"><Header days={days} /></div>

  /**
   * One answer per fact. The median tile used to read `10.3h · p90 11.6h` while
   * the panel under it, fed by the same object, said there was not enough
   * history — because the tile counted every latency and the chart counted days
   * that had one. Both ask the chart's question now.
   */
  const trendDays = a.responseTime.daily.filter(d => d.value !== null).length
  const hasTrend = trendDays >= TREND_MIN_POINTS
  const period = `last ${a.pace.days}d`

  const arrived = a.throughput.appeared.reduce((n, d) => n + d.value, 0)
  const cleared = a.throughput.cleared.reduce((n, d) => n + d.value, 0)

  return (
    <div className="pb-24">
      <Header days={days} />

      {/* Three numbers, one baseline, and each names the window it was measured
          over, because the range control moves them. Two columns on a phone, so
          nothing wraps to three lines. */}
      <section className="grid grid-cols-2 sm:grid-cols-3 gap-6 py-4">
        <Stat value={a.pace.period} label={`tasks done · ${period}`}
          foot={a.pace.delta === null
            ? `against ${a.pace.previous} before`
            : `${a.pace.delta >= 0 ? '+' : ''}${Math.round(a.pace.delta * 100)}% against ${a.pace.previous}`} />
        <Stat value={a.rhythm.streak} label="day streak · all time"
          foot={`best ${a.rhythm.bestStreak}`} />
        {/* Arrived against cleared, which is a fact this database actually has,
            rather than a median over four samples on one day. */}
        <Stat value={cleared} label={`cleared · ${period}`} foot={`${arrived} arrived`} />
      </section>

      {/* One gutter, one row gap, and no `items-start`: a 109px cell beside a
          320px cell in an `items-start` grid is where the 275px hole came from. */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-6">
        <Panel title="Throughput" empty={a.throughput.done.every(d => !d.value)}>
          <Bars data={a.throughput.done} label={d => `${d.day.slice(5)} · ${d.value} done`} />
        </Panel>

        <Panel title="Response time" empty={!hasTrend}>
          <Trend data={a.responseTime.daily} format={v => duration(v)} />
        </Panel>

        <Panel title="Arrived" empty={!arrived}>
          <Bars data={a.throughput.appeared} height={96} />
        </Panel>

        <Panel title="Cleared" empty={!cleared}>
          <Bars data={a.throughput.cleared} height={96} />
        </Panel>

        <Panel title="Your rhythm" empty={a.rhythm.byHour.every(h => !h.value)}>
          <div className="grid sm:grid-cols-2 gap-6">
            <DayClock data={a.rhythm.byHour} />
            <div>
              <SubLabel>By weekday</SubLabel>
              <WeekdayBars data={a.rhythm.byWeekday} />
            </div>
          </div>
        </Panel>

        <Panel title="Ageing" empty={!a.aging.length}>
          <StackedAging
            rows={a.aging}
            buckets={a.agingBuckets}
            /* The same names every other surface uses: this legend said `Claude`
               and `Github` where the rest of the product says `Claude Code` and
               `GitHub`. */
            labelOf={(s: string) => SOURCE_LABEL[s as keyof typeof SOURCE_LABEL] ?? s}
            colorOf={s => SOURCE_COLOR[s as keyof typeof SOURCE_COLOR] ?? 'var(--color-fg-mute)'}
          />
          <div className="mt-4 flex items-end gap-1">
            {a.agingBuckets.map((b, i) => (
              <span key={b} className="flex-1">
                <span className="block h-1.5 rounded-chip bg-fg-dim"
                      style={{ opacity: 0.3 + (i / Math.max(1, a.agingBuckets.length - 1)) * 0.7 }} />
                <span className="block mt-1 text-sm text-fg-mute">{b}</span>
              </span>
            ))}
          </div>
        </Panel>

        <Panel title="Goals" empty={!a.goals.length} wide>
          <div className="space-y-4">
            {a.goals.map((g, i) => {
              const pctDone = g.total ? g.done / g.total : 0
              return (
                <div key={g.id}>
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-sm text-fg-dim">{g.title}</span>
                    <span className="tnum text-sm text-fg-mute">{g.done}/{g.total}</span>
                  </div>
                  <div className="h-1 bg-ink-800 rounded-full overflow-hidden">
                    <motion.div className="h-full rounded-full bg-fg-dim"
                      style={g.color ? { background: g.color } : undefined}
                      initial={reduce ? false : { width: 0 }} animate={{ width: `${pctDone * 100}%` }}
                      transition={{ delay: 0.1 + i * 0.06, duration: 0.7, ease: [0.22, 1, 0.36, 1] }} />
                  </div>
                </div>
              )
            })}
          </div>
        </Panel>
      </div>
    </div>
  )
}

function Header({ days }: { days: number }) {
  return (
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
  )
}

/**
 * A number, its label, and one comparison. The hero is `fg`, not amber: a count
 * of completed tasks is not "this one", and the accent was hard-passed to the
 * first tile whatever it happened to say.
 */
function Stat({
  value, label, foot,
}: { value: number | string; label: string; foot?: string }) {
  const still = useStill()
  return (
    <div>
      <motion.div
        initial={still ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 28 }}
        className="text-xl font-medium tnum text-fg"
      >
        {value}
      </motion.div>
      <div className="mt-2 text-sm text-fg-dim">{label}</div>
      <div className="mt-1 text-sm text-fg-mute">{foot}</div>
    </div>
  )
}

/**
 * A heading and a chart, and an em dash when there is no chart.
 *
 * `hint` left this signature in an earlier pass and a test keeps it out. `empty`
 * is the other half of the same idea: a panel with nothing to draw states that
 * on its own title row in one character, rather than reserving 210px to say it
 * in three words.
 *
 * Rendered statically. `whileInView` with `once: true` left everything below the
 * fold at `opacity: 0` in any capture, print or background tab.
 */
function Panel({
  title, empty, wide, children,
}: { title: string; empty?: boolean; wide?: boolean; children: React.ReactNode }) {
  const still = useStill()
  return (
    <motion.section
      /* The last panel spans both columns rather than orphaning a 470×130 hole
         beside itself, which is what an odd count in a two-column grid does. */
      className={`mt-8 ${wide ? 'lg:col-span-2' : ''}`}
      initial={still ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex items-baseline gap-2 mb-4">
        <h2 className="text-eyebrow uppercase text-fg-mute">{title}</h2>
        {empty && <span className="text-sm text-fg-mute">—</span>}
      </div>
      {!empty && children}
    </motion.section>
  )
}

const SubLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="text-eyebrow uppercase text-fg-mute mb-2">{children}</div>
)
