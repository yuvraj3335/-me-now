/**
 * A task, shaped like a desk row.
 *
 * The Desk's first tab used to be the absence of a source filter — every card
 * from every pipe, ~100 rows of other people's systems, under a heading that
 * said `Tasks`. Nothing he had ever written down was on it, because a task is
 * not a card: they are two tables, and only one of them is his. The tab now
 * shows the `tasks` table and nothing else, which is what its name has claimed
 * all along.
 *
 * It is an adapter rather than a second table because the desk is not a list —
 * it is search, five filter axes, a sort, a pager, a `j`/`k` cursor, a swipe
 * drawer, a detail pane and eight palette entries, all of which are written
 * against `Card`. A parallel implementation over `Task` would be a second desk
 * that drifts, which is the failure `STATUS_ORDER` was consolidated to end when
 * Work kept its own three-word vocabulary. One shape in, every one of those
 * behaviours out.
 *
 * **The key is prefixed, and that prefix is the routing.** A task row writes
 * through `PATCH /tasks/:id` and a card row through `POST /cards/:group/...`;
 * they share a table and share no endpoint. `group_key` is the only identifier
 * that reaches a row action, so it carries which of the two this is. Nothing
 * downstream has to be told — `isTaskRow` asks the key.
 *
 * What is deliberately *not* invented here: a priority (the column does not
 * exist on `tasks`, so the desk hides that filter on this tab rather than
 * offering one that always answers Normal), an activity count (nothing lands on
 * a task from outside, so there is no "since you last looked"), and a source
 * (a task belongs to no pipe, which is the whole point of the tab).
 */

import type { Card, Task } from './types'

const PREFIX = 'task:'

/** The desk key for a task. Prefixed so a row action knows where to write. */
export const taskRowKey = (id: string) => `${PREFIX}${id}`

/** Whether this desk row is a task of his rather than a card from a pipe. */
export const isTaskRow = (c: Card) => c.group_key.startsWith(PREFIX)

/** The task id behind a task row. Only meaningful when `isTaskRow` is true. */
export const taskIdOf = (c: Card) => c.group_key.slice(PREFIX.length)

/**
 * One task as a desk row.
 *
 * `activity_at` and `ts` are both `updated_at`, which is the same one-clock rule
 * the server holds for a card: the desk orders on `activity_at` and prints an
 * age from `ts`, and a row at the top of the list showing a three-day-old age is
 * two facts where there should be one.
 *
 * `why` falls back to a written sentence rather than an empty string, because
 * `why` is what the pane and the palette hint render and a blank there reads as
 * missing data. A task made from a card already carries the card's own `why`,
 * frozen at creation — see `taskFrom.ts` for why that is a copy.
 */
export function taskRow(t: Task): Card {
  return {
    group_key: taskRowKey(t.id),
    pile: 'open',
    status: t.status,
    priority: 2,
    due_at: t.due_at,
    title: t.title,
    why: t.origin_why ?? 'you added this',
    actor: null,
    who: null,
    excerpt: t.detail ?? t.origin_excerpt ?? null,
    url: t.origin_url ?? '',
    kind: 'task',
    ts: t.updated_at,
    activity_at: t.updated_at,
    first_seen_at: t.created_at,
    activity: { count: 0, tagged: false, at: null },
    meta: {},
    sources: [],
    state: null,
    tasks: [],
  }
}
