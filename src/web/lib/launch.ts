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

/** Where a brief goes, and how much of one the link can carry. */
export type HandoffTarget = { url: string; maxChars: number }

/** What came back when a brief was handed over. */
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

export type LaunchState = {
  handoff: HandoffTarget
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
  }) => req<Pack>('/packs', { method: 'POST', body: JSON.stringify(b) }),
  /** Mark a brief handed over and get the link that opens it in Claude. */
  open: (id: string) => req<Handoff>(`/packs/${id}/open`, { method: 'POST' }),
  pack: (id: string) => req<Pack>(`/packs/${id}`),
  packs: () => req<{ packs: Pack[] }>('/packs'),
  packFileUrl: (id: string) => `/api/claude/packs/${id}/file`,
}

/* ----------------------------- the open basket ---------------------------- */

type Basket = { open: boolean; items: PackItem[]; template: string | null }

let basket: Basket = { open: false, items: [], template: null }
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
export function openLaunch(items: PackItem[], template?: string) {
  const seen = new Set(basket.items.map(i => `${i.kind}:${i.ref}`))
  const merged = [...basket.items, ...items.filter(i => !seen.has(`${i.kind}:${i.ref}`))]
  set({ open: true, items: merged, template: template ?? basket.template })
}
export const removeFromLaunch = (ref: string) => set({ items: basket.items.filter(i => i.ref !== ref) })
export const closeLaunch = () => set({ open: false })