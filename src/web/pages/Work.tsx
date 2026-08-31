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
 */

import { Reorder, motion } from 'motion/react'
import { useStill } from '../lib/motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, BellRing, Circle, CircleCheck, CircleDot, Plus, SquareTerminal, Trash2, X } from 'lucide-react'
import { actions, optimistic, reload, useStore } from '../lib/api'
import type { Goal, Task } from '../lib/types'
import { STATUS_LABEL } from '../lib/types'
import { deadlineWords, shortDate, wallClock } from '../lib/time'
import { SwipeDrawer, useSwipe } from '../components/swipe'
import { PANE_MIN, useViewport } from '../components/CardTable'
import { toast } from '../lib/toast'
import {
  Button, DateField, DateTimePicker, Field, PageTitle, Pager, Segmented, Select, Sheet,
  inputClass, pageCount, pageSlice, rowStateClass, spring,
} from '../components/primitives'
import { TaskSheet, NOTE_COLORS } from '../components/TaskSheet'
import { Recorder, VoicePlayer } from '../components/voice'
import { voiceApi, type VoiceNote } from '../lib/voice'
import { SOURCE_LABEL } from '../components/sources'
import { openLaunch, taskContext, taskRepoHint } from '../lib/launch'
import { setParam, useParam } from '../lib/route'

type Tab = 'tasks' | 'goals'

/**
 * The three a task can be in, under the desk's own words.
 *
 * Tasks were not migrated to the card's five, and this is the seam. A task is
 * his own work with a lifecycle this page already draws; a card is somebody
 * else's system, and its status is a note he keeps about it. `In review` and
 * `Won't do` have no home here — the first because a task of his own does not
 * wait on a reviewer inside Wake, and the second because a task decided against
 * is one that leaves, which is what `Delete` is for. The three that do map take
 * the labels the desk prints, so the product has one vocabulary rather than two
 * that happen to agree today.
 *
 * `as const` so the ids are the union `Task['status']` rather than `string`: the
 * pane's `Select` is generic over its own value, and a picker typed `string`
 * could offer a status the route refuses.
 */
const TASK_CHOICES = [
  { id: 'todo',  label: STATUS_LABEL.not_started },
  { id: 'doing', label: STATUS_LABEL.in_progress },
  { id: 'done',  label: STATUS_LABEL.done },
] as const

