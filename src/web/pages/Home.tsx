/**
 * Now.
 *
 * A table of everything on him, in one downward glance: what it is, the thing
 * itself, why it is on him, where, which source, when, and the one thing he can
 * do about it without opening anything.
 *
 * Above the first row there is a title and one chrome row, and nothing else.
 * Everything left of that row's spacer narrows what you see; the one thing right
 * of it — Fetch — changes what exists. Piles with nothing in them are not
 * rendered: `Now 0` plus the sentence under it cost 109px of the fold to report
 * a zero, and three of them stacked cost 331px of a 844px phone to say nothing
 * at all.
 *
 * The three piles are `<tbody>` groups of one table sharing one `<colgroup>`, so
 * the columns hold their x-position from the first row of Now to the last row of
 * Parked. `Done and not mine` sits collapsed at the bottom, in the same columns.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, Download, Loader2, RotateCcw } from 'lucide-react'
import { actions, fetchNow, optimistic, reload, useStore } from '../lib/api'
import type { Card as CardT, SourceName } from '../lib/types'
import { ago, atHour, timeOfDay } from '../lib/time'
import {
  CardLine, CardRow, columnsFor, colSpanOf, GroupHead, PANE_MIN, TABLE_MIN, TableCols, TableHead,
  useViewport, sourceWords, type Columns, type RowAction,
} from '../components/CardTable'
import { CardDetail } from '../components/CardDetail'
import { TaskSheet } from '../components/TaskSheet'
import { Button, Chip, Empty } from '../components/primitives'
import { SOURCE_LABEL } from '../components/sources'
import { SourceMark } from '../components/kinds'
import { registerPaletteActions } from '../components/palette'
import { toast } from '../lib/toast'
import { overlayOpen, useOverlay } from '../lib/overlay'
import { closeDetail, openDetail, setParam, useDetailKey, useParam } from '../lib/route'

/**
 * Every source the filter row offers, in a fixed order, always all five.
 *
 * They used to be re-sorted by connectedness on every render, which moved chips
 * under the finger as polls landed and pushed the one broken source off the
 * right edge of a 390px screen inside `overflow-x-auto no-scrollbar` — so Gmail,
 * the source that was not connected, did not exist on the device he checks at
 * 7am. Hiding the broken thing is how the broken thing stops getting fixed.
 *
 * They are filters over rows, not connection indicators, so none of them is ever
 * disabled either. A source whose last poll failed carries its own mark at a
 * quarter weight and the reason on `title`, and that is the only sync mark on
 * this page.
 */
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

