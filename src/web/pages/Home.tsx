import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { actions, optimistic, refresh, reload, useStore } from '../lib/api'
import type { Card as CardT, SourceName } from '../lib/types'
import { atHour, ago, greeting } from '../lib/time'
import { Card } from '../components/Card'
import { CardDetail, CardSheet } from '../components/CardSheet'
import { TaskSheet } from '../components/TaskSheet'
import { Chip, Empty, spring } from '../components/primitives'
import { useStill } from '../lib/motion'
import { SOURCE_COLOR, SOURCE_LABEL } from '../components/sources'
import { openLaunch } from '../lib/launch'
import { cardContext, cardTitle, repoHintFor, templateFor } from '../lib/cardContext'
import { registerPaletteActions } from '../components/palette'
import { toast } from '../lib/toast'

/** Every kind Now can hold, in the order the filter row offers them. */
const FILTERS: SourceName[] = ['slack', 'gmail', 'github', 'sentry', 'claude']

/**
 * Stable empty arrays.
 *
 * `state?.now ?? []` builds a fresh array on every render, which makes every
 * `useMemo` keyed on it recompute, which makes the effect that registers this
 * page's palette actions re-run, which re-renders the shell — a loop that took
 * React's "maximum update depth" error to notice. A shared constant is
 * referentially stable, so nothing downstream sees a change that did not happen.
 */
const NO_CARDS: CardT[] = []

/**
 * Whether the viewport is wide enough for the list+detail pane layout.
 *
 * The pane's own visibility is CSS (`hidden lg:block`), which is enough for
 * how it *looks* — but the modal `CardSheet` it replaces has a real side
 * effect (locking body scroll) that CSS alone cannot suppress. Only one of
 * the two may ever actually receive `openCard`.
 */
function useIsPaneWidth(): boolean {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return wide
}

