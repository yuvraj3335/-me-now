/**
 * Work — his own list, beside the pane that reads one row of it.
 *
 * On the same grid as the desk and Mail: a padded list column and a pane of the
 * same width token with the same left hairline, so the second column's left edge
 * sits on the one vertical the product uses.
 *
 * **The page is one tree, and it stays one tree.** This file used to early-return
 * a structurally different subtree when there was nothing on the list — a
 * header, a line, the recorder — against the two-column layout it returned
 * otherwise. React reconciles positionally, so the two child lists disagreed at
 * every index and the instant that condition flipped it unmounted and remounted
 * *everything*: the header, the pane, the recorder and all three sheets. Saving
 * the first task flipped it, because `TaskSheet.save()` reloads before it closes
 * and the reload landed `tasks.length === 1` with the sheet still open — so the
 * sheet was torn down mid-save and the pane beside it was rebuilt from scratch.
 * That was the reported disappearance, and the rule that ends it is: emptiness
 * changes what is INSIDE a slot, never which slots exist. There is no early
 * return on this page any more, including the one for the first load.
 *
 * The pane is the second half of that. A task used to open a modal on every
 * width, which on a laptop is a sheet over a column that was already showing
 * nothing in particular; the row's detail belongs in the column. Below the pane
 * width it is still a sheet, because 375px has no room for a second column.
 *
 * One control language. `Tasks | Goals` is the segmented control the product
 * already ships, and `+ Task` is the single amber commit.
 *
 * Every time on this page is stated in the words he set it in — `Thu 3 Sep,
 * 2:35pm`, or `2:35pm` when it is today, or `late — Thu 3 Sep, 2:35pm` once it
 * has passed. The storage was always right; the display only ever showed `in
 * 4d`, which is not a commitment, it is a distance.
 *
 * **A task has the same five statuses a card has, painted by the same file.**
 * This page used to keep a private set of circles — a mute ring, an `fg` dot
 * and an `ok` tick — for a three-word vocabulary of its own, which is precisely
 * how it drifted three states behind the desk while both surfaces claimed to
 * show "status". The circles are gone; `status.tsx` is the only thing in the
 * product allowed to paint one, and the list is cut into the sections those
 * five statuses name.
 *
 * **Drag-to-reorder is gone, and the page scrolls again.** A `Reorder.Item`
 * writes `touch-action: pan-x` inline to claim the vertical axis for its drag,
 * and every task row answered that with `none` to get the horizontal axis back
 * for the swipe. Both of those take the page's own scroll away: a thumb dragging
 * up the list moved nothing, which is the "frozen app" failure `lib/swipe.ts`
 * puts above every gesture in this product. There is no way to hold a manual
 * order and a one-thumb scroll on the same row, so the order goes: the list is
 * grouped by status now, which is the ordering a phone at 7am actually reads.
 */

import { AnimatePresence, motion } from 'motion/react'
import { useStill } from '../lib/motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell, BellRing, ChevronDown, Mic, Plus, SquareTerminal, Trash2, X,
} from 'lucide-react'
import { actions, optimistic, reload, useStore } from '../lib/api'
import type { CardStatus, Goal, Task } from '../lib/types'
import { STATUS_LABEL, STATUS_ORDER } from '../lib/types'
import { StatusChip, StatusGlyph, StatusSlot, isSettled } from '../components/status'
import { deadlineWords, shortDate, wallClock } from '../lib/time'
import { SwipeDrawer, useSwipe } from '../components/swipe'
import { PANE_MIN, StatusPicker, useViewport } from '../components/CardTable'
import { toast } from '../lib/toast'
import {
  Button, DateTimePicker, Field, PageTitle, Pager, Segmented, Select, Sheet,
  inputClass, pageCount, pageSlice, rowStateClass,
} from '../components/primitives'
import { TaskSheet, TaskRead, NOTE_COLORS, noteColorName } from '../components/TaskSheet'
import { Recorder, VoicePlayer } from '../components/voice'
import { voiceApi, type VoiceNote } from '../lib/voice'
import { SOURCE_LABEL } from '../components/sources'
import { openLaunch, taskContext, taskRepoHint } from '../lib/launch'
import { setParam, useParam } from '../lib/route'

type Tab = 'tasks' | 'goals'

/**
 * The five, in the order work moves through them.
 *
 * Taken from `STATUS_ORDER` rather than written out, so this page cannot offer
 * a status the route refuses or spell one differently from the desk. A task
 * used to have three of its own — `todo | doing | done` — and the argument for
 * that seam was that a task of his own does not wait on a reviewer and that a
 * task decided against is one that leaves. Both halves were wrong in use: work
 * of his own sits waiting on a review as often as anything else does, and
 * deleting the thing you decided not to do destroys the record that you decided.
 * `Won't do` keeps it, in a section that is folded away.
 */
const TASK_CHOICES = STATUS_ORDER.map(id => ({ id, label: STATUS_LABEL[id] }))

/**
 * The three sections a live task can be in, in the order the phone lists them.
 *
 * In progress first because it is what he is actually holding; `Not started`
 * last because it is the biggest and the least urgent. `done` and `wont_do` are
 * not here — they are the two folded sections at the foot of the page.
 */
const LIVE_GROUPS = ['in_progress', 'in_review', 'not_started'] as const satisfies readonly CardStatus[]

/**
 * A goal is finished or it is not; there is no middle for it to be in.
 *
 * It still speaks in the shared words, so `Not started` means the same thing on
 * a goal as on a task and on a card — the ids are two of the five rather than a
 * private pair that happens to read the same.
 */
type GoalState = 'not_started' | 'done'
const GOAL_CHOICES = [
  { id: 'not_started', label: STATUS_LABEL.not_started },
  { id: 'done', label: STATUS_LABEL.done },
] as const satisfies ReadonlyArray<{ id: GoalState; label: string }>


/**
 * Put back a deleted task, field for field.
 *
 * The server has no soft delete for a task, so the undo is a re-creation: a new
 * id carrying every field the old one had, including the frozen provenance that
 * says where it came from. Its stickies are copied across too, because a note
 * points at the id that was just removed and would otherwise be stranded on a
 * row nothing renders. What genuinely does not survive is a reminder pointed at
 * the old id, which the server deletes with the task — that is worth knowing and
 * not worth a second table.
 *
 * `origin_meta` is stored as a JSON *string* and the create route stringifies
 * whatever it is handed, so passing the string straight through would write a
 * quoted blob and the provenance would come back as gibberish. It is parsed here
 * and dropped if it will not parse, because a task with no origin line is a
 * great deal better than one whose origin line is `"{\"repo\":…"`.
 */
async function recreateTask(t: Task) {
  let originMeta: unknown = null
  try {
    originMeta = t.origin_meta ? JSON.parse(t.origin_meta) : null
  } catch {
    originMeta = null
  }

  const made = await actions.createTask({
    title: t.title, detail: t.detail, status: t.status, goal_id: t.goal_id,
    source_card_group: t.source_card_group, due_at: t.due_at, color: t.color, sort: t.sort,
    // `started_at` and `completed_at` are normally derived from a status
    // *transition*, and a restore is not one — so a finished task came back with
    // no finish time and sorted to the bottom of a Done list ordered by exactly
    // that column. `restore` also keeps the undo out of the throughput counts:
    // an undo is not work that happened.
    started_at: t.started_at, completed_at: t.completed_at, restore: true,
    origin_source: t.origin_source, origin_title: t.origin_title, origin_why: t.origin_why,
    origin_url: t.origin_url, origin_excerpt: t.origin_excerpt, origin_meta: originMeta,
  }) as Task

  for (const n of t.notes ?? []) {
    await actions.createNote({ task_id: made.id, body: n.body, color: n.color, sort: n.sort })
  }
  await reload()
}

/* --------------------------- what the pane holds --------------------------- */

/**
 * What the pane is standing on, as the address bar spells it.
 *
 * Two functions rather than a template string and a `slice(5)` at the three
 * places that read it back. The slice is the whole reason: it encodes the
 * prefix's *length* at a call site that does not mention the prefix, so
 * renaming `task:` to anything else leaves a parse that still runs, still
 * returns a string, and resolves to no row at all.
 */
export const paneKey = (kind: PaneKind, id: string) => `${kind}:${id}`

export type PaneKind = 'task' | 'goal'

/**
 * The other direction, and it refuses everything it does not recognise.
 *
 * The address bar is user-editable and a stale link outlives the row it names,
 * so this is handed junk in the normal course of things. A key with no colon, an
 * unknown kind, or a kind with nothing after it are all "the pane is showing
 * nothing" rather than a lookup against an id of `''` — which would match no row
 * today and is one `find` predicate away from matching the wrong one.
 */
