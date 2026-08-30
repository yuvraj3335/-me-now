import { AnimatePresence, motion } from 'motion/react'
import { useEffect, type ReactNode } from 'react'
import { useStill } from '../lib/motion'
import { useOverlay } from '../lib/overlay'
import { X } from 'lucide-react'

export const spring = { type: 'spring', stiffness: 520, damping: 40, mass: 0.7 } as const
export const softSpring = { type: 'spring', stiffness: 260, damping: 30 } as const

/* --------------------------------- buttons -------------------------------- */

export type ButtonSize = 'sm' | 'md' | 'lg'
export type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger'

/**
 * One height. The sizes differ in padding, and the hit area is not the ink.
 *
 * There were nine painted control heights in this product against four row
 * heights — 24, 26, 28, 32, 36, 38, 44, 45, 48, 52, 60, 65 — and not one control
 * equalled a row. A control is 32px now, everywhere, with a glyph of at most
 * 14px inside it, and `.hit` grows the touch target to 44px on a coarse pointer
 * while the painted box stays 32. Small ink, generous target: that is what
 * "feels like a tool" means. See the note in `styles.css` for why the hit box is
 * scoped to touch.
 *
 * Every label is `text-sm`. `text-xs` was on the filter chips, every row action
 * and every `sm` button — which is most of what gets read before a decision, at
 * 12px, under this file's own stated floor.
 *
 * `primary` is the amber fill. At most one per surface, and only when pressing
 * it commits something. It is never `Open`, `Connect`, `Turn on`, `Instruction`
 * or `Fetch` — those are decisions, not commitments, and they are ghost text.
 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'hit h-8 px-2 text-sm font-medium gap-2',
  md: 'hit h-8 px-3 text-sm font-medium gap-2',
  lg: 'hit h-8 px-4 text-sm font-medium gap-2',
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:brightness-110',
  default: 'border border-edge text-fg-dim hover:text-fg hover:bg-ink-800',
  ghost: 'text-fg-mute hover:text-fg-dim hover:bg-ink-800',
  danger: 'border border-edge text-bad hover:bg-ink-800',
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
 * `Later today / Tonight / Tomorrow / Next week` was four 36px lozenges taking a
 * whole row of the detail pane; `Move to: Now / Open` was two more. They are the
 * same decision asked once, so they render as one 32px segmented control.
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

export function Chip({
  active, onClick, children, dot, hollow, disabled, title, ariaLabel,
}: {
  active?: boolean; onClick?: () => void; children: ReactNode
  dot?: string
  /** The dot is an outline: this source's last poll failed. */
  hollow?: boolean
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
        font-medium transition-colors duration-100 whitespace-nowrap shrink-0
        disabled:opacity-40 disabled:pointer-events-none
        ${active ? 'bg-ink-800 text-fg border border-edge' : 'text-fg-mute hover:text-fg-dim hover:bg-ink-800 border border-transparent'}`}
    >
      {/* A hollow dot is a source whose last poll failed; the reason is on the
          chip's own `title`. It is the only sync mark on Now. */}
      {dot && (
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={hollow
            ? { border: `1.5px solid ${dot}`, background: 'transparent' }
            : { background: dot }}
        />
      )}
      {children}
    </button>
  )
}

/**
 * A whole surface that is empty says one word, on the row grid.
 *
 * One line at the content's own x, exactly one row tall. Never centred, never a
 * sentence, never a number, never an icon — and never naming the filter, because
 * the chip already does and "Nothing from Slack" is three chapters' worth of
 * apology compressed into one. Default `—`, because most callers are a value
 * that has nothing in it rather than a surface that is empty.
 *
 * An empty *group* does not use this. It is not rendered at all.
 */
export function Empty({ children = '—' }: { children?: ReactNode }) {
  return (
    <p className="text-sm text-fg-mute h-11 flex items-center">{children}</p>
  )
}
