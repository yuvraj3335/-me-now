import { Hono } from 'hono'
import { db, latestFinishedRuns, logEvent, now, uid } from './db'
import { pile as pileOf } from './dedup'
import { ADAPTERS, ingest } from './ingest'
import { fetchStatus, startFetch, isFetchScope } from './fetch'
import { notify, runReminders, vapidPublicKey } from './push'
import { CARD_PRIORITIES, CARD_STATUSES, type CardPriority, type CardStatus } from './sources/types'
import { readThread } from './sources/slack'
import { sessionExcerpt } from './sources/claudeSessions'
import { getThread } from './mail/service'
import { analytics } from './analytics'
import { connections } from './connections'
import { mail } from './mail/router'
import { voice } from './voice/router'
import { claudecode } from './claudecode/router'
import { settings } from './settings'

export const api = new Hono()

/* ------------------------------- helpers -------------------------------- */

const j = (v: string | null) => { try { return v ? JSON.parse(v) : {} } catch { return {} } }
const bad = (m: string) => ({ error: m })

type Row = Record<string, any>

/**
 * Cards grouped into the dedup unit the UI actually renders.
 *
 * `hidden` asks for the opposite set: the groups whose status took them off the
 * list. Nothing else changes — same grouping, same speaking member, same
 * sources — because a card someone wants back has to be the card they
 * recognise.
 */
function groupedCards(opts: { hidden?: boolean } = {}) {
  const cards = db.query<Row, []>(`SELECT * FROM cards WHERE gone = 0 ORDER BY ts DESC`).all()
  const states = new Map<string, Row>(
    db.query<Row, []>(`SELECT * FROM card_state`).all().map(s => [s.group_key, s]),
  )

  const byGroup = new Map<string, Row[]>()
  for (const c of cards) {
    const arr = byGroup.get(c.group_key)
    arr ? arr.push(c) : byGroup.set(c.group_key, [c])
  }

  // A "now" card explains the group better than an "open" one, so it leads.
  const RANK: Record<string, number> = { now: 0, open: 1, parked: 2 }
  const SOURCE_RANK: Record<string, number> = { slack: 0, github: 1, gmail: 2, sentry: 3, claude: 4 }

  const out: Row[] = []
  for (const [group_key, members] of byGroup) {
    const state = states.get(group_key)
    const sorted = [...members].sort(
      (a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9) || b.ts - a.ts,
    )
    const natural = leadPile(sorted)
    const computed = pileOf({ pile: natural }, state)
    if ((computed === 'hidden') !== !!opts.hidden) continue

    /**
     * The member that produced the pile is the member that gets to explain it.
     *
     * The pile came from `leadPile` — *any* member saying "now" wins — while
     * every displayed field came from `sorted[0]`, ranked by source rather than
     * by pile. So a group holding a Gmail card addressed to him (pile `now`,
     * why "addressed to you, unread") and a GitHub card for his own PR (pile
     * `open`) sat in Now and said "your open pull request": the row was in the
     * right pile for a reason it did not state, and stated a reason that was not
     * why it was there.
     *
     * Within the members that made the claim, `SOURCE_RANK` still decides — that
     * ordering is about which system to believe when two describe one thing, and
     * it is still the right tiebreak. It just no longer overrides the pile.
     */
    const voice = sorted.find(m => m.pile === natural) ?? sorted[0]!

    out.push({
      group_key,
      pile: computed,
      status: statusOf(state),
      priority: (state?.priority ?? PRIORITY_NORMAL) as CardPriority,
      due_at: state?.due_at ?? null,
      title: voice.title,
      why: voice.why,
      actor: voice.actor,
      actor_id: voice.actor_id,
      who: voice.who ?? sorted.find(m => m.who)?.who ?? null,
      excerpt: voice.excerpt,
      url: voice.url,
      kind: voice.kind,
      ts: Math.max(...members.map(m => m.ts)),
      first_seen_at: state?.first_seen_at ?? Math.min(...members.map(m => m.first_seen_at)),
      meta: j(voice.meta),
      sources: sorted.map(m => ({
        source: m.source, kind: m.kind, url: m.url, ts: m.ts, title: m.title,
        actor: m.actor, who: m.who ?? null, account: m.account, why: m.why, meta: j(m.meta),
      })),
      state: state
        ? {
            acked_at: state.acked_at, snoozed_until: state.snoozed_until,
            notified_at: state.notified_at, pinned: !!state.pinned,
            pile_override: state.pile_override,
            done_at: state.done_at, not_mine: !!state.not_mine,
            status: statusOf(state),
            priority: (state.priority ?? PRIORITY_NORMAL) as CardPriority,
            due_at: state.due_at ?? null,
          }
        : null,
      tasks: db.query<Row, [string]>(
        `SELECT id, title, status FROM tasks WHERE source_card_group = ?`,
      ).all(group_key),
    })
  }

  if (opts.hidden) {
    // Most recently taken off the list first: the one someone wants back is
    // almost always the one they just removed.
    //
    // `done_at` alone was not enough once a card could be hidden without one:
    // a `wont_do` has no completion time, so it sorted by upstream recency and
    // a message he dismissed a minute ago landed below one he dismissed last
    // week. `updated_at` is when he last touched the row, which for that card
    // is exactly when he dismissed it.
    const hiddenAt = (r: Row) => {
      const s = states.get(r.group_key)
      return s?.done_at ?? s?.updated_at ?? r.ts
    }
    out.sort((a, b) => hiddenAt(b) - hiddenAt(a))
    return out
  }

  out.sort((a, b) =>
    Number(b.state?.pinned ?? 0) - Number(a.state?.pinned ?? 0) ||
    (RANK[a.pile] ?? 9) - (RANK[b.pile] ?? 9) ||
    b.ts - a.ts,
  )
  return out
}

