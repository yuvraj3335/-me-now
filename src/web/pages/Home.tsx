/**
 * Now.
 *
 * A table of everything on him, in one downward glance: what it is, the thing
 * itself, why it is on him, who, where, which source, when, and the two things
 * he can do about it without opening anything.
 *
 * The three piles are three `<tbody>` groups of one table sharing one
 * `<colgroup>`, so the columns hold their x-position from the first row of Now
 * to the last row of Parked. A fourth group, `Done and not mine`, sits collapsed
 * at the bottom — a pile of his cards belongs on the page that holds his piles,
 * not behind a modal.
 *
 * Everything that used to shout is gone: the 40px accent numeral, the sentence
 * under it, and the second sentence under that, all three of which said the same
 * thing about a zero.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, RefreshCw, RotateCcw } from 'lucide-react'
import { actions, optimistic, refresh, reload, useStore } from '../lib/api'
import type { Card as CardT, SourceName } from '../lib/types'
import { ago, atHour } from '../lib/time'
import {
  CardLine, CardRow, columnsFor, colSpanOf, EmptyRow, GroupHead, TableCols, TableHead,
  useViewport, sourceWords, type Columns, type RowAction,
} from '../components/CardTable'
import { CardDetail, EmptyDetail } from '../components/CardDetail'
import { TaskSheet } from '../components/TaskSheet'
import { Button, Chip, Empty } from '../components/primitives'
import { SOURCE_COLOR, SOURCE_LABEL } from '../components/sources'
import { registerPaletteActions } from '../components/palette'
import { toast } from '../lib/toast'
import { overlayOpen } from '../lib/overlay'
import { closeDetail, openDetail, setParam, useDetailKey, useParam } from '../lib/route'

/** Every source the filter row offers, in a fixed order. */
const FILTERS: SourceName[] = ['slack', 'gmail', 'github', 'sentry', 'claude']

/**
 * Stable empty arrays.
 *
 * `state?.now ?? []` builds a fresh array on every render, which makes every
 * `useMemo` keyed on it recompute, which makes the effect that registers this
 * page's palette actions re-run, which re-renders the shell — a loop that took
 * React's "maximum update depth" error to notice.
 */
const NO_CARDS: CardT[] = []

/** The width below which six columns stop being a table and become a diagram of one. */
const TABLE_MIN = 1024

