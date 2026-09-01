/**
 * The task a row becomes, written once.
 *
 * Two surfaces make a task out of something else — the sheet you get from the
 * detail pane, and the `Task` action in the swipe drawer — and they must agree
 * about what gets carried across, or the quick path silently produces a thinner
 * task than the slow one. It was one inline object literal inside `TaskSheet`
 * before there was a second caller; it is a function now for exactly that
 * reason and for no other.
 *
 * The provenance fields are frozen at creation and never updated, which is the
 * rule `TaskSheet` already kept and the reason it kept it: a task is a durable
 * object and a card is a view of somebody else's system. `ingest.ts` marks a
 * card gone the moment its source stops returning it, so a task whose only link
 * was `source_card_group` lost its provenance line the moment the pull request
 * merged.
 */

import type { Card } from './types'
import type { Session } from './launch'

/** Everything but the origin block — the fields a sheet lets you edit. */
export type TaskBody = Record<string, unknown>

/**
 * The frozen origin block for a task made from a card.
 *
 * Separate from the whole body because `TaskSheet` owns the editable half and
 * only wants this part; the swipe action wants both and composes them below.
 */
export function originFromCard(card: Card): TaskBody {
  return {
    origin_source: card.sources[0]?.source ?? null,
    origin_title: card.title,
    origin_why: card.why,
    origin_url: card.url,
    origin_excerpt: card.excerpt ?? null,
    origin_meta: card.meta ?? null,
  }
}

/** A complete, ready-to-POST task made from a card with nothing else asked. */
export function taskFromCard(card: Card): TaskBody {
  return {
    title: card.title,
    source_card_group: card.group_key,
    ...originFromCard(card),
  }
}

/**
 * The same, for a Claude Code session row.
 *
 * A session is not a card and does not pretend to be one here. It has no group,
 * so `source_card_group` is null and the link back is carried in `origin_meta`
 * as the session id — which is the only identifier that survives the process
 * exiting, and the thing you would actually want in a week's time.
 *
 * `origin_why` is written rather than borrowed because a session has no `why`:
 * nothing put it on the desk, he started it. Saying where it was running is the
 * useful half of that, and it is the half a row cannot show him later.
 */
export function taskFromSession(s: Session): TaskBody {
  return {
    title: s.title,
    source_card_group: null,
    origin_source: 'claude',
    origin_title: s.title,
    origin_why: `a Claude Code session in ${s.project}`,
    origin_url: s.pr?.url ?? null,
    origin_excerpt: s.lastPrompt ?? null,
    origin_meta: { session_id: s.id, cwd: s.cwd, project: s.project },
  }
}