/**
 * The strongest claim any member makes decides the group's natural pile. Each
 * adapter already decided whether a human is waiting on you, so this trusts that
 * rather than re-deriving it from `kind` and losing the nuance (a Gmail thread
 * addressed to me is "now"; the same thread with me on cc is not).
 */
function leadPile(members: Row[]): 'now' | 'open' | 'parked' {
  return members.some(m => m.pile === 'now') ? 'now' : 'open'
}

const PRIORITY_NORMAL = 2

/**
 * A group's status, from the column that holds it.
 *
 * The right-hand side is reached only for a group with no state row at all —
 * `card_state.status` is NOT NULL with a default — and it derives the two
 * statuses that have a legacy timestamp behind them. `acked_at` is deliberately
 * not consulted: an ack suppressed a notification, it never claimed the work
 * had begun, and reading it as `in_progress` here would make that claim about
 * most of the desk (DECISIONS.md #32).
 */
const statusOf = (s: Row | undefined): CardStatus =>
  (s?.status as CardStatus | undefined) ??
  (s?.not_mine ? 'wont_do' : s?.done_at ? 'done' : 'not_started')

/* -------------------------------- state --------------------------------- */

api.get('/state', async c => {
  const cards = groupedCards()
  return c.json({
    // The flat list the desk renders, already sorted pinned -> pile rank -> ts.
    // The three arrays below are the same rows, split; they are kept for one
    // release so a client that has not moved yet keeps working, and nothing new
    // may read them.
    cards,
    now: cards.filter(x => x.pile === 'now'),
    open: cards.filter(x => x.pile === 'open'),
    parked: cards.filter(x => x.pile === 'parked'),
    tasks: db.query<Row, []>(`SELECT * FROM tasks ORDER BY sort, created_at DESC`).all()
      .map(t => ({ ...t, notes: db.query(`SELECT * FROM notes WHERE task_id = ? ORDER BY sort, created_at`).all(t.id) })),
    goals: db.query<Row, []>(`SELECT * FROM goals WHERE archived = 0 ORDER BY sort, created_at`).all(),
    reminders: db.query<Row, []>(
      `SELECT * FROM reminders WHERE dismissed_at IS NULL ORDER BY fire_at`,
    ).all(),
    notifications: db.query<Row, []>(
      `SELECT * FROM notifications ORDER BY created_at DESC LIMIT 30`,
    ).all(),
    // Finished runs only. A row is inserted when a poll STARTS, with ok = NULL,
    // so including in-flight runs made every source read as failed for the
    // duration of each poll — the Home page's sync line said "needs connect"
    // about a source that was answering fine.
    // Fetch writes `fetch:<connector>` rows so that "asked, answered, nothing"
    // and "asked, did not answer" are different states there too. They are not
    // sources, and a filter chip named `fetch:slack` is not a thing.
    lastSync: latestFinishedRuns(),
    serverTime: now(),
  })
})

api.post('/refresh', async c => c.json(await ingest()))

/**
 * Fetch — pipe 2.
 *
 * Runs pipe 1 first, then asks every connector this box can reach the two
 * standing questions, and lands what comes back on the same desk. It only ever
 * adds, so nothing on the page is blocked while it runs, and a second press is
 * neither refused nor rate-limited: it re-runs, dedups, and answers `0 new`.
 */
