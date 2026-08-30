/**
 * Charts drawn from d3-scale + d3-shape and animated with motion.
 *
 * Deliberately not a chart component library: their defaults (gridlines, boxed
 * legends, drop-shadowed tooltips) are exactly the admin-dashboard look the
 * brief ruled out, and overriding them costs more than drawing the mark.
 * See DECISIONS.md #6.
 *
 * Every mark in this file prints its numbers as text somewhere the reader can
 * see without a pointer. The set that came before it did not: a 24-hour dial
 * whose value only appeared on `onPointerEnter`, a stacked bar whose segments
 * were readable only through `title=`, and a line chart with a hover crosshair.
 * On a phone none of those events fire at all, so three of seven panels were
 * decoration. That is the rule the shapes here are chosen to satisfy — a legend
 * with counts beats a tooltip with counts, always.
 */
import { motion } from 'motion/react'
import { useStill } from '../lib/motion'
import { scaleBand, scaleLinear } from 'd3-scale'
import { arc, pie, type PieArcDatum } from 'd3-shape'
import { useState } from 'react'

/**
 * Chart marks are neutral.
 *
 * They used to default to the surface amber, so Pulse painted an amber hero, an
 * amber throughput bar, an amber clock hand and a full-width amber Ageing bar —
 * four marks, none of which meant "this one". Amber is spent on three things in
 * this product and a chart series is not one of them.
 */
const MARK = 'var(--color-fg-dim)'

/** How few days a sparse series is allowed to compact to, and how wide one bar
 *  may be drawn in the 720-unit canvas the chart is stretched from.
 *
 *  The floor was 7, which is a week, which is a number about calendars and not
 *  about this series. A two-day extent was padded back out to seven slots and
 *  printed `08-24 … 08-30` over two marks — the same long empty axis the
 *  compaction exists to remove, five sevenths of the way. `compacts to its own
 *  extent` is the rule; the floor is only here so a span of one or two still
 *  reads as a chart rather than as a slab, and four slots does that. */
const MIN_SLOTS = 4
const MAX_BAR = 26

const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0)

/* ------------------------------ bar chart -------------------------------- */

