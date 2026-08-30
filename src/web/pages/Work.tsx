/**
 * Work — his own list, beside his own notes.
 *
 * Two columns rather than one 760px reading strip with 65% of the screen dark:
 * tasks and goals on the left, voice notes on the right, both visible at once
 * because they are two halves of "what am I carrying".
 *
 * Every time on this page is stated in the words he set it in — `Thu 3 Sep,
 * 2:35pm`, or `2:35pm` when it is today, or `late — Thu 3 Sep, 2:35pm` once it
 * has passed. The storage was always right; the display only ever showed `in
 * 4d`, which is not a commitment, it is a distance.
 */

import { Reorder, motion } from 'motion/react'
import { useStill } from '../lib/motion'
import { useEffect, useMemo, useState } from 'react'
import { Bell, Circle, CircleCheck, CircleDot, Mic, Plus } from 'lucide-react'
import { actions, optimistic, reload, useStore } from '../lib/api'
import type { Goal, Task } from '../lib/types'
import { deadlineWords, shortDate, wallClock } from '../lib/time'
import { Button, Empty, Field, Segmented, Sheet, inputClass, spring } from '../components/primitives'
import { TaskSheet, NOTE_COLORS } from '../components/TaskSheet'
import { Recorder, VoicePlayer } from '../components/voice'
import { voiceApi, type VoiceNote } from '../lib/voice'
import { SOURCE_LABEL } from '../components/sources'
import { setParam, useParam } from '../lib/route'

type Tab = 'tasks' | 'goals'

export function Work() {
  const { state } = useStore()
  const tab = (useParam('tab') === 'goals' ? 'goals' : 'tasks') as Tab
  const [editing, setEditing] = useState<Task | null>(null)
  const [creating, setCreating] = useState(false)
  const [goalEditing, setGoalEditing] = useState<Goal | null | 'new'>(null)
  const [showDone, setShowDone] = useState(false)

  const tasks = state?.tasks ?? []
  const goals = state?.goals ?? []
  const reminders = state?.reminders ?? []

  /**
   * Provenance, resolved once per render rather than per row: a task carries the
   * group key it was made from, and the card is what turns that key into "from
   * Slack". Cards churn; the task does not, so a task whose card is gone simply
   * loses the line rather than breaking.
   */
  const cardByGroup = useMemo(() => {
    const all = [...(state?.now ?? []), ...(state?.open ?? []), ...(state?.parked ?? [])]
    return new Map(all.map(c => [c.group_key, c]))
  }, [state?.now, state?.open, state?.parked])

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

  /** Persist the new order as sort keys after a drag. */
  const commitOrder = async (list: Task[]) => {
    optimistic(s => {
      const order = new Map(list.map((t, i) => [t.id, i]))
      s.tasks = s.tasks.map(t => (order.has(t.id) ? { ...t, sort: order.get(t.id)! } : t))
      return s
    })
    await Promise.all(list.map((t, i) => actions.updateTask(t.id, { sort: i })))
  }

  // Same distinction as Now: no state yet is not the same fact as "0 waiting".
  if (!state) return <div className="pt-16"><Empty>Reading what's queued</Empty></div>

  const rowProps = (t: Task) => ({
    task: t, reminders, goals,
    origin: cardByGroup.get(t.source_card_group ?? ''),
    onCycle: cycle, onEdit: setEditing,
  })

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 pt-4 pb-2">
        <h1 className="text-lg font-medium">Work</h1>
        <span className="tnum text-md text-fg-mute">
          {doing.length ? `${doing.length} in flight` : todo.length}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Segmented
            options={[{ id: 'tasks', label: 'Tasks' }, { id: 'goals', label: 'Goals' }]}
            value={tab}
            onChange={id => setParam('tab', id === 'tasks' ? null : id)}
            ariaLabel="Tasks or goals"
          />
          <Button size="md" variant="primary"
            onClick={() => (tab === 'tasks' ? setCreating(true) : setGoalEditing('new'))}>
            <Plus size={15} /> {tab === 'tasks' ? 'Task' : 'Goal'}
          </Button>
        </span>
      </header>

      <div className="lg:grid lg:grid-cols-[1fr_360px] lg:gap-8 lg:items-start">
        <div className="min-w-0">
          {tab === 'tasks' ? (
            <>
              {doing.length > 0 && (
                <Group label="In flight" accent>
                  <Reorder.Group axis="y" values={doing} onReorder={commitOrder}>
                    {doing.map(t => <TaskRow key={t.id} {...rowProps(t)} />)}
                  </Reorder.Group>
                </Group>
              )}

              <Group label="Up next">
                {todo.length ? (
                  <Reorder.Group axis="y" values={todo} onReorder={commitOrder}>
                    {todo.map(t => <TaskRow key={t.id} {...rowProps(t)} />)}
                  </Reorder.Group>
                ) : (
                  <Empty>No tasks</Empty>
                )}
              </Group>

              {done.length > 0 && (
                <Group label={`Done — ${done.length}`}>
                  <Button size="sm" variant="ghost" onClick={() => setShowDone(v => !v)}>
                    {showDone ? 'Hide' : 'Show'}
                  </Button>
                  {showDone && done.slice(0, 40).map(t => <TaskRow key={t.id} {...rowProps(t)} static />)}
                </Group>
              )}
            </>
          ) : (
            <GoalList goals={goals} tasks={tasks} onEdit={setGoalEditing} />
          )}
        </div>

        <VoiceNotes />
      </div>

      <TaskSheet open={creating} onClose={() => setCreating(false)} />
      <TaskSheet open={!!editing} onClose={() => setEditing(null)} task={editing} />
      <GoalSheet goal={goalEditing} onClose={() => setGoalEditing(null)} />
    </div>
  )
}

