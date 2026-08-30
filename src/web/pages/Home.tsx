/**
 * Desk.
 *
 * One flat table of everything on him — Title, Status, Kind, Due — searched,
 * filtered, paginated, with a resizable detail pane beside it.
 *
 * It used to be four chapters — three named after the machine's own guess at
 * how urgent a card was, each with its own eyebrow and count, and a fourth
 * collapsed underneath them for what had been finished. Those names are gone
 * from the product. A guess about urgency printed as a heading reads as a
 * decision he made, and it was not one; where a card stands is a value he sets
 * now, and one table shows every card whatever that value is. So finished work
 * is a filter rather than a chapter.
 *
 * Four filter axes, all of them in the URL: source, search, due, priority,
 * status. Because none of them is component-local tab state, they compose the
 * same way on the All tab and inside a source tab, which is the whole
 * requirement — you can be in Slack, at Urgent, overdue, on page 2, and put all
 * of that in a bookmark.
 *
 * Paging happens *after* search and filter, on the client, and the server keeps
 * sending the whole desk. That is deliberate: search has to span every row and
 * not the fifty currently visible, and at ~100 rows the whole desk is smaller
 * than one page of most APIs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Loader2 } from 'lucide-react'
import { actions, fetchNow, optimistic, reload, useStore } from '../lib/api'
import type { Card as CardT, CardPriority, CardStatus, SourceName } from '../lib/types'
import { PRIORITY_LABEL, PRIORITY_ORDER, STATUS_LABEL, STATUS_ORDER } from '../lib/types'
import { timeOfDay } from '../lib/time'
import {
  CardLine, CardRow, PANE_MIN, TABLE_MIN, TableCols, TableHead, maxPaneFor,
  useViewport, type DueSort, type RowAction,
} from '../components/CardTable'
import { CardDetail } from '../components/CardDetail'
import { TaskSheet } from '../components/TaskSheet'
import {
  Button, Empty, PAGE_SIZE, PageTitle, Pager, Select, inputClass, pageCount, pageSlice, useRail,
} from '../components/primitives'
import { SOURCE_LABEL } from '../components/sources'
import { cardKind, cleanChannel, SourceMark, whereOf } from '../components/kinds'
import { registerPaletteActions } from '../components/palette'
import { toast } from '../lib/toast'
import { useStill } from '../lib/motion'
import { overlayOpen, useOverlay } from '../lib/overlay'
import { closeDetail, openDetail, setParam, useDetailKey, useParams } from '../lib/route'

/**
 * Every source the tab strip offers, in a fixed order, always all five.
 *
 * They used to be re-sorted by connectedness on every render, which moved
 * controls under the finger as polls landed and pushed the one broken source off
 * the right edge of a 390px screen — so Gmail, the source that was not
 * connected, did not exist on the device he checks at 7am. Hiding the broken
 * thing is how the broken thing stops getting fixed.
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
 * `state?.cards ?? []` builds a fresh array on every render, which makes every
 * `useMemo` keyed on it recompute, which makes the effect that registers this
 * page's palette actions re-run, which re-renders the shell — a loop that took
 * React's "maximum update depth" error to notice.
 */
const NO_CARDS: CardT[] = []

const DUE_OPTIONS = [
  { id: 'any', label: 'Any date' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'none', label: 'No date' },
] as const
type DueFilter = typeof DUE_OPTIONS[number]['id']

const DAY = 864e5

/** Local start of tomorrow — the boundary `today` and `week` are measured from. */
const endOfToday = (now: number) => {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/** The pane's remembered width. Never allowed to be the reason nothing renders. */
const PANE_KEY = 'wake:pane'
const SHEET_KEY = 'wake:sheet'

function readNumber(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : fallback
  } catch {
    return fallback
  }
}

function writeNumber(key: string, value: number) {
  try { localStorage.setItem(key, String(value)) } catch { /* private mode */ }
}

const isSettledFilter = (s: string) => s === 'done' || s === 'wont_do'

