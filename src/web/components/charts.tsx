/**
 * Charts drawn from d3-scale + d3-shape and animated with motion.
 *
 * Deliberately not a chart component library: their defaults (gridlines, boxed
 * legends, drop-shadowed tooltips) are exactly the admin-dashboard look the
 * brief ruled out, and overriding them costs more than drawing the mark.
 * See DECISIONS.md #6.
 */
import { motion } from 'motion/react'
import { useStill } from '../lib/motion'
import { scaleBand, scaleLinear, scaleSqrt } from 'd3-scale'
import { area, curveMonotoneX, line } from 'd3-shape'
import { useId, useState } from 'react'

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

/* ------------------------------ bar chart -------------------------------- */

export function Bars({
  data, height = 132, color = MARK, format = (n: number) => String(n), label,
}: {
  data: Array<{ day: string; value: number }>
  height?: number; color?: string
  format?: (n: number) => string
  label?: (d: { day: string; value: number }) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  // With motion disabled, an animated-in mark must already be at its end state.
  // `initial={false}` does exactly that; without it a reduced-motion reader gets
  // bars of zero height, which is worse than no animation.
  const reduce = useStill()
  const w = 720, padB = 18
  const rawMax = Math.max(0, ...data.map(d => d.value))

  // Nothing to draw is not a hole to fill with a sentence. The panel's title row
  // carries an em dash and the chart is not drawn at all. A 572×132 box
  // centring three words about the absence was the largest mark on the page.
  if (rawMax === 0) return null

  /**
   * A sparse series compacts to its own extent, and says what that extent is.
   *
   * Measured: `Throughput` drew thirty day-slots across 572px and painted one
   * 11px bar at slot thirty — 98% of the axis empty — and `The pile` did it
   * twice more. That is a formatting decision, not a data problem: the chart
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

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${height}`} className="w-full block overflow-visible"
           preserveAspectRatio="none" role="img">
        {data.map((d, i) => {
          const h = Math.max(d.value > 0 ? 2 : 0, height - padB - y(d.value))
          return (
            <g key={d.day}>
              {/* A full-height transparent target: hitting a 2px bar with a
                  thumb is impossible, so the hit area is the whole column. */}
              <rect
                x={x(d.day)!} y={0} width={x.bandwidth()} height={height} fill="transparent"
                onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}
              />
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

/* ----------------------------- area + line ------------------------------- */

/** How many days with a value a line needs before it is a line. */
export const TREND_MIN_POINTS = 2

export function Trend({
  data, height = 132, color = MARK, format = (n: number) => String(n),
}: {
  data: Array<{ day: string; value: number | null }>
  height?: number; color?: string; format?: (n: number) => string
}) {
  const gid = useId()
  const [hover, setHover] = useState<number | null>(null)
  const reduce = useStill()
  const w = 720, padB = 18
  const points = data.map((d, i) => ({ i, v: d.value, day: d.day }))
  const known = points.filter(p => p.v != null) as Array<{ i: number; v: number; day: string }>

  // A line needs two points, and the caller is told the same threshold through
  // `TREND_MIN_POINTS`, so the tile above cannot state a median the chart below
  // refuses to draw. Not enough is not a 572×132 box saying so: the panel puts
  // an em dash on its title row and draws nothing.
  if (known.length < TREND_MIN_POINTS) return null

  const max = Math.max(...known.map(p => p.v))
  const x = scaleLinear().domain([0, data.length - 1]).range([0, w])
  const y = scaleLinear().domain([0, max || 1]).range([height - padB, 4])

  const mkLine = line<{ i: number; v: number }>().x(p => x(p.i)).y(p => y(p.v)).curve(curveMonotoneX)
  const mkArea = area<{ i: number; v: number }>()
    .x(p => x(p.i)).y0(height - padB).y1(p => y(p.v)).curve(curveMonotoneX)

  const active = hover != null ? known.find(p => p.i === hover) : null

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${height}`} className="w-full block overflow-visible" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.26} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        <motion.path
          d={mkArea(known)!} fill={`url(#${gid})`}
          initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.25 }}
        />
        {/* Draw the line on rather than fading it in — the stroke reads as the
            data arriving, which is the one bit of showmanship here. */}
        <motion.path
          d={mkLine(known)!} fill="none" stroke={color} strokeWidth={1.75}
          strokeLinecap="round" vectorEffect="non-scaling-stroke"
          initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />

        {active && (
          <>
            <line x1={x(active.i)} x2={x(active.i)} y1={0} y2={height - padB}
                  stroke="var(--color-ink-600)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={x(active.i)} cy={y(active.v)} r={3.5} fill={color} />
          </>
        )}

        {points.map(p => (
          <rect key={p.i} x={x(p.i) - w / data.length / 2} y={0}
                width={w / data.length} height={height} fill="transparent"
                onPointerEnter={() => setHover(p.i)} onPointerLeave={() => setHover(null)} />
        ))}
      </svg>
      <div className="flex justify-between mt-2 text-sm text-fg-mute tnum">
        <span>{data[0]?.day.slice(5)}</span>
        <span className={active ? 'text-fg' : ''}>
          {active ? `${active.day.slice(5)} · ${format(active.v)}` : ''}
        </span>
        <span>{data.at(-1)?.day.slice(5)}</span>
      </div>
    </div>
  )
}

/* --------------------------- radial day clock ---------------------------- */

/**
 * When I actually work, drawn as a 24-hour dial. A bar chart of hours is
 * readable but forgettable; a clock is instantly legible because everyone
 * already knows how to read one, and it makes a late-night habit obvious.
 */
