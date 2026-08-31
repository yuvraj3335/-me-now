import { Hono } from 'hono'
import { db, isTaskStatus, latestFinishedRuns, logEvent, now, taskStatus, uid } from './db'
import { pile as pileOf } from './dedup'
import { ADAPTERS, ingest } from './ingest'
import { fetchStatus, startFetch, isFetchScope } from './fetch'
import { notify, runReminders, vapidPublicKey } from './push'
import { CARD_PRIORITIES, CARD_STATUSES, type CardPriority, type CardStatus } from './sources/types'
import { readThread, slackTsToMs } from './sources/slack'
import {
  isDmChannel, itemFromEntry, parseSlackLink, slackAppLink,
  type SlackThreadItem, type StoredThreadEntry,
} from '../shared/slackThread'
import { SLACK_TEAM_ID } from './env'
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

/** An epoch a client sent, or null. A timestamp that is not a number is not one. */
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

type Row = Record<string, any>

/* -------------------------------- activity ------------------------------- */

/**
 * What has landed on a thing since he last looked at it.
 *
 * One rule, computed here and nowhere else, because the badge and the highlight
 * are the same fact: `+N` renders iff `count > 0` and a row is marked iff
 * `count > 0`, so `+2` and the amber edge can never disagree about how much is
 * new. A second implementation in the browser is how they would.
 */
export type Activity = {
  /** Messages on this thing newer than the baseline, excluding his own. */
  count: number
  /** He was named in one of them. */
  tagged: boolean
  /** When the newest of them landed. */
  at: number | null
}

/** One thing that happened, from whichever member of the group carries it. */
type Event = { at: number; tagged: boolean; mine: boolean }

/**
 * Slack stamps a ts string ("1787812499.720579"); Gmail stamps epoch ms. Both
 * answer in ms, because the desk has one clock.
 */
function eventMs(ts: unknown): number | null {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null
  if (typeof ts !== 'string' || !/^\d+(\.\d+)?$/.test(ts)) return null
  return ts.includes('.') ? slackTsToMs(ts) : Number(ts)
}

/**
 * Everything that happened on a group, from every member of it.
 *
 * Three sources of events, and the union really is a union: a Slack card's own
 * `ts` is its newest message, which is also an entry in `meta.thread`, and
 * counting both would double every fresh reply. So events are keyed by *when*,
 * and one marked as his own wins the key — a card timestamp carries no author,
 * and "he replied at 14:32" must not become "something arrived at 14:32".
 *
 * Two things bound what a member is allowed to contribute, and both of them are
 * the same sentence said twice: **nothing a card brought with it when it arrived
 * is something he has missed.**
 *
 *   * A member's own history counts only from the moment *that member* landed,
 *     not from the moment the group did. A Slack thread that merges into a pull
 *     request's group inherits a `first_seen_at` from weeks ago, and without
 *     this every one of its twelve replies counted at once, in a single poll,
 *     for a conversation he had never been shown.
 *   * A member's own `ts` is an event only on the poll it *arrived* on. It is
 *     there to say "a second source landed on this", and a landing happens once.
 *     Left ungated it also fired every time a timestamp merely moved forward —
 *     and a Claude session's `ts` is the transcript's mtime and a `author:me`
 *     pull request's is its `updated_at`, so his own work came back to him as an
 *     amber edge and a `+1` reading "new since you last looked".
 */
function eventsOf(members: Row[], baseline: number): Event[] {
  const byAt = new Map<number, Event>()
  const add = (e: Event) => {
    const prev = byAt.get(e.at)
    if (!prev) { byAt.set(e.at, e); return }
    byAt.set(e.at, { at: e.at, tagged: prev.tagged || e.tagged, mine: prev.mine || e.mine })
  }

  for (const m of members) {
    const arrived = typeof m.first_seen_at === 'number' ? m.first_seen_at : baseline
    /*
     * A second source landing on a thing already on the desk is activity too.
     *
     * Stamped at the member's own `ts` while that is newer than the baseline,
     * because that timestamp is usually also an entry in the member's `thread`
     * and the two must collapse to one event rather than count the same reply
     * twice. When it is older, the landing is stamped at the moment it *landed*
     * instead — `activityOf` drops everything at or before the baseline, so a
     * Sentry issue whose `ts` is a last-seen from two days ago merged into
     * today's Slack thread contributed nothing at all: no `+1`, no amber edge,
     * and nothing anywhere saying a second system now points at that row.
     */
    if (arrived > baseline) add({ at: m.ts > baseline ? m.ts : arrived, tagged: false, mine: false })

    const since = Math.max(baseline, arrived)
    const meta = j(m.meta)
    for (const key of ['thread', 'messages'] as const) {
      const list = meta[key]
      if (!Array.isArray(list)) continue
      for (const e of list) {
        const at = eventMs(e?.ts)
        if (at === null || at <= since) continue
        add({ at, tagged: !!e?.tagged, mine: !!e?.mine })
      }
    }
  }
  return [...byAt.values()]
}

