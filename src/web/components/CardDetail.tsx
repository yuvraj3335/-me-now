/**
 * The detail: a column of the shell, not a floating card.
 *
 * What this replaces: a pane where 68% of 754px was a button band — fifteen
 * controls, twelve of them the identical 36px lozenge — while the pane itself
 * showed almost no facts, and the one amber slab was spent on `Open`, the least
 * consequential action on the panel.
 *
 * A detail pane is for facts. So: a header, the excerpt, a per-kind fact table,
 * where it was seen, and one bottom-pinned action bar with at most five visible
 * controls. Everything else is behind `⋯`.
 */

import { useEffect, useState } from 'react'
import {
  ArrowUpRight, Check, ChevronDown, Copy, ListPlus, MoreHorizontal, Pin, PinOff,
  Sunrise, Terminal, UserMinus, X,
} from 'lucide-react'
import type { Card, Pile } from '../lib/types'
import { actions, reload } from '../lib/api'
import { ago, atHour, timeOfDay, wallClock } from '../lib/time'
import { SOURCE_LABEL, SourceDot } from './sources'
import { Button, Segmented } from './primitives'
import { cardKind, KindGlyph, whereOf } from './kinds'
import { openLaunch } from '../lib/launch'
import { cardContext, cardTitle, repoHintFor, templatesFor } from '../lib/cardContext'
import { toast } from '../lib/toast'

/**
 * Deferral, as one control rather than four lozenges.
 *
 * These are *arrival* times — when should this come back — so they are offered
 * only to a card that has not already been set aside. A Parked card gets
 * `Parked until …` and `Wake now` instead: the one control labelled "Later",
 * pressed on a card parked indefinitely, replaced "nothing is going to bring
 * this back" with "tomorrow at nine" and toasted `Back tomorrow morning.` as if
 * that were a deferral.
 */
const SNOOZE = [
  { id: 'today', label: 'Later today', at: () => Date.now() + 4 * 3.6e6 },
  { id: 'tonight', label: 'Tonight', at: () => atHour(0, 20) },
  { id: 'tomorrow', label: 'Tomorrow', at: () => atHour(1, 9) },
  { id: 'week', label: 'Next week', at: () => atHour(7, 9) },
] as const

const PILES: Array<{ id: Pile; label: string }> = [
  { id: 'now', label: 'Now' },
  { id: 'open', label: 'Open' },
  { id: 'parked', label: 'Parked' },
]

