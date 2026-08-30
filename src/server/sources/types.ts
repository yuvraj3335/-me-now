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
  /**
   * Whoever put it there, in whatever vocabulary the source uses. Historically
   * this held a project slug for Sentry and the operator's own login for his own
   * pull requests, because "whose name is on this row" was never actually asked.
   */
  actor?: string
  actor_id?: string
  /**
   * A *person* who is waiting on you, or nothing.
   *
   * Distinct from `actor` on purpose. `actor` is whatever the source calls the
   * thing that produced the row: for `is:pr author:me` that is Yuvraj himself,
   * and for Sentry it is a project slug. Neither is a person waiting on him, and
   * a `Who` column that prints his own name on eight of twenty rows is a column
   * that has to be re-read rather than scanned. Only Slack and Gmail can
   * truthfully fill this in for most rows; the rest leave it empty, and the
   * column renders empty rather than inventing one.
   */
  who?: string
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

/**
 * Thrown by `fetch()` when there is nothing to poll — no token, no account, no
 * `gh` login on the box.
 *
 * Returning an empty array instead is what made a disconnected source report a
 * healthy, up-to-the-second sync: "ran against nothing and found nothing" and
 * "ran against your inbox and found nothing new" are not the same fact, and the
 * sync line was stamping both `ok`. It is also not an *error* — nothing is
 * broken — so it is a type of its own rather than a message the ingest has to
 * pattern-match.
 */
export class NotConnected extends Error {
  constructor(public readonly source: SourceName) {
    super(`${source} is not connected`)
    this.name = 'NotConnected'
  }
}

/**
 * Some of this poll's questions failed and the rest answered.
 *
 * `NotConnected` closed the *no-credential* case. This closes the one under it,
 * which is the one that loses data: every adapter wrapped its queries in
 * `Promise.allSettled` (or `try { … } catch { continue }`) and dropped the
 * rejections, so four rate-limited GitHub searches were recorded as `ok: 1,
 * count: 0` — a healthy, successful, empty poll. The sweep in `ingest.ts` then
 * marked every stored GitHub card `gone = 1`, because a healthy source is
 * authoritative about what it no longer returns. A swallowed 403 wiped the desk
 * and reported "synced".
 *
 * So a partial poll carries its cards *and* says it was partial. The cards land;
 * the sweep does not run, because "not returned" cannot be told apart from "not
 * asked"; and the run is recorded as failed, with the reason, which is what the
 * filter chip and the Settings row read.
 */
export class PartialPoll extends Error {
  constructor(
    public readonly source: SourceName,
    public readonly cards: RawCard[],
    message: string,
  ) {
    super(message)
    this.name = 'PartialPoll'
  }
}

/**
 * Decide what a set of settled queries is allowed to claim.
 *
 * All of them failed → throw, because zero answers out of zero is not an empty
 * inbox. Some failed → `PartialPoll`. None failed → the cards, and the sweep may
 * run.
 */
export function settle(
  source: SourceName,
  results: Array<PromiseSettledResult<unknown>>,
  cards: RawCard[],
): RawCard[] {
  const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
  if (!failed.length) return cards
  const why = failed.map(f => (f.reason as Error)?.message ?? String(f.reason)).join('; ')
  if (failed.length === results.length) throw new Error(why)
  throw new PartialPoll(source, cards, `${failed.length} of ${results.length} queries failed: ${why}`)
}

export interface SourceAdapter {
  name: SourceName
  label: string
  /** Whether this source can run right now, and why not if it can't. */
  status(): Promise<{ ok: boolean; detail: string; via?: string }>
  /** Throws `NotConnected` rather than returning `[]` when nothing is attached. */
  fetch(): Promise<RawCard[]>
}
