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
 * Three sizes, and the hit area is not the ink.
 *
 * There used to be exactly one button in the app — `min-h-9 px-3 text-[13.5px]`
 * — used for a close X, a snooze preset and a form submit alike, which is how
 * "Tonight" became a 69×36 box around a seven-character label.
 *
 * `sm` and `md` carry `.hit`, an `::after { inset: -6px }` that grows the touch
 * target to 38/44px while the painted box stays 26/32px. Small ink, generous
 * target: that is what "feels like a tool" means, and it is what lets a button
 * shrink without becoming unhittable on a phone.
 *
 * `primary` is the amber fill, and there is at most one per surface.
 * `default` is bordered and not filled, which is what actually reads as a tool.
 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'hit h-[26px] px-2 text-xs font-medium gap-1.5',
  md: 'hit h-8 px-3 text-sm font-medium gap-1.5',
  lg: 'h-[38px] px-4 text-base font-medium gap-2',
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
      <div className="text-eyebrow uppercase text-fg-mute mb-1.5">{label}</div>
      {children}
    </label>
  )
}

export const inputClass =
  `w-full bg-ink-850 border border-edge rounded-control px-3 py-2 text-base text-fg
   placeholder:text-fg-mute outline-none transition-shadow
   focus:ring-1 focus:ring-accent/50`

export function Chip({
  active, onClick, children, dot, disabled, title,
}: {
  active?: boolean; onClick?: () => void; children: ReactNode
  dot?: string; disabled?: boolean; title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={`hit relative inline-flex items-center gap-1.5 h-[26px] px-2 rounded-control text-xs
        font-medium transition-colors duration-100 whitespace-nowrap shrink-0
        disabled:opacity-40 disabled:pointer-events-none
        ${active ? 'bg-ink-800 text-fg border border-edge' : 'text-fg-mute hover:text-fg-dim hover:bg-ink-800 border border-transparent'}`}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />}
      {children}
    </button>
  )
}

/**
 * An empty surface keeps all of its chrome and says nothing louder than a row.
 *
 * One line, left-aligned at the x-position of the content it replaces, occupying
 * exactly one row's height. A noun phrase, not a sentence — no terminal period,
 * no second line, no explanation, no number, no icon, and never centred. The
 * previous version was `py-10 text-center`, which made "nothing here" the
 * largest thing on the screen.
 */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm text-fg-mute h-11 flex items-center">{children}</p>
  )
}
