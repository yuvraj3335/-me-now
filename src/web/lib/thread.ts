/**
 * The conversation a row is about, flattened into something the pane can draw.
 *
 * Both halves of this arrive already built: the Slack adapter reads the whole
 * thread once per poll and stores the parent and the newest twenty replies on
 * the card, and Gmail's search already returned the thread's `messages` array.
 * So nothing here fetches, and — importantly — nothing here counts. `+N` and the
 * amber edge are one number computed on the server, and a second implementation
 * in the browser is precisely how those two would come to disagree. This decides
 * only what to *show*, in what order, and which lines to mark.
 *
 * Two shapes, one list. Slack stamps a ts as a string of seconds with a
 * fractional part; Gmail stamps epoch milliseconds as a number. Reading either
 * as the other is off by a factor of a thousand, which renders as 1970 — so the
 * conversion is one function with one test rather than a `Number()` at four call
 * sites.
 */

import type { Card, MailEntry, ThreadEntry } from './types'

/** One message, as the pane draws it, whichever system it came from. */
export type ThreadLine = {
  key: string
  /** The parent of a Slack thread, which is the row's own title. Drawn first. */
  parent: boolean
  who: string | null
  /** Epoch ms, or null when the source gave a timestamp that made no sense. */
  at: number | null
  text: string
  /** Names him personally, or pages a usergroup he is in. */
  tagged: boolean
  /** He wrote it. */
  mine: boolean
  /**
   * When the source that carries this message landed on the group.
   *
   * Not decoration: it is the second of the two clamps the server's count
   * applies, and it is per-*member* rather than per-card. See `isFreshLine`.
   */
  since: number
}

/**
 * A Slack ts, or a Gmail epoch, in milliseconds.
 *
 * `1787812499.720579` is seconds with six digits of microseconds; only the
 * first three are milliseconds and the rest are Slack's uniqueness tail. Taking
 * the whole fraction as milliseconds would put every message 720 seconds late.
 */
export function entryMs(ts: unknown): number | null {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null
  if (typeof ts !== 'string' || !/^\d+(\.\d+)?$/.test(ts)) return null
  if (!ts.includes('.')) return Number(ts)
  const [secs, frac = ''] = ts.split('.')
  return Number(secs) * 1000 + Number(frac.slice(0, 3).padEnd(3, '0'))
}

const entries = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/**
 * Every message on this card, parent first and then oldest to newest.
 *
 * One order, kept everywhere: a conversation reads downward, and after a scroll
 * the new material is where the eye already is. The alternative — newest first —
 * puts the answer above the question it answers.
 *
 * A card that carries both a Slack thread and a Gmail thread (dedup can union
 * one) shows both, Slack first, because Slack is the source that speaks for the
 * group whenever it is in it.
 */
export function threadLines(card: Card): ThreadLine[] {
  const out: ThreadLine[] = []

  for (const s of card.sources) {
    const since = typeof s.first_seen_at === 'number' ? s.first_seen_at : 0

    if (s.source === 'slack') {
      const meta = s.meta ?? {}
      const parent = meta.parent as ThreadEntry | null | undefined
      if (parent?.text) {
        out.push({
          key: `slack:${parent.ts}`,
          parent: true,
          who: parent.who || null,
          at: entryMs(parent.ts),
          text: parent.text,
          tagged: !!parent.tagged,
          mine: !!parent.mine,
          since,
        })
      }
      for (const raw of entries(meta.thread)) {
        const e = raw as ThreadEntry
        if (!e?.text) continue
        out.push({
          key: `slack:${e.ts}`,
          parent: false,
          who: e.who || null,
          at: entryMs(e.ts),
          text: e.text,
          tagged: !!e.tagged,
          mine: !!e.mine,
          since,
        })
      }
    }

    if (s.source === 'gmail') {
      for (const raw of entries(s.meta?.messages)) {
        const m = raw as MailEntry
        if (!m?.snippet) continue
        out.push({
          key: `gmail:${m.ts}:${m.who ?? ''}`,
          parent: false,
          who: m.who || null,
          at: entryMs(m.ts),
          text: m.snippet,
          // Gmail carries no notion of being named: an addressed thread is the
          // whole card's `why`, not one message's mark.
          tagged: false,
          mine: !!m.mine,
          since,
        })
      }
    }
  }

  // One conversation seen twice — the same Slack thread on two member cards —
  // is still one conversation.
  const seen = new Set<string>()
  return out.filter(l => (seen.has(l.key) ? false : (seen.add(l.key), true)))
}

/**
 * The total the source itself reported, which is not the same as what is drawn.
 *
 * Slack's thread header carries the authoritative count even when the page it
 * returned held fewer, and only the newest twenty are stored. `12 replies` over
 * a list of twenty entries is honest; counting the array would quietly claim a
 * long thread is short.
 */
export function replyTotal(card: Card): number {
  let total = 0
  for (const s of card.sources) {
    const n = s.meta?.replies
    if (typeof n === 'number' && Number.isFinite(n)) total += n
  }
  return total
}

/**
 * When he last looked at this — everything after it is new.
 *
 * The same baseline the server counted `activity` against, so a reply drawn in
 * the brighter ink is exactly a reply the `+N` counted.
 */
export const baselineOf = (card: Card): number =>
  card.state?.acked_at ?? card.first_seen_at

/**
 * Whether this line is one of the messages the row's `+N` counted.
 *
 * `activityOf` in `api.ts` applies two clamps and the pane used to apply
 * neither, which is exactly how one fact becomes two that disagree:
 *
 *   * **A message of his own is never activity on him.** On the live `#truto`
 *     thread ten of eleven messages are his; he acked the row, replied twice,
 *     and the next poll left the row with no `+N` and no amber edge while the
 *     pane drew his own two replies in the brighter "new" ink.
 *   * **Nothing a source brought with it when it landed is something he has
 *     missed.** The floor is that source's own arrival, not the group's: a Slack
 *     thread merging into a week-old pull request's group counts zero on the
 *     server, and the pane — comparing against the group's `first_seen_at` —
 *     lit all twelve pre-existing replies.
 *
 * Written here, once, rather than inline at the one place that draws it, so the
 * next thing that wants to know "is this new" cannot answer it a third way.
 */
export const isFreshLine = (l: ThreadLine, baseline: number): boolean =>
  !l.mine && l.at !== null && l.at > Math.max(baseline, l.since)
