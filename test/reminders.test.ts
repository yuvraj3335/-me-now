/**
 * Deadline nudges.
 *
 * The hard requirement is "one reminder per thing", and `notify` enforces that
 * on a dedup key. The subtler half is that the two deadline horizons are
 * *different* things: a task warned an hour before it is due must still be able
 * to tell you when it has actually passed.
 *
 * That is what these pin. An earlier version listed the hour-out horizon first
 * and broke out of the loop on the first match — but "the deadline is within an
 * hour of now" is also true of a deadline that went by yesterday, so the
 * overdue horizon was unreachable and an overdue task was reported as "Due
 * soon", forever.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { db, now, uid } from '../src/server/db'
import { runReminders } from '../src/server/push'
import { api } from '../src/server/api'

const HOUR = 3.6e6

function task(title: string, dueAt: number): string {
  const id = uid()
  db.query(
    `INSERT INTO tasks (id, title, status, due_at, sort, created_at, updated_at)
     VALUES (?, ?, 'todo', ?, 0, ?, ?)`,
  ).run(id, title, dueAt, now(), now())
  return id
}

const notificationsFor = (taskTitle: string) =>
  db
    .query<{ title: string; body: string | null; kind: string | null }, [string]>(
      `SELECT title, body, kind FROM notifications WHERE body = ? ORDER BY created_at`,
    )
    .all(taskTitle)

beforeEach(() => {
  db.query(`DELETE FROM tasks`).run()
  db.query(`DELETE FROM notifications`).run()
})

describe('deadline horizons', () => {
  test('a deadline that has passed is reported as overdue, not as due soon', async () => {
    task('ship the migration', now() - 10 * 60_000)
    await runReminders()

    const sent = notificationsFor('ship the migration')
    expect(sent.map(n => n.title)).toEqual(['Overdue'])
    expect(sent[0]?.kind).toBe('deadline')
  })

  test('a deadline still ahead is reported as due soon', async () => {
    task('review the PR', now() + 30 * 60_000)
    await runReminders()

    expect(notificationsFor('review the PR').map(n => n.title)).toEqual(['Due soon'])
  })

  test('the two horizons do not collide on one pass', async () => {
    task('overdue one', now() - HOUR)
    task('soon one', now() + 20 * 60_000)
    await runReminders()

    expect(notificationsFor('overdue one').map(n => n.title)).toEqual(['Overdue'])
    expect(notificationsFor('soon one').map(n => n.title)).toEqual(['Due soon'])
  })

  test('a deadline further out than an hour says nothing at all', async () => {
    task('next week', now() + 5 * HOUR)
    await runReminders()

    expect(notificationsFor('next week')).toEqual([])
  })

  test('a second pass does not buzz twice for the same deadline', async () => {
    task('ship the migration', now() - 10 * 60_000)
    await runReminders()
    await runReminders()

    expect(notificationsFor('ship the migration').length).toBe(1)
  })

  test('a finished task stops nagging', async () => {
    const id = task('already done', now() - HOUR)
    db.query(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(id)
    await runReminders()

    expect(notificationsFor('already done')).toEqual([])
  })
})

describe('a reminder cannot be set in the past', () => {
  test('the boundary refuses it, with a reason', async () => {
    // It used to validate presence only, and `runReminders()` fires on
    // `fire_at <= now()` — so a past reminder was created and fired one second
    // later, into a `push_subs` table with nothing in it. The Work row filters
    // on `!fired_at`, so no bell appeared; reopening the task showed an empty
    // field. He was never told.
    const r = await api.request('/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_kind: 'task', target_id: 't1', fire_at: Date.now() - 3.6e6,
      }),
    })
    expect(r.status).toBe(400)
    expect((await r.json() as any).error).toContain('past')
  })

  test('a minute of slack, because "now" is not "the past"', async () => {
    const r = await api.request('/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_kind: 'task', target_id: 'slack-window', fire_at: Date.now() - 5_000,
      }),
    })
    expect(r.status).toBe(200)
  })

  test('a future reminder is still accepted', async () => {
    const r = await api.request('/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_kind: 'task', target_id: 'future', fire_at: Date.now() + 864e5,
      }),
    })
    expect(r.status).toBe(200)
  })
})