function Group({ label, children, accent }: { label: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <section className="mb-6">
      <h2 className={`text-eyebrow uppercase mb-1 ${accent ? 'text-accent-ink' : 'text-fg-mute'}`}>{label}</h2>
      {children}
    </section>
  )
}

function TaskRow({
  task, goals, reminders, origin, onCycle, onEdit, static: isStatic,
}: {
  task: Task; goals: Goal[]; reminders: any[]
  origin?: { title: string; url: string; sources: Array<{ source: keyof typeof SOURCE_LABEL }> }
  onCycle: (t: Task) => void; onEdit: (t: Task) => void; static?: boolean
}) {
  const goal = goals.find(g => g.id === task.goal_id)
  const reminder = reminders.find(r => r.target_kind === 'task' && r.target_id === task.id && !r.fired_at && !r.dismissed_at)
  const overdue = task.due_at && task.due_at < Date.now() && task.status !== 'done'

  const Icon = task.status === 'done' ? CircleCheck : task.status === 'doing' ? CircleDot : Circle

  const body = (
    <div className="flex items-start gap-3 py-2 min-h-11">
      <button
        onClick={e => { e.stopPropagation(); onCycle(task) }}
        className="pt-0.5 shrink-0 transition-colors duration-100"
        aria-label={`Mark ${task.status === 'done' ? 'not done' : 'done'}`}
      >
        <Icon size={16} className={
          task.status === 'done' ? 'text-ok' : task.status === 'doing' ? 'text-accent-ink' : 'text-fg-mute hover:text-fg-dim'
        } />
      </button>

      <div className="min-w-0 grow cursor-pointer" onClick={() => onEdit(task)}>
        <div className={`text-base ${task.status === 'done' ? 'text-fg-mute line-through' : 'text-fg'}`}>
          {task.title}
        </div>

        {!!(goal || task.due_at || reminder || task.notes?.length) && (
          <div className="mt-0.5 flex items-center gap-x-3 gap-y-1 flex-wrap text-sm text-fg-mute">
            {goal && (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: goal.color ?? 'var(--color-fg-mute)' }} />
                {goal.title}
              </span>
            )}
            {/* The wall-clock time he picked, not a distance from now. */}
            {task.due_at && (
              <span className={overdue ? 'text-bad' : 'text-fg-dim'}>{deadlineWords(task.due_at)}</span>
            )}
            {reminder && (
              <span className="inline-flex items-center gap-1.5">
                <Bell size={11} className="text-accent-ink" />
                {wallClock(reminder.fire_at)}
              </span>
            )}
            {!!task.notes?.length && <span>{task.notes.length} note{task.notes.length > 1 ? 's' : ''}</span>}
            {origin && (
              <a
                href={origin.url.startsWith('http') ? origin.url : undefined}
                target="_blank" rel="noreferrer"
                onClick={e => e.stopPropagation()}
                className="hover:text-fg-dim transition-colors duration-100"
                title={origin.title}
              >
                from {SOURCE_LABEL[origin.sources[0]?.source ?? 'github']}
              </a>
            )}
          </div>
        )}
      </div>

      {task.color && (
        <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: task.color }} />
      )}
    </div>
  )

  if (isStatic) return <div className="border-b border-rule last:border-0">{body}</div>

  return (
    <Reorder.Item
      value={task}
      id={task.id}
      transition={spring}
      whileDrag={{ scale: 1.01, backgroundColor: 'var(--color-ink-850)', zIndex: 10 }}
      className="border-b border-rule last:border-0"
    >
      {body}
    </Reorder.Item>
  )
}

