/**
 * "Open in Claude" on the client.
 *
 * The selection lives here rather than inside one sheet, because a hand-off can
 * be started from a card, a mail thread or the palette, and all of them add to
 * the same basket. `openLaunch()` is idempotent by ref so clicking it twice does
 * not pack the same thread twice.
 */

import { useCallback, useSyncExternalStore } from 'react'

/**
 * `task` is Wake's own object rather than somebody else's.
 *
 * It was the missing link in the chain the product exists to serve — row → task
 * → stickies → Open in Claude → Pulse. `openLaunch` had three callers (the
 * palette, a card, a mail thread) and Work had none, and a task could not be an
 * object in a brief even if a button had existed.
 */
export type SlotKind = 'card' | 'mail' | 'slack' | 'sentry' | 'notion' | 'github' | 'session' | 'note' | 'task'

export type PackItem = {
  kind: SlotKind
  ref: string
  title?: string | null
  url?: string | null
  excerpt?: string | null
  why?: string | null
  /** Facts worth stating as facts: a channel, a PR number, a session's cwd. */
  meta?: Record<string, string | number | boolean | null> | null
}

export type Template = {
  id: string
  label: string
  blurb: string
  slots: SlotKind[]
  skills: string[]
  defaultRepo: string | null
  instruction: string
}

/**
 * Where a brief goes, how it is prefilled, and how much of one fits.
 *
 * The whole config, not a summary: the browser builds the link itself as you
 * edit the brief, using the same `handoffFor` the server does.
 */
export type HandoffTarget = import('../../shared/handoff').HandoffConfig

/** What the server recorded when a brief was handed over. */
export type Handoff = {
  packId: string
  url: string
  cwd: string
  packPath: string | null
  sent: number
  total: number
  trimmed: boolean
}

export type Session = {
  id: string
  title: string
  cwd: string
  project: string
  turns: number
  lastTs: number
}

export type Pack = {
  id: string
  template: string
  templates?: string[]
  title: string
  cwd: string
  repo_name: string | null
  status: string
  created_at: number
  launched_at: number | null
  pack_path?: string | null
  first_message?: string
  items?: Array<PackItem & { id: string }>
  skills?: string[]
}

export type Skill = { id: string; name: string; catalog: string; whenToUse: string | null; mutating: boolean }

