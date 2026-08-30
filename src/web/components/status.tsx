/**
 * Where work stands, and how much it matters, as marks rather than colours.
 *
 * Five statuses and four priorities is nine states on a row that already has a
 * source hue and a kind glyph on it. Painting each of them would put nine
 * competing colours on a screen budgeted for three, so the *ring* carries the
 * state — open circle, filled dot, dashed, tick, slash — and colour is spent
 * only where it says something a shape cannot.
 *
 * The one deliberate omission: `in_progress` is NOT amber. It is the commonest
 * state on the desk, and a colour every second row wears is not a signal. It
 * takes the brightest neutral instead, so it reads as "live" without competing
 * with the three real accents (the pinned row, the phone badge, the one primary
 * button). Amber stays scarce on purpose.
 *
 * Normal priority renders nothing at all. A mark the eye has to identify and
 * then dismiss on every single row is not information, it is work.
 */

import {
  Circle, CircleCheck, CircleDot, CircleDotDashed, CircleSlash,
  Flame, SignalHigh, SignalLow, type LucideIcon,
} from 'lucide-react'
import type { CardPriority, CardStatus } from '../lib/types'
import { STATUS_LABEL } from '../lib/types'

type Mark = { Icon: LucideIcon; color: string }

const STATUS_MARK: Record<CardStatus, Mark> = {
  not_started: { Icon: Circle,           color: 'var(--color-fg-mute)' },
  in_progress: { Icon: CircleDot,        color: 'var(--color-fg)' },
  in_review:   { Icon: CircleDotDashed,  color: 'var(--color-warn)' },
  done:        { Icon: CircleCheck,      color: 'var(--color-ok)' },
  wont_do:     { Icon: CircleSlash,      color: 'var(--color-fg-mute)' },
}

/**
 * The two statuses whose rows read as struck through wherever a title is drawn
 * beside them. Exported rather than inlined because the table row and the
 * detail header both have to agree about it.
 */
export const isSettled = (status: CardStatus) => status === 'done' || status === 'wont_do'

export function StatusGlyph({ status, size = 14 }: { status: CardStatus; size?: number }) {
  const { Icon, color } = STATUS_MARK[status]
  return <Icon size={size} strokeWidth={1.8} style={{ color }} aria-hidden />
}

/**
 * The glyph in the fixed slot the whole product uses, carrying its word for
 * anything that cannot see it.
 *
 * The `w-5 shrink-0` slot is not a gap: these glyphs differ in painted width by
 * a pixel or two, and letting one push what follows is what puts five rows on
 * five different x down a column. The label matters most where the word is not
 * also printed — the phone row is a glyph and a title and nothing else, and a
 * ring that a sighted reader learns in a morning is silent otherwise.
 */
export function StatusSlot({ status }: { status: CardStatus }) {
  return (
    <span role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}
      className="w-5 shrink-0 flex items-center">
      <StatusGlyph status={status} />
    </span>
  )
}

/**
 * `Flame` is reserved for Urgent and appears nowhere else in the product;
 * `TriangleAlert` is Sentry's and may not be borrowed for this, or the two
 * meanings blur on exactly the row where they are most likely to co-occur.
 */
const PRIORITY_MARK: Record<CardPriority, Mark | null> = {
  0: { Icon: Flame,      color: 'var(--color-bad)' },
  1: { Icon: SignalHigh, color: 'var(--color-fg)' },
  2: null,
  3: { Icon: SignalLow,  color: 'var(--color-fg-mute)' },
}

export function PriorityGlyph({ priority, size = 14 }: { priority: CardPriority; size?: number }) {
  const mark = PRIORITY_MARK[priority]
  if (!mark) return null
  const { Icon, color } = mark
  return <Icon size={size} strokeWidth={1.8} style={{ color }} aria-hidden />
}