function GoalList({ goals, tasks, onEdit }: { goals: Goal[]; tasks: Task[]; onEdit: (g: Goal) => void }) {
  const reduce = useStill()
  if (!goals.length) return <Empty>No goals</Empty>
  return (
    <div>
      {goals.map(g => {
        const linked = tasks.filter(t => t.goal_id === g.id)
        const done = linked.filter(t => t.status === 'done').length
        const pct = linked.length ? done / linked.length : 0
        const color = g.color ?? 'var(--color-accent)'
        return (
          <button
            key={g.id} onClick={() => onEdit(g)}
            className="w-full text-left py-3 border-b border-rule last:border-0"
          >
            <div className="flex items-baseline gap-2.5">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
              <span className="text-base grow">{g.title}</span>
              {g.target_date && <span className="text-sm text-fg-mute">by {shortDate(g.target_date)}</span>}
              <span className="tnum text-sm text-fg-mute">{done}/{linked.length}</span>
            </div>
            <div className="mt-2 h-[3px] bg-ink-800 rounded-full overflow-hidden">
              <motion.div
                className="h-full rounded-full"
                style={{ background: color }}
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${pct * 100}%` }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
          </button>
        )
      })}
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
        <textarea className={`${inputClass} min-h-[60px] resize-y`} value={detail}
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
 * Voice notes, beside the list rather than under it.
 *
 * They live on this page because a note is a note; the only difference is that
 * this one was easier to make while walking.
 */
function VoiceNotes() {
  const [notes, setNotes] = useState<VoiceNote[]>([])
  const [stt, setStt] = useState<{ available: boolean; reason: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    voiceApi.list()
      .then(d => { setNotes(d.notes); setStt(d.stt) })
      .catch(e => setErr((e as Error).message))
  }, [])

  return (
    <section className="mt-8 lg:mt-0">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-eyebrow uppercase text-fg-mute">Voice notes</h2>
        {notes.length > 0 && <span className="tnum text-xs text-fg-mute">{notes.length}</span>}
        <Mic size={12} className="text-fg-mute ml-auto" />
      </div>

      <Recorder onSaved={n => setNotes(prev => [n, ...prev])} />

      {err && <p className="mt-2 text-sm text-bad">{err}</p>}
      {/* A safety-adjacent fact rather than help text: it is the claim the
          product keeps about where a recording goes. */}
      {stt && !stt.available && notes.some(n => !n.transcript) && (
        <p className="mt-2 text-sm text-fg-mute">{stt.reason}</p>
      )}

      <div className="mt-2">
        {notes.map(n => (
          <VoicePlayer
            key={n.id}
            note={n}
            onDelete={async () => {
              await voiceApi.remove(n.id)
              setNotes(prev => prev.filter(x => x.id !== n.id))
            }}
          />
        ))}
        {!notes.length && <Empty>No notes</Empty>}
      </div>
    </section>
  )
}
