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
 * same way on the Tasks tab and inside a source tab, which is the whole
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
import { ChevronLeft, ChevronRight, Download, Loader2, Plus, SlidersHorizontal } from 'lucide-react'
import { actions, fetchNow, optimistic, reload, useStore } from '../lib/api'
import type { Card as CardT, CardPriority, CardStatus, SourceName, Task } from '../lib/types'
import { PRIORITY_LABEL, PRIORITY_ORDER, STATUS_LABEL, STATUS_ORDER } from '../lib/types'
import { timeOfDay } from '../lib/time'
import {
  CardList, CardRow, COLUMNS_MIN, PANE_MIN, PhoneTable, TABLE_MIN, TableCols, TableHead,
  maxPaneFor, titleOf, useViewport, type DueSort, type RowAction,
} from '../components/CardTable'
import { CardDetail } from '../components/CardDetail'
import { Sync, useResultLine } from '../components/sync'
import { TaskRead, TaskSheet } from '../components/TaskSheet'
import {
  Button, CountBadge, Field, PAGE_SIZE, PageTitle, Pager, Select, Sheet, inputClass,
  pageCount, pageSlice, useRail,
} from '../components/primitives'
import { SOURCE_LABEL } from '../components/sources'
import { cardKind, cleanChannel, contextLine, SourceMark, whereOf } from '../components/kinds'
import { bucketsOf, inBucket, pipesFor } from '../lib/bucket'
import { registerPaletteActions } from '../components/palette'
import { toast } from '../lib/toast'
import { overlayOpen, useOverlay } from '../lib/overlay'
import { openSwipeKey } from '../lib/swipe'
import { taskFromCard } from '../lib/taskFrom'
import { isTaskRow, taskIdOf, taskRow, taskRowKey } from '../lib/taskRow'
import { recreateTask } from './Work'
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
 * Where the desk's rows come from, which is six answers and not five.
 *
 * `tasks` is not a sixth source and it is no longer the absence of a filter
 * either — it is the other *table*. The first tab used to mean "no source
 * predicate", so it showed every card from every pipe: ~100 rows of other
 * people's systems under a heading that said `Tasks`, with not one thing he had
 * written down among them, because a task has never been a card. It shows the
 * `tasks` table now, adapted to the row shape by `lib/taskRow.ts`.
 *
 * What that costs, stated plainly: there is no single view of every source at
 * once any more. It was the thing the first tab did and it is the thing the
 * first tab was named against, and one of the two had to go. Every card is
 * still one tap away on the source tab it belongs to, and `?src=` still holds
 * whichever that is.
 */
export type DeskTab = 'tasks' | SourceName

