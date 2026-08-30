import { useEffect, useState } from 'react'
import { Bell, BellOff, Plus, Trash2 } from 'lucide-react'
import type { Card as CardT, Goal, Task } from '../lib/types'
import { actions, reload, useStore } from '../lib/api'
import { atHour, deadlineWords, until, wallClock } from '../lib/time'
import { actions as api } from '../lib/api'
import { Button, Chip, Field, Sheet, inputClass } from './primitives'

/** Sticky-note palette: muted enough to sit on the dark ground without shouting. */
export const NOTE_COLORS = ['#e9a23b', '#b58ee0', '#6bd39a', '#d98a86', '#8fa4c4', '#d0a07a']

/**
 * `<input type="datetime-local">` wants local wall-clock, not an ISO instant.
 *
 * Built from the parts rather than by subtracting an offset. The old version
 * used `new Date().getTimezoneOffset()` — *today's* offset, applied to an
 * instant that might sit on the other side of a daylight-saving boundary, which
 * is an hour wrong wherever the clocks move. It is harmless in IST and wrong
 * everywhere else, which is the worst kind of harmless.
 */
const pad = (n: number) => String(n).padStart(2, '0')
const toLocalInput = (ts: number | null) => {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromLocalInput = (v: string) => (v ? new Date(v).getTime() : null)

/** What the reminder field says: the time he chose, and where it will land. */
function reminderWords(ts: number, devices: number | null, error: string | null): string {
  if (error) return error
  const when = `${wallClock(ts)} · ${until(ts)}`
  if (devices === null) return when
  if (devices === 0) return `${when} — no device is registered, so it will only appear in Wake`
  return `${when} — pushes to ${devices} device${devices > 1 ? 's' : ''}`
}

/**
 * The four times he actually picks, plus an escape hatch.
 *
 * Two bare `datetime-local` fields were the only unstyled native controls in the
 * product, and they are also the slowest way to say "tomorrow morning".
 */
const PRESETS: Array<{ id: string; label: string; at: () => number }> = [
  { id: 'today5', label: 'Today 5pm', at: () => atHour(0, 17) },
  { id: 'tom9', label: 'Tomorrow 9am', at: () => atHour(1, 9) },
  { id: 'mon9', label: 'Mon 9am', at: () => atHour(((8 - new Date().getDay()) % 7) || 7, 9) },
]

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
  /**
   * How many devices a reminder can actually reach.
   *
   * The field's hint used to read `Pushes to your devices in 2m` while
   * `GET /api/push/status` returned `{"devices":[]}` — a future-tense promise to
   * nobody. It states the number now, and says so when the number is zero.
   */
  const [devices, setDevices] = useState<number | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    api.pushStatus().then(d => { if (live) setDevices(d.devices.length) }).catch(() => { if (live) setDevices(0) })
    return () => { live = false }
  }, [open])

  /**
   * A reminder in the past is refused here, with a reason, rather than accepted
   * and fired one second later into nothing. It used to be: `created_at` and
   * `fired_at` measured one second apart, the Work row filtered on `!fired_at`
   * so no bell appeared, and reopening the task showed an empty field. He was
   * never told.
   */
  const remindTs = fromLocalInput(remindAt)
  const remindError = remindTs !== null && remindTs <= Date.now()
    ? 'That time has already passed — a reminder can only be set for the future.'
    : null

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
    // `existingReminder?.id` is in the dependency list on purpose. Without it,
    // a sheet opened before `/state` had returned seeded `remindAt` from
    // `undefined` and never re-seeded — and saving then took the
    // "clear the reminder" branch and silently deleted a reminder the reader
    // had never touched.
  }, [open, task?.id, fromCard?.group_key, existingReminder?.id])

  async function save() {
    if (!title.trim() || busy || remindError) return
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
        // creates it or moves the existing one — never a second buzz. It also
        // refuses a `fire_at` in the past now; the field below refuses it first,
        // so this is a second line rather than the only one.
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
          <Button variant="primary" className="grow" onClick={save} disabled={!title.trim() || busy}>
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

      {/* A deadline he set, stated back to him in the words he set it in. The
          storage was always right; the display never showed the time at all. */}
      <TimeField label="Deadline" value={due} onChange={setDue}
        stated={due ? deadlineWords(fromLocalInput(due)!) : null} />

      <TimeField
        label="Remind me" value={remindAt} onChange={setRemindAt}
        stated={remindAt ? reminderWords(fromLocalInput(remindAt)!, devices, remindError) : null}
        tone={remindError ? 'bad' : undefined}
      >
        {remindAt && !remindError && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {[['', 'Once'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly']].map(([v, l]) => (
              <Chip key={v} active={repeat === v} onClick={() => setRepeat(v!)}>{l}</Chip>
            ))}
          </div>
        )}
      </TimeField>

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
                  background: `color-mix(in oklab, ${n.color ?? 'var(--color-accent)'} 12%, var(--color-ink-800))`,
                  boxShadow: `inset 2px 0 0 ${n.color ?? 'var(--color-accent)'}`,
                }}>
                {/* Editable in place: click the text, type, blur to save. A note
                    you cannot correct is a note you stop trusting. */}
                <div
                  contentEditable suppressContentEditableWarning
                  className="whitespace-pre-wrap text-fg-dim outline-none pr-5"
                  onBlur={async e => {
                    const body = e.currentTarget.textContent?.trim() ?? ''
                    if (!body || body === n.body) {
                      e.currentTarget.textContent = n.body
                      return
                    }
                    await actions.updateNote(n.id, { body })
                    await reload()
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur() }
                    if (e.key === 'Escape') { e.currentTarget.textContent = n.body; e.currentTarget.blur() }
                  }}
                >{n.body}</div>
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
          <div className="flex gap-1.5">
            <input
              className={inputClass} value={noteBody}
              onChange={e => setNoteBody(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void addNote() }}
              placeholder="Add a note…"
            />
            <Button variant="default" onClick={addNote} disabled={!noteBody.trim()}><Plus size={15} /></Button>
          </div>
        </div>
      )}

      {existingReminder && (
        <p className="mt-3 text-sm text-fg-mute flex items-center gap-2">
          {remindAt ? <Bell size={12} /> : <BellOff size={12} />}
          {remindAt ? `Set for ${wallClock(fromLocalInput(remindAt)!)}` : 'Clearing this reminder on save'}
        </p>
      )}
    </Sheet>
  )
}


/**
 * A time, chosen from the times he actually picks, with the native control as
 * the escape hatch rather than as the interface — and stated back in words.
 */
function TimeField({
  label, value, onChange, stated, tone, children,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  stated: string | null
  tone?: 'bad'
  children?: React.ReactNode
}) {
  const [exact, setExact] = useState(false)
  useEffect(() => { if (!value) setExact(false) }, [value])

  return (
    <div className="mb-4">
      <div className="text-eyebrow uppercase text-fg-mute mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map(p => (
          <Chip key={p.id} onClick={() => { onChange(toLocalInput(p.at())); setExact(false) }}>
            {p.label}
          </Chip>
        ))}
        <Chip active={exact} onClick={() => setExact(o => !o)}>Pick…</Chip>
        <Chip active={!value} onClick={() => { onChange(''); setExact(false) }}>None</Chip>
      </div>
      {(exact || (!!value && !stated)) && (
        <input type="datetime-local" className={`${inputClass} mt-2`} value={value}
          onChange={e => onChange(e.target.value)} />
      )}
      {stated && (
        <p className={`mt-1.5 text-sm ${tone === 'bad' ? 'text-bad' : 'text-fg-dim'}`}>{stated}</p>
      )}
      {children}
    </div>
  )
}