export function paneRef(key: string | null): { kind: PaneKind; id: string } | null {
  if (!key) return null
  const cut = key.indexOf(':')
  if (cut <= 0) return null
  const kind = key.slice(0, cut)
  const id = key.slice(cut + 1)
  if (!id) return null
  return kind === 'task' || kind === 'goal' ? { kind, id } : null
}

export function Work() {
  const { state } = useStore()
  const tab = (useParam('tab') === 'goals' ? 'goals' : 'tasks') as Tab
  /**
   * The sheets are addressed by id rather than by object.
   *
   * `task={editing}` used to hand the sheet a frozen snapshot: `reload()`
   * replaces every task object in the store and nothing re-pointed `editing` at
   * the new one, so a note added inside an open sheet did not appear until the
   * sheet was closed and opened again. An id survives a reload; an object does
   * not.
   */
  const [editingId, setEditingId] = useState<string | null>(null)
  /**
   * The row the phone is *reading*, which is not the row it is editing.
   *
   * Below the pane width a tap on a title used to open the whole editor — a
   * title field, a goal picker, two calendars, a palette and the notes — to
   * answer "what was this again". The read sheet is what that tap opens now;
   * `Edit` inside it is what opens the form.
   */
  const [readingId, setReadingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [goalEditingId, setGoalEditingId] = useState<string | 'new' | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [showDropped, setShowDropped] = useState(false)
  /**
   * Which of the rail's two sections the phone has open over the list.
   *
   * On a phone the rail is not a column beside the list, it is 400 pixels
   * wedged under it — so the reminders that went off and the recorder are a
   * badge in the header and a sheet each. At the pane width they are what they
   * always were, in the rail, where there is room for them.
   */
  const [railSheet, setRailSheet] = useState<'fired' | 'voice' | null>(null)
  const donePage = Math.max(1, Number(useParam('page')) || 1)
  /** The settled lists page independently: one parameter each, or `Show`ing the
   *  second one would land it on whatever page the first was left at. */
  const droppedPage = Math.max(1, Number(useParam('wpage')) || 1)

  const width = useViewport()
  /**
   * Below this the detail is the sheet the phone already has. It is the desk's
   * own threshold, imported rather than restated, because two pages disagreeing
   * about where a second column fits is how a layout drifts.
   */
  const hasPane = width >= PANE_MIN

  const tasks = state?.tasks ?? []
  const goals = state?.goals ?? []
  const reminders = state?.reminders ?? []
  const fired = (state?.notifications ?? []).filter(n => !n.read_at).slice(0, 6)

  /**
   * An unread list and an empty one are different things, and only one of them
   * gets the empty state. Without this the page says "nothing here yet, add
   * one" for the length of the first fetch, every load.
   */
  const loaded = !!state

  /** Live, so a reload lands inside the open sheet instead of beside it. */
  const editing = editingId === null ? null : tasks.find(t => t.id === editingId) ?? null
  const reading = readingId === null ? null : tasks.find(t => t.id === readingId) ?? null
  const goalEditing: Goal | 'new' | null =
    goalEditingId === 'new' ? 'new'
    : goalEditingId === null ? null
    : goals.find(g => g.id === goalEditingId) ?? null

  /** Any of the sheets this page owns. While one is up it holds the surface,
   *  and with it the single primary. */
  const sheetOpen =
    creating || editing !== null || reading !== null || goalEditing !== null || railSheet !== null

  /**
   * The task the edit sheet is animating with, which outlives the task it is
   * about by one exit.
   *
   * `editing` goes null the instant it is closed — or the instant its own
   * `Delete` lands — and the sheet then spends 180ms sliding out as a *New task*
   * form with empty fields and a different footer. Holding the last subject in a
   * ref costs nothing and the sheet leaves looking like the thing it was.
   */
  const lastEdited = useRef<Task | null>(null)
  useEffect(() => { if (editing) lastEdited.current = editing }, [editing])
  /** The same, for the read sheet: it leaves looking like the row it was. */
  const lastRead = useRef<Task | null>(null)
  useEffect(() => { if (reading) lastRead.current = reading }, [reading])

  /**
   * The notes live here rather than inside their own section, because they share
   * the pane with whatever row is open and the recorder must not be torn down by
   * a row being opened beside it. `null` is "not read yet" and reads as empty,
   * which is right: the common case is zero and it never flashes.
   */
  const [notes, setNotes] = useState<VoiceNote[] | null>(null)
  useEffect(() => {
    let live = true
    voiceApi.list()
      .then(d => { if (live) setNotes(d.notes) })
      .catch(() => { if (live) setNotes([]) })
    return () => { live = false }
  }, [])

  /**
   * Provenance, resolved once per render rather than per row: a task carries the
   * group key it was made from, and the card is what turns that key into the
   * name of the source it came from. Cards churn; the task does not, so a task
   * whose card is gone simply loses the line rather than breaking.
   */
  const cardByGroup = useMemo(
    () => new Map((state?.cards ?? []).map(c => [c.group_key, c])),
    [state?.cards],
  )

  /**
   * The list, cut into the sections it is drawn in.
   *
   * One pass rather than a `filter` per section: the store's order is the
   * server's — `sort, created_at DESC` — and pushing in that order is what keeps
   * a row in the same place within its section that it had on the flat list.
   * A task carrying a status this build does not know cannot land anywhere, so
   * `get` is allowed to miss; the server maps every row to one of the five on
   * its way out, which is what makes that unreachable rather than merely rare.
   */
  const live = useMemo(() => {
    const by = new Map<CardStatus, Task[]>(LIVE_GROUPS.map(s => [s, [] as Task[]]))
    for (const t of tasks) by.get(t.status)?.push(t)
    return by
  }, [tasks])

  /** Most recently finished first: the Done list is a record, read from the top. */
  const done = useMemo(
    () => tasks.filter(t => t.status === 'done').sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0)),
    [tasks],
  )
  /**
   * And the ones he decided against, newest first.
   *
   * By `updated_at`, not `completed_at`: a `wont_do` has no completion time —
   * the route clears it on every move that is not `done` — so ordering these by
   * that column would sort them all as zero and leave the list in creation
   * order, with the one he just dropped at the bottom.
   */
  const dropped = useMemo(
    () => tasks.filter(t => t.status === 'wont_do').sort((a, b) => b.updated_at - a.updated_at),
    [tasks],
  )

  /* -------------------------------- the pane ------------------------------- */

  /**
   * What the pane is showing, in the address bar.
   *
   * A query parameter rather than component state, for the reason the filter and
   * the page are: it survives a reload, and `navigate()` drops every parameter
   * on the way out — which is the whole of "the pane closes on its own cross or
   * on leaving Work" with no teardown code to get wrong. `replaceState` is
   * deliberate too: opening a row is a view of the page he is on, not a place he
   * went, so Back leaves Work rather than walking back through six rows.
   */
  const openKey = useParam('open')
  const ref = paneRef(openKey)
  const openTask = ref?.kind === 'task' ? tasks.find(t => t.id === ref.id) ?? null : null
  const openGoal = ref?.kind === 'goal' ? goals.find(g => g.id === ref.id) ?? null : null

  /**
   * The last row the pane actually resolved, so a deleted one does not blink the
   * column out from under him.
   *
   * The desk's pane falls back to the top row when its key resolves to nothing,
   * and that is right *there*: the desk is a triage surface and "the most likely
   * next thing" is a real answer to arriving at it. It is wrong here. This pane
   * is only ever opened by pressing a row, so substituting a different one would
   * put a task he did not choose under a cursor that was reading another — and
   * the most common way for the subject to vanish on this page is him ticking
   * its own checkbox, which is exactly the moment he is not looking at the pane.
   * So it holds the frame it had, says the row is gone, and drops the controls
   * that would write to an id the server no longer has. The undo lives in the
   * toast, and a restore is a new id, so the pane cannot follow it there either.
   */
  const lastPane = useRef<{ key: string; task: Task | null; goal: Goal | null } | null>(null)
  useEffect(() => {
    if (openKey && (openTask || openGoal)) lastPane.current = { key: openKey, task: openTask, goal: openGoal }
  }, [openKey, openTask, openGoal])
  const held = openKey && lastPane.current?.key === openKey ? lastPane.current : null
  const paneTask = openTask ?? held?.task ?? null
  const paneGoal = openGoal ?? held?.goal ?? null
  const paneGone = !!ref && !openTask && !openGoal
  /** Whether the rail is currently leading with a row's detail. See `railTail`. */
  const paneShown = hasPane && !!(paneTask || paneGoal)

  const closePane = () => setParam('open', null)
  const openRow = (t: Task) => (hasPane ? setParam('open', paneKey('task', t.id)) : setReadingId(t.id))
  const openGoalRow = (g: Goal) => (hasPane ? setParam('open', paneKey('goal', g.id)) : setGoalEditingId(g.id))

  /* ------------------------------- the writes ------------------------------ */

  /**
   * Every status a task takes, whoever asked for it.
   *
   * Undone by putting back the status it replaced rather than by a general
   * "restore", because a task has no undo record on the server and does not need
   * one: there is exactly one field in play and its previous value is in hand at
   * the moment it changes.
   */
  const setTaskStatus = async (t: Task, status: CardStatus) => {
    if (status === t.status) return
    const was = t.status
    optimistic(s => {
      const x = s.tasks.find(i => i.id === t.id)
      if (x) x.status = status
      return s
    })
    await actions.updateTask(t.id, { status })
    toast(`${STATUS_LABEL[status]}.`, {
      label: 'Undo',
      run: async () => { await actions.updateTask(t.id, { status: was }); await reload() },
    })
    void reload()
  }

  /*
   * The glyph used to be a switch, and it is a picker now. The reasoning it
   * carried was right about the thing it was arguing against, and that thing is
   * not what replaced it.
   *
   * It said:
   *
   *   > Done, or back to whatever it was before it was done — `Not started`
   *   > when this tab has forgotten. The other three are reachable from the
   *   > swipe's Status picker and from the read sheet, both of which show the
   *   > five at once; a control that steps through five states one press at a
   *   > time makes the fourth one four presses away and every mis-tap a state
   *   > to undo.
   *
   * Every word of that is a case against a **cycle**, and a cycle is not what a
   * picker is. In a five-step cycle the fourth state costs four presses and each
   * one commits; in the picker the five are on screen at once, none is further
   * away than any other, and you see the value before it is written rather than
   * after. The cost the comment was protecting against does not arrive.
   *
   * What the toggle cost instead, and why it had to go: it was a hidden two-
   * state machine wearing a control that draws five. Tapping a chip reading
   * `In review` sent it to `Done` with no warning, and the identical chip on the
   * identical row on the desk opened a picker — one glyph, two behaviours,
   * depending which page you were on. That is the complaint, and it is not
   * fixable while the tap means something this narrow.
   *
   * **The quick path survives, and it is still one motion.** It moved from a tap
   * to the swipe's `Done`, which was already there, already the same call, and
   * already remembered where the task came from. So the common case costs one
   * gesture, the other four cost a press and a pick, and nothing on this row now
   * behaves differently from the same row on the desk.
   *
   * `beforeDone` went with it. It existed so an untick could land on the state a
   * tick replaced; `setTaskStatus` already hands its own undo the exact previous
   * value, which is the same fact with a shorter life and no map to keep.
   */

  /** Delete, and a way back — see `recreateTask` for what a way back costs. */
  const removeTask = async (t: Task) => {
    optimistic(s => { s.tasks = s.tasks.filter(x => x.id !== t.id); return s })
    await actions.deleteTask(t.id)
    toast('Deleted.', { label: 'Undo', run: () => recreateTask(t) })
    void reload()
  }

  /**
   * Deleting a goal orphans the tasks that named it, so undoing has to adopt
   * them back.
   *
   * The server drops the row and leaves every `tasks.goal_id` pointing at an id
   * nothing resolves — which renders as the goal's chip simply vanishing from
   * those rows. A re-created goal has a new id, so without this the undo would
   * put the goal back and leave its work behind.
   */
  const removeGoal = async (g: Goal) => {
    const orphans = tasks.filter(t => t.goal_id === g.id).map(t => t.id)
    await actions.deleteGoal(g.id)
    await reload()
    toast('Deleted.', {
      label: 'Undo',
      run: async () => {
        // Field for field, the same way `recreateTask` puts a task back. A goal
        // restored without its `sort` jumps to the head of the list, and one
        // restored without `completed_at` comes back unfinished — so undoing the
        // delete of a goal he had marked Done would quietly un-do that too.
        const made = await actions.createGoal({
          title: g.title, detail: g.detail, color: g.color, target_date: g.target_date,
          sort: g.sort, completed_at: g.completed_at, restore: true,
        }) as Goal
        for (const id of orphans) await actions.updateTask(id, { goal_id: made.id })
        await reload()
      },
    })
  }

  const setGoalDone = async (g: Goal, done: boolean) => {
    await actions.updateGoal(g.id, { completed: done })
    await reload()
    toast(done ? `${STATUS_LABEL.done}.` : `${STATUS_LABEL.not_started}.`, {
      label: 'Undo',
      run: async () => { await actions.updateGoal(g.id, { completed: !done }); await reload() },
    })
  }

  const rowProps = (t: Task): TaskRowProps => ({
    task: t, reminders, goals,
    // The live card when there still is one, so the link is current; the frozen
    // copy when the poller has swept it, so the line does not vanish with the
    // pull request it was about.
    origin: cardByGroup.get(t.source_card_group ?? ''),
    selected: openKey === paneKey('task', t.id),
    onOpen: openRow,
    onStatus: setTaskStatus, onDelete: removeTask,
  })

  /**
   * The number beside the title counts what the tab beside it is showing.
   *
   * It was `todo.length + doing.length` unconditionally, which on `?tab=goals`
   * with no goals at all printed `Work 1` over an empty list — a count of a
   * list that was not on screen, sitting where a reader takes it for a count of
   * the one that was. A header that carries a tab carries the tab's number.
   *
   * The noun is not painted, because a zero-width header on a 360px phone needs
   * the two controls beside it more than it needs the word; it is on `title`
   * and in the accessible name instead, so the number is never bare to anything
   * that reads it out.
   */
  const open = tab === 'tasks'
    ? tasks.filter(t => !isSettled(t.status)).length
    : goals.filter(g => !g.completed_at).length
  const openNoun = `${tab === 'tasks' ? 'task' : 'goal'}${open === 1 ? '' : 's'} not done`

  return (
    /* The shell's own grid: a padded list column, then a pane on the same width
       token with the same left hairline the desk's detail and Mail's list use.
       Below the pane width the two simply stack, which is what they did anyway.

       The foot of the page clears the tab bar. `--nav-h` is the strip the bar
       owns — 53px plus the home indicator on a phone, nothing at all above
       `sm` — so without the reserve the last row of the list sits under it and
       can be neither read nor swiped. At `xl` the bar is a rail and it is 0. */
    <div className="xl:flex xl:items-stretch xl:min-h-dvh
                    pb-[var(--nav-h)] xl:pb-0">
      <div className="min-w-0 grow pad-x pb-8">
        {/*
          The header is rendered unconditionally, at every state of the page,
          which is half of the one-tree rule: the count and the empty line are
          things INSIDE it, not branches around it.

          It wraps. At 360px the title, a count, a two-segment control and a
          commit do not all fit on one line, and the failure mode of a row that
          cannot wrap is a control sliced by the screen edge — so the pair on the
          right drops to a second line instead of disappearing off one.
        */}
        <header className="flex items-center flex-wrap gap-x-3 gap-y-2 pt-4 pb-2">
          <PageTitle>Work</PageTitle>
          {/* A zero here is not information, and it is 32px of the phone's
              header row that the two controls beside it actually need. */}
          {loaded && open > 0 && (
            <span className="tnum text-sm text-fg-mute" title={`${open} ${openNoun}`}>
              {open}<span className="sr-only"> {openNoun}</span>
            </span>
          )}
          <span className="ml-auto flex items-center gap-2 sm:gap-4">
            {/*
              The rail, as two badges, on the width that has no rail.

              A reminder that went off and the recorder were a section each,
              stacked under the list on a phone — so the first thing under the
              row he was reading was a block about something else, and both of
              them were 800px down the page from the header that would have told
              him they were there. A badge says the number where he is looking
              and opens the thing itself on a press; nothing is lost except the
              distance.
            */}
            {!hasPane && fired.length > 0 && (
              <Button size="md" variant="default" onClick={() => setRailSheet('fired')}
                title="Reminders that went off"
                ariaLabel={`${fired.length} reminder${fired.length === 1 ? '' : 's'} went off`}>
                <BellRing size={14} /> <span className="tnum">{fired.length}</span>
              </Button>
            )}
            {!hasPane && (
              <Button size="md" variant="default" onClick={() => setRailSheet('voice')}
                title="Voice notes" ariaLabel="Voice notes">
                <Mic size={14} />
                {!!notes?.length && <span className="tnum">{notes.length}</span>}
              </Button>
            )}
            {/*
              A pill pair, not two words.

              The two bare `<button>`s this replaces argued for themselves in a
              comment: a choice between two lists, on a page already carrying one
              bordered control too many. The evidence says otherwise. Their whole
              selected state was `text-fg` against `text-fg-mute` — a colour swap
              on 13px text — and at 7am on a phone nothing on the screen said
              which of the two lists you were looking at. The segmented control
              is the product's own answer for a small fixed set, it is one
              control rather than two, and its active segment is a fill.
            */}
            <Segmented<Tab>
              ariaLabel="Which list"
              /*
                `To do`, not `Tasks`, and this is the losing half of a trade
                rather than an improvement on its own.

                The desk's first tab is called `Tasks` now (see `SourceTabs` in
                `Home.tsx`), and two destinations wearing one word is worse than
                either word being slightly off, so something had to move.

                What is uncomfortable about it: these are the actual `tasks`
                table — first-class objects with their own rows, their own API
                and their own provenance, per DECISIONS #10 — and the desk's
                unfiltered view is not. The word went to the surface with the
                weaker claim on it. The URL still says `?tab=tasks` and the type
                is still `Tab = 'tasks' | 'goals'`, because the underlying thing
                did not change and renaming storage to chase a label is how a
                schema ends up needing translating in both directions.

                `To do` is at least true, and is what he calls this list out
                loud. The real fix is one surface rather than two names, and
                that is a bigger change than a label.
              */
              options={[{ id: 'tasks', label: 'To do' }, { id: 'goals', label: 'Goals' }]}
              value={tab}
              onChange={id => setParam('tab', id === 'tasks' ? null : id)}
            />
            {/* The one primary in the product, and the only place amber marks a
                commit rather than a decision.

                It hands the amber over while its sheet is open. One primary per
                surface is the rule, and a sheet is the surface once it is up: the
                fill belongs to `Add task`, the button that actually commits. This
                one had already been pressed and is sitting behind a scrim with
                nothing left to ask for, so it spends the accent twice on one
                screen for a control that cannot be reached. */}
            <Button size="md" variant={sheetOpen ? 'default' : 'primary'}
              onClick={() => (tab === 'tasks' ? setCreating(true) : setGoalEditingId('new'))}>
              <Plus size={14} /> {tab === 'tasks' ? 'Task' : 'Goal'}
            </Button>
          </span>
        </header>

        {tab === 'tasks' ? (
          <>
            {/* One section per live status, in `LIVE_GROUPS` order, and a
                section with nothing in it is not rendered at all — a heading
                over an empty list is a section reporting its own absence. */}
            {LIVE_GROUPS.map(status => {
              const rows = live.get(status) ?? []
              return rows.length === 0 ? null : (
                <Group key={status} label={STATUS_LABEL[status]}>
                  {rows.map(t => <TaskRow key={t.id} {...rowProps(t)} />)}
                </Group>
              )
            })}

            {loaded && !tasks.length && <Blank what="tasks" onAdd={() => setCreating(true)} />}

            {/*
              The two settled lists are folded away, and they page.

              They are the only lists here that grow without limit — Done used
              to be cut at a hard `slice(0, 40)`, which is not a page, it is a
              silent floor under everything finished more than a few weeks ago.
              Folded because neither is work: they are the record of it, and a
              phone opening on 200 finished rows is a phone he has to scroll
              past to reach today. The count is on the heading, so the fold
              never hides how much is behind it.
            */}
            <Settled
              label={`${STATUS_LABEL.done} — ${done.length}`} rows={done} row={rowProps}
              shown={showDone} onShow={() => setShowDone(v => !v)}
              page={donePage} onPage={n => setParam('page', n === 1 ? null : String(n))}
            />
            <Settled
              label={`${STATUS_LABEL.wont_do} — ${dropped.length}`} rows={dropped} row={rowProps}
              shown={showDropped} onShow={() => setShowDropped(v => !v)}
              page={droppedPage} onPage={n => setParam('wpage', n === 1 ? null : String(n))}
            />
          </>
        ) : (
          <GoalList goals={goals} tasks={tasks} loaded={loaded} openKey={openKey}
            onOpen={openGoalRow} onAdd={() => setGoalEditingId('new')}
            onStatus={setGoalDone} onDelete={removeGoal} />
        )}
      </div>

      {/*
        The pane column, and it is one column with three things stacked in it
        rather than three layouts fighting over one slot.

        The detail sits above the two sections that were already here, instead of
        replacing them, and that is not a compromise: `Recorder` holds a live
        `MediaRecorder` and a running clock, so a pane that swapped its contents
        would end a recording every time a row was pressed beside it. Opening a
        row pushes the notes down the column; it does not take them away.

        Sticky, and only at the pane width. The list is 244 rows on a real day,
        so a row opened at y=1500 put its detail at the top of a document the
        reader was nowhere near — the pane was rendered, correct, and off
        screen. It holds the viewport and scrolls inside itself instead, which
        is what the desk's own pane does.

        Below `xl` it holds nothing at all now. It used to be the section under
        the list — a row's detail, then the reminders that went off, then the
        recorder, four hundred pixels of column stacked under the last task on a
        phone. The detail is a sheet at that width and the other two are the
        header's badges, so what is left here is an empty slot that keeps the
        tree the same shape at both widths, which is the rule this page is built
        on. Its `pb-24` went with the content: the page's own `--nav-h` is what
        clears the tab bar now, and two reserves would count the bar twice.
      */}
      <aside className="pad-x xl:pt-4 pb-8 xl:w-90 2xl:w-100 xl:shrink-0
                        xl:border-l xl:border-edge
                        xl:sticky xl:top-0 xl:h-dvh xl:overflow-y-auto xl:overscroll-contain">
        {hasPane && paneTask && (
          <TaskDetail
            task={paneTask} gone={paneGone} goals={goals} reminders={reminders}
            origin={cardByGroup.get(paneTask.source_card_group ?? '')}
            onClose={closePane} onEdit={() => setEditingId(paneTask.id)}
            onStatus={setTaskStatus}
            /* A delete pressed in here closes the pane, which is not the same
               call as the held frame above. The frame is for a row that went
               away somewhere else — swiped off the list, finished in another
               tab — where blanking the column would be an answer to something
               he never asked. Pressing Delete on the pane IS asking. */
            onDelete={t => { closePane(); void removeTask(t) }}
          />
        )}
        {hasPane && paneGoal && (
          <GoalDetail
            goal={paneGoal} gone={paneGone}
            linked={tasks.filter(t => t.goal_id === paneGoal.id)}
            onClose={closePane} onEdit={() => setGoalEditingId(paneGoal.id)}
            onOpenTask={openRow}
            onStatus={setGoalDone} onDelete={g => { closePane(); void removeGoal(g) }}
          />
        )}
        {/* Only where there is a column to put them in. Below `xl` these two
            are the header's badges and the sheets at the foot of this file, and
            rendering them here as well would put a second `Recorder` — a live
            `MediaRecorder` and a running clock — in the tree behind the one he
            is actually speaking into. */}
        {hasPane && <Fired rows={fired} lead={!paneShown} />}
        {hasPane && <VoiceNotes notes={notes} onNotes={setNotes} lead={!paneShown && !fired.length} />}
      </aside>

      <TaskSheet open={creating} onClose={() => setCreating(false)} />
      <TaskSheet open={!!editing} onClose={() => setEditingId(null)}
        task={editing ?? lastEdited.current} />
      <TaskRead
        open={!!reading}
        task={reading ?? lastRead.current}
        goals={goals} reminders={reminders}
        origin={cardByGroup.get((reading ?? lastRead.current)?.source_card_group ?? '')}
        onClose={() => setReadingId(null)}
        /* Reading and editing are one surface at a time: the form replaces the
           sheet it was opened from rather than stacking on top of it, or the
           back gesture has two sheets to walk out of. */
        onEdit={t => { setReadingId(null); setEditingId(t.id) }}
        onStatus={setTaskStatus}
        onDelete={t => { setReadingId(null); void removeTask(t) }}
      />
      <GoalSheet goal={goalEditing} onClose={() => setGoalEditingId(null)} />
      <RailSheet
        which={railSheet} onClose={() => setRailSheet(null)}
        fired={fired} notes={notes} onNotes={setNotes}
      />
    </div>
  )
}

