/**
 * Web Push (VAPID) + the reminder scheduler.
 *
 * Every outbound notification goes through notify(), which is idempotent on a
 * dedup_key. That single choke point is what enforces "one reminder per thing":
 * a duplicate source, a repeated poll, or a restarted process cannot produce a
 * second buzz for the same event.
 */
import webpush from 'web-push'
import { db, kvGet, kvSet, logEvent, now, uid } from './db'
import { PUBLIC_URL, VAPID_SUBJECT } from './env'

let ready = false

export function vapidPublicKey(): string {
  ensureVapid()
  return kvGet('vapid_public')!
}

function ensureVapid() {
  if (ready) return
  let pub = kvGet('vapid_public')
  let priv = kvGet('vapid_private')
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys()
    pub = keys.publicKey
    priv = keys.privateKey
    kvSet('vapid_public', pub)
    kvSet('vapid_private', priv)
  }
  webpush.setVapidDetails(VAPID_SUBJECT, pub, priv)
  ready = true
}

export type PushPayload = { title: string; body?: string; url?: string; tag?: string; kind?: string }

/**
 * Deliver to every registered device. A subscription that returns 404/410 is
 * dead (browser uninstalled or permission revoked) and is dropped immediately;
 * anything else is counted and only dropped after repeated failure, so one
 * flaky network moment does not unsubscribe a phone.
 */
async function deliver(p: PushPayload) {
  ensureVapid()
  const subs = db.query<any, []>(`SELECT * FROM push_subs`).all()
  const body = JSON.stringify(p)

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 12 * 3600 },
      )
      db.query(`UPDATE push_subs SET last_ok_at = ?, fail_count = 0 WHERE endpoint = ?`).run(now(), s.endpoint)
    } catch (e: any) {
      const code = e?.statusCode
      if (code === 404 || code === 410) {
        db.query(`DELETE FROM push_subs WHERE endpoint = ?`).run(s.endpoint)
      } else {
        db.query(`UPDATE push_subs SET fail_count = fail_count + 1 WHERE endpoint = ?`).run(s.endpoint)
        db.query(`DELETE FROM push_subs WHERE endpoint = ? AND fail_count > 8`).run(s.endpoint)
      }
    }
  }))
}

/**
 * The one place a notification can be created. Returns false when this exact
 * thing has already been sent — callers rely on that rather than checking first,
 * so the check and the send cannot drift apart.
 */
export async function notify(dedupKey: string, p: PushPayload): Promise<boolean> {
  const inserted = db.query(
    `INSERT INTO notifications (id, dedup_key, title, body, url, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedup_key) DO NOTHING
     RETURNING id`,
  ).get(uid(), dedupKey, p.title, p.body ?? null, p.url ?? null, p.kind ?? null, now())

  if (!inserted) return false
  logEvent('notified', { meta: { dedup_key: dedupKey, kind: p.kind } })
  await deliver({ ...p, tag: p.tag ?? dedupKey })
  return true
}

const REPEAT_MS: Record<string, number> = { daily: 864e5, weekly: 7 * 864e5 }

function nextFire(fireAt: number, rule: string | null): number | null {
  if (!rule) return null
  if (rule === 'weekdays') {
    let t = fireAt + 864e5
    // Skip Saturday and Sunday so a weekday reminder stays a weekday reminder.
    for (let i = 0; i < 7; i++) {
      const d = new Date(t).getDay()
      if (d !== 0 && d !== 6) return t
      t += 864e5
    }
    return t
  }
  const step = REPEAT_MS[rule]
  return step ? fireAt + step : null
}

/** Fire everything due. Called on a timer; safe to call concurrently. */
export async function runReminders() {
  const due = db.query<any, [number]>(
    `SELECT * FROM reminders WHERE fired_at IS NULL AND dismissed_at IS NULL AND fire_at <= ?`,
  ).all(now())

  for (const r of due) {
    const { title, body, url } = describeTarget(r)
    // The reminder id is in the dedup key so a repeating reminder can fire
    // again tomorrow, while this occurrence can only fire once.
    await notify(`reminder:${r.id}:${r.fire_at}`, { title, body, url, kind: 'reminder' })

    const next = nextFire(r.fire_at, r.repeat_rule)
    if (next) {
      db.query(`UPDATE reminders SET fire_at = ? WHERE id = ?`).run(next, r.id)
    } else {
      db.query(`UPDATE reminders SET fired_at = ? WHERE id = ?`).run(now(), r.id)
    }
    logEvent('reminder_fired', { task_id: r.target_kind === 'task' ? r.target_id : null, meta: { id: r.id } })
  }

  await warnDeadlines()
}

function describeTarget(r: any): { title: string; body?: string; url?: string } {
  if (r.target_kind === 'task') {
    const t = db.query<any, [string]>(`SELECT title FROM tasks WHERE id = ?`).get(r.target_id)
    return { title: r.label || 'Reminder', body: t?.title ?? undefined, url: `${PUBLIC_URL}/work` }
  }
  if (r.target_kind === 'goal') {
    const g = db.query<any, [string]>(`SELECT title FROM goals WHERE id = ?`).get(r.target_id)
    return { title: r.label || 'Goal reminder', body: g?.title ?? undefined, url: `${PUBLIC_URL}/work` }
  }
  const c = db.query<any, [string]>(
    `SELECT title, url FROM cards WHERE group_key = ? AND gone = 0 ORDER BY ts DESC LIMIT 1`,
  ).get(r.target_id)
  return { title: r.label || 'Reminder', body: c?.title ?? undefined, url: c?.url ?? `${PUBLIC_URL}/` }
}

/**
 * Nudge once when a deadline comes into view, and once when it passes. The
 * deadline value is part of the dedup key, so moving a due date legitimately
 * re-arms the warning while leaving it alone never re-fires.
 *
 * Ordered nearest-first, and that order is load-bearing: each entry's test is
 * "the deadline is within `lead` of now", which an overdue task satisfies for
 * every lead. Checking the hour-out window first would match an overdue task
 * too, and the `break` below would then mean the overdue nudge never fired at
 * all — the earlier "Due soon" had already spent its dedup key.
 */
const HORIZONS: Array<[number, string]> = [[0, 'overdue'], [3600_000, 'due within the hour']]

async function warnDeadlines() {
  const t = now()
  const tasks = db.query<any, []>(
    `SELECT id, title, due_at FROM tasks WHERE status != 'done' AND due_at IS NOT NULL`,
  ).all()

  for (const task of tasks) {
    for (const [lead, label] of HORIZONS) {
      if (task.due_at - lead > t) continue
      await notify(`due:${task.id}:${task.due_at}:${lead}`, {
        title: label === 'overdue' ? 'Overdue' : 'Due soon',
        body: task.title,
        url: `${PUBLIC_URL}/work`,
        kind: 'deadline',
      })
      break // one horizon per pass; the nearer one wins
    }
  }
}