export function Home() {
  const still = useStill()
  const wide = useIsPaneWidth()
  const { state, syncing } = useStore()
  const [openCard, setOpenCard] = useState<CardT | null>(null)
  const [taskFrom, setTaskFrom] = useState<CardT | null>(null)
  const [filter, setFilter] = useState<SourceName | 'all'>('all')
  /**
   * `null` until someone actually navigates.
   *
   * Defaulting to 0 meant the first row was highlighted before anyone chose it,
   * and — worse — a stray `e` completed something the reader had not selected.
   * Keyboard actions apply to a selection, and there is no selection until a
   * key makes one.
   */
  const [cursor, setCursor] = useState<number | null>(null)

  const now = state?.now ?? NO_CARDS
  const open = state?.open ?? NO_CARDS
  const parked = state?.parked ?? NO_CARDS

  // One filter, three piles: which kind, not which pile — piles already answer
  // "does this need me now", the filter answers "which of my sources is this".
  const matches = (c: CardT) => filter === 'all' || c.sources.some(s => s.source === filter)
  const fNow = useMemo(() => now.filter(matches), [now, filter])
  const fOpen = useMemo(() => open.filter(matches), [open, filter])
  const fParked = useMemo(() => parked.filter(matches), [parked, filter])

  const today = useMemo(
    () => new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    [],
  )

  /** Remove locally first so the list closes under the thumb immediately. */
  const drop = (g: string) =>
    optimistic(s => {
      for (const k of ['now', 'open', 'parked'] as const) {
        s[k] = s[k].filter(c => c.group_key !== g)
      }
      return s
    })

  /**
   * Done and Later, with a way back.
   *
   * `e` is one key, unmodified and unconfirmed, which is the right cost for
   * the action people take fifty times a day — but only if it is reversible.
   * The bar offers the undo for the few seconds it is likely to be wanted;
   * "Done and not mine" in the palette covers everything after that.
   */
  const undoable = (c: CardT, text: string) =>
    toast(text, {
      label: 'Undo',
      run: async () => { await actions.restore(c.group_key); await reload() },
    })

  const done = async (c: CardT) => {
    drop(c.group_key)
    await actions.doneCard(c.group_key)
    undoable(c, 'Marked done.')
    void reload()
  }
  const snooze = async (c: CardT) => {
    drop(c.group_key)
    await actions.snooze(c.group_key, atHour(1, 9))
    undoable(c, 'Back tomorrow morning.')
    void reload()
  }

  // One context entry per place the card was seen, each with its own facts —
  // see lib/cardContext.ts for what the one-line version used to produce.
  const launch = (c: CardT) =>
    openLaunch(cardContext(c), {
      template: templateFor(c),
      repoHint: repoHintFor(c),
      title: cardTitle(c),
    })

  /**
   * j/k over the visible rows, Enter to open.
   *
   * Scoped to keydown on the document but ignored while a field has focus, so
   * typing "j" in the composer on another page cannot move a selection here.
   */
  const rows = useMemo(() => [...fNow, ...fOpen], [fNow, fOpen])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!rows.length) return

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor(c => (c === null ? 0 : Math.min(c + 1, rows.length - 1)))
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor(c => (c === null ? 0 : Math.max(c - 1, 0)))
        return
      }
      if (e.key === 'Escape') return setCursor(null)

      // Everything below acts on the selection, so it does nothing until j or k
      // has made one.
      const card = cursor === null ? null : rows[cursor]
      if (!card) return
      if (e.key === 'Enter') { e.preventDefault(); setOpenCard(card) }
      else if (e.key === 'e') { e.preventDefault(); void done(card) }
      else if (e.key === 's') { e.preventDefault(); void snooze(card) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [rows, cursor])

  // A shrinking list must not leave the cursor past the end.
  useEffect(() => {
    setCursor(c => (c === null ? null : Math.min(c, Math.max(rows.length - 1, 0))))
  }, [rows.length])

  useEffect(() =>
    registerPaletteActions(() =>
      rows.slice(0, 20).map(c => ({
        id: `card:${c.group_key}`,
        label: c.title,
        hint: c.why,
        group: 'Cards',
        run: () => setOpenCard(c),
      })),
    ), [rows])

  const cardProps = (c: CardT) => ({
    card: c,
    focused: cursor !== null && rows[cursor]?.group_key === c.group_key,
    onOpen: setOpenCard,
    onDone: done,
    onSnooze: snooze,
    onTask: setTaskFrom,
    onLaunch: launch,
  })

  // No state yet is not the same fact as "zero cards" — the first is still
  // loading, the second is a real, checked answer. Rendering "0 / nobody is
  // waiting on you" before the first `/state` response lands says the second
  // thing about a question that hasn't actually been asked yet.
  if (!state) return <div className="pt-24"><Empty>Reading what's on you…</Empty></div>

  return (
    <div className="pb-24 lg:flex lg:gap-10 lg:items-start">
    {/* The list. Capped at a reading width when nothing is open — the same
        760px Now always had — but free to give that width up to the detail
        pane once something is, rather than the pane fighting the column for
        room neither can spare. */}
    <div className={`min-w-0 w-full ${openCard ? 'lg:flex-1' : 'lg:max-w-[760px] lg:mx-auto'}`}>
      <header className="pt-8 pb-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[26px] sm:text-[30px] font-medium tracking-[-0.025em] leading-none">
              {greeting()}
            </h1>
            <p className="mt-2 text-[13px] text-fg-mute">{today}</p>
          </div>
          <button
            onClick={() => void refresh()}
            title="Refresh all sources"
            className="p-2 -mr-2 text-fg-mute hover:text-fg-dim transition-colors"
          >
            <RefreshCw size={15} className={syncing ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      {/* One filter, applied to every pile below: which of my sources, not
          which pile — a pile already means something (nobody's waiting on
          Open, someone is on Now), and the filter must not blur that. */}
      <div className="flex items-center gap-1.5 flex-wrap pb-4 hairline">
        <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All</Chip>
        {FILTERS.map(s => (
          <Chip key={s} active={filter === s} onClick={() => setFilter(s)} dot={SOURCE_COLOR[s]}>
            {SOURCE_LABEL[s]}
          </Chip>
        ))}
      </div>

      {/* The hero. The count is the only place a large number appears, and the
          only routine use of the accent — that is what makes it read as urgent
          without any red, badges or alarm styling. It is always the true,
          unfiltered count: a filter narrows which rows are shown, never what
          the number claims. */}
      <section className="pt-1 pb-1">
        <div className="flex items-baseline gap-3 mb-1">
          <motion.span
            key={now.length}
            initial={still ? false : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={spring}
            className={`text-[40px] leading-none font-medium tnum tracking-[-0.03em]
              ${now.length ? 'text-accent-ink' : 'text-fg-mute'}`}
          >
            {now.length}
          </motion.span>
          <div>
            <h2 className="text-[15px] font-medium tracking-[-0.01em]">Now</h2>
            <p className="text-[12.5px] text-fg-mute">
              {now.length ? 'someone is waiting on you' : 'nobody is waiting on you'}
              {filter !== 'all' && fNow.length !== now.length && ` · showing ${fNow.length} of ${now.length}`}
            </p>
          </div>
        </div>

        <div className={now.length ? 'mt-4' : 'mt-1'}>
          <AnimatePresence initial={false} mode="popLayout">
            {fNow.map(c => <Card key={c.group_key} {...cardProps(c)} />)}
          </AnimatePresence>
          {!now.length && (
            <p className="text-[13px] text-fg-mute py-5 leading-relaxed">
              Clear. Nothing is waiting on a reply from you.
            </p>
          )}
          {now.length > 0 && !fNow.length && (
            <p className="text-[13px] text-fg-mute py-5 leading-relaxed">
              Nothing on Now matches this filter.
            </p>
          )}
        </div>
      </section>

      <Section title="Open" count={fOpen.length} hint="you started these">
        <AnimatePresence initial={false} mode="popLayout">
          {fOpen.map(c => <Card key={c.group_key} {...cardProps(c)} />)}
        </AnimatePresence>
        {!open.length && <Empty>Nothing in flight.</Empty>}
        {open.length > 0 && !fOpen.length && <Empty>Nothing open matches this filter.</Empty>}
      </Section>

      {/* Parked is a pile someone deliberately set aside, not a footnote — it
          gets the same standing section as Open, not a collapsed toggle
          someone has to know to click. */}
      {fParked.length > 0 && (
        <Section title="Parked" count={fParked.length} hint="comes back on its own">
          <AnimatePresence initial={false} mode="popLayout">
            {fParked.map(c => (
              <Card key={c.group_key} card={c} onOpen={setOpenCard} onDone={done} onSnooze={snooze}
                onTask={setTaskFrom} onLaunch={launch} />
            ))}
          </AnimatePresence>
        </Section>
      )}

      <SyncLine />
    </div>

    {/* The detail pane. On a screen wide enough to hold it beside the list, a
        card's own content lives here — permanently, no backdrop, no dismissal
        by clicking elsewhere, because it never covered anything to begin with.
        Below that width it stays the modal sheet it always was. */}
    <aside className="hidden lg:block lg:sticky lg:top-6 lg:w-[380px] xl:w-[420px] lg:shrink-0
                      lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto">
      {openCard ? (
        <div className="rounded-2xl bg-ink-900/60 border border-white/[0.05] p-5">
          <CardDetail
            card={openCard}
            onClose={() => setOpenCard(null)}
            onMakeTask={c => { setOpenCard(null); setTaskFrom(c) }}
          />
        </div>
      ) : (
        <div className="rounded-2xl bg-ink-900/60 border border-white/[0.05] p-6 text-center">
          <p className="text-[13px] text-fg-mute">Pick something on the left to see it here.</p>
        </div>
      )}
    </aside>

    {/* `wide` decides which of these two actually receives the card — never
        both, since the modal locks body scroll the moment it is handed one,
        whether or not `lg:hidden` is also hiding it visually. */}
    <CardSheet
      card={wide ? null : openCard}
      onClose={() => setOpenCard(null)}
      onMakeTask={c => { setOpenCard(null); setTaskFrom(c) }}
    />
    <TaskSheet
      open={!!taskFrom}
      onClose={() => setTaskFrom(null)}
      fromCard={taskFrom}
    />
    </div>
  )
}

/**
 * One line, at the bottom, naming when each source last answered and which one
 * did not. It replaces the old habit of finding that out in Settings — the
 * question "is this list complete?" belongs next to the list.
 *
 * Three states, not two. "Not connected" and "connected but the sync itself
 * failed" are different problems with different fixes, and collapsing them
 * sent a reader to connect a source that was already connected — while a
 * source that had never been connected at all read as freshly synced, because
 * polling nothing succeeds.
 */
function syncWord(r: { ok: number; connected: number; at: number }): { text: string; tone: string } {
  if (!r.connected) return { text: 'not connected', tone: 'text-fg-mute' }
  if (!r.ok) return { text: `sync failed ${ago(r.at)}`, tone: 'text-warn' }
  return { text: ago(r.at), tone: '' }
}

function SyncLine() {
  const { state } = useStore()
  const rows = state?.lastSync ?? []
  if (!rows.length) return null

  return (
    <p className="mt-10 text-[11.5px] text-fg-mute flex flex-wrap items-center gap-x-2 gap-y-1">
      {rows.map((r, i) => {
        const w = syncWord(r)
        return (
          <span key={r.source} className="inline-flex items-center gap-1.5">
            {i > 0 && <span className="text-ink-600">·</span>}
            {/* The error is the title, not the line: a sync line that grows a
                paragraph stops being a line anyone reads. */}
            <span className={w.tone} title={r.error ?? undefined}>
              {SOURCE_LABEL[r.source as keyof typeof SOURCE_LABEL] ?? r.source}{' '}{w.text}
            </span>
          </span>
        )
      })}
    </p>
  )
}

function Section({
  title, count, hint, children,
}: { title: string; count: number; hint: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h2>
        <span className="tnum text-[13px] text-fg-mute">{count}</span>
        <span className="text-[12.5px] text-fg-mute/70 ml-auto">{hint}</span>
      </div>
      {children}
    </section>
  )
}