/**
 * Collect now, optionally from one source only.
 *
 * `only` is validated against the scope list rather than passed through: it
 * reaches `ingest()` and picks connectors, and a free string there would be a
 * quiet no-op run reporting success over nothing asked.
 */
api.post('/fetch', async c => {
  const { only } = await c.req.json<{ only?: unknown }>().catch(() => ({ only: undefined }))
  if (only != null && !isFetchScope(only)) return c.json(bad('unknown source'), 400)
  return c.json(startFetch(only ?? undefined))
})

/**
 * What the last press did, and whether one is still going.
 *
 * Fetch starts and answers; the browser asks again. Holding an HTTP request
 * open for the 40–60 seconds a collection through the box takes is a way to
 * lose it — measured, the socket closed at exactly 60s while the run finished
 * and landed its rows, so the page reported a failure that had not happened.
 */
api.get('/fetch', c => c.json(fetchStatus()))

/* -------------------------------- cards --------------------------------- */

/**
 * The fields an undoable action is allowed to have replaced.
 *
 * All of them, not the one the action is named after. `Later` writes
 * `snoozed_until` *and* `pile_override = null`; its undo cleared only the first,
 * so undoing a snooze on a card that had been deliberately parked put it in Open
 * and destroyed a park the product had no other way to re-create. An undo that
 * does less than the action it undoes is not an undo.
 *
 * `priority` is the one field held back. No undoable action writes it, so
 * snapshotting it would only give an undo a way to clobber a value the action
 * it is undoing never touched.
 */
const UNDOABLE = [
  'pile_override', 'snoozed_until', 'acked_at', 'done_at', 'not_mine', 'status', 'due_at',
] as const

/**
 * Apply a patch to a card's state.
 *
 * `undoAs` records what the patch is about to replace, under the label the undo
 * bar will send back. One record per group: only the most recent action is
 * undoable, which is what the toast offers and all it ever offered.
 */
function touchState(group: string, patch: Record<string, unknown>, undoAs?: string) {
  db.query(
    `INSERT INTO card_state (group_key, first_seen_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(group_key) DO NOTHING`,
  ).run(group, now(), now())

  const full: Record<string, unknown> = { ...patch }
  if (undoAs) {
    const before = db.query<Row, [string]>(
      `SELECT ${UNDOABLE.join(', ')} FROM card_state WHERE group_key = ?`,
    ).get(group)
    full.undo_json = JSON.stringify({ action: undoAs, at: now(), fields: before ?? {} })
  }

  const keys = Object.keys(full)
  if (!keys.length) return
  db.query(
    `UPDATE card_state SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE group_key = ?`,
  ).run(...keys.map(k => full[k] as any), now(), group)
}

const stateRow = (group: string) =>
  db.query<Row, [string]>(`SELECT * FROM card_state WHERE group_key = ?`).get(group) ?? undefined

/**
 * The events Pulse is made of, emitted from the one place status changes.
 *
 * `card_done`, `card_not_mine` and `card_acked` are the vocabulary
 * `src/server/analytics.ts` reads — the Cleared chart, both response-time
 * percentiles, both heatmaps and the streak are all counts of those three
 * kinds. Status is a column now, and a column is not a history: stop emitting
 * these and every one of those goes quietly empty with no failing test.
 *
 * `card_status` is the new one, and it carries both ends of the move so a later
 * reader can tell "started it" from "sent it back".
 */
function logStatusChange(group: string, from: CardStatus, to: CardStatus) {
  if (from === to) return
  if (to === 'done') logEvent('card_done', { group_key: group })
  if (to === 'wont_do') logEvent('card_not_mine', { group_key: group })
  if (to === 'in_progress' && from === 'not_started') logEvent('card_acked', { group_key: group })
  logEvent('card_status', { group_key: group, meta: { from, to } })
}

/**
 * Move a card to a status, and keep the derived timestamps in step.
 *
 * `done_at` and `not_mine` are no longer the truth — `status` is — but they are
 * still read by `pile()`, by the hidden-list sort, and by every `undo_json`
 * written before this shipped, so they are maintained rather than abandoned
 * (DECISIONS.md #32). Writing them here, in one place, is what stops the two
 * from drifting apart.
 *
 * `done_at` is cleared on any move away from `done`: a card that is in review
 * has no completion time, and leaving the old one behind would put it back at
 * the top of the hidden list it is no longer on.
 */
