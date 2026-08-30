/**
 * The detail: a glance, not a document — and now the only home for everything
 * the table dropped.
 *
 * Top to bottom: the title, one line of `why · who · when`, the three controls
 * that change what the card *is* (status, priority, due), the facts, the
 * excerpt, one mono line to resume, where it was seen, and one row of actions.
 *
 * Two things changed here and both were reported.
 *
 * **The overflow menu is gone.** One 32px glyph in the footer held every
 * deferral control in the product, and it appended its contents to the bottom
 * of a scrolling body while its trigger stayed pinned — so on a card with a
 * transcript you pressed it and four controls appeared about 1400px below the
 * viewport. Nothing appeared to happen. A control worth hiding in a menu was
 * worth a button; a control not worth a button was not worth shipping. Status,
 * priority and due are visible without pressing anything now, and pin is a
 * plain toggle.
 *
 * **The action bar is four solid buttons.** They used to be four ghost labels
 * of identical weight, on the theory that they were the same kind of decision —
 * which made the row read as a caption rather than as controls. They are
 * `secondary` now, with exactly one `primary` among them, so the pane still
 * spends the accent once.
 *
 * `Open` prefers the native application. See `lib/appLinks.ts` for why the
 * browser link beside it is a visible link rather than a fallback timer.
 *
 * **The conversation is here now.** A Slack card carries its parent and the
 * newest twenty replies, and a Gmail card carries its messages; this drew none
 * of them, so a thread's row said "you were mentioned" and then showed a
 * 400-character excerpt of the same text. Parent first, replies oldest to
 * newest, three lines each — a Cursor root-cause post is 1,400 characters and
 * does not get to own a 400px pane.
 *
 * **And opening a row acknowledges it.** The `+N` and the amber edge are the
 * answer to "what have I not seen", so reading a row is what makes them go
 * away. The subtlety, and it is the whole of it: the pane's *resting* state —
 * the top row it shows before anything has been clicked — must not acknowledge
 * anything, or the feature silently destroys itself every morning at 7am.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight, Check, Copy, ListPlus, Pin, PinOff, SquareTerminal, X,
} from 'lucide-react'
import type { Card, CardPriority, CardStatus } from '../lib/types'
import { PRIORITY_LABEL, PRIORITY_ORDER, STATUS_LABEL, STATUS_ORDER } from '../lib/types'
import { actions, reload } from '../lib/api'
import { ago, wallClock } from '../lib/time'
import { baselineOf, isFreshLine, replyTotal, threadLines, type ThreadLine } from '../lib/thread'
import { SOURCE_LABEL, SourceDot } from './sources'
import { Button, DateField, Select } from './primitives'
import { cardKind, cleanChannel, KindGlyph } from './kinds'
import { PriorityGlyph, StatusGlyph, isSettled } from './status'
import { openTarget } from '../lib/appLinks'
import { DETAIL_BODY, DETAIL_TITLE, EYEBROW } from '../lib/typography'
import { openLaunch } from '../lib/launch'
import { cardContext, cardTitle, repoHintFor, templatesFor } from '../lib/cardContext'
import { toast } from '../lib/toast'

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

  useEffect(() => { setCopied(false); setExpanded(false) }, [card.group_key])

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

  const lines = useMemo(() => threadLines(card), [card])

  /**
   * One message is an excerpt. Two is a conversation.
   *
   * The thread list replaces the excerpt where it draws, which is right for a
   * thread and wrong for everything else — and everything else is most of the
   * desk. A Datadog row, a Grafana row and the Truto Notifications digest each
   * carry exactly one message, and each has an `excerpt` its own family built on
   * purpose: Datadog's drops the `Attachment:` and `Notified:` lines, Grafana's
   * drops the attachment, the digest's drops its four-line preamble, and a
   * Sentry row's is the `_Root cause:_ / _Classification:_ / _Fix:_` triple
   * pulled out of a wall of prose. The thread entry beside it is the raw body,
   * clipped to 280 — so drawing a one-line "Thread" here quoted the transport
   * back at him and threw away the curation that made the row readable.
   *
   * A Slack thread whose parent stands alone loses nothing either: its excerpt
   * *is* that parent, at 400 characters with a `Show all` under it rather than
   * 280 with no way to see the rest.
   */
  const conversation = lines.length > 1 ? lines : []

  /**
   * The thread read failed for this row, so what it holds is what the search
   * returned rather than the conversation. It is said next to whichever of the
   * two is drawing — a short thread and a thread that would not load look
   * identical otherwise, and the shape a degraded row most often takes is one
   * message, which is the shape the list declines to draw.
   */
  const partial = card.sources.some(s => s.meta?.thread_partial)

  const run = async (fn: () => Promise<unknown>) => { await fn(); await reload() }

  const kind = cardKind(card)
  const claude = card.sources.find(s => s.source === 'claude')
  const resume = claude?.meta?.resume_cmd as string | undefined
  const { href, app } = openTarget(card)
  const external = href.startsWith('http')

  /**
   * The undo names the field it is putting back.
   *
   * `actions.restore(g)` with no second argument clears everything keeping a
   * card off the list, which is right for "bring this back" and wrong for an
   * undo: it also drops a due date or a pin that had nothing to do with the
   * action being reversed.
   */
  const setStatus = async (next: CardStatus, undo: 'status' = 'status') => {
    await actions.setStatus(card.group_key, next)
    await reload()
    if (isSettled(next)) onClose()
    toast(next === 'done' ? 'Done.' : `${STATUS_LABEL[next]}.`, {
      label: 'Undo',
      run: async () => { await actions.restore(card.group_key, undo); await reload() },
    })
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="pad-x pt-4 pb-3 shrink-0">
        {/* Everything in this pane starts on one x. The glyph used to sit in a
            slot ahead of the title, which put the title and its own why-line on
            two verticals 7px apart — and there were seven left edges inside this
            400px pane. The glyph moves onto the metadata line, where it is one
            more fact rather than an indent. */}
        <div className="flex items-start gap-2">
          <h2 className={`grow ${DETAIL_TITLE} line-clamp-3
                          ${isSettled(card.status) ? 'line-through text-fg-dim' : ''}`}>
            {card.title}
          </h2>
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
        {/*
          The three controls, in the order the questions get asked: where does
          this stand, how much does it matter, when is it wanted. Each is one
          labelled row on the fact grid the panel already uses, so they read as
          properties of the card rather than as a toolbar bolted to it.
        */}
        <div className="mt-2 border-b border-rule">
          <Row label="Status" mark={<StatusGlyph status={card.status} />}>
            <Select
              value={card.status}
              options={STATUS_ORDER.map(s => ({ id: s, label: STATUS_LABEL[s] }))}
              onChange={s => void setStatus(s)}
              ariaLabel="Status"
            />
          </Row>
          <Row label="Priority" mark={<PriorityGlyph priority={card.priority} />}>
            <Select
              value={String(card.priority)}
              options={PRIORITY_ORDER.map(v => ({ id: String(v), label: PRIORITY_LABEL[v] }))}
              onChange={v => void run(() =>
                actions.setPriority(card.group_key, Number(v) as CardPriority))}
              ariaLabel="Priority"
            />
          </Row>
          <Row label="Due">
            <DateField
              value={card.due_at}
              onChange={at => void run(() => actions.setDue(card.group_key, at))}
              ariaLabel="Due date"
            />
          </Row>
          <Row label="Pin">
            <Button size="sm" variant={card.state?.pinned ? 'secondary' : 'ghost'}
              onClick={() => void run(() => actions.pin(card.group_key, !card.state?.pinned))}>
              {card.state?.pinned ? <><PinOff size={14} /> Pinned</> : <><Pin size={14} /> Pin</>}
            </Button>
          </Row>
        </div>

        <Facts card={card} />

        <Thread card={card} lines={conversation} baseline={opened.current.baseline}
          partial={partial} />

        {/*
          The excerpt is what a card shows when there is no conversation to show.
          Where there is one it is the same text a second time: a Slack card's
          excerpt is built from the thread it belongs to, and a Gmail card's is
          the newest message's own snippet.
        */}
        {!conversation.length && card.excerpt && (
          <div className="mt-6">
            {partial && <p className={`${EYEBROW} mb-1`}>partial</p>}
            <p className={`${DETAIL_BODY} whitespace-pre-wrap ${expanded ? '' : 'line-clamp-3'}`}>
              {card.excerpt}
            </p>
            {/* Three lines, then a way to see the rest. `line-clamp-6` with no
                expand made a silent clip read as the whole thing. */}
            {card.excerpt.length > 160 && (
              <button onClick={() => setExpanded(v => !v)}
                className="mt-1 text-sm text-fg-mute hover:text-fg-dim transition-colors duration-100">
                {expanded ? 'Less' : 'Show all'}
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
      </div>

      {/*
        Four buttons, two columns on a narrow pane so four labels cannot overflow
        320px, one row wherever they fit. `Done` is the only primary: it is the
        only one of the four that commits anything.
      */}
      <div className="shrink-0 border-t border-rule pad-x py-3">
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          {external && (
            <a
              href={app ?? href}
              target="_blank"
              rel="noreferrer"
              className="relative inline-flex items-center justify-center rounded-control
                         whitespace-nowrap transition-colors duration-100 hit h-8 px-3 text-sm gap-2
                         bg-ink-800 border border-edge text-fg font-medium hover:bg-ink-700"
            >
              Open <ArrowUpRight size={14} />
            </a>
          )}
          <Button size="md" variant="secondary" onClick={() => {
            onClose()
            openLaunch(cardContext(card), {
              templates: templatesFor(card),
              repoHint: repoHintFor(card),
              title: cardTitle(card),
            })
          }}>
            <SquareTerminal size={14} /> Claude
          </Button>
          <Button size="md" variant="secondary" onClick={() => onMakeTask(card)}>
            <ListPlus size={14} /> Task
          </Button>
          <Button size="md" variant="primary" onClick={() => void setStatus('done')}>
            <Check size={14} /> Done
          </Button>
        </div>
        {/*
          The escape hatch, and the reason it is a visible link rather than a
          timer: a custom scheme with no handler does not throw, does not fire an
          error and does not navigate, so there is no honest way to detect that
          `slack://` went nowhere. One quiet line costs a person with the app
          nothing and saves the one without it.
        */}
        {app && (
          <a href={href} target="_blank" rel="noreferrer"
            className="mt-2 inline-block text-sm text-fg-mute hover:text-fg-dim
                       transition-colors duration-100">
            Open in browser
          </a>
        )}
      </div>
    </div>
  )
}

/* -------------------------------- thread ---------------------------------- */

/**
 * The conversation, parent first and then oldest to newest.
 *
 * One order, and it is the one a conversation is written in: the answer goes
 * under the question, and after a scroll the new material is where the eye
 * already is. Every body clips to three lines — the pane is 320–720px wide and
 * one Cursor root-cause post is 1,400 characters, so an unclipped list is a
 * single message and a scrollbar.
 *
 * Two marks, and no more. A reply that names him carries a 2px amber rule and
 * the word `@you`, which is the answer to "why did this row light up". A reply
 * the server counted is drawn in the brighter ink, under `isFreshLine` — the
 * count's own two clamps, in one expression both halves read — so the `+3` on
 * the row and the brighter lines in here cannot disagree about a message.
 */
function Thread({
  card, lines, baseline, partial,
}: { card: Card; lines: ThreadLine[]; baseline: number; partial: boolean }) {
  if (!lines.length) return null
  const total = replyTotal(card)

  return (
    <section className="mt-6">
      <div className="flex items-baseline gap-2 mb-1">
        <h3 className={EYEBROW}>Thread</h3>
        {total > 0 && <span className={`${EYEBROW} tnum`}>{total}</span>}
        {partial && <span className={EYEBROW}>partial</span>}
      </div>
      <ol>
        {lines.map(l => (
          <ThreadRow key={l.key} line={l} fresh={isFreshLine(l, baseline)} />
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
      {/* `text-sm`, not the pane's body size, and not `DETAIL_BODY` — which
          carries a colour of its own that would fight the one below it. A body
          size is right for one excerpt and wrong for a list of twenty messages
          in a 400px column. */}
      <p className={`text-sm whitespace-pre-wrap line-clamp-3
                     ${fresh ? 'text-fg-dim' : 'text-fg-mute'}`}>
        {line.text}
      </p>
    </li>
  )
}

/* --------------------------------- facts ---------------------------------- */

/**
 * One labelled row, with a fixed slot for its mark.
 *
 * The slot is always rendered, even when the mark is null. Normal priority
 * draws nothing at all — which is right on a table row and wrong here, where an
 * absent 20px glyph pulled the Priority control 20px left of the Status control
 * directly above it. Four controls on four verticals in a 360px pane is what
 * this whole file spent its last rewrite removing.
 */
const Row = ({
  label, mark, children,
}: { label: string; mark?: React.ReactNode; children: React.ReactNode }) => (
  <div className="flex items-center gap-3 h-11 border-t border-rule first:border-t-0">
    <span className="w-24 shrink-0 text-sm text-fg-mute">{label}</span>
    <span className="w-5 shrink-0 flex items-center">{mark}</span>
    <span className="min-w-0 grow">{children}</span>
  </div>
)

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-sm">{children}</span>
)

/**
 * The facts, merged across sources, in one fixed order.
 *
 * It used to render one `Block` and one `FactTable` per source, so a card seen
 * in GitHub and Claude Code got a five-row table and a three-row table — eight
 * rows and two headings for a glance — and the more successfully the dedup
 * engine merged, the worse the pane got. So the facts became a union, in one
 * order, capped at four.
 *
 * The cap is gone. This is the only surface that carries `why`, `who`, `when`,
 * the channel and the repository at all now that the table is four columns
 * wide, and a cap here would silently drop the one a person opened the card to
 * read. Order does the work the cap used to: the five that are true of every
 * card come first, then whatever the sources themselves know.
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
    if (v === null || v === undefined || v === '') return
    rows.push([k, v])
  }

  add('Why', card.why)
  add('Who', card.who ?? card.actor)
  add('When', wallClock(card.ts))
  if (slack) {
    const channel = slack.meta?.channel ?? card.meta?.channel
    add('Channel', channel ? <Mono>{cleanChannel(String(channel))}</Mono> : null)
    add('From', slack.who ?? slack.actor)
    if (slack.meta?.paged) add('Paged', 'your group was named')
    add('Alert', slack.meta?.short_id ? <Mono>{slack.meta.short_id}</Mono> : null)
    add('Monitor', slack.meta?.monitor ? <Mono>{slack.meta.monitor}</Mono> : null)
  }
  if (gh) {
    add('Repository', gh.meta?.repo ? <Mono>{gh.meta.repo}</Mono> : null)
    add('Number', gh.meta?.number ? <Mono>#{gh.meta.number}</Mono> : null)
    add('State', gh.meta?.is_pr ? (gh.meta?.draft ? 'draft' : 'ready for review') : 'open')
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

  // The same `Row` the controls above use, so a fact and a control that mean
  // the same thing about the same card start on the same x. It was a table with
  // its own label width, which put the two columns 28px apart.
  return (
    <div className="mt-6 border-b border-rule">
      {rows.map(([k, v]) => (
        <Row key={k} label={k}>
          <span className="block text-sm text-fg-dim truncate">{v}</span>
        </Row>
      ))}
    </div>
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
    <div className="mt-6">
      <div className={`${EYEBROW} mb-2`}>Seen in</div>
      <div className="flex items-center gap-3 text-sm text-fg-mute flex-wrap">
        {rows.map(s => {
          const where = s.meta?.channel
            ? cleanChannel(String(s.meta.channel))
            : s.account ?? s.meta?.repo ?? s.meta?.project ?? s.kind
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
              className="inline-flex items-center gap-2 h-11 hover:text-fg-dim transition-colors duration-100">
              {body}
            </a>
          ) : (
            <span key={`${s.source}:${s.url}`} className="inline-flex items-center gap-2 h-11">{body}</span>
          )
        })}
      </div>
    </div>
  )
}
