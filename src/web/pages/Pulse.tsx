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
import {
  Bars, Donut, Legend, PartBar, Ring, WeekdayBars, type DonutSlice,
} from '../components/charts'
import { SOURCE_COLOR, SOURCE_LABEL } from '../components/sources'
import { Empty, PageTitle, Segmented } from '../components/primitives'
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
const DAY_PARTS: Array<{ id: string; label: string; from: number; to: number }> = [
  { id: 'night', label: 'Night', from: 0, to: 5 },
  { id: 'morning', label: 'Morning', from: 6, to: 11 },
  { id: 'afternoon', label: 'Afternoon', from: 12, to: 17 },
  { id: 'evening', label: 'Evening', from: 18, to: 23 },
]

// One hue, four steps — a ramp, not a palette. Parts of a day are ordered, and
// an ordered variable takes a sequential ramp; four unrelated hues would say
// they are four unrelated things, and re-using the five source hues here would
// teach the reader that violet means Slack on one ring and evening on the next.
//
// The hue is the accent rather than a neutral. A grey ramp is the correct shape
// drawn in the one colour that cannot hold four legible steps on this ground:
// `fg-dim` into `ink-700` puts Morning and Evening close enough that the ring
// has to be read against its own legend, which is the complaint this page
// exists to answer. Amber is already the product's second colour and is spent
// nowhere on the first donut, so it separates the two rings rather than
// colliding with them.
const partColor = (weight: number) =>
  `color-mix(in oklab, var(--color-accent) ${weight}%, var(--color-ink-700))`

/**
 * Where the i-th of n drawn parts sits on that ramp.
 *
 * Derived from the parts that are actually drawn rather than fixed per part,
 * which is the difference between using the ramp and wasting it: with one
 * quiet part the remaining three used to land on 25/50/100 and put two of them
 * a twentieth of a lightness step apart, because the missing one had taken a
 * rung with it. Spread over what is present, the three sit 25/62/100 and the
 * scale gives up as much separation as it has.
 */
const partWeight = (i: number, n: number) => (n < 2 ? 100 : 25 + (75 * i) / (n - 1))

/**
 * A single day, in the words the rest of the product uses for one.
 *
 * `08-30` was `day.slice(5)` reaching the screen: the wire format, which is
 * `YYYY-MM-DD` because that is what sorts, printed at a reader who has never
 * been told the year is missing rather than the day. Everywhere else Wake says
 * a day the way `wallClock` does — Today and Yesterday replace the date on the
 * two days he already knows which day it is, and every other day is
 * `Sat 30 Aug`. This is that rule, minus the clock, because a day has no time
 * of day in it.
 *
 * Lowercase, unlike `wallClock`'s, because these follow a number: `4 yesterday`
 * rather than `4 Yesterday`. And parsed at noon local, like `dayLabel` already
 * does — `new Date('2026-08-30')` is midnight *UTC*, which is the day before in
 * every timezone west of Greenwich.
 */
function dayWords(iso: string, now = Date.now()): string {
  const d = new Date(`${iso}T12:00:00`)
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((midnight(d) - midnight(new Date(now))) / 864e5)
  if (days === 0) return 'today'
  if (days === -1) return 'yesterday'
  return `on ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`
}

/**
 * The weekday names in full, Sunday first.
 *
 * Sunday first because that is how the *data* is indexed — the server writes
 * `getUTCDay()` into `weekday` — and this is a lookup, not a layout. Where the
 * week is drawn rather than indexed it starts on Monday; see `MONDAY_FIRST`.
 *
 * Built from a known Sunday (2023-01-01) rather than a hard-coded list, so the
 * name follows the reader's locale the way every other date in this product
 * does. The plural `s` the caller appends is English, like every other word
 * Wake says.
 */
const WEEKDAY_LONG = Array.from({ length: 7 }, (_, i) =>
  new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'long' }))