export function Home() {
  const { state, syncing } = useStore()
  const width = useViewport()
  const filter = (useParam('src') ?? 'all') as SourceName | 'all'
  const doneOpen = useParam('done') === '1'
  const selectedKey = useDetailKey()
  const [taskFrom, setTaskFrom] = useState<CardT | null>(null)
  /**
   * `null` until someone actually navigates.
   *
   * Defaulting to 0 meant the first row was highlighted before anyone chose it,
   * and — worse — a stray `e` completed something the reader had not selected.
   */
  const [cursor, setCursor] = useState<number | null>(null)

  const now = state?.now ?? NO_CARDS
  const open = state?.open ?? NO_CARDS
  const parked = state?.parked ?? NO_CARDS

  const matches = useCallback(
    (c: CardT) => filter === 'all' || c.sources.some(s => s.source === filter),
    [filter],
  )
  const fNow = useMemo(() => now.filter(matches), [now, matches])
  const fOpen = useMemo(() => open.filter(matches), [open, matches])
  const fParked = useMemo(() => parked.filter(matches), [parked, matches])

  const rows = useMemo(() => [...fNow, ...fOpen, ...fParked], [fNow, fOpen, fParked])
  const selected = useMemo(
    () => rows.find(c => c.group_key === selectedKey) ?? null,
    [rows, selectedKey],
  )
  const cols = columnsFor(width)
  const isTable = width >= TABLE_MIN

  /** Remove locally first so the list closes under the thumb immediately. */
  const drop = (g: string) =>
    optimistic(s => {
      for (const k of ['now', 'open', 'parked'] as const) s[k] = s[k].filter(c => c.group_key !== g)
      return s
    })

  /**
   * Done, Later and Wake now, each with a way back.
   *
   * The undo restores every field the action replaced, not the one it is named
   * after — `Later` writes `snoozed_until` *and* clears `pile_override`, and an
   * undo that cleared only the first destroyed a park the product could not
   * re-create.
   */
  const undoable = (c: CardT, text: string, undo: 'done' | 'snoozed' | 'moved') =>
    toast(text, {
      label: 'Undo',
      run: async () => { await actions.restore(c.group_key, undo); await reload() },
    })

  const done = async (c: CardT) => {
    drop(c.group_key)
    if (c.group_key === selectedKey) closeDetail()
    await actions.doneCard(c.group_key)
    undoable(c, 'Marked done.', 'done')
    void reload()
  }
  const later = async (c: CardT) => {
    drop(c.group_key)
    await actions.snooze(c.group_key, atHour(1, 9))
    undoable(c, 'Back tomorrow morning.', 'snoozed')
    void reload()
  }
  /** The counterpart, and the only second action a Parked card is offered. */
  const wake = async (c: CardT) => {
    drop(c.group_key)
    await actions.move(c.group_key, null)
    undoable(c, 'Back on your list.', 'moved')
    void reload()
  }

  const rowActions: RowAction = {
    onDone: done,
    onLater: later,
    onWake: wake,
    onOpen: c => openDetail(c.group_key),
  }

  /**
   * j/k over the visible rows, Enter to open, e and s to act.
   *
   * Inert while any modal is open. The handler is bound to `document` and used
   * to skip only INPUT / TEXTAREA / contentEditable — a `role="dialog"` panel is
   * none of those, so `e` marked a card Done straight through an open sheet,
   * and the undo toast rendered underneath the scrim where it could not be
   * reached.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen()) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!rows.length) return

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        return setCursor(c => (c === null ? 0 : Math.min(c + 1, rows.length - 1)))
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        return setCursor(c => (c === null ? 0 : Math.max(c - 1, 0)))
      }
      if (e.key === 'Escape') {
        if (selectedKey) return closeDetail()
        return setCursor(null)
      }

      const card = cursor === null ? null : rows[cursor]
      if (!card) return
      if (e.key === 'Enter') { e.preventDefault(); openDetail(card.group_key) }
      else if (e.key === 'e') { e.preventDefault(); void done(card) }
      else if (e.key === 's') {
        e.preventDefault()
        void (card.pile === 'parked' ? wake(card) : later(card))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [rows, cursor, selectedKey])

  // A shrinking list must not leave the cursor past the end.
  useEffect(() => {
    setCursor(c => (c === null ? null : Math.min(c, Math.max(rows.length - 1, 0))))
  }, [rows.length])

  /**
   * The palette's card entries, capped.
   *
   * Nineteen rows filled the list ahead of every global command, which is the
   * opposite of what a palette is for when the thing you want is "compose mail".
   */
  useEffect(() =>
    registerPaletteActions(() =>
      rows.slice(0, 8).map(c => ({
        id: `card:${c.group_key}`,
        label: c.title,
        hint: c.why,
        group: `Cards — ${rows.length}`,
        run: () => openDetail(c.group_key),
      })),
    ), [rows])

  if (!state) {
    return <div className="px-4 sm:px-6 pt-16"><Empty>Reading what's on you</Empty></div>
  }

  const groups: Array<{ title: string; shown: CardT[]; total: number; empty: string }> = [
    { title: 'Now', shown: fNow, total: now.length, empty: emptyWord('Nothing waiting', filter) },
    { title: 'Open', shown: fOpen, total: open.length, empty: emptyWord('Nothing in flight', filter) },
    { title: 'Parked', shown: fParked, total: parked.length, empty: emptyWord('Nothing parked', filter) },
  ]

  const list = (
    <div className="min-w-0 grow px-4 pb-24 lg:pb-8">
      <Header syncing={syncing} />
      <FilterRow value={filter} state={state} />

      {isTable ? (
        <table className="w-full table-fixed border-collapse">
          <TableCols cols={cols} />
          <TableHead cols={cols} />
          {groups.map(g => (
            <tbody key={g.title}>
              <GroupHead title={g.title} shown={g.shown.length} total={g.total} cols={cols}
                first={g.title === 'Now'} />
              {g.shown.length === 0
                ? <EmptyRow cols={cols}>{g.empty}</EmptyRow>
                : g.shown.map(c => (
                    <CardRow
                      key={c.group_key} card={c} cols={cols}
                      selected={c.group_key === selectedKey}
                      focused={cursor !== null && rows[cursor]?.group_key === c.group_key}
                      actions={rowActions}
                    />
                  ))}
            </tbody>
          ))}
          <DoneGroup cols={cols} open={doneOpen} />
        </table>
      ) : (
        <div>
          {groups.map(g => (
            <section key={g.title}>
              <div className="flex items-baseline gap-2 pt-6 pb-2">
                <h2 className="text-md font-medium tracking-[-0.01em]">{g.title}</h2>
                <span className={`tnum text-md ${g.title === 'Now' && g.shown.length ? 'text-accent-ink' : 'text-fg-mute'}`}>
                  {g.shown.length !== g.total ? `${g.shown.length} of ${g.total}` : g.shown.length}
                </span>
              </div>
              {g.shown.length === 0
                ? <p className="text-sm text-fg-mute h-11 flex items-center">{g.empty}</p>
                : (
                  <ul className="-mx-4">
                    {g.shown.map(c => (
                      <CardLine key={c.group_key} card={c}
                        selected={c.group_key === selectedKey} actions={rowActions} />
                    ))}
                  </ul>
                )}
            </section>
          ))}
          <DoneList open={doneOpen} />
        </div>
      )}

      <SyncLine />
    </div>
  )

  /*
   * Below the table width the detail is a full-screen push view, not a bottom
   * sheet. The sheet was 963px of content in a 725px scroller that also
   * drag-dismissed on the same axis as its own scroll, and its last two actions
   * sat behind the tab bar. A push view fixes the clipping structurally and
   * makes the OS Back button close the detail instead of leaving Wake.
   */
  if (!isTable && selected) {
    // Through a portal, not inline. `main` carries `relative z-10`, so anything
    // rendered inside it lives in that stacking context and can never paint
    // above the `z-30` tab bar that is its sibling — which put the detail's
    // action bar back underneath the nav, the exact clipping this view exists to
    // fix. On `document.body` it is above everything, and the tab bar is
    // covered rather than competed with.
    return createPortal(
      <div className="fixed inset-0 z-50 bg-ink-900 flex flex-col pad-top pad-bottom">
        <CardDetail card={selected} onClose={closeDetail}
          onMakeTask={c => { closeDetail(); setTaskFrom(c) }} />
        <TaskSheet open={!!taskFrom} onClose={() => setTaskFrom(null)} fromCard={taskFrom} />
      </div>,
      document.body,
    )
  }

  return (
    <div className="lg:flex lg:items-stretch lg:min-h-dvh">
      {list}
      {/*
        The pane column always exists at the table width, so opening a row never
        re-lays out the list. The list used to be `max-w-[760px] mx-auto` and
        flip to `flex-1` the moment a card opened, which moved every row on the
        page as a side effect of reading one.
      */}
      <aside className="hidden lg:block lg:w-88 xl:w-100 lg:shrink-0 lg:border-l lg:border-edge
                        lg:sticky lg:top-0 lg:h-dvh bg-ink-850">
        {selected
          ? <CardDetail card={selected} onClose={closeDetail}
              onMakeTask={c => { closeDetail(); setTaskFrom(c) }} />
          : <EmptyDetail />}
      </aside>
      <TaskSheet open={!!taskFrom} onClose={() => setTaskFrom(null)} fromCard={taskFrom} />
    </div>
  )
}