function setStatus(group: string, next: CardStatus, undoAs?: string): CardStatus {
  const from = statusOf(stateRow(group))
  touchState(group, {
    status: next,
    done_at: next === 'done' ? now() : null,
    not_mine: next === 'wont_do' ? 1 : 0,
  }, undoAs)
  logStatusChange(group, from, next)
  return from
}

/**
 * Acknowledge: I have seen this, stop telling me about it.
 *
 * It promotes a card that had not been started, and only that one. An ack on
 * something already in review must not demote it — the ack is about the
 * notification, and the status is about the work.
 */
api.post('/cards/:group/ack', c => {
  const g = decodeURIComponent(c.req.param('group'))
  const from = statusOf(stateRow(g))
  const to: CardStatus = from === 'not_started' ? 'in_progress' : from
  touchState(g, to === from ? { acked_at: now() } : { acked_at: now(), status: to })
  logEvent('card_acked', { group_key: g })
  if (to !== from) logEvent('card_status', { group_key: g, meta: { from, to } })
  return c.json({ ok: true })
})

/**
 * Where the work stands. The one route the desk's Status control talks to; the
 * verbs below are wrappers over it that keep their own URLs and undo labels.
 */
api.post('/cards/:group/status', async c => {
  const g = decodeURIComponent(c.req.param('group'))
  const { status } = await c.req.json<{ status?: string }>().catch(() => ({ status: undefined }))
  if (!CARD_STATUSES.includes(status as CardStatus)) return c.json(bad('bad status'), 400)
  setStatus(g, status as CardStatus, 'status')
  return c.json({ ok: true })
})

/** 0 urgent · 1 high · 2 normal · 3 low. Not undoable: nothing else writes it. */
api.post('/cards/:group/priority', async c => {
  const g = decodeURIComponent(c.req.param('group'))
  const { priority } = await c.req.json<{ priority?: number }>().catch(() => ({ priority: undefined }))
  if (!CARD_PRIORITIES.includes(priority as CardPriority)) return c.json(bad('bad priority'), 400)
  touchState(g, { priority })
  return c.json({ ok: true })
})

/**
 * When it is due, or `null` to clear it.
 *
 * A date in the past is accepted, deliberately. `/reminders` refuses one
 * because a reminder for the past fires instantly into nothing, but an overdue
 * due date is the entire point of the field: it is a statement about when the
 * work was wanted, not an instruction to buzz a phone.
 */
api.post('/cards/:group/due', async c => {
  const g = decodeURIComponent(c.req.param('group'))
  const { at } = await c.req.json<{ at?: number | null }>().catch(() => ({ at: undefined }))
  if (at !== null && !Number.isFinite(at)) return c.json(bad('at must be a timestamp or null'), 400)
  touchState(g, { due_at: at === null ? null : Math.trunc(at as number) })
  return c.json({ ok: true })
})

api.post('/cards/:group/snooze', async c => {
  const g = decodeURIComponent(c.req.param('group'))
  const { until } = await c.req.json<{ until: number }>()
  if (!until || until < now()) return c.json(bad('until must be in the future'), 400)
  touchState(g, { snoozed_until: until, pile_override: null }, 'snoozed')
  logEvent('card_snoozed', { group_key: g, meta: { until } })
  return c.json({ ok: true })
})

api.post('/cards/:group/pile', async c => {
  const g = decodeURIComponent(c.req.param('group'))
  const { pile } = await c.req.json<{ pile: string | null }>()
  if (pile && !['now', 'open', 'parked'].includes(pile)) return c.json(bad('bad pile'), 400)
  touchState(g, { pile_override: pile, snoozed_until: null }, 'moved')
  logEvent('card_moved', { group_key: g, meta: { pile } })
  return c.json({ ok: true })
})

/** The wire name predates the vocabulary; the status it sets is `wont_do`. */
api.post('/cards/:group/not-mine', c => {
  const g = decodeURIComponent(c.req.param('group'))
  setStatus(g, 'wont_do', 'not_mine')
  return c.json({ ok: true })
})

api.post('/cards/:group/done', c => {
  const g = decodeURIComponent(c.req.param('group'))
  setStatus(g, 'done', 'done')
  return c.json({ ok: true })
})

api.post('/cards/:group/pin', async c => {
  const g = decodeURIComponent(c.req.param('group'))
  const { pinned } = await c.req.json<{ pinned: boolean }>()
  touchState(g, { pinned: pinned ? 1 : 0 })
  return c.json({ ok: true })
})

