/**
 * Which tab a row belongs on — what it *is*, not which pipe carried it.
 *
 * The desk's source tabs used to ask `c.sources.some(s => s.source === filter)`,
 * which is a question about transport. Forty Sentry issues arrive through
 * `#sentry-alerts` and are minted `source: 'slack'`, so Slack claimed all forty:
 * the Slack tab read 47 with nine human threads buried under `TRUTO-39 · Error`
 * and `TRUTO-APP-1BY · FetchError`, while the Sentry tab read 13 — the handful
 * that had independently merged with a card from Sentry's own API.
 *
 * The ruling: **a row belongs to the source it is about.** A Slack member that
 * is a Sentry issue buckets to Sentry. Nothing new is invented for it — there is
 * no third tab called "alerts" — the two tabs that already exist simply stop
 * lying about which rows are theirs.
 *
 * Three rules, and the edges between them are the whole file:
 *
 *   1. **Every non-Slack member buckets to itself.** A Sentry API card is
 *      Sentry's, a Gmail thread is Gmail's; there is nothing to decide.
 *   2. **A Slack member buckets to Sentry only if it is an alert AND it carries
 *      a Sentry identity.** `#truto-api-alerts` (Datadog) and
 *      `#truto-grafana-alerts` (Grafana) are alerts with no Sentry identity —
 *      `meta.short_id` is `null` for them by construction, in the adapter — so
 *      they stay on Slack, which is where the channel they came from lives.
 *   3. **A conversation is never an issue.** A human thread that merely *names*
 *      `TRUTO-38` in prose — "duplicate of TRUTO-37", the way the Cursor triage
 *      bot and every engineer writes — is a conversation, and bucketing on a
 *      bare reference match would move real threads off the tab where the person
 *      who wrote them is waiting. Prose is deliberately not read here: identity
 *      comes from `meta.short_id`, from a link that points at the issue, or from
 *      the row's own title, and from nowhere else.
 */

import type { Card, CardSource, SourceName } from './types'

/**
 * A Sentry short id, copied from `src/server/dedup.ts` rather than imported.
 *
 * The server is not in this bundle and must not be — but the pattern is subtle
 * enough that re-deriving it from memory produces a worse one, so it is copied
 * verbatim along with the two facts that make it right. **If one changes, both
 * change.**
 *
 * Short ids are base36, not decimal: `TRUTO-38`, `TRUTO-2D`, `TRUTO-W`,
 * `TRUTO-APP-1BY`. A `TRUTO-\d+` pattern misses most of them outright, and the
 * `-APP` branch has to be tried *first* — the `?` is greedy, so it is — or
 * `TRUTO-APP-1BY` matches as `TRUTO-APP`, which is a reference to an issue that
 * does not exist. No `i` flag: a lowercase `truto-38` in prose is a word.
 *
 * The boundary is spelled out rather than `\b`, because `_` is a word character
 * and the triage bot writes the id italic — `_TRUTO-38_`. Under `\b` there is
 * no boundary on either side of that.
 *
 * Not global. A `/g` regex carries `lastIndex` between calls, so the same
 * expression tested twice against the same string answers `true` and then
 * `false` — a filter that drops every second row and looks like a data problem.
 */
const SHORT_ID = /(?<![0-9A-Za-z])TRUTO(?:-APP)?-[0-9A-Z]+(?![0-9A-Za-z])/

/** A link that points at the issue itself, in either of Sentry's two shapes. */
const SENTRY_URL = /sentry\.io\/(?:organizations\/[^/]+\/)?issues\/\d+/i

/**
 * Whether this Slack alert is a Sentry issue wearing a Slack permalink.
 *
 * Four fields, and the list is short on purpose. `meta.short_id` is the
 * adapter's own answer and is authoritative — `sentryAlertCards` refuses to put
 * an id there that the message merely mentions, and the Datadog and Grafana
 * families write `null`. The other three are the fallbacks for a row minted
 * before that rule existed or by a channel nobody has taught this parser about,
 * and every one of them is a field that *names the row* rather than a field that
 * quotes what somebody said in it. That is what keeps rule 3 true.
 */
function isSentryIssue(source: CardSource): boolean {
  const meta = source.meta ?? {}

  const short = meta.short_id
  if (typeof short === 'string' && SHORT_ID.test(short)) return true

  // A link, wherever the row happens to carry one. On a Slack alert `url` is the
  // permalink and holds none; on a row stamped by something else it may.
  for (const held of [source.url, meta.issue_url, source.title]) {
    if (typeof held === 'string' && SENTRY_URL.test(held)) return true
  }

  // And the title, which for `#sentry-alerts` is either `TRUTO-39 · Error` or
  // the error class alone when the class already begins with the id.
  return typeof source.title === 'string' && SHORT_ID.test(source.title)
}

/**
 * The tab one member of a group belongs on.
 *
 * Pure, and takes a member rather than a card, because a group can hold several
 * and they do not have to agree: a Slack alert that has merged with the Sentry
 * API card for the same issue has two members, both of which answer `sentry`,
 * and a pull request discussed in a thread has two that answer differently. The
 * card-level question is `inBucket`, which is this asked of each of them.
 */
export function bucketOf(source: CardSource): SourceName {
  if (source.source !== 'slack') return source.source
  if (source.kind !== 'alert') return 'slack'
  return isSentryIssue(source) ? 'sentry' : 'slack'
}

/**
 * Every tab this card appears on, without duplicates and in members' order.
 *
 * The desk does not draw these today — the tab strip carries no counts — but the
 * predicate below is one line of it, and anything that ever labels or counts a
 * row by source has to ask this rather than `card.sources`, or the strip goes
 * back to disagreeing with the list under it.
 */
export function bucketsOf(card: Card): SourceName[] {
  const seen: SourceName[] = []
  for (const s of card.sources) {
    const b = bucketOf(s)
    if (!seen.includes(b)) seen.push(b)
  }
  return seen
}

/** The tab predicate. `all` takes everything, including a card with no members. */
export function inBucket(card: Card, tab: SourceName | 'all'): boolean {
  return tab === 'all' || card.sources.some(s => bucketOf(s) === tab)
}

/**
 * The pollers that can put a row on one tab — the same ruling read backwards.
 *
 * Fetch and Sync are scoped by the tab you are standing on, and both of them
 * scoped by *pipe*: `Fetch Sentry` asked the Sentry collector, which is not
 * where the forty rows on the Sentry tab come from. They come from the Slack
 * poller reading `#sentry-alerts`, so the tab and the button pointed at
 * different sets and the control was reporting a refresh of something the
 * operator could not see. A scope is a bucket now, and a bucket may be fed by
 * more than one pipe.
 *
 * Slack is the only polyvalent pipe — `bucketOf` sends every non-Slack member
 * to itself — so this table has exactly one entry, and it is one-way: the
 * Sentry tab needs Slack, the Slack tab does not need Sentry. A scoped press is
 * still scoped; `Fetch Slack` asks Slack alone, and asking a pipe that cannot
 * reach the tab would put the button back to refreshing what you are not
 * looking at, from the other direction.
 *
 * **Mirrored in `src/server/fetch/index.ts` as `ALSO_POLLED`, because Fetch
 * runs pipe 1 inside the server and cannot ask the browser.** `test/bucket.test.ts`
 * fails if the two ever drift.
 */
export function pipesFor(tab: SourceName): SourceName[] {
  return tab === 'sentry' ? ['sentry', 'slack'] : [tab]
}
