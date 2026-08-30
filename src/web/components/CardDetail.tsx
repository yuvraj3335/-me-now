/**
 * The detail: a glance, not a document.
 *
 * What it renders, top to bottom, and nothing else: the title, one line of
 * `why · who · when`, ONE fact table of at most four rows, the conversation
 * itself, one mono line to resume, one line of where it was seen, and one block
 * of controls above one row of actions.
 *
 * What it replaced, measured on the live page: a five-row PULL REQUEST table
 * *and* a three-row SESSION table — one `Block` per source, so the dedup
 * engine's success was what made the pane worst — with `Why` printed twice, a
 * bordered filled box around the resume command, and under it a 224px scrolling
 * `<pre>` holding 1,776 characters of Wake's own handoff pack. Wake was printing
 * its own paperwork back to itself in a 400px pane.
 *
 * Four things are new here, and each one was a thing the pane claimed to do and
 * did not:
 *
 * **The cross closes it.** `closeDetail()` only ever cleared the fragment, and
 * the laptop pane falls back to showing the top row — so pressing X changed
 * nothing visible and read as a dead control. The dismissal is a fact the page
 * holds now (`Home.tsx`), and this only reports the press.
 *
 * **Opening a row acknowledges it.** The `+N` and the amber edge are answers to
 * "what have I not seen", so reading a row has to be what makes them go away.
 * The subtlety, and it is the whole of it: the pane's *resting* state — the top
 * row it shows before anything has been clicked — must not acknowledge
 * anything, or the feature silently destroys itself every morning at 7am.
 *
 * **The conversation is here.** The card carries the parent and the newest
 * twenty replies, and this drew none of them: a thread's row said "you were
 * mentioned in #truto" and then showed a 400-character excerpt of the same
 * text. Parent first, replies oldest to newest, three lines each — a Cursor
 * root-cause essay is 1,400 characters and does not get to own a 400px pane.
 *
 * **The `⋯` is gone.** Everything behind it — deferral, the group, the pin —
 * has a real home on the surface, and the status control sits with them. That
 * button was also broken in a way worth remembering: it appended its contents to
 * the bottom of the scrolling body while its trigger sat in the pinned action
 * bar, so on a long card the reader pressed it and four controls appeared about
 * 1400px below the viewport.
 *
 * `Open` is not amber. The file's own docblock used to claim it had fixed that,
 * 175 lines above the hand-rolled `bg-accent` anchor that had not.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight, Check, ChevronDown, Copy, ListPlus, Pin, PinOff, Sunrise, Terminal, X,
} from 'lucide-react'
import { STATUS_LABEL, STATUS_ORDER } from '../../shared/status'
import type { Card, Pile } from '../lib/types'
import { PILE_LABEL } from '../lib/types'
import { actions, reload } from '../lib/api'
import { ago, atHour, wallClock } from '../lib/time'
import { baselineOf, replyTotal, threadLines, type ThreadLine } from '../lib/thread'
import { SOURCE_LABEL, SourceDot } from './sources'
import { Button, Chip, controlClass } from './primitives'
import { cardKind, KindGlyph } from './kinds'
import { openLaunch } from '../lib/launch'
import { cardContext, cardTitle, repoHintFor, templatesFor } from '../lib/cardContext'
import { toast } from '../lib/toast'

/**
 * Deferral, as four arrival times.
 *
 * These say when something should come *back*, so they are offered only to a
 * card that has not already been set aside. A snoozed card gets the time it is
 * due and the two things that can change it instead.
 */
const SNOOZE = [
  { id: 'afternoon', label: 'This afternoon', at: () => Date.now() + 4 * 3.6e6 },
  { id: 'tonight', label: 'Tonight', at: () => atHour(0, 20) },
  { id: 'tomorrow', label: 'Tomorrow', at: () => atHour(1, 9) },
  { id: 'week', label: 'Next week', at: () => atHour(7, 9) },
] as const

const PILES: Array<{ id: Pile; label: string }> =
  (['now', 'open', 'parked'] as Pile[]).map(id => ({ id, label: PILE_LABEL[id] }))

/** A Slack channel, without the `#` the poller stores it with. */
const bareChannel = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.replace(/^#+/, '') : ''
  return s || null
}