/**
 * Put a card back on the list.
 *
 * With no body this clears everything that could be keeping it off one, which
 * is what "bring this back" means when someone picks it out of a list of things
 * they have hidden.
 *
 * `{ undo: 'done' | 'snoozed' | 'not_mine' | 'moved' | 'status' }` clears
 * exactly one, which is what the undo bar needs: undoing a Done must not also
 * un-park a card that was parked before the Done, or drop a manual pile someone
 * chose an hour ago. An undo that does more than the thing it is undoing is its
 * own small surprise.
 *
 * Each entry below is the *patch* that undoes its action with no memory of what
 * came before, not a single field name: undoing a Done has to clear `done_at`
 * and put the status back, because those are two halves of one write.
 */
const UNDO_FIELD: Record<string, Record<string, unknown>> = {
  done:     { done_at: null, status: 'not_started' },
  not_mine: { not_mine: 0, status: 'not_started' },
  snoozed:  { snoozed_until: null },
  moved:    { pile_override: null },
  status:   { status: 'not_started' },
}

api.post('/cards/:group/restore', async c => {
  const g = decodeURIComponent(c.req.param('group'))
  const body: { undo?: string } =
    await c.req.json<{ undo?: string }>().catch(() => ({}))
  const undo = body.undo
  const patch = undo ? UNDO_FIELD[undo] : undefined
  if (undo && !patch) return c.json(bad('unknown undo target'), 400)

  if (!undo) {
    // "Bring this back" from the restore list: clear everything keeping it off
    // a pile, and forget the undo record along with it. `due_at` is left alone
    // on purpose — a due date is his, not the action's.
    touchState(g, {
      not_mine: 0, done_at: null, snoozed_until: null, pile_override: null,
      status: 'not_started', undo_json: null,
    })
    logEvent('card_restored', { group_key: g, meta: { undo: 'all' } })
    return c.json({ ok: true })
  }

  const row = db.query<Row, [string]>(`SELECT undo_json FROM card_state WHERE group_key = ?`).get(g)
  const rec = row?.undo_json ? j(row.undo_json) : null

  if (rec?.action === undo && rec.fields && typeof rec.fields === 'object') {
    // Put back exactly what that action replaced — every field, not the one the
    // action was named after — and spend the record so a second undo cannot
    // rewind past it into a state nobody chose.
    const restore: Record<string, unknown> = { undo_json: null }
    for (const k of UNDOABLE) restore[k] = (rec.fields as Row)[k] ?? null
    restore.not_mine = (rec.fields as Row).not_mine ? 1 : 0
    // A record written before `status` existed has no key for it, and the loop
    // above would then write NULL into a NOT NULL column — a constraint failure
    // inside a route with no catch, which is a 500 on the Undo button.
    restore.status = (rec.fields as Row).status ?? 'not_started'
    touchState(g, restore)
    logEvent('card_restored', { group_key: g, meta: { undo, exact: true } })
    return c.json({ ok: true })
  }

  // No record — a card acted on before this shipped, or an undo of an undo.
  // Clearing what that action set is the old behaviour, and it is still the
  // safest thing to do with no memory of what came before.
  touchState(g, { ...patch!, undo_json: null })
  logEvent('card_restored', { group_key: g, meta: { undo, exact: false } })
  return c.json({ ok: true })
})

/**
 * What Done and Not-mine took away.
 *
 * Done is one unconfirmed keystroke, and until this existed there was no route
 * back to a card it removed: the sheet is unreachable once the card is off
 * every pile, and a re-sync does not undo it — the suppression is state, not a
 * missing card. `POST /cards/:group/restore` was always here; this is the list
 * that makes it findable.
 */
api.get('/cards/done', c => {
  const limit = Math.min(Number(c.req.query('limit') ?? 40) || 40, 200)
  return c.json({ cards: groupedCards({ hidden: true }).slice(0, limit) })
})

/**
 * A card's own body, per kind, read on demand.
 *
 * A detail pane is for facts, and two of these were already built and simply
 * had no route to reach them: `sessionExcerpt` reads a Claude transcript's last
 * exchanges and was exported with zero callers, and `getThread` already returns
 * a full sanitized Gmail thread that the card knows the account and thread id
 * for. Neither costs a byte of new ingest — they are reads of things Wake can
 * already see, at the moment somebody actually asks.
 */