/**
 * How a rail section separates itself from whatever is above it.
 *
 * The rail is a column of PEERS — the row you pressed, the reminders that went
 * off, and the recorder — and none of them owns another. Voice notes carried
 * `xl:mt-0`, which is right only while they are first in the column; open a
 * task and the same block sat 24 pixels under the pane's `Delete` with nothing
 * between them, where it read as "record a note about this task". Measured on
 * the deployed page at 1440×900: `Delete` bottom 274, `VOICE NOTES` top 298.
 *
 * The recorder stays in the rail rather than moving under the list, and that is
 * the decision, not a default. It holds a live `MediaRecorder` and a running
 * clock, so it has to live in exactly one place unconditionally — and of the
 * two places available, the rail is the one where a capture control is reachable
 * without scrolling past two hundred rows, and the one that keeps the column
 * from being empty when no row is open. What was wrong was never the address;
 * it was that nothing said where the pane stopped.
 *
 * So a section that is not first says so with the product's own elevation: one
 * pixel of edge, and equal air either side of it.
 */
const railTail = (lead: boolean) => (lead ? 'mt-8 xl:mt-0' : 'pt-6 border-t border-edge')

/** An eyebrow and rows. It is never amber: a heading colour is not a state. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-eyebrow uppercase text-fg-mute mb-2">{label}</h2>
      {children}
    </section>
  )
}

/**
 * A finished list, folded, with its size on the heading.
 *
 * `Done` and `Won't do` are the same shape and were nearly written twice; the
 * only thing that differs between them is which query parameter holds the page,
 * and that is a prop. An empty one renders nothing at all — not the heading,
 * not the `Show` — because a fold over zero rows is a control that reveals a
 * blank.
 */