/**
 * The order the week is *drawn* in.
 *
 * `By weekday` read `Sun Mon Tue Wed Thu Fri Sat` while the calendar behind
 * every date field in the product — the new-task deadline, the remind-me grid —
 * reads `MON … SUN`, so one product had two week-shapes in it and the busiest
 * column moved depending on which screen you were on. The calendar's is the one
 * that stays: it is the one he picks dates in, and a working week that ends at
 * the weekend is the shape the rest of the data already has.
 *
 * A permutation of indices rather than a re-labelling, so the bars, their
 * counts and their names all move together — `WeekdayBars` keys every one of
 * those off the row's own `weekday`, and the row is what is being reordered.
 */
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0]

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
   * what it has rather than an em dash it would be lying with — and it says the
   * day in words, because this row is prose and `08-30` is a wire format.
   */
  const shape = (series: Array<{ day: string; value: number }>) => {
    const marked = series.filter(d => d.value > 0)
    return {
      thin: marked.length < 2,
      value: marked.length === 1 ? `${marked[0]!.value} ${dayWords(marked[0]!.day)}` : undefined,
    }
  }
  const done = shape(a.throughput.done)
  const clearedShape = shape(a.throughput.cleared)

  /**
   * The two Flow totals, over the window rather than over the drawn extent.
   *
   * `Bars` compacts a sparse series to the days that actually have something in
   * them, and it does that from the primary series — so every day that cleared
   * anything is always drawn, and the `Cleared` total always equals the bars
   * beside it. `Arrived` is looked up per day, so a burst of arrivals in a week
   * where nothing was cleared can fall outside the compacted slice. The number
   * stays the window's, because the window is what the range control at the top
   * of the page selects and what every other figure here is measured over; the
   * narrower thing is the picture, not the fact.
   */
  const flow = {
    cleared: a.throughput.cleared.reduce((n, d) => n + d.value, 0),
    arrived: a.throughput.appeared.reduce((n, d) => n + d.value, 0),
  }

  /**
   * The same rule, over the week rather than over the window.
   *
   * `By weekday` was the one mark on this page exempt from it, and it showed:
   * with a single active day it drew one tall bar over six 4px stubs — the
   * shape the throughput charts were collapsed for, six sevenths of the way.
   * Seven empty slots do not put Sunday's number next to anything, so it says
   * the number instead, the way every other thin series here already does.
   *
   * `on Sundays`, plural, and that is the whole difference from the date rows
   * above it: they name one day that happened, this names every Sunday in the
   * window at once. `22 on Sun` read as a date — a date with no number on it —
   * which is the same mistake `08-30` makes from the other end.
   */
  const weekday = (() => {
    const marked = a.rhythm.byWeekday.filter(d => d.value > 0)
    return {
      thin: marked.length < 2,
      value: marked.length === 1
        ? `${marked[0]!.value} on ${WEEKDAY_LONG[marked[0]!.weekday]}s`
        : undefined,
    }
  })()

  // The same seven rows, in the order the calendar draws them.
  const week = MONDAY_FIRST
    .map(i => a.rhythm.byWeekday.find(d => d.weekday === i))
    .filter((d): d is { weekday: number; value: number } => !!d)

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
  // Quiet parts are dropped before the ramp is laid over them, so a part with
  // nothing in it neither takes a rung of the scale nor keeps a legend row
  // reading `Afternoon 0 · 0%` beside a swatch pointing at no arc.
  const worked = DAY_PARTS
    .map(p => ({
      ...p,
      value: a.rhythm.byHour
        .filter(h => h.hour >= p.from && h.hour <= p.to)
        .reduce((n, h) => n + h.value, 0),
    }))
    .filter(p => p.value > 0)
  const parts: DonutSlice[] = worked.map((p, i) => ({
    id: p.id,
    label: p.label,
    value: p.value,
    color: partColor(partWeight(i, worked.length)),
  }))
  const peak = a.rhythm.byHour.reduce((best, h) => (h.value > best.value ? h : best), a.rhythm.byHour[0]!)

  const panels: Array<{ title: string; empty: boolean; value?: string; node: React.ReactNode }> = [
    {
      /**
       * The title carries the measure, because three surfaces print a number
       * per source and none of them was counting the same thing.
       *
       * Measured on one morning: Pulse `37 · 4 · 29 · 12 · 17`, Settings
       * `56 · 4 · 30 · 17 · 21`, the desk's own tabs `14 · 5 · 29 · 35 · 18`.
       * Three measures — rows fetched, rows on the desk by the pipe that
       * carried them, rows on the desk by what they *are* — and with nothing
       * naming any of them they read as one measure disagreeing three ways.
       *
       * This one is the middle: `analytics.aging` groups the open desk by
       * `cards.source`, which is the pipe. That is why Slack is large here and
       * small on the tab strip — a Sentry issue announced in `#sentry-alerts`
       * arrived through Slack and *is* a Sentry row, and `inBucket` sorts the
       * tabs the second way. Both numbers are true; only one of them was said
       * out loud.
       */
      title: 'On the desk, by where it arrived',
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
      //
      // And the two series are named underneath. This is the only panel here
      // that draws more than one thing, and the only place either word appeared
      // was an SVG `title` attribute — which is the rule this whole page was
      // rewritten to keep: a legend with counts beats a tooltip with counts,
      // because a phone fires no pointer events at all.
      node: (
        <div>
          <Bars
            data={a.throughput.cleared}
            secondary={a.throughput.appeared}
            title="cards cleared each day, against the cards that arrived"
            label={d => `${d.day.slice(5)} · ${d.value} cleared`}
          />
          <SeriesKey
            items={[
              { label: 'Cleared', value: flow.cleared, color: 'var(--color-fg-dim)' },
              { label: 'Arrived', value: flow.arrived, color: 'var(--color-ink-700)' },
            ]}
          />
        </div>
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
            {/* The centre counts this ring, like the desk ring's does: the
                total finished in the window, which is what the four arcs are
                shares of. The peak hour is the secondary fact and reads as one
                — as the headline it was a clock over a count from a single
                hour, so a ring summing to four announced two. */}
            <Donut
              slices={parts}
              size={160}
              centreTop="finished"
              centreFoot={`peak ${String(peak.hour).padStart(2, '0')}:00`}
            />
            <div className="w-full grow min-w-0"><Legend items={parts} /></div>
          </div>
          <div>
            <SubLabel>By weekday</SubLabel>
            {weekday.thin
              ? <Empty>{weekday.value ?? '—'}</Empty>
              : <WeekdayBars data={week} />}
          </div>
        </div>
      ),
    },
    {
      title: 'Goals',
      empty: !a.goals.length,
      /* An em dash is the right mark for a series that *could* have had
         something in it this window and did not. A goal is not a measurement —
         it exists because he made one — so the absence of any is a state, and a
         state has a name. `GOALS —` read as a panel that had failed to load. */
      value: 'none set',
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
      <PageTitle>Pulse</PageTitle>
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

/**
 * Which mark is which, for a chart of counted series.
 *
 * Deliberately not `Legend`, and the difference is arithmetic rather than
 * taste: that one divides each row by the sum of the rows and prints a
 * percentage, which is the right thing for a donut — where the slices really
 * are parts of one whole — and a fabricated statistic here. Cleared and
 * arrived are two independent counts of two different events; `120 · 55%` of
 * their sum answers no question anyone has.
 *
 * The grammar is `PartBar`'s legend — the swatch, the word, the count in
 * `tnum`, one flex-wrapped row — so the two keys on this page look like one
 * thing. The swatch is a bar rather than that one's dot because the mark it
 * names is a bar.
 *
 * The fills are exactly what `charts.tsx` paints — `fg-dim` for the primary
 * series, `ink-700` for the secondary — because a swatch brightened until it
 * was easy to see would be a key pointing at a mark that is not on the chart.
 * What the recessive one gets instead is the product's own structural hairline:
 * measured at 8×16 on the light ground, `ink-700` is 1.15:1, which is legible
 * as a 114px bar in the chart above and is nothing at all at swatch size. Both
 * swatches take the edge, not just the faint one — outlining one of a pair says
 * the two marks differ in a way that they do not.
 */
function SeriesKey({
  items,
}: { items: Array<{ label: string; value: number; color: string }> }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
      {items.map(s => (
        <li key={s.label} className="flex items-center gap-2">
          <span className="w-2 h-4 rounded-chip border border-edge shrink-0"
            style={{ background: s.color }} aria-hidden />
          <span className="text-sm text-fg-dim">{s.label}</span>
          <span className="tnum text-sm text-fg-mute">{s.value}</span>
        </li>
      ))}
    </ul>
  )
}
