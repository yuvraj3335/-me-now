/**
 * The Slack conversation a desk row is actually made of.
 *
 * A Slack row on the desk is a thread *parent*, and the parent is almost never
 * where the work is. "we're seeing 500s on the sync" is the parent; the reply
 * four messages down naming the account and the hour is what a brief needs. The
 * sheet used to carry the parent alone, because the parent is what the card is,
 * so every brief written off a Slack row quoted the question and none of the
 * answers.
 *
 * `GET /api/cards/:group/slack` hands back what the poll already stored — the
 * parent and the newest replies under it — so this reads no network of Slack's
 * own and cannot answer 502 in the middle of writing a brief. See
 * HANDOFF_SLACK_API.md for the wire contract.
 *
 * The item shape is imported from `src/shared/slackThread.ts` rather than
 * restated here, for the reason that file gives for existing at all: the server
 * mints these out of stored cards and the browser parses a pasted link into one,
 * and two declarations of one shape is how the two halves come to disagree about
 * what a Slack message is.
 */

import type { SlackThreadItem } from '../../shared/slackThread'
import type { PackItem } from './launch'

export type { SlackThreadItem }

/**
 * One Slack conversation on one desk row.
 *
 * `threads` is a list because a merged group can hold more than one: an alert
 * channel's row and the human thread that collided with it are two channels and
 * two parents, and a sheet offering only the first is offering half of what was
 * said.
 */
export type SlackThread = {
  channel: string | null
  channel_id: string
  team_id: string | null
  thread_ts: string
  /**
   * Slack's own header count, which can exceed what is held.
   *
   * Only the newest twenty replies are stored per card, so `replies.length` is
   * "what Wake has" and this is "how many there are". Printing the array length
   * as the thread's size reports a fourteen-reply thread as a twenty-reply one.
   */
  reply_total: number
  /** The poll's read of this thread did not finish. What is here is still true. */
  partial: boolean
  /** An alert row: separate top-level messages, no parent, everything in `replies`. */
  alert: boolean
  url: string
  app_url: string | null
  parent: SlackThreadItem | null
  replies: SlackThreadItem[]
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await r.json().catch(() => ({}))
  // The server's own sentence. Every refusal on these two routes — a direct
  // message, a channel link with no message in it, something that is not a
  // Slack link at all — is written for a person and is a thing he can act on,
  // so it is what the sheet shows rather than a status code.
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `${r.status}`)
  return body as T
}

export const slackApi = {
  /**
   * Every Slack conversation on one desk row. Always answers; a row with no
   * Slack in it answers with an empty list rather than a 404.
   *
   * The group key carries `:` and `/` — `slackthread:C04D9HKDWAV:1787812499.720579`,
   * `gh:trutohq/truto#2034` — so it is encoded whole, exactly as every other
   * `/cards/:group/...` call in this product encodes it.
   */
  forCard: (group: string) =>
    req<{ threads: SlackThread[] }>(`/cards/${encodeURIComponent(group)}/slack`),

  /**
   * A link he pasted, as the same item a listed reply is.
   *
   * The route rather than `parseSlackLink` in the browser, and the difference is
   * worth the round trip: the route knows the workspace id the https form does
   * not carry, and it looks the message up in what the poll already stored — so
   * a link to a thread Wake *has* read comes back with the real author and the
   * real words instead of an empty shell the brief would quote as silence.
   */
  link: (url: string) =>
    req<{ item: SlackThreadItem }>('/slack/link', { method: 'POST', body: JSON.stringify({ url }) }),
}

/**
 * One Slack message, as an object a brief can carry.
 *
 * The mapping is HANDOFF_SLACK_API.md §1.4 and it is deliberately not clever.
 * Two fields carry the whole design:
 *
 * **`ref` is `<channel>:<ts>`**, which is byte-identical to what `refFor` in
 * `cardContext.ts` mints for a whole Slack card (`channel_id:thread_ts`). So the
 * parent of a thread and the card that thread *is* are one ref, and `openLaunch`'s
 * duplicate collapse merges them with no special case: attaching the card and
 * then the parent yields one item, not the same message twice.
 *
 * **`url` is the durable https permalink and `open_in_app` is the `slack://`
 * one.** The same split `appLinks.ts` reasons about: the https form is what gets
 * stored, copied and shared and is what `SLACK_ARCHIVE` parses back out, and the
 * app form is what a laptop or a phone should actually be sent to. Putting the
 * app link in the stored field would put a URL nobody else can open into the
 * pack file; leaving it out would send him to a second Slack in a browser tab.
 */
export function packItemFor(entry: SlackThreadItem): PackItem {
  return {
    kind: entry.kind,
    ref: entry.ref,
    title: entry.who ?? 'Slack message',
    url: entry.url,
    excerpt: entry.excerpt,
    why: entry.parent ? 'the thread this row is about' : 'a reply on that thread',
    meta: {
      channel: entry.channel,
      at: entry.at,
      open_in_app: entry.app_url,
    },
  }
}

/**
 * Where a control should send somebody for this message.
 *
 * `app ?? href`, the rule `openTarget` already states for a card: the app link
 * when we have the ids to build one, the permalink when we do not. A
 * `slack://` link cannot be probed — with no handler it does not throw, does not
 * fire an error and does not navigate — so the https form is not a fallback that
 * runs, it is the value used when there was never an app link to prefer.
 */
export const slackLinkFor = (entry: SlackThreadItem): string => entry.app_url ?? entry.url

/**
 * What to call the messages under a row.
 *
 * A thread has a parent and replies. An alert row has neither: its members are
 * separate top-level messages in an alert channel that Wake grouped, and calling
 * them "replies" says they answer something that was never asked.
 */
export const messageWord = (t: SlackThread, n: number): string =>
  // Not `word + 's'`. That is how a picker comes to say `10 replys`, which is
  // the kind of thing nobody reports and everybody sees.
  t.alert
    ? `${n} message${n === 1 ? '' : 's'}`
    : `${n} ${n === 1 ? 'reply' : 'replies'}`
