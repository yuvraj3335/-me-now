import { useEffect, useState } from 'react'
import { Bell, BellOff, Plus, Trash2 } from 'lucide-react'
import type { Card as CardT, Goal, Task } from '../lib/types'
import { actions, reload, useStore } from '../lib/api'
import { until } from '../lib/time'
import { Button, Chip, Field, Sheet, inputClass } from './primitives'

/** Sticky-note palette: muted enough to sit on the dark ground without shouting. */
export const NOTE_COLORS = ['#e9a23b', '#b58ee0', '#6bd39a', '#d98a86', '#8fa4c4', '#d0a07a']

/** <input type="datetime-local"> wants local wall-clock, not an ISO instant. */
const toLocalInput = (ts: number | null) => {
  if (!ts) return ''
  const d = new Date(ts - new Date().getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}
const fromLocalInput = (v: string) => (v ? new Date(v).getTime() : null)

export function TaskSheet({
  open, onClose, task, fromCard,
}: { open: boolean; onClose: () => void; task?: Task | null; fromCard?: CardT | null }) {
  const { state } = useStore()
  const goals: Goal[] = state?.goals ?? []
  const existingReminder = state?.reminders.find(
    r => r.target_kind === 'task' && r.target_id === task?.id && !r.fired_at && !r.dismissed_at,
  )

  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [goalId, setGoalId] = useState('')
  const [due, setDue] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [remindAt, setRemindAt] = useState('')
  const [repeat, setRepeat] = useState('')
  const [noteBody, setNoteBody] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle(task?.title ?? fromCard?.title ?? '')
    setDetail(task?.detail ?? '')
    setGoalId(task?.goal_id ?? '')
    setDue(toLocalInput(task?.due_at ?? null))
    setColor(task?.color ?? null)
    setRemindAt(toLocalInput(existingReminder?.fire_at ?? null))
    setRepeat(existingReminder?.repeat_rule ?? '')
    setNoteBody('')
  }, [open, task?.id, fromCard?.group_key])

  async function save() {
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const body = {
        title: title.trim(),
        detail: detail.trim() || null,
        goal_id: goalId || null,
        due_at: fromLocalInput(due),
        color,
        source_card_group: task?.source_card_group ?? fromCard?.group_key ?? null,
      }
      const saved = task
        ? await actions.updateTask(task.id, body) as Task
        : await actions.createTask(body) as Task

      const fireAt = fromLocalInput(remindAt)
      if (fireAt) {
        // The server keeps at most one live reminder per target, so this either
        // creates it or moves the existing one — never a second buzz.
        await actions.setReminder({
          target_kind: 'task', target_id: saved.id, fire_at: fireAt,
          label: 'Reminder', repeat_rule: repeat || null,
        })
      } else if (existingReminder) {
        await actions.clearReminder(existingReminder.id)
      }
      await reload()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  async function addNote() {
    if (!noteBody.trim() || !task) return
    await actions.createNote({ task_id: task.id, body: noteBody.trim(), color })
    setNoteBody('')
    await reload()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={task ? 'Edit task' : 'New task'}
      footer={
        <div className="flex gap-2">
          {task && (
            <Button variant="ghost"
              onClick={async () => { await actions.deleteTask(task.id); await reload(); onClose() }}>
              <Trash2 size={14} /> Delete
            </Button>
          )}
          <Button variant="accent" className="grow" onClick={save} disabled={!title.trim() || busy}>
            {busy ? 'Saving…' : task ? 'Save' : 'Add task'}
          </Button>
        </div>
      }
    >
      {fromCard && (
        <p className="text-[12.5px] text-fg-mute mb-3.5 leading-snug">
          Linked to <span className="text-fg-dim">{fromCard.title.slice(0, 60)}</span>. The task
          survives even if that message goes away.
        </p>
      )}

      <Field label="Task">
        <input
          className={inputClass} value={title} autoFocus={!task}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save() }}
          placeholder="What needs doing?"
        />
      </Field>

      <Field label="Detail">
        <textarea
          className={`${inputClass} min-h-[68px] resize-y`} value={detail}
          onChange={e => setDetail(e.target.value)} placeholder="Optional"
        />
      </Field>

      {goals.length > 0 && (
        <Field label="Goal">
          <div className="flex flex-wrap gap-1.5">
            <Chip active={!goalId} onClick={() => setGoalId('')}>None</Chip>
            {goals.map(g => (
              <Chip key={g.id} active={goalId === g.id} dot={g.color ?? undefined}
                onClick={() => setGoalId(g.id === goalId ? '' : g.id)}>
                {g.title}
              </Chip>
            ))}
          </div>
        </Field>
      )}

      <Field label="Deadline" hint={due ? `Due ${until(fromLocalInput(due)!)}` : undefined}>
        <input type="datetime-local" className={inputClass} value={due}
          onChange={e => setDue(e.target.value)} />
      </Field>

      <Field
        label="Remind me"
        hint={remindAt ? `Pushes to your devices ${until(fromLocalInput(remindAt)!)}` : 'One reminder per task, always.'}
      >
        <input type="datetime-local" className={inputClass} value={remindAt}
          onChange={e => setRemindAt(e.target.value)} />
        {remindAt && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {[['', 'Once'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly']].map(([v, l]) => (
              <Chip key={v} active={repeat === v} onClick={() => setRepeat(v!)}>{l}</Chip>
            ))}
          </div>
        )}
      </Field>

      <Field label="Colour">
        <div className="flex gap-2 items-center">
          <button onClick={() => setColor(null)}
            className={`w-6 h-6 rounded-full border transition
              ${!color ? 'border-fg-dim' : 'border-ink-600'}`} />
          {NOTE_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)}
              style={{ background: c }}
              className={`w-6 h-6 rounded-full transition ${color === c ? 'ring-2 ring-offset-2 ring-offset-ink-850 ring-fg-dim' : ''}`} />
          ))}
        </div>
      </Field>

      {task && (
        <div className="mt-1">
          <div className="text-[11.5px] uppercase tracking-[0.07em] text-fg-mute mb-2">
            Sticky notes
          </div>
          <div className="space-y-2 mb-2">
            {task.notes?.map(n => (
              <div key={n.id}
                className="group relative rounded-[10px] px-3 py-2.5 text-[13px] leading-relaxed"
                style={{
                  background: `color-mix(in oklab, ${n.color ?? '#e9a23b'} 12%, var(--color-ink-800))`,
                  boxShadow: `inset 2px 0 0 ${n.color ?? '#e9a23b'}`,
                }}>
                <span className="whitespace-pre-wrap text-fg-dim">{n.body}</span>
                <button
                  onClick={async () => { await actions.deleteNote(n.id); await reload() }}
                  className="absolute top-1.5 right-1.5 p-1 text-fg-mute opacity-0
                             group-hover:opacity-100 hover:text-bad transition-opacity"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input
              className={inputClass} value={noteBody}
              onChange={e => setNoteBody(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void addNote() }}
              placeholder="Add a note…"
            />
            <Button variant="solid" onClick={addNote} disabled={!noteBody.trim()}><Plus size={15} /></Button>
          </div>
        </div>
      )}

      {existingReminder && (
        <p className="mt-3 text-[12.5px] text-fg-mute flex items-center gap-1.5">
          {remindAt ? <Bell size={12} /> : <BellOff size={12} />}
          {remindAt ? `Reminder set for ${until(fromLocalInput(remindAt)!)}` : 'Clearing this reminder on save'}
        </p>
      )}
    </Sheet>
  )
}
