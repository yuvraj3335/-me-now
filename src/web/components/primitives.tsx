import { AnimatePresence, motion } from 'motion/react'
import { useEffect, type ReactNode } from 'react'
import { useStill } from '../lib/motion'
import { X } from 'lucide-react'

export const spring = { type: 'spring', stiffness: 520, damping: 40, mass: 0.7 } as const
export const softSpring = { type: 'spring', stiffness: 260, damping: 30 } as const

export function Button({
  children, onClick, variant = 'ghost', className = '', disabled, type = 'button', title,
}: {
  children: ReactNode; onClick?: () => void
  variant?: 'ghost' | 'solid' | 'accent' | 'quiet'
  className?: string; disabled?: boolean; type?: 'button' | 'submit'; title?: string
}) {
  const styles = {
    ghost: 'text-fg-dim hover:text-fg hover:bg-ink-800',
    quiet: 'text-fg-mute hover:text-fg-dim',
    solid: 'bg-ink-700 text-fg hover:bg-ink-600',
    accent: 'bg-accent text-ink-950 hover:brightness-110 font-medium',
  }[variant]

  return (
    <motion.button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={spring}
      // min-h-9 keeps every control at a comfortable thumb size on a phone
      // without drawing a box around it.
      className={`inline-flex items-center justify-center gap-1.5 min-h-9 px-3 rounded-[10px]
        text-[13.5px] transition-colors duration-150 disabled:opacity-40
        disabled:pointer-events-none ${styles} ${className}`}
    >
      {children}
    </motion.button>
  )
}

/**
 * One modal component for the whole app: a bottom sheet on a phone, a centred
 * panel on a laptop. Same content, so nothing is built twice.
 */
export function Sheet({
  open, onClose, title, children, footer,
}: {
  open: boolean; onClose: () => void; title?: string
  children: ReactNode; footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    // Freeze the page behind the sheet so iOS does not scroll it away.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
          <motion.div
            className="absolute inset-0 bg-ink-950/70 backdrop-blur-[2px]"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog" aria-modal="true" aria-label={title}
            className="relative w-full sm:max-w-[460px] bg-ink-850 sm:rounded-2xl
                       rounded-t-2xl shadow-2xl max-h-[88vh] flex flex-col pad-bottom"
            initial={{ y: '100%', opacity: 0.6, scale: 1 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '100%', opacity: 0.6 }}
            transition={spring}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            // Flick down to dismiss — the gesture people already expect.
            onDragEnd={(_, i) => { if (i.offset.y > 110 || i.velocity.y > 750) onClose() }}
          >
            <div className="sm:hidden pt-2.5 pb-1 flex justify-center shrink-0">
              <div className="w-9 h-1 rounded-full bg-ink-600" />
            </div>
            {title && (
              <div className="flex items-center justify-between px-5 pt-3 pb-2 shrink-0">
                <h2 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h2>
                <Button variant="quiet" onClick={onClose} className="!px-2 -mr-2" title="Close">
                  <X size={16} />
                </Button>
              </div>
            )}
            <div className="overflow-y-auto px-5 pb-4 grow">{children}</div>
            {footer && <div className="px-5 py-3 shrink-0">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

export function Field({
  label, children, hint,
}: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block mb-3.5">
      <div className="text-[11.5px] uppercase tracking-[0.07em] text-fg-mute mb-1.5">{label}</div>
      {children}
      {hint && <div className="text-[12px] text-fg-mute mt-1.5 leading-snug">{hint}</div>}
    </label>
  )
}

export const inputClass =
  `w-full bg-ink-800 rounded-[10px] px-3 py-2.5 text-[14.5px] text-fg
   placeholder:text-fg-mute outline-none transition-shadow
   focus:ring-1 focus:ring-accent/50`

export function Chip({
  active, onClick, children, dot,
}: { active?: boolean; onClick?: () => void; children: ReactNode; dot?: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12.5px]
        transition-colors duration-150 whitespace-nowrap
        ${active ? 'bg-ink-700 text-fg' : 'text-fg-mute hover:text-fg-dim hover:bg-ink-800'}`}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />}
      {children}
    </button>
  )
}

/** Quiet empty state — a sentence, not an illustration. */
export function Empty({ children }: { children: ReactNode }) {
  const still = useStill()
  return (
    <motion.p
      initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}
      className="text-[13.5px] text-fg-mute py-10 text-center leading-relaxed"
    >
      {children}
    </motion.p>
  )
}