function Settled({
  label, rows, row, shown, onShow, page, onPage,
}: {
  label: string
  rows: Task[]
  /** The row's props, resolved by the page that owns the writes. */
  row: (t: Task) => TaskRowProps
  shown: boolean
  onShow: () => void
  page: number
  onPage: (n: number) => void
}) {
  if (!rows.length) return null
  return (
    <Group label={label}>
      <Button size="sm" variant="ghost" onClick={onShow}>{shown ? 'Hide' : 'Show'}</Button>
      {shown && (
        <>
          {pageSlice(rows, page).map(t => <TaskRow key={t.id} {...row(t)} />)}
          <Pager page={page} pages={pageCount(rows.length)} total={rows.length} onPage={onPage} />
        </>
      )}
    </Group>
  )
}

/**
 * A list with nothing on it — one line and the one thing to press.
 *
 * `Empty` is a single muted word on the row grid, which is the right answer for
 * a filter that matched nothing and the wrong one for a whole page: on a phone
 * it left `No tasks`, the recorder, and eleven hundred pixels of nothing. This
 * is deliberately not a tutorial either. One sentence saying what the list is
 * for, and a button.
 *
 * The button is `secondary` rather than the amber. The page's own `+ Task` is a
 * primary sitting forty pixels above it and one surface spends the accent once;
 * two amber fills that do the same thing on one screen is the rule this product
 * holds itself to, backwards. `secondary` is the filled, bordered, full-contrast
 * variant that exists exactly for a control that must be unmistakably pressable
 * without claiming to be the commit — and at `lg` it is the biggest thing on an
 * otherwise empty page, which is the whole job.
 *
 * An audit called this a duplicate of the header's `+ Task` — two controls for
 * one action, "sixty to a hundred and thirty pixels apart". That number is the
 * vertical gap and nothing else. Measured on the deployed page with an empty
 * Goals list, the two centres are 258px apart at 375 and 738px apart at 1440,
 * because the header control is right-aligned and this one is left-aligned:
 * they sit at opposite corners of the screen, not beside each other. A toolbar
 * action and the empty state's own answer to its own sentence are not the same
 * control twice, and the redundancy that WAS real here — both of them amber —
 * is the one that got fixed.
 */
