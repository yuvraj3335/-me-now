/**
 * "Open in Claude" on the client.
 *
 * The selection lives here rather than inside one sheet, because a hand-off can
 * be started from a card, a mail thread or the palette, and all of them add to
 * the same basket. `openLaunch()` is idempotent by ref so clicking it twice does
 * not pack the same thread twice.
 */

import { useCallback, useSyncExternalStore } from 'react'

export type SlotKind = 'card' | 'mail' | 'slack' | 'sentry' | 'notion' | 'github' | 'session' | 'note'

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
    template: string
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
  template: string | null
  /** The repository the card knew about, so the brief does not default to ~/work. */
  repoHint: string | null
  title: string | null
}

let basket: Basket = { open: false, items: [], template: null, repoHint: null, title: null }
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
  opts: { template?: string; repoHint?: string | null; title?: string | null } = {},
) {
  const seen = new Set(basket.items.map(i => `${i.kind}:${i.ref}`))
  const merged = [...basket.items, ...items.filter(i => !seen.has(`${i.kind}:${i.ref}`))]
  set({
    open: true,
    items: merged,
    template: opts.template ?? basket.template,
    repoHint: opts.repoHint ?? basket.repoHint,
    title: opts.title ?? basket.title,
  })
}
export const removeFromLaunch = (ref: string) => set({ items: basket.items.filter(i => i.ref !== ref) })
export const closeLaunch = () => set({ open: false })

/** Empty it. A brief handed over should not leave its objects in the basket. */
export const resetLaunch = () =>
  set({ open: false, items: [], template: null, repoHint: null, title: null })