import { motion, useMotionValue, useTransform, type PanInfo } from 'motion/react'
import { useStill } from '../lib/motion'
import { useEffect, useRef, useState } from 'react'
import { Check, Clock, ListPlus, Pin, Terminal } from 'lucide-react'
import type { Card as CardT } from '../lib/types'
import { ago } from '../lib/time'
import { SOURCE_LABEL, SourceDot } from './sources'
import { spring } from './primitives'

/** Past this many pixels a release commits the gesture instead of springing back. */
const COMMIT_PX = 78

export type CardActions = {
  onOpen: (c: CardT) => void
  onDone: (c: CardT) => void
  onSnooze: (c: CardT) => void
  onTask?: (c: CardT) => void
  onLaunch?: (c: CardT) => void
}

export function Card({
  card, focused, onOpen, onDone, onSnooze, onTask, onLaunch,
}: CardActions & { card: CardT; focused?: boolean }) {
  const x = useMotionValue(0)
  const still = useStill()
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLElement>(null)

  // The action behind the card fades in as you pull, so the gesture explains
  // itself the first time rather than needing to be learned.
  const doneOpacity = useTransform(x, [0, COMMIT_PX], [0, 1])
  const snoozeOpacity = useTransform(x, [-COMMIT_PX, 0], [1, 0])
  const bodyOpacity = useTransform(x, [-160, 0, 160], [0.45, 1, 0.45])

  const sources = [...new Set(card.sources.map(s => s.source))]
  const acked = !!card.state?.acked_at
  const pinned = !!card.state?.pinned

  // Keyboard focus scrolls the row into view; without this, j past the fold
  // moves a selection nobody can see.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  function onDragEnd(_: unknown, info: PanInfo) {
    setDragging(false)
    const past = Math.abs(info.offset.x) > COMMIT_PX || Math.abs(info.velocity.x) > 620
    if (!past) return
    info.offset.x > 0 ? onDone(card) : onSnooze(card)
  }

  return (
    <div className="relative">
      {/* Gesture affordances, revealed by the drag rather than always visible. */}
      <div className="absolute inset-0 flex items-center justify-between px-6 pointer-events-none">
        <motion.span style={{ opacity: doneOpacity }} className="flex items-center gap-2 text-ok text-[13px]">
          <Check size={15} /> Done
        </motion.span>
        <motion.span style={{ opacity: snoozeOpacity }} className="flex items-center gap-2 text-fg-dim text-[13px]">
          Later <Clock size={15} />
        </motion.span>
      </div>

      <motion.article
        ref={ref as never}
        layout
        drag="x"
        dragDirectionLock
        style={{ x, opacity: bodyOpacity }}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.55}
        onDragStart={() => setDragging(true)}
        onDragEnd={onDragEnd}
        transition={spring}
        initial={still ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, height: 0, marginTop: 0, transition: { duration: 0.2 } }}
        // Click, not tap-through: a drag must never open a link by accident.
        onClick={() => { if (!dragging) onOpen(card) }}
        className={`relative cursor-pointer select-none group
                   px-4 sm:px-5 py-3.5 -mx-4 sm:-mx-5 rounded-xl
                   transition-colors duration-150 active:bg-ink-850
                   ${focused ? 'bg-ink-800' : 'bg-ink-900 hover:bg-ink-850'}`}
      >
        <div className="flex gap-3">
          <div className="pt-[7px]">
            <SourceDot source={card.sources[0]?.source ?? 'github'} size={7} />
          </div>

          <div className="min-w-0 grow">
            <h3 className={`text-[14.5px] leading-[1.4] tracking-[-0.01em] line-clamp-2
              ${acked ? 'text-fg-dim' : 'text-fg'}`}>
              {card.title}
            </h3>

            <div className="mt-1.5 flex items-center gap-x-2 gap-y-1 flex-wrap
                            text-[12.5px] text-fg-mute leading-none">
              <span className="text-fg-dim">{card.why}</span>
              {card.actor && (
                <>
                  <Dot />
                  <span className="truncate max-w-[14ch]">{card.actor}</span>
                </>
              )}
              <Dot />
              <time className="tnum">{ago(card.ts)}</time>
              {card.tasks.length > 0 && (
                <><Dot /><span className="text-accent-ink/80">
                  {card.tasks.length} task{card.tasks.length > 1 ? 's' : ''}
                </span></>
              )}
            </div>

            {/* Named chips rather than bare dots: "Slack + GitHub" is the dedup
                made legible, and a dot alone needs a legend nobody reads. */}
            <div className="mt-2 flex items-center gap-1.5 flex-wrap">
              {sources.map(s => (
                <span key={s} className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full
                                          bg-ink-850 text-[11px] text-fg-mute">
                  <SourceDot source={s} size={5} />
                  {SOURCE_LABEL[s]}
                </span>
              ))}
            </div>
          </div>

          {pinned && <Pin size={12} className="text-accent-ink shrink-0 mt-1.5" />}
        </div>

        {/* Row actions. Hidden until hover or keyboard focus so a scanning read
            stays quiet, but always reachable — the swipe covers only two of them
            and a laptop has no swipe. */}
        <div
          className={`mt-2 -mb-1 flex items-center gap-0.5 transition-opacity
            ${focused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}
          onClick={e => e.stopPropagation()}
        >
          {onLaunch && <RowAction icon={<Terminal size={12} />} label="Open in Claude" onClick={() => onLaunch(card)} />}
          {onTask && <RowAction icon={<ListPlus size={12} />} label="Task" onClick={() => onTask(card)} />}
          <RowAction icon={<Clock size={12} />} label="Later" onClick={() => onSnooze(card)} />
          <RowAction icon={<Check size={12} />} label="Done" onClick={() => onDone(card)} />
        </div>
      </motion.article>
    </div>
  )
}

function RowAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="inline-flex items-center gap-1.5 h-7 px-2 rounded-lg text-[11.5px]
                 text-fg-mute hover:text-fg-dim hover:bg-ink-800 transition-colors"
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

const Dot = () => <span className="text-ink-600 select-none">·</span>