/** Slack threads are read on demand rather than on every poll. */
api.get('/cards/:group/thread', async c => {
  const g = decodeURIComponent(c.req.param('group'))
  const row = db.query<Row, [string]>(
    `SELECT meta FROM cards WHERE group_key = ? AND source = 'slack' AND gone = 0 ORDER BY ts DESC LIMIT 1`,
  ).get(g)
  if (!row) return c.json(bad('no slack message in this group'), 404)
  const meta = j(row.meta)
  try {
    return c.json({ thread: await readThread(meta.channel_id, meta.thread_ts) })
  } catch (e) {
    return c.json(bad((e as Error).message), 502)
  }
})

/** The last exchanges of the Claude Code session in this group. */
api.get('/cards/:group/session', c => {
  const g = decodeURIComponent(c.req.param('group'))
  const row = db.query<Row, [string]>(
    `SELECT meta FROM cards WHERE group_key = ? AND source = 'claude' AND gone = 0 ORDER BY ts DESC LIMIT 1`,
  ).get(g)
  if (!row) return c.json(bad('no Claude Code session in this group'), 404)
  const id = j(row.meta).session_id
  if (typeof id !== 'string') return c.json(bad('this session recorded no id'), 404)

  // Capped well under the hand-off budget: this is a preview in a 400px pane,
  // not the transcript.
  const r = sessionExcerpt(id, 4_000)
  if (!r.found) return c.json(bad('that transcript is no longer on this machine'), 404)
  return c.json({ session: { id, cwd: r.cwd ?? null, text: r.text ?? '' } })
})

/** The Gmail thread this card is about, sanitized, from the account it arrived on. */
api.get('/cards/:group/mail', async c => {
  const g = decodeURIComponent(c.req.param('group'))
  const row = db.query<Row, [string]>(
    `SELECT account, meta FROM cards WHERE group_key = ? AND source = 'gmail' AND gone = 0 ORDER BY ts DESC LIMIT 1`,
  ).get(g)
  if (!row) return c.json(bad('no mail in this group'), 404)
  const meta = j(row.meta)
  const account = row.account ?? meta.account
  const threadId = meta.thread_id
  if (!account || !threadId) return c.json(bad('this card names no mail thread'), 404)
  try {
    const t = await getThread(String(account), String(threadId))
    return c.json(t)
  } catch (e) {
    return c.json(bad((e as Error).message), 502)
  }
})

/* -------------------------------- tasks --------------------------------- */

/**
 * A task freezes its provenance at creation.
 *
 * `source_card_group` is a pointer into `cards`, and `ingest.ts` marks a card
 * gone the moment its source stops returning it — so "from GitHub" disappeared
 * from a task exactly when the pull request merged, which is when remembering
 * what the task was about matters most. The `origin_*` columns are a copy, not a
 * reference, and they are written once and never updated: a task is a durable
 * object, a card is a view of somebody else's system.
 */
const ORIGIN_FIELDS = ['origin_source', 'origin_title', 'origin_why', 'origin_url', 'origin_excerpt', 'origin_meta'] as const

api.post('/tasks', async c => {
  const b = await c.req.json<Row>()
  if (!b.title?.trim()) return c.json(bad('title required'), 400)
  const id = uid()
  db.query(
    `INSERT INTO tasks (id, title, detail, status, goal_id, source_card_group, due_at, color, sort,
                        created_at, updated_at, ${ORIGIN_FIELDS.join(', ')})
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, b.title.trim(), b.detail ?? null, b.status ?? 'todo', b.goal_id ?? null,
    b.source_card_group ?? null, b.due_at ?? null, b.color ?? null,
    b.sort ?? -now(), now(), now(),
    b.origin_source ?? null, b.origin_title ?? null, b.origin_why ?? null,
    b.origin_url ?? null,
    // Clipped here rather than trusted: it is provider text on its way into a
    // row that outlives the card it came from.
    typeof b.origin_excerpt === 'string' ? b.origin_excerpt.slice(0, 600) : null,
    b.origin_meta ? JSON.stringify(b.origin_meta).slice(0, 2_000) : null,
  )
  logEvent('task_created', { task_id: id, group_key: b.source_card_group ?? null })
  return c.json(db.query(`SELECT * FROM tasks WHERE id = ?`).get(id))
})

const TASK_FIELDS = ['title', 'detail', 'status', 'goal_id', 'source_card_group', 'due_at', 'color', 'sort']

api.patch('/tasks/:id', async c => {
  const id = c.req.param('id')
  const b = await c.req.json<Row>()
  const prev = db.query<Row, [string]>(`SELECT * FROM tasks WHERE id = ?`).get(id)
  if (!prev) return c.json(bad('not found'), 404)

  const keys = TASK_FIELDS.filter(k => k in b)
  const extra: Row = {}
  if (b.status && b.status !== prev.status) {
    if (b.status === 'done') extra.completed_at = now()
    if (b.status === 'doing' && !prev.started_at) extra.started_at = now()
    if (b.status !== 'done') extra.completed_at = null
  }
  const sets = [...keys, ...Object.keys(extra)]
  if (sets.length) {
    db.query(`UPDATE tasks SET ${sets.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map(k => b[k]), ...Object.values(extra), now(), id)
  }
  if (b.status && b.status !== prev.status) {
    logEvent(b.status === 'done' ? 'task_done' : `task_${b.status}`, { task_id: id })
  }
  return c.json(db.query(`SELECT * FROM tasks WHERE id = ?`).get(id))
})

