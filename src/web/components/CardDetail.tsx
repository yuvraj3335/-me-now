/**
 * The detail: a glance, not a document.
 *
 * What it renders, top to bottom, and nothing else: the title, one line of
 * `why · who · when`, ONE fact table of at most four rows, the excerpt clipped
 * to three lines with an expand, one mono line to resume, one line of where it
 * was seen, and one row of actions.
 *
 * What it replaced, measured on the live page: a five-row PULL REQUEST table
 * *and* a three-row SESSION table — one `Block` per source, so the dedup
 * engine's success was what made the pane worst — with `Why` printed twice, a
 * bordered filled box around the resume command, and under it a 224px scrolling
 * `<pre>` holding 1,776 characters of Wake's own handoff pack — its instruction
 * heading and its own timestamped footer included. Wake was printing its own
 * paperwork back to itself in a 400px pane. The transcript block is gone; the
 * cut happens on the server's read path now, where the card's excerpt is built.
 *
 * `Open` is not amber. The file's own docblock used to claim it had fixed that,
 * 175 lines above the hand-rolled `bg-accent` anchor that had not.
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
 * `Parked until …` and `Wake now` instead.
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
  const [expanded, setExpanded] = useState(false)

  useEffect(() => { setMore(false); setCopied(false); setExpanded(false) }, [card.group_key])

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
  const claude = card.sources.find(s => s.source === 'claude')
  const resume = claude?.meta?.resume_cmd as string | undefined

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="pad-x pt-4 pb-3 shrink-0">
        {/* Everything in this pane starts on one x. The glyph used to sit in a
            slot ahead of the title, which put the title and its own why-line on
            two verticals 7px apart — and there were seven left edges inside this
            400px pane. The glyph moves onto the metadata line, where it is one
            more fact rather than an indent. */}
        <div className="flex items-start gap-2">
          <h2 className="grow text-md font-medium tracking-[-0.01em] line-clamp-3">{card.title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} title="Close" ariaLabel="Close">
            <X size={14} />
          </Button>
        </div>
        {/* One line, and `why` appears on it exactly once. It used to be here and
            again as the last row of the fact table below. */}
        <p className="mt-2 flex items-center gap-2 text-sm text-fg-dim">
          <KindGlyph kind={kind} size={14} />
          <span className="truncate">{[card.why, card.who, ago(card.ts)].filter(Boolean).join(' · ')}</span>
        </p>
      </div>

      <div className="grow min-h-0 overflow-y-auto pad-x pb-4">
        <Facts card={card} />

        {card.excerpt && (
          <div className="mt-6">
            <p className={`text-sm text-fg-dim whitespace-pre-wrap ${expanded ? '' : 'line-clamp-3'}`}>
              {card.excerpt}
            </p>
            {/* Three lines, then a way to see the rest. `line-clamp-6` with no
                expand made a silent clip read as the whole thing. */}
            {card.excerpt.length > 160 && (
              <button onClick={() => setExpanded(v => !v)}
                className="mt-1 text-sm text-fg-mute hover:text-fg-dim transition-colors duration-100">
                {expanded ? 'Less' : 'More'}
              </button>
            )}
          </div>
        )}

        {/* One mono line and a copy glyph. It was a filled, bordered 32px box —
            `bg-ink-850`, which is pure white on a light page. */}
        {resume && (
          <button
            onClick={() => { void navigator.clipboard?.writeText(resume); setCopied(true) }}
            className="mt-6 w-full flex items-center gap-2 h-11 text-left border-b border-rule
                       text-fg-mute hover:text-fg-dim transition-colors duration-100"
          >
            <code className="text-sm font-mono truncate grow">{resume}</code>
            {copied ? <Check size={14} className="text-ok shrink-0" />
                    : <Copy size={14} className="shrink-0" />}
          </button>
        )}

        <SeenIn card={card} />

        {parked && <ParkedNote card={card} run={run} />}

        {/*
          `⋯` reveals its content next to itself.
          It used to append to the bottom of the scrolling body while its trigger
          sat in the pinned action bar, so on a card with a transcript the reader
          pressed it and four controls appeared ~1400px below the viewport.
          Nothing appeared to happen — and every deferral control in the product
          is behind that button.
        */}
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
              classification forever.
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
                <Button size="sm" variant="ghost"
                  onClick={() => void run(() => actions.pin(card.group_key, !card.state?.pinned))}>
                  {card.state?.pinned ? <><PinOff size={14} /> Unpin</> : <><Pin size={14} /> Pin</>}
                </Button>
                <Button size="sm" variant="ghost"
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

      {/*
        The action bar. Every control is ghost text of the same weight, because
        they are the same kind of decision — and because `Open`, the least
        consequential of them, was the one amber slab on the panel. It wraps, so
        370px of `whitespace-nowrap` cannot overflow a 360px pane.
      */}
      <div className="shrink-0 border-t border-rule pad-x py-2 flex items-center gap-1 flex-wrap">
        {external && (
          <Button size="sm" variant="ghost"
            onClick={() => window.open(card.url, '_blank', 'noopener,noreferrer')}>
            Open <ArrowUpRight size={14} />
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => {
          onClose()
          openLaunch(cardContext(card), {
            templates: templatesFor(card),
            repoHint: repoHintFor(card),
            title: cardTitle(card),
          })
        }}>
          <Terminal size={14} /> Claude
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onMakeTask(card)}>
          <ListPlus size={14} /> Task
        </Button>
        <Button size="sm" variant="ghost"
          onClick={() => void runUndoable(() => actions.doneCard(card.group_key), 'Marked done.', 'done')}>
          <Check size={14} /> Done
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto"
          title="More actions" ariaLabel="More actions"
          onClick={() => setMore(o => !o)}>
          <MoreHorizontal size={14} />
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

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-sm">{children}</span>
)