/** Stable empty task list, for the same reason `NO_CARDS` exists. */
const NO_TASKS: Task[] = []

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
  /*
   * Read through the source list rather than cast.
   *
   * `?src=` is a string a person can type, a phone can hold in its history and a
   * bookmark can carry — including `?src=all`, which every bookmark made before
   * this tab was renamed is carrying right now. Cast, that lands in `inBucket`
   * as a source name matching nothing and renders an empty desk with nothing on
   * screen to say why. Checked, an unrecognised value means what no value means:
   * no source filter. Same whitelist `sort` keeps four lines down, for the same
   * reason.
   */
  const tab: DeskTab = FILTERS.find(s => s === p.src) ?? 'tasks'
  /**
   * The tab as a *source*, which is what the chrome around the list wants.
   *
   * `Sync`, `Fetch` and the empty state are all scoped by pipe, and the Tasks
   * tab has no pipe — so this is `null` there, which is the value those three
   * already treat as "everything" and which `inBucket` already reads as "no
   * source predicate". Nothing downstream had to learn a sixth name.
   */
  const filter: SourceName | null = tab === 'tasks' ? null : tab
  const isTasks = tab === 'tasks'
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
  /** The `+ Task` button on the Tasks tab, opening an empty form. */
  const [newTask, setNewTask] = useState(false)
  /**
   * `null` until someone actually navigates.
   *
   * Defaulting to 0 meant the first row was highlighted before anyone chose it,
   * and — worse — a stray `e` completed something the reader had not selected.
   */
  const [cursor, setCursor] = useState<number | null>(null)
  /** Bumped by every status write, so a settled list re-reads itself. */
  const [written, setWritten] = useState(0)

  /**
   * The settled list is a *card* list, so the Tasks tab never asks for it.
   *
   * `GET /cards/done` exists because a finished card leaves `state.cards`
   * entirely — the desk is what is still on him. Nothing does that to a task:
   * `/state` sends the whole `tasks` table including the done and the
   * won't-done ones, so on this tab the Status filter is an ordinary predicate
   * over rows that are already in hand. Asking the server here would fetch a
   * hundred cards to render none of them.
   */
  const settled = !isTasks && isSettledFilter(status)
  const hidden = useHiddenCards(settled, written)
  const tasks = state?.tasks ?? NO_TASKS
  /**
   * Every task, as a desk row.
   *
   * Memoised on the task list itself rather than rebuilt per render: `rows`
   * below is a `useMemo` keyed on this, and a fresh array every render is the
   * loop `NO_CARDS` was introduced to stop.
   */
  const taskRows = useMemo(() => tasks.map(taskRow), [tasks])
  const cards = isTasks
    ? taskRows
    : settled ? (hidden ?? NO_CARDS) : (state?.cards ?? NO_CARDS)
  /** The real task behind a task row, for the sheet that reads one. */
  const taskById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks])
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
   *
   * The first of them asks what a row *is*, not which pipe carried it.
   * `c.sources.some(s => s.source === filter)` is the transport question, and it
   * was wrong by about forty rows: a Sentry issue announced in `#sentry-alerts`
   * is minted `source: 'slack'`, so Slack claimed it and the tab's nine human
   * threads sat under forty `TRUTO-39 · Error`s while the Sentry tab read 13.
   * `inBucket` answers the other question — see `lib/bucket.ts` for what counts
   * as a Sentry identity and, just as importantly, what does not.
   */
  const matchSource = useCallback((c: CardT) => inBucket(c, filter), [filter])

  /**
   * Priority does not exist on a task, so this tab does not pretend it does.
   *
   * The `tasks` table has no priority column — `taskRow` writes Normal because
   * `Card` requires a number, not because anything chose it. Left as an
   * ordinary predicate, `?pri=0` on this tab would empty the list with a
   * control above it claiming to be the reason. `FilterRow` hides the control
   * here for the same reason; this is the half that survives a hand-typed URL.
   */
  const priActive = !isTasks && pri !== 'any'

  /**
   * Search spans every column the table dropped, not just the two it kept.
   *
   * Why, who, channel, repo, project, excerpt and every account a group was
   * seen under. Those facts left the table; they did not stop being how he
   * remembers a row.
   *
   * The source names in it are the row's *tabs* rather than its pipes, for the
   * same reason the strip above is: typing `slack` here and pressing the Slack
   * tab are one question asked two ways, and on `c.sources` they answered
   * differently — forty Sentry alerts came back for `slack` and none of them
   * were on the tab. `cardKind(c).word` is a bucket now too, so both halves of
   * this list agree without being told to.
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
      ...bucketsOf(c).map(b => SOURCE_LABEL[b]),
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
    (c: CardT) => !priActive || c.priority === Number(pri),
    [pri, priActive],
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
  /**
   * A task opens its own sheet, not the card pane.
   *
   * `CardDetail` reads a card: its members, the thread on it, who is waiting,
   * what has landed since he last looked. A task has none of those, so pointing
   * it at a synthetic row would render a pane of blanks and an `Open` button
   * with nowhere to go. `TaskRead` is the surface that already answers a task —
   * Work has opened it for two releases — and it is the same sheet here.
   *
   * There is also no resting fallback on this tab. `rows[0]` in the pane is
   * right for a desk, where something is always the most likely thing to be
   * reading at 7am; a sheet is a thing you opened, and one that opens itself
   * over the list on arrival is a takeover.
   */
  const shown = isTasks || selectedKey === '' ? null : (selected ?? rows[0] ?? null)
  const readingTask =
    selected && isTaskRow(selected) ? taskById.get(taskIdOf(selected)) ?? null : null
  /**
   * The last task the sheet held, so it can animate out with its contents.
   *
   * `TaskRead` is gated on `open`, and closing clears the selection on the same
   * tick — without this the panel's exit animation plays over an empty sheet.
   * Work keeps the identical ref for the identical reason.
   */
  const lastRead = useRef<Task | null>(null)
  if (readingTask) lastRead.current = readingTask
  /** The task being edited, when the read sheet hands over to the form. */
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = editingId ? taskById.get(editingId) ?? null : null
  const isTable = width >= TABLE_MIN
  /**
   * Whether this viewport can hold columns at all.
   *
   * Three layouts rather than two, and the third is the phone's. `CardTable`
   * carries the measurement: four columns at a readable width need 552px and a
   * 375px screen gives the page column 343, so below `sm` a row is a card and
   * above it a row is a row. See `COLUMNS_MIN`.
   */
  const hasColumns = width >= COLUMNS_MIN
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
  const undoable = (c: CardT, verb: string, undo: 'status') =>
    /*
     * The row is named, and that is not decoration.
     *
     * Every one of these writes takes the row off the screen or out from under
     * the thumb, and the swipe drawer — three 88px actions over a 343px row —
     * has already covered everything but the first two or three words of the
     * title while you press `Delete`. `TRUTO-3A · TypeError` and `TRUTO-39 ·
     * Error` both read as `TRUTO-` behind it. A bar that then says `Won't do.`
     * closes no loop at all: it names the verb you just chose and withholds the
     * one thing you cannot see. The undo is only worth having if you can tell
     * what it will bring back.
     *
     * `titleOf` rather than the raw title, so a collector's hard cut is admitted
     * here too, and the bar's own `truncate` elides whatever is left over.
     */
    toast(`${verb} — ${titleOf(c)}`, {
      label: 'Undo',
      run: async () => {
        await actions.restore(c.group_key, undo)
        setWritten(v => v + 1)
        await reload()
      },
    })

  /**
   * Where the work stands, on whichever of the two tables this row lives in.
   *
   * A task settles in place: `/state` sends every task whatever its status, so
   * `Done` on this tab moves the row within the list rather than off it, and
   * the Status filter is what hides it. That is the opposite of a card, which
   * leaves `state.cards` the moment it settles — hence two branches rather than
   * one clever one.
   */
  const setTaskStatus = async (c: CardT, next: CardStatus) => {
    const id = taskIdOf(c)
    const was = c.status
    if (next === was) return
    optimistic(s => {
      const x = s.tasks.find(t => t.id === id)
      if (x) x.status = next
      return s
    })
    try {
      await actions.updateTask(id, { status: next })
    } catch (e) {
      toast((e as Error).message)
      await reload()
      return
    }
    // Named, and undone by putting the old status back rather than by
    // `actions.restore` — that endpoint drops card suppressions and a task has
    // none. Same shape as the card branch, different write.
    toast(`${next === 'done' ? 'Done' : STATUS_LABEL[next]} — ${titleOf(c)}`, {
      label: 'Undo',
      run: async () => { await actions.updateTask(id, { status: was }); await reload() },
    })
    void reload()
  }

  const setStatus = async (c: CardT, next: CardStatus) => {
    if (isTaskRow(c)) return setTaskStatus(c, next)
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
    /*
     * A write that fails must not look like one that worked.
     *
     * The row is already off the screen by here — `drop()` above is optimistic —
     * and this was an unguarded `await` inside a function called as
     * `void setStatus(...)`. So a failed Done was pixel-identical to a
     * successful one: the card vanished, no toast appeared because `undoable`
     * never ran, the rejection went nowhere, and the card came back on the next
     * poll with no explanation. `makeTask` below was written with this guard and
     * these two were not.
     *
     * The server is the truth, so recovery is to re-read rather than to invert
     * the optimistic edit by hand.
     */
    try {
      await actions.setStatus(c.group_key, next)
    } catch (e) {
      toast((e as Error).message)
      await reload()
      return
    }
    setWritten(v => v + 1)
    undoable(c, next === 'done' ? 'Done' : STATUS_LABEL[next], 'status')
    void reload()
  }

  const setDue = async (c: CardT, at: number | null) => {
    if (isTaskRow(c)) {
      const id = taskIdOf(c)
      optimistic(s => {
        const x = s.tasks.find(t => t.id === id)
        if (x) x.due_at = at
        return s
      })
      try {
        await actions.updateTask(id, { due_at: at })
      } catch (e) {
        toast((e as Error).message)
        await reload()
        return
      }
      void reload()
      return
    }
    optimistic(s => {
      const x = s.cards.find(i => i.group_key === c.group_key)
      if (x) x.due_at = at
      return s
    })
    // Same guard as `setStatus`, for the same reason: the row already shows the
    // new date, so a failure that says nothing leaves the screen lying until the
    // next poll quietly puts the old one back.
    try {
      await actions.setDue(c.group_key, at)
    } catch (e) {
      toast((e as Error).message)
      await reload()
      return
    }
    setWritten(v => v + 1)
    void reload()
  }

  /**
   * A task from a card, landed in Work without a sheet.
   *
   * The sheet is still what the detail pane offers, and it is still the right
   * thing there — that is the path for a task you want to give a deadline, a
   * goal and a colour. This is the other path: the row under the thumb is
   * already the title and already carries its own provenance, so the only thing
   * a sheet could add is a confirmation of what is on screen.
   *
   * The card is deliberately left exactly where it is. Making a note of
   * something is not finishing it, and a row that vanished when you wrote it
   * down would be the one action on this page that quietly did two things.
   */
  const makeTask = async (c: CardT) => {
    /*
     * One task per row, and the second press says so rather than making another.
     *
     * Nothing anywhere refuses a duplicate — `POST /tasks` inserts
     * unconditionally — so two presses produced two identical tasks and two
     * identical toasts, of which only the second Undo was reachable: the toast
     * is single-slot, so the first task was orphaned with no way back to it
     * except finding it in Work.
     *
     * On a control this quick, a second press is a mis-tap far more often than
     * it is a considered decision to track the same thread twice. Saying so is
     * both the safer answer and the more useful one — it tells him the note he
     * meant to make is already made.
     */
    const already = (state?.tasks ?? []).find(t => t.source_card_group === c.group_key)
    if (already) {
      toast(`Already on your list — ${titleOf(c)}`)
      return
    }
    try {
      const t = await actions.createTask(taskFromCard(c)) as { id: string }
      // The row is named for the same reason every other toast on this page
      // names it — the drawer has been covering the title while the thumb was on
      // the button, so `Task.` alone closes no loop.
      toast(`Task — ${titleOf(c)}`, {
        label: 'Undo',
        run: async () => { await actions.deleteTask(t.id); await reload() },
      })
      void reload()
    } catch (e) {
      toast((e as Error).message)
    }
  }

  /**
   * The drawer's fourth action, offered only where it means something.
   *
   * `Task` makes a task out of a row. On the Tasks tab every row already is
   * one, so the action is withheld rather than made into a no-op — and the
   * drawer narrows to three actions on its own, because `actionsOn` reads
   * exactly this. See `RowAction.onTask`.
   */
  /**
   * Delete a task, with the row put back on undo.
   *
   * A real delete, unlike a card's `Delete`, which is `Won't do` and reachable
   * again through the Status filter. There is no suppression table behind a
   * task and nothing to restore it from, so the undo re-creates it from the row
   * that was on screen — which is why the whole task is captured rather than
   * its id.
   */
  const removeTask = async (t: Task) => {
    optimistic(s => { s.tasks = s.tasks.filter(x => x.id !== t.id); return s })
    if (t.id === editingId) setEditingId(null)
    if (taskRowKey(t.id) === selectedKey) closeDetail()
    try {
      await actions.deleteTask(t.id)
    } catch (e) {
      toast((e as Error).message)
      await reload()
      return
    }
    // Named, like every other undo on this page — the drawer has been covering
    // the title while the thumb was on the button. `recreateTask` is Work's, so
    // the notes and the `restore` flag come back with it.
    toast(`Deleted — ${t.title}`, { label: 'Undo', run: () => recreateTask(t) })
    void reload()
  }

  const rowActions: RowAction = {
    onOpen: c => openDetail(c.group_key),
    onStatus: (c, s) => void setStatus(c, s),
    onDue: (c, at) => void setDue(c, at),
    ...(isTasks ? {} : { onTask: (c: CardT) => void makeTask(c) }),
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
      // A drawer open on some row owns the keyboard until it is shut. Without
      // this, `e` on an open swipe finishes the *cursor* card rather than the
      // one whose actions are showing under the thumb.
      if (openSwipeKey()) return
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
        label: titleOf(c),
        hint: c.why,
        group: `Cards — ${rows.length}`,
        run: () => openDetail(c.group_key),
      })),
    ), [rows])

  // Nothing at all until the first read lands. A 200ms loader is worse than a
  // beat of nothing, and a sentence explaining that a page is loading is chrome
  // that teaches.
  if (!state) return <div className="pad-x pt-4"><Header source={filter} tab={tab} /></div>

  /**
   * Whether anything is narrowing this list besides the tab.
   *
   * The tab is deliberately not in it: it is a strip of six controls directly
   * above the answer, with the pressed one lit, so "you are in Slack" is
   * already on the screen and the empty state has a different thing to say
   * about it — see `Blank`.
   */
  const filtered = !!query || due !== 'any' || priActive || status !== 'any'

  /**
   * A filter that matches nothing is one line — but it is a line, not a word.
   *
   * Still no heading, no count, no apology, and nothing per-pile: the rule this
   * page was rebuilt around holds. What changed is that the word was `Nothing`,
   * at 13px, in the top-left corner of a 900px void, and it named neither the
   * state nor the way out of it — a search that matches nothing looks exactly
   * like a desk that is clear, and the reader who mistyped one letter has to
   * work out which. `Blank` says which of the two it is and, where there is
   * one, offers the way back. Work's own empty state is the pattern and this is
   * deliberately the same shape as it.
   */
  const list = (
    <div
      /*
       * The last row clears the tab bar, by measuring it rather than by
       * guessing at it.
       *
       * This was `pb-24 lg:pb-8` — 96px under a 53px bar, which is 43px of hole
       * on a laptop-sized phone and not enough on a device with a home
       * indicator. `--nav-h` is the strip the bar actually owns at this width,
       * declared once in `styles.css` and already carrying `env(safe-area-inset-
       * bottom)`; above `sm` the bar is not drawn and the same expression
       * collapses to the indicator plus this page's own 24px of air.
       */
      style={{ paddingBottom: 'calc(var(--nav-h) + 24px)' }}
      className="min-w-0 grow pad-x"
    >
      <Header count={rows.length} source={filter} tab={tab} onNewTask={() => setNewTask(true)} />
      {/*
        The tabs and the filters pin; the title does not.

        Which of the three sticks is the whole decision here. All three is
        ~150px of an 844px screen held permanently — a quarter of the phone
        spent on chrome above a list. None of them is what this page did, and on
        74 rows it means scrolling back to the top to change source. So it is
        the two that are *controls*: `Desk`, its count and `Fetch` are a title
        row, and a title that scrolls away is the pattern every phone OS uses
        for exactly this reason.

        `bleed-x` because a glass bar with 16px of un-tinted gutter either side
        reads as a bug — see `styles.css`. `z-20` sits under the swipe drawer's
        picker (z-30) and the shell's rails (z-30), and over every row.
      */}
      <div className="sticky top-0 z-20 bleed-x glass-bar">
        <SourceTabs value={tab} state={state} />
        <FilterRow query={query} due={due} pri={pri} status={status} tab={tab} />
      </div>

      {rows.length === 0 ? (
        <Blank query={query} filtered={filtered} tab={tab} onNewTask={() => setNewTask(true)} />
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
      ) : hasColumns ? (
        <>
          {/* Four columns here too, at the widths a narrow laptop window and a
              tablet can read them at — Kind gives up its place to Where,
              because a glyph already says which kind and nothing said which
              customer. The `j`/`k` cursor reaches this layout now as well; it
              did not before, so a narrow laptop had a keyboard cursor with
              nothing on screen to show where it was standing. */}
          <PhoneTable
            rows={pageRows}
            selectedKey={selectedKey}
            cursorKey={cursor === null ? null : rows[cursor]?.group_key ?? null}
            actions={rowActions}
          />
          <Pager page={page} pages={pages} total={rows.length}
            onPage={n => setParam('page', n === 1 ? null : String(n))} />
        </>
      ) : (
        <>
          {/* And on the phone a row is a card: the title on its own line, then
              status, customer and deadline on the next. The same four facts the
              table draws, at a width that does not have to be scrolled to. */}
          <CardList
            rows={pageRows}
            selectedKey={selectedKey}
            cursorKey={cursor === null ? null : rows[cursor]?.group_key ?? null}
            actions={rowActions}
          />
          <Pager page={page} pages={pages} total={rows.length}
            onPage={n => setParam('page', n === 1 ? null : String(n))} />
        </>
      )}
    </div>
  )

  /*
   * Below the pane width the detail is a page of its own, and it is still only
   * offered once a row has actually been chosen — a detail over the list on
   * arrival is a takeover whatever it is shaped like.
   */
  const detail = !hasPane && selectedKey && shown
    ? <DetailPage card={shown} resting={!selected} onMakeTask={setTaskFrom} taskFrom={taskFrom} />
    : null

  return (
    <div className="lg:flex lg:items-stretch lg:min-h-dvh">
      {list}
      {detail}
      {/*
        The pane column always exists at the pane width, so opening a row never
        re-lays out the list.

        `glass-bar` and deliberately not `glass`. The old note here refused a
        fill at all, on the measurement that `bg-ink-850` is pure white in light
        mode and put a 400px white panel on a grey page — which was true of an
        opaque token and is the whole reason the material has three weights. A
        bar is the right one: this column is full-height and the table scrolls
        past it, which is the condition `.glass-bar` exists for, and a panel's
        heavier tint over 400×900 of screen would be the white box again in a
        different colour. The left hairline stays; the tint is what makes it
        read as in front rather than as more page.
      */}
      <aside
        style={{ width: paneWidth }}
        /*
         * Not drawn on the Tasks tab, and that is a layout change on purpose.
         *
         * The pane exists at every width so that *opening a row* never re-lays
         * out the list — a card is read in the column beside the table. A task
         * is not: it opens `TaskRead`, so the column would be 400px of nothing
         * on every row of the tab, and the list it is taking that width from is
         * the one the reader came here to scan. Switching tabs re-lays out;
         * opening a row still does not, which is what the rule was protecting.
         */
        hidden={isTasks || undefined}
        className={`${isTasks ? 'hidden' : 'hidden xl:block'} relative xl:shrink-0 edge-l glass-bar xl:sticky xl:top-0 xl:h-dvh`}
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
          /*
           * `resting` is the difference between "he opened this" and "something
           * had to be in the pane". The pane falls back to the top row when
           * nothing has been chosen, and a fallback that acknowledges what it
           * happens to be showing would clear the `+N` on the newest thread
           * every morning before he had read a word of it.
           *
           * `!selected`, not `!selectedKey`, and the gap between the two is a
           * second way into that same failure. `shown` falls back to `rows[0]`
           * whenever the key in the URL does not match a row on the desk — which
           * is not only "nothing chosen": it is also a card he opened and then
           * finished, or one a poll swept while the pane was still on it. In
           * every one of those the pane silently swaps to the top row, and with
           * `!selectedKey` it would then acknowledge it. `selected` is the row
           * that was actually asked for, so this is exactly "the pane is showing
           * what somebody asked for" and nothing else.
           */
          <CardDetail card={shown} onClose={closeDetail} resting={!selected}
            onMakeTask={c => { closeDetail(); setTaskFrom(c) }} />
        )}
      </aside>
      <TaskSheet open={!!taskFrom} onClose={() => setTaskFrom(null)} fromCard={taskFrom} />
      {/*
        The two surfaces a task of his own is read and written through, and they
        are Work's — the same components, not a second pair that would drift.
        Reading and editing are one surface at a time for the reason Work states:
        a form stacked on the sheet it opened from gives the back gesture two
        panels to walk out of.
      */}
      <TaskRead
        open={!!readingTask}
        task={readingTask ?? lastRead.current}
        goals={state.goals}
        reminders={state.reminders}
        onClose={closeDetail}
        onEdit={t => { closeDetail(); setEditingId(t.id) }}
        onStatus={(t, next) => void setStatus(taskRow(t), next)}
        onDelete={t => { closeDetail(); void removeTask(t) }}
      />
      <TaskSheet
        open={!!editing || newTask}
        onClose={() => { setEditingId(null); setNewTask(false) }}
        task={editing}
      />
    </div>
  )
}

