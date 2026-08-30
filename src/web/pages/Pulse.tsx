/**
 * Pulse.
 *
 * Three numbers on one baseline, then a two-column grid of panels sharing one
 * gutter. Title only — no subtitles, no captions, no hints, no footer, and
 * nothing centred.
 *
 * The page used to draw seven time-series over a handful of counts: a 24-hour
 * dial reading `00:00 / 2 done`, a by-weekday chart that was one bar, a
 * five-colour stacked bar in shades nobody could tell apart, and four one-line
 * rows of which Response time was a permanent em dash. Six marks replace them,
 * chosen by what the data actually is rather than by what a dashboard usually
 * has: a share of a whole is a donut, a distribution across five ordered
 * buckets is one stacked bar, and two counted series that answer the same
 * question are one chart, not two.
 *
 * Three rules survive from the pass before it, all of them measured.
 *
 * **A series with no data does not hold a cell.** An empty series is an em dash
 * on a title row, the chart is not drawn, and the row is laid out after the grid
 * so it cannot leave a hole next to a short tile.
 *
 * **`whileInView` is gone.** With `viewport={{ once: true }}` the panels below
 * the fold never enter the viewport in a capture, a print, a background tab or a
 * slow observer, so 838px of the phone page was present in the DOM, occupying
 * layout, and painting nothing.
 *
 * **Every number is readable without a pointer.** The marks carry legends with
 * counts and percentages as text; nothing here depends on `title=` or a hover.
 */

import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { useStill } from '../lib/motion'
import { actions } from '../lib/api'
import type { Analytics, SourceName } from '../lib/types'
import { duration } from '../lib/time'
import { Bars, Donut, Legend, PartBar, Ring, WeekdayBars, type DonutSlice } from '../components/charts'
import { SOURCE_COLOR, SOURCE_LABEL } from '../components/sources'
import { Empty, Segmented } from '../components/primitives'
import { setParam, useParam } from '../lib/route'

const RANGES = ['7', '30', '90'] as const

/**
 * The order slices sit in around the ring.
 *
 * Fixed, not sorted by size. `sort(null)` on the pie generator stops d3 from
 * reordering, and this is what it defers to — a ring whose slices trade places
 * whenever a count changes looks like the data moved when only a number did.
 *
 * Claude leads at twelve o'clock: it is the great majority of rows here and its
 * token is deliberately hueless, so putting it first makes the coloured minority
 * read as the minority. Gmail and Sentry are kept apart because their tokens are
 * about fifteen degrees of hue from each other and are not separable at 390px;
 * `separated` below repairs the subsets where this order alone does not do it.
 */
const RING_ORDER: SourceName[] = ['claude', 'gmail', 'github', 'slack', 'sentry']

const ringAdjacent = (i: number, j: number, n: number) =>
  Math.abs(i - j) === 1 || Math.abs(i - j) === n - 1

/**
 * Move Sentry off Gmail's shoulder when the present subset lands them together.
 *
 * Below four slices every pair on a ring is adjacent, so there is nothing to
 * repair and nothing is attempted.
 */
function separated(rows: DonutSlice[]): DonutSlice[] {
  const n = rows.length
  if (n < 4) return rows
  const gi = rows.findIndex(r => r.id === 'gmail')
  const si = rows.findIndex(r => r.id === 'sentry')
  if (gi < 0 || si < 0 || !ringAdjacent(gi, si, n)) return rows
  // Swap Sentry with its other neighbour: one step along the ring is always
  // enough to break a single adjacency once there are four seats.
  const other = si === n - 1 ? n - 2 : (si + 1) % n
  const out = [...rows]
  ;[out[si], out[other]] = [out[other]!, out[si]!]
  return out
}

/**
 * Ok → warn → bad across however many buckets there are, mixed in oklab so the
 * middle steps are perceptually even rather than evenly spaced in sRGB. Every
 * stop is a token: a hex here would not follow the theme, and light mode's
 * palette is a different set of hues, not the same ones dimmed.
 */
function staleRamp(i: number, n: number): string {
  const mid = (n - 1) / 2
  if (i <= mid) {
    const t = Math.round((i / mid) * 100)
    return `color-mix(in oklab, var(--color-warn) ${t}%, var(--color-ok))`
  }
  const t = Math.round(((i - mid) / (n - 1 - mid)) * 100)
  return `color-mix(in oklab, var(--color-bad) ${t}%, var(--color-warn))`
}

/** Four parts of a day, and the hours each one owns. */
const DAY_PARTS: Array<{ id: string; label: string; from: number; to: number; weight: number }> = [
  { id: 'night', label: 'Night', from: 0, to: 5, weight: 25 },
  { id: 'morning', label: 'Morning', from: 6, to: 11, weight: 50 },
  { id: 'afternoon', label: 'Afternoon', from: 12, to: 17, weight: 75 },
  { id: 'evening', label: 'Evening', from: 18, to: 23, weight: 100 },
]

