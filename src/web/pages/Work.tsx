import { AnimatePresence, Reorder, motion } from 'motion/react'
import { useStill } from '../lib/motion'
import { useEffect, useMemo, useState } from 'react'
import { Bell, Circle, CircleCheck, CircleDot, Mic, Plus, Target } from 'lucide-react'
import { actions, optimistic, reload, useStore } from '../lib/api'
import type { Goal, Task } from '../lib/types'
import { shortDate, until } from '../lib/time'
import { Button, Chip, Empty, Field, Sheet, inputClass, spring } from '../components/primitives'
import { TaskSheet, NOTE_COLORS } from '../components/TaskSheet'
import { Recorder, VoicePlayer } from '../components/voice'
import { voiceApi, type VoiceNote } from '../lib/voice'
import { SOURCE_LABEL } from '../components/sources'

type Tab = 'tasks' | 'goals'

export function Work() {
  const { state } = useStore()
  const [tab, setTab] = useState<Tab>('tasks')
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
   * Slack — Acme's sync stopped". Cards churn; the task does not, so a task
   * whose card is gone simply loses the line rather than breaking.
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

  return (
    <div className="pb-24">
      <header className="pt-8 pb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] sm:text-[30px] font-medium tracking-[-0.025em] leading-none">
            Work
          </h1>
          <p className="mt-2 text-[13px] text-fg-mute">
            {doing.length ? `${doing.length} in flight` : `${todo.length} waiting`}
            {goals.length > 0 && ` · ${goals.length} goal${goals.length > 1 ? 's' : ''}`}
          </p>
        </div>
        <Button variant="accent" onClick={() => (tab === 'tasks' ? setCreating(true) : setGoalEditing('new'))}>
          <Plus size={15} /> {tab === 'tasks' ? 'Task' : 'Goal'}
        </Button>
      </header>

      <div className="flex gap-1 mb-6">
        <Chip active={tab === 'tasks'} onClick={() => setTab('tasks')}>Tasks</Chip>
        <Chip active={tab === 'goals'} onClick={() => setTab('goals')}>Goals</Chip>
      </div>

      {tab === 'tasks' ? (
        <>
          {/* "What I am working on" — the current view the brief asked for. */}
          {doing.length > 0 && (
            <Group label="In flight" accent>
              <Reorder.Group axis="y" values={doing} onReorder={commitOrder} className="space-y-0">
                {doing.map(t => (
                  <TaskRow key={t.id} task={t} reminders={reminders} goals={goals}
                    origin={cardByGroup.get(t.source_card_group ?? '')}
                    onCycle={cycle} onEdit={setEditing} />
                ))}
              </Reorder.Group>
            </Group>
          )}

          <Group label="Up next">
            {todo.length ? (
              <Reorder.Group axis="y" values={todo} onReorder={commitOrder} className="space-y-0">
                {todo.map(t => (
                  <TaskRow key={t.id} task={t} reminders={reminders} goals={goals}
                    origin={cardByGroup.get(t.source_card_group ?? '')}
                    onCycle={cycle} onEdit={setEditing} />
                ))}
              </Reorder.Group>
            ) : (
              <EmptyDesk />
            )}
          </Group>

          {done.length > 0 && (
            <div className="mt-8">
              <button onClick={() => setShowDone(v => !v)}
                className="text-[13px] text-fg-mute hover:text-fg-dim transition-colors min-h-9">
                {showDone ? 'Hide' : 'Show'} {done.length} done
              </button>
              <AnimatePresence>
                {showDone && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <div className="pt-2">
                      {done.slice(0, 40).map(t => (
                        <TaskRow key={t.id} task={t} reminders={reminders} goals={goals}
                          origin={cardByGroup.get(t.source_card_group ?? '')}
                          onCycle={cycle} onEdit={setEditing} static />
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </>
      ) : (
        <GoalList goals={goals} tasks={tasks} onEdit={setGoalEditing} />
      )}

      {tab === 'tasks' && <VoiceNotes />}

      <TaskSheet open={creating} onClose={() => setCreating(false)} />
      <TaskSheet open={!!editing} onClose={() => setEditing(null)} task={editing} />
      <GoalSheet goal={goalEditing} onClose={() => setGoalEditing(null)} />
    </div>
  )
}

function Group({ label, children, accent }: { label: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <section className="mb-8">
      <h2 className={`text-[11.5px] uppercase tracking-[0.08em] mb-2.5
        ${accent ? 'text-accent' : 'text-fg-mute'}`}>{label}</h2>
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
    <div className="flex items-start gap-3 py-3 group">
      <button
        onClick={e => { e.stopPropagation(); onCycle(task) }}
        className="pt-[3px] shrink-0 transition-colors"
        aria-label={`Mark ${task.status === 'done' ? 'not done' : 'done'}`}
      >
        <Icon size={16} className={
          task.status === 'done' ? 'text-ok' : task.status === 'doing' ? 'text-accent' : 'text-fg-mute hover:text-fg-dim'
        } />
      </button>

      <div className="min-w-0 grow cursor-pointer" onClick={() => onEdit(task)}>
        <div className={`text-[14.5px] leading-snug tracking-[-0.01em]
          ${task.status === 'done' ? 'text-fg-mute line-through' : 'text-fg'}`}>
          {task.title}
        </div>

        {/* Boolean-coerced: `task.notes?.length` is 0 for a task with no notes,
            and a bare 0 is renderable, so `&&` would print "0" under the title. */}
        {!!(goal || task.due_at || reminder || task.notes?.length) && (
          <div className="mt-1.5 flex items-center gap-x-2 gap-y-1 flex-wrap text-[12px] text-fg-mute leading-none">
            {goal && (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: goal.color ?? '#8f8f99' }} />
                {goal.title}
              </span>
            )}
            {task.due_at && (
              <span className={overdue ? 'text-bad' : ''}>{until(task.due_at)}</span>
            )}
            {reminder && <Bell size={11} className="text-accent/70" />}
            {!!task.notes?.length && <span>{task.notes.length} note{task.notes.length > 1 ? 's' : ''}</span>}
            {origin && (
              <a
                href={origin.url.startsWith('http') ? origin.url : undefined}
                target="_blank"
                rel="noreferrer"
                onClick={e => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-fg-mute hover:text-fg-dim transition-colors"
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

  if (isStatic) return <div className="hairline last:border-0">{body}</div>

  return (
    <Reorder.Item
      value={task}
      id={task.id}
      transition={spring}
      whileDrag={{ scale: 1.01, backgroundColor: 'var(--color-ink-850)', borderRadius: 12, zIndex: 10 }}
      className="hairline last:border-0"
    >
      {body}
    </Reorder.Item>
  )
}

function GoalList({ goals, tasks, onEdit }: { goals: Goal[]; tasks: Task[]; onEdit: (g: Goal) => void }) {
  const reduce = useStill()
  if (!goals.length) {
    return <Empty>No goals yet. A goal is a thing you are moving toward; tasks hang off it.</Empty>
  }
  return (
    <div className="space-y-1">
      {goals.map(g => {
        const linked = tasks.filter(t => t.goal_id === g.id)
        const done = linked.filter(t => t.status === 'done').length
        const pct = linked.length ? done / linked.length : 0
        const color = g.color ?? 'var(--color-accent)'
        return (
          <motion.button
            key={g.id} layout onClick={() => onEdit(g)}
            className="w-full text-left py-4 hairline last:border-0 group"
          >
            <div className="flex items-baseline gap-2.5">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
              <span className="text-[15px] tracking-[-0.01em] grow">{g.title}</span>
              <span className="tnum text-[13px] text-fg-mute">{done}/{linked.length}</span>
            </div>

            {/* A hairline progress bar rather than a ring or a badge — it reads
                as part of the type, not as a widget. */}
            <div className="mt-3 h-[3px] bg-ink-800 rounded-full overflow-hidden">
              <motion.div
                className="h-full rounded-full"
                style={{ background: color }}
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${pct * 100}%` }}
                transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>

            {(g.target_date || g.detail) && (
              <div className="mt-2 flex items-center gap-2 text-[12px] text-fg-mute">
                {g.target_date && <span>by {shortDate(g.target_date)}</span>}
                {g.detail && <span className="truncate">{g.detail}</span>}
              </div>
            )}
          </motion.button>
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
    setTarget(g?.target_date ? new Date(g.target_date).toISOString().slice(0, 10) : '')
  }, [g?.id, isNew])

  if (!goal) return null

  const save = async () => {
    if (!title.trim()) return
    const body = {
      title: title.trim(), detail: detail.trim() || null, color,
      target_date: target ? new Date(`${target}T12:00`).getTime() : null,
    }
    g ? await actions.updateGoal(g.id, body) : await actions.createGoal(body)
    await reload()
    onClose()
  }

  return (
    <Sheet open onClose={onClose} title={g ? 'Edit goal' : 'New goal'}
      footer={
        <div className="flex gap-2">
          {g && (
            <Button variant="ghost" onClick={async () => { await actions.deleteGoal(g.id); await reload(); onClose() }}>
              Delete
            </Button>
          )}
          <Button variant="accent" className="grow" onClick={save} disabled={!title.trim()}>
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
            className={`w-6 h-6 rounded-full border ${!color ? 'border-fg-dim' : 'border-ink-600'}`} />
          {NOTE_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)} style={{ background: c }}
              className={`w-6 h-6 rounded-full ${color === c ? 'ring-2 ring-offset-2 ring-offset-ink-850 ring-fg-dim' : ''}`} />
          ))}
        </div>
      </Field>
      <p className="text-[12.5px] text-fg-mute flex items-center gap-1.5 mt-1">
        <Target size={12} /> Link tasks to this goal from any task's editor.
      </p>
    </Sheet>
  )
}

/**
 * The empty desk.
 *
 * "Nothing queued" is true and useless. What someone wants at an empty desk is
 * the two ways work gets in — and one of them (make a task from a card) is the
 * habit that makes the rest of Wake worth having.
 */
function EmptyDesk() {
  return (
    <div className="py-10">
      <p className="text-[14px] text-fg-dim leading-relaxed">A clear desk.</p>
      <p className="mt-1.5 text-[13px] text-fg-mute leading-relaxed max-w-[46ch]">
        Work arrives two ways: press <span className="text-fg-dim">+ Task</span> above, or open something on
        Now and turn it into one — a task made from a card keeps a link back to it and survives the card
        disappearing.
      </p>
    </div>
  )
}

/**
 * Voice notes, alongside written ones.
 *
 * They live here rather than on their own page because a note is a note: the
 * only difference is that this one was easier to make while walking.
 */
function VoiceNotes() {
  const [notes, setNotes] = useState<VoiceNote[]>([])
  const [stt, setStt] = useState<{ available: boolean; reason: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = () =>
    voiceApi
      .list()
      .then(d => { setNotes(d.notes); setStt(d.stt) })
      .catch(e => setErr((e as Error).message))

  useEffect(() => { void load() }, [])

  return (
    <section className="mt-10">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-fg-mute">Voice notes</h2>
        {notes.length > 0 && <span className="tnum text-[12px] text-fg-mute">{notes.length}</span>}
        <Mic size={12} className="text-fg-mute ml-auto" />
      </div>

      <Recorder onSaved={n => setNotes(prev => [n, ...prev])} />

      {err && <p className="mt-2 text-[12.5px] text-bad">{err}</p>}
      {stt && !stt.available && notes.some(n => !n.transcript) && (
        <p className="mt-2 text-[11.5px] text-fg-mute leading-relaxed max-w-[54ch]">
          Some notes have no transcript. {stt.reason}
        </p>
      )}

      <div className="mt-3">
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
        {!notes.length && (
          <p className="text-[12.5px] text-fg-mute py-3 leading-relaxed">
            Nothing recorded. A voice note stays on this machine; nothing is uploaded unless you attach it
            to something you send.
          </p>
        )}
      </div>
    </section>
  )
}
