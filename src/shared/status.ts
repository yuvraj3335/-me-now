/**
 * How far along a thing is — the one vocabulary, shared by both halves.
 *
 * This lives in `shared/` rather than on the server because the words are the
 * product: the swipe's Status action, the detail pane's picker and the server's
 * validation must offer the same five in the same order with the same labels,
 * and three hand-maintained copies of a five-element list is how a picker ends
 * up offering a value the route refuses.
 *
 * The names are deliberately not new. An overhaul on another worktree already
 * landed this exact enum, and the two are meant to merge as a dedupe rather than
 * as a redesign — so nothing here is "improved" on the way in, however tempting
 * `blocked` or `todo` might look.
 *
 * `status` and the legacy `done_at` / `not_mine` columns are the same fact told
 * two ways, and they are kept in step by exactly one function on the server
 * (`statusPatch` in `api.ts`). Nothing else may write one without the other.
 */

export type CardStatus = 'not_started' | 'in_progress' | 'in_review' | 'done' | 'wont_do'

export const CARD_STATUSES = ['not_started', 'in_progress', 'in_review', 'done', 'wont_do'] as const

/** The order a picker shows them in: left to right, earliest to latest. */
export const STATUS_ORDER: readonly CardStatus[] = CARD_STATUSES

export const STATUS_LABEL: Record<CardStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  wont_do: "Won't do",
}

/** A card with no state row has not been touched, so it has not been started. */
export const DEFAULT_STATUS: CardStatus = 'not_started'

export const isCardStatus = (v: unknown): v is CardStatus =>
  typeof v === 'string' && (CARD_STATUSES as readonly string[]).includes(v)

/**
 * Tasks have three states and are not being migrated to five.
 *
 * A task is my own work with a lifecycle the Work page already draws; a card is
 * somebody else's system, and its status is a note I keep about it. Forcing one
 * table to carry the other's vocabulary would mean a migration, a backfill and
 * two more columns to answer a question the Status control can answer with a
 * lookup — so the five labels map onto the three, and `wont_do` maps onto the
 * thing a task actually does when you decide against it, which is to leave.
 *
 * `null` therefore means "delete this task", not "no opinion".
 */
export const TASK_STATUS_FOR: Record<CardStatus, 'todo' | 'doing' | 'done' | null> = {
  not_started: 'todo',
  in_progress: 'doing',
  in_review: 'doing',
  done: 'done',
  wont_do: null,
}

/** The three a task can actually be in, under the shared labels. */
export const TASK_STATUS_LABEL: Record<'todo' | 'doing' | 'done', string> = {
  todo: STATUS_LABEL.not_started,
  doing: STATUS_LABEL.in_progress,
  done: STATUS_LABEL.done,
}
