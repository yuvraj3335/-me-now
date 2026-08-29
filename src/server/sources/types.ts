export type SourceName = 'slack' | 'gmail' | 'github' | 'sentry' | 'claude'

export type Pile = 'now' | 'open' | 'parked'

/**
 * A hard reference to a real-world entity. Two cards that share one are the
 * same thing, which is the entire basis of dedup — see DECISIONS.md #4.
 */
export type Ref =
  | { t: 'gh'; v: string }        // owner/repo#123
  | { t: 'slackthread'; v: string } // channel:thread_ts
  | { t: 'gmailthread'; v: string }
  | { t: 'msgid'; v: string }     // RFC 5322 Message-ID
  | { t: 'sentry'; v: string }    // issue short id
  | { t: 'url'; v: string }       // normalized external URL
  | { t: 'subject'; v: string }   // normalized subject line

/** What every source produces. Nothing here is generated — it is copied or computed. */
export type RawCard = {
  source: SourceName
  source_id: string
  account?: string
  kind: string
  title: string
  /** Why this is on me, in plain words. A rule fired; no model wrote this. */
  why: string
  actor?: string
  actor_id?: string
  excerpt?: string
  url: string
  ts: number
  refs: Ref[]
  /** The pile this card wants to be in, before my own state is applied. */
  pile: Pile
  meta?: Record<string, unknown>
}

export type StoredCard = RawCard & {
  id: string
  group_key: string
  first_seen_at: number
  last_seen_at: number
  gone: number
}

export interface SourceAdapter {
  name: SourceName
  label: string
  /** Whether this source can run right now, and why not if it can't. */
  status(): Promise<{ ok: boolean; detail: string; via?: string }>
  fetch(): Promise<RawCard[]>
}