api.delete('/tasks/:id', c => {
  db.query(`DELETE FROM tasks WHERE id = ?`).run(c.req.param('id'))
  db.query(`DELETE FROM reminders WHERE target_kind = 'task' AND target_id = ?`).run(c.req.param('id'))
  return c.json({ ok: true })
})

/* -------------------------------- notes --------------------------------- */

api.post('/notes', async c => {
  const b = await c.req.json<Row>()
  if (!b.body?.trim()) return c.json(bad('body required'), 400)
  const id = uid()
  db.query(`INSERT INTO notes (id, task_id, goal_id, body, color, sort, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, b.task_id ?? null, b.goal_id ?? null, b.body, b.color ?? null, b.sort ?? -now(), now(), now())
  return c.json(db.query(`SELECT * FROM notes WHERE id = ?`).get(id))
})

api.patch('/notes/:id', async c => {
  const b = await c.req.json<Row>()
  const keys = ['body', 'color', 'sort', 'task_id', 'goal_id'].filter(k => k in b)
  if (keys.length) {
    db.query(`UPDATE notes SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map(k => b[k]), now(), c.req.param('id'))
  }
  return c.json(db.query(`SELECT * FROM notes WHERE id = ?`).get(c.req.param('id')))
})

api.delete('/notes/:id', c => {
  db.query(`DELETE FROM notes WHERE id = ?`).run(c.req.param('id'))
  return c.json({ ok: true })
})

/* -------------------------------- goals --------------------------------- */

api.post('/goals', async c => {
  const b = await c.req.json<Row>()
  if (!b.title?.trim()) return c.json(bad('title required'), 400)
  const id = uid()
  db.query(`INSERT INTO goals (id, title, detail, color, target_date, sort, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, b.title.trim(), b.detail ?? null, b.color ?? null, b.target_date ?? null, b.sort ?? -now(), now(), now())
  logEvent('goal_created', { meta: { id } })
  return c.json(db.query(`SELECT * FROM goals WHERE id = ?`).get(id))
})

api.patch('/goals/:id', async c => {
  const b = await c.req.json<Row>()
  const keys = ['title', 'detail', 'color', 'target_date', 'archived', 'sort'].filter(k => k in b)
  const extra: Row = {}
  if ('completed' in b) extra.completed_at = b.completed ? now() : null
  const sets = [...keys, ...Object.keys(extra)]
  if (sets.length) {
    db.query(`UPDATE goals SET ${sets.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map(k => b[k]), ...Object.values(extra), now(), c.req.param('id'))
  }
  return c.json(db.query(`SELECT * FROM goals WHERE id = ?`).get(c.req.param('id')))
})

api.delete('/goals/:id', c => {
  db.query(`DELETE FROM goals WHERE id = ?`).run(c.req.param('id'))
  return c.json({ ok: true })
})

/* ------------------------------ reminders ------------------------------- */

