import { AnimatePresence, motion } from 'motion/react'
import { Undo2 } from 'lucide-react'
import { dismissToast, useToast } from '../lib/toast'
import { useStill } from '../lib/motion'

/**
 * The undo bar. One line, one action, and it gets out of the way on its own.
 *
 * It sits above the phone's tab bar rather than over it, because the whole
 * point is that it is reachable — a bar the thumb bar covers is a bar nobody
 * presses in the four seconds they have.
 */
export function ToastBar() {
  const t = useToast()
  const still = useStill()

  return (
    <AnimatePresence>
      {t && (
        <motion.div
          key={t.id}
          role="status"
          aria-live="polite"
          initial={still ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={still ? undefined : { opacity: 0, y: 12 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] sm:bottom-6
                     z-[70] flex justify-center px-4 pointer-events-none"
        >
          <div className="pointer-events-auto flex items-center gap-3 max-w-[min(30rem,100%)]
                          rounded-panel bg-ink-850 border border-edge
                          pl-4 pr-1.5 py-1.5">
            <span className="text-sm text-fg-dim truncate">{t.text}</span>
            {t.action && (
              <button
                onClick={() => { const run = t.action!.run; dismissToast(); void run() }}
                className="shrink-0 inline-flex items-center gap-2 h-8 px-3 rounded-full
                           text-sm font-medium text-accent-ink hover:bg-ink-600 transition-colors"
              >
                <Undo2 size={13} />
                {t.action.label}
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