export function Bars({
  data, secondary, height = 132, color = MARK, format = (n: number) => String(n), label, title,
}: {
  data: Array<{ day: string; value: number }>
  /** Drawn behind, unfilled. What lets Arrived and Cleared be one chart. */
  secondary?: Array<{ day: string; value: number }>
  height?: number; color?: string
  format?: (n: number) => string
  label?: (d: { day: string; value: number }) => string
  /** The accessible name. Without one, `role="img"` is an unlabelled graphic. */
  title?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  // With motion disabled, an animated-in mark must already be at its end state.
  // `initial={false}` does exactly that; without it a reduced-motion reader gets
  // bars of zero height, which is worse than no animation.
  const reduce = useStill()
  const w = 720, padB = 18
  const behind = new Map((secondary ?? []).map(d => [d.day, d.value]))
  const rawMax = Math.max(0, ...data.map(d => d.value), ...(secondary ?? []).map(d => d.value))

  // Nothing to draw is not a hole to fill with a sentence. The panel's title row
  // carries an em dash and the chart is not drawn at all. A 572×132 box
  // centring three words about the absence was the largest mark on the page.
  if (rawMax === 0) return null

  /**
   * A sparse series compacts to its own extent, and says what that extent is.
   *
   * Measured: `Throughput` drew thirty day-slots across 572px and painted one
   * 11px bar at slot thirty — 98% of the axis empty — and two more panels did
   * the same. That is a formatting decision, not a data problem: the chart
   * shows the days it has, and the axis labels say which days those are.
   */
  const first = data.findIndex(d => d.value > 0)
  const last = data.length - 1 - [...data].reverse().findIndex(d => d.value > 0)
  const span = last - first + 1
  if (span < 4 || span < data.length / 4) {
    // Enough slots either side that it still reads as a chart rather than as a
    // slab, centred on the days that actually have something in them.
    const need = Math.min(data.length, Math.max(MIN_SLOTS, span + 2))
    const hi = Math.min(data.length, Math.max(last + 1 + Math.ceil((need - span) / 2), need))
    data = data.slice(Math.max(0, hi - need), hi)
  }

  const max = Math.max(1, rawMax)
  const x = scaleBand<string>().domain(data.map(d => d.day)).range([0, w]).padding(0.34)
  const y = scaleLinear().domain([0, max]).range([height - padB, 2])
  // Capped, because the viewBox is stretched to the container: three slots in a
  // 720-unit canvas makes a 200-unit bar, which is a rectangle, not a mark.
  const bw = Math.min(Math.max(2, x.bandwidth()), MAX_BAR)
  const bx = (d: string) => x(d)! + (x.bandwidth() - bw) / 2

  const active = hover != null ? data[hover] : null
  const total = data.reduce((n, d) => n + d.value, 0)

  return (
    <div className="relative">
      {/*
        `height` is set, not inferred.

        With only `w-full` and a 720×132 viewBox the browser derived the height
        from the intrinsic ratio, so in a 358px phone column a chart that
        declares 132 units rendered 66px tall — every geometric constant in this
        component was wrong by half at the size it is most often read.
        `preserveAspectRatio="none"` stays with it: the y axis is now exact
        (132 units in a 132px box), and the x axis is a band scale, which is
        meant to stretch to whatever width it is given.
      */}
      <svg viewBox={`0 0 ${w} ${height}`} height={height} className="w-full block overflow-visible"
           preserveAspectRatio="none" role="img"
           aria-label={title ?? `${total} across ${data.length} days`}>
        {data.map((d, i) => {
          const h = Math.max(d.value > 0 ? 2 : 0, height - padB - y(d.value))
          const bg = behind.get(d.day) ?? 0
          const bh = Math.max(bg > 0 ? 2 : 0, height - padB - y(bg))
          return (
            <g key={d.day}>
              {/* A full-height transparent target: hitting a 2px bar with a
                  thumb is impossible, so the hit area is the whole column. */}
              <rect
                x={x(d.day)!} y={0} width={x.bandwidth()} height={height} fill="transparent"
                onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}
              />
              {secondary && bh > 0 && (
                <rect
                  x={bx(d.day)} y={height - padB - bh} width={bw} height={bh}
                  rx={Math.min(3, bw / 2)} fill="var(--color-ink-700)"
                />
              )}
              {/* Geometry is static and the growth is a CSS transform. Animating
                  the `height`/`y` attributes instead looks equivalent but is not:
                  motion drives those as geometry properties and the spring never
                  settles on the real value, which left every bar a few px tall.
                  transform-box:fill-box makes the origin the bar, not the canvas. */}
              <motion.rect
                x={bx(d.day)} y={height - padB - h} width={bw} height={h}
                rx={Math.min(3, bw / 2)} fill={color}
                initial={reduce ? false : { scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={{ delay: i * 0.012, type: 'spring', stiffness: 240, damping: 26 }}
                style={{
                  transformBox: 'fill-box',
                  transformOrigin: 'bottom',
                  opacity: hover == null ? (d.value ? 0.85 : 0.16) : hover === i ? 1 : 0.28,
                  transition: 'opacity .15s',
                }}
              />
            </g>
          )
        })}
      </svg>

      <div className="flex justify-between mt-2 text-sm text-fg-mute tnum">
        <span>{data[0]?.day.slice(5)}</span>
        <span className={active ? 'text-fg' : ''}>
          {active ? (label?.(active) ?? `${active.day.slice(5)} · ${format(active.value)}`) : ''}
        </span>
        <span>{data.at(-1)?.day.slice(5)}</span>
      </div>
    </div>
  )
}

/* --------------------------------- donut --------------------------------- */

export type DonutSlice = { id: string; label: string; value: number; color: string }

/**
 * The shape a share-of-a-whole actually has.
 *
 * A donut answers "how much of this is Claude?" in one glance, which is the
 * question the page opens with, and it answers it without an axis — so there is
 * no long empty ruler when four of five sources are quiet. The counts and
 * percentages live in `Legend` beside it, as text.
 */
export function Donut({
  slices, total, centreTop, centreFoot, size = 240,
}: {
  slices: DonutSlice[]
  /**
   * What the centre says. Not always the sum — the desk ring's centre is
   * `openNow`, and the day-part ring's is the peak hour, a clock reading.
   */
  total: number | string
  centreTop: string
  centreFoot: string
  size?: number
}) {
  const reduce = useStill()
  const sum = slices.reduce((n, s) => n + s.value, 0)
  if (!sum) return null

  // `sort(null)` is mandatory: without it d3 re-sorts by value on every render,
  // so two sources that trade places between polls swap sides of the ring and
  // the picture appears to have changed when only a count did. The caller owns
  // the order, and it owns it for reasons this component cannot see — Claude
  // first at twelve o'clock because it is hueless and dominant, gmail and sentry
  // never adjacent because they are fifteen degrees apart in hue.
  const arcs = pie<DonutSlice>().value(s => s.value).sort(null).padAngle(0.02)(slices)
  const shape = arc<PieArcDatum<DonutSlice>>()
    .innerRadius(size * 0.30)
    .outerRadius(size * 0.47)
    .cornerRadius(2)

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`} width={size} height={size}
      className="block max-w-full h-auto" role="img"
      aria-label={slices.map(s => `${s.label} ${s.value}, ${pct(s.value, sum)}%`).join('; ')}
    >
      <g transform={`translate(${size / 2} ${size / 2})`}>
        {arcs.map((d, i) => (
          <motion.path
            key={d.data.id}
            d={shape(d) ?? undefined}
            fill={d.data.color}
            /* Gated, like every other entrance in this codebase. An ungated
               `initial` leaves the whole ring at opacity 0 in a screenshot, a
               print, a background tab and `?static=1` — a donut that is only
               there for readers who watched it arrive. */
            initial={reduce ? false : { opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.05 + i * 0.05, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            style={{ transformOrigin: 'center' }}
          />
        ))}
      </g>
      <text x={size / 2} y={size / 2 - 2} textAnchor="middle"
            className="fill-[var(--color-fg)] text-xl font-medium tnum">
        {total}
      </text>
      <text x={size / 2} y={size / 2 + 16} textAnchor="middle"
            className="fill-[var(--color-fg-mute)] text-sm">
        {centreTop}
      </text>
      <text x={size / 2} y={size / 2 + 32} textAnchor="middle"
            className="fill-[var(--color-fg-mute)] text-sm">
        {centreFoot}
      </text>
    </svg>
  )
}

/**
 * The donut's numbers, as text.
 *
 * This is the load-bearing half. It replaces `title=` and `onPointerEnter`
 * readouts, neither of which fires on a touch screen, and it is what a reader on
 * a phone actually reads — the ring beside it is the summary, not the data.
 */
export function Legend({ items }: { items: DonutSlice[] }) {
  const sum = items.reduce((n, s) => n + s.value, 0)
  return (
    <ul className="min-w-0">
      {items.map(s => (
        <li key={s.id} className="flex items-center gap-2 h-8 min-w-0">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} aria-hidden />
          <span className="text-sm text-fg-dim truncate grow">{s.label}</span>
          <span className="tnum text-sm text-fg-mute shrink-0">
            {s.value} · {pct(s.value, sum)}%
          </span>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------- part bar -------------------------------- */

/**
 * One 100%-stacked bar, and its numbers underneath.
 *
 * Widths are a share of the sum with no gaps between them, which is the whole
 * difference from the five-colour thing this replaces: that one drew
 * `value / max` inside a gapped flex row, so the widest row systematically
 * under-read its own total and no two rows were comparable.
 */
export function PartBar({
  segments,
}: {
  segments: Array<{ id: string; label: string; value: number; color: string }>
}) {
  const reduce = useStill()
  const sum = segments.reduce((n, s) => n + s.value, 0)
  if (!sum) return null
  const shown = segments.filter(s => s.value > 0)

  return (
    <div>
      <div className="flex h-3 rounded-chip overflow-hidden"
           role="img"
           aria-label={shown.map(s => `${s.label} ${s.value}`).join('; ')}>
        {shown.map((s, i) => (
          <motion.div
            key={s.id}
            style={{ background: s.color }}
            initial={reduce ? false : { width: 0 }}
            animate={{ width: `${(s.value / sum) * 100}%` }}
            transition={{ delay: 0.08 + i * 0.05, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
        {shown.map(s => (
          <li key={s.id} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} aria-hidden />
            <span className="text-sm text-fg-dim">{s.label}</span>
            <span className="tnum text-sm text-fg-mute">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* --------------------------------- ring ---------------------------------- */

/** A single-series donut, small enough to sit in a row of them. */
export function Ring({
  value, total, color = MARK, label, size = 56,
}: {
  value: number; total: number; color?: string; label: string; size?: number
}) {
  const reduce = useStill()
  const done = pct(value, total)
  const r = size / 2 - 5
  const c = 2 * Math.PI * r

  return (
    <div className="flex items-center gap-3 min-w-0">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="block shrink-0"
           role="img" aria-label={`${label}: ${value} of ${total}, ${done}%`}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none"
                  stroke="var(--color-ink-800)" strokeWidth={5} />
          <motion.circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={color} strokeWidth={5} strokeLinecap="round"
            strokeDasharray={c}
            initial={reduce ? false : { strokeDashoffset: c }}
            animate={{ strokeDashoffset: c - (c * done) / 100 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          />
        </g>
        <text x={size / 2} y={size / 2 + 4} textAnchor="middle"
              className="fill-[var(--color-fg-dim)] text-sm tnum">
          {done}
        </text>
      </svg>
      <div className="min-w-0">
        <div className="text-sm text-fg-dim truncate">{label}</div>
        <div className="tnum text-sm text-fg-mute">{value}/{total}</div>
      </div>
    </div>
  )
}

/* -------------------------------- weekday -------------------------------- */

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function WeekdayBars({ data }: { data: Array<{ weekday: number; value: number }> }) {
  const reduce = useStill()
  const max = Math.max(1, ...data.map(d => d.value))

  /**
   * Three rows on one seven-column grid: the values, the bars, the names.
   *
   * The values used to sit inside each column above its own bar, which put them
   * at seven different heights — a ragged line of numbers that reads as noise
   * rather than as a row you can compare across. On a shared grid they share a
   * baseline, and every column's three parts stay in the same column.
   *
   * Three letters, not one. `T` and `T`, `S` and `S` are the same character, so
   * half the axis was unreadable at the width this chart is usually given.
   */
  return (
    <div role="img" aria-label={data.map(d => `${WD[d.weekday]} ${d.value}`).join('; ')}>
      <div className="grid grid-cols-7 gap-2">
        {data.map(d => (
          <span key={d.weekday} className="tnum text-sm text-fg-mute text-center">{d.value || ''}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-2 items-end h-24 mt-1">
        {data.map(d => (
          <motion.span
            key={d.weekday}
            className="w-full rounded-chip block"
            style={{
              background: d.value === max ? 'var(--color-fg-dim)' : 'var(--color-ink-700)',
              opacity: d.value === max ? 0.9 : 1,
            }}
            initial={reduce ? false : { height: 0 }}
            animate={{ height: `${Math.max(3, (d.value / max) * 100)}%` }}
            transition={{ delay: d.weekday * 0.04, type: 'spring', stiffness: 200, damping: 24 }}
          />
        ))}
      </div>
      <div className="grid grid-cols-7 gap-2 mt-2">
        {data.map(d => (
          <span key={d.weekday} className="text-sm text-fg-mute text-center truncate">{WD[d.weekday]}</span>
        ))}
      </div>
    </div>
  )
}