api.post('/reminders', async c => {
  const b = await c.req.json<Row>()
  if (!b.target_kind || !b.target_id || !b.fire_at) return c.json(bad('target_kind, target_id, fire_at required'), 400)
  /**
   * A reminder in the past is refused here, not accepted and fired instantly.
   *
   * This validated presence only, and `runReminders()` fires on `fire_at <=
   * now()`. Measured: `created_at 1788075717452`, `fired_at 1788075718465` — one
   * second later. The Work row filters on `!fired_at` so no bell appeared, and
   * reopening the task showed an empty field. Nobody was told anything.
   *
   * A minute of slack, because a form submitted at 09:00:00 for 09:00 is asking
   * for now rather than for the past.
   */
  if (Number(b.fire_at) <= now() - 60_000) {
    return c.json(bad('fire_at is in the past; a reminder can only be set for the future'), 400)
  }
  const id = uid()
  try {
    db.query(`INSERT INTO reminders (id, target_kind, target_id, fire_at, label, repeat_rule, created_at)
              VALUES (?,?,?,?,?,?,?)`)
      .run(id, b.target_kind, b.target_id, b.fire_at, b.label ?? null, b.repeat_rule ?? null, now())
  } catch {
    // The partial UNIQUE index refuses a second live reminder on one target.
    // Treat that as "move the existing one" rather than as an error.
    db.query(
      `UPDATE reminders SET fire_at = ?, label = ?, repeat_rule = ?
       WHERE target_kind = ? AND target_id = ? AND fired_at IS NULL AND dismissed_at IS NULL`,
    ).run(b.fire_at, b.label ?? null, b.repeat_rule ?? null, b.target_kind, b.target_id)
    // Same predicate as the UPDATE above: without `dismissed_at IS NULL` this
    // could read back a dismissed reminder and report it as the live one.
    const moved = db.query<Row, [string, string]>(
      `SELECT * FROM reminders
        WHERE target_kind = ? AND target_id = ? AND fired_at IS NULL AND dismissed_at IS NULL`,
    ).get(b.target_kind, b.target_id)
    if (!moved) return c.json(bad('could not create that reminder'), 400)
    return c.json({ ...moved, moved: true })
  }
  logEvent('reminder_set', { task_id: b.target_kind === 'task' ? b.target_id : null })
  return c.json(db.query(`SELECT * FROM reminders WHERE id = ?`).get(id))
})

api.delete('/reminders/:id', c => {
  db.query(`UPDATE reminders SET dismissed_at = ? WHERE id = ?`).run(now(), c.req.param('id'))
  return c.json({ ok: true })
})

/* --------------------------------- push --------------------------------- */

api.get('/push/key', c => c.json({ key: vapidPublicKey() }))

api.post('/push/subscribe', async c => {
  const b = await c.req.json<any>()
  const { endpoint, keys } = b?.subscription ?? b
  if (!endpoint || !keys?.p256dh || !keys?.auth) return c.json(bad('bad subscription'), 400)
  db.query(
    `INSERT INTO push_subs (endpoint, p256dh, auth, ua, label, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, fail_count = 0`,
  ).run(endpoint, keys.p256dh, keys.auth, c.req.header('user-agent') ?? null, b.label ?? null, now())
  return c.json({ ok: true })
})

api.post('/push/unsubscribe', async c => {
  const { endpoint } = await c.req.json<{ endpoint: string }>()
  db.query(`DELETE FROM push_subs WHERE endpoint = ?`).run(endpoint)
  return c.json({ ok: true })
})

api.post('/push/test', async c => {
  const sent = await notify(`test:${now()}`, {
    title: 'Wake',
    body: 'Notifications are working.',
    kind: 'test',
  })
  const devices = db.query<Row, []>(`SELECT COUNT(*) AS n FROM push_subs`).get()!.n
  return c.json({ sent, devices })
})

api.get('/push/status', c =>
  c.json({
    devices: db.query<Row, []>(`SELECT endpoint, ua, label, created_at, last_ok_at FROM push_subs`).all(),
  }),
)

api.post('/reminders/tick', async c => { await runReminders(); return c.json({ ok: true }) })

/**
 * Mark a notification read.
 *
 * `notifications` rows were written by every fired reminder and rendered by
 * nothing: `grep -rn notifications src/web/` found no component that displayed
 * one. A reminder that reaches zero devices and then appears nowhere in the
 * product has not been delivered, it has been discarded. Work shows them now,
 * and this is how one leaves.
 */
api.post('/notifications/:id/read', c => {
  db.query(`UPDATE notifications SET read_at = ? WHERE id = ?`).run(now(), c.req.param('id'))
  return c.json({ ok: true })
})

/* ------------------------------ sub-routers ----------------------------- */

api.route('/analytics', analytics)
api.route('/connections', connections)
api.route('/mail', mail)
api.route('/voice', voice)
api.route('/claude', claudecode)
api.route('/settings', settings)

api.get('/sources', async c =>
  c.json(await Promise.all(ADAPTERS.map(async a => ({
    name: a.name, label: a.label, ...(await a.status()),
  })))),
)
