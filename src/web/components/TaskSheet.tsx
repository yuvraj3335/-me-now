import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import type { Card as CardT, Goal, Task } from '../lib/types'
import { actions, reload, useStore } from '../lib/api'
import { useStill } from '../lib/motion'
import { deadlineWords, until, wallClock } from '../lib/time'
import { actions as api } from '../lib/api'
import { Button, Chip, DateTimePicker, Field, Sheet, inputClass } from './primitives'

/** Sticky-note palette: muted enough to sit on the dark ground without shouting. */
export const NOTE_COLORS = ['#e9a23b', '#b58ee0', '#6bd39a', '#d98a86', '#8fa4c4', '#d0a07a']

/**
 * The same six, in words, because a swatch with no name is a control nobody can
 * describe.
 *
 * Seven 24px circles eight pixels apart, with no `aria-label`, no `title` and no
 * legend: a screen reader announced seven unlabelled buttons and a sighted
 * reader had no way to say which one they had chosen. The names are a second
 * array rather than a field on each entry because a contract test refuses a
 * hard-coded hex on any line that does not mention the palette — so every hex
 * stays on the one line that does, and these pair with it by index.
 *
 * A hex that is not in the palette is `Custom` rather than `undefined`: a task
 * coloured before this list changed still has to be able to say what it is.
 */
const NOTE_COLOR_NAMES = ['Amber', 'Violet', 'Green', 'Rose', 'Blue', 'Clay']

export const noteColorName = (hex: string | null) =>
  hex === null ? 'No colour' : NOTE_COLOR_NAMES[NOTE_COLORS.indexOf(hex)] ?? 'Custom'

/** What the reminder field says: the time he chose, and where it will land. */
function reminderWords(ts: number, devices: number | null, error: string | null): string {
  if (error) return error
  const when = `${wallClock(ts)} · ${until(ts)}`
  if (devices === null) return when
  if (devices === 0) return `${when} — no device is registered, so it will only appear in Wake`
  return `${when} — pushes to ${devices} device${devices > 1 ? 's' : ''}`
}