export function CardDetail({
  card, onClose, onMakeTask, resting,
}: {
  card: Card
  onClose: () => void
  onMakeTask: (c: Card) => void
  /**
   * True when this is the pane's resting state — the top row, shown because
   * something has to be, not because anybody asked for it. A resting pane reads
   * nothing and acknowledges nothing.
   */
  resting?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [changing, setChanging] = useState(false)

  useEffect(() => { setCopied(false); setExpanded(false); setChanging(false) }, [card.group_key])

  /**
   * The baseline this card was opened at, held still while it is open.
   *
   * The ack below moves `acked_at` to now and reloads, and `baselineOf` reads
   * exactly that — so within one round trip every line the thread had just
   * marked as new was older than the baseline again and went back to the muted
   * ink. The `+3` on the row and the three brighter lines in here are supposed
   * to be the same three messages; without freezing this, the second half of
   * that sentence was true for about twenty milliseconds. Captured during render
   * rather than in an effect, because the first paint is the one that has to be
   * right, and re-derived only when the pane changes card.
   */
  const opened = useRef({ key: card.group_key, baseline: baselineOf(card) })
  if (opened.current.key !== card.group_key) {
    opened.current = { key: card.group_key, baseline: baselineOf(card) }
  }

  /**
   * Reading a row is what clears its count.
   *
   * Only for a card somebody actually opened, and only when there is something
   * to clear — a POST per row per render is not free, and an `acked_at` moved
   * forward by merely rendering the desk is the same bug as acknowledging the
   * resting pane, arriving by a different route.
   */
  useEffect(() => {
    if (resting) return
    if (card.activity.count <= 0) return
    let live = true
    void actions.ack(card.group_key).then(() => { if (live) void reload() })
    return () => { live = false }
  }, [card.group_key, resting, card.activity.count])

  const run = async (fn: () => Promise<unknown>, close = true) => {
    await fn()
    await reload()
    if (close) onClose()
  }

  const runUndoable = async (
    fn: () => Promise<unknown>,
    text: string,
    undo: 'done' | 'not_mine' | 'snoozed' | 'moved' | 'status',
    close = true,
  ) => {
    await run(fn, close)
    toast(text, {
      label: 'Undo',
      run: async () => { await actions.restore(card.group_key, undo); await reload() },
    })
  }

  const kind = cardKind(card)
  const snoozed = card.pile === 'parked'
  const claude = card.sources.find(s => s.source === 'claude')
  const resume = claude?.meta?.resume_cmd as string | undefined
  const lines = useMemo(() => threadLines(card), [card])

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
          <span className="truncate">
            {[whyLine(card), card.who, ago(card.ts)].filter(Boolean).join(' · ')}
          </span>
        </p>
      </div>

      <div className="grow min-h-0 overflow-y-auto pad-x pb-4">
        <Facts card={card} />

        <Thread card={card} lines={lines} baseline={opened.current.baseline} />

        {/*
          The excerpt is what a card shows when there is no conversation to show.
          Where there is one it is the same text a second time: a Slack card's
          excerpt is built from the thread it belongs to, and a Gmail card's is
          the newest message's own snippet.
        */}
        {!lines.length && card.excerpt && (
          <div className="mt-6">
            <p className={`text-sm text-fg-dim whitespace-pre-wrap ${expanded ? '' : 'line-clamp-3'}`}>
              {card.excerpt}
            </p>
            {/* Three lines, then a way to see the rest. `line-clamp-6` with no
                expand made a silent clip read as the whole thing. */}
            {card.excerpt.length > 160 && (
              <button onClick={() => setExpanded(v => !v)}
                className="mt-1 text-sm text-fg-mute hover:text-fg-dim transition-colors duration-100">
                {expanded ? 'Show less' : 'Show all'}
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

        {/*
          One block, on the surface, above the action bar. This is where the
          `⋯` went: the same four decisions, wrapped rather than hidden, so
          pressing one does not scroll something into existence 1400px away.
        */}
        <div className="mt-6 space-y-4">
          <Block label="Status">
            <div className="flex items-center gap-1 flex-wrap">
              {STATUS_ORDER.map(s => (
                <Chip
                  key={s}
                  active={card.status === s}
                  onClick={() => {
                    if (card.status === s) return
                    void runUndoable(
                      () => actions.setStatus(card.group_key, s),
                      `${STATUS_LABEL[s]}.`,
                      'status',
                      // Only the two that take it off the desk close the pane.
                      s === 'done' || s === 'wont_do',
                    )
                  }}
                >
                  {STATUS_LABEL[s]}
                </Chip>
              ))}
            </div>
          </Block>

          {snoozed ? (
            <Block label="Snoozed">
              <p className="text-sm text-fg-dim">
                {card.state?.snoozed_until ? `Until ${wallClock(card.state.snoozed_until)}` : 'Indefinitely'}
              </p>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <Button size="sm" variant="ghost"
                  onClick={() => void run(() => actions.move(card.group_key, null))}>
                  <Sunrise size={14} /> Bring it back
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setChanging(o => !o)}>
                  Change <ChevronDown size={14} />
                </Button>
              </div>
              {changing && <SnoozeChips card={card} run={runUndoable} />}
            </Block>
          ) : (
            <Block label="Snooze">
              <SnoozeChips card={card} run={runUndoable} />
            </Block>
          )}

          {/*
            All three, with the one it is in pressed and inert. Offering "move to
            Waiting" on a Waiting card was not a no-op: it silently wrote
            `pile_override`, nulling the snooze and freezing the card against
            Wake's own classification forever.
          */}
          <Block label="Where">
            <div className="flex items-center gap-1 flex-wrap">
              {PILES.map(p => (
                <Chip
                  key={p.id}
                  active={p.id === card.pile}
                  /* Pressed and inert, not `disabled`: a chip at 40% opacity
                     reads as unavailable, and this one is not unavailable, it
                     is where the card already is. */
                  onClick={p.id === card.pile ? undefined : () => void runUndoable(
                    () => actions.move(card.group_key, p.id), `Moved to ${p.label}.`, 'moved',
                  )}
                >
                  {p.label}
                </Chip>
              ))}
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
        </div>
      </div>

      {/*
        The action bar. Every control is ghost text of the same weight, because
        they are the same kind of decision — and because `Open`, the least
        consequential of them, was the one amber slab on the panel. It wraps, so
        370px of `whitespace-nowrap` cannot overflow a 320px pane.
      */}
      <div className="shrink-0 border-t border-rule pad-x py-2 flex items-center gap-1 flex-wrap">
        <OpenLink card={card} />
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
          title={card.state?.pinned ? 'Unpin' : 'Pin'}
          ariaLabel={card.state?.pinned ? 'Unpin' : 'Pin'}
          onClick={() => void run(() => actions.pin(card.group_key, !card.state?.pinned), false)}>
          {card.state?.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </Button>
      </div>
    </div>
  )
}

/**
 * The row's reason, with the count's word folded in.
 *
 * `activity.tagged` changes the word and never the number — the number is the
 * server's, and it is already on the row. This is where the "why did this light
 * up" question gets its sentence.
 */
function whyLine(card: Card): string {
  if (card.activity.count > 0 && card.activity.tagged) return 'you were named in a reply'
  return card.why
}

function SnoozeChips({
  card, run,
}: {
  card: Card
  run: (
    fn: () => Promise<unknown>, text: string,
    undo: 'done' | 'not_mine' | 'snoozed' | 'moved' | 'status', close?: boolean,
  ) => Promise<void>
}) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {SNOOZE.map(s => (
        <Chip key={s.id}
          onClick={() => void run(
            () => actions.snooze(card.group_key, s.at()),
            `Back ${s.label.toLowerCase()}.`,
            'snoozed',
          )}>
          {s.label}
        </Chip>
      ))}
    </div>
  )
}

/**
 * The way out to the thing itself.
 *
 * A real anchor, not a scripted `window.open`. Slack gets its own scheme so the
 * app opens on the parent message rather than the browser opening on a
 * permalink; the https permalink is still there, in `SeenIn`, which is the line
 * that says where this was seen. A custom scheme is never given `target=_blank`
 * — that opens an empty tab the handler then abandons.
 */
function OpenLink({ card }: { card: Card }) {
  const slack = card.sources.find(s => s.source === 'slack')
  const channelId = slack?.meta?.channel_id as string | undefined
  const parentTs = slack?.meta?.thread_ts as string | undefined
  const deep = channelId && parentTs
    ? `slack://channel?id=${encodeURIComponent(channelId)}&message=${encodeURIComponent(parentTs)}`
    : null
  const href = deep ?? (card.url.startsWith('http') ? card.url : null)
  if (!href) return null

  return (
    <a
      href={href}
      {...(deep ? {} : { target: '_blank', rel: 'noreferrer' })}
      className={controlClass('ghost', 'sm')}
    >
      Open <ArrowUpRight size={14} />
    </a>
  )
}

/* -------------------------------- thread ---------------------------------- */

/**
 * The conversation, parent first and then oldest to newest.
 *
 * One order, and it is the one a conversation is written in: the answer goes
 * under the question, and after a scroll the new material is where the eye
 * already is. Every body clips to three lines — the pane is 320–640px wide and
 * one Cursor root-cause post is 1,400 characters, so an unclipped list is a
 * single message and a scrollbar.
 *
 * Two marks, and no more. A reply that names him carries a 2px amber rule and
 * the word `@you`, which is the answer to "why did this row light up". A reply
 * newer than the baseline the server counted against is drawn in the brighter
 * ink, so the `+3` on the row and the three brighter lines in here are the same
 * three messages.
 */
function Thread({
  card, lines, baseline,
}: { card: Card; lines: ThreadLine[]; baseline: number }) {
  if (!lines.length) return null
  const total = replyTotal(card)
  const partial = card.sources.some(s => s.meta?.thread_partial)

  return (
    <section className="mt-6">
      <div className="flex items-baseline gap-2 mb-1">
        <h3 className="text-eyebrow uppercase text-fg-mute">Thread</h3>
        {total > 0 && <span className="text-eyebrow uppercase tnum text-fg-mute">{total}</span>}
        {/* The thread read failed for this row, so what is below it is the
            hits the search returned rather than the conversation. Said, not
            hidden: a short thread and a thread that would not load look
            identical otherwise. */}
        {partial && <span className="text-eyebrow uppercase text-fg-mute">partial</span>}
      </div>
      <ol>
        {lines.map(l => (
          <ThreadRow key={l.key} line={l} fresh={l.at !== null && l.at > baseline} />
        ))}
      </ol>
    </section>
  )
}

function ThreadRow({ line, fresh }: { line: ThreadLine; fresh: boolean }) {
  return (
    <li
      className={`py-2 border-b border-rule last:border-0
        ${line.tagged ? 'border-l-2 border-l-accent pl-3' : ''}`}
    >
      <div className="flex items-baseline gap-2 text-sm text-fg-mute">
        <span className="text-fg-dim truncate">{line.who ?? 'someone'}</span>
        {line.tagged && <span className="text-accent-ink shrink-0">@you</span>}
        <span className="ml-auto tnum shrink-0">{line.at ? ago(line.at) : ''}</span>
      </div>
      <p className={`text-sm whitespace-pre-wrap line-clamp-3 ${fresh ? 'text-fg-dim' : 'text-fg-mute'}`}>
        {line.text}
      </p>
    </li>
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

  const rows: Array<[string, React.ReactNode, boolean]> = []
  /** `wrap` is for a value that must be read whole rather than clipped. */
  const add = (k: string, v: React.ReactNode, wrap = false) => {
    if (v === null || v === undefined || v === '' || rows.length >= 4) return
    rows.push([k, v, wrap])
  }

  if (gh) {
    add('Repository', gh.meta?.repo ? <Mono>{gh.meta.repo}</Mono> : null)
    add('Number', gh.meta?.number ? <Mono>#{gh.meta.number}</Mono> : null)
    add('State', gh.meta?.is_pr ? (gh.meta?.draft ? 'draft' : 'ready for review') : 'open')
  }
  if (slack) {
    // No `#`, and not truncated: `15five-truto` cut to `15five-tru…` names a
    // channel that does not exist, and the `#` is a sigil the pane does not need
    // — every row in here is already in Slack.
    const channel = bareChannel(slack.meta?.channel ?? card.meta?.channel)
    add('Channel', channel ? <Mono>{channel}</Mono> : null, true)
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
        {rows.map(([k, v, wrap]) => (
          <tr key={k} className="h-11 align-middle border-b border-rule">
            <td className="w-24 text-sm text-fg-mute pr-4">{k}</td>
            <td className={`text-sm text-fg-dim ${wrap ? 'break-words' : 'truncate'}`}>{v}</td>
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
        const where = bareChannel(s.meta?.channel)
          ?? s.account ?? s.meta?.repo ?? s.meta?.project ?? s.kind
        const external = s.url.startsWith('http')
        const body = (
          <>
            <SourceDot source={s.source} />
            <span className="text-fg-dim">{SOURCE_LABEL[s.source]}</span>
            <span className="font-mono">{where}</span>
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