/**
 * The baseline is when he last acknowledged this, or when it first appeared —
 * so a thread that already had ten replies on it the moment it arrived is not
 * ten things he has missed.
 */
function activityOf(members: Row[], baseline: number): Activity {
  const fresh = eventsOf(members, baseline).filter(e => !e.mine && e.at > baseline)
  return {
    count: fresh.length,
    tagged: fresh.some(e => e.tagged),
    at: fresh.length ? Math.max(...fresh.map(e => e.at)) : null,
  }
}

/* -------------------------------- recency -------------------------------- */

/**
 * When this row last had something happen on it. The desk's one sort key.
 *
 * The order rows appear in used to be an emergent property of five adapters
 * that each decided `ts` for their own reasons, and those reasons are not the
 * same reason: a Slack thread's `ts` is its newest message, a Sentry issue's is
 * a last-seen, a Claude session's is a transcript's mtime, a GitHub row's is an
 * `updated_at`. Four of those move when new work lands and one of them does not
 * always, and there was nowhere to point at and say what the sort *means*. This
 * is that place, and it is deliberately not "trust each source's `ts`": it is
 * the union of `ts` with the per-message facts the card already carries, so a
 * source whose own stamp lags cannot silently hold a row down.
 *
 * It is the same set of facts `eventsOf` walks, minus the baseline clamp and the
 * mine/tagged filter — which is the property worth having. "How much is new" and
 * "when did it last happen" are two questions about one pile of events, and
 * answering them from two different piles is how a row shows `+3` while sitting
 * eleventh.
 *
 * What feeds it, per source:
 *
 *   * **Slack thread** — the card's `ts` (already the newest of parent, replies
 *     and search hits), every `meta.thread[].ts`, and `meta.last_reply_at`.
 *   * **Slack alert** — the card's `ts` (its newest member) and every
 *     `meta.thread[].ts`, which for a folded row includes the human replies
 *     `foldThreadIntoAlert` merged in.
 *   * **Gmail** — the card's `ts` (now the newest of the thread stamp and every
 *     message) and every `meta.messages[].ts`.
 *   * **GitHub** — the card's `ts`, which is the issue or pull request's
 *     `updated_at`, and that moves on a comment, a push and a review.
 *   * **Sentry** — the card's `ts`, which is `lastSeen`, so a new event on the
 *     short id moves it. A *comment* has no instant anywhere in what the MCP
 *     server answers with; on this deployment one arrives as a `#sentry-alerts`
 *     message, which merges into this group on the shared `sentry:` reference
 *     and moves the row through its Slack member instead.
 *   * **Claude Code** — the card's `ts` (the transcript's mtime, so a new turn
 *     moves it) and `meta.live_at`, which is when the session became live. An
 *     mtime alone cannot express "he came back to this and it is open now",
 *     because a finished session satisfies a recent mtime just as well.
 *
 * A member contributes; it never subtracts. `Math.max` over an empty group is
 * `-Infinity`, so the seed is 0 — a group with no readable timestamp anywhere
 * sorts last rather than before the epoch.
 */
function memberActivityAt(m: Row): number {
  let at = typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : 0
  const meta = j(m.meta)

  // The per-message lists, in the two spellings the adapters use. `eventMs`
  // reads a Slack ts string and a Gmail epoch alike, which is the whole reason
  // the desk has one clock.
  for (const key of ['thread', 'messages'] as const) {
    const list = meta[key]
    if (!Array.isArray(list)) continue
    for (const e of list) {
      const t = eventMs(e?.ts)
      if (t !== null && t > at) at = t
    }
  }

  // And the two facts a source states directly rather than as a message.
  for (const key of ['last_reply_at', 'live_at'] as const) {
    const t = eventMs(meta[key])
    if (t !== null && t > at) at = t
  }
  return at
}

