import { AnimatePresence, motion } from 'motion/react'
import { useEffect, type ReactNode } from 'react'
import { useStill } from '../lib/motion'
import { useOverlay } from '../lib/overlay'
import { toLocalInput, fromLocalInput } from '../lib/time'
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react'

export const spring = { type: 'spring', stiffness: 520, damping: 40, mass: 0.7 } as const
export const softSpring = { type: 'spring', stiffness: 260, damping: 30 } as const

/* --------------------------------- buttons -------------------------------- */

export type ButtonSize = 'sm' | 'md' | 'lg'
export type ButtonVariant = 'primary' | 'secondary' | 'default' | 'ghost' | 'danger'

/**
 * Three real heights, and the hit area is not the ink.
 *
 * There were nine painted control heights in this product against four row
 * heights — 24, 26, 28, 32, 36, 38, 44, 45, 48, 52, 60, 65 — and not one control
 * equalled a row, so everything collapsed to one 32px box. That collapse went
 * one step too far: a page-level commit and a row action ended up the same
 * 32px, and a commitment that is the same size as a row action reads as a row
 * action. The three heights are back, but as three *jobs* rather than three
 * paddings — 28 for something that lives inside a row, 32 for page chrome, 40
 * for the one control that commits. `lg` is allowed on a sheet-footer commit
 * and a page-header primary and nowhere else; never in a table row, never in a
 * chip rail.
 *
 * `.hit` grows the touch target to 44px on a coarse pointer while the painted
 * box stays small — see the note in `styles.css` for why that is scoped to
 * touch. `lg` does not take it: at 40px the box already clears the target, and
 * the 6px outset is scrollable overflow on a page that has a mouse.
 *
 * Every label is `text-sm` bar `lg`. `text-xs` was on the filter chips, every
 * row action and every `sm` button — which is most of what gets read before a
 * decision, at 12px, under this file's own stated floor.
 *
 * `primary` is the amber fill. At most one per surface, and only when pressing
 * it commits something. It is never `Connect`, `Turn on`, `Instruction` or
 * `Fetch` — those are decisions, not commitments.
 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'hit h-7 px-2 text-sm gap-2',
  md: 'hit h-8 px-3 text-sm gap-2',
  lg: 'h-10 px-4 text-base gap-2',
}

/**
 * Weight lives here rather than on the size, because weight is what the button
 * is *for*: a commit is semibold whatever height it is drawn at, and a ghost
 * stays medium even when it is the biggest thing on the row.
 *
 * `secondary` is the new one, and it is what an action bar is made of — a
 * filled, bordered, full-contrast button that is unmistakably pressable without
 * spending the accent. Four ghost labels in a row read as a caption.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent font-semibold hover:brightness-110',
  secondary: 'bg-ink-800 border border-edge text-fg font-medium hover:bg-ink-700',
  default: 'border border-edge text-fg-dim font-medium hover:text-fg hover:bg-ink-800',
  ghost: 'text-fg-mute font-medium hover:text-fg-dim hover:bg-ink-800',
  danger: 'bg-bad text-on-bad font-semibold hover:brightness-110',
}

export function Button({
  children, onClick, variant = 'default', size = 'md', className = '',
  disabled, type = 'button', title, ariaLabel,
}: {
  children: ReactNode; onClick?: () => void
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string; disabled?: boolean; type?: 'button' | 'submit'
  title?: string; ariaLabel?: string
}) {
  return (
    <button
      type={type}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={`relative inline-flex items-center justify-center rounded-control whitespace-nowrap
        transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none
        ${SIZE[size]} ${VARIANT[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * A set of sibling choices is one control, not N buttons.
 *
 * A row of lozenges is N controls that look like N decisions; a segmented box
 * is one control that looks like the one decision it is. Two of the deferral
 * ladders this replaced took a whole row of the detail pane each, to ask one
 * question between them.
 *
 * Use it for three or four short, fixed choices that fit side by side. Beyond
 * that — the five statuses, the four priorities — it is a `Select`: a segmented
 * control wide enough to hold five words is a toolbar.
 */
