/**
 * The Mail client's data layer.
 *
 * Pagination state is per account rather than global, mirroring the server:
 * two inboxes advance independently, and one shared cursor would quietly stop
 * showing the slower one's older mail.
 */

import { useCallback, useEffect, useState } from 'react'

export type Address = { name: string | null; addr: string }

export type MailThread = {
  id: string
  account: string
  threadId: string
  subject: string
  snippet: string
  from: Address | null
  to: Address[]
  labels: string[]
  unread: boolean
  starred: boolean
  toMe: boolean
  messageCount: number
  ts: number
}

export type MailMessage = {
  id: string
  rfcId: string | null
  from: Address | null
  to: Address[]
  cc: Address[]
  subject: string | null
  ts: number
  text: string
  html: string | null
  blockedImages: number
  attachments: Array<{ filename: string; mimeType: string | null; size: number | null; id: string | null }>
}

export type MailState = {
  connected: boolean
  reason: string | null
  accounts: Array<{ address: string; connected: boolean; via: string; reason: string | null }>
  boxes: Array<{ id: string; label: string }>
  me: string[]
  canSend: boolean
  canDraft: boolean
  tools: Record<string, string | null>
  discovered: string[]
}

export type Draft = {
  account: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  threadId?: string | null
  inReplyTo?: string | null
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/mail${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((body as any).error ?? `${r.status}`)
  return body as T
}

export const mailApi = {
  state: (refresh = false) => req<MailState>(`/state${refresh ? '?refresh=1' : ''}`),

  threads: (opts: { box: string; account?: string; label?: string | null; q?: string | null; cursors?: Record<string, string | null> }) => {
    const p = new URLSearchParams({ box: opts.box })
    if (opts.account && opts.account !== 'all') p.set('account', opts.account)
    if (opts.label) p.set('label', opts.label)
    if (opts.q?.trim()) p.set('q', opts.q.trim())
    if (opts.cursors && Object.keys(opts.cursors).length) p.set('cursors', JSON.stringify(opts.cursors))
    return req<{
      threads: MailThread[]
      cursors: Record<string, string | null>
      errors: Array<{ account: string; error: string }>
      connected: boolean
      reason: string | null
    }>(`/threads?${p}`)
  },

  thread: (account: string, id: string, refresh = false) =>
    req<{ thread: MailThread | null; messages: MailMessage[]; cached: boolean; error?: string }>(
      `/threads/${encodeURIComponent(account)}/${encodeURIComponent(id)}${refresh ? '?refresh=1' : ''}`,
    ),

  labels: (account?: string) =>
    req<{ labels: string[]; error?: string }>(`/labels${account ? `?account=${encodeURIComponent(account)}` : ''}`),

  compose: (b: { account: string; threadId: string; messageId?: string; mode: 'reply' | 'reply_all' | 'forward' }) =>
    req<Draft>('/compose', { method: 'POST', body: JSON.stringify(b) }),

  /** Step one of a send: what will go out, and a token bound to exactly that. */
  confirm: (d: Draft) =>
    req<{ token: string; expiresAt: number; preview: Record<string, unknown> }>('/send/confirm', {
      method: 'POST',
      body: JSON.stringify(d),
    }),

  send: (d: Draft & { token: string }) =>
    req<{ sent: boolean; id?: string }>('/send', { method: 'POST', body: JSON.stringify(d) }),

  draft: (d: Draft) => req<{ sent: boolean; id?: string; error?: string }>('/draft', { method: 'POST', body: JSON.stringify(d) }),
}
/** Addresses come back structured; the UI shows a name. */
export const displayName = (a: Address | null) => a?.name || a?.addr?.split('@')[0] || 'unknown'
export const splitAddrs = (s: string) => s.split(/[,;]/).map(x => x.trim()).filter(Boolean)

export function useMailState() {
  const [state, setState] = useState<MailState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (refresh = false) => {
    try {
      setState(await mailApi.state(refresh))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  return { state, error, reload: load }
}
