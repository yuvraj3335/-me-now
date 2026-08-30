/**
 * Work — his own list, beside his own notes.
 *
 * On the same grid as the desk and Mail: a padded list column and a pane of the same
 * width token with the same left hairline, so the second column's left edge sits
 * on the one vertical the product uses. It used to be a `[1fr_360px]` grid
 * inside the shell's own pad, which put its right column at x=1056 — a vertical
 * nothing else shared — and left roughly 760px of nothing under both halves.
 *
 * One control language, too. `Tasks | Goals` is text, `Record a note` is ghost,
 * and `+ Task` is the single amber commit: three control styles on one surface
 * is three claims about which one matters.
 *
 * **A page with nothing on it is one column.** Two structural columns, each
 * holding an em dash, is a layout announcing an absence. Nothing on the list,
 * nothing in the notes and nothing that went off collapses to a title, a dash
 * and the mic.
 *
 * Every time on this page is stated in the words he set it in — `Thu 3 Sep,
 * 2:35pm`, or `2:35pm` when it is today, or `late — Thu 3 Sep, 2:35pm` once it
 * has passed. The storage was always right; the display only ever showed `in
 * 4d`, which is not a commitment, it is a distance.
 */

import { Reorder, motion } from 'motion/react'
import { useStill } from '../lib/motion'
import { useEffect, useMemo, useState } from 'react'
import { Bell, BellRing, Circle, CircleCheck, CircleDot, Plus, SquareTerminal, X } from 'lucide-react'
import { actions, optimistic, reload, useStore } from '../lib/api'
import type { Goal, Task } from '../lib/types'
import { STATUS_LABEL } from '../lib/types'
import { deadlineWords, shortDate, wallClock } from '../lib/time'
import { SwipeDrawer, useSwipe } from '../components/swipe'
import { toast } from '../lib/toast'
import {
  Button, Empty, Field, PageTitle, Pager, Sheet, inputClass, pageCount, pageSlice, spring,
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
 */
const TASK_CHOICES = [
  { id: 'todo',  label: STATUS_LABEL.not_started },
  { id: 'doing', label: STATUS_LABEL.in_progress },
  { id: 'done',  label: STATUS_LABEL.done },
]

/** A goal is finished or it is not; there is no middle for it to be in. */
const GOAL_CHOICES = [
  { id: 'todo', label: STATUS_LABEL.not_started },
  { id: 'done', label: STATUS_LABEL.done },
]

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

export function Work() {
  const { state } = useStore()
  const tab = (useParam('tab') === 'goals' ? 'goals' : 'tasks') as Tab
  const [editing, setEditing] = useState<Task | null>(null)
  const [creating, setCreating] = useState(false)
  const [goalEditing, setGoalEditing] = useState<Goal | null | 'new'>(null)
  const [showDone, setShowDone] = useState(false)
  const donePage = Math.max(1, Number(useParam('page')) || 1)

  /** Any of the three sheets this page owns. While one is up it holds the
   *  surface, and with it the single primary. */
  const sheetOpen = creating || editing !== null || goalEditing !== null

  const tasks = state?.tasks ?? []
  const goals = state?.goals ?? []
  const reminders = state?.reminders ?? []
  const fired = (state?.notifications ?? []).filter(n => !n.read_at).slice(0, 6)

  /**
   * The notes live here rather than inside their own section, because whether
   * this page has a second column at all depends on whether there are any. A
   * component that fetches what the layout above it needs to know cannot answer
   * that question in time. `null` is "not read yet" and reads as empty, which is
   * right: the common case is zero and it never flashes.
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

  // Nothing at all until the first read lands. A sentence saying a page is
  // loading is chrome that teaches, and it paints for one frame.
  if (!state) return <div className="pad-x pt-4 flex items-center gap-3"><PageTitle>Work</PageTitle></div>

  const rowProps = (t: Task) => ({
    task: t, reminders, goals,
    // The live card when there still is one, so the link is current; the frozen
    // copy when the poller has swept it, so the line does not vanish with the
    // pull request it was about.
    origin: cardByGroup.get(t.source_card_group ?? ''),
    onCycle: cycle, onEdit: setEditing,
    onStatus: setTaskStatus, onDelete: removeTask,
  })

  const header = (
    <header className="flex items-center gap-3 pt-4 pb-2">
      <PageTitle>Work</PageTitle>
      <span className="tnum text-sm text-fg-mute">{todo.length + doing.length}</span>
      <span className="ml-auto flex items-center gap-4">
        {/* Two words, not a bordered segmented box. It is a choice between two
            lists, and the page already carries one bordered control too many. */}
        <span className="flex items-center gap-3">
          {(['tasks', 'goals'] as const).map(id => (
            <button
              key={id}
              onClick={() => setParam('tab', id === 'tasks' ? null : id)}
              aria-pressed={tab === id}
              /* `relative`, or `.hit` hangs its touch box off `<main>` instead
                 of off the word — a page-sized invisible target that answers
                 every tap on the route with `Goals`. */
              className={`hit relative h-8 text-sm font-medium transition-colors duration-100
                ${tab === id ? 'text-fg' : 'text-fg-mute hover:text-fg-dim'}`}
            >
              {id === 'tasks' ? 'Tasks' : 'Goals'}
            </button>
          ))}
        </span>
        {/* The one primary in the product, and the only place amber marks a
            commit rather than a decision.

            It hands the amber over while its sheet is open. One primary per
            surface is the rule, and a sheet is the surface once it is up: the
            fill belongs to `Add task`, the button that actually commits. This
            one had already been pressed and is sitting behind a scrim with
            nothing left to ask for, so it spends the accent twice on one screen
            for a control that cannot be reached. */}
        <Button size="md" variant={sheetOpen ? 'default' : 'primary'}
          onClick={() => (tab === 'tasks' ? setCreating(true) : setGoalEditing('new'))}>
          <Plus size={14} /> {tab === 'tasks' ? 'Task' : 'Goal'}
        </Button>
      </span>
    </header>
  )

  const sheets = (
    <>
      <TaskSheet open={creating} onClose={() => setCreating(false)} />
      <TaskSheet open={!!editing} onClose={() => setEditing(null)} task={editing} />
      <GoalSheet goal={goalEditing} onClose={() => setGoalEditing(null)} />
    </>
  )

  /**
   * Nothing on the list, nothing that went off, nothing recorded.
   *
   * One column, one line, and the mic — because a second structural column
   * holding a second em dash is a layout describing an absence, and 760px of it
   * is the loudest way this product has ever said nothing. The line says which
   * list is empty; a bare dash in that slot is what a failed render looks like.
   */
  if (!tasks.length && !goals.length && !fired.length && !notes?.length) {
    return (
      <div className="pad-x pb-24 xl:pb-8">
        {header}
        <Empty>{tab === 'tasks' ? 'No tasks' : 'No goals'}</Empty>
        <VoiceNotes notes={notes} onNotes={setNotes} />
        {sheets}
      </div>
    )
  }

  return (
    /* The shell's own grid: a padded list column, then a pane on the same width
       token with the same left hairline the desk's detail and Mail's list use. Below
       the pane width the two simply stack, which is what they did anyway. */
    <div className="xl:flex xl:items-stretch xl:min-h-dvh">
      <div className="min-w-0 grow pad-x pb-8">
        {header}
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
            {/* An empty list is one word, not a paragraph and not a tutorial — and a
                word rather than the default dash, because a dash alone in a
                44px slot with 90px of nothing under it reads as a render that
                failed rather than as a list with nothing on it. */}
            {!todo.length && !doing.length && !done.length && <Empty>No tasks</Empty>}

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
          <GoalList goals={goals} tasks={tasks} onEdit={setGoalEditing}
            onStatus={setGoalDone} onDelete={removeGoal} />
        )}
      </div>

      <aside className="pad-x xl:pt-4 pb-24 xl:pb-8 xl:w-90 2xl:w-100 xl:shrink-0 xl:border-l xl:border-edge">
        <Fired rows={fired} />
        <VoiceNotes notes={notes} onNotes={setNotes} />
      </aside>

      {sheets}
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

