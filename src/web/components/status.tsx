/**
 * Where work stands, and how much it matters — a shape *and* a hue.
 *
 * This file used to argue that the ring alone should carry the status and that
 * colour was too expensive to spend on it. Held on a phone that argument does
 * not survive first contact: `not_started` and `wont_do` were painted with the
 * same token, so two of the five states were not hard to tell apart, they were
 * the same picture. `in_progress` took `--color-fg`, which is also the colour
 * of the title next to it. Five statuses rendered as, in practice, two.
 *
 * So the shape stays — open circle, filled dot, dashed, tick, slash, which is
 * what still works for anyone who cannot use the hue — and each state now also
 * gets one of the five `--color-status-*` tokens. `StatusGlyph` and
 * `StatusChip` are the only two things in the product allowed to paint them;
 * `Work.tsx` in particular used to keep its own private set of circles, which
 * is how it drifted three states behind this file.
 *
 * `in_progress` is sky, not amber. Amber is unread, the badge, and the one
 * primary button, and a status every second row wears would drown all three.
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
  not_started: { Icon: Circle,           color: 'var(--color-status-idle)' },
  in_progress: { Icon: CircleDot,        color: 'var(--color-status-live)' },
  in_review:   { Icon: CircleDotDashed,  color: 'var(--color-status-review)' },
  done:        { Icon: CircleCheck,      color: 'var(--color-status-done)' },
  wont_do:     { Icon: CircleSlash,      color: 'var(--color-status-drop)' },
}

/** The hue one status owns, for the rare caller that needs it raw. */
export const statusColor = (status: CardStatus) => STATUS_MARK[status].color

/**
 * The wash behind a chip: the status' own hue at 14%, over whatever surface the
 * chip happens to sit on.
 *
 * `oklab` rather than `srgb` because mixing a saturated violet toward
 * transparent in sRGB greys it out on the way, and the whole point of the chip
 * is that the hue survives at low alpha. 14% is the highest value at which the
 * five washes still read as *behind* the text rather than as five buttons.
 */
export const statusWash = (status: CardStatus) =>
  `color-mix(in oklab, ${STATUS_MARK[status].color} 14%, transparent)`

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
 * The status as a thing you can read across a room: glyph, word, and the hue
 * washed behind both.
 *
 * This is what a closed Status control shows, what a row shows on the phone,
 * and what the swipe drawer's five choices are drawn with — one component, so
 * the five colours cannot mean one thing in a list and another in a picker.
 *
 * `size="sm"` is the row chip and `md` is the one in a detail header or a
 * picker, where 44px of height is a tap target rather than decoration.
 */
export function StatusChip({
  status, size = 'sm', className = '',
}: { status: CardStatus; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full whitespace-nowrap ${
        size === 'md' ? 'px-2.5 py-1.5 text-base' : 'px-2 py-0.5 text-sm'
      } ${className}`}
      style={{ background: statusWash(status), color: STATUS_MARK[status].color }}
    >
      <StatusGlyph status={status} size={size === 'md' ? 15 : 13} />
      {STATUS_LABEL[status]}
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