export type LaunchState = {
  handoff: HandoffTarget
  skills: Skill[]
  templates: Template[]
  repos: Array<{ name: string; path: string; role: string; branch: string | null; dirty: number }>
  sessions: Session[]
  packs: Pack[]
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/claude${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((body as any).error ?? `${r.status}`)
  return body as T
}

export const launchApi = {
  state: () => req<LaunchState>('/state'),
  createPack: (b: {
    templates: string[]
    title?: string
    cwd?: string | null
    instruction?: string
    items: PackItem[]
    skills?: string[]
  }) => req<Pack>('/packs', { method: 'POST', body: JSON.stringify(b) }),
  /**
   * Record what was actually handed over. `brief` is the edited text, which
   * becomes the stored copy and the file on disk — a record of the draft Wake
   * happened to render first is not an audit trail.
   */
  open: (id: string, brief?: string) =>
    req<Handoff>(`/packs/${id}/open`, { method: 'POST', body: JSON.stringify({ brief }) }),
  pack: (id: string) => req<Pack>(`/packs/${id}`),
  packs: () => req<{ packs: Pack[] }>('/packs'),
  packFileUrl: (id: string) => `/api/claude/packs/${id}/file`,
}

/* ----------------------------- the open basket ---------------------------- */

type Basket = {
  open: boolean
  items: PackItem[]
  /** Every template the opener suggested. Multi-select, all the way down. */
  templates: string[]
  /** The repository the card knew about, so the brief does not default to ~/work. */
  repoHint: string | null
  title: string | null
}

let basket: Basket = { open: false, items: [], templates: [], repoHint: null, title: null }
const listeners = new Set<() => void>()
const set = (p: Partial<Basket>) => {
  basket = { ...basket, ...p }
  listeners.forEach(l => l())
}

export function useLaunchBasket() {
  return useSyncExternalStore(
    useCallback((l: () => void) => (listeners.add(l), () => listeners.delete(l)), []),
    () => basket,
    () => basket,
  )
}

/** Add objects and open the sheet. Duplicate refs collapse rather than stack. */
export function openLaunch(
  items: PackItem[],
  opts: { template?: string; templates?: string[]; repoHint?: string | null; title?: string | null } = {},
) {
  const seen = new Set(basket.items.map(i => `${i.kind}:${i.ref}`))
  const merged = [...basket.items, ...items.filter(i => !seen.has(`${i.kind}:${i.ref}`))]
  const templates = opts.templates ?? (opts.template ? [opts.template] : basket.templates)
  set({
    open: true,
    items: merged,
    templates,
    repoHint: opts.repoHint ?? basket.repoHint,
    title: opts.title ?? basket.title,
  })
}
export const removeFromLaunch = (ref: string) => set({ items: basket.items.filter(i => i.ref !== ref) })

/**
 * Every dismissal empties the basket.
 *
 * `closeLaunch` used to set `{ open: false }` and nothing else, while
 * `resetLaunch` — the one that actually clears it — was called from exactly one
 * place: the final anchor's onClick. So the basket emptied only on the success
 * path. Open one card's brief, press Escape, open a different card, and the
 * sheet read `CONTEXT — 4 OBJECTS`, three of them from the card he walked away
 * from — and `repoHint` was sticky too, so an abandoned card's repository could
 * silently become the next brief's working directory.
 */
export const closeLaunch = () => resetLaunch()

/** Empty it. A brief handed over should not leave its objects in the basket. */
export const resetLaunch = () =>
  set({ open: false, items: [], templates: [], repoHint: null, title: null })

/**
 * A task, as objects a brief can carry.
 *
 * The task itself, then one `note` slot per sticky — a slot every template has
 * listed since the first release and nothing has ever filled. Stickies are the
 * operator's own words about this task, they are short by construction, and they
 * are the highest-signal thing in any brief.
 *
 * The provenance comes from the task's frozen `origin_*` columns rather than
 * from the card it was made from: the card is swept when its source stops
 * returning it, and the whole point of freezing was that the brief still knows
 * why the task exists after the pull request merges.
 */
export function taskContext(task: {
  id: string; title: string; detail?: string | null
  notes?: Array<{ id: string; body: string }>
  origin_source?: string | null; origin_title?: string | null; origin_why?: string | null
  origin_url?: string | null; origin_excerpt?: string | null; origin_meta?: string | null
  due_at?: number | null
}, goal?: { title: string } | null): PackItem[] {
  const meta: Record<string, string | number | boolean | null> = {}
  if (goal?.title) meta.goal = goal.title
  if (task.due_at) meta.due = new Date(task.due_at).toISOString()
  if (task.origin_source) meta.came_from = task.origin_source
  if (task.origin_why) meta.why_it_exists = task.origin_why

  const items: PackItem[] = [{
    kind: 'task',
    ref: `task:${task.id}`,
    title: task.title,
    url: task.origin_url?.startsWith('http') ? task.origin_url : null,
    excerpt: task.detail?.trim() || task.origin_excerpt || null,
    why: task.origin_why ?? 'on your own list',
    meta,
  }]

  for (const n of task.notes ?? []) {
    items.push({
      kind: 'note',
      ref: `note:${n.id}`,
      title: 'Note',
      excerpt: n.body,
      why: 'your own note on this task',
      meta: {},
    })
  }
  return items
}

/**
 * Which repository a task concerns, if its frozen provenance knows.
 * `origin_meta` is the card's `meta` as stored JSON.
 */
export function taskRepoHint(originMeta: string | null | undefined): string | null {
  if (!originMeta) return null
  try {
    const m = JSON.parse(originMeta) as Record<string, unknown>
    if (typeof m.cwd === 'string') return m.cwd
    if (typeof m.repo === 'string') return m.repo.split('/').pop() ?? null
  } catch { /* a task with unreadable provenance simply has no hint */ }
  return null
}
