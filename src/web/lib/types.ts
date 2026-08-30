import type { CardStatus } from '../../shared/status'

export type SourceName = 'slack' | 'gmail' | 'github' | 'sentry' | 'claude'

/**
 * The three groups, still spelled the way the database spells them.
 *
 * The words on the screen changed — `On you`, `Waiting`, `Snoozed` — and the
 * field names did not. That is deliberate: a rename in the JSON would have been
 * a migration, a poller change and a set of server tests, to buy nothing a
 * lookup table does not already buy. `PILE_LABEL` is the only place the two
 * vocabularies meet, so there is exactly one file to read when they disagree.
 */
export type Pile = 'now' | 'open' | 'parked'

export const PILE_LABEL: Record<Pile, string> = {
  now: 'On you',
  open: 'Waiting',
  parked: 'Snoozed',
}

/**
 * One message on a thread, as the Slack adapter already cleaned it.
 *
 * `tagged` is decided on the raw Slack markup, before the ids became display
 * names — so it survives somebody changing what they are called.
 */
export type ThreadEntry = {
  /** A Slack ts string, e.g. `1787814333.427979`. Not epoch ms. */
  ts: string
  who: string
  who_id: string
  text: string
  tagged: boolean
  mine: boolean
}

/** One message in a Gmail thread. `ts` here IS epoch ms — Gmail is not Slack. */
export type MailEntry = {
  ts: number
  who: string | null
  snippet: string
  mine: boolean
}

export type CardSource = {
  source: SourceName
  kind: string
  url: string
  ts: number
  title: string
  actor?: string | null
  /** A person waiting on you, or null. See `src/server/sources/types.ts`. */
  who?: string | null
  account?: string | null
  why: string
  meta: Record<string, any>
}

export type Card = {
  group_key: string
  pile: Pile
  title: string
  why: string
  actor?: string | null
  /**
   * A person waiting on you, or null — never a project slug and never the
   * operator's own login. The `Who` column renders this, and renders nothing
   * when it is null, because an invented name is worse than a blank.
   */
  who?: string | null
  excerpt?: string | null
  url: string
  kind: string
  ts: number
  first_seen_at: number
  /**
   * How far along this is. Always present, on every card, even one that has
   * never been touched — so nothing here ever reads `state?.status` and has to
   * decide what an absent one means.
   */
  status: CardStatus
  /**
   * What has landed on this since he last looked at it, computed once on the
   * server. The `+N` renders iff `count > 0` and the amber edge appears iff
   * `count > 0` — one expression, read twice, so they cannot disagree. Nothing
   * in the browser recounts it.
   */
  activity: {
    count: number
    /** He was named in one of the counted messages. Changes the word, never the count. */
    tagged: boolean
    /** When the newest of them landed, or null when there were none. */
    at: number | null
  }
  meta: Record<string, any>
  sources: CardSource[]
  state: {
    acked_at: number | null
    snoozed_until: number | null
    notified_at: number | null
    pinned: boolean
    pile_override: string | null
    /** Only ever set on a card `GET /cards/done` returned. */
    done_at?: number | null
    not_mine?: boolean
  } | null
  tasks: Array<{ id: string; title: string; status: string }>
}

export type Note = {
  id: string; task_id: string | null; goal_id: string | null
  body: string; color: string | null; sort: number
  created_at: number; updated_at: number
}

export type Task = {
  id: string; title: string; detail: string | null
  status: 'todo' | 'doing' | 'done'
  goal_id: string | null; source_card_group: string | null
  due_at: number | null; color: string | null; sort: number
  created_at: number; updated_at: number
  started_at: number | null; completed_at: number | null
  notes: Note[]
  /**
   * Provenance, frozen at creation.
   *
   * A copy, not a reference: `source_card_group` points at a `cards` row the
   * poller marks gone when its source stops returning it, so a task's line
   * naming where it came from used to disappear at exactly the moment the pull
   * request merged. Written once and never updated. `origin_meta` is the card's
   * `meta` as stored JSON.
   */
  origin_source: string | null
  origin_title: string | null
  origin_why: string | null
  origin_url: string | null
  origin_excerpt: string | null
  origin_meta: string | null
}

export type Goal = {
  id: string; title: string; detail: string | null; color: string | null
  target_date: number | null; archived: number; sort: number
  created_at: number; updated_at: number; completed_at: number | null
}

export type Reminder = {
  id: string; target_kind: 'task' | 'goal' | 'card'; target_id: string
  fire_at: number; label: string | null; repeat_rule: string | null
  fired_at: number | null; dismissed_at: number | null; created_at: number
}

export type Notification = {
  id: string; dedup_key: string; title: string; body: string | null
  url: string | null; kind: string | null; created_at: number; read_at: number | null
}

/**
 * One source's last finished poll.
 *
 * `connected` is the fact `ok` cannot carry: a source with no account attached
 * polls successfully, finds nothing, and reports `ok: 1, count: 0` — which is
 * indistinguishable from a healthy sync of an inbox with nothing new in it
 * unless the run also says whether there was anything to poll.
 */
export type SyncRun = {
  source: string
  at: number
  ok: number
  count: number
  error: string | null
  connected: number
}

export type State = {
  now: Card[]; open: Card[]; parked: Card[]
  tasks: Task[]; goals: Goal[]; reminders: Reminder[]
  notifications: Notification[]
  lastSync: SyncRun[]
  serverTime: number
}

export type SourceStatus = {
  name: SourceName; label: string; ok: boolean; detail: string; via?: string
  /** The last finished poll, or null if this source has never run one. */
  /**
   * The last finished poll. `connected` is the fact `ok` cannot carry: one
   * ingest run stamps every source with the same `at`, including the ones with
   * no account attached, so an age rendered without it says "synced 1m ago"
   * about a source nobody ever connected.
   */
  lastSync: { ok: number; connected: number; at: number; count: number | null; error: string | null } | null
  oauthable: boolean
  /**
   * Whether pressing Connect can succeed at all, as opposed to whether Wake
   * knows a URL for this server. A button that can only 400 is worse than none.
   */
  connectable: boolean
  hasWakeToken: boolean; hasClaudeBridge: boolean
  hasClientId: boolean; needsClientId: boolean
}

export type Analytics = {
  days: number
  throughput: Record<'done' | 'created' | 'appeared' | 'cleared', Array<{ day: string; value: number }>>
  responseTime: {
    count: number; p50: number; p90: number
    daily: Array<{ day: string; value: number | null; n: number }>
  }
  /**
   * The selected period against the one before it. `delta` is null when the
   * previous period was empty — a percentage change from zero is not a fact.
   */
  pace: { days: number; period: number; previous: number; delta: number | null }
  rhythm: {
    byHour: Array<{ hour: number; value: number }>
    byWeekday: Array<{ weekday: number; value: number }>
    streak: number; bestStreak: number
  }
  aging: Array<{ source: string; buckets: Record<string, number> }>
  agingBuckets: string[]
  goals: Array<{ id: string; title: string; color: string | null; target_date: number | null; total: number; done: number }>
  totals: { openNow: number; doneAllTime: number; tasksOpen: number }
}

/**
 * What one press of Fetch did.
 *
 * `found` is rows that landed after dedup; `fresh` is groups that did not exist
 * before. "Fetched 6 · 0 new" is a useful answer, which is why a second press is
 * never refused.
 */
export type FetchReport = {
  at: number
  ms: number
  found: number
  fresh: number
  connectors: Array<{
    name: string
    /** Wake's own credential answered, the box's did, or neither could. */
    via: 'wake' | 'box' | 'none'
    ok: boolean
    count: number
    ms: number
    error?: string
  }>
}