function Blank({ what, onAdd }: { what: Tab; onAdd: () => void }) {
  return (
    <div className="py-2">
      <p className="text-base text-fg-dim max-w-prose">
        {what === 'tasks'
          ? 'Your own work, in the order you mean to do it.'
          : 'The few things all of it is moving toward.'}
      </p>
      <Button size="lg" variant="secondary" className="mt-3" onClick={onAdd}>
        <Plus size={14} /> {what === 'tasks' ? 'Add a task' : 'Add a goal'}
      </Button>
    </div>
  )
}

/* --------------------------------- the pane -------------------------------- */

/** A heading and a rule, so the pane's sections read as one column of facts. */
function PaneHead({
  title, done, gone, onClose,
}: { title: string; done: boolean; gone: boolean; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2">
      <h2 className={`grow min-w-0 text-md font-medium tracking-[-0.01em] line-clamp-3
                      ${done || gone ? 'line-through text-fg-dim' : 'text-fg'}`}>
        {title}
      </h2>
      {/* The pane had no close control of any kind — not a cross, not a
          collapse. This is the one, and it is the only thing besides leaving
          Work that shuts it. */}
      <Button variant="ghost" size="sm" onClick={onClose} title="Close" ariaLabel="Close">
        <X size={14} />
      </Button>
    </div>
  )
}

/**
 * One labelled fact, on the pane's own grid.
 *
 * It wraps, which is not decoration: the pane is 360px at `xl` and a `Deadline`
 * label plus a native `datetime-local` and its Clear measure more than the
 * ~310px left after the page pad. A row that cannot wrap answers that by
 * pushing the page sideways, which is the one thing this product measures
 * itself against — so the control drops under its own label instead.
 */
function PaneRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center flex-wrap gap-x-3 gap-y-1 py-2 min-h-11 border-b border-rule">
      <span className="text-sm text-fg-mute w-24 shrink-0">{label}</span>
      <span className="min-w-0 grow flex items-center justify-end">{children}</span>
    </div>
  )
}

/**
 * The row he pressed, read in the column rather than over it.
 *
 * It is not a second copy of the sheet. The two things anybody changes while
 * *reading* a task are where it stands and when it is wanted, so those are the
 * two controls here; the title, the reminder, the colour and the goal are a
 * form, and a form belongs in the sheet `Edit` opens. Notes are the task's
 * content rather than a field of it, so they are readable here and one line adds
 * another.
 */
