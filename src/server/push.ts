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
import { slackTsMs } from '../shared/slackThread'
import { sessionsNeedingAttention } from './sources/claudeSessions'
import { listTerminals } from './claudecode/terminal'

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

/* ------------------------------ new work ---------------------------------- */

/**
 * Where a push about a card lands: the desk, filtered to its source, with the
 * card's own detail open.
 *
 * Built from the same two things `src/web/lib/route.ts` reads back out — `?src=`
 * (`Home.tsx`'s `FILTERS` tab) and `#card/<group_key>` (`detailKeyOf`) — because
 * that file, not this one, owns what a Wake address means. `test/push-events
 * .test.ts` parses this URL with `detailKeyOf` and asserts the group key comes
 * back exactly, which is what keeps the two ends from drifting apart.
 */
function cardUrl(source: string, groupKey: string, kind?: string): string {
  return `${PUBLIC_URL}/?src=${encodeURIComponent(tabFor(source, kind))}#card/${encodeURIComponent(groupKey)}`
}

/**
 * The tab a row is filed under, mirrored from `bucketOf` in
 * `src/web/lib/bucket.ts`: a Sentry member and any Slack member a monitor posted
 * (`kind: 'alert'`) are on the Alerts tab, whatever pipe carried them. The first
 * paged push this shipped with linked to `?src=slack#card/sentry:TRUTO-Q` — the
 * pipe, not the tab — and landed on a tab that did not hold the card.
 * `test/push-events.test.ts` pins the mirror.
 */
export function tabFor(source: string, kind?: string): string {
  if (source === 'sentry') return 'alerts'
  if (source === 'slack' && kind === 'alert') return 'alerts'
  return source
}

const CRISP = '💬 '
const MENTION = '👋 '
const PAGED = '🚨 '
const NOW_WAITING = '🔔 '

/** How far back "new" reaches. Older than this is backlog, not news. */
const NEW_WORK_MAX_AGE_MS = 2 * 3600_000

/** Logged once per process — see the note on `deliver()`'s own empty-devices line. */
let warnedNoSubsForNewWork = false

function pushSubCount(): number {
  return (db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM push_subs`).get() ?? { n: 0 }).n
}

/** `card_state` says this group is settled — done, abandoned, disowned, or parked. */
function groupSuppressed(state: any): boolean {
  if (!state) return false
  if (state.status === 'done' || state.status === 'wont_do') return true
  if (state.not_mine) return true
  if (state.snoozed_until && state.snoozed_until > now()) return true
  return false
}

/**
 * A visitor waiting on an unresolved Crisp conversation.
 *
 * `who` is the visitor — Crisp cards, like every other card, only fill it in
 * with a *person* waiting on him, and here that person is the customer, not a
 * teammate. Dedup is keyed on the state rather than the poll: the same
 * conversation flipping to unresolved a second time is the same key, so it
 * buzzes once for as long as it stays that one conversation's one unresolved
 * spell — which is deliberate, not an oversight; see the brief.
 */
async function notifyCrisp(row: any): Promise<void> {
  const visitor = row.who || row.actor || 'A visitor'
  await notify(`crisp:${row.source_id}:unresolved`, {
    title: `${CRISP}${visitor} is waiting on Crisp`,
    body: row.title,
    url: cardUrl(row.source, row.group_key),
    kind: 'crisp',
  })
}

/**
 * Somebody named him, in a thread entry that is not his own.
 *
 * Reads `meta.thread` and `meta.parent` exactly as `buildThreadCard` in
 * `sources/slack.ts` writes them — `ThreadEntry[]` with `tagged`/`mine` already
 * decided at ingest time, so this never re-derives "was he named" from display
 * text. One push per entry, each keyed on the entry's own Slack `ts`, so a
 * five-year-old thread that merges into this group today cannot replay its
 * entire history as five pushes: each entry's own age is checked against
 * `NEW_WORK_MAX_AGE_MS`, separately from the card-level check the caller already
 * did, because a thread's `ts` is its *newest* activity and a stale mention can
 * hide behind a fresh reply from somebody else.
 */
async function notifyMentions(row: any, meta: any, at: number): Promise<number> {
  let sent = 0
  const entries: any[] = [
    ...(meta?.parent ? [meta.parent] : []),
    ...(Array.isArray(meta?.thread) ? meta.thread : []),
  ]
  const channel = String(meta?.channel || '').replace(/^#/, '')

  for (const e of entries) {
    if (!e || !e.tagged || e.mine || typeof e.ts !== 'string') continue
    const entryMs = slackTsMs(e.ts)
    if (entryMs === null || at - entryMs > NEW_WORK_MAX_AGE_MS) continue
    if (await notify(`mention:${row.group_key}:${e.ts}`, {
      title: `${MENTION}${e.who} mentioned you in #${channel}`,
      body: e.text,
      url: cardUrl(row.source, row.group_key),
      kind: 'mention',
    })) sent++
  }
  return sent
}

/**
 * A page, not a post. `meta.paged` is decided in `sources/slack.ts`'s `paged()`
 * against `SLACK_USERGROUPS` — his on-call groups being named in the message —
 * which is exactly the line between "someone is on the hook for this" and the
 * routine Datadog/Grafana volume Half A took off the visible desk. Unpaged alert
 * volume never reaches this function's caller with anything to do, and
 * `alert_state === 'recovered'` is checked defensively even though nothing in
 * `slack.ts` emits it today — a recovered transition is filtered out before it
 * becomes a card at all, so this is a second door on a lock that should already
 * be shut.
 *
 * Dedup is the source id alone, forever: the monitor or issue this alert is
 * *about* buzzes once, ever, the first time it pages — a flapping monitor is
 * still one thing, and re-arming that would be the paging fatigue this whole
 * exercise exists to avoid. Its later transitions still land on the desk.
 */