/**
 * The phone detail is a page, not a squeezed sheet.
 *
 * What this replaces was a bottom sheet with a drag handle and two snap
 * heights, on the argument that keeping the list visible above it is what makes
 * reading four rows in sequence one gesture instead of twelve. The argument was
 * about the wrong cost. At 390px the sheet was 55dvh of a 844px screen — a
 * ~460px window holding a title, three controls, a fact grid, a conversation
 * and four buttons — so every card was read through a slot, and the way out of
 * it was a 40px handle and a 14px cross. A card is a place you go on a phone.
 * It gets the screen.
 *
 * Three things make it a page rather than the takeover the sheet was written to
 * escape, and all three are the address bar's doing. It is `#card/<key>`, so it
 * is a place with a URL; `openDetail` pushed to get here, so the OS Back button
 * leaves; and `DetailPath` puts the way back on the screen for the reader who
 * does not think in browser buttons. Coming back is one control, and it lands
 * on the list exactly where it was left — the page underneath never unmounted.
 *
 * It stops at `--nav-h` rather than at the bottom edge, and that is not a
 * leftover from the sheet. `styles.css` states it as a rule: nothing may cover
 * the phone tab bar. A sheet at `bottom: 0` measured all six destinations
 * unreachable, with no bar drawn to explain why. A detail that fills everything
 * above the bar is a page in the sense that matters — the whole surface a page
 * ever gets on this product — and the six destinations stay one tap away.
 *
 * `useOverlay(true)` is load-bearing and not decoration. `overlay.ts` exists
 * because `e` — destructive and unconfirmed — leaked through open modals; this
 * view was added afterwards and never counted itself, so on a laptop at half
 * screen `e` finished the *cursor* card rather than the one being read, and the
 * undo toast rendered under the `z-50` overlay.
 */