function TaskDetail({
  task, gone, goals, reminders, origin, onClose, onEdit, onStatus, onDelete,
}: {
  task: Task
  /** The row is no longer in the store. See `lastPane` for why it still paints. */
  gone: boolean
  goals: Goal[]; reminders: any[]
  origin?: { title: string; url: string; sources: Array<{ source: keyof typeof SOURCE_LABEL }> }
  onClose: () => void
  onEdit: () => void
  onStatus: (t: Task, s: CardStatus) => void
  onDelete: (t: Task) => void
}) {
  const still = useStill()
  const [noteBody, setNoteBody] = useState('')
  /** The deadline calendar's disclosure. Shut on every task — see the row. */
  const [dueOpen, setDueOpen] = useState(false)
  useEffect(() => { setNoteBody(''); setDueOpen(false) }, [task.id])

  const goal = goals.find(g => g.id === task.goal_id)
  const reminder = reminders.find(
    r => r.target_kind === 'task' && r.target_id === task.id && !r.fired_at && !r.dismissed_at)
  // Settled, not just done: a deadline on a task he decided against is not late,
  // it is irrelevant, and painting it red asks him to act on a closed row.
  const overdue = task.due_at && task.due_at < Date.now() && !isSettled(task.status)

  const source = (origin?.sources[0]?.source ?? task.origin_source) as keyof typeof SOURCE_LABEL | undefined
  const url = origin?.url ?? task.origin_url ?? undefined

  const addNote = async () => {
    const body = noteBody.trim()
    if (!body) return
    setNoteBody('')
    await actions.createNote({ task_id: task.id, body, color: task.color })
    await reload()
  }

  return (
    <section className="mb-8 xl:mb-6">
      <PaneHead title={task.title} done={isSettled(task.status)} gone={gone} onClose={onClose} />

      {gone ? (
        // No controls at all on a frame that is being held: every one of them
        // would write to an id the server has already dropped.
        <p className="mt-2 text-sm text-fg-mute">
          Deleted. The undo is in the toast; a restored task comes back on the list.
        </p>
      ) : (
        <>
          <div className="mt-3">
            {/* The glyph beside the control, the way the card's own detail
                pane carries it: the `Select` says the word, and the mark is
                what the eye finds when it comes back to the column. */}
            <PaneRow label="Status">
              <StatusGlyph status={task.status} />
              <Select<CardStatus>
                value={task.status}
                options={TASK_CHOICES}
                onChange={s => onStatus(task, s)}
                ariaLabel="Status"
                className="ml-2"
              />
            </PaneRow>
            {/*
              The field is the disclosure, and the calendar is behind it.

              This was a bare `<input type="datetime-local">`, which on a task
              with no deadline renders as the literal string
              `dd/mm/yyyy, --:-- --` — while the sheet three presses away
              answered the same question with a month grid. Two answers to "how
              do I set a date" is one too many, and the native box was the worse
              of them. This is the shape the desk's Due row settled on: the
              value states itself without being pressed, and pressing it unfolds
              the real calendar full-width underneath. What the press reveals is
              the *control*, not the choice, so it is not a menu.

              `deadlineWords` is the words — the same ones the list row prints,
              including its own `late —`, which is why the separate red `late`
              span that used to sit beside the input is gone rather than moved.
              The pane must not grow a second vocabulary for the same fact.
            */}
            <PaneRow label="Deadline">
              <button
                type="button"
                onClick={() => setDueOpen(v => !v)}
                aria-expanded={dueOpen}
                aria-label={`Deadline — ${task.due_at === null ? 'none set' : deadlineWords(task.due_at)}`}
                title={task.due_at === null ? undefined : deadlineWords(task.due_at)}
                className="hit relative w-full inline-flex items-center justify-between gap-2
                           h-8 px-2 rounded-control border border-edge text-sm font-medium
                           hover:bg-ink-800 transition-colors duration-100"
              >
                <span className={`truncate ${
                  task.due_at === null ? 'text-fg-mute' : overdue ? 'text-bad' : 'text-fg-dim'}`}>
                  {task.due_at === null ? 'No deadline' : deadlineWords(task.due_at)}
                </span>
                <ChevronDown size={13} aria-hidden
                  className={`shrink-0 text-fg-mute transition-transform duration-100 ${dueOpen ? 'rotate-180' : ''}`} />
              </button>
            </PaneRow>
            {/* Outside the `PaneRow`, because a row is a 44px line and seven
                calendar cells want the pane's whole width — 272px across is the
                difference between a usable grid and a decorative one. */}
            <AnimatePresence initial={false}>
              {dueOpen && (
                <motion.div
                  key="due-picker"
                  initial={still ? false : { height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={still ? undefined : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                  className="overflow-hidden border-b border-rule"
                >
                  <div className="py-3">
                    <DateTimePicker
                      value={task.due_at}
                      onChange={async at => {
                        await actions.updateTask(task.id, { due_at: at })
                        await reload()
                      }}
                      ariaLabel="Deadline"
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {goal && (
              <PaneRow label="Goal">
                <span className="min-w-0 inline-flex items-center gap-2 text-sm text-fg-dim">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: goal.color ?? 'var(--color-fg-mute)' }} />
                  <span className="truncate">{goal.title}</span>
                </span>
              </PaneRow>
            )}
            {reminder && (
              <PaneRow label="Reminder">
                <span className="inline-flex items-center gap-2 text-sm text-fg-dim">
                  <Bell size={12} /> {wallClock(reminder.fire_at)}
                </span>
              </PaneRow>
            )}
            {source && (
              <PaneRow label="From">
                {url?.startsWith('http') ? (
                  <a href={url} target="_blank" rel="noreferrer"
                    title={origin?.title ?? task.origin_title ?? undefined}
                    className="min-w-0 text-sm text-fg-dim hover:text-fg transition-colors duration-100 truncate">
                    {SOURCE_LABEL[source] ?? source}
                  </a>
                ) : (
                  <span className="min-w-0 text-sm text-fg-dim truncate">{SOURCE_LABEL[source] ?? source}</span>
                )}
              </PaneRow>
            )}
          </div>

          <div className="mt-4">
            <div className="text-eyebrow uppercase text-fg-mute mb-2">Notes</div>
            <div className="space-y-2 mb-2">
              {task.notes?.map(n => (
                <div key={n.id}
                  className="relative rounded-chip px-3 py-2 text-sm leading-relaxed"
                  style={{
                    background: `color-mix(in oklab, ${n.color ?? 'var(--color-accent)'} 12%, var(--color-ink-800))`,
                    boxShadow: `inset 2px 0 0 ${n.color ?? 'var(--color-accent)'}`,
                  }}>
                  <span className="whitespace-pre-wrap text-fg-dim pr-5">{n.body}</span>
                  <button
                    onClick={async () => { await actions.deleteNote(n.id); await reload() }}
                    className="absolute top-1.5 right-1.5 p-1 text-fg-mute hover:text-bad
                               transition-colors duration-100"
                    aria-label="Delete note"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                className={inputClass} value={noteBody}
                onChange={e => setNoteBody(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void addNote() }}
                placeholder="Add a note"
              />
              <Button variant="ghost" onClick={addNote} disabled={!noteBody.trim()} ariaLabel="Add note">
                <Plus size={14} />
              </Button>
            </div>
          </div>

          {/* Three real buttons rather than a rail of ghosts: an action bar made
              of four ghost labels reads as a caption. `Edit` is where the rest
              of the form lives, which is why it leads. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={onEdit}>Edit</Button>
            <Button variant="default" title="Send to Claude Code"
              onClick={() => openLaunch(taskContext(task, goal), {
                template: 'blank',
                title: task.title,
                repoHint: taskRepoHint(task.origin_meta),
              })}>
              <SquareTerminal size={14} /> Claude
            </Button>
            <Button variant="ghost" className="ml-auto" onClick={() => onDelete(task)}>
              <Trash2 size={14} /> Delete
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

/**
 * A goal in the pane, which is the first surface in the product that answers
 * "what is actually under this".
 *
 * The list rows only ever showed `3/7`. The seven are the goal's content and
 * they were unreachable from it — the only way to see them was to remember which
 * tasks carried the chip. Each one opens in this same pane.
 */
function GoalDetail({
  goal: g, gone, linked, onClose, onEdit, onOpenTask, onStatus, onDelete,
}: {
  goal: Goal
  gone: boolean
  linked: Task[]
  onClose: () => void
  onEdit: () => void
  onOpenTask: (t: Task) => void
  onStatus: (g: Goal, done: boolean) => void
  onDelete: (g: Goal) => void
}) {
  const finished = !!g.completed_at
  const done = linked.filter(t => t.status === 'done').length

  return (
    <section className="mb-8 xl:mb-6">
      <PaneHead title={g.title} done={finished} gone={gone} onClose={onClose} />

      {gone ? (
        <p className="mt-2 text-sm text-fg-mute">
          Deleted. The undo is in the toast; a restored goal comes back on the list.
        </p>
      ) : (
        <>
          {g.detail && <p className="mt-2 text-sm text-fg-dim whitespace-pre-wrap">{g.detail}</p>}

          <div className="mt-3">
            <PaneRow label="Status">
              <StatusGlyph status={finished ? 'done' : 'not_started'} />
              <Select<GoalState>
                value={finished ? 'done' : 'not_started'}
                options={GOAL_CHOICES}
                onChange={s => onStatus(g, s === 'done')}
                ariaLabel="Status"
                className="ml-2"
              />
            </PaneRow>
            <PaneRow label="Target">
              <span className="text-sm text-fg-dim tnum">
                {g.target_date ? shortDate(g.target_date) : '—'}
              </span>
            </PaneRow>
            <PaneRow label="Work">
              <span className="text-sm text-fg-dim tnum">{done}/{linked.length}</span>
            </PaneRow>
          </div>

          {/* An empty group is not rendered at all — a `Tasks` heading over
              nothing is a section reporting its own absence. */}
          {linked.length > 0 && (
            <div className="mt-4">
              <div className="text-eyebrow uppercase text-fg-mute mb-2">Tasks</div>
              {linked.map(t => (
                <button key={t.id} onClick={() => onOpenTask(t)}
                  className={`w-full text-left flex items-center gap-2 min-h-11 py-2 ${rowStateClass()}
                              border-b border-rule last:border-0`}>
                  {/* The shared slot, not three circles of this file's own.
                      The fixed width is what keeps five titles on one x down
                      the column when the glyphs beside them differ. */}
                  <StatusSlot status={t.status} />
                  <span className={`text-base truncate ${isSettled(t.status) ? 'text-fg-mute line-through' : ''}`}>
                    {t.title}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={onEdit}>Edit</Button>
            <Button variant="ghost" className="ml-auto" onClick={() => onDelete(g)}>
              <Trash2 size={14} /> Delete
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

/* --------------------------------- the rows -------------------------------- */

export type TaskRowProps = {
  task: Task; goals: Goal[]; reminders: any[]
  origin?: { title: string; url: string; sources: Array<{ source: keyof typeof SOURCE_LABEL }> }
  /** This is the row the pane is showing. */
  selected: boolean
  /** Open this row in the pane. The glyph beside it is the shared status picker. */
  onOpen: (t: Task) => void
  onStatus: (t: Task, s: CardStatus) => void
  onDelete: (t: Task) => void
}

function TaskRow({
  task, goals, reminders, origin, selected, onOpen, onStatus, onDelete,
}: TaskRowProps) {
  /*
   * `pan-y`, on every task row, which is the split every other row in the
   * product uses: vertical is the page's, horizontal is the drawer's.
   *
   * It was `none` on a draggable row, because `Reorder.Item` writes
   * `touch-action: pan-x` inline to claim the vertical axis for its drag and
   * `pan-x` hands the browser the horizontal one — the axis this gesture is
   * made of. Both of those answers take the page's own scroll away: with either
   * declaration in force a thumb dragging up the list moved nothing at all,
   * which is the "frozen app" failure `lib/swipe.ts` puts above every gesture
   * here. Neither can be overruled from this file, and `pan-y` cannot outrank an
   * inline declaration, so the reorder is what went — see the note at the top of
   * this file. Nothing writes an inline `touch-action` on this row now, the
   * stylesheet's `[data-swipe='pan-y']` rule applies, and the drawer still opens
   * because `axisFor` only calls a gesture horizontal after 12px of travel that
   * is 1.5× more sideways than it is vertical.
   */
  const swipe = useSwipe(`task:${task.id}`, 3)
  const drawer = (
    <SwipeDrawer
      offset={swipe.offset}
      live={swipe.live}
      width={swipe.width}
      onClose={swipe.close}
      onDone={() => onStatus(task, 'done')}
      onDelete={() => onDelete(task)}
      status={{
        current: task.status,
        // All five, including the `Won't do` that used to be reachable only by
        // deleting the row it was written on.
        options: TASK_CHOICES,
        onPick: id => onStatus(task, id as CardStatus),
      }}
    />
  )
  const goal = goals.find(g => g.id === task.goal_id)
  const reminder = reminders.find(r => r.target_kind === 'task' && r.target_id === task.id && !r.fired_at && !r.dismissed_at)
  // Settled, not just done: a deadline on a task he decided against is not late,
  // it is irrelevant, and painting it red asks him to act on a closed row.
  const overdue = task.due_at && task.due_at < Date.now() && !isSettled(task.status)

  const source = (origin?.sources[0]?.source ?? task.origin_source) as keyof typeof SOURCE_LABEL | undefined
  const provenance = source
    ? {
        label: SOURCE_LABEL[source] ?? source,
        url: origin?.url ?? task.origin_url ?? undefined,
        title: origin?.title ?? task.origin_title ?? undefined,
      }
    : null

  const body = (
    <div className="flex items-start gap-3 py-2 min-h-11">
      {/*
        The status, painted by the one file allowed to paint one, and the row's
        primary verb at the same time.

        This was a private `Circle` / `CircleDot` / `CircleCheck` in `fg-mute`,
        `fg` and `ok`: three marks for five states, two of which the desk had
        been drawing differently for a release. The chip carries the glyph, the
        word and the hue washed behind both, so the row says where it stands
        without the reader having to have learned a ring.

        `hit relative` is the 44px collar. The glyph alone was 14×16 with no
        `position`, so `.hit` had nothing to hang a collar on and the row's
        `items-start` pinned all 224px² of it into the top-left corner —
        measured, on the one control that takes a task off the list. Nothing
        else on the row is within reach of the collar except the first few
        pixels of the title, which opens the row this chip is already on.
      */}
      {/*
        The same picker the desk row and the detail pane use, rather than this
        page's own tap-to-toggle. See the note beside `setTaskStatus` for why the
        toggle's reasoning did not survive contact with the picker, and where the
        one-motion `Done` it was protecting went.

        `stopPropagation` still, and for the unchanged reason: setting a status
        is not asking to read the task.
      */}
      <span className="shrink-0" onClick={e => e.stopPropagation()}>
        <StatusPicker
          value={task.status}
          onChange={(s: CardStatus) => onStatus(task, s)}
          of={task.title}
        />
      </span>

      <div className="min-w-0 grow cursor-pointer" onClick={() => onOpen(task)}>
        <div className={`text-base ${isSettled(task.status) ? 'text-fg-mute line-through' : 'text-fg'}`}>
          {task.title}
        </div>

        {!!(goal || task.due_at || reminder || task.notes?.length) && (
          <div className="mt-0.5 flex items-center gap-x-3 gap-y-1 flex-wrap text-sm text-fg-mute">
            {goal && (
              <span className="inline-flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: goal.color ?? 'var(--color-fg-mute)' }} />
                {goal.title}
              </span>
            )}
            {/* The wall-clock time he picked, not a distance from now. */}
            {task.due_at && (
              <span className={overdue ? 'text-bad' : 'text-fg-dim'}>{deadlineWords(task.due_at)}</span>
            )}
            {reminder && (
              <span className="inline-flex items-center gap-2">
                <Bell size={12} />
                {wallClock(reminder.fire_at)}
              </span>
            )}
            {!!task.notes?.length && <span>{task.notes.length} note{task.notes.length > 1 ? 's' : ''}</span>}
            {provenance && (
              <a
                href={provenance.url?.startsWith('http') ? provenance.url : undefined}
                target="_blank" rel="noreferrer"
                onClick={e => e.stopPropagation()}
                className="hover:text-fg-dim transition-colors duration-100"
                title={provenance.title}
              >
                {provenance.label}
              </a>
            )}
          </div>
        )}
      </div>

      {/* No terminal glyph here any more. A row is a status, a title and its
          meta; `Open in Claude` is one press further in — on the pane at the
          desk width and in the read sheet on a phone — because it is an action
          on a task he has decided to work on, not a thing to offer on all two
          hundred of them. */}

      {task.color && (
        <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: task.color }} />
      )}
    </div>
  )

  // One row treatment, shared with every other list in the product: lightness is
  // attention, so the row the pane is showing is plainly not the row under the
  // cursor. Hover is emitted only when nothing else is set.
  const rowClass = `relative border-b border-rule last:border-0 ${rowStateClass({ selected })}`

  // One shape for every row on the page. There were two — a `Reorder.Item` for
  // the live lists and a plain block for the finished one — and the two
  // disagreed about which axis the browser owned, which is how the Done list
  // scrolled under a thumb while the list above it did not.
  return (
    <div
      ref={swipe.bind.ref}
      onPointerDown={swipe.bind.onPointerDown}
      onPointerMove={swipe.bind.onPointerMove}
      onPointerUp={swipe.bind.onPointerUp}
      onPointerCancel={swipe.bind.onPointerCancel}
      onClickCapture={swipe.bind.onClickCapture}
      data-swipe={swipe.bind['data-swipe']}
      // `user-select: none` while the drawer is moving. The `removeAllRanges()`
      // at engage only clears what the first twelve pixels selected; without
      // this the rest of a mouse drag highlights the row's title and meta blue
      // under the open drawer, and leaves them highlighted afterwards.
      style={swipe.bind.style}
      className={rowClass}
    >
      {body}
      {drawer}
    </div>
  )
}

function GoalList({
  goals, tasks, loaded, openKey, onOpen, onAdd, onStatus, onDelete,
}: {
  goals: Goal[]; tasks: Task[]
  loaded: boolean
  openKey: string | null
  onOpen: (g: Goal) => void
  onAdd: () => void
  onStatus: (g: Goal, done: boolean) => void
  onDelete: (g: Goal) => void
}) {
  if (!goals.length) return loaded ? <Blank what="goals" onAdd={onAdd} /> : null
  return (
    <div>
      {goals.map(g => (
        <GoalRow
          key={g.id} goal={g}
          selected={openKey === paneKey('goal', g.id)}
          linked={tasks.filter(t => t.goal_id === g.id)}
          onOpen={onOpen} onStatus={onStatus} onDelete={onDelete}
        />
      ))}
    </div>
  )
}

/**
 * A goal is its own row so it can hold a gesture.
 *
 * The list was a `.map` returning a `<button>`, which is the one element the
 * drawer cannot live inside: its three actions are buttons themselves, and a
 * button inside a button is not a thing the platform renders. The press target
 * stays a button; the swipe and its drawer are the block around it.
 */
function GoalRow({
  goal: g, selected, linked, onOpen, onStatus, onDelete,
}: {
  goal: Goal; selected: boolean; linked: Task[]
  onOpen: (g: Goal) => void
  onStatus: (g: Goal, done: boolean) => void
  onDelete: (g: Goal) => void
}) {
  const reduce = useStill()
  const swipe = useSwipe(`goal:${g.id}`, 3)
  const done = linked.filter(t => t.status === 'done').length
  const pct = linked.length ? done / linked.length : 0
  const color = g.color ?? 'var(--color-fg-dim)'
  const finished = !!g.completed_at

  return (
    <div
      ref={swipe.bind.ref}
      onPointerDown={swipe.bind.onPointerDown}
      onPointerMove={swipe.bind.onPointerMove}
      onPointerUp={swipe.bind.onPointerUp}
      onPointerCancel={swipe.bind.onPointerCancel}
      onClickCapture={swipe.bind.onClickCapture}
      data-swipe={swipe.bind['data-swipe']}
      style={swipe.bind.style}
      className={`relative border-b border-rule last:border-0 ${rowStateClass({ selected })}`}
    >
      <button onClick={() => onOpen(g)} className="w-full text-left py-3">
        <div className="flex items-baseline gap-3">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
          {/* A finished goal reads like a finished task. Without this the Done
              action would write a column nothing on the page draws, which is a
              control that does nothing you can see. */}
          <span className={`text-base grow ${finished ? 'text-fg-mute line-through' : ''}`}>
            {g.title}
          </span>
          {g.target_date && <span className="text-sm text-fg-mute">by {shortDate(g.target_date)}</span>}
          <span className="tnum text-sm text-fg-mute">{done}/{linked.length}</span>
        </div>
        <div className="mt-2 h-1 bg-ink-800 rounded-full overflow-hidden">
          <motion.div
            className="h-full rounded-full"
            style={{ background: color }}
            initial={reduce ? false : { width: 0 }}
            animate={{ width: `${pct * 100}%` }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      </button>
      <SwipeDrawer
        offset={swipe.offset}
        live={swipe.live}
        width={swipe.width}
        onClose={swipe.close}
        onDone={() => onStatus(g, true)}
        onDelete={() => onDelete(g)}
        status={{
          // Two options, in the shared words, so the picker on a goal row is
          // painted by the same table as the one on a task row two lists over.
          current: finished ? 'done' : 'not_started',
          options: GOAL_CHOICES,
          onPick: id => onStatus(g, id === 'done'),
        }}
      />
    </div>
  )
}

function GoalSheet({ goal, onClose }: { goal: Goal | null | 'new'; onClose: () => void }) {
  const isNew = goal === 'new'
  const g = isNew ? null : goal
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [target, setTarget] = useState<number | null>(null)

  useMemo(() => {
    setTitle(g?.title ?? '')
    setDetail(g?.detail ?? '')
    setColor(g?.color ?? null)
    setTarget(g?.target_date ?? null)
  }, [g?.id, isNew])

  if (!goal) return null

  const save = async () => {
    if (!title.trim()) return
    await (g
      ? actions.updateGoal(g.id, body())
      : actions.createGoal(body()))
    await reload()
    onClose()
  }
  const body = () => ({
    title: title.trim(), detail: detail.trim() || null, color, target_date: target,
  })

  return (
    <Sheet open onClose={onClose} title={g ? 'Edit goal' : 'New goal'}
      footer={
        <div className="flex gap-2">
          {g && (
            <Button variant="ghost" onClick={async () => { await actions.deleteGoal(g.id); await reload(); onClose() }}>
              Delete
            </Button>
          )}
          <Button size="lg" variant="primary" className="grow" onClick={save} disabled={!title.trim()}>
            {g ? 'Save' : 'Add goal'}
          </Button>
        </div>
      }>
      {/*
        No `autoFocus`, here or anywhere else on this page.

        On iOS a focused field raises the keyboard the instant the sheet
        appears: half the surface is gone before it has finished sliding up, the
        commit in the footer is under the keyboard, and the animation stutters
        while the viewport is remeasured. The keyboard comes up when he taps the
        field, which is the moment he actually asked for it.
      */}
      <Field label="Goal">
        <input className={inputClass} value={title}
          onChange={e => setTitle(e.target.value)} placeholder="What are you moving toward?" />
      </Field>
      <Field label="Detail">
        <textarea className={`${inputClass} min-h-16 resize-y`} value={detail}
          onChange={e => setDetail(e.target.value)} placeholder="Optional" />
      </Field>
      {/*
        A calendar, for the same reason the deadline is one.

        This was a bare `<input type="date">` — the only unstyled native control
        left on the page, and the only field in the product that answered "when"
        with a box you have to type into. The picker states the answer back
        underneath rather than leaving the field to speak for itself, and Clear
        is how a goal says it has no date.
      */}
      <div className="mb-4">
        <div className="text-eyebrow uppercase text-fg-mute mb-2">Target date</div>
        <DateTimePicker value={target} onChange={setTarget} ariaLabel="Target date" />
        <p className="mt-2 text-sm text-fg-dim">
          {target ? `By ${shortDate(target)}` : 'No target date'}
        </p>
      </div>
      {/* Named and hittable, for the reasons the task sheet's palette gives:
          seven 24px circles at a 32px pitch are seven unlabelled buttons with
          576px² of target each, and `gap-5` is the pitch at which a 44px collar
          owns its own circle instead of half its neighbour's. */}
      <Field label="Colour">
        <div className="flex gap-5 items-center">
          <button onClick={() => setColor(null)} title="No colour" aria-label="No colour"
            aria-pressed={!color}
            className={`hit relative w-6 h-6 rounded-full border ${!color ? 'border-fg-dim' : 'border-edge'}`} />
          {NOTE_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)} style={{ background: c }}
              title={noteColorName(c)} aria-label={noteColorName(c)} aria-pressed={color === c}
              className={`hit relative w-6 h-6 rounded-full ${color === c ? 'ring-2 ring-offset-2 ring-offset-ink-850 ring-fg-dim' : ''}`} />
          ))}
        </div>
        <p className="mt-2 text-sm text-fg-mute">
          {color === null
            ? 'No colour'
            : `${noteColorName(color)} — tints this goal's dot and its progress bar.`}
        </p>
      </Field>
    </Sheet>
  )
}

/**
 * Reminders that have already fired.
 *
 * `notifications` rows were written by every fired reminder and displayed by
 * nothing — `grep -rn notifications src/web/` found no component that rendered
 * one. So a reminder set for a device count of zero went off, wrote a row, and
 * vanished. This is the somewhere it is visible: beside the tasks the reminders
 * were about.
 */
type FiredRow = { id: string; title: string; body?: string | null; created_at: number }

/**
 * The rows themselves, so the rail and the phone's sheet show one list rather
 * than two that were written twice and drifted.
 */
function FiredRows({ rows }: { rows: FiredRow[] }) {
  return (
    <>
      {rows.map(n => (
        <div key={n.id} className="flex items-start gap-2 py-2 border-b border-rule last:border-0">
          <BellRing size={14} className="text-fg-mute mt-0.5 shrink-0" />
          <div className="min-w-0 grow">
            <div className="text-base text-fg-dim truncate">{n.title}</div>
            {n.body && <div className="text-sm text-fg-mute truncate">{n.body}</div>}
            <div className="text-sm text-fg-mute tnum">{wallClock(n.created_at)}</div>
          </div>
          <Button size="sm" variant="ghost" title="Dismiss" ariaLabel="Dismiss"
            onClick={async () => { await actions.readNotification(n.id); await reload() }}>
            <X size={13} />
          </Button>
        </div>
      ))}
    </>
  )
}

function Fired({
  rows, lead,
}: {
  rows: FiredRow[]
  /** This is the first thing in the rail — see `railTail`. */
  lead: boolean
}) {
  if (!rows.length) return null
  return (
    <section className={`mb-6 ${railTail(lead)}`}>
      <h2 className="text-eyebrow uppercase text-fg-mute mb-1">Went off</h2>
      <FiredRows rows={rows} />
    </section>
  )
}

/**
 * The rail's two sections on a phone, one at a time, over the list.
 *
 * A sheet rather than a block at the foot of the page: below `xl` the rail is
 * not a column, it is four hundred pixels of somebody else's business under the
 * row he was reading. The badge in the header says the number; this is what the
 * badge opens.
 *
 * The recorder is inside it, which means closing the sheet ends a recording in
 * progress. That is the one place a `MediaRecorder` may be torn down — he did
 * it, deliberately, with the cross — and it is why the rail keeps its own copy
 * at the pane width instead of both surfaces sharing one.
 */
function RailSheet({
  which, onClose, fired, notes, onNotes,
}: {
  which: 'fired' | 'voice' | null
  onClose: () => void
  fired: FiredRow[]
  notes: VoiceNote[] | null
  onNotes: (fn: (prev: VoiceNote[] | null) => VoiceNote[]) => void
}) {
  return (
    <Sheet open={which !== null} onClose={onClose}
      title={which === 'fired' ? 'Went off' : 'Voice notes'}>
      {which === 'fired' && <FiredRows rows={fired} />}
      {which === 'voice' && <VoiceBody notes={notes} onNotes={onNotes} />}
    </Sheet>
  )
}

/**
 * Voice notes, beside the list rather than under it.
 *
 * They live on this page because a note is a note; the only difference is that
 * this one was easier to make while walking.
 */
function VoiceBody({
  notes, onNotes,
}: {
  notes: VoiceNote[] | null
  onNotes: (fn: (prev: VoiceNote[] | null) => VoiceNote[]) => void
}) {
  const rows = notes ?? []
  return (
    <>
      <Recorder onSaved={n => onNotes(prev => [n, ...(prev ?? [])])} />

      {/* No dash under an empty list. Zero notes is the mic and nothing else —
          the second em dash on this page was the other half of a two-column
          void. */}
      <div className="mt-2">
        {rows.map(n => (
          <VoicePlayer
            key={n.id}
            note={n}
            onDelete={async () => {
              await voiceApi.remove(n.id)
              onNotes(prev => (prev ?? []).filter(x => x.id !== n.id))
            }}
          />
        ))}
      </div>
    </>
  )
}

function VoiceNotes({
  notes, onNotes, lead,
}: {
  notes: VoiceNote[] | null
  onNotes: (fn: (prev: VoiceNote[] | null) => VoiceNote[]) => void
  /** This is the first thing in the rail — see `railTail`. */
  lead: boolean
}) {
  const rows = notes ?? []
  return (
    <section className={railTail(lead)}>
      {/* The lone `ml-auto` mic glyph is gone: it sat 250px from anything it
          related to and did nothing when pressed. `Recorder` below is the mic. */}
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-eyebrow uppercase text-fg-mute">Voice notes</h2>
        {rows.length > 0 && <span className="text-eyebrow uppercase tnum text-fg-mute">{rows.length}</span>}
      </div>

      <VoiceBody notes={notes} onNotes={onNotes} />
    </section>
  )
}
