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
 * The first pass here fixed that by parsing a Sentry identity — a short id, an
 * issue link — out of a Slack alert, and left `#truto-api-alerts` (Datadog) and
 * `#truto-grafana-alerts` (Grafana) exactly where they were: alerts with no
 * Sentry identity, still claiming the Slack tab, still forty rows deep. That
 * was correct as far as it went and it did not go far enough: a person reading
 * the Slack tab to find out who is waiting on him was reading past two more
 * monitors' worth of noise that happened to not be Sentry's.
 *
 * The ruling now: **a row belongs to what it is about, and every production
 * alert is one kind of thing.** There is a fourth tab, `alerts`, and it is not
 * "the Sentry tab renamed" — it is where a monitor's own page lands, whichever
 * monitor wrote it and whichever channel carried it. Identity-sniffing a short
 * id out of a title is gone with it: the question is no longer *which* monitor,
 * it is *a* monitor versus *a person*, and `kind` already answers that — the
 * Slack poller writes `kind: 'alert'` for exactly the messages a monitor posted
 * and nothing else.
 *
 * Two rules, and the edge between them is the whole file:
 *
 *   1. **Every non-alert member buckets to itself.** A Sentry API card is
 *      always an alert; a Gmail thread, a GitHub row and a Claude session have
 *      no alert form and bucket to their own pipe, unconditionally.
 *   2. **A Slack member buckets to `alerts` exactly when `kind === 'alert'`,**
 *      regardless of which monitor wrote it. A human thread that merely
 *      *names* an issue in prose — "duplicate of TRUTO-37", the way the Cursor
 *      triage bot and every engineer writes — is a conversation with somebody
 *      waiting in it, and `kind` says so: Slack's poller only ever writes
 *      `alert` for a monitor's own post, never for a reply that mentions one.
 */

import type { Card, CardSource, SourceName } from './types'

/**
 * The tabs the desk offers that are not `tasks`.
 *
 * Four of these are a pipe's own name; `alerts` is not — no `CardSource.source`
 * is ever `'alerts'`, because nothing sends Wake an alert directly. A row gets
 * here from `sentry` or from a Slack message a monitor posted, and
 * `bucketOf` is the one place that says so.
 */
export type Bucket = 'slack' | 'gmail' | 'github' | 'alerts' | 'claude'

/**
 * The tab one member of a group belongs on.
 *
 * Pure, and takes a member rather than a card, because a group can hold several
 * and they do not have to agree: a Slack alert that has merged with the Sentry
 * API card for the same issue has two members, both of which answer `alerts`,
 * and a pull request discussed in a thread has two that answer differently. The
 * card-level question is `inBucket`, which is this asked of each of them.
 */
export function bucketOf(source: CardSource): Bucket {
  if (source.source === 'sentry') return 'alerts'
  if (source.source === 'slack') return source.kind === 'alert' ? 'alerts' : 'slack'
  // Neither `sentry` nor `slack` is left, so this is `gmail`, `github` or
  // `claude` — every one of them a legal `Bucket` on its own name.
  return source.source
}

/**
 * Every tab this card appears on, without duplicates and in members' order.
 *
 * The desk does not draw these today — the tab strip carries no counts — but the
 * predicate below is one line of it, and anything that ever labels or counts a
 * row by source has to ask this rather than `card.sources`, or the strip goes
 * back to disagreeing with the list under it.
 */
export function bucketsOf(card: Card): Bucket[] {
  const seen: Bucket[] = []
  for (const s of card.sources) {
    const b = bucketOf(s)
    if (!seen.includes(b)) seen.push(b)
  }
  return seen
}

/**
 * The tab predicate. `null` is no source filter at all, so it takes everything
 * — including a card with no members.
 *
 * It used to be the string `'all'`, which read as a sixth source sitting beside
 * the five real ones and had to be excluded by hand everywhere a real source
 * name was expected: `source === 'all' ? undefined : source` appeared in three
 * files. `null` says the same thing in the type system — there is no source here
 * — so those exclusions become `??` and the compiler checks them instead of a
 * reader remembering to.
 */
export function inBucket(card: Card, tab: Bucket | null): boolean {
  return tab === null || card.sources.some(s => bucketOf(s) === tab)
}

/**
 * The pollers that can put a row on one tab — the same ruling read backwards.
 *
 * Fetch and Sync are scoped by the tab you are standing on, and both of them
 * scoped by *pipe*: `Fetch Alerts` asked the Sentry collector, which is not
 * where most of the rows on the Alerts tab come from. They come from the Slack
 * poller reading `#sentry-alerts`, `#truto-api-alerts` and
 * `#truto-grafana-alerts`, so the tab and the button pointed at different sets
 * and the control was reporting a refresh of something the operator could not
 * see. A scope is a bucket now, and a bucket may be fed by more than one pipe.
 *
 * Slack is the only polyvalent pipe — `bucketOf` sends every non-alert member
 * to itself — so this table has exactly one entry, and it is one-way: the
 * Alerts tab needs Slack, the Slack tab does not need Sentry. A scoped press is
 * still scoped; `Fetch Slack` asks Slack alone, and asking a pipe that cannot
 * reach the tab would put the button back to refreshing what you are not
 * looking at, from the other direction.
 *
 * The parameter also accepts a bare `SourceName`, because the two controls
 * that call this — `Sync`'s own source menu and this same function's mirror in
 * `src/server/fetch/index.ts` — both still speak in real pipe names rather
 * than in tabs: Sync re-polls "Sentry" on purpose whichever tab you are
 * standing on, and the server's `FetchScope` has no `alerts` of its own to
 * offer, only the five connectors it has always had. `sentry` and `alerts` are
 * therefore the same question asked in the two different vocabularies this
 * file has to speak.
 *
 * **Mirrored in `src/server/fetch/index.ts` as `ALSO_POLLED`, because Fetch
 * runs pipe 1 inside the server and cannot ask the browser.** `test/bucket.test.ts`
 * fails if the two ever drift.
 */
export function pipesFor(tab: Bucket | SourceName): SourceName[] {
  return tab === 'alerts' || tab === 'sentry' ? ['sentry', 'slack'] : [tab]
}

/**
 * The one real pipe a bucket is named after, for the callers that need a
 * `SourceName` rather than a list — the tab strip's own glyph and the header's
 * Sync/Fetch controls, both of which pre-date `alerts` and speak `SourceName`
 * on purpose (see `pipesFor`'s note on the two vocabularies). It is
 * `pipesFor(tab)`'s first entry, which is `sentry` for `alerts` and the bucket
 * itself for the other four.
 */
export function primaryPipe(tab: Bucket): SourceName {
  return pipesFor(tab)[0]!
}
