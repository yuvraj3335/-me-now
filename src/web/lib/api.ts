import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { Analytics, SourceStatus, State } from './types'

/** What `POST /connections/:source/start` answers with, success or not. */
export type ConnectStart = {
  status?: number
  url?: string
  error?: string
  detail?: string
  redirectUri?: string
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`)
  return r.json() as Promise<T>
}

const post = <T,>(p: string, body?: unknown) =>
  req<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const patch = <T,>(p: string, body: unknown) => req<T>(p, { method: 'PATCH', body: JSON.stringify(body) })
const del = <T,>(p: string) => req<T>(p, { method: 'DELETE' })

/* ------------------------------- the store ------------------------------- */

type Store = {
  state: State | null
  error: string | null
  loading: boolean
  syncing: boolean
}

let store: Store = { state: null, error: null, loading: true, syncing: false }
const listeners = new Set<() => void>()

function set(patchObj: Partial<Store>) {
  store = { ...store, ...patchObj }
  listeners.forEach(l => l())
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l))
const snapshot = () => store

export function useStore() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

let inflight: Promise<void> | null = null

/** Reload server state. Concurrent calls share one request. */
export function reload(): Promise<void> {
  inflight ??= req<State>('/state')
    .then(state => set({ state, error: null, loading: false }))
    .catch(e => set({ error: (e as Error).message, loading: false }))
    .finally(() => { inflight = null })
  return inflight
}

/** Ask the server to poll every source now, then reload. */
export async function refresh() {
  set({ syncing: true })
  try {
    await post('/refresh')
    await reload()
  } catch (e) {
    set({ error: (e as Error).message })
  } finally {
    set({ syncing: false })
  }
}

/**
 * Apply a change locally before the server confirms it, so a tap feels
 * instant on a phone. On failure the reload below restores the truth.
 */
export function optimistic(mutate: (s: State) => State) {
  if (store.state) set({ state: mutate(structuredClone(store.state)) })
}

export const actions = {
  ack: (g: string) => post(`/cards/${encodeURIComponent(g)}/ack`),
  snooze: (g: string, until: number) => post(`/cards/${encodeURIComponent(g)}/snooze`, { until }),
  move: (g: string, pile: string | null) => post(`/cards/${encodeURIComponent(g)}/pile`, { pile }),
  notMine: (g: string) => post(`/cards/${encodeURIComponent(g)}/not-mine`),
  doneCard: (g: string) => post(`/cards/${encodeURIComponent(g)}/done`),
  pin: (g: string, pinned: boolean) => post(`/cards/${encodeURIComponent(g)}/pin`, { pinned }),
  /**
   * With no `undo`, everything keeping this card off a list is cleared. With
   * one, only that — so undoing a Done leaves a snooze or a manual pile alone.
   */
  restore: (g: string, undo?: 'done' | 'snoozed' | 'not_mine' | 'moved') =>
    post(`/cards/${encodeURIComponent(g)}/restore`, undo ? { undo } : {}),
  doneCards: () => req<{ cards: import('./types').Card[] }>('/cards/done'),
  thread: (g: string) => req<{ thread: any }>(`/cards/${encodeURIComponent(g)}/thread`),
  /** A Claude session's last exchanges — read on open, no new ingest. */
  session: (g: string) =>
    req<{ session: { id: string; cwd: string | null; text: string } }>(
      `/cards/${encodeURIComponent(g)}/session`,
    ),
  /** The Gmail thread this card is about, sanitized on the way in. */
  cardMail: (g: string) => req<{ thread: any; messages: any[] }>(`/cards/${encodeURIComponent(g)}/mail`),

  createTask: (b: Record<string, unknown>) => post('/tasks', b),
  updateTask: (id: string, b: Record<string, unknown>) => patch(`/tasks/${id}`, b),
  deleteTask: (id: string) => del(`/tasks/${id}`),

  createNote: (b: Record<string, unknown>) => post('/notes', b),
  updateNote: (id: string, b: Record<string, unknown>) => patch(`/notes/${id}`, b),
  deleteNote: (id: string) => del(`/notes/${id}`),

  createGoal: (b: Record<string, unknown>) => post('/goals', b),
  updateGoal: (id: string, b: Record<string, unknown>) => patch(`/goals/${id}`, b),
  deleteGoal: (id: string) => del(`/goals/${id}`),

  setReminder: (b: Record<string, unknown>) => post('/reminders', b),
  clearReminder: (id: string) => del(`/reminders/${id}`),

  sources: () => req<SourceStatus[]>('/sources'),
  connections: () => req<{ sources: SourceStatus[]; redirectUri: string }>('/connections'),
  /**
   * Unlike every other call here, this one reads the body on a failure status.
   * "This source needs an app of your own" arrives as a 428 whose body carries
   * the explanation and the redirect URL to paste — throwing that away and
   * surfacing the status code is how a helpful backend becomes a dead button.
   */
  connectStart: async (s: string): Promise<ConnectStart> => {
    const r = await fetch(`/api/connections/${s}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const body = (await r.json().catch(() => ({}))) as ConnectStart
    return { ...body, status: r.status }
  },
  setClient: (s: string, b: { client_id: string; client_secret?: string }) => post(`/connections/${s}/client`, b),
  disconnect: (s: string) => post(`/connections/${s}/disconnect`),

  analytics: (days = 30) =>
    req<Analytics>(`/analytics?days=${days}&tzOffsetMinutes=${new Date().getTimezoneOffset()}`),

  pushKey: () => req<{ key: string }>('/push/key'),
  pushSubscribe: (subscription: unknown, label?: string) => post('/push/subscribe', { subscription, label }),
  pushUnsubscribe: (endpoint: string) => post('/push/unsubscribe', { endpoint }),
  pushTest: () => post<{ sent: boolean; devices: number }>('/push/test'),
  pushStatus: () =>
    req<{ devices: Array<{ endpoint: string; ua: string | null; label: string | null; created_at: number; last_ok_at: number | null }> }>(
      '/push/status',
    ),
}

/** Poll while the tab is visible; stop entirely when it is not. */
export function useLiveState(intervalMs = 60_000) {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const start = useCallback(() => {
    if (timer.current) return
    timer.current = setInterval(() => { if (!document.hidden) void reload() }, intervalMs)
  }, [intervalMs])

  useEffect(() => {
    void reload()
    start()
    const onVisible = () => { if (!document.hidden) void reload() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [start])

  return useStore()
}
