/**
 * "Open in Claude Code" on the client.
 *
 * The selection lives here rather than inside one sheet, because a launch can
 * be started from a card, a mail thread, an agent inspector or the palette, and
 * all of them add to the same basket. `add()` is idempotent by ref so clicking
 * "add to launch" twice does not pack the same thread twice.
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

export type LauncherStatus = {
  ok: boolean
  binary: string
  version: string | null
  loggedIn: boolean | null
  reason: string
  packDir: string
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
  session_id: string | null
  status: string
  error: string | null
  created_at: number
  launched_at: number | null
  finished_at: number | null
  live: boolean
  resumeCommand: string | null
  pack_path?: string | null
  items?: Array<PackItem & { id: string }>
  skills?: string[]
}

export type LaunchState = {
  status: LauncherStatus
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
    resumeSessionId?: string | null
  }) => req<Pack>('/packs', { method: 'POST', body: JSON.stringify(b) }),
  launch: (id: string) =>
    req<{ launched: boolean; sessionId?: string; cwd?: string; resumeCommand?: string; packPath?: string }>(
      `/packs/${id}/launch`,
      { method: 'POST' },
    ),
  pack: (id: string) => req<Pack>(`/packs/${id}`),
  packs: () => req<{ packs: Pack[] }>('/packs'),
  stop: (id: string) => req<{ stopped: boolean }>(`/packs/${id}/stop`, { method: 'POST' }),
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