/**
 * A noun phrase, not a sentence, and it names the filter when there is one:
 * "no parked GitHub items" and "Parked does not exist" used to look identical.
 */
const emptyWord = (base: string, filter: SourceName | 'all') =>
  filter === 'all' ? base : `${base} from ${SOURCE_LABEL[filter]}`

/* --------------------------------- chrome --------------------------------- */

function Header({ syncing }: { syncing: boolean }) {
  return (
    <header className="flex items-center gap-3 pt-4 pb-2">
      <h1 className="text-lg font-medium">Now</h1>
      {/* `md`, not `sm`: with its `::after` inset this is a 44px target, and
          the old one was a 31×31 tap on a phone. */}
      <Button size="md" variant="ghost" className="ml-auto"
        title="Refresh all sources" ariaLabel="Refresh all sources"
        onClick={() => void refresh()}>
        <RefreshCw size={15} className={syncing ? 'animate-spin' : ''} />
      </Button>
    </header>
  )
}

/**
 * The filter, in the URL.
 *
 * It used to live in `useState`: clicking GitHub narrowed Open 19 → 3 while
 * `location.href` stayed `/`, so a filtered view could not be bookmarked and a
 * refresh mid-triage lost his place.
 *
 * A source that is not connected renders disabled and sorts last, rather than
 * being hidden — hiding them makes the row change shape as connections come and
 * go — and rather than being offered identically to the ones that work, which is
 * how picking Slack emptied the list with no statement of why.
 */
function FilterRow({ value, state }: { value: SourceName | 'all'; state: { lastSync: Array<{ source: string; connected: number }> } }) {
  const connected = new Set(state.lastSync.filter(r => r.connected).map(r => r.source))
  const ordered = [...FILTERS].sort(
    (a, b) => Number(connected.has(b)) - Number(connected.has(a)),
  )
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-2">
      <Chip active={value === 'all'} onClick={() => setParam('src', null)}>All</Chip>
      {ordered.map(s => {
        const on = connected.has(s)
        return (
          <Chip
            key={s}
            active={value === s}
            disabled={!on}
            title={on ? undefined : `${SOURCE_LABEL[s]} is not connected`}
            onClick={() => setParam('src', value === s ? null : s)}
            dot={SOURCE_COLOR[s]}
          >
            {SOURCE_LABEL[s]}
          </Chip>
        )
      })}
    </div>
  )
}

