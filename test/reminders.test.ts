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

/**
 * The titles carry one leading emoji each, because a push lands in OS chrome
 * where nothing else can tell two grey lines apart. They are pinned here rather
 * than matched loosely: the whole point of the policy is that the mark for a
 * kind never changes, and a regex that shrugs at the prefix would not notice.
 */
const OVERDUE = '🔴 Overdue'
const DUE_SOON = '🟠 Due soon'

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

function card(group: string, title: string, dueAt: number, opts: { gone?: number; status?: string } = {}) {
  db.query(
    `INSERT INTO cards (id, source, source_id, group_key, kind, title, why, url, ts, pile,
                        refs, meta, first_seen_at, last_seen_at, gone)
     VALUES (?,?,?,?,?,?,?,?,?,?,'[]','{}',?,?,?)`,
  ).run(`github:${group}`, 'github', group, group, 'my_pr', title, 'yours',
        'https://github.com/acme/widgets/pull/7', now(), 'open', now(), now(), opts.gone ?? 0)
  db.query(
    `INSERT INTO card_state (group_key, status, due_at, first_seen_at, updated_at)
     VALUES (?,?,?,?,?)`,
  ).run(group, opts.status ?? 'not_started', dueAt, now(), now())
}

beforeEach(() => {
  db.query(`DELETE FROM tasks`).run()
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
  db.query(`DELETE FROM notifications`).run()
})

describe('deadline horizons', () => {
  test('a deadline that has passed is reported as overdue, not as due soon', async () => {
    task('ship the migration', now() - 10 * 60_000)
    await runReminders()

    const sent = notificationsFor('ship the migration')
    expect(sent.map(n => n.title)).toEqual([OVERDUE])
    expect(sent[0]?.kind).toBe('deadline')
  })

  test('a deadline still ahead is reported as due soon', async () => {
    task('review the PR', now() + 30 * 60_000)
    await runReminders()

    expect(notificationsFor('review the PR').map(n => n.title)).toEqual([DUE_SOON])
  })

  test('the two horizons do not collide on one pass', async () => {
    task('overdue one', now() - HOUR)
    task('soon one', now() + 20 * 60_000)
    await runReminders()

    expect(notificationsFor('overdue one').map(n => n.title)).toEqual([OVERDUE])
    expect(notificationsFor('soon one').map(n => n.title)).toEqual([DUE_SOON])
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

describe('a card has a deadline too', () => {
  test('an overdue card is nudged, with a link back to the desk', async () => {
    card('gh:acme/widgets#7', 'the migration PR', now() - 10 * 60_000)
    await runReminders()

    const sent = db.query<any, [string]>(
      `SELECT title, url FROM notifications WHERE body = ?`,
    ).all('the migration PR')
    expect(sent.map(n => n.title)).toEqual([OVERDUE])
    expect(sent[0].url).toMatch(/\/$/)
  })

  test('a card the poller swept says nothing', async () => {
    // `card_state` outlives the card. Without the `gone = 0` join, a due date on
    // a group whose last card vanished upstream keeps buzzing about something
    // that is on no desk and opens to nothing.
    card('gh:acme/widgets#8', 'a merged PR', now() - HOUR, { gone: 1 })
    await runReminders()

    expect(notificationsFor('a merged PR')).toEqual([])
  })

  test('a card he finished says nothing', async () => {
    card('gh:acme/widgets#9', 'already shipped', now() - HOUR, { status: 'done' })
    card('gh:acme/widgets#10', 'never doing it', now() - HOUR, { status: 'wont_do' })
    await runReminders()

    expect(notificationsFor('already shipped')).toEqual([])
    expect(notificationsFor('never doing it')).toEqual([])
  })
})

describe('a push that woke nobody says so', () => {
  /*
   * The reported symptom was "notifications are not firing", and everything
   * downstream turned out to be healthy: the 30s tick runs, VAPID keys are
   * generated and stored, `sw.js` is correct and in `dist/`, and `notify()` had
   * written its rows. `push_subs` was simply empty — `POST /api/push/subscribe`
   * has never been called on this deployment, not once in the service's logged
   * history.
   *
   * That part is his to fix, on a device, and it is one tap. What was Wake's to
   * fix is that nothing ever said so: `/push/test` called `notify()` and
   * reported *its* return value, which answers whether the dedup key was new.
   * With nothing subscribed the response was `{ sent: true, devices: 0 }` — two
   * true facts arranged to read as success, on the one button whose entire job
   * is telling him whether this works.
   */
  test('the test button reports reach, not that a row was written', async () => {
    db.query(`DELETE FROM push_subs`).run()

    const r = await api.request('/push/test', { method: 'POST' })
    expect(r.status).toBe(200)
    const body = await r.json() as { sent: boolean; devices: number; reason: string | null }

    expect(body.devices, 'a device appeared from nowhere').toBe(0)
    expect(body.sent, 'a push that reached nobody reported success').toBe(false)
    expect(body.reason, 'the failure has no reason on it').toBeTruthy()
    expect(body.reason, 'the reason does not say what to do about it')
      .toContain('subscribed')
  })

  test('a test does not appear in his notifications', () => {
    // It used to go through `notify()`, which writes a row. A test is not a
    // thing that happened to him and has no business in that list.
    const before = db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM notifications WHERE kind = 'test'`,
    ).get()!.n
    expect(before, 'the test button is still filing notifications').toBe(0)
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
