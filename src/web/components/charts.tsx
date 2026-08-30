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

/** Chart marks are surfaces, so they use the surface amber, not the text one. */
const ACCENT = 'var(--color-accent)'

/* ------------------------------ bar chart -------------------------------- */

export function Bars({
  data, height = 132, color = ACCENT, format = (n: number) => String(n), label,
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
  const max = Math.max(1, ...data.map(d => d.value))
  const x = scaleBand<string>().domain(data.map(d => d.day)).range([0, w]).padding(0.34)
  const y = scaleLinear().domain([0, max]).range([height - padB, 2])
  const bw = Math.max(2, x.bandwidth())

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
                x={x(d.day)!} y={0} width={bw} height={height} fill="transparent"
                onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}
              />
              {/* Geometry is static and the growth is a CSS transform. Animating
                  the `height`/`y` attributes instead looks equivalent but is not:
                  motion drives those as geometry properties and the spring never
                  settles on the real value, which left every bar a few px tall.
                  transform-box:fill-box makes the origin the bar, not the canvas. */}
              <motion.rect
                x={x(d.day)} y={height - padB - h} width={bw} height={h}
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

      <div className="flex justify-between mt-1.5 text-[11px] text-fg-mute tnum">
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

export function Trend({
  data, height = 132, color = ACCENT, format = (n: number) => String(n),
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

  if (known.length < 2) {
    return <div className="h-[132px] grid place-items-center text-[12.5px] text-fg-mute">
      Not enough history yet
    </div>
  }

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
      <div className="flex justify-between mt-1.5 text-[11px] text-fg-mute tnum">
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
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[280px]" role="img">
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
                stroke={isHot ? 'var(--color-accent)' : 'var(--color-fg-mute)'}
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
              className="fill-[var(--color-fg)] text-[15px] font-medium tnum">
          {String(shown.hour).padStart(2, '0')}:00
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle"
              className="fill-[var(--color-fg-mute)] text-[10.5px]">
          {shown.value} done
        </text>
      </svg>
      <p className="text-[12px] text-fg-mute mt-1">
        {hover == null ? 'Your sharpest hour' : 'Hover to compare'}
      </p>
    </div>
  )
}

/* ------------------------------- stacked --------------------------------- */

export function StackedAging({
  rows, buckets, colorOf,
}: {
  rows: Array<{ source: string; buckets: Record<string, number> }>
  buckets: string[]
  colorOf: (s: string) => string
}) {
  const reduce = useStill()
  const totals = rows.map(r => buckets.reduce((n, b) => n + (r.buckets[b] ?? 0), 0))
  const max = Math.max(1, ...totals)

  return (
    <div className="space-y-3.5">
      {rows.map((r, i) => {
        const total = totals[i]!
        return (
          <div key={r.source}>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="inline-flex items-center gap-2 text-[13px] text-fg-dim capitalize">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: colorOf(r.source) }} />
                {r.source}
              </span>
              <span className="tnum text-[12.5px] text-fg-mute">{total}</span>
            </div>
            <div className="flex gap-[2px] h-2">
              {buckets.map((b, bi) => {
                const v = r.buckets[b] ?? 0
                if (!v) return null
                return (
                  <motion.div
                    key={b} title={`${v} · ${b}`}
                    className="rounded-[2px]"
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
    <div className="flex items-end gap-2.5 h-[104px]">
      {data.map(d => (
        <div key={d.weekday} className="flex-1 flex flex-col items-center gap-2 h-full justify-end">
          <motion.div
            className="w-full rounded-[3px]"
            style={{
              background: d.value === max ? ACCENT : 'var(--color-ink-700)',
              opacity: d.value === max ? 0.9 : 1,
            }}
            initial={reduce ? false : { height: 0 }}
            animate={{ height: `${Math.max(3, (d.value / max) * 82)}%` }}
            transition={{ delay: d.weekday * 0.04, type: 'spring', stiffness: 200, damping: 24 }}
          />
          <span className="text-[10.5px] text-fg-mute">{WD[d.weekday]!.slice(0, 1)}</span>
        </div>
      ))}
    </div>
  )
}