export function TaskSheet({
  open, onClose, task, fromCard,
}: { open: boolean; onClose: () => void; task?: Task | null; fromCard?: CardT | null }) {
  const { state } = useStore()
  const goals: Goal[] = state?.goals ?? []
  const existingReminder = state?.reminders.find(
    r => r.target_kind === 'task' && r.target_id === task?.id && !r.fired_at && !r.dismissed_at,
  )

  const [title, setTitle] = useState('')
  const [goalId, setGoalId] = useState('')
  /**
   * Both times are epoch milliseconds now, not `datetime-local` strings.
   *
   * The string was an artefact of the native input these fields used to hide
   * behind a `Pick…` chip; with a real calendar the field's value and the value
   * that gets written are the same number, so there is one representation and
   * no `fromLocalInput` on the way out. The picker does its own wall-clock
   * arithmetic on local parts, which is the only kind that survives a daylight
   * saving boundary.
   */
  const [due, setDue] = useState<number | null>(null)
  const [color, setColor] = useState<string | null>(null)
  const [remindAt, setRemindAt] = useState<number | null>(null)
  const [repeat, setRepeat] = useState('')
  const [noteBody, setNoteBody] = useState('')
  /** Notes typed before there is a task to hang them on. */
  const [pending, setPending] = useState<string[]>([])
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
  const remindError = remindAt !== null && remindAt <= Date.now()
    ? 'That time has already passed — a reminder can only be set for the future.'
    : null

  useEffect(() => {
    if (!open) return
    setTitle(task?.title ?? fromCard?.title ?? '')
    setGoalId(task?.goal_id ?? '')
    setDue(task?.due_at ?? null)
    setColor(task?.color ?? null)
    setRemindAt(existingReminder?.fire_at ?? null)
    setRepeat(existingReminder?.repeat_rule ?? '')
    setNoteBody('')
    setPending([])
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
      const body: Record<string, unknown> = {
        title: title.trim(),
        goal_id: goalId || null,
        due_at: due,
        color,
        source_card_group: task?.source_card_group ?? fromCard?.group_key ?? null,
      }
      // Frozen at creation, never on update: a task is a durable object and a
      // card is a view of somebody else's system. `source_card_group` used to be
      // the only link, and `ingest.ts` marks a card gone the moment its source
      // stops returning it — so a task's provenance line disappeared exactly
      // when the pull request merged.
      if (!task && fromCard) {
        body.origin_source = fromCard.sources[0]?.source ?? null
        body.origin_title = fromCard.title
        body.origin_why = fromCard.why
        body.origin_url = fromCard.url
        body.origin_excerpt = fromCard.excerpt ?? null
        body.origin_meta = fromCard.meta ?? null
      }
      const saved = task
        ? await actions.updateTask(task.id, body) as Task
        : await actions.createTask(body) as Task

      // Notes typed before the first save land now, in the order they were typed.
      for (const p of pending) await actions.createNote({ task_id: saved.id, body: p, color })
      setPending([])

      if (remindAt !== null) {
        // The server keeps at most one live reminder per target, so this either
        // creates it or moves the existing one — never a second buzz. It also
        // refuses a `fire_at` in the past now; the field below refuses it first,
        // so this is a second line rather than the only one.
        await actions.setReminder({
          target_kind: 'task', target_id: saved.id, fire_at: remindAt,
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
    const body = noteBody.trim()
    if (!body) return
    setNoteBody('')
    // Before the first save there is no task to hang a note on, so it waits.
    if (!task) return setPending(p => [...p, body])
    await actions.createNote({ task_id: task.id, body, color })
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
      {/* One quiet line, not a promise about durability. The durability is in the
          `origin_*` columns below, which copy the card rather than pointing at a
          row the poller garbage-collects. */}
      {fromCard && (
        <div className="flex items-center h-11 border-b border-rule mb-4 min-w-0">
          <span className="text-sm text-fg-mute w-24 shrink-0">From</span>
          <span className="text-sm text-fg-dim truncate min-w-0" title={fromCard.title}>
            {fromCard.title}
          </span>
        </div>
      )}

      <Field label="Task">
        <input
          className={inputClass} value={title} autoFocus={!task}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save() }}
          placeholder="What needs doing?"
        />
      </Field>

      {goals.length > 0 && (
        <Field label="Goal">
          <div className="flex flex-wrap gap-2">
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
      <TimeField
        label="Deadline" value={due} onChange={setDue}
        stated={due !== null ? deadlineWords(due) : 'No deadline'}
      />

      {/*
        The reminder folds; the deadline does not.

        This sheet was 1,082px of content in a 608px window and two thirds of
        that was calendars — two six-week grids standing open at once to add a
        one-line task. They are both the right control (see `TimeField`), so the
        cut is not to the control, it is to how many of them are unfolded before
        anyone asks. A deadline is the ordinary question a task answers and it
        stays open; a reminder is the rarer of the two and it asks first, the
        same way the desk's Due row does. The sentence is on the button, so a
        reminder that is already set is still readable without opening anything.
      */}
      <TimeField
        fold
        label="Remind me" value={remindAt} onChange={setRemindAt}
        stated={
          remindAt !== null ? reminderWords(remindAt, devices, remindError)
          : existingReminder ? 'Clearing this reminder on save'
          : 'No reminder'
        }
        tone={remindError ? 'bad' : undefined}
      >
        {remindAt !== null && !remindError && (
          <div className="flex flex-wrap gap-2 mt-2">
            {[['', 'Once'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly']].map(([v, l]) => (
              <Chip key={v} active={repeat === v} onClick={() => setRepeat(v!)}>{l}</Chip>
            ))}
          </div>
        )}
      </TimeField>

      {/*
        A palette that says what it is, and can be hit.

        Seven 24px circles at `gap-2` measured 576px² of target each on a phone
        and announced as seven unlabelled buttons. Both halves are fixed here.
        `.hit` is the target — but a collar is 44px wide and these tile, so at a
        32px pitch each circle's collar swallowed a third of its left neighbour's
        and the row's last-painted button took the taps. `gap-5` puts the pitch
        at 44 so every collar owns exactly its own circle and nothing overlaps.

        The sentence under the row is the same promise `TimeField` makes: say the
        choice back. A colour in Wake means nothing on its own — it is a tint,
        not a category — so the honest legend is its name and where it will show
        up, rather than a meaning invented for it here.
      */}
      <Field label="Colour">
        <div className="flex gap-5 items-center">
          <button onClick={() => setColor(null)} title="No colour" aria-label="No colour"
            aria-pressed={!color}
            className={`hit relative w-6 h-6 rounded-full border transition
              ${!color ? 'border-fg-dim' : 'border-ink-600'}`} />
          {NOTE_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)}
              style={{ background: c }}
              title={noteColorName(c)} aria-label={noteColorName(c)} aria-pressed={color === c}
              className={`hit relative w-6 h-6 rounded-full transition ${color === c ? 'ring-2 ring-offset-2 ring-offset-ink-850 ring-fg-dim' : ''}`} />
          ))}
        </div>
        <p className="mt-2 text-sm text-fg-mute">
          {color === null
            ? 'No colour'
            : `${noteColorName(color)} — tints this task's edge on the list, and its notes.`}
        </p>
      </Field>

      {/*
        Stickies exist at the moment they are wanted.
        They were gated on `{task && …}`, so a task made from a card got the
        create sheet — which had no stickies at all, and a `Detail` textarea
        instead. You had to save, find the task in Up next, tap it, and reopen a
        sheet with a different set of fields than it had a second earlier. A form
        whose field list changes on save is a form nobody trusts. Notes typed
        before the first save are held here and written straight after it.
      */}
      <div className="mt-1">
        <div className="text-eyebrow uppercase text-fg-mute mb-2">Notes</div>
          <div className="space-y-2 mb-2">
            {pending.map((body, i) => (
              <div key={`pending:${i}`}
                className="relative rounded-chip px-3 py-2 text-sm leading-relaxed"
                style={{
                  background: `color-mix(in oklab, ${color ?? 'var(--color-fg-mute)'} 12%, var(--color-ink-800))`,
                  boxShadow: `inset 2px 0 0 ${color ?? 'var(--color-fg-mute)'}`,
                }}>
                <span className="whitespace-pre-wrap text-fg-dim pr-5">{body}</span>
                <button onClick={() => setPending(p => p.filter((_, j) => j !== i))}
                  className="absolute top-1.5 right-1.5 p-1 text-fg-mute hover:text-bad
                             transition-colors duration-100"
                  aria-label="Remove note">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {task?.notes?.map(n => (
              <div key={n.id}
                className="group relative rounded-chip px-3 py-2 text-sm leading-relaxed"
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
    </Sheet>
  )
}


/**
 * A time, picked on a calendar, and said back in his own words.
 *
 * What was here was five chips — `Today 5pm · Tomorrow 9am · Mon 9am · Pick… ·
 * None` — and they were broken in a way the design hid: the three presets were
 * rendered with no `active`, so choosing one left every chip unpressed and only
 * the sentence underneath changed. `None` was the only one that ever lit up. On
 * a phone the row wrapped to two lines.
 *
 * They are gone rather than repaired, because the bug was the smaller half. A
 * preset answers *how far away* and a deadline is *when*, and putting the two
 * questions side by side made the control that answers the real one — the
 * native field behind `Pick…` — look like the fallback. `DateTimePicker` is a
 * month grid and a time, so `Tomorrow 9am` is a day cell and a clock rather
 * than a chip, and every other date in the year is reachable by the same two
 * presses instead of by a sixth control.
 *
 * `stated` survives untouched, and it is the best thing this field had: it says
 * the choice back in the words he set it in, including when the choice is
 * nothing at all. A field that reads `No deadline` has answered its own
 * question; one that is simply blank has not. Clearing is `DateTimePicker`'s own
 * Clear, which appears only once there is something to clear.
 */
function TimeField({
  label, value, onChange, stated, tone, fold, children,
}: {
  label: string
  value: number | null
  onChange: (ms: number | null) => void
  /** Always a sentence, including the one that says nothing is set. */
  stated: string
  tone?: 'bad'
  /**
   * Start folded, with the sentence on the button that unfolds it.
   *
   * A month grid and a time is ~314px, and two of them standing open is most of
   * a sheet. Folded, the field still answers its own question — the sentence is
   * the button's label rather than a line under a calendar — and one press
   * reveals the same control, unchanged. What the press reveals is the
   * *control*, not the choice, which is what keeps it from being a menu.
   */
  fold?: boolean
  children?: React.ReactNode
}) {
  const still = useStill()
  const [open, setOpen] = useState(false)

  /** One element, reached two ways: folded it is behind the button, unfolded it
   *  is the field. Two JSX sites would be two calendars to keep in step. */
  const picker = <DateTimePicker value={value} onChange={onChange} ariaLabel={label} />
  const wordClass = tone === 'bad' ? 'text-bad' : value === null ? 'text-fg-mute' : 'text-fg-dim'

  return (
    <div className="mb-4">
      <div className="text-eyebrow uppercase text-fg-mute mb-2">{label}</div>

      {fold ? (
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          aria-label={`${label} — ${stated}`}
          className="hit relative w-full flex items-center justify-between gap-2 text-left
                     min-h-8 px-2 py-1.5 rounded-control border border-edge text-sm font-medium
                     hover:bg-ink-800 transition-colors duration-100"
        >
          <span className={wordClass}>{stated}</span>
          <ChevronDown size={13} aria-hidden
            className={`shrink-0 text-fg-mute transition-transform duration-100 ${open ? 'rotate-180' : ''}`} />
        </button>
      ) : picker}

      {/* Height, not display: a grid that appears at its full size shoves the
          footer commit out from under a thumb already travelling toward it. */}
      <AnimatePresence initial={false}>
        {fold && open && (
          <motion.div
            key={`${label}-picker`}
            initial={still ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={still ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="pt-3">{picker}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* An unfolded field states itself underneath; a folded one already said
          it on the button, and saying it twice is how a form starts arguing
          with itself. */}
      {!fold && (
        <p className={`mt-2 text-sm ${wordClass}`}>{stated}</p>
      )}

      {/* Outside the fold on purpose. The repeat rule only exists once a
          reminder does, and it is four chips — hiding it behind the same press
          that hides a 314px calendar would cost a fact to save nothing. */}
      {children}
    </div>
  )
}