export function CardDetail({
  card, onClose, onMakeTask,
}: { card: Card; onClose: () => void; onMakeTask: (c: Card) => void }) {
  const [more, setMore] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => { setMore(false); setCopied(false) }, [card.group_key])

  const run = async (fn: () => Promise<unknown>) => { await fn(); await reload(); onClose() }

  const runUndoable = async (
    fn: () => Promise<unknown>, text: string, undo: 'done' | 'not_mine' | 'snoozed' | 'moved',
  ) => {
    await run(fn)
    toast(text, {
      label: 'Undo',
      run: async () => { await actions.restore(card.group_key, undo); await reload() },
    })
  }

  const kind = cardKind(card)
  const parked = card.pile === 'parked'
  const external = card.url.startsWith('http')

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 shrink-0">
        <div className="flex items-start gap-2">
          <span className="pt-1"><KindGlyph kind={kind} size={14} /></span>
          <h2 className="grow text-md font-medium tracking-[-0.01em] line-clamp-3">{card.title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} title="Close" ariaLabel="Close">
            <X size={14} />
          </Button>
        </div>
        <p className="mt-1.5 ml-6 text-sm text-fg-dim">
          {[card.why, card.who, `${ago(card.ts)} ago`].filter(Boolean).join(' · ')}
        </p>
      </div>

      <div className="grow min-h-0 overflow-y-auto px-4 pb-4">
        {card.excerpt && (
          <p className="text-sm text-fg-dim whitespace-pre-wrap border-l-2 border-rule pl-3
                        line-clamp-6">
            {card.excerpt}
          </p>
        )}

        <Facts card={card} copied={copied} setCopied={setCopied} />

        <SeenIn card={card} />

        {parked && <ParkedNote card={card} run={run} />}

        {more && (
          <div className="mt-6 space-y-4">
            {!parked && (
              <Block label="Later">
                <Segmented
                  options={SNOOZE.map(s => ({ id: s.id, label: s.label }))}
                  onChange={id => {
                    const s = SNOOZE.find(x => x.id === id)!
                    void runUndoable(
                      () => actions.snooze(card.group_key, s.at()),
                      `Back ${s.label.toLowerCase()}.`,
                      'snoozed',
                    )
                  }}
                  ariaLabel="Come back"
                />
              </Block>
            )}

            {/*
              Only the piles it is not in. Offering "Move to Open" on an Open
              card was not a no-op: it silently wrote `pile_override:'open'` and
              nulled the snooze, freezing the card against Wake's own
              classification forever. And Parked is here at all because the
              server has always accepted it while the UI never offered it — the
              one pile with a section, a heading and a count, and no control.
            */}
            <Block label="Move to">
              <div className="flex items-center gap-2 flex-wrap">
                <Segmented
                  options={PILES.filter(p => p.id !== card.pile)}
                  onChange={id => void runUndoable(
                    () => actions.move(card.group_key, id),
                    `Moved to ${PILES.find(p => p.id === id)!.label}.`,
                    'moved',
                  )}
                  ariaLabel="Move to"
                />
                {card.state?.pile_override && (
                  <Button size="sm" variant="ghost"
                    onClick={() => void runUndoable(
                      () => actions.move(card.group_key, null), 'Back to what Wake decides.', 'moved',
                    )}>
                    Let Wake decide
                  </Button>
                )}
              </div>
            </Block>

            <Block label="This card">
              <div className="flex items-center gap-2 flex-wrap">
                <Button size="sm" variant="default"
                  onClick={() => void run(() => actions.pin(card.group_key, !card.state?.pinned))}>
                  {card.state?.pinned ? <><PinOff size={14} /> Unpin</> : <><Pin size={14} /> Pin</>}
                </Button>
                <Button size="sm" variant="default"
                  onClick={() => void runUndoable(
                    () => actions.notMine(card.group_key), 'Taken off your list.', 'not_mine',
                  )}>
                  <UserMinus size={14} /> Not mine
                </Button>
              </div>
            </Block>
          </div>
        )}
      </div>

      {/* The action bar: one 48px row, pinned to the bottom, five controls. */}
      <div className="shrink-0 border-t border-rule px-3 h-12 flex items-center gap-2">
        {external && (
          <a href={card.url} target="_blank" rel="noreferrer"
             className="relative inline-flex items-center justify-center gap-1.5 h-8 px-3
                        rounded-control text-sm font-medium bg-accent text-on-accent
                        hover:brightness-110 transition-colors duration-100">
            Open <ArrowUpRight size={14} />
          </a>
        )}
        <Button size="md" variant="default" onClick={() => {
          onClose()
          openLaunch(cardContext(card), {
            templates: templatesFor(card),
            repoHint: repoHintFor(card),
            title: cardTitle(card),
          })
        }}>
          <Terminal size={14} /> Claude
        </Button>
        <Button size="md" variant="default" onClick={() => onMakeTask(card)}>
          <ListPlus size={14} /> Task
        </Button>
        <Button size="md" variant="default"
          onClick={() => void runUndoable(() => actions.doneCard(card.group_key), 'Marked done.', 'done')}>
          <Check size={14} /> Done
        </Button>
        <Button size="md" variant="ghost" className="ml-auto"
          title="More actions" ariaLabel="More actions"
          onClick={() => setMore(o => !o)}>
          <MoreHorizontal size={15} />
        </Button>
      </div>
    </div>
  )
}

/* --------------------------------- facts ---------------------------------- */

const Block = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div className="text-eyebrow uppercase text-fg-mute mb-2">{label}</div>
    {children}
  </div>
)