/**
 * What Done and Won't-do took away, reached through the same table.
 *
 * They are not in `state.cards` — the desk is what is still on him — so asking
 * the Status filter for one of them changes where the rows come from rather
 * than which of them survive. That is the whole replacement for the collapsed
 * fourth chapter this page used to carry: no separate section, no second row
 * shape, and no restore button of its own, because the control that took a card
 * off the list is sitting on the row that will put it back.
 *
 * `version` is what a write bumps. The server owns this list, and a status
 * changed from inside it has to be re-read rather than patched locally.
 *
 * `null` while it is being read, and an array once it has answered — including
 * an empty array, which is a different fact from "not asked yet". Everything on
 * this page that clamps a range against `rows.length` has to know which of the
 * two it is looking at, or it clamps against a list that does not exist yet.
 */
function useHiddenCards(active: boolean, version: number) {
  const [cards, setCards] = useState<CardT[] | null>(null)
  useEffect(() => {
    if (!active) return setCards(null)
    let live = true
    actions.doneCards()
      .then(d => { if (live) setCards(d.cards) })
      .catch(() => { if (live) setCards(NO_CARDS) })
    return () => { live = false }
  }, [active, version])
  return cards
}

export function Home() {
  const { state } = useStore()
  const width = useViewport()
  const p = useParams(['src', 'q', 'due', 'pri', 'status', 'page', 'sort'])
  const filter = (p.src ?? 'all') as SourceName | 'all'
  const query = p.q ?? ''
  const due = (p.due ?? 'any') as DueFilter
  const pri = p.pri ?? 'any'
  const status = p.status ?? 'any'
  const page = Math.max(1, Number(p.page) || 1)
  // Read through a whitelist rather than cast: `?sort=` is a string a person
  // can type, and an unrecognised one has to mean the default order rather than
  // an order nothing implements.
  const sort: DueSort = p.sort === 'due' || p.sort === '-due' ? p.sort : null
  const selectedKey = useDetailKey()
  const [taskFrom, setTaskFrom] = useState<CardT | null>(null)
  /**
   * `null` until someone actually navigates.
   *
   * Defaulting to 0 meant the first row was highlighted before anyone chose it,
   * and — worse — a stray `e` completed something the reader had not selected.
   */
  const [cursor, setCursor] = useState<number | null>(null)
  /** Bumped by every status write, so a settled list re-reads itself. */
  const [written, setWritten] = useState(0)

  const settled = isSettledFilter(status)
  const hidden = useHiddenCards(settled, written)
  const cards = settled ? (hidden ?? NO_CARDS) : (state?.cards ?? NO_CARDS)
  /**
   * Whether the list this page is standing over has actually answered.
   *
   * Both sources arrive over the wire — the desk in `/api/state`, the settled
   * list in its own read — and both are an empty array until they do. That is
   * indistinguishable from a list that really is empty unless it is asked
   * separately, which is why this is a third value rather than `rows.length`.
   */
  const loaded = settled ? hidden !== null : state !== null

  /**
   * Five predicates over one list, composed in a fixed order.
   *
   * Each reads exactly one URL parameter, so none of them can know about any of
   * the others — which is what makes "the source tab and the priority filter
   * both apply" true by construction rather than by remembering to write it.
   */
  const matchSource = useCallback(
    (c: CardT) => filter === 'all' || c.sources.some(s => s.source === filter),
    [filter],
  )

  /**
   * Search spans every column the table dropped, not just the two it kept.
   *
   * Why, who, channel, repo, project, excerpt and every account a group was
   * seen under. Those facts left the table; they did not stop being how he
   * remembers a row.
   */
  const matchQuery = useCallback((c: CardT) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    const lead = c.sources[0]
    const channel = c.meta?.channel ?? lead?.meta?.channel
    const hay = [
      c.title, c.why, c.who, c.actor, c.excerpt,
      cardKind(c).word,
      whereOf(lead, c),
      channel ? cleanChannel(String(channel)) : null,
      STATUS_LABEL[c.status],
      ...c.sources.map(s => s.account ?? ''),
      ...c.sources.map(s => SOURCE_LABEL[s.source]),
    ]
    return hay.some(v => v && String(v).toLowerCase().includes(q))
  }, [query])

  const matchDue = useCallback((c: CardT) => {
    if (due === 'any') return true
    if (due === 'none') return c.due_at === null
    if (c.due_at === null) return false
    const now = Date.now()
    if (due === 'overdue') return c.due_at < now
    if (due === 'today') return c.due_at < endOfToday(now)
    return c.due_at < endOfToday(now) + 6 * DAY
  }, [due])

  const matchPriority = useCallback(
    (c: CardT) => pri === 'any' || c.priority === Number(pri),
    [pri],
  )

  const matchStatus = useCallback(
    (c: CardT) => status === 'any' || c.status === status,
    [status],
  )

  /**
   * Filtered, then ordered — and the order is the sixth thing in the URL.
   *
   * The five predicates decide which rows exist; this decides where they sit,
   * and it has to happen here rather than inside the table because the page
   * slice, the palette's eight entries and the j/k cursor all index this list.
   * Sorting the visible page instead would put "the soonest thing due" at the
   * top of page 1 and a second, unrelated soonest thing at the top of page 2.
   *
   * A card with no deadline is not the earliest and not the latest; it has no
   * position on this axis at all, so it sits after everything that does in both
   * directions. Sending it to the front of "latest first" would answer "what is
   * furthest out" with sixty rows that were never due.
   */
  const rows = useMemo(
    () => {
      const kept = cards
        .filter(matchSource)
        .filter(matchQuery)
        .filter(matchDue)
        .filter(matchPriority)
        .filter(matchStatus)
      if (!sort) return kept
      const dir = sort === '-due' ? -1 : 1
      // In place is safe — every `.filter` above already handed back a fresh
      // array, so the store is never the thing being reordered. `sort` is
      // stable, so rows sharing a date keep the order they arrived in.
      return kept.sort((a, b) =>
        a.due_at === null || b.due_at === null
          ? Number(a.due_at === null) - Number(b.due_at === null)
          : (a.due_at - b.due_at) * dir,
      )
    },
    [cards, matchSource, matchQuery, matchDue, matchPriority, matchStatus, sort],
  )

  const pages = pageCount(rows.length)
  const pageRows = useMemo(() => pageSlice(rows, page), [rows, page])

  /**
   * The pane's resting state is the top row's detail, not the words "No
   * selection" in a 400×855 void — 27.8% of the viewport, every morning, until
   * something is clicked. At 7am there is always a most-likely thing.
   *
   * An explicit close is different from never having chosen, and that is the
   * whole close-button fix: `''` is the address bar saying "he closed it", and
   * it yields an empty pane column that stays empty. `null` — a fresh visit —
   * still gets the top row. Both halves have to be true at once, which is why
   * no amount of local state in the pane could fix this on its own.
   */
  const selected = useMemo(
    () => rows.find(c => c.group_key === selectedKey) ?? null,
    [rows, selectedKey],
  )
  const shown = selectedKey === '' ? null : (selected ?? rows[0] ?? null)
  const isTable = width >= TABLE_MIN
  const hasPane = width >= PANE_MIN

  /* ------------------------------- the pane ------------------------------- */

  const [paneW, setPaneW] = useState(() => readNumber(PANE_KEY, 400))
  const paneWidth = Math.min(Math.max(paneW, 320), Math.min(720, maxPaneFor(width)))
  const dragging = useRef(false)

  const onGrab = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    // Measured from the right edge, because that is the edge the pane is pinned
    // to; measuring the delta from the grab point drifts once the clamp bites.
    setPaneW(Math.round(window.innerWidth - e.clientX))
  }
  const onRelease = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    writeNumber(PANE_KEY, paneWidth)
  }

  /* ------------------------------- actions -------------------------------- */

  /** Remove locally first so the list closes under the thumb immediately. */
  const drop = (g: string) =>
    optimistic(s => {
      s.cards = s.cards.filter(c => c.group_key !== g)
      // The three legacy splits are still on the wire for one release and the
      // phone's badge still counts one of them, so a card removed here has to
      // leave them too or the number sits a poll behind the list.
      s.now = s.now.filter(c => c.group_key !== g)
      s.open = s.open.filter(c => c.group_key !== g)
      s.parked = s.parked.filter(c => c.group_key !== g)
      return s
    })

  /**
   * Status and due date, each with a way back.
   *
   * The undo names the field it is putting back rather than clearing
   * everything: `actions.restore(g)` with no second argument drops every
   * suppression on the card, which is right for "bring this back" out of the
   * settled list and wrong for an undo, because it also destroys a due date or
   * a pin the action never touched.
   */
  const undoable = (c: CardT, text: string, undo: 'status') =>
    toast(text, {
      label: 'Undo',
      run: async () => {
        await actions.restore(c.group_key, undo)
        setWritten(v => v + 1)
        await reload()
      },
    })

  const setStatus = async (c: CardT, next: CardStatus) => {
    // A card that settles leaves the desk entirely; one that merely moves along
    // stays where it is, so the row updates under the pointer instead of
    // jumping. The exception is the settled list itself, which is server-owned
    // and re-read rather than patched.
    if (isSettledFilter(next)) {
      if (!settled) drop(c.group_key)
      if (c.group_key === selectedKey) closeDetail()
    } else {
      optimistic(s => {
        const x = s.cards.find(i => i.group_key === c.group_key)
        if (x) x.status = next
        return s
      })
    }
    await actions.setStatus(c.group_key, next)
    setWritten(v => v + 1)
    undoable(c, next === 'done' ? 'Done.' : `${STATUS_LABEL[next]}.`, 'status')
    void reload()
  }

  const setDue = async (c: CardT, at: number | null) => {
    optimistic(s => {
      const x = s.cards.find(i => i.group_key === c.group_key)
      if (x) x.due_at = at
      return s
    })
    await actions.setDue(c.group_key, at)
    setWritten(v => v + 1)
    void reload()
  }

  const rowActions: RowAction = {
    onOpen: c => openDetail(c.group_key),
    onStatus: (c, s) => void setStatus(c, s),
    onDue: (c, at) => void setDue(c, at),
  }

  /**
   * j/k over the *filtered* list, Enter to open, e to finish.
   *
   * The cursor indexes every matching row rather than the visible page, and the
   * page follows it — otherwise `j` on the last row of a page moves a selection
   * onto a row nobody can see, which is worse than doing nothing.
   *
   * Inert while any modal is open. The handler is bound to `document` and used
   * to skip only INPUT / TEXTAREA / contentEditable — a `role="dialog"` panel is
   * none of those, so `e` marked a card Done straight through an open sheet, and
   * the undo toast rendered underneath the scrim where it could not be reached.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen()) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable)) return
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
      else if (e.key === 'e') { e.preventDefault(); void setStatus(card, 'done') }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [rows, cursor, selectedKey])

  // The page follows the cursor rather than trapping it.
  useEffect(() => {
    if (cursor === null) return
    const want = Math.floor(cursor / PAGE_SIZE) + 1
    if (want !== page) setParam('page', want === 1 ? null : String(want))
  }, [cursor, page])

  // A shrinking list must not leave the cursor past the end, nor the reader on
  // a page that no longer exists.
  useEffect(() => {
    setCursor(c => (c === null ? null : Math.min(c, Math.max(rows.length - 1, 0))))
  }, [rows.length])
  /**
   * And it waits for the list before it decides that a page is past the end.
   *
   * Every mount runs this effect once with no cards in hand: `state` is null
   * until `/api/state` lands, so `rows.length` is 0, `pageCount` answers 1, and
   * a perfectly valid `?page=3` was rewritten to `/` about 40ms after load —
   * before any row existed to be counted. A reloaded page-3 landed on page 1
   * and the bookmark was destroyed on the way. `loaded` is the difference
   * between "there is no page 3" and "nobody has answered yet"; only the first
   * of those is a reason to move the reader.
   */
  useEffect(() => {
    if (!loaded) return
    if (page > pages) setParam('page', pages === 1 ? null : String(pages))
  }, [loaded, page, pages])

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

  /**
   * A filter that matches nothing is one line.
   *
   * Not a heading and a count and an apology. One word, with no source name
   * appended either — the pressed tab already names the source, so the suffix
   * restates the question inside the answer.
   */
  const list = (
    <div className="min-w-0 grow pad-x pb-24 lg:pb-8">
      <Header count={rows.length} />
      <SourceTabs value={filter} state={state} />
      <FilterRow query={query} due={due} pri={pri} status={status} />

      {rows.length === 0 ? (
        <Empty>Nothing</Empty>
      ) : isTable ? (
        <>
          <table className="w-full table-fixed border-collapse">
            <TableCols />
            {/* Re-ordering does not change which rows exist, but it does change
                which of them page 3 holds — and the reader who just asked what
                is due soonest wants the top of the answer, not row 101 of it. */}
            <TableHead
              sort={sort}
              onSort={next => { setParam('sort', next); setParam('page', null) }}
            />
            <tbody>
              {pageRows.map(c => (
                <CardRow
                  key={c.group_key} card={c}
                  selected={c.group_key === selectedKey}
                  focused={cursor !== null && rows[cursor]?.group_key === c.group_key}
                  actions={rowActions}
                />
              ))}
            </tbody>
          </table>
          <Pager page={page} pages={pages} total={rows.length}
            onPage={n => setParam('page', n === 1 ? null : String(n))} />
        </>
      ) : (
        <>
          <ul>
            {pageRows.map(c => (
              <CardLine key={c.group_key} card={c}
                selected={c.group_key === selectedKey} actions={rowActions} />
            ))}
          </ul>
          <Pager page={page} pages={pages} total={rows.length}
            onPage={n => setParam('page', n === 1 ? null : String(n))} />
        </>
      )}
    </div>
  )

  /*
   * Below the pane width the detail is a bottom sheet with a drag handle, not a
   * full-screen takeover.
   *
   * The takeover it replaces returned *instead of* the list, so reading four
   * rows in sequence was four closes and four finds; and the sheet before that
   * was 963px of content in a 725px scroller that drag-dismissed on the same
   * axis as its own scroll. The list stays mounted underneath this one, which
   * is the whole difference — and it is only offered once a row has actually
   * been chosen, because a sheet over the list on arrival is a takeover with a
   * handle on it.
   */
  const sheet = !hasPane && selectedKey && shown
    ? <PushDetail card={shown} onMakeTask={setTaskFrom} taskFrom={taskFrom} />
    : null

  return (
    <div className="lg:flex lg:items-stretch lg:min-h-dvh">
      {list}
      {sheet}
      {/*
        The pane column always exists at the pane width, so opening a row never
        re-lays out the list. No fill: `bg-ink-850` is pure white in light mode,
        which put a 400px white panel on a grey page on the product's main
        screen. A left hairline is the whole edge it needs.
      */}
      <aside
        style={{ width: paneWidth }}
        className="hidden xl:block relative xl:shrink-0 edge-l xl:sticky xl:top-0 xl:h-dvh"
      >
        {/* Six pixels of grab, sitting over the hairline rather than beside it,
            so the edge the eye sees and the edge the hand finds are one edge. */}
        <div
          role="separator" aria-orientation="vertical" aria-label="Resize the detail pane"
          onPointerDown={onGrab} onPointerMove={onDrag}
          onPointerUp={onRelease} onPointerCancel={onRelease}
          className="grabber absolute -left-[3px] top-0 h-full w-[6px] z-20 hover:bg-ink-600"
        />
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
 * The phone and narrow-laptop detail.
 *
 * A bottom sheet with two snap heights rather than a full-screen view: the list
 * stays visible above it, which is what makes reading four rows in a row one
 * gesture instead of twelve. It snaps rather than resting anywhere, because a
 * freely-dragged sheet is a control that has to be re-aimed every time.
 *
 * `useOverlay(true)` is load-bearing and not decoration. `overlay.ts` exists
 * precisely because `e` — destructive and unconfirmed — leaked through open
 * modals; this view was added afterwards and never counted itself, so on a
 * laptop at half screen `e` finished the *cursor* card rather than the one being
 * read, and the undo toast rendered under the `z-50` overlay.
 */
function PushDetail({
  card, taskFrom, onMakeTask,
}: { card: CardT; taskFrom: CardT | null; onMakeTask: (c: CardT | null) => void }) {
  useOverlay(true)
  const still = useStill()
  const [tall, setTall] = useState(() => readNumber(SHEET_KEY, 0) === 1)

  const snap = (next: boolean) => { setTall(next); writeNumber(SHEET_KEY, next ? 1 : 0) }

  /**
   * Two heights, and both ways of asking for them.
   *
   * A drag past 24px snaps to whichever height it was heading for; anything
   * shorter is a tap, which toggles. `dragged` is what keeps the two apart —
   * `onClick` fires after every `onPointerUp`, so without it a drag would snap
   * and then immediately toggle back.
   *
   * It snaps rather than resting wherever it is let go, because a sheet that
   * can be any height is a control that has to be re-aimed every time it opens.
   *
   * **The sheet follows the finger while the finger is down.** It held `92dvh`
   * through every `pointermove` and changed only on release, so the one direct
   * manipulation in the product gave no sign it had been noticed until it was
   * over: you drag a dead handle, let go, and the panel teleports. `held` is
   * the live pixel height and it is dropped on release, so the resting height
   * goes back to being a `dvh` that follows the viewport rather than a pixel
   * count that was true once.
   *
   * Its ceiling is read off the element rather than recomputed here. The sheet
   * is capped by a `max-height` that keeps the tab bar and a row of the list
   * showing, and that cap is lower than the tall snap on a phone — a drag
   * clamped to `92dvh` would have spent its last 50px moving nothing, which is
   * the same dead handle in a smaller place.
   */
  const from = useRef<number | null>(null)
  const dragged = useRef(false)
  const grip = useRef({ height: 0, min: 0, max: 0 })
  const [held, setHeld] = useState<number | null>(null)

  const height = held !== null ? `${held}px` : tall ? '92dvh' : '55dvh'

  return createPortal(
    <div
      /*
       * It stops above the phone's tab bar rather than on the bottom edge.
       *
       * At `bottom: 0` a 55dvh sheet covered all six destinations — every one of
       * them measured unreachable with `elementFromPoint`, and no bar was even
       * visible to explain why. This is a push sheet and not a modal: the list
       * stays live underneath it, so the shell has to stay live under that. The
       * cap keeps a row of the list showing at the tall snap too, which is the
       * whole reason the sheet is not a takeover.
       *
       * From `sm` up `--nav-h` is only the home indicator, which is what the
       * sheet's own `pad-bottom` used to supply — so that class goes with it,
       * or the indicator's height is reserved twice.
       */
      style={{
        height,
        bottom: 'var(--nav-h)',
        maxHeight: 'calc(100dvh - var(--nav-h) - 44px)',
      }}
      /* No transition while the finger is down — the drag is the animation, and
         easing it would leave the sheet a frame or two behind the thumb. On
         release it travels to the snap instead of jumping to it.
         Gated on `useStill` like every other motion here: a height transition
         needs frames, and a headless pane produces none, so an ungated one
         leaves the sheet frozen at the height it was let go from. */
      className={`fixed inset-x-0 z-50 bg-ink-900 edge-t flex flex-col
                  ${held === null && !still ? 'transition-[height] duration-200 ease-out-quint' : ''}`}
    >
      <button
        onPointerDown={e => {
          from.current = e.clientY
          dragged.current = false
          const sheet = e.currentTarget.parentElement
          const vh = window.innerHeight
          const min = vh * 0.55
          // `max-height` computes to a pixel length, so the cap the sheet is
          // actually under can be read rather than re-derived from `--nav-h`.
          const cap = sheet ? parseFloat(getComputedStyle(sheet).maxHeight) : NaN
          grip.current = {
            height: sheet?.getBoundingClientRect().height ?? min,
            min,
            max: Math.max(min, Math.min(vh * 0.92, Number.isFinite(cap) ? cap : Infinity)),
          }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => {
          if (from.current === null) return
          const dy = e.clientY - from.current
          if (Math.abs(dy) > 8) dragged.current = true
          const { height: h0, min, max } = grip.current
          setHeld(Math.min(max, Math.max(min, h0 - dy)))
        }}
        onPointerUp={e => {
          const start = from.current
          from.current = null
          setHeld(null)
          if (start === null) return
          const dy = e.clientY - start
          if (Math.abs(dy) > 24) snap(dy < 0)
        }}
        // A pointer the system takes away mid-drag still has to put the height
        // back on a snap, or it rests at whatever pixel the last move wrote.
        onPointerCancel={() => { from.current = null; setHeld(null) }}
        onClick={() => { if (!dragged.current) snap(!tall) }}
        aria-label={tall ? 'Shrink the panel' : 'Grow the panel'}
        className="hit relative shrink-0 h-6 flex items-center justify-center touch-none cursor-row-resize"
      >
        <span className="block w-10 h-1 rounded-full bg-ink-600" />
      </button>
      <CardDetail card={card} onClose={closeDetail}
        onMakeTask={c => { closeDetail(); onMakeTask(c) }} />
      <TaskSheet open={!!taskFrom} onClose={() => onMakeTask(null)} fromCard={taskFrom} />
    </div>,
    document.body,
  )
}

/* --------------------------------- chrome --------------------------------- */

/**
 * The title row: what this is, how much of it there is, and the one control
 * that changes what exists.
 *
 * Fetch sits here rather than in the filter row beneath it, and the separation
 * is the point — everything in the filter row narrows what you see, and this
 * changes what there is to see. It is also the only row on the page that cannot
 * scroll sideways on a phone, which is where a control worth pressing belongs.
 *
 * The mark rides this row on a phone and nowhere else — `PageTitle` owns that
 * rule now, for all six routes rather than for the two that remembered it.
 */
function Header({ count }: { count?: number }) {
  return (
    <header className="pt-4 pb-2 flex items-center gap-3">
      <PageTitle>Desk</PageTitle>
      {count !== undefined && <span className="tnum text-sm text-fg-mute">{count}</span>}
      <span className="ml-auto shrink-0"><Fetch /></span>
    </header>
  )
}

/**
 * All / Slack / Gmail / GitHub / Sentry / Claude, as a real tab strip.
 *
 * A strip with a rule under it and `aria-selected` on the pressed one, rather
 * than six lozenges: a lozenge row reads as six filters that could be combined,
 * and this is one choice of six. Everything below it — search, due, priority,
 * status — composes *with* whichever tab is selected, because all of it lives in
 * the URL rather than inside this component.
 *
 * All five sources, always, in one fixed order, never disabled and never
 * reordered. Each carries the mark its rows already carry in the Kind column, so
 * the strip is readable on a device that cannot hover. A source whose last poll
 * failed draws that mark at a quarter weight with the reason on `title`; a
 * source with no credential gets the same treatment with a different reason.
 * That is the only sync mark on this page.
 *
 * The strip scrolls on a phone rather than wrapping. Six tabs need more than
 * 358px whatever is done to them, and a second line of tabs pushes the first row
 * of the list off the fold — so it fades at the right edge while there is more
 * past it, because a tab sliced in half by the screen edge reads as a bug and
 * not as more. A scrolling strip also clips its children's overflow, which is
 * what took `.hit`'s vertical outset off every tab in it; the tab is 44px in its
 * own right on a phone rather than borrowing one it cannot keep.
 */
function SourceTabs({
  value, state,
}: {
  value: SourceName | 'all'
  state: { lastSync: Array<{ source: string; ok: number; connected: number; error: string | null }> }
}) {
  const runs = new Map(state.lastSync.map(r => [r.source, r]))

  const wordFor = (s: SourceName) => {
    const r = runs.get(s)
    if (!r || !r.connected) return 'not connected'
    if (!r.ok) return 'sync failed'
    return null
  }

  const tab = (active: boolean) =>
    `hit relative inline-flex items-center gap-2 h-11 sm:h-9 px-2 text-sm whitespace-nowrap
     border-b-2 -mb-px transition-colors duration-100
     ${active
       ? 'border-accent text-fg font-medium'
       : 'border-transparent text-fg-mute font-medium hover:text-fg-dim'}`

  const rail = useRail<HTMLDivElement>()

  return (
    <div className="rail" data-spill={rail.spill || undefined}>
      <div ref={rail.ref}
        className="flex items-center gap-4 border-b border-edge overflow-x-auto no-scrollbar">
        <button aria-selected={value === 'all'} role="tab" className={tab(value === 'all')}
          onClick={() => { setParam('src', null); setParam('page', null) }}>
          All
        </button>
        {FILTERS.map(s => {
          const bad = wordFor(s)
          return (
            <button
              key={s}
              role="tab"
              aria-selected={value === s}
              className={tab(value === s)}
              title={bad ? `${SOURCE_LABEL[s]} · ${bad}${runs.get(s)?.error ? ` — ${runs.get(s)!.error}` : ''}` : SOURCE_LABEL[s]}
              onClick={() => { setParam('src', value === s ? null : s); setParam('page', null) }}
            >
              <SourceMark source={s} failed={!!bad} />
              {/* The name from `sm` up, where six of them fit. On a phone the six
                  marks are the strip, and the pressed one keeps its name so the
                  answer to "which am I in" never needs a hover. */}
              <span className={value === s ? '' : 'hidden sm:inline'}>{SOURCE_LABEL[s]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Search, and the three closed sets.
 *
 * One row under the tabs. Everything here narrows what you see and none of it
 * changes what exists — which is why Fetch sits up on the tab row instead,
 * behind a spacer, where it cannot be mistaken for a fourth filter.
 *
 * Each control writes one URL parameter and resets the page, because page 4 of
 * a list you just re-filtered is a page that may not exist.
 *
 * It wraps rather than scrolls on a phone. Four controls need about 450px and
 * have 358; squeezed onto one line the three closed sets each rendered as `A…`,
 * which is three anonymous dropdowns, and scrolled sideways two of them are
 * simply not there. Search takes the first line and the three sets take the
 * second, which is exactly 346px of the 358 available.
 */
function FilterRow({
  query, due, pri, status,
}: { query: string; due: DueFilter; pri: string; status: string }) {
  const set = (k: string, v: string | null) => { setParam(k, v); setParam('page', null) }

  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      <input
        type="search"
        value={query}
        onChange={e => set('q', e.target.value || null)}
        placeholder="Search"
        aria-label="Search every column"
        className={`${inputClass} h-8 py-0 w-full sm:w-64`}
      />
      <Select
        value={due}
        options={DUE_OPTIONS}
        onChange={v => set('due', v === 'any' ? null : v)}
        ariaLabel="Filter by due date"
      />
      <Select
        value={pri}
        options={[{ id: 'any', label: 'Any priority' },
          ...PRIORITY_ORDER.map(v => ({ id: String(v), label: PRIORITY_LABEL[v] }))]}
        onChange={v => set('pri', v === 'any' ? null : v)}
        ariaLabel="Filter by priority"
      />
      <Select
        value={status}
        options={[{ id: 'any', label: 'Any status' },
          ...STATUS_ORDER.map(s => ({ id: s as string, label: STATUS_LABEL[s] }))]}
        onChange={v => set('status', v === 'any' ? null : v)}
        ariaLabel="Filter by status"
      />
    </div>
  )
}

/**
 * Pipe 2, as one control.
 *
 * Bordered rather than amber, and to the right of a spacer: everything left of
 * that spacer narrows what you see; this changes what exists. An amber control
 * in a filter row reads as a hero, and Fetch is a tool.
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
            is 22px this row does not have to spend. It comes back at the width
            where the tabs get their names. The busy state is still legible
            without it — the label is the indicator. */}
        <span className="hidden lg:inline-flex">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        </span>
        {/* One width for both words, so the row does not shift under the finger. */}
        <span className="w-14 text-left">{busy ? 'Fetching' : 'Fetch'}</span>
      </Button>
    </span>
  )
}
