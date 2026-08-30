/**
 * ⌘K.
 *
 * One list, ranked by a subsequence match rather than a substring one, so "opc"
 * finds "Open in Claude Code" the way people actually type into these things.
 * It offers navigation, the actions a page would otherwise hide behind a menu,
 * and whatever the current page contributes — a card, a mail thread — through
 * `usePaletteActions`, so the palette never has to know what a page is.
 */

import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { useStill } from '../lib/motion'
import { useOverlay } from '../lib/overlay'

export type Command = {
  id: string
  label: string
  hint?: string
  group: string
  icon?: ReactNode
  run: () => void
}

/**
 * Score `label` against `q`. A contiguous match beats a scattered one, and a
 * match at a word boundary beats one mid-word — which is what stops "ma" from
 * ranking "Format" above "Mail".
 */
export function score(label: string, q: string): number {
  if (!q) return 1
  const l = label.toLowerCase()
  const needle = q.toLowerCase()
  if (l.startsWith(needle)) return 1000 - l.length
  const at = l.indexOf(needle)
  if (at >= 0) return 800 - at * 4 - l.length

  let i = 0
  let streak = 0
  let best = 0
  for (const ch of l) {
    if (ch === needle[i]) {
      i++
      streak++
      best = Math.max(best, streak)
    } else {
      streak = 0
    }
    if (i >= needle.length) break
  }
  return i >= needle.length ? 100 + best * 8 - l.length / 4 : 0
}

export function Palette({
  open, onClose, commands,
}: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const still = useStill()
  useOverlay(open)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQ('')
    setSel(0)
    // A task, not an animation frame. The element is mounting inside an
    // animation so the focus has to be deferred — but a hidden document
    // schedules no frames at all, so `requestAnimationFrame` here meant the
    // palette opened with nothing focused and stayed that way.
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [open])

  const hits = useMemo(() => {
    const ranked = commands
      .map(c => ({ c, n: score(`${c.label} ${c.hint ?? ''}`, q) }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 40)
      .map(x => x.c)
    return ranked
  }, [commands, q])

  useEffect(() => { setSel(0) }, [q])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose()
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
        e.preventDefault()
        setSel(s => Math.min(s + 1, hits.length - 1))
      } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
        e.preventDefault()
        setSel(s => Math.max(s - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const hit = hits[sel]
        if (hit) {
          onClose()
          hit.run()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, hits, sel, onClose])

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  let lastGroup = ''

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4">
          <motion.div
            className="absolute inset-0 bg-scrim/70"
            initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }}
            exit={still ? undefined : { opacity: 0 }}
            transition={{ duration: 0.14 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog" aria-modal="true" aria-label="Command palette"
            // An ungated exit here is worse than a missing animation: the
            // palette stays mounted, over the page, until an animation frame
            // that a hidden tab never schedules finally arrives.
            initial={still ? false : { opacity: 0, y: -8, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={still ? undefined : { opacity: 0, y: -6, scale: 0.99 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="relative w-full max-w-[560px] rounded-panel bg-ink-850
                       border border-edge overflow-hidden"
          >
            <div className="flex items-center gap-2.5 px-4 h-12 hairline">
              <Search size={15} className="text-fg-mute shrink-0" />
              <input
                ref={inputRef}
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Go to, or do…"
                className="flex-1 bg-transparent outline-none text-[14.5px] text-fg placeholder:text-fg-mute"
              />
              <kbd className="text-[10.5px] text-fg-mute px-1.5 py-0.5 rounded bg-ink-800">esc</kbd>
            </div>

            <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5">
              {hits.map((c, i) => {
                const head = c.group !== lastGroup ? c.group : null
                lastGroup = c.group
                return (
                  <div key={c.id}>
                    {head && (
                      <div className="px-4 pt-2.5 pb-1 text-[10.5px] uppercase tracking-[0.08em] text-fg-mute">
                        {head}
                      </div>
                    )}
                    <button
                      data-selected={i === sel}
                      onMouseEnter={() => setSel(i)}
                      onClick={() => { onClose(); c.run() }}
                      className={`w-full flex items-center gap-2.5 px-4 py-2 text-left transition-colors
                        ${i === sel ? 'bg-ink-800' : 'hover:bg-ink-800/60'}`}
                    >
                      <span className="text-fg-mute shrink-0">{c.icon}</span>
                      <span className="text-[13.5px] text-fg truncate">{c.label}</span>
                      {c.hint && <span className="ml-auto text-[11.5px] text-fg-mute truncate max-w-[45%]">{c.hint}</span>}
                    </button>
                  </div>
                )
              })}
              {!hits.length && (
                <p className="px-4 py-6 text-[13px] text-fg-mute text-center">Nothing matches that.</p>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

/* ------------------------- page-contributed actions ----------------------- */

/**
 * Pages push their own commands into the palette without the palette importing
 * them. A module-level registry rather than context, because the shell renders
 * above every page and a provider would have to wrap the whole tree to pass
 * values upward — which context does not do.
 */
type Contributor = () => Command[]
const contributors = new Set<Contributor>()
const listeners = new Set<() => void>()
let version = 0

export function registerPaletteActions(fn: Contributor): () => void {
  contributors.add(fn)
  version++
  listeners.forEach(l => l())
  return () => {
    contributors.delete(fn)
    version++
    listeners.forEach(l => l())
  }
}

export function contributedCommands(): Command[] {
  return [...contributors].flatMap(fn => {
    try {
      return fn()
    } catch {
      // A page mid-render must not be able to break the palette.
      return []
    }
  })
}

export const paletteVersion = () => version
export const subscribePalette = (l: () => void) => (listeners.add(l), () => listeners.delete(l))
