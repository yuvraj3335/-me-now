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
export type Delivery = { devices: number; delivered: number; dropped: number }

async function deliver(p: PushPayload): Promise<Delivery> {
  ensureVapid()
  const subs = db.query<any, []>(`SELECT * FROM push_subs`).all()
  const body = JSON.stringify(p)
  let delivered = 0
  let dropped = 0

  /*
   * A send that reached nobody is said out loud.
   *
   * `push_subs` was empty on this deployment and had been for the whole life of
   * the service — `POST /api/push/subscribe` has never been called, not once.
   * Every part of the machinery downstream is healthy: the 30s tick runs, VAPID
   * keys exist, `sw.js` is correct and deployed, and `notify()` wrote its rows.
   * They just went to an empty list, silently: this function had no logging at
   * all, so a zero-device delivery was indistinguishable from a successful one
   * in the journal, and `POST /push/test` answered `{ sent: true, devices: 0 }`
   * — which reads as "it works".
   *
   * That is why "notifications are not firing" went unexplained for so long. The
   * cause is that no device ever completed the subscription; the *bug* is that
   * nothing anywhere said so.
   */
  if (!subs.length) {
    console.warn(`wake: push "${p.title}" reached no devices — nothing is subscribed`)
    return { devices: 0, delivered: 0, dropped: 0 }
  }

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 12 * 3600 },
      )
      db.query(`UPDATE push_subs SET last_ok_at = ?, fail_count = 0 WHERE endpoint = ?`).run(now(), s.endpoint)
      delivered++
    } catch (e: any) {
      const code = e?.statusCode
      if (code === 404 || code === 410) {
        db.query(`DELETE FROM push_subs WHERE endpoint = ?`).run(s.endpoint)
        dropped++
      } else {
        db.query(`UPDATE push_subs SET fail_count = fail_count + 1 WHERE endpoint = ?`).run(s.endpoint)
        // Counted here too: this path also removes the row, and a `dropped`
        // that only counted the 404/410 case reported fewer devices lost than
        // were actually lost.
        const gone = db.query(`DELETE FROM push_subs WHERE endpoint = ? AND fail_count > 8`)
          .run(s.endpoint)
        if (gone.changes > 0) dropped++
      }
      /*
       * The host, if the endpoint parses — and nothing thrown from in here.
       *
       * `POST /push/subscribe` validates only that `endpoint` is truthy, so a
       * row can hold a string that is not a URL. `new URL()` on that throws a
       * `TypeError` *out of this catch block*, which rejects the map callback,
       * which rejects the `Promise.all`, which rejects `deliver()` — and
       * `runReminders()` is the caller. One malformed row would therefore throw
       * mid-loop before the `UPDATE reminders` below it ran, so the reminder
       * stayed due and threw again on the next tick, for ever. A logging line is
       * not allowed to be the thing that stops reminders working.
       */
      let where = 'a device'
      try { where = new URL(s.endpoint).host } catch { /* not a URL; say so plainly */ }
      console.warn(`wake: push to ${where} failed (${code ?? 'no status'})`)
    }
  }))

  return { devices: subs.length, delivered, dropped }
}

/**
 * Send one now, past the dedup table, and report what actually happened.
 *
 * `notify()` is the wrong shape for a test: it answers whether a *row* was
 * created, which is a fact about the notifications table and not about whether
 * a phone buzzed. A test button exists to answer the second question.
 */
export async function sendTestPush(): Promise<Delivery> {
  return deliver({
    title: 'Wake',
    body: 'Notifications are working.',
    kind: 'test',
    tag: `test:${now()}`,
  })
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

/**
 * One emoji per notification kind, always the same one, always leading the
 * title, and never in the body.
 *
 * These four are the only emoji in the product. A push lands in OS chrome,
 * where no lucide glyph and no Wake token reaches, and a lock screen holding
 * six grey lines needs one mark that says which of them this is. Inside the DOM
 * the same distinction is drawn with a glyph and a colour, so nothing there
 * needs one — and the body is his own words either way.
 */
const REMINDER = '⏰ '
const GOAL = '🎯 '
const OVERDUE = '🔴 '
const DUE_SOON = '🟠 '

function describeTarget(r: any): { title: string; body?: string; url?: string } {
  if (r.target_kind === 'task') {
    const t = db.query<any, [string]>(`SELECT title FROM tasks WHERE id = ?`).get(r.target_id)
    return { title: REMINDER + (r.label || 'Reminder'), body: t?.title ?? undefined, url: `${PUBLIC_URL}/work` }
  }
  if (r.target_kind === 'goal') {
    const g = db.query<any, [string]>(`SELECT title FROM goals WHERE id = ?`).get(r.target_id)
    return { title: GOAL + (r.label || 'Goal reminder'), body: g?.title ?? undefined, url: `${PUBLIC_URL}/work` }
  }
  const c = db.query<any, [string]>(
    `SELECT title, url FROM cards WHERE group_key = ? AND gone = 0 ORDER BY ts DESC LIMIT 1`,
  ).get(r.target_id)
  return { title: REMINDER + (r.label || 'Reminder'), body: c?.title ?? undefined, url: c?.url ?? `${PUBLIC_URL}/` }
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

  const due: Array<{ key: string; title: string; at: number; url: string }> = []

  for (const task of db.query<any, []>(
    // `NOT IN`, not `!= 'done'`. A task now has two settled states, and the
    // second one arrived with migration 14: deciding you are *not* going to do
    // something is the one case where a deadline is most certainly not news.
    // The old test let every `wont_do` task keep buzzing on the day it was
    // never going to be done.
    `SELECT id, title, due_at FROM tasks
      WHERE status NOT IN ('done', 'wont_do') AND due_at IS NOT NULL`,
  ).all()) {
    due.push({ key: `due:${task.id}`, title: task.title, at: task.due_at, url: `${PUBLIC_URL}/work` })
  }

  /*
   * Cards have due dates too, and the join to `cards` is what keeps this
   * honest: `card_state` outlives the card the poller sweeps, so without
   * `gone = 0` Wake would push deadline warnings about things that are no
   * longer on any desk and cannot be opened from the notification.
   */
  for (const card of db.query<any, []>(
    `SELECT s.group_key, s.due_at, c.title
       FROM card_state s
       JOIN cards c ON c.id = (
         SELECT live.id FROM cards live
          WHERE live.group_key = s.group_key AND live.gone = 0
          ORDER BY live.ts DESC LIMIT 1
       )
      WHERE s.status NOT IN ('done','wont_do') AND s.due_at IS NOT NULL`,
  ).all()) {
    due.push({
      key: `due:card:${card.group_key}`,
      title: card.title,
      at: card.due_at,
      // The desk, not the source: a due date is Wake's own fact about the card,
      // and the thing to do with it is look at the row it is on.
      url: `${PUBLIC_URL}/`,
    })
  }

  for (const item of due) {
    for (const [lead, label] of HORIZONS) {
      if (item.at - lead > t) continue
      await notify(`${item.key}:${item.at}:${lead}`, {
        title: label === 'overdue' ? `${OVERDUE}Overdue` : `${DUE_SOON}Due soon`,
        body: item.title,
        url: item.url,
        kind: 'deadline',
      })
      break // one horizon per pass; the nearer one wins
    }
  }
}