/** A label/value table: 28px a row, the label in a fixed 96px column. */
function FactTable({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  const live = rows.filter(([, v]) => v !== null && v !== undefined && v !== '')
  if (!live.length) return null
  return (
    <table className="w-full table-fixed">
      <tbody>
        {live.map(([k, v]) => (
          <tr key={k} className="h-7 align-top">
            <td className="w-24 text-sm text-fg-mute pr-2">{k}</td>
            <td className="text-sm text-fg-dim break-words">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-sm">{children}</span>
)

/**
 * The facts, per kind. This is what a detail pane is for, and it is what was
 * missing: a PR knows its repo, number, draft state and comment count; a session
 * knows its project, working directory, turn count and resume command; a Sentry
 * issue knows its level, event count and culprit. All of it was on the card
 * already and none of it was rendered.
 */
function Facts({
  card, copied, setCopied,
}: { card: Card; copied: boolean; setCopied: (v: boolean) => void }) {
  const bySource = (s: string) => card.sources.find(x => x.source === s)
  const gh = bySource('github')
  const claude = bySource('claude')
  const sentry = bySource('sentry')
  const gmail = bySource('gmail')
  const slack = bySource('slack')

  const resume = claude?.meta?.resume_cmd as string | undefined

  return (
    <div className="mt-5 space-y-5">
      {gh && (
        <Block label={gh.meta?.is_pr ? 'Pull request' : 'Issue'}>
          <FactTable rows={[
            ['Repository', <Mono key="r">{gh.meta?.repo}</Mono>],
            ['Number', gh.meta?.number ? <Mono key="n">#{gh.meta.number}</Mono> : null],
            ['State', gh.meta?.is_pr ? (gh.meta?.draft ? 'draft' : 'ready for review') : 'open'],
            ['Comments', typeof gh.meta?.comments === 'number' ? String(gh.meta.comments) : null],
            ['Why', gh.why],
          ]} />
        </Block>
      )}

      {claude && (
        <Block label="Session">
          <FactTable rows={[
            ['Project', <Mono key="p">{claude.meta?.project}</Mono>],
            ['Directory', <Mono key="c">{claude.meta?.cwd}</Mono>],
            ['Exchanges', typeof claude.meta?.turns === 'number' ? String(claude.meta.turns) : null],
          ]} />
          {resume && (
            <button
              onClick={() => { void navigator.clipboard?.writeText(resume); setCopied(true) }}
              className="mt-2 w-full flex items-center gap-2 bg-ink-850 border border-edge
                         rounded-control px-3 h-8 text-left hover:bg-ink-800 transition-colors duration-100"
            >
              <code className="text-xs font-mono text-fg-dim truncate grow">{resume}</code>
              {copied ? <Check size={13} className="text-ok shrink-0" />
                      : <Copy size={13} className="text-fg-mute shrink-0" />}
            </button>
          )}
          <SessionExcerpt group={card.group_key} />
        </Block>
      )}

      {sentry && (
        <Block label="Alert">
          <FactTable rows={[
            ['Project', <Mono key="p">{sentry.meta?.project}</Mono>],
            ['Level', sentry.meta?.level],
            ['Events', typeof sentry.meta?.events === 'number' ? String(sentry.meta.events) : null],
            ['Users', typeof sentry.meta?.users === 'number' ? String(sentry.meta.users) : null],
            ['Culprit', card.excerpt],
          ]} />
        </Block>
      )}

      {gmail && (
        <Block label="Mail">
          <FactTable rows={[
            ['Account', <Mono key="a">{gmail.account ?? gmail.meta?.account}</Mono>],
            ['To you', gmail.meta?.direct ? 'yes' : 'on a list'],
            ['Subject', gmail.title],
          ]} />
        </Block>
      )}

      {slack && <SlackThread card={card} />}
    </div>
  )
}

/**
 * A Claude session's last exchanges.
 *
 * `sessionExcerpt` already read them and was exported with zero callers and no
 * route. This is one fetch and no new ingest.
 */
function SessionExcerpt({ group }: { group: string }) {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setText(null)
    setErr(null)
    actions.session(group)
      .then(r => { if (live) setText(r.session.text) })
      .catch(e => { if (live) setErr((e as Error).message) })
    return () => { live = false }
  }, [group])

  if (err) return <p className="mt-2 text-sm text-fg-mute">{err}</p>
  if (!text) return null
  return (
    <pre className="mt-2 text-sm text-fg-dim whitespace-pre-wrap font-sans
                    border-l-2 border-rule pl-3 max-h-56 overflow-y-auto">{text}</pre>
  )
}

/**
 * The Slack messages, loaded when the detail opens rather than behind a button.
 * "Read the thread" was a click that asked whether he wanted the thing he had
 * just opened the thread to read.
 */
function SlackThread({ card }: { card: Card }) {
  const [thread, setThread] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setThread(null)
    setErr(null)
    actions.thread(card.group_key)
      .then(r => { if (live) setThread(r.thread) })
      .catch(e => { if (live) setErr((e as Error).message) })
    return () => { live = false }
  }, [card.group_key])

  const slack = card.sources.find(s => s.source === 'slack')
  return (
    <Block label="Thread">
      <FactTable rows={[
        ['Channel', <Mono key="c">{whereOf(slack, card)}</Mono>],
        ['Messages', thread?.messages?.length ? String(thread.messages.length) : null],
      ]} />
      {err && <p className="mt-2 text-sm text-fg-mute">{err}</p>}
      {thread?.messages?.length > 0 && (
        <div className="mt-2 space-y-3 max-h-64 overflow-y-auto">
          {thread.messages.map((m: any, i: number) => (
            <div key={i}>
              <div className="text-xs text-fg-mute">{m.fromName} · {timeOfDay(m.epochMs)}</div>
              <div className="text-sm text-fg-dim whitespace-pre-wrap">{m.text}</div>
            </div>
          ))}
        </div>
      )}
    </Block>
  )
}

/** Where this was seen. The best thing in the old pane; kept, with duplicates collapsed. */
function SeenIn({ card }: { card: Card }) {
  // The same source, same context and same day rendered twice — a Claude Code
  // session that produced two transcript files is one place, seen once.
  const seen = new Map<string, typeof card.sources[number]>()
  for (const s of card.sources) {
    const key = `${s.source}|${s.meta?.channel ?? s.account ?? s.meta?.repo ?? s.meta?.project ?? s.kind}|${ago(s.ts)}`
    if (!seen.has(key)) seen.set(key, s)
  }
  const rows = [...seen.values()]

  return (
    <div className="mt-6">
      <div className="text-eyebrow uppercase text-fg-mute mb-1">
        {rows.length > 1 ? `Seen in ${rows.length} places` : 'Source'}
      </div>
      {rows.map(s => {
        const external = s.url.startsWith('http')
        return (
          <a
            key={`${s.source}:${s.url}:${s.ts}`}
            href={external ? s.url : undefined}
            target="_blank" rel="noreferrer"
            className={`flex items-center gap-2 h-8 text-sm border-b border-rule last:border-0
              ${external ? 'hover:bg-ink-800 cursor-pointer' : 'cursor-default'}`}
          >
            <SourceDot source={s.source} />
            <span className="text-fg-dim shrink-0">{SOURCE_LABEL[s.source]}</span>
            <span className="text-fg-mute truncate grow font-mono">
              {s.meta?.channel ?? s.account ?? s.meta?.repo ?? s.meta?.project ?? s.kind}
            </span>
            <span className="text-fg-mute tnum shrink-0">{ago(s.ts)}</span>
            {external && <ArrowUpRight size={13} className="text-fg-mute shrink-0" />}
          </a>
        )
      })}
    </div>
  )
}

/**
 * A parked card says when it comes back and offers the two things that can
 * change that. It is never offered the arrival presets: it has already arrived
 * somewhere, and "Later" on it means sooner.
 */
function ParkedNote({
  card, run,
}: { card: Card; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const until = card.state?.snoozed_until
  const [changing, setChanging] = useState(false)

  return (
    <div className="mt-6">
      <div className="text-eyebrow uppercase text-fg-mute mb-2">Parked</div>
      <p className="text-sm text-fg-dim">
        {until ? `Until ${wallClock(until)}` : 'Indefinitely — nothing will bring it back on its own'}
      </p>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="default" onClick={() => void run(() => actions.move(card.group_key, null))}>
          <Sunrise size={14} /> Wake now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setChanging(o => !o)}>
          Change <ChevronDown size={13} />
        </Button>
      </div>
      {changing && (
        <div className="mt-2">
          <Segmented
            options={SNOOZE.map(s => ({ id: s.id, label: s.label }))}
            onChange={id => {
              const s = SNOOZE.find(x => x.id === id)!
              void run(() => actions.snooze(card.group_key, s.at()))
            }}
            ariaLabel="Come back"
          />
        </div>
      )}
    </div>
  )
}

/** The frame with nothing selected. One line, top left. Never a centred box. */
export function EmptyDetail() {
  return <p className="px-4 pt-4 text-sm text-fg-mute">No selection</p>
}
