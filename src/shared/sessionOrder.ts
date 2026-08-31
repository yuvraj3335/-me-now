/**
 * The order Claude Code sessions are listed in.
 *
 * Same rule as the desk's, said in the vocabulary a transcript has: the thing
 * that most recently had something happen on it goes first. The desk states
 * that as `activity_at` in `src/server/api.ts`, computed over a card's members;
 * a session is not a card and has no members, so it states it here, over the two
 * facts a session row carries.
 *
 * It lives in `src/shared/` rather than inside the component for the same reason
 * `sessionRepo.ts` does: a comparator is a rule, a rule with no test is a
 * rule that drifts, and a rule that only exists inside a React `useMemo` cannot
 * be tested without rendering one.
 */

/**
 * The two facts about a session that decide where it sits.
 *
 * `live` comes from Claude Code's own per-process files, read by
 * `liveSessions()`; `lastTs` is the transcript's mtime. They are genuinely
 * different questions and both are needed, which is the whole point of this
 * function: an mtime says a session was *written to* recently, and a session
 * that finished an hour ago satisfies that exactly as well as one that is open
 * on this machine right now.
 */
export type SessionOrderable = {
  live?: boolean
  lastTs: number
}

/**
 * Live first, then most recently active.
 *
 * Live is a separate term rather than a bonus folded into the timestamp, and
 * that is deliberate. Adding, say, an hour to a live session's `lastTs` would
 * make the order depend on how big the number was — a session live but idle
 * since this morning would sink under a finished one from twenty minutes ago,
 * and there would be no way to say what the list is sorted by. "Running now, and
 * then by recency" is one sentence, and it is what the reader sees.
 */
export const bySessionActivity = (a: SessionOrderable, b: SessionOrderable): number =>
  Number(!!b.live) - Number(!!a.live) || b.lastTs - a.lastTs

/** A copy in that order. Never sorts in place: the source array belongs to a store. */
export const inSessionOrder = <T extends SessionOrderable>(rows: readonly T[]): T[] =>
  [...rows].sort(bySessionActivity)