// A monochrome ramp on purpose. The five source hues are spent on the first
// donut, and a second coloured ring on the same page would read as a second
// taxonomy rather than as a clock.
const partColor = (weight: number) =>
  `color-mix(in oklab, var(--color-fg-dim) ${weight}%, var(--color-ink-700))`

export function Pulse() {
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

  const period = `last ${a.pace.days}d`

  /**
   * One bar is not a chart.
   *
   * An axis exists to put a value next to the values around it. With a single
   * day in the window there is nothing to put it next to, so the axis is six
   * empty slots and a label pair spanning days that hold nothing — one 12px mark
   * under 95% ruled paper. A series that thin is a number, and the row form the
   * empty series already uses is where a number goes.
   *
   * `value` is that day's count when there is exactly one, so the row can say
   * what it has rather than an em dash it would be lying with.
   */
  const shape = (series: Array<{ day: string; value: number }>) => {
    const marked = series.filter(d => d.value > 0)
    return {
      thin: marked.length < 2,
      value: marked.length === 1 ? `${marked[0]!.value} on ${marked[0]!.day.slice(5)}` : undefined,
    }
  }
  const done = shape(a.throughput.done)
  const clearedShape = shape(a.throughput.cleared)

  /* --- panel 1: what is on the desk, by source --------------------------- */
  const bySource = new Map(a.aging.map(r => [
    r.source,
    a.agingBuckets.reduce((n, b) => n + (r.buckets[b] ?? 0), 0),
  ]))
  const desk = separated(
    RING_ORDER
      .filter(s => (bySource.get(s) ?? 0) > 0)
      .map(s => ({
        id: s,
        label: SOURCE_LABEL[s] ?? s,
        value: bySource.get(s)!,
        color: SOURCE_COLOR[s] ?? 'var(--color-fg-mute)',
      })),
  )
  // A source the map has never heard of still has to appear, or the ring and the
  // centre count disagree and one of them is wrong.
  for (const [source, value] of bySource) {
    if (value > 0 && !RING_ORDER.includes(source as SourceName)) {
      desk.push({ id: source, label: source, value, color: 'var(--color-fg-mute)' })
    }
  }

  /* --- panel 2: how stale ------------------------------------------------ */
  const stale = a.agingBuckets.map((b, i) => ({
    id: b,
    label: b,
    value: a.aging.reduce((n, r) => n + (r.buckets[b] ?? 0), 0),
    color: staleRamp(i, a.agingBuckets.length),
  }))
  const staleMarked = stale.filter(s => s.value > 0)

  /* --- panel 5: when you work -------------------------------------------- */
  const parts: DonutSlice[] = DAY_PARTS.map(p => ({
    id: p.id,
    label: p.label,
    value: a.rhythm.byHour
      .filter(h => h.hour >= p.from && h.hour <= p.to)
      .reduce((n, h) => n + h.value, 0),
    color: partColor(p.weight),
  }))
  const peak = a.rhythm.byHour.reduce((best, h) => (h.value > best.value ? h : best), a.rhythm.byHour[0]!)

  const panels: Array<{ title: string; empty: boolean; value?: string; node: React.ReactNode }> = [
    {
      title: 'On the desk',
      empty: !desk.length,
      // Stacked until `lg`. Between 640 and 1023 a panel is half of a narrow
      // page, and a 240px ring beside a legend there left `Claude Code`
      // truncated to `Claude Co…` — the legend is the data, so it gets the
      // width and the ring goes above it.
      node: (
        <div className="flex flex-col items-center gap-5 lg:flex-row lg:items-center lg:gap-6">
          <Donut
            slices={desk}
            size={200}
            total={a.totals.openNow}
            centreTop="cards"
            centreFoot={desk.length === 1 ? 'one source' : `${desk.length} sources`}
          />
          <div className="w-full grow min-w-0"><Legend items={desk} /></div>
        </div>
      ),
    },
    {
      title: 'How stale',
      // One non-empty bucket is five segments of one colour and a legend of one
      // row. That is a number, and it takes the quiet row a number takes.
      empty: staleMarked.length < 2,
      value: staleMarked.length === 1 ? `${staleMarked[0]!.value} · ${staleMarked[0]!.label}` : undefined,
      node: <PartBar segments={stale} />,
    },
    {
      title: 'Flow',
      empty: clearedShape.thin,
      value: clearedShape.value,
      // Arrived behind, cleared in front, on one axis. As two charts they were
      // side by side with independent maxima, so the one comparison worth making
      // — is more coming in than going out — had to be done in the reader's head
      // against two different rulers.
      node: (
        <Bars
          data={a.throughput.cleared}
          secondary={a.throughput.appeared}
          title="cards cleared each day, against the cards that arrived"
          label={d => `${d.day.slice(5)} · ${d.value} cleared`}
        />
      ),
    },
    {
      title: 'Done each day',
      empty: done.thin,
      value: done.value,
      node: (
        <Bars
          data={a.throughput.done}
          title="tasks finished each day"
          label={d => `${d.day.slice(5)} · ${d.value} done`}
        />
      ),
    },
    {
      title: 'When you work',
      empty: a.rhythm.byHour.every(h => !h.value),
      // Two marks stacked, each with the whole panel to itself. Side by side
      // they were three things in one half-column: the day-part legend clipped
      // its own words to `N…` and `A…`, and seven weekday names collided into
      // `SunMonTueWedThuFri Sat`.
      node: (
        <div className="space-y-6">
          <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-6">
            <Donut
              slices={parts}
              size={160}
              total={`${String(peak.hour).padStart(2, '0')}:00`}
              centreTop="peak hour"
              centreFoot={`${peak.value} done`}
            />
            <div className="w-full grow min-w-0"><Legend items={parts} /></div>
          </div>
          <div>
            <SubLabel>By weekday</SubLabel>
            <WeekdayBars data={a.rhythm.byWeekday} />
          </div>
        </div>
      ),
    },
    {
      title: 'Goals',
      empty: !a.goals.length,
      node: (
        <div className="flex flex-wrap gap-6">
          {a.goals.map(g => (
            <Ring
              key={g.id}
              label={g.title}
              value={g.done}
              total={g.total}
              /* A goal's own colour is the one amber this page is allowed, and
                 only because he chose it. Everything else here is neutral. */
              color={g.color ?? undefined}
            />
          ))}
        </div>
      ),
    },
  ]
  const drawn = panels.filter(p => !p.empty)
  const quiet = panels.filter(p => p.empty)

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
        {/* Revives a real measurement the page had stopped printing. Response
            time had a whole panel and it rendered an em dash at every range,
            because a line needs two days with a sample and the median needs one.
            The median is the fact; the panel was the wrong shape for it. */}
        {a.responseTime.count > 0 && (
          <Stat value={duration(a.responseTime.p50)} label={`median reply · ${period}`}
            foot={`p90 ${duration(a.responseTime.p90)}`} />
        )}
      </section>

      {/* One gutter, one row gap, and no `items-start`: a 109px cell beside a
          320px cell in an `items-start` grid is where the 275px hole came from.
          The break is at `sm`, not `lg` — a 640–1023px tablet was reading every
          panel full-width in one stack, which is a phone layout on a screen with
          room for two columns. */}
      <div className="sm:grid sm:grid-cols-2 sm:gap-6 lg:gap-8">
        {drawn.map((p, i) => (
          <Panel
            key={p.title}
            title={p.title}
            /* The last tile spans both columns when the count is odd, so the
               row it lands on cannot orphan a hole beside it. It is a fact
               about the count, not a property of one chart, which is why it is
               computed rather than declared: the count moves with the data. */
            wide={i === drawn.length - 1 && drawn.length % 2 === 1}
          >
            {p.node}
          </Panel>
        ))}
      </div>

      {/* And the ones with nothing to draw, one row each. The series is still
          named — its absence is a fact about the window — but a name and an em
          dash is one line, not a cell. A series with a single marked day lands
          here too, and says that day's number: it has a value, so an em dash
          would be the one thing on this page that is not true. */}
      {quiet.length > 0 && (
        <section className="mt-8">
          {quiet.map(p => (
            <div key={p.title} className="flex items-baseline gap-2 h-11 border-b border-rule last:border-0">
              <h2 className="text-eyebrow uppercase text-fg-mute">{p.title}</h2>
              <span className="text-sm text-fg-mute">{p.value ?? '—'}</span>
            </div>
          ))}
        </section>
      )}
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
 * A heading and a chart.
 *
 * `hint` left this signature in an earlier pass and a test keeps it out. `empty`
 * followed it: a series with nothing in it is not a panel at all now, because a
 * panel is a grid cell and reserving one to print a single character is the hole
 * beside a short tile. The caller lays those out as rows instead.
 *
 * Rendered statically. `whileInView` with `once: true` left everything below the
 * fold at `opacity: 0` in any capture, print or background tab.
 */
function Panel({
  title, wide, children,
}: { title: string; wide?: boolean; children: React.ReactNode }) {
  const still = useStill()
  return (
    <motion.section
      /* Spans both columns when the caller says the count is odd, so the last
         row cannot orphan a 470×130 hole beside itself. */
      className={`mt-8 ${wide ? 'sm:col-span-2' : ''}`}
      initial={still ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex items-baseline gap-2 mb-4">
        <h2 className="text-eyebrow uppercase text-fg-mute">{title}</h2>
      </div>
      {children}
    </motion.section>
  )
}

const SubLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="text-eyebrow uppercase text-fg-mute mb-2">{children}</div>
)