function DetailPage({
  card, resting, taskFrom, onMakeTask,
}: {
  card: CardT
  /**
   * The same word the pane uses, and for the same reason.
   *
   * `shown` falls back to the top row whenever the key in the URL names a row
   * that is not on the desk — a card he finished, one a poll swept, one a source
   * tab filtered away — and this page is gated on `selectedKey`, which is still
   * set in every one of those. Without carrying `resting` through, the phone
   * silently swapped to `rows[0]` and `CardDetail` acknowledged it: the `+N` and
   * the amber edge on the newest unread thread destroyed by a card nobody
   * opened. The desktop pane spends fifteen lines on this; this is the same
   * failure at the width he actually reads on.
   */
  resting: boolean
  taskFrom: CardT | null
  onMakeTask: (c: CardT | null) => void
}) {
  useOverlay(true)

  return createPortal(
    <div
      /* `pad-top` because a fixed element at `top: 0` starts under the notch,
         and `--nav-h` at the foot because the tab bar is not this page's to
         cover. Between them the detail has the whole screen the shell allows
         anything, which is what a page means here. */
      style={{ bottom: 'var(--nav-h)' }}
      className="fixed inset-x-0 top-0 z-50 pad-top flex flex-col glass"
    >
      <DetailPath card={card} onBack={closeDetail} />
      {/* `CardDetail` is `h-full min-h-0`, so as a flex item it shrinks to
          whatever the path bar leaves and scrolls its own body inside that.
          Nothing here sets a height: a `dvh` number would be the sheet's
          mistake in new clothes. */}
      <CardDetail card={card} onClose={closeDetail} resting={resting} backProvided
        onMakeTask={c => { closeDetail(); onMakeTask(c) }} />
      <TaskSheet open={!!taskFrom} onClose={() => onMakeTask(null)} fromCard={taskFrom} />
    </div>,
    document.body,
  )
}