function TaskRow({
  task, goals, reminders, origin, onCycle, onEdit, onStatus, onDelete, static: isStatic,
}: {
  task: Task; goals: Goal[]; reminders: any[]
  origin?: { title: string; url: string; sources: Array<{ source: keyof typeof SOURCE_LABEL }> }
  onCycle: (t: Task) => void; onEdit: (t: Task) => void
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

      <div className="min-w-0 grow cursor-pointer" onClick={() => onEdit(task)}>
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
        className="relative border-b border-rule last:border-0"
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
      className="relative border-b border-rule last:border-0"
    >
      {body}
      {drawer}
    </Reorder.Item>
  )
}

function GoalList({
  goals, tasks, onEdit, onStatus, onDelete,
}: {
  goals: Goal[]; tasks: Task[]
  onEdit: (g: Goal) => void
  onStatus: (g: Goal, done: boolean) => void
  onDelete: (g: Goal) => void
}) {
  if (!goals.length) return <Empty>No goals</Empty>
  return (
    <div>
      {goals.map(g => (
        <GoalRow
          key={g.id} goal={g}
          linked={tasks.filter(t => t.goal_id === g.id)}
          onEdit={onEdit} onStatus={onStatus} onDelete={onDelete}
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
  goal: g, linked, onEdit, onStatus, onDelete,
}: {
  goal: Goal; linked: Task[]
  onEdit: (g: Goal) => void
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
      className="relative border-b border-rule last:border-0"
    >
      <button onClick={() => onEdit(g)} className="w-full text-left py-3">
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
  const [target, setTarget] = useState('')

  useMemo(() => {
    setTitle(g?.title ?? '')
    setDetail(g?.detail ?? '')
    setColor(g?.color ?? null)
    // Read back as LOCAL parts, not `toISOString().slice(0,10)`, which is UTC:
    // the write below anchors at local noon, so the round-trip only survived
    // because noon is far enough from either boundary to absorb the offset.
    setTarget(g?.target_date ? localDay(g.target_date) : '')
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
    title: title.trim(), detail: detail.trim() || null, color,
    target_date: target ? new Date(`${target}T12:00`).getTime() : null,
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
      <Field label="Target date">
        <input type="date" className={inputClass} value={target} onChange={e => setTarget(e.target.value)} />
      </Field>
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

/** A date as local calendar parts. `toISOString()` would answer in UTC. */
const localDay = (ts: number) => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
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