/**
 * One line naming when each source last answered and which one did not.
 *
 * Three states, not two: "not connected" and "connected but the sync failed" are
 * different problems with different fixes. This is the one place in the product
 * that already made that distinction, and it is kept verbatim.
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
    <p className="mt-8 pt-4 border-t border-rule text-xs text-fg-mute flex flex-wrap items-center gap-x-2 gap-y-1">
      {rows.map((r, i) => (
        <span key={r.source} className="inline-flex items-center gap-2">
          {i > 0 && <span aria-hidden>·</span>}
          <span className={syncWord(r).tone} title={r.error ?? undefined}>
            {SOURCE_LABEL[r.source as keyof typeof SOURCE_LABEL] ?? r.source} {syncWord(r).text}
          </span>
        </span>
      ))}
    </p>
  )
}

/* ------------------------- done and not mine ------------------------------ */

/**
 * What Done and Not-mine took away, as a fourth group rather than a modal.
 *
 * Done is one unconfirmed keystroke, which is only defensible because it is
 * reversible. The undo bar covers the next few seconds; this covers the rest,
 * including the card he finished yesterday and needs again. Collapsed, because
 * it is the only group he is not looking for.
 */
function useDoneCards(open: boolean) {
  const [cards, setCards] = useState<CardT[] | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    setCards(null)
    actions.doneCards().then(d => { if (live) setCards(d.cards) }).catch(() => { if (live) setCards([]) })
    return () => { live = false }
  }, [open])

  const restore = async (c: CardT) => {
    setCards(cur => cur?.filter(x => x.group_key !== c.group_key) ?? cur)
    await actions.restore(c.group_key)
    await reload()
    toast('Back on your list.')
  }
  return { cards, restore }
}

const doneWord = (c: CardT) =>
  c.state?.not_mine ? 'not mine' : `done ${c.state?.done_at ? ago(c.state.done_at) : ''}`.trim()

function DoneGroup({ cols, open }: { cols: Columns; open: boolean }) {
  const { cards, restore } = useDoneCards(open)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <tbody>
      <tr>
        <td colSpan={colSpanOf(cols)} className="px-2 pt-6 pb-2">
          <button
            onClick={() => setParam('done', open ? null : '1')}
            className="inline-flex items-center gap-2 text-md font-medium tracking-[-0.01em]
                       text-fg-dim hover:text-fg transition-colors duration-100"
          >
            <Chevron size={15} className="text-fg-mute" />
            Done and not mine
            {cards && <span className="tnum text-md text-fg-mute">{cards.length}</span>}
          </button>
        </td>
      </tr>
      {open && cards?.length === 0 && <EmptyRow cols={cols}>Nothing taken off</EmptyRow>}
      {open && cards?.map(c => (
        <tr key={c.group_key} className="border-b border-rule">
          <td className="px-2 py-3 text-sm text-fg-mute align-middle">{doneWord(c)}</td>
          <td className="px-2 py-3 text-base text-fg-dim align-middle truncate" colSpan={colSpanOf(cols) - 3}>
            {c.title}
          </td>
          <td className="px-2 py-3 text-sm text-fg-mute align-middle truncate font-mono">{sourceWords(c)}</td>
          <td className="px-2 py-1 align-middle text-right">
            <Button size="sm" variant="ghost" title="Bring it back" onClick={() => void restore(c)}>
              <RotateCcw size={14} />
            </Button>
          </td>
        </tr>
      ))}
    </tbody>
  )
}

function DoneList({ open }: { open: boolean }) {
  const { cards, restore } = useDoneCards(open)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section>
      <button
        onClick={() => setParam('done', open ? null : '1')}
        className="inline-flex items-center gap-2 pt-6 pb-2 text-md font-medium text-fg-dim"
      >
        <Chevron size={15} className="text-fg-mute" />
        Done and not mine
        {cards && <span className="tnum text-md text-fg-mute">{cards.length}</span>}
      </button>
      {open && cards?.length === 0 && <p className="text-sm text-fg-mute h-11 flex items-center">Nothing taken off</p>}
      {open && !!cards?.length && (
        <ul className="-mx-4">
          {cards.map(c => (
            <li key={c.group_key} className="flex items-center gap-3 px-4 min-h-[60px] border-b border-rule">
              <div className="min-w-0 grow py-2">
                <div className="text-base text-fg-dim truncate">{c.title}</div>
                <div className="text-sm text-fg-mute truncate">{doneWord(c)} · {sourceWords(c)}</div>
              </div>
              <Button size="md" variant="ghost" title="Bring it back" onClick={() => void restore(c)}>
                <RotateCcw size={15} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