export function Segmented<T extends string>({
  options, value, onChange, ariaLabel, className = '',
}: {
  options: Array<{ id: T; label: string; disabled?: boolean }>
  value?: T | null
  onChange: (id: T) => void
  ariaLabel?: string
  className?: string
}) {
  return (
    <div role="group" aria-label={ariaLabel}
      className={`inline-flex h-8 rounded-control border border-edge overflow-hidden ${className}`}>
      {options.map((o, i) => (
        <button
          key={o.id}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={`relative px-3 text-sm font-medium transition-colors duration-100
            disabled:opacity-40 disabled:pointer-events-none
            ${i > 0 ? 'border-l border-edge' : ''}
            ${value === o.id ? 'bg-ink-800 text-fg' : 'text-fg-mute hover:text-fg-dim hover:bg-ink-800'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* --------------------------------- sheets --------------------------------- */

/**
 * One modal component for the whole app: a bottom sheet on a phone, a centred
 * panel on a laptop. Same content, so nothing is built twice.
 *
 * Opaque with a 1px edge. Elevation here is an edge on a flat surface — there is
 * no blur and no `shadow-2xl`, because a blurred translucent panel over a
 * near-black page reads as smear rather than as depth, and over an off-white one
 * it reads as nothing at all.
 *
 * The body scroll lock is not owned here: `useOverlay` owns it, so two sheets
 * closing in the wrong order cannot leave the page frozen at `hidden`.
 */
export function Sheet({
  open, onClose, title, children, footer, wide,
}: {
  open: boolean; onClose: () => void; title?: string
  children: ReactNode; footer?: ReactNode
  /**
   * A reading width rather than a control width. 460px is right for a form of
   * short fields; it is wrong for anything you have to actually read, and a
   * brief reviewed through a 460px column of monospace is not reviewed.
   */
  wide?: boolean
}) {
  const still = useStill()
  useOverlay(open)

  // Escape closes every overlay in the product.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
          <motion.div
            className="absolute inset-0 bg-scrim/70"
            initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }}
            exit={still ? undefined : { opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog" aria-modal="true" aria-label={title}
            className={`relative w-full ${wide ? 'sm:max-w-[760px]' : 'sm:max-w-[460px]'} bg-ink-850
                       border border-edge sm:rounded-panel rounded-t-panel
                       max-h-[88vh] flex flex-col pad-bottom`}
            // Not animated in when frames are not being produced. `y: '100%'`
            // is a real transform the moment it is applied, so a slide-up that
            // never runs leaves the panel a full panel-height below the fold —
            // its buttons unreachable, with nothing to scroll to reach them.
            initial={still ? false : { y: '100%', opacity: 0.6 }}
            animate={{ y: 0, opacity: 1 }}
            exit={still ? undefined : { y: '100%', opacity: 0.6 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            {title && (
              <div className="flex items-center justify-between gap-3 px-4 h-12 shrink-0 border-b border-rule">
                <h2 className="text-md font-medium tracking-[-0.01em] truncate">{title}</h2>
                <Button variant="ghost" size="sm" onClick={onClose} ariaLabel="Close" title="Close">
                  <X size={14} />
                </Button>
              </div>
            )}
            <div className="overflow-y-auto px-4 py-4 grow">{children}</div>
            {footer && <div className="px-4 py-3 shrink-0 border-t border-rule">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

/* --------------------------------- fields --------------------------------- */

/**
 * A label and a control.
 *
 * `hint` is gone from the signature on purpose. Sixty-one distinct explanatory
 * strings shipped across five routes and six overlays, most of them a second
 * paragraph under a field — and a control that needs a paragraph is the wrong
 * control. Removing the prop is what keeps them from coming back without a code
 * change. The few strings that are safety controls rather than help text live
 * next to the action they guard, written out, not passed through here.
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block mb-4">
      <div className="text-eyebrow uppercase text-fg-mute mb-2">{label}</div>
      {children}
    </label>
  )
}

export const inputClass =
  `w-full bg-ink-850 border border-edge rounded-control px-3 py-2 text-base text-fg
   placeholder:text-fg-mute outline-none transition-shadow
   focus:ring-1 focus:ring-accent/50`

/**
 * A closed set of values, as one control that fits inside a table row.
 *
 * A native `<select>`, deliberately. Every hand-rolled dropdown in a scrolling
 * table has to solve clipping, focus return and pointer capture, and iOS gives
 * a native one a wheel picker that is better than anything that could be built
 * here. `appearance-none` takes the platform chrome off and the chevron is
 * drawn back on behind `pointer-events-none`, so the whole box is the target.
 *
 * 28px, so it sits inside a 44px data row without setting the row's height.
 * `onClick`/`onPointerDown` stop propagating: a Status control lives in a row
 * whose own click opens the detail, and changing a status is not asking to read
 * the card.
 */
export function Select<T extends string>({
  value, options, onChange, ariaLabel, className = '',
}: {
  value: T
  options: ReadonlyArray<{ id: T; label: string }>
  onChange: (v: T) => void
  ariaLabel: string
  className?: string
}) {
  return (
    <span className={`relative inline-flex items-center shrink-0 ${className}`}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={e => onChange(e.target.value as T)}
        onClick={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}
        className="appearance-none h-7 w-full pl-2 pr-5 rounded-control border border-edge
                   bg-transparent text-sm text-fg-dim hover:text-fg hover:bg-ink-800
                   transition-colors duration-100 outline-none truncate"
      >
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <ChevronDown size={13} aria-hidden
        className="absolute right-1 text-fg-mute pointer-events-none" />
    </span>
  )
}

/**
 * A real calendar, not four presets.
 *
 * `datetime-local` is the whole point: the operator asked to pick a date, and
 * every preset ladder this product shipped answered a different question — how
 * far away, rather than when. Presets may sit beside this; they may not replace
 * it. `toLocalInput`/`fromLocalInput` handle the wall-clock round trip and its
 * daylight-saving trap; see `lib/time.ts`.
 *
 * The Clear control is separate and only rendered once there is something to
 * clear, because an empty field with a cross beside it is two ways to say the
 * same nothing.
 */
export function DateField({
  value, onChange, ariaLabel,
}: { value: number | null; onChange: (ms: number | null) => void; ariaLabel: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="datetime-local"
        aria-label={ariaLabel}
        value={toLocalInput(value)}
        onChange={e => onChange(fromLocalInput(e.target.value))}
        onClick={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}
        className="h-8 px-2 rounded-control border border-edge bg-transparent
                   text-sm text-fg-dim outline-none transition-shadow
                   focus:ring-1 focus:ring-accent/50"
      />
      {value !== null && (
        <Button size="sm" variant="ghost" title="Clear" ariaLabel="Clear"
          onClick={() => onChange(null)}>
          <X size={13} />
        </Button>
      )}
    </span>
  )
}

/**
 * How many rows a page holds, everywhere in the product.
 *
 * One number rather than one per list: `Pager` renders the range it is standing
 * over, so a caller that sliced by 25 and a pager that counted by 50 would
 * print a range that does not describe the rows underneath it. `pageCount` and
 * `pageSlice` are here so nobody has to re-derive the clamp either.
 */
export const PAGE_SIZE = 50

export const pageCount = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE))

/** The rows for `page`, with `page` clamped into the list that actually exists. */
export function pageSlice<T>(rows: readonly T[], page: number): T[] {
  const p = Math.min(Math.max(page, 1), pageCount(rows.length))
  return rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE) as T[]
}

/**
 * One page of a list, and how to get to the next.
 *
 * Prev and Next, and no numbered strip: a strip is N controls to say what two
 * plus a count already say, and at page 40 it is either a scrolling row of
 * digits or an ellipsis menu, which this product does not have. The range and
 * the total are the orientation; the two buttons are the movement.
 *
 * The disabled ends are real `disabled` attributes rather than a dimmed style,
 * so a screen reader and a finger get the same answer as the eye.
 *
 * It renders nothing when one page holds everything — a pager over 12 rows is
 * chrome reporting that there is no second page.
 */
export function Pager({
  page, pages, total, onPage,
}: { page: number; pages: number; total: number; onPage: (n: number) => void }) {
  if (total === 0 || pages <= 1) return null
  const from = (page - 1) * PAGE_SIZE + 1
  const to = Math.min(page * PAGE_SIZE, total)

  return (
    <div className="flex items-center gap-3 py-3">
      <span className="text-sm text-fg-mute tnum">{from}–{to} of {total}</span>
      <span className="ml-auto flex items-center gap-2">
        <Button size="md" variant="default" disabled={page <= 1}
          title="Previous page" ariaLabel="Previous page" onClick={() => onPage(page - 1)}>
          <ChevronLeft size={14} />
        </Button>
        <Button size="md" variant="default" disabled={page >= pages}
          title="Next page" ariaLabel="Next page" onClick={() => onPage(page + 1)}>
          <ChevronRight size={14} />
        </Button>
      </span>
    </div>
  )
}

export function Chip({
  active, onClick, children, dot, mark, disabled, title, ariaLabel, flexible,
}: {
  active?: boolean; onClick?: () => void; children: ReactNode
  /**
   * This chip may give up width rather than push its neighbours off the screen.
   *
   * A chip is `shrink-0` by default, which is right for a row that fits and
   * wrong for the one chip in it that carries a variable-length name. Six
   * controls and a name like `Claude Code` do not fit 358px, and the row is
   * required not to scroll, so that name truncates instead.
   */
  flexible?: boolean
  /** A colour swatch — a goal's colour, and nothing that has a mark of its own. */
  dot?: string
  /**
   * A mark the caller draws itself, which wins over `dot`.
   *
   * A phone has no hover, so a row of chips whose only identification is a
   * `title` attribute is a row of anonymous lozenges until you tap one. A chip
   * that stands for something with a glyph elsewhere in the product carries that
   * same glyph here.
   */
  mark?: ReactNode
  disabled?: boolean; title?: string; ariaLabel?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`hit relative inline-flex items-center gap-2 h-8 px-2 rounded-control text-sm
        font-medium transition-colors duration-100 whitespace-nowrap
        ${flexible ? 'min-w-0' : 'shrink-0'}
        disabled:opacity-40 disabled:pointer-events-none
        ${active ? 'bg-ink-800 text-fg border border-edge' : 'text-fg-mute hover:text-fg-dim hover:bg-ink-800 border border-transparent'}`}
    >
      {mark ?? (dot && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />)}
      {children}
    </button>
  )
}

/**
 * A whole surface that is empty says one word, on the row grid.
 *
 * One line at the content's own x, exactly one row tall. Never centred, never a
 * sentence, never a number, never an icon — and never naming the filter, since
 * the pressed chip already does. Naming it was three chapters' worth of apology
 * compressed into one line. Default `—`, because most callers are a value that
 * has nothing in it rather than a surface that is empty.
 *
 * An empty *group* does not use this. It is not rendered at all.
 */
export function Empty({ children = '—' }: { children?: ReactNode }) {
  return (
    <p className="text-sm text-fg-mute h-11 flex items-center">{children}</p>
  )
}