/** The newest activity across every member of a group. */
export const activityAt = (members: Row[]): number =>
  Math.max(0, ...members.map(memberActivityAt))

/**
 * Cards grouped into the dedup unit the UI actually renders.
 *
 * `hidden` asks for the opposite set: the groups whose status took them off the
 * list. Nothing else changes — same grouping, same speaking member, same
 * sources — because a card someone wants back has to be the card they
 * recognise.
 */
function groupedCards(opts: { hidden?: boolean } = {}) {
  // The query's order decides nothing a reader sees: members are re-sorted by
  // source below to pick the one that speaks, and the list itself is ordered at
  // the bottom of this function by `activity_at`. It is `ts DESC` so that the
  // newest member of a group is the first one seen, which keeps the tie-breaks
  // inside `sorted` deterministic.
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
    const firstSeen = state?.first_seen_at ?? Math.min(...members.map(m => m.first_seen_at))
    const at = activityAt(members)

    out.push({
      group_key,
      pile: computed,
      status: statusOf(state),
      activity: activityOf(members, state?.acked_at ?? firstSeen),
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
      /*
       * One number, read twice.
       *
       * `ts` was `max(member.ts)` and `activity_at` is that same maximum unioned
       * with the per-message facts on the members, so it is never earlier — it
       * only ever moves forward onto an event that really happened. Emitting
       * both and letting them differ would put a row at the top of the list
       * while the age beside it said three days, with nothing on screen to
       * explain the gap. `activity_at` is the name the sort reads and the name
       * to write new code against; `ts` stays because half the product already
       * says `card.ts` and none of it should have to change to get the right
       * answer.
       */
      ts: at,
      activity_at: at,
      first_seen_at: firstSeen,
      meta: j(voice.meta),
      sources: sorted.map(m => ({
        source: m.source, kind: m.kind, url: m.url, ts: m.ts, title: m.title,
        actor: m.actor, who: m.who ?? null, account: m.account, why: m.why, meta: j(m.meta),
        // When *this* member landed, which is not when the group did. The pane
        // marks a message as new against the same floor `activityOf` counts
        // against, and that floor is per-member: a Slack thread merging into a
        // pull request's group inherits a `first_seen_at` from weeks ago, and
        // without this the pane drew all twelve of its pre-existing replies as
        // new beside a row saying `+0`.
        first_seen_at: m.first_seen_at,
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
      ).all(group_key).map(outTask),
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

  /*
   * Pinned, then pile, then the newest activity.
   *
   * The third term is the whole of change two: a row moves to the top of its
   * list when anything lands on it — a Slack reply, a mail reply, another
   * Sentry event, another turn in a session, a session going live — because all
   * five of those feed `activity_at` and nothing else decides this order. The
   * first two terms are untouched: a pin is a standing instruction and the pile
   * is where a card belongs, and recency does not outrank either.
   */
  out.sort((a, b) =>
    Number(b.state?.pinned ?? 0) - Number(a.state?.pinned ?? 0) ||
    (RANK[a.pile] ?? 9) - (RANK[b.pile] ?? 9) ||
    b.activity_at - a.activity_at,
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

/**
 * One task row, with its status said in the words the product uses.
 *
 * Every task leaves the server through this, so nothing in the browser has to
 * know that the column once held `todo`. Migration 14 rewrote the rows that
 * existed the day it ran; this covers the ones written since by something that
 * has not moved — `tools/seed-demo.ts` writes the old words straight into
 * SQLite — because a status the UI cannot map draws no glyph and no word, and a
 * blank where a status should be reads as a broken page.
 */
const outTask = (t: Row): Row => ({ ...t, status: taskStatus(t.status) })

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
      .map(t => ({
        ...outTask(t),
        notes: db.query(`SELECT * FROM notes WHERE task_id = ? ORDER BY sort, created_at`).all(t.id),
      })),
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

/**
 * Sync — pipe 1, on demand.
 *
 * The same poll the timer runs, run now: every source Wake already holds a
 * credential for is asked what is on him, and nothing outside those credentials
 * is touched. That is the whole difference from Fetch below, which additionally
 * asks the connectors on this box. Both pipes stay, because neither can see
 * what the other sees.
 *
 * `only` narrows it to one source, and it is validated for the reason spelled
 * out over the Fetch route: `ingest()` picks its adapters by name, so a free
 * string would select none of them and report a clean, successful, entirely
 * empty poll — a green tick over a question nobody asked.
 *
 * `isFetchScope` is the right guard here rather than a near-copy of it under a
 * different name. `FetchScope` and `SourceName` are the same five names, and
 * the coupling is not new: `collectAll` already hands a `FetchScope` straight
 * to `ingest()`. One list means the two buttons can never disagree about which
 * sources exist.
 */
api.post('/refresh', async c => {
  const { only } = await c.req.json<{ only?: unknown }>().catch(() => ({ only: undefined }))
  if (only != null && !isFetchScope(only)) return c.json(bad('unknown source'), 400)
  return c.json(await ingest(only ?? undefined))
})

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
 * It moves the baseline `activity` is counted from, and nothing else. It used to
 * also promote a card nobody had started to `in_progress`, which was a fair
 * reading while an ack was something he pressed: pressing "I have seen this" on
 * a notification is close enough to saying he is on it.
 *
 * The detail pane acknowledges automatically now — that is what makes the `+N`
 * and the amber edge go away when a row is opened — and the promotion did not
 * survive the change of who is doing the acknowledging. `db.ts`'s migration 9
 * refuses to read a historical `acked_at` as `in_progress` in exactly these
 * words: an ack "was never a claim that work had begun", and `in_progress` and
 * `in_review` "are facts only he can assert". A pane that promoted whatever it
 * displayed would assert one of them on his behalf every time he read a reply —
 * so a Slack thread he glanced at and left alone would drop out of the
 * Not-started filter he uses to find the work he has not touched.
 *
 * This is the same correction `analytics.ts` makes one field over, and it is the
 * same sentence: reading is not clearing, and reading is not starting either.
 * `card_acked` is still emitted, because he did read it — it is what both
 * response-time percentiles measure — and the Status control remains the only
 * thing in the product that writes a status.
 */
api.post('/cards/:group/ack', c => {
  const g = decodeURIComponent(c.req.param('group'))
  touchState(g, { acked_at: now() })
  logEvent('card_acked', { group_key: g })
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

/* ---------------------- slack threads, from what we hold ------------------- */

/**
 * One Slack conversation on a card, in the shape a brief can carry.
 *
 * `parent` and `replies` are separate rather than one flat list because the two
 * questions a launch sheet asks are separate: which message names this row, and
 * which of the things said under it are worth attaching. A thread nobody has
 * answered comes back with `replies: []` — an empty array the sheet renders as
 * nothing at all, which is a different and more useful answer than a 404 or a
 * placeholder entry saying there is nothing here.
 */
type SlackThread = {
  channel: string | null
  channel_id: string
  team_id: string | null
  thread_ts: string
  /** Slack's own header total, which can exceed `replies.length`. */
  reply_total: number
  /** The poll's thread read failed, so these replies are what search saw. */
  partial: boolean
  /** An alert row: separate top-level messages, not a parent and its replies. */
  alert: boolean
  url: string
  app_url: string | null
  parent: SlackThreadItem | null
  replies: SlackThreadItem[]
}

/** The https origin a stored permalink was minted from, so links stay on his workspace. */
function originOf(u: unknown): string | null {
  if (typeof u !== 'string') return null
  try {
    const o = new URL(u)
    return o.protocol === 'https:' ? o.origin : null
  } catch {
    return null
  }
}

/** Whatever of a stored `thread` array is actually an entry. Same guard as `slack.ts`. */
const storedEntries = (v: unknown): StoredThreadEntry[] =>
  Array.isArray(v)
    ? v.filter((e): e is StoredThreadEntry => !!e && typeof (e as StoredThreadEntry).ts === 'string')
    : []

/**
 * Stored Slack cards, as conversations.
 *
 * Reading `meta`, and never the network. Wake already asks Slack for every
 * thread it holds on every poll — `buildThreadCard` stores the parent and the
 * newest twenty replies with the author, the text, and whether each names him —
 * so re-asking at the moment somebody opens a sheet buys nothing, costs a round
 * trip, and adds a way for the sheet to fail that has nothing to do with the
 * sheet.
 *
 * Direct messages cannot appear here. The refusal lives in `bucketHits`
 * (`sources/slack.ts`), which throws a `D…` conversation away before it can
 * become a bucket and therefore before it can become a card — so this reads
 * from a store that has never contained one. `isDmChannel` is applied anyway,
 * on the way out, because "the data cannot contain it" is an invariant one
 * future adapter can quietly break, and this is the surface where it would be
 * noticed last.
 */
function threadsFromCards(rows: Row[]): SlackThread[] {
  const out: SlackThread[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const meta = j(row.meta)
    const channelId = typeof meta.channel_id === 'string' ? meta.channel_id : ''
    const threadTs = typeof meta.thread_ts === 'string' ? meta.thread_ts : ''
    if (!channelId || !threadTs) continue
    if (isDmChannel(channelId)) continue

    const key = `${channelId}:${threadTs}`
    if (seen.has(key)) continue
    seen.add(key)

    const teamId = typeof meta.team_id === 'string' ? meta.team_id : null
    const channel = typeof meta.channel === 'string' ? meta.channel : null
    const origin = originOf(row.url)
    const ctx = { channelId, channel, teamId, threadTs, origin }

    /*
     * An alert row has no parent and is not pretending to.
     *
     * Its members are separate top-level messages in an alert channel that
     * dedup unioned on a short id — Sentry's post and Cursor's triage of it,
     * five minutes apart — so there is no message the others hang off. Calling
     * the oldest one "the parent" would be a tidy lie, and the flag is on the
     * response so the sheet can say "3 messages" rather than "2 replies".
     */
    const alert = !!meta.alert
    const parentEntry = storedEntries(meta.parent ? [meta.parent] : [])[0] ?? null
    const parent = parentEntry
      ? itemFromEntry(parentEntry, { ...ctx, parent: true })
      : null

    const replies = storedEntries(meta.thread)
      // The parent is not one of its own replies. `foldThreadIntoAlert` merges a
      // thread's parent into the alert's `thread` array, so on a folded row it
      // genuinely can be in both.
      .filter(e => e.ts !== parentEntry?.ts)
      .map(e => itemFromEntry(e, { ...ctx, parent: false }))

    out.push({
      channel,
      channel_id: channelId,
      team_id: teamId,
      thread_ts: threadTs,
      // The header's total when the poll got one, and what we hold when it did
      // not. Counting the array would quietly report a fourteen-reply thread as
      // a twenty-reply one's worth of nothing.
      reply_total: typeof meta.replies === 'number' ? meta.replies : replies.length,
      partial: !!meta.thread_partial,
      alert,
      url: typeof row.url === 'string' ? row.url : '',
      app_url: slackAppLink({ teamId, channelId, ts: threadTs }),
      parent,
      replies,
    })
  }
  return out
}

const slackCardsIn = (group: string) =>
  db.query<Row, [string]>(
    `SELECT url, meta FROM cards WHERE group_key = ? AND source = 'slack' AND gone = 0 ORDER BY ts DESC`,
  ).all(group)

/**
 * The Slack messages this row is made of: the parent, and the replies under it.
 *
 * A sibling of `/cards/:group/thread` rather than an extension of it, and the
 * three reasons are worth writing down because "add a field to the existing
 * route" was the obvious move:
 *
 *   1. That route is a *live* `slack_read_thread` on every open. It costs a
 *      round trip, it answers 502 when Slack is unreachable, and it needs a
 *      thread-read tool `discoverTools` treats as optional. A sheet somebody
 *      presses fifty times a day cannot have Slack's availability in its path
 *      when the answer is already on disk.
 *   2. It returns `SlackThreadRead` — the reader's own vocabulary, parent and
 *      replies and a total — and `src/web/lib/api.ts` already calls it. Widening
 *      a shipped response to carry refs, deep links and team ids changes a
 *      contract for the benefit of a caller that does not want the rest of it.
 *   3. It reads one card (`ORDER BY ts DESC LIMIT 1`) and one `thread_ts`. A
 *      merged group can hold two Slack cards — an alert row and the human thread
 *      that collided with it — and a sheet offering only one of them is offering
 *      half the conversation.
 *
 * Always 200. A group with no Slack in it answers `{ threads: [] }`, because
 * "this card is not a Slack card" is a fact the sheet renders as an absent
 * section, not an error it has to catch.
 */
api.get('/cards/:group/slack', c => {
  const g = decodeURIComponent(c.req.param('group'))
  return c.json({ threads: threadsFromCards(slackCardsIn(g)) })
})

/**
 * A Slack link somebody pasted, as the same item shape the route above returns.
 *
 * The desk lists what the poll found; the operator can always see one more
 * thing than the poll asked about. So a pasted URL becomes an attachable item
 * through one parser — `parseSlackLink` in `src/shared/slackThread.ts`, written
 * against both formats this codebase already mints and reads: the https archive
 * form `SLACK_ARCHIVE` in `dedup.ts` parses, and the `slack://` form
 * `slackAppUrl` builds.
 *
 * Two things this does that the pure function cannot. It supplies the workspace
 * id for the https form, which carries none — without it there is no `slack://`
 * link to build. And it looks the message up in what the poll already stored, so
 * pasting a link to a thread Wake *has* listed comes back with the real author,
 * the real text and `tagged`/`mine` already decided, rather than an empty shell
 * the brief would quote as silence.
 *
 * A refusal is a 400 carrying the parser's own sentence. The three of them —
 * a direct message, a channel with no message, something that is not a Slack
 * link — are all things a person can act on, and none of them is a server fault.
 */
api.post('/slack/link', async c => {
  const body = await c.req.json<{ url?: unknown }>().catch(() => ({ url: undefined }))
  if (typeof body.url !== 'string' || !body.url.trim()) {
    return c.json(bad('url must be a Slack message link'), 400)
  }
  const parsed = parseSlackLink(body.url, { teamId: SLACK_TEAM_ID })
  if (!parsed.ok) return c.json(bad(parsed.reason), 400)

  /*
   * The stored copy wins whole, not field by field.
   *
   * It is the same message described twice, and the stored one knows strictly
   * more: who said it, what they said, which thread it hangs off — a pasted
   * reply link with no `thread_ts` on it comes back knowing its parent. Merging
   * the two per field would produce an item that is half what Slack minted and
   * half what Wake read, which is a shape nobody can reason about when one of
   * them is wrong.
   */
  const stored = storedSlackItem(parsed.item.channel_id, parsed.item.ts)
  return c.json({ item: stored ?? parsed.item })
})

/** One message out of every Slack conversation on the desk, by channel and ts. */
function storedSlackItem(channelId: string, ts: string): SlackThreadItem | null {
  const rows = db.query<Row, [string]>(
    `SELECT url, meta FROM cards
      WHERE source = 'slack' AND gone = 0 AND json_extract(meta, '$.channel_id') = ?
      ORDER BY ts DESC`,
  ).all(channelId)

  for (const t of threadsFromCards(rows)) {
    const hit = [t.parent, ...t.replies].find(e => e?.ts === ts)
    if (hit) return hit
  }
  return null
}

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

/**
 * `restore` is an undo putting something back, not somebody making a new thing.
 *
 * The swipe's Delete is a real delete — there is no soft-delete column on a task
 * or a goal — so its undo has to re-create the row, and two things follow from
 * that, both of them honesty rather than convenience. `started_at` and
 * `completed_at` are normally *derived*, by `PATCH`, from a status transition,
 * so a restore that could only say `status: 'done'` came back finished with no
 * finish time and sorted below tasks completed weeks earlier in a list ordered
 * by exactly that column. And `task_created` is a throughput measurement:
 * counting an undo as a creation makes the product report work that never
 * happened.
 */
const restoring = (b: Row) => b.restore === true

/**
 * What a client is allowed to call a task's status, on the way in.
 *
 * The five are the vocabulary; the old three are still accepted because
 * accepting them costs one lookup and refusing them would 400 a client that has
 * not shipped yet. Both are normalised to the five before they reach the column,
 * so the legacy words can only ever enter this table the way `seed-demo` puts
 * them there — straight into SQLite, past every route.
 *
 * Anything else is refused rather than defaulted. A typo'd status silently
 * stored as `not_started` is a row that quietly moved section, which is worse
 * than a request that failed.
 */
api.post('/tasks', async c => {
  const b = await c.req.json<Row>()
  if (!b.title?.trim()) return c.json(bad('title required'), 400)
  if (b.status !== undefined && !isTaskStatus(b.status)) return c.json(bad('bad status'), 400)
  const id = uid()
  db.query(
    `INSERT INTO tasks (id, title, detail, status, goal_id, source_card_group, due_at, color, sort,
                        created_at, updated_at, started_at, completed_at, ${ORIGIN_FIELDS.join(', ')})
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, b.title.trim(), b.detail ?? null, taskStatus(b.status ?? 'not_started'), b.goal_id ?? null,
    b.source_card_group ?? null, b.due_at ?? null, b.color ?? null,
    b.sort ?? -now(), now(), now(),
    num(b.started_at), num(b.completed_at),
    b.origin_source ?? null, b.origin_title ?? null, b.origin_why ?? null,
    b.origin_url ?? null,
    // Clipped here rather than trusted: it is provider text on its way into a
    // row that outlives the card it came from.
    typeof b.origin_excerpt === 'string' ? b.origin_excerpt.slice(0, 600) : null,
    b.origin_meta ? JSON.stringify(b.origin_meta).slice(0, 2_000) : null,
  )
  if (!restoring(b)) logEvent('task_created', { task_id: id, group_key: b.source_card_group ?? null })
  return c.json(outTask(db.query<Row, [string]>(`SELECT * FROM tasks WHERE id = ?`).get(id)!))
})

const TASK_FIELDS = ['title', 'detail', 'status', 'goal_id', 'source_card_group', 'due_at', 'color', 'sort']

api.patch('/tasks/:id', async c => {
  const id = c.req.param('id')
  const b = await c.req.json<Row>()
  if (b.status !== undefined && !isTaskStatus(b.status)) return c.json(bad('bad status'), 400)
  const prev = db.query<Row, [string]>(`SELECT * FROM tasks WHERE id = ?`).get(id)
  if (!prev) return c.json(bad('not found'), 404)

  /*
   * The move is decided in the five, on both sides.
   *
   * `prev.status` is whatever the column holds, which on a reseeded box is
   * still `doing` — so comparing the incoming word against the raw column made
   * `in_progress` land on a `doing` row as a *transition*, stamping a fresh
   * `started_at` over the one the task already had and writing a second
   * `task_in_progress` event for a move nobody made.
   */
  const next = b.status === undefined ? null : taskStatus(b.status)
  const was = taskStatus(prev.status)
  const moved = next !== null && next !== was

  const values: Row = Object.fromEntries(TASK_FIELDS.filter(k => k in b).map(k => [k, b[k]]))
  if (next !== null) values.status = next
  if (moved) {
    // Derived from the transition, never sent: `completed_at` is the one column
    // the Done list is ordered by, and `started_at` is what the response-time
    // chart measures from. A status that arrives at `wont_do` clears the
    // completion time with everything else that is not `done` — a task he
    // dropped was not finished, and the two must not sort together.
    values.completed_at = next === 'done' ? now() : null
    if ((next === 'in_progress' || next === 'in_review') && !prev.started_at) values.started_at = now()
  }

  const sets = Object.keys(values)
  if (sets.length) {
    db.query(`UPDATE tasks SET ${sets.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...sets.map(k => values[k]), now(), id)
  }
  // `task_done` is what Pulse counts as work finished; the other four are
  // written for the record and drawn by nothing.
  if (moved) logEvent(next === 'done' ? 'task_done' : `task_${next}`, { task_id: id })
  return c.json(outTask(db.query<Row, [string]>(`SELECT * FROM tasks WHERE id = ?`).get(id)!))
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
  db.query(`INSERT INTO goals (id, title, detail, color, target_date, sort, created_at, updated_at, completed_at)
            VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      id, b.title.trim(), b.detail ?? null, b.color ?? null, b.target_date ?? null,
      // A restore keeps its place in the list. Defaulting to `-now()` put an
      // undone delete at the head of `ORDER BY sort`, above goals it had sat
      // under for weeks — which is the undo moving something it did not touch.
      b.sort ?? -now(), now(), now(), num(b.completed_at),
    )
  if (!restoring(b)) logEvent('goal_created', { meta: { id } })
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