/**
 * Where you are, and the way back, in one line.
 *
 * `‹ Desk › Slack › 15five — Roopi`. The first segment is the control and the
 * rest is the sentence it completes: one thing to press, and a path that says
 * what was left behind rather than making the reader remember it. A bare chevron
 * with no word beside it is a guess about what it will close, and the sheet
 * before this had exactly that plus a cross, two dismissals eight pixels apart
 * that did the same thing.
 *
 * The middle segment is the source and the last is the card's own context —
 * `contextLine`, the same `customer — who` the row shows in its Where column, so
 * the crumb and the row a reader tapped are recognisably the same thing. It
 * falls back to the kind word for a card with no context to give.
 *
 * Neither of the last two is a control, deliberately. Filtering the desk to
 * Slack from here means a `replaceState` for the filter and a `history.back()`
 * for the close, in that order, on the same tick — the back would land on the
 * entry the filter was just written into and undo it. A crumb that quietly does
 * not work is worse than a crumb that never claimed to.
 */
function DetailPath({ card, onBack }: { card: CardT; onBack: () => void }) {
  const kind = cardKind(card)
  const here = contextLine(card) ?? kind.word

  return (
    <nav aria-label="Breadcrumb"
      className="shrink-0 flex items-center gap-1 pad-x py-1 border-b border-rule">
      <Button variant="default" size="sm" onClick={onBack}
        ariaLabel="Back to the desk" title="Back to the desk"
        className="shrink-0">
        <ChevronLeft size={14} aria-hidden /> Desk
      </Button>
      <ChevronRight size={12} aria-hidden className="shrink-0 text-fg-mute" />
      <span className="shrink-0 text-sm text-fg-dim">{SOURCE_LABEL[kind.source]}</span>
      <ChevronRight size={12} aria-hidden className="shrink-0 text-fg-mute" />
      <span className="truncate text-sm text-fg-mute">{here}</span>
    </nav>
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
 *
 * Two controls sit here, side by side, and they are peers rather than a primary
 * and its overflow. `Fetch` asks the collectors this machine can reach — the
 * Claude bridge and the MCP boxes — and `Sync` re-polls the sources Wake is
 * already connected to. They are different pipes with different failure modes,
 * a reader has to be able to press either one on purpose, and a poll that was
 * reachable only from the command palette was a poll nobody knew existed.
 */
function Header({
  count, source, tab, onNewTask,
}: {
  count?: number
  source: SourceName | null
  tab: DeskTab
  onNewTask?: () => void
}) {
  /*
   * Two different jobs, so two different right-hand sides.
   *
   * `Sync` and `Fetch` change what a *pipe* has delivered, and on the Tasks tab
   * there is no pipe: nothing polled his task list, he wrote it. Leaving them
   * there would put two controls at the top of the page that cannot add a row
   * to what is under them — and worse, `Fetch` unscoped would report having
   * found six new things while the list it sits above did not move.
   *
   * What that tab wants instead is the one control that *can* add a row, and it
   * is the amber: writing a task down is the only commitment on this page, so
   * it takes the accent the way Work's `+ Task` does. One per surface, and the
   * source tabs spend theirs on nothing.
   */
  const isTasks = tab === 'tasks'
  return (
    <header className="pt-4 pb-2 flex items-center gap-3">
      <PageTitle>Desk</PageTitle>
      {count !== undefined && <span className="tnum text-sm text-fg-mute">{count}</span>}
      {/* `min-w-0`, not `shrink-0`. This group holds two controls and two result
          lines, and a group that refuses to shrink hands its overflow to the
          page column — which clips it, so the rightmost control simply stops
          being reachable and nothing on screen says why. Shrinkable, the
          pressure lands on the two lines inside, which are built to elide. */}
      <span className="ml-auto min-w-0 flex items-center gap-2">
        {isTasks ? (
          onNewTask && (
            <Button variant="primary" onClick={onNewTask}>
              <Plus size={14} aria-hidden /> Task
            </Button>
          )
        ) : (
          <>
            <Sync source={source} />
            <Fetch source={source} />
          </>
        )}
      </span>
    </header>
  )
}

/**
 * Tasks / Slack / Gmail / GitHub / Sentry / Claude, as a real tab strip.
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
  value: DeskTab
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
        {/*
          `Tasks`, and it now holds tasks.

          It used to be the unfiltered view — every card from every pipe — on the
          argument that everything on this desk is something somebody is waiting
          on him for. That argument was about cards, and the word on the tab was
          not: he read `Tasks` and got a hundred rows of Slack, Sentry and Gmail
          with nothing he had written down among them. A task and a card are two
          tables and only one of them is his.

          It carries no `SourceMark`, unlike the five, and that is still
          deliberate — but the reason has changed. It is not the absence of a
          source filter any more; it is the one tab whose rows have no source at
          all, so there is no mark that could honestly go here. See `DeskTab`.
        */}
        <button aria-selected={value === 'tasks'} role="tab" className={tab(value === 'tasks')}
          onClick={() => { setParam('src', null); setParam('page', null) }}>
          Tasks
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
 * Nothing here, and which nothing it is.
 *
 * `Empty` — one muted word on the row grid — is the right answer for a value
 * that has nothing in it and the wrong one for a whole surface. Measured on the
 * deployed desk, a search that matched nothing rendered the single word
 * `Nothing` at 13px in the corner of a 900px hole: it did not say whether the
 * desk was clear or the search was wrong, and it did not say what to press. The
 * two states are one keystroke apart and they mean opposite things.
 *
 * So: one line that names the state, and — where there is one — the way out, as
 * a real control rather than an instruction to go and press something else.
 * It is deliberately not a tutorial and deliberately not three chapters with
 * counts, which is what this page's empty state was before the table.
 *
 * The button is `secondary`, not the amber, for the reason Work's is: `Fetch`
 * is sitting on the header row above it and one surface spends the accent once.
 *
 * There is no way out of a genuinely clear desk, so it is not offered one. That
 * is not an omission — nothing being on you is the good state, and `Fetch` is
 * already on the row above for the reader who does not believe it.
 */
function Blank({
  query, filtered, tab, onNewTask,
}: { query: string; filtered: boolean; tab: DeskTab; onNewTask: () => void }) {
  const source = tab === 'tasks' ? null : tab
  /* Everything but the tab, and the page with it: page 3 of a list you are
     about to widen is not where the answer starts. The tab is left alone
     because the strip above says which one is pressed and unpressing it is one
     tap on that strip — see the second button. */
  const clear = () => {
    for (const k of ['q', 'due', 'pri', 'status', 'page']) setParam(k, null)
  }

  return (
    <div className="py-2">
      <p className="text-base text-fg-dim max-w-prose">
        {filtered
          ? query
            // Not quoted back at him: the search field is directly above this
            // line with the words still in it, and the same rule that keeps the
            // source name out of here keeps the query out of here.
            ? 'Nothing on the desk matches this search.'
            : 'Nothing on the desk matches these filters.'
          : source === null
            ? 'Nothing on your list.'
            : `Nothing from ${SOURCE_LABEL[source]} is on you.`}
      </p>
      {/*
        Three states, and only two of them have a way out.

        A filtered miss offers the filters back. An empty Tasks tab offers the
        one control that fills it — which is the whole difference between this
        and a source tab, where the way out used to be `Show every source` and
        is gone with the view it pointed at. A source with genuinely nothing on
        it is the good state and is not offered an escape from itself; `Fetch`
        is on the row above for the reader who does not believe it.
      */}
      {filtered ? (
        <Button size="lg" variant="secondary" className="mt-3" onClick={clear}>
          Clear filters
        </Button>
      ) : source === null ? (
        <Button size="lg" variant="secondary" className="mt-3" onClick={onNewTask}>
          <Plus size={14} aria-hidden /> Add one
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Everything that is narrowing this list besides the tab, counted.
 *
 * `pri` counts only where a priority filter exists. On the Tasks tab the
 * control is not drawn and the predicate is inert, so a stale `?pri=0` left in
 * the URL by a source tab would otherwise put `Filters · 1` on a phone above a
 * list nothing was filtering — a badge pointing at a control that is not there.
 */
const filterCount = (query: string, due: DueFilter, pri: string, status: string, tab: DeskTab) =>
  [
    query.trim() !== '',
    due !== 'any',
    tab !== 'tasks' && pri !== 'any',
    status !== 'any',
  ].filter(Boolean).length

/** Everything the filter row owns, and the page with it. Cleared together. */
const FILTER_PARAMS = ['q', 'due', 'pri', 'status', 'page']

/**
 * How much of the screen the keyboard is currently covering.
 *
 * iOS does not shrink the layout viewport when the keyboard comes up — it
 * shrinks the *visual* one and leaves the page the height it had — so a sheet
 * anchored to the bottom edge keeps its footer exactly where the keyboard now
 * is, and the one control on the surface that commits is under it with nothing
 * on screen to say so. `dvh` does not help: it is measured against the layout
 * viewport too, which is why the panel's own max-height fixes the URL bar
 * and not this.
 *
 * `visualViewport` is the only thing that can answer it. The number is the gap
 * between the two viewports' bottoms, which is the keyboard plus any accessory
 * bar, and it comes back to zero the moment the field is left. It is spent as
 * bottom padding inside the footer, so the panel — which is bottom-anchored and
 * free to grow upward — lifts the commit strip to sit exactly on top of the
 * keyboard rather than behind it.
 *
 * Only measured while something is actually open. Two listeners on a viewport
 * that nothing is asking about is a listener firing on every scroll of every
 * page for nobody.
 */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const vv = typeof window === 'undefined' ? null : window.visualViewport
    if (!active || !vv) return
    const read = () =>
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    read()
    vv.addEventListener('resize', read)
    vv.addEventListener('scroll', read)
    return () => {
      vv.removeEventListener('resize', read)
      vv.removeEventListener('scroll', read)
      setInset(0)
    }
  }, [active])

  return inset
}

/**
 * Search, and the three closed sets — one row on a laptop, one control on a
 * phone.
 *
 * Everything here narrows what you see and none of it changes what exists,
 * which is why Fetch sits up on the tab row instead, behind a spacer, where it
 * cannot be mistaken for a fourth filter. Each control writes one URL parameter
 * and resets the page, because page 4 of a list you just re-filtered is a page
 * that may not exist.
 *
 * **The phone gets a button instead of the row, and that is the whole change.**
 * Four controls need about 450px and a 375px screen gives 343, so this wrapped:
 * a full-width `Search`, and `Any date · Any priority · Any status` underneath
 * it. Two rows of chrome, ~88px, above a list on an 812px screen — and the
 * three sets on the second row are three anonymous dropdowns until one is
 * opened, because a closed set whose value is `Any date` is a control saying it
 * is doing nothing. So below `sm` all four collapse into one 44px control that
 * says how many of them are set, and pressing it opens the same four in a sheet
 * with room to label them. The row above the list is 44px instead of 88, and
 * what it costs is one press to reach a filter that, unset, was only telling
 * you it was unset.
 *
 * From `sm` up it is exactly the row it has always been. There is no laptop
 * problem here — the four fit on one line with room over — and a laptop that
 * grew a modal to reach its own filters would be paying for the phone's fix.
 */
function FilterRow({
  query, due, pri, status, tab,
}: { query: string; due: DueFilter; pri: string; status: string; tab: DeskTab }) {
  const [open, setOpen] = useState(false)
  const set = (k: string, v: string | null) => { setParam(k, v); setParam('page', null) }
  const count = filterCount(query, due, pri, status, tab)
  const keyboard = useKeyboardInset(open)

  /* The three closed sets, built once and drawn twice — the sheet and the row
     are two arrangements of one set of controls, and a second copy of these
     option lists is how the two come to offer different answers. `full` is the
     sheet's: a labelled control in a form spans its column, and the same
     control in a filter row is as wide as its longest option. */
  const sets = (full: boolean): Array<[string, React.ReactNode]> => {
    const w = full ? 'w-full' : ''
    const due_: [string, React.ReactNode] = ['Due', (
      <Select key="due" className={w}
        value={due}
        options={DUE_OPTIONS}
        onChange={v => set('due', v === 'any' ? null : v)}
        ariaLabel="Filter by due date"
      />
    )]
    const priority: [string, React.ReactNode] = ['Priority', (
      <Select key="pri" className={w}
        value={pri}
        options={[{ id: 'any', label: 'Any priority' },
          ...PRIORITY_ORDER.map(v => ({ id: String(v), label: PRIORITY_LABEL[v] }))]}
        onChange={v => set('pri', v === 'any' ? null : v)}
        ariaLabel="Filter by priority"
      />
    )]
    const state_: [string, React.ReactNode] = ['Status', (
      <Select key="status" className={w}
        value={status}
        options={[{ id: 'any', label: 'Any status' },
          ...STATUS_ORDER.map(s => ({ id: s as string, label: STATUS_LABEL[s] }))]}
        onChange={v => set('status', v === 'any' ? null : v)}
        ariaLabel="Filter by status"
      />
    )]
    /*
     * Priority is a card's, not a task's — the `tasks` table has no such column.
     * Offering it on that tab would be a control whose every setting but `Any`
     * empties the list, sitting directly above the emptiness as if it were the
     * explanation for it. `Home` refuses the same parameter in `priActive`, so a
     * hand-typed `?pri=0` is inert rather than merely unreachable.
     */
    return tab === 'tasks' ? [due_, state_] : [due_, priority, state_]
  }

  return (
    <>
      {/* The phone's whole filter row. `secondary` once something is set, so
          the control says it is doing something without hover and without
          being read — the count beside it says how much. */}
      <div className="sm:hidden py-2">
        <Button
          size="md"
          variant={count ? 'secondary' : 'default'}
          onClick={() => setOpen(true)}
          ariaLabel={count ? `Filters — ${count} set` : 'Filters'}
        >
          <SlidersHorizontal size={14} aria-hidden /> Filters
          <CountBadge count={count} />
        </Button>
      </div>

      <div className="hidden sm:flex flex-wrap items-center gap-2 py-2">
        <input
          type="search"
          value={query}
          onChange={e => set('q', e.target.value || null)}
          placeholder="Search"
          aria-label="Search every column"
          className={`${inputClass} h-8 py-0 w-full sm:w-64`}
        />
        {sets(false).map(([, control]) => control)}
      </div>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Filters"
        footer={
          /*
            The footer is the phone's, in both directions: `pad-bottom` on the
            panel already carries the home indicator, and this carries the
            keyboard — the search field is the first thing in the sheet, so the
            commit strip is behind an iOS keyboard the moment anybody types.
            See `useKeyboardInset`.
          */
          <div style={{ paddingBottom: keyboard }} className="flex items-center gap-2">
            <Button size="lg" variant="default" disabled={!count} onClick={() => {
              for (const k of FILTER_PARAMS) setParam(k, null)
            }}>
              Clear filters
            </Button>
            {/* Nothing in this sheet commits — every control writes its
                parameter as it is pressed and the list behind is already
                filtered — so this is a way out rather than a confirmation, and
                it is not the accent. It exists because the panel's own cross is
                in the far corner from a thumb. */}
            <Button size="lg" variant="secondary" className="grow" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        }
      >
        {/* No `autoFocus`. A sheet that opens with the keyboard already up has
            covered the three controls underneath the field before they have
            been seen, and the reader who came here for `Overdue` never asked
            to type. */}
        <Field label="Search">
          <input
            type="search"
            value={query}
            onChange={e => set('q', e.target.value || null)}
            placeholder="Search"
            aria-label="Search every column"
            className={`${inputClass} h-11 py-0`}
          />
        </Field>
        {/* Labelled here and not on the row above, and that is the sheet
            earning its existence rather than a decoration: on the row the value
            *is* the label — `Any date` says what it is and that it is unset in
            two words — and in a form a control with a label above it can drop
            the prefix and just answer. */}
        {sets(true).map(([label, control]) => (
          <Field key={label} label={label}>{control}</Field>
        ))}
      </Sheet>
    </>
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
/**
 * Collect now — from every source, or from the one you are looking at.
 *
 * The brief asked for a way to fetch a single source. This is that, and it is
 * the tab strip rather than a second control: the desk already carries the
 * question "which source" in the URL, and answering it twice — once to filter,
 * once again inside a menu on the button — is two places to be out of step with
 * each other. On the Tasks tab the button reads `Fetch` and asks everything; on
 * the Slack tab it reads `Fetch Slack` and asks Slack alone.
 *
 * The label is what makes it discoverable. A control that silently changed what
 * it did based on a filter elsewhere on the page would be a trap; one that
 * renames itself is a statement, and it is the only affordance needed.
 */
function Fetch({ source }: { source: SourceName | null }) {
  const [busy, setBusy] = useState(false)
  const [line, say] = useResultLine()
  const only = source ?? undefined
  const word = only ? SOURCE_LABEL[only] : null

  /**
   * The pipes this press re-polls beyond the one it is named after.
   *
   * Named in the tooltip rather than left to be discovered, because the server
   * is the half that widens — the scope reaches `ingest` in there — and a
   * control whose stated reach and real reach differ is the thing this whole
   * pass is about. The Sentry tab is fed by the Slack poller reading
   * `#sentry-alerts`, so `Fetch Sentry` re-polls Slack; the connector it asks
   * afterwards is still Sentry's alone.
   */
  const carriers = only ? pipesFor(only).filter(p => p !== only).map(p => SOURCE_LABEL[p]) : []

  const run = async () => {
    setBusy(true)
    try {
      const r = await fetchNow(only)
      const asked = r.connectors.filter(c => c.via !== 'none')
      const quiet = asked.filter(c => !c.ok).map(c => c.name)
      say({
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
      say({ text: `Fetch failed · ${timeOfDay(Date.now())}`, title: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="flex items-center gap-3 min-w-0">
      {/* Below `lg` this span is not rendered and the same sentence arrives as
          a toast, which is the one answer both controls on this row give — see
          `useResultLine`. Capped and shrinkable for the reasons `Sync`'s line
          spells out: it is the half of this row that gives way, so a long
          answer elides instead of pushing the button it belongs to off a screen
          that cannot scroll sideways to reach it. */}
      {line && !busy && (
        <span className="hidden lg:inline min-w-0 text-sm text-fg-mute tnum truncate max-w-[34ch]"
          title={line.title}>
          {line.text}
        </span>
      )}
      <Button size="md" variant="default" className="shrink-0"
        onClick={() => void run()} disabled={busy}
        /* Named for a screen reader at every width, because the printed half of
           the label is `display: none` below `lg` and that takes it out of the
           accessibility tree too. See the same line on `Sync`. */
        ariaLabel={word ? `${busy ? 'Fetching' : 'Fetch'} ${word}` : undefined}
        title={!only
          ? 'Ask every connector this machine can reach what is on you'
          : carriers.length
            ? `Ask ${SOURCE_LABEL[only]} what is on you, and re-poll ${carriers.join(' and ')}`
              + ` — part of this tab arrives through it`
            : `Ask ${SOURCE_LABEL[only]} alone what is on you — the other sources are left as they are`}>
        {/* The word is the control; the glyph is decoration, and on a phone it
            is 22px this row does not have to spend. It comes back at the width
            where the tabs get their names. The busy state is still legible
            without it — the label is the indicator. */}
        <span className="hidden lg:inline-flex">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        </span>
        {/* Unscoped, the verb holds one width for both states so the button does
            not resize under the finger mid-press. Scoped, it must not: a fixed
            56px column against a 36px word opens a 20px hole and `Fetch  Slack`
            reads as two controls rather than one label. The scoped button does
            change width between its two states, and that is the better trade —
            it is right-aligned so only its left edge moves, and it is disabled
            for the whole of the state that moves it.

            The source name is printed from `lg`, in step with `Sync` beside it
            and for the reason spelled out there: the two names together are
            272px of a 343px phone, and this is the button that was pushed off
            the edge. The `ariaLabel` above is what keeps it called `Fetch Claude
            Code` where the word is not printed. */}
        <span className={word ? '' : 'w-14 text-left'}>
          {busy ? 'Fetching' : 'Fetch'}
          {word ? <span className="hidden lg:inline">{` ${word}`}</span> : null}
        </span>
      </Button>
    </span>
  )
}