/**
 * One table, at most four rows, merged across sources.
 *
 * It used to render one `Block` and one `FactTable` per source, so a card seen
 * in GitHub and Claude Code got a five-row table and a three-row table — eight
 * rows and two headings for a glance — and the more successfully the dedup
 * engine merged, the worse the pane got. The facts are a union now, in one
 * order, capped: the four a person acts on.
 *
 * `Why` is not among them. It is the second line of the header, and printing it
 * again here was the same sentence twice in 200 pixels.
 */
function Facts({ card }: { card: Card }) {
  const by = (s: string) => card.sources.find(x => x.source === s)
  const gh = by('github')
  const claude = by('claude')
  const sentry = by('sentry')
  const gmail = by('gmail')
  const slack = by('slack')

  const rows: Array<[string, React.ReactNode]> = []
  const add = (k: string, v: React.ReactNode) => {
    if (v === null || v === undefined || v === '' || rows.length >= 4) return
    rows.push([k, v])
  }

  if (gh) {
    add('Repository', gh.meta?.repo ? <Mono>{gh.meta.repo}</Mono> : null)
    add('Number', gh.meta?.number ? <Mono>#{gh.meta.number}</Mono> : null)
    add('State', gh.meta?.is_pr ? (gh.meta?.draft ? 'draft' : 'ready for review') : 'open')
  }
  if (slack) {
    add('Channel', <Mono>{whereOf(slack, card)}</Mono>)
    add('From', slack.who ?? slack.actor)
  }
  if (sentry) {
    add('Project', sentry.meta?.project ? <Mono>{sentry.meta.project}</Mono> : null)
    add('Level', sentry.meta?.level)
    add('Events', typeof sentry.meta?.events === 'number' ? String(sentry.meta.events) : null)
  }
  if (gmail) {
    add('Account', <Mono>{gmail.account ?? gmail.meta?.account}</Mono>)
    add('To you', gmail.meta?.direct ? 'yes' : 'on a list')
  }
  if (claude) {
    add('Project', claude.meta?.project ? <Mono>{claude.meta.project}</Mono> : null)
    add('Directory', claude.meta?.cwd ? <Mono>{claude.meta.cwd}</Mono> : null)
    add('Exchanges', typeof claude.meta?.turns === 'number' ? String(claude.meta.turns) : null)
  }

  if (!rows.length) return null

  return (
    <table className="w-full table-fixed mt-4">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="h-11 align-middle border-b border-rule">
            <td className="w-24 text-sm text-fg-mute pr-4">{k}</td>
            <td className="text-sm text-fg-dim truncate">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Where this was seen: one line of dots and names. */
function SeenIn({ card }: { card: Card }) {
  // The same source, same context and same day rendered twice — a Claude Code
  // session that produced two transcript files is one place, seen once.
  const seen = new Map<string, typeof card.sources[number]>()
  for (const s of card.sources) {
    const key = `${s.source}|${s.meta?.channel ?? s.account ?? s.meta?.repo ?? s.meta?.project ?? s.kind}`
    if (!seen.has(key)) seen.set(key, s)
  }
  const rows = [...seen.values()]
  if (!rows.length) return null

  return (
    <div className="mt-6 flex items-center gap-3 h-11 text-sm text-fg-mute flex-wrap">
      {rows.map(s => {
        const where = s.meta?.channel ?? s.account ?? s.meta?.repo ?? s.meta?.project ?? s.kind
        const external = s.url.startsWith('http')
        const body = (
          <>
            <SourceDot source={s.source} />
            <span className="text-fg-dim">{SOURCE_LABEL[s.source]}</span>
            <span className="font-mono truncate max-w-40">{where}</span>
            <span className="tnum">{ago(s.ts)}</span>
          </>
        )
        return external ? (
          <a key={`${s.source}:${s.url}`} href={s.url} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-2 hover:text-fg-dim transition-colors duration-100">
            {body}
          </a>
        ) : (
          <span key={`${s.source}:${s.url}`} className="inline-flex items-center gap-2">{body}</span>
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
        {until ? `Until ${wallClock(until)}` : 'Indefinitely'}
      </p>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="ghost" onClick={() => void run(() => actions.move(card.group_key, null))}>
          <Sunrise size={14} /> Wake now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setChanging(o => !o)}>
          Change <ChevronDown size={14} />
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

/** Kept for the one caller that still asks for a wall clock in this file. */
export const detailTime = timeOfDay