/** A goal is finished or it is not; there is no middle for it to be in. */
const GOAL_CHOICES = [
  { id: 'todo', label: STATUS_LABEL.not_started },
  { id: 'done', label: STATUS_LABEL.done },
] as const

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
  const [creating, setCreating] = useState(false)
  const [goalEditingId, setGoalEditingId] = useState<string | 'new' | null>(null)
  const [showDone, setShowDone] = useState(false)
  const donePage = Math.max(1, Number(useParam('page')) || 1)

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
  const goalEditing: Goal | 'new' | null =
    goalEditingId === 'new' ? 'new'
    : goalEditingId === null ? null
    : goals.find(g => g.id === goalEditingId) ?? null

  /** Any of the three sheets this page owns. While one is up it holds the
   *  surface, and with it the single primary. */
  const sheetOpen = creating || editing !== null || goalEditing !== null

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

  const doing = useMemo(() => tasks.filter(t => t.status === 'doing'), [tasks])
  const todo = useMemo(() => tasks.filter(t => t.status === 'todo'), [tasks])
  const done = useMemo(
    () => tasks.filter(t => t.status === 'done').sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0)),
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

  const closePane = () => setParam('open', null)
  const openRow = (t: Task) => (hasPane ? setParam('open', paneKey('task', t.id)) : setEditingId(t.id))
  const openGoalRow = (g: Goal) => (hasPane ? setParam('open', paneKey('goal', g.id)) : setGoalEditingId(g.id))

  /* ------------------------------- the writes ------------------------------ */

  const cycle = async (t: Task) => {
    const next = t.status === 'todo' ? 'doing' : t.status === 'doing' ? 'done' : 'todo'
    optimistic(s => {
      const x = s.tasks.find(i => i.id === t.id)
      if (x) x.status = next as Task['status']
      return s
    })
    await actions.updateTask(t.id, { status: next })
    void reload()
  }

  /**
   * The swipe's Status, on a task.
   *
   * Undone by putting back the status it replaced rather than by a general
   * "restore", because a task has no undo record on the server and does not need
   * one: there is exactly one field in play and its previous value is in hand at
   * the moment it changes.
   */
  const setTaskStatus = async (t: Task, status: Task['status']) => {
    if (status === t.status) return
    const was = t.status
    optimistic(s => {
      const x = s.tasks.find(i => i.id === t.id)
      if (x) x.status = status
      return s
    })
    await actions.updateTask(t.id, { status })
    toast(`${TASK_CHOICES.find(c => c.id === status)?.label ?? 'Changed'}.`, {
      label: 'Undo',
      run: async () => { await actions.updateTask(t.id, { status: was }); await reload() },
    })
    void reload()
  }

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

  /** Persist the new order as sort keys after a drag. */
  const commitOrder = async (list: Task[]) => {
    optimistic(s => {
      const order = new Map(list.map((t, i) => [t.id, i]))
      s.tasks = s.tasks.map(t => (order.has(t.id) ? { ...t, sort: order.get(t.id)! } : t))
      return s
    })
    await Promise.all(list.map((t, i) => actions.updateTask(t.id, { sort: i })))
  }

  const rowProps = (t: Task) => ({
    task: t, reminders, goals,
    // The live card when there still is one, so the link is current; the frozen
    // copy when the poller has swept it, so the line does not vanish with the
    // pull request it was about.
    origin: cardByGroup.get(t.source_card_group ?? ''),
    selected: openKey === paneKey('task', t.id),
    onCycle: cycle, onOpen: openRow,
    onStatus: setTaskStatus, onDelete: removeTask,
  })

  const open = todo.length + doing.length

  return (
    /* The shell's own grid: a padded list column, then a pane on the same width
       token with the same left hairline the desk's detail and Mail's list use.
       Below the pane width the two simply stack, which is what they did anyway. */
    <div className="xl:flex xl:items-stretch xl:min-h-dvh">
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
          {loaded && open > 0 && <span className="tnum text-sm text-fg-mute">{open}</span>}
          <span className="ml-auto flex items-center gap-4">
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
              options={[{ id: 'tasks', label: 'Tasks' }, { id: 'goals', label: 'Goals' }]}
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
            {doing.length > 0 && (
              <Group label="In progress">
                <Reorder.Group axis="y" values={doing} onReorder={commitOrder}>
                  {doing.map(t => <TaskRow key={t.id} {...rowProps(t)} />)}
                </Reorder.Group>
              </Group>
            )}

            {todo.length > 0 && (
              <Group label="Not started">
                <Reorder.Group axis="y" values={todo} onReorder={commitOrder}>
                  {todo.map(t => <TaskRow key={t.id} {...rowProps(t)} />)}
                </Reorder.Group>
              </Group>
            )}

            {loaded && !todo.length && !doing.length && !done.length && (
              <Blank what="tasks" onAdd={() => setCreating(true)} />
            )}

            {/*
              Done is the only list here that pages.

              It is also the only one that grows without limit — it used to be
              cut at a hard `slice(0, 40)`, which is not a page, it is a silent
              floor under everything finished more than a few weeks ago. The two
              live lists above are drag-ordered and `commitOrder` writes their
              sort keys from the array index it is handed, so slicing them into
              pages would rewrite page two's order as if it were page one's.
              They are bounded by what he is actually working on anyway.
            */}
            {done.length > 0 && (
              <Group label={`Done — ${done.length}`}>
                <Button size="sm" variant="ghost" onClick={() => setShowDone(v => !v)}>
                  {showDone ? 'Hide' : 'Show'}
                </Button>
                {showDone && (
                  <>
                    {pageSlice(done, donePage).map(t => <TaskRow key={t.id} {...rowProps(t)} static />)}
                    <Pager page={donePage} pages={pageCount(done.length)} total={done.length}
                      onPage={n => setParam('page', n === 1 ? null : String(n))} />
                  </>
                )}
              </Group>
            )}
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
        is what the desk's own pane does. Below `xl` it is not a column at all,
        it is the section under the list, and a sticky full-height section there
        would pin the recorder over the page.
      */}
      <aside className="pad-x xl:pt-4 pb-24 xl:pb-8 xl:w-90 2xl:w-100 xl:shrink-0
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
        <Fired rows={fired} />
        <VoiceNotes notes={notes} onNotes={setNotes} />
      </aside>

      <TaskSheet open={creating} onClose={() => setCreating(false)} />
      <TaskSheet open={!!editing} onClose={() => setEditingId(null)}
        task={editing ?? lastEdited.current} />
      <GoalSheet goal={goalEditing} onClose={() => setGoalEditingId(null)} />
    </div>
  )
}

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
  onStatus: (t: Task, s: Task['status']) => void
  onDelete: (t: Task) => void
}) {
  const [noteBody, setNoteBody] = useState('')
  useEffect(() => setNoteBody(''), [task.id])

  const goal = goals.find(g => g.id === task.goal_id)
  const reminder = reminders.find(
    r => r.target_kind === 'task' && r.target_id === task.id && !r.fired_at && !r.dismissed_at)
  const overdue = task.due_at && task.due_at < Date.now() && task.status !== 'done'

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
      <PaneHead title={task.title} done={task.status === 'done'} gone={gone} onClose={onClose} />

      {gone ? (
        // No controls at all on a frame that is being held: every one of them
        // would write to an id the server has already dropped.
        <p className="mt-2 text-sm text-fg-mute">
          Deleted. The undo is in the toast; a restored task comes back on the list.
        </p>
      ) : (
        <>
          <div className="mt-3">
            <PaneRow label="Status">
              <Select<Task['status']>
                value={task.status}
                options={TASK_CHOICES}
                onChange={s => onStatus(task, s)}
                ariaLabel="Status"
              />
            </PaneRow>
            <PaneRow label="Deadline">
              {/* One word, and it is the one `deadlineWords` already prints on
                  the row — the pane must not grow a second vocabulary for the
                  same fact. The control beside it stays the control. */}
              {overdue && <span className="text-sm text-bad mr-2">late</span>}
              <DateField
                value={task.due_at}
                onChange={async at => { await actions.updateTask(task.id, { due_at: at }); await reload() }}
                ariaLabel="Deadline"
              />
            </PaneRow>
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
            <Button variant="default" title="Open in Claude"
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
              <Select<'todo' | 'done'>
                value={finished ? 'done' : 'todo'}
                options={GOAL_CHOICES}
                onChange={s => onStatus(g, s === 'done')}
                ariaLabel="Status"
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
                  {t.status === 'done'
                    ? <CircleCheck size={14} className="text-ok shrink-0" />
                    : t.status === 'doing'
                      ? <CircleDot size={14} className="text-fg shrink-0" />
                      : <Circle size={14} className="text-fg-mute shrink-0" />}
                  <span className={`text-base truncate ${t.status === 'done' ? 'text-fg-mute line-through' : ''}`}>
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

function TaskRow({
  task, goals, reminders, origin, selected, onCycle, onOpen, onStatus, onDelete, static: isStatic,
}: {
  task: Task; goals: Goal[]; reminders: any[]
  origin?: { title: string; url: string; sources: Array<{ source: keyof typeof SOURCE_LABEL }> }
  /** This is the row the pane is showing. */
  selected: boolean
  onCycle: (t: Task) => void; onOpen: (t: Task) => void
  onStatus: (t: Task, s: Task['status']) => void
  onDelete: (t: Task) => void
  static?: boolean
}) {
  /*
   * `'none'` on a draggable row, `'pan-y'` on a static one, and the difference
   * is who owns the vertical axis.
   *
   * `Reorder.Item` writes `touch-action: pan-x` inline, which is how a vertical
   * drag reaches its reorder handler instead of scrolling the page. `pan-x` also
   * hands the browser the horizontal axis — the one this gesture is made of — so
   * a thumb swipe on a draggable task row could be taken over as a pan and
   * cancelled halfway through. `none` gives the row's whole gesture to the app,
   * which is what framer's own drag wants anyway, and costs nothing there:
   * vertical scrolling on those rows already belonged to framer.
   *
   * A static row is not a `Reorder.Item`. Nothing writes `pan-x` on it and
   * nothing catches a vertical drag, so `none` would take the page's scroll away
   * and hand it to no one — a thumb dragging up the Done list would move
   * nothing, which is the "frozen app" failure `lib/swipe.ts` puts above this
   * whole gesture. `pan-y` is the same split every other row in the product uses:
   * vertical is the page's, horizontal is the drawer's.
   */
  const swipe = useSwipe(`task:${task.id}`, 3, isStatic ? 'pan-y' : 'none')
  const drawer = (
    <SwipeDrawer
      dx={swipe.dx}
      width={swipe.width}
      onClose={swipe.close}
      onDone={() => onStatus(task, 'done')}
      onDelete={() => onDelete(task)}
      status={{
        current: task.status,
        options: TASK_CHOICES,
        onPick: id => onStatus(task, id as Task['status']),
      }}
    />
  )
  const goal = goals.find(g => g.id === task.goal_id)
  const reminder = reminders.find(r => r.target_kind === 'task' && r.target_id === task.id && !r.fired_at && !r.dismissed_at)
  const overdue = task.due_at && task.due_at < Date.now() && task.status !== 'done'

  const source = (origin?.sources[0]?.source ?? task.origin_source) as keyof typeof SOURCE_LABEL | undefined
  const provenance = source
    ? {
        label: SOURCE_LABEL[source] ?? source,
        url: origin?.url ?? task.origin_url ?? undefined,
        title: origin?.title ?? task.origin_title ?? undefined,
      }
    : null

  const Icon = task.status === 'done' ? CircleCheck : task.status === 'doing' ? CircleDot : Circle

  const body = (
    <div className="flex items-start gap-3 py-2 min-h-11">
      <button
        onClick={e => { e.stopPropagation(); onCycle(task) }}
        className="pt-0.5 shrink-0 transition-colors duration-100"
        aria-label={`Mark ${task.status === 'done' ? 'not done' : 'done'}`}
      >
        <Icon size={14} className={
          task.status === 'done' ? 'text-ok' : task.status === 'doing' ? 'text-fg' : 'text-fg-mute hover:text-fg-dim'
        } />
      </button>

      <div className="min-w-0 grow cursor-pointer" onClick={() => onOpen(task)}>
        <div className={`text-base ${task.status === 'done' ? 'text-fg-mute line-through' : 'text-fg'}`}>
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

      {/* The third arrow of the chain, which did not exist: `openLaunch` had three
          call sites and none of them was a task. The brief carries the task's
          title as the instruction seed, its stickies as `note` slots, and its
          frozen provenance as the reason it exists. */}
      <span className="shrink-0" onClick={e => e.stopPropagation()}>
        <Button size="sm" variant="ghost" title="Open in Claude" ariaLabel="Open in Claude"
          onClick={() => openLaunch(taskContext(task, goal), {
            template: 'blank',
            title: task.title,
            repoHint: taskRepoHint(task.origin_meta),
          })}>
          <SquareTerminal size={14} />
        </Button>
      </span>

      {task.color && (
        <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: task.color }} />
      )}
    </div>
  )

  // One row treatment, shared with every other list in the product: lightness is
  // attention, so the row the pane is showing is plainly not the row under the
  // cursor. Hover is emitted only when nothing else is set.
  const rowClass = `relative border-b border-rule last:border-0 ${rowStateClass({ selected })}`

  if (isStatic) {
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
        className={rowClass}
      >
        {body}
        {drawer}
      </div>
    )
  }

  return (
    <Reorder.Item
      value={task}
      id={task.id}
      transition={spring}
      whileDrag={{ scale: 1.01, backgroundColor: 'var(--color-ink-850)', zIndex: 10 }}
      ref={swipe.bind.ref}
      onPointerDown={swipe.bind.onPointerDown}
      onPointerMove={swipe.bind.onPointerMove}
      onPointerUp={swipe.bind.onPointerUp}
      onPointerCancel={swipe.bind.onPointerCancel}
      onClickCapture={swipe.bind.onClickCapture}
      data-swipe={swipe.bind['data-swipe']}
      // Reorder.Item spreads whatever style it is given before adding its own
      // `x`/`y`/`zIndex`, so the gesture's `user-select: none` survives here —
      // and without it a mouse drag across a draggable task highlighted the
      // title and detail blue under the open drawer, and left them highlighted
      // after the button came up. The `removeAllRanges()` at engage only clears
      // what the first twelve pixels selected.
      style={swipe.bind.style}
      className={rowClass}
    >
      {body}
      {drawer}
    </Reorder.Item>
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
        dx={swipe.dx}
        width={swipe.width}
        onClose={swipe.close}
        onDone={() => onStatus(g, true)}
        onDelete={() => onDelete(g)}
        status={{
          current: finished ? 'done' : 'todo',
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
      <Field label="Goal">
        <input className={inputClass} value={title} autoFocus
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
      <Field label="Colour">
        <div className="flex gap-2 items-center">
          <button onClick={() => setColor(null)}
            className={`w-6 h-6 rounded-full border ${!color ? 'border-fg-dim' : 'border-edge'}`} />
          {NOTE_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)} style={{ background: c }}
              className={`w-6 h-6 rounded-full ${color === c ? 'ring-2 ring-offset-2 ring-offset-ink-850 ring-fg-dim' : ''}`} />
          ))}
        </div>
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
function Fired({ rows }: { rows: Array<{ id: string; title: string; body?: string | null; created_at: number }> }) {
  if (!rows.length) return null
  return (
    <section className="mb-8">
      <h2 className="text-eyebrow uppercase text-fg-mute mb-1">Went off</h2>
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
    </section>
  )
}

/**
 * Voice notes, beside the list rather than under it.
 *
 * They live on this page because a note is a note; the only difference is that
 * this one was easier to make while walking.
 */
function VoiceNotes({
  notes, onNotes,
}: { notes: VoiceNote[] | null; onNotes: (fn: (prev: VoiceNote[] | null) => VoiceNote[]) => void }) {
  const rows = notes ?? []
  return (
    <section className="mt-8 xl:mt-0">
      {/* The lone `ml-auto` mic glyph is gone: it sat 250px from anything it
          related to and did nothing when pressed. `Recorder` below is the mic. */}
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-eyebrow uppercase text-fg-mute">Voice notes</h2>
        {rows.length > 0 && <span className="text-eyebrow uppercase tnum text-fg-mute">{rows.length}</span>}
      </div>

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
    </section>
  )
}