export function Home() {
  const { state } = useStore()
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
  /**
   * The pane's resting state is the top row's detail, not the words "No
   * selection" in a 400×855 void — 27.8% of the viewport, every morning, until
   * something is clicked. At 7am there is always a most-likely thing.
   *
   * The keyboard cursor still starts at `null`, so nothing is destructible by
   * accident: showing a row is not selecting it.
   */
  const selected = useMemo(
    () => rows.find(c => c.group_key === selectedKey) ?? null,
    [rows, selectedKey],
  )
  const shown = selected ?? rows[0] ?? null
  const cols = columnsFor(width)
  const isTable = width >= TABLE_MIN
  const hasPane = width >= PANE_MIN

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

  // Nothing at all until the first read lands. A 200ms loader is worse than a
  // beat of nothing, and a sentence explaining that a page is loading is chrome
  // that teaches.
  if (!state) return <div className="pad-x pt-4"><Header /></div>

  const groups: Array<{ title: string; shown: CardT[]; total: number }> = [
    { title: 'Now', shown: fNow, total: now.length },
    { title: 'Open', shown: fOpen, total: open.length },
    { title: 'Parked', shown: fParked, total: parked.length },
  ]
  const live = groups.filter(g => g.shown.length > 0)

  /**
   * A filter that matches nothing anywhere is one line.
   *
   * Not three chapters and a count and a fourth heading. One word, with no
   * source name appended either — the chip above it is already pressed and
   * already names the source, so the suffix restates the question inside the
   * answer, and the phrase it would make is a banned one. `Done and not mine` is
   * not rendered here either: it is scoped to the same filter, so it opens to
   * either a different population than the filter implies or a second empty
   * state, and both are worse than absence.
   */
  const list = (
    <div className="min-w-0 grow pad-x pb-24 lg:pb-8">
      <Header />
      <FilterRow value={filter} state={state} />

      {live.length === 0 ? (
        <Empty>Nothing</Empty>
      ) : isTable ? (
        <table className="w-full table-fixed border-collapse">
          <TableCols cols={cols} />
          <TableHead cols={cols} />
          {live.map((g, i) => (
            <tbody key={g.title}>
              <GroupHead title={g.title} shown={g.shown.length} total={g.total} cols={cols}
                first={i === 0} />
              {g.shown.map(c => (
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
          {live.map(g => (
            <section key={g.title}>
              <div className="flex items-baseline gap-2 pt-6 pb-2">
                <h2 className="text-eyebrow uppercase text-fg-mute">{g.title}</h2>
                <span className="text-eyebrow uppercase tnum text-fg-mute">
                  {g.shown.length !== g.total ? `${g.shown.length} of ${g.total}` : g.shown.length}
                </span>
              </div>
              <ul>
                {g.shown.map(c => (
                  <CardLine key={c.group_key} card={c}
                    selected={c.group_key === selectedKey} actions={rowActions} />
                ))}
              </ul>
            </section>
          ))}
          <DoneList open={doneOpen} />
        </div>
      )}
    </div>
  )

  /*
   * Below the pane width the detail is a full-screen push view, not a bottom
   * sheet. The sheet was 963px of content in a 725px scroller that also
   * drag-dismissed on the same axis as its own scroll, and its last two actions
   * sat behind the tab bar. A push view fixes the clipping structurally and
   * makes the OS Back button close the detail instead of leaving Wake.
   */
  if (!hasPane && selected) {
    return <PushDetail card={selected} onMakeTask={setTaskFrom} taskFrom={taskFrom} />
  }

  return (
    <div className="lg:flex lg:items-stretch lg:min-h-dvh">
      {list}
      {/*
        The pane column always exists at the pane width, so opening a row never
        re-lays out the list. No fill: `bg-ink-850` is pure white in light mode,
        which put a 400px white panel on a grey page on the product's main
        screen. A left hairline is the whole edge it needs.
      */}
      <aside className="hidden xl:block xl:w-90 2xl:w-100 xl:shrink-0 xl:border-l xl:border-edge
                        xl:sticky xl:top-0 xl:h-dvh">
        {shown && (
          <CardDetail card={shown} onClose={closeDetail}
            onMakeTask={c => { closeDetail(); setTaskFrom(c) }} />
        )}
      </aside>
      <TaskSheet open={!!taskFrom} onClose={() => setTaskFrom(null)} fromCard={taskFrom} />
    </div>
  )
}

/**
 * The phone and narrow-laptop detail, and the bug it used to carry.
 *
 * `overlay.ts` exists precisely because `e` (Done) and `s` (Later) — both
 * destructive and both unconfirmed — leaked through open modals. This view was
 * added afterwards and never counted itself, so below the pane width, on a
 * laptop at half screen with a keyboard, `e` marked the *cursor* card done
 * rather than the one being read, and the undo toast rendered under the `z-50`
 * overlay. It counts itself now, which is what the module was written for.
 */
function PushDetail({
  card, taskFrom, onMakeTask,
}: { card: CardT; taskFrom: CardT | null; onMakeTask: (c: CardT | null) => void }) {
  useOverlay(true)
  return createPortal(
    <div className="fixed inset-0 z-50 bg-ink-900 flex flex-col pad-top pad-bottom">
      <CardDetail card={card} onClose={closeDetail}
        onMakeTask={c => { closeDetail(); onMakeTask(c) }} />
      <TaskSheet open={!!taskFrom} onClose={() => onMakeTask(null)} fromCard={taskFrom} />
    </div>,
    document.body,
  )
}

/* --------------------------------- chrome --------------------------------- */

function Header() {
  return (
    <header className="pt-4 pb-2">
      <h1 className="text-lg font-medium">Now</h1>
    </header>
  )
}

/**
 * The chrome row: what you see, then what exists.
 *
 * The filter lives in the URL. It used to live in `useState`, so a filtered view
 * could not be bookmarked and a refresh mid-triage lost his place.
 *
 * All five sources, always, in one fixed order, never disabled and never
 * reordered. Each carries the mark its rows already carry in the Kind column, so
 * the row is readable on a device that cannot hover. A source whose last poll
 * failed draws that mark at a quarter weight with the reason on `title`; a
 * source with no credential gets the same treatment with a different reason. That is the only sync mark on this page — `SyncLine`, a wrapping
 * five-clause paragraph at 12px that ended in amber and sat 424px below the
 * fold, is deleted rather than shortened. Failure belongs on the chip you are
 * about to press and on the row in Settings where you would go to fix it.
 */
function FilterRow({
  value, state,
}: { value: SourceName | 'all'; state: { lastSync: Array<{ source: string; ok: number; connected: number; error: string | null }> } }) {
  const runs = new Map(state.lastSync.map(r => [r.source, r]))

  const wordFor = (s: SourceName) => {
    const r = runs.get(s)
    if (!r || !r.connected) return 'not connected'
    if (!r.ok) return 'sync failed'
    return null
  }

  return (
    <div className="flex items-center gap-2 pb-2">
      <Chip active={value === 'all'} onClick={() => setParam('src', null)}>All</Chip>
      {FILTERS.map(s => {
        const bad = wordFor(s)
        return (
          <Chip
            key={s}
            active={value === s}
            /* Below the width that fits five names, a chip carries either its
               mark or its name and never both — and the one with a name is the
               one that is pressed. Both together is 41–86px per chip on a row
               that has 358 to spend on eight controls, which is how a filtered
               phone ended up 71px wider than the screen. */
            flexible={value === s}
            mark={
              <span className={value === s ? 'hidden lg:inline-flex' : 'inline-flex'}>
                <SourceMark source={s} failed={!!bad} />
              </span>
            }
            title={bad ? `${SOURCE_LABEL[s]} · ${bad}${runs.get(s)?.error ? ` — ${runs.get(s)!.error}` : ''}` : SOURCE_LABEL[s]}
            ariaLabel={SOURCE_LABEL[s]}
            onClick={() => setParam('src', value === s ? null : s)}
          >
            {/* Every name at `lg`, where all five fit; the pressed one's name at
                every width, truncating rather than pushing Fetch off the screen.
                The names used to appear from `sm`, where the row needs 612px and
                has 392 — the page scrolled sideways at 640 and 768. */}
            <span className={value === s ? 'truncate' : 'hidden lg:inline'}>{SOURCE_LABEL[s]}</span>
          </Chip>
        )
      })}
      <span className="grow" />
      <Fetch />
    </div>
  )
}

/**
 * Pipe 2, as one control.
 *
 * Bordered rather than amber, and to the right of a spacer: everything left of
 * that spacer narrows what you see; this changes what exists. An amber chip in a
 * filter row reads as a hero, and Fetch is a tool.
 *
 * Pressing it blocks nothing. Triage continues while it runs, because Fetch only
 * ever adds. A second press is never disabled and never scolded — it re-runs,
 * dedups, and answers `0 new`, which is a useful answer where "please wait" is
 * chrome that teaches. The label swaps to `Fetching` and the control does not
 * change width, so nothing on the page moves.
 */
function Fetch() {
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<{ text: string; title?: string } | null>(null)

  const run = async () => {
    setBusy(true)
    try {
      const r = await fetchNow()
      const asked = r.connectors.filter(c => c.via !== 'none')
      const quiet = asked.filter(c => !c.ok).map(c => c.name)
      setLine({
        text: [
          `Fetched ${r.found}`,
          `${r.fresh} new`,
          quiet.length ? `${quiet.join(' and ')} didn't answer` : null,
          timeOfDay(Date.now()),
        ].filter(Boolean).join(' · '),
        title: asked.map(c => `${c.name}: ${c.error ?? `${c.count} via ${c.via}`}`).join('\n'),
      })
      await reload()
    } catch (e) {
      setLine({ text: `Fetch failed · ${timeOfDay(Date.now())}`, title: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="flex items-center gap-3 shrink-0">
      {line && !busy && (
        <span className="hidden sm:inline text-sm text-fg-mute tnum truncate" title={line.title}>
          {line.text}
        </span>
      )}
      <Button size="md" variant="default" onClick={() => void run()} disabled={busy}
        title="Ask every connector this machine can reach what is on you">
        {/* The word is the control; the glyph is decoration, and on a phone it
            is 22px of a 358px row that six filters and this have to share. It
            comes back at the width where the filters get their names. The busy
            state is still legible without it — the label is the indicator. */}
        <span className="hidden lg:inline-flex">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        </span>
        {/* One width for both words, so the row does not shift under the finger. */}
        <span className="w-14 text-left">{busy ? 'Fetching' : 'Fetch'}</span>
      </Button>
    </span>
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
        <td colSpan={colSpanOf(cols)} className="pt-6 pb-2">
          <button
            onClick={() => setParam('done', open ? null : '1')}
            className="inline-flex items-center gap-2 text-eyebrow uppercase
                       text-fg-mute hover:text-fg-dim transition-colors duration-100"
          >
            <Chevron size={13} />
            Done and not mine
            {cards && <span className="text-eyebrow uppercase tnum">{cards.length}</span>}
          </button>
        </td>
      </tr>
      {/* The real columns, not a second table wearing the first one's headers.
          `doneWord` used to land in KIND, the title spanned three columns, and
          the source names landed left-aligned in the right-aligned WHEN column. */}
      {open && cards?.map(c => (
        <tr key={c.group_key} className="border-b border-rule">
          <td className="py-3 pr-4 text-sm text-fg-mute align-middle truncate">{doneWord(c)}</td>
          <td className="py-3 pr-4 text-base text-fg-dim align-middle truncate">{c.title}</td>
          {cols.why && <td className="py-3 pr-4 text-sm text-fg-mute align-middle truncate">{c.why}</td>}
          {cols.where && <td className="py-3 pr-4 text-sm text-fg-mute align-middle truncate font-mono">{sourceWords(c)}</td>}
          <td />
          <td className="py-3 pr-4 text-sm text-fg-mute align-middle tnum text-right">{ago(c.ts)}</td>
          <td className="py-1 pr-0 align-middle text-right">
            <Button size="sm" variant="ghost" title="Bring it back" ariaLabel="Bring it back"
              onClick={() => void restore(c)}>
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
        className="inline-flex items-center gap-2 pt-6 pb-2 text-eyebrow uppercase text-fg-mute"
      >
        <Chevron size={13} />
        Done and not mine
        {cards && <span className="text-eyebrow uppercase tnum">{cards.length}</span>}
      </button>
      {open && !!cards?.length && (
        <ul>
          {cards.map(c => (
            <li key={c.group_key} className="flex items-center h-11 border-b border-rule">
              <span className="text-base text-fg-dim truncate grow min-w-0">{c.title}</span>
              <span className="text-sm text-fg-mute shrink-0 pl-3">{doneWord(c)}</span>
              <span className="pl-2 shrink-0">
                <Button size="sm" variant="ghost" title="Bring it back" ariaLabel="Bring it back"
                  onClick={() => void restore(c)}>
                  <RotateCcw size={14} />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