async function notifyPaged(row: any, meta: any): Promise<void> {
  if (!meta?.paged || meta?.alert_state === 'recovered') return
  await notify(`paged:${row.source_id}`, {
    title: `${PAGED}Paged: ${row.title}`,
    url: cardUrl(row.source, row.group_key, row.kind),
    kind: 'paged',
  })
}

/**
 * Fired from `ingest.ts` after its transaction commits, over exactly the card
 * ids that transaction wrote — new rows and re-polled ones alike, since a
 * dedup key is what stops a repoll from buzzing twice, not staying off this list.
 *
 * Four kinds fire, each stated as one rule: an unresolved Crisp conversation, a
 * thread entry that names him, an alert that paged his on-call group, and — the
 * catch-all — a `pile: 'now'` card with a `who` that is none of the above and is
 * brand new this poll. Everything else on the desk, however urgent-looking,
 * stays a card and does not buzz: that restraint is the entire point of this
 * function, not a gap in it.
 *
 * Two guards apply before any of the four: a card older than
 * `NEW_WORK_MAX_AGE_MS` is backlog, not news — the first poll after a deploy or
 * a newly-scoped channel can hand this function two weeks of "new" rows in one
 * batch, and none of that is allowed to become forty buzzes. And a group already
 * `done`, `wont_do`, `not_mine` or snoozed stays quiet: he settled it, and a
 * background poll re-touching the row is not news either.
 */
export async function notifyOnNewWork(report: { at: number; cardIds: string[] }): Promise<void> {
  if (!report.cardIds.length) return

  if (pushSubCount() === 0) {
    if (!warnedNoSubsForNewWork) {
      console.warn('wake: skipping new-work pushes — push_subs is empty, nothing is subscribed')
      warnedNoSubsForNewWork = true
    }
    return
  }

  const ph = report.cardIds.map(() => '?').join(',')
  const rows = db.query<any, any[]>(`SELECT * FROM cards WHERE id IN (${ph})`).all(...report.cardIds)

  for (const row of rows) {
    if (report.at - row.ts > NEW_WORK_MAX_AGE_MS) continue
    const state = db.query<any, [string]>(`SELECT * FROM card_state WHERE group_key = ?`).get(row.group_key)
    if (groupSuppressed(state)) continue

    let meta: any = {}
    try { meta = JSON.parse(row.meta || '{}') } catch { /* treated as no meta */ }

    if (row.source === 'slack' && row.kind === 'crisp' && meta.crisp_state === 'unresolved') {
      await notifyCrisp(row)
      continue
    }
    if (row.source === 'slack' && row.kind === 'mention') {
      // A customer's post in a channel read wholesale is also `kind: 'mention'`
      // (see `allChannelCard`) and names nobody — so a thread with no tagged
      // entry falls through to the desk's own rule below rather than being
      // swallowed here. One that did name him has already buzzed once and must
      // not buzz a second time under a second heading.
      if (await notifyMentions(row, meta, report.at) > 0) continue
    }
    if (row.source === 'slack' && row.kind === 'alert') {
      await notifyPaged(row, meta)
      continue
    }
    // The desk's own urgency, for everything that is none of the three kinds
    // above: a card he has not seen before this poll, sitting in `now`, with a
    // real person waiting on it.
    if (row.pile === 'now' && row.who && row.first_seen_at === report.at) {
      await notify(`now:${row.group_key}`, {
        title: `${NOW_WAITING}${row.who} is waiting: ${row.title}`,
        url: cardUrl(row.source, row.group_key, row.kind),
        kind: 'now',
      })
    }
  }
}

/**
 * A live Claude Code session sitting idle on a turn or a tool call, with nobody
 * looking at it.
 *
 * `sessionsNeedingAttention()` (in `sources/claudeSessions.ts`) answers *what*
 * is idle; this answers *who else is looking*. Two separate refusals, both
 * load-bearing:
 *
 *  - Not in `listTerminals()` at all — Claude Code running in a laptop terminal
 *    he opened himself, outside Wake. He is looking at it; a push saying so
 *    would be Wake telling him about his own screen.
 *  - In `listTerminals()` with `clients > 0` — a browser tab (laptop or phone)
 *    is attached to it right now, which is Wake's own way of saying the same
 *    thing: somebody is already looking.
 *
 * Only a Wake-started session nobody currently has open gets a buzz.
 */
export async function notifySessions(): Promise<void> {
  const attention = sessionsNeedingAttention()
  if (!attention.length) return

  const terminals = new Map(listTerminals().map(t => [t.id, t]))

  for (const s of attention) {
    const term = terminals.get(s.id)
    if (!term || term.clients > 0) continue

    const title = s.reason === 'permission_prompt'
      ? `⌨️ Session is asking permission · ${s.title}`
      : `⌨️ Session finished a turn · ${s.title}`

    await notify(`session:${s.id}:${s.since}`, {
      title,
      url: `${PUBLIC_URL}/terminal/${encodeURIComponent(s.id)}`,
      kind: 'session',
    })
  }
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

/**
 * Fire everything due. Called on a timer; safe to call concurrently.
 *
 * `notifySessions()` rides this same 30s tick rather than getting a timer of
 * its own — a Claude Code session sitting on a finished turn or a permission
 * prompt is exactly the kind of thing a reminder tick already exists to catch,
 * and a second `setInterval` for one more idempotent, dedup-keyed check would
 * only be another place for the two to drift out of step.
 */
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
  await notifySessions()
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
