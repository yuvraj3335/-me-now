export type SourceName = 'slack' | 'gmail' | 'github' | 'sentry' | 'claude'
export type Pile = 'now' | 'open' | 'parked'

/**
 * One Slack channel, as Settings' scope editor reads and writes it.
 *
 * `mode` is what the Slack poller does with the channel — `off` reads nothing,
 * `mentions` reads only the messages that would page or @-mention him,
 * `all` reads every message — and the words the control shows for it depend on
 * `family`: a monitor channel's `mentions` is "Paged", because there is no
 * `@mention` on a bot's own post, only the subset of its alerts that named his
 * group. `label` is a human's classification of the channel, not the poller's;
 * `alert` and `crisp` are only legal there when `family` says so, because
 * calling a customer channel `alert` by hand would tell the alert pipeline to
 * read it as a monitor's.
 */
export type SlackChannelMode = 'off' | 'mentions' | 'all'
export type SlackChannelLabel = 'team' | 'customer' | 'partner' | 'alert' | 'crisp'
export type SlackChannelFamily = 'sentry' | 'datadog' | 'grafana' | 'crisp'

export type SlackChannel = {
  id: string
  /** No leading `#`. */
  name: string
  /** `null` is "unknown" — a seeded row Wake has never listed from Slack. */
  is_private: boolean | null
  is_ext_shared: boolean | null
  is_member: boolean | null
  mode: SlackChannelMode
  label: SlackChannelLabel | null
  /** Which monitor posts here, or `null` for a channel no adapter recognises. */
  family: SlackChannelFamily | null
  /** Written by a migration before Wake could list channels itself, rather than by a read. */
  seeded: boolean
  updated_at: number
  last_listed_at: number | null
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
  /**
   * When this member landed on the group, which is not when the group appeared.
   * The pane needs it to mark a message as new against the same floor the
   * server counted `activity` against — see `isFreshLine` in `lib/thread.ts`.
   */
  first_seen_at?: number
  title: string
  actor?: string | null
  /** A person waiting on you, or null. See `src/server/sources/types.ts`. */
  who?: string | null
  account?: string | null
  why: string
  meta: Record<string, any>
}

/**
 * Where the work stands. Orthogonal to `Pile`, which is still computed from the
 * snooze and the adapter's own claim — a card can be in progress and parked
 * until Monday at once, and there is deliberately no `parked` status because a
 * park is a statement about when he wants to see it.
 */
export type CardStatus =
  | 'not_started' | 'in_progress' | 'in_review' | 'done' | 'wont_do'
export type CardPriority = 0 | 1 | 2 | 3

/** The order a Status control offers them in: how work actually moves. */
export const STATUS_ORDER: readonly CardStatus[] =
  ['not_started', 'in_progress', 'in_review', 'done', 'wont_do'] as const

export const STATUS_LABEL: Record<CardStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  in_review:   'In review',
  done:        'Done',
  wont_do:     "Won't do",
}

export const PRIORITY_ORDER: readonly CardPriority[] = [0, 1, 2, 3] as const
export const PRIORITY_LABEL: Record<CardPriority, string> = {
  0: 'Urgent', 1: 'High', 2: 'Normal', 3: 'Low',
}
/** Normal. A row at this priority draws no mark. */
export const PRIORITY_DEFAULT: CardPriority = 2

export type Card = {
  group_key: string
  pile: Pile
  /**
   * Authoritative, and always present. Never read `state?.status` in the UI:
   * a card with no state row at all still has a status, and this is where it is.
   */
  status: CardStatus
  priority: CardPriority
  due_at: number | null
  title: string
  why: string
  actor?: string | null
  /**
   * A person waiting on you, or null — never a project slug and never the
   * operator's own login. Rendered where there is room for it, and rendered as
   * nothing when it is null, because an invented name is worse than a blank.
   */
  who?: string | null
  excerpt?: string | null
  url: string
  kind: string
  ts: number
  /**
   * When this row last had something happen on it, and the reason it sits where
   * it does. The desk is ordered `pinned → pile → activity_at DESC`, on every
   * surface, and that is the whole of it — nothing in the browser re-derives it.
   *
   * Computed on the server as the union of every member's `ts` with the
   * per-message facts the card carries: a Slack reply's ts, a Gmail message's,
   * `meta.last_reply_at`, and `meta.live_at` for a Claude Code session that is
   * open on this machine right now. See `activityAt` in `src/server/api.ts` for
   * the per-source table.
   *
   * `ts` is set to the same number. They are one clock on purpose: a row at the
   * top of the list printing an age from three days ago, with nothing on screen
   * to explain the gap, is two facts where there should be one.
   */
  activity_at: number
  first_seen_at: number
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
    /**
     * Derived from `status` and kept in sync with it server-side, for the
     * hidden-list sort and for undo records written before status existed.
     * Always emitted, on every card, not only on the hidden list.
     */
    done_at: number | null
    not_mine: boolean
    status: CardStatus
    priority: CardPriority
    due_at: number | null
  } | null
  /** The tasks made from this card, with the status they are in — the five. */
  tasks: Array<{ id: string; title: string; status: CardStatus }>
}

export type Note = {
  id: string; task_id: string | null; goal_id: string | null
  body: string; color: string | null; sort: number
  created_at: number; updated_at: number
}

export type Task = {
  id: string; title: string; detail: string | null
  /**
   * The same five a card has, and the same five the desk paints.
   *
   * This was `todo | doing | done` — a second vocabulary for one idea, which is
   * how Work came to keep its own circles and drift three states behind the
   * rest of the product. The column was rewritten by migration 14 and every row
   * is mapped again on its way out of `/state`, so nothing here has to know the
   * old words: a task arriving from an unmigrated writer is already one of the
   * five by the time it reaches this type.
   */
  status: CardStatus
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
  /** The flat list the desk renders. Sorted pinned -> pile rank -> ts desc. */
  cards: Card[]
  /**
   * The same rows, split by pile. Kept for one release so nothing breaks mid
   * wave; nothing new may read them. Cards whose status is `done` or `wont_do`
   * are in none of these — they are reached through `GET /cards/done`.
   */
  now: Card[]; open: Card[]; parked: Card[]
  tasks: Task[]; goals: Goal[]; reminders: Reminder[]
  notifications: Notification[]
  lastSync: SyncRun[]
  serverTime: number
}

export type SourceStatus = {
  name: SourceName; label: string; ok: boolean; detail: string; via?: string
  /**
   * The last finished poll. `connected` is the fact `ok` cannot carry: one
   * ingest run stamps every source with the same `at`, including the ones with
   * no account attached, so an age rendered without it says "synced 1m ago"
   * about a source nobody ever connected.
   */
  lastSync: { ok: number; connected: number; at: number; count: number | null; error: string | null } | null
  /** When this credential last completed an auth round-trip. */
  lastAuthOkAt?: number | null
  /**
   * Non-null means reconnect, and the string is the provider's own reason. A
   * credential that cannot refresh is not connected, and "sync failed" is the
   * wrong sentence for it.
   */
  lastAuthError?: string | null
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
  throughput: Record<'done' | 'appeared' | 'cleared', Array<{ day: string; value: number }>>
  responseTime: {
    count: number; p50: number; p90: number
    daily: Array<{ day: string; value: number | null }>
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
  totals: { openNow: number }
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
