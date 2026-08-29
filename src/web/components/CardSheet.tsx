import { useEffect, useState } from 'react'
import {
  ArrowUpRight, Check, Clock, Copy, Inbox, ListPlus, MessageSquare, Pin, PinOff,
  SquareCheck, UserMinus,
} from 'lucide-react'
import type { Card as CardT } from '../lib/types'
import { actions, reload } from '../lib/api'
import { ago, atHour, timeOfDay } from '../lib/time'
import { SOURCE_LABEL, SourceDot } from './sources'
import { Button, Sheet } from './primitives'

const SNOOZE = [
  { label: 'Later today', at: () => Date.now() + 4 * 3.6e6 },
  { label: 'Tonight', at: () => atHour(0, 20) },
  { label: 'Tomorrow', at: () => atHour(1, 9) },
  { label: 'Next week', at: () => atHour(7, 9) },
]

export function CardSheet({
  card, onClose, onMakeTask,
}: { card: CardT | null; onClose: () => void; onMakeTask: (c: CardT) => void }) {
  const [thread, setThread] = useState<any>(null)
  const [loadingThread, setLoadingThread] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => { setThread(null); setCopied(false) }, [card?.group_key])

  if (!card) return null

  const run = async (fn: () => Promise<unknown>) => { await fn(); await reload(); onClose() }
  const resumeCmd = card.sources.find(s => s.source === 'claude')?.meta?.resume_cmd as string | undefined
  const hasSlack = card.sources.some(s => s.source === 'slack')

  async function loadThread() {
    setLoadingThread(true)
    try { setThread(await actions.thread(card!.group_key)) }
    catch (e) { setThread({ error: (e as Error).message }) }
    finally { setLoadingThread(false) }
  }

  return (
    <Sheet open onClose={onClose} title={undefined}>
      <div className="pt-1">
        <h2 className="text-[17px] leading-snug tracking-[-0.015em] font-medium pr-6">{card.title}</h2>
        <p className="mt-1.5 text-[13px] text-fg-dim">
          {card.why}
          {card.actor && <> · <span className="text-fg-mute">{card.actor}</span></>}
          {' · '}<span className="text-fg-mute tnum">{ago(card.ts)} ago</span>
        </p>

        {card.excerpt && (
          <p className="mt-3.5 text-[13.5px] leading-relaxed text-fg-dim whitespace-pre-wrap
                        border-l border-ink-700 pl-3">
            {card.excerpt}
          </p>
        )}

        {/* Where this came from. With more than one entry this is the dedup
            made legible: the same thing, seen in several places, shown once. */}
        <div className="mt-5">
          <SectionLabel>
            {card.sources.length > 1 ? `Seen in ${card.sources.length} places` : 'Source'}
          </SectionLabel>
          <div className="space-y-0.5">
            {card.sources.map(s => {
              const external = s.url.startsWith('http')
              return (
                <a
                  key={`${s.source}:${s.url}:${s.ts}`}
                  href={external ? s.url : undefined}
                  target="_blank" rel="noreferrer"
                  className={`flex items-center gap-2.5 py-2 px-2 -mx-2 rounded-lg text-[13px]
                    ${external ? 'hover:bg-ink-800 cursor-pointer' : 'cursor-default'}`}
                >
                  <SourceDot source={s.source} />
                  <span className="text-fg-dim shrink-0">{SOURCE_LABEL[s.source]}</span>
                  <span className="text-fg-mute truncate grow">
                    {s.meta?.channel ?? s.account ?? s.meta?.repo ?? s.meta?.project ?? s.kind}
                  </span>
                  <span className="text-fg-mute tnum text-[12px] shrink-0">{ago(s.ts)}</span>
                  {external && <ArrowUpRight size={13} className="text-fg-mute shrink-0" />}
                </a>
              )
            })}
          </div>
        </div>

        {resumeCmd && (
          <div className="mt-4">
            <SectionLabel>Resume this session</SectionLabel>
            <button
              onClick={() => { void navigator.clipboard?.writeText(resumeCmd); setCopied(true) }}
              className="w-full flex items-center gap-2 bg-ink-800 rounded-[10px] px-3 py-2.5
                         text-left hover:bg-ink-700 transition-colors"
            >
              <code className="text-[12.5px] font-mono text-fg-dim truncate grow">{resumeCmd}</code>
              {copied ? <Check size={13} className="text-ok shrink-0" />
                      : <Copy size={13} className="text-fg-mute shrink-0" />}
            </button>
          </div>
        )}

        {hasSlack && (
          <div className="mt-4">
            {!thread && (
              <Button variant="solid" onClick={loadThread} disabled={loadingThread} className="w-full">
                <MessageSquare size={14} />
                {loadingThread ? 'Loading thread…' : 'Read the thread'}
              </Button>
            )}
            {thread?.error && <p className="text-[12.5px] text-bad mt-2">{thread.error}</p>}
            {thread?.thread?.messages?.length > 0 && (
              <div className="mt-3 space-y-3 max-h-64 overflow-y-auto">
                {thread.thread.messages.map((m: any, i: number) => (
                  <div key={i} className="text-[13px]">
                    <div className="text-fg-mute text-[11.5px] mb-0.5">
                      {m.fromName} · {timeOfDay(m.epochMs)}
                    </div>
                    <div className="text-fg-dim leading-relaxed whitespace-pre-wrap">{m.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-5">
          <SectionLabel>Move to</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="solid" onClick={() => run(() => actions.move(card.group_key, 'now'))}>
              <Inbox size={14} /> Now
            </Button>
            <Button variant="solid" onClick={() => run(() => actions.move(card.group_key, 'open'))}>
              <SquareCheck size={14} /> Open
            </Button>
            {card.state?.pile_override && (
              <Button variant="ghost" onClick={() => run(() => actions.move(card.group_key, null))}>
                Let Wake decide
              </Button>
            )}
          </div>
        </div>

        <div className="mt-5">
          <SectionLabel>Snooze until</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {SNOOZE.map(s => (
              <Button key={s.label} variant="solid"
                onClick={() => run(() => actions.snooze(card.group_key, s.at()))}>
                {s.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-1.5">
          {card.url.startsWith('http') && (
            <a href={card.url} target="_blank" rel="noreferrer"
               className="col-span-2 inline-flex items-center justify-center gap-1.5 min-h-10
                          rounded-[10px] bg-accent text-ink-950 font-medium text-[13.5px]
                          hover:brightness-110 transition">
              Open <ArrowUpRight size={15} />
            </a>
          )}
          <Button variant="solid" onClick={() => onMakeTask(card)}>
            <ListPlus size={14} /> Make a task
          </Button>
          <Button variant="solid" onClick={() => run(() => actions.doneCard(card.group_key))}>
            <Check size={14} /> Done
          </Button>
          <Button variant="ghost"
            onClick={() => run(() => actions.pin(card.group_key, !card.state?.pinned))}>
            {card.state?.pinned ? <><PinOff size={14} /> Unpin</> : <><Pin size={14} /> Pin</>}
          </Button>
          <Button variant="ghost" onClick={() => run(() => actions.notMine(card.group_key))}>
            <UserMinus size={14} /> Not mine
          </Button>
        </div>

        {card.state?.snoozed_until && (
          <p className="mt-4 text-[12.5px] text-fg-mute flex items-center gap-1.5">
            <Clock size={12} /> Parked until {new Date(card.state.snoozed_until).toLocaleString()}
            <button className="underline hover:text-fg-dim ml-1"
              onClick={() => run(() => actions.restore(card.group_key))}>bring back</button>
          </p>
        )}
      </div>
    </Sheet>
  )
}

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[11px] uppercase tracking-[0.08em] text-fg-mute mb-2">{children}</div>
)