export function DayClock({ data, size = 260 }: { data: Array<{ hour: number; value: number }>; size?: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const reduce = useStill()
  const cx = size / 2, cy = size / 2
  const stroke = size * 0.026
  const rIn = size * 0.19, rOut = size * 0.45
  const max = Math.max(1, ...data.map(d => d.value))
  // A square-root scale, not linear: one dominant hour would otherwise squash
  // every other spoke to a stub against the inner ring, hiding the shape of the
  // day. Sqrt keeps the peak obvious while leaving the quiet hours readable.
  // The half-stroke inset stops round caps from spilling past the outer ring.
  const r = scaleSqrt().domain([0, max]).range([rIn, rOut - stroke / 2])

  const peak = data.reduce((a, b) => (b.value > a.value ? b : a), data[0]!)
  const shown = hover != null ? data[hover]! : peak

  return (
    <div className="flex flex-col">
      <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-56" role="img">
        {/* midnight / noon guides, the only chrome on this chart */}
        <circle cx={cx} cy={cy} r={rOut} fill="none" stroke="var(--color-ink-800)" strokeWidth={1} />
        <circle cx={cx} cy={cy} r={rIn} fill="none" stroke="var(--color-ink-800)" strokeWidth={1} />

        {data.map(d => {
          // 0h at the top, clockwise, so it reads like a real clock face.
          const a0 = (d.hour / 24) * Math.PI * 2 - Math.PI / 2
          const a1 = ((d.hour + 0.82) / 24) * Math.PI * 2 - Math.PI / 2
          const mid = (a0 + a1) / 2
          const len = r(d.value)
          const isHot = d.hour === shown.hour
          return (
            <g key={d.hour}
               onPointerEnter={() => setHover(d.hour)} onPointerLeave={() => setHover(null)}>
              {/* Static endpoints, animated by drawing the stroke on — same
                  reasoning as the bars above. */}
              <motion.line
                x1={cx + Math.cos(mid) * rIn} y1={cy + Math.sin(mid) * rIn}
                x2={cx + Math.cos(mid) * len} y2={cy + Math.sin(mid) * len}
                initial={reduce ? false : { pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ delay: 0.1 + d.hour * 0.018, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                stroke={isHot ? 'var(--color-fg)' : 'var(--color-fg-mute)'}
                strokeOpacity={isHot ? 1 : d.value ? 0.55 : 0.16}
                strokeWidth={stroke} strokeLinecap="round"
              />
              <line
                x1={cx + Math.cos(mid) * rIn} y1={cy + Math.sin(mid) * rIn}
                x2={cx + Math.cos(mid) * rOut} y2={cy + Math.sin(mid) * rOut}
                stroke="transparent" strokeWidth={size * 0.05}
              />
            </g>
          )
        })}

        <text x={cx} y={cy - 4} textAnchor="middle"
              className="fill-[var(--color-fg)] text-md font-medium tnum">
          {String(shown.hour).padStart(2, '0')}:00
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle"
              className="fill-[var(--color-fg-mute)] text-sm">
          {shown.value} done
        </text>
      </svg>

    </div>
  )
}

/* ------------------------------- stacked --------------------------------- */

export function StackedAging({
  rows, buckets, colorOf, labelOf = s => s,
}: {
  rows: Array<{ source: string; buckets: Record<string, number> }>
  buckets: string[]
  colorOf: (s: string) => string
  /** The name the rest of the product uses. `capitalize` gave `Claude`, `Github`. */
  labelOf?: (s: string) => string
}) {
  const reduce = useStill()
  const totals = rows.map(r => buckets.reduce((n, b) => n + (r.buckets[b] ?? 0), 0))
  const max = Math.max(1, ...totals)

  return (
    <div className="space-y-4">
      {rows.map((r, i) => {
        const total = totals[i]!
        return (
          <div key={r.source}>
            <div className="flex items-baseline justify-between mb-2">
              <span className="inline-flex items-center gap-2 text-sm text-fg-dim">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: colorOf(r.source) }} />
                {labelOf(r.source)}
              </span>
              <span className="tnum text-sm text-fg-mute">{total}</span>
            </div>
            <div className="flex gap-[2px] h-2">
              {buckets.map((b, bi) => {
                const v = r.buckets[b] ?? 0
                if (!v) return null
                return (
                  <motion.div
                    key={b} title={`${v} · ${b}`}
                    className="rounded-chip"
                    style={{
                      background: colorOf(r.source),
                      // Older items are drawn stronger, so a pile that is going
                      // stale looks worse than one that is merely large.
                      opacity: 0.28 + (bi / Math.max(1, buckets.length - 1)) * 0.72,
                    }}
                    initial={reduce ? false : { width: 0 }}
                    animate={{ width: `${(v / max) * 100}%` }}
                    transition={{ delay: 0.1 + i * 0.05, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                  />
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* -------------------------------- weekday -------------------------------- */

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function WeekdayBars({ data }: { data: Array<{ weekday: number; value: number }> }) {
  const reduce = useStill()
  const max = Math.max(1, ...data.map(d => d.value))
  return (
    <div className="flex items-end gap-2 h-26">
      {data.map(d => (
        <div key={d.weekday} className="flex-1 flex flex-col items-center gap-2 h-full justify-end">
          <motion.div
            className="w-full rounded-chip"
            style={{
              background: d.value === max ? 'var(--color-fg-dim)' : 'var(--color-ink-700)',
              opacity: d.value === max ? 0.9 : 1,
            }}
            initial={reduce ? false : { height: 0 }}
            animate={{ height: `${Math.max(3, (d.value / max) * 82)}%` }}
            transition={{ delay: d.weekday * 0.04, type: 'spring', stiffness: 200, damping: 24 }}
          />
          <span className="text-sm text-fg-mute">{WD[d.weekday]!.slice(0, 1)}</span>
        </div>
      ))}
    </div>
  )
}
