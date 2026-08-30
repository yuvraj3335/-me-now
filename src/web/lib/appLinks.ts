/**
 * Where `Open` actually goes.
 *
 * The desk's whole job is to end in the app that owns the thing, and until now
 * every Open landed in a browser tab — a second Slack, logged in or not,
 * scrolled to the wrong place, with the real Slack already open behind it. The
 * card's `url` stays the https permalink because that is the durable, shareable
 * form and it is what `SLACK_ARCHIVE` in `src/server/dedup.ts` parses back out;
 * what changes is that the button prefers a scheme the desktop and phone apps
 * register.
 *
 * `slack://` cannot be probed. A custom scheme with no handler does not throw,
 * does not fire an error event and does not navigate — the page simply stays
 * where it is — so there is no honest fallback timer to write, and a timer that
 * guesses is worse than nothing. The escape hatch is therefore a second,
 * visible link carrying the https form, rendered whenever an app link exists.
 * A person who has no Slack app sees one extra quiet line; a person who has one
 * never reads it.
 */

import type { Card } from './types'

/**
 * The Slack desktop/mobile app link, or null when we lack the ids to build one.
 *
 * `message` is the thread's own `ts` and is optional to Slack — without it the
 * app opens the channel, which is still the right place. Team and channel are
 * not optional: `slack://channel` with either missing opens Slack on whatever
 * was last shown, which looks exactly like a link that worked.
 */
export function slackAppUrl(meta: Record<string, any>): string | null {
  const team = meta?.team_id
  const channel = meta?.channel_id
  if (!team || !channel) return null
  const ts = meta?.thread_ts
  return `slack://channel?team=${team}&id=${channel}${ts ? `&message=${ts}` : ''}`
}

/**
 * Gmail, with the account address NOT percent-encoded.
 *
 * `encodeURIComponent('yuvraj@truto.one')` is `yuvraj%40truto.one`, and the
 * `/u/` segment wants the literal address — the escaped form does not resolve,
 * which is visible on the live desk today. The server has the same builder in
 * `src/server/mail/gmail.ts`; this one exists because the client sometimes only
 * has the account and the thread id and not a URL that was built for it.
 */
export function gmailWebUrl(account: string, threadId: string): string {
  return `https://mail.google.com/mail/u/${account}/#inbox/${threadId}`
}

/**
 * What the Open button should navigate to for a card.
 *
 * `href` is always the durable web form and is what a person can copy or share.
 * `app` is non-null only when we can build a link the native application will
 * answer, and the button prefers it — `app ?? href`.
 */
export function openTarget(card: Card): { href: string; app: string | null } {
  const href = card.url
  const slack = card.sources.find(s => s.source === 'slack')
  if (slack) {
    // The card's own meta wins: a merged group carries the fields the dedup
    // engine kept, and the per-source meta is the fallback for a single-source
    // card that never went through a merge.
    const app = slackAppUrl({ ...(slack.meta ?? {}), ...(card.meta ?? {}) })
    if (app) return { href, app }
  }
  return { href, app: null }
}
