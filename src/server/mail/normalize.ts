/**
 * Gmail MCP payloads → Wake's mail shapes.
 *
 * The server's response shape is not a contract Wake controls, and it has
 * already moved once (threads have arrived as a bare array, under `threads`,
 * under `results` and under `items`). Every field here is read defensively and
 * pinned to a single normalized shape, so a shape change is a change in this
 * file rather than a scattering of `?.` through the UI.
 *
 * These functions are pure. That is what makes them testable without a Gmail
 * credential, which — given a claude.ai connector token can never be read from
 * disk — is the only way this code can be tested at all on this machine.
 */

import { htmlToText, plainBody, plainText, sanitizeEmailHtml } from './sanitize'

export type Address = { name: string | null; addr: string }

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

export const parseAddress = (raw: unknown): Address | null => {
  // A display name arrives escaped like every other field — `Burns &amp;
  // McDonnell` was the sender on a live row — so it is decoded on the way in.
  const s = plainText(raw)
  if (!s) return null
  const angle = /<([^>]+)>/.exec(s)
  if (angle) {
    const name = s.slice(0, angle.index).replace(/^["']|["']$/g, '').trim()
    return { name: name || null, addr: angle[1]!.trim().toLowerCase() }
  }
  return { name: null, addr: s.toLowerCase() }
}

export function parseAddresses(raw: unknown): Address[] {
  if (Array.isArray(raw)) return raw.map(parseAddress).filter((a): a is Address => !!a)
  if (typeof raw !== 'string') return []
  // Split on commas that are not inside a quoted display name.
  return raw
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(parseAddress)
    .filter((a): a is Address => !!a)
}

/** Every container shape the Gmail MCP has been observed to use. */
export function listOf(payload: any, ...keys: string[]): any[] {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  for (const k of [...keys, 'threads', 'messages', 'results', 'items', 'data']) {
    if (Array.isArray(payload?.[k])) return payload[k]
  }
  return []
}

export const cursorOf = (payload: any): string | null =>
  payload?.nextPageToken ?? payload?.next_page_token ?? payload?.nextCursor ?? payload?.cursor ?? null

const asTs = (...values: unknown[]): number => {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000
    if (typeof v === 'string') {
      const n = Date.parse(v)
      if (Number.isFinite(n)) return n
      const epoch = Number(v)
      if (Number.isFinite(epoch) && epoch > 1e9) return epoch > 1e12 ? epoch : epoch * 1000
    }
  }
  return 0
}

const labelsOf = (t: any): string[] => {
  const raw = t?.labelIds ?? t?.labels ?? t?.label_ids ?? []
  return (Array.isArray(raw) ? raw : []).map((l: any) => String(l?.id ?? l?.name ?? l)).filter(Boolean)
}

export function normalizeThread(account: string, raw: any, myAddresses: string[]): MailThread | null {
  const threadId = String(raw?.threadId ?? raw?.thread_id ?? raw?.id ?? '')
  if (!threadId) return null

  const messages = listOf(raw?.messages ?? [], 'messages')
  const last = messages[messages.length - 1] ?? {}
  const first = messages[0] ?? {}

  const labels = [...new Set([...labelsOf(raw), ...labelsOf(last)])]
  const to = parseAddresses(last.toRecipients ?? last.to ?? raw.to)

  return {
    id: `${account}:${threadId}`,
    account,
    threadId,
    // Decoded and de-padded here, once. A snippet reaches a list row, a card
    // excerpt, a Now row and a detail pane, and every one of those renders text
    // — so `let&#39;s` and ten combining grapheme joiners printed literally on
    // four surfaces from one escape in one field.
    subject: plainText(raw.subject ?? last.subject ?? first.subject) || '(no subject)',
    snippet: plainText(raw.snippet ?? last.snippet ?? first.snippet).slice(0, 400),
    from: parseAddress(raw.sender ?? last.sender ?? last.from ?? raw.from),
    to,
    labels,
    // Gmail reports unread as a label; some shapes also carry a boolean.
    unread: labels.includes('UNREAD') || raw.unread === true || raw.isUnread === true,
    starred: labels.includes('STARRED') || raw.starred === true,
    toMe: to.some(a => myAddresses.includes(a.addr)),
    messageCount: messages.length || Number(raw.messageCount ?? raw.messagesTotal ?? 1) || 1,
    ts: asTs(raw.date, last.date, raw.internalDate, last.internalDate, raw.ts),
  }
}

export function normalizeMessage(raw: any, index: number): MailMessage {
  const rawHtml = String(raw?.htmlBody ?? raw?.bodyHtml ?? raw?.html ?? '')
  const rawText = String(raw?.plaintextBody ?? raw?.textBody ?? raw?.body ?? raw?.text ?? raw?.snippet ?? '')
  const clean = rawHtml ? sanitizeEmailHtml(rawHtml) : { html: '', blockedImages: 0 }

  return {
    id: String(raw?.id ?? raw?.messageId ?? `msg-${index}`),
    rfcId: raw?.rfcMessageId ?? raw?.messageIdHeader ?? raw?.['Message-ID'] ?? null,
    from: parseAddress(raw?.sender ?? raw?.from),
    to: parseAddresses(raw?.toRecipients ?? raw?.to),
    cc: parseAddresses(raw?.ccRecipients ?? raw?.cc),
    subject: raw?.subject == null ? null : plainText(raw.subject),
    ts: asTs(raw?.date, raw?.internalDate),
    // Plain text is preferred; HTML is only rendered for mail that has nothing
    // else. Either way the body is decoded exactly once — `htmlToText` already
    // ends in `plainBody`, so this branch does not run it twice and `&amp;lt;`
    // cannot decay into a tag on the second pass.
    text: rawText ? plainBody(rawText) : (rawHtml ? htmlToText(rawHtml) : ''),
    html: clean.html || null,
    blockedImages: clean.blockedImages,
    attachments: (Array.isArray(raw?.attachments) ? raw.attachments : []).map((a: any) => ({
      filename: String(a?.filename ?? a?.name ?? 'attachment'),
      mimeType: a?.mimeType ?? a?.mime_type ?? null,
      size: typeof a?.size === 'number' ? a.size : (typeof a?.sizeBytes === 'number' ? a.sizeBytes : null),
      id: a?.attachmentId ?? a?.id ?? null,
    })),
  }
}

/* --------------------------------- boxes ---------------------------------- */

export type Box = 'inbox' | 'unread' | 'all' | 'sent' | 'drafts' | 'starred'

export const BOXES: Array<{ id: Box; label: string; query: string }> = [
  { id: 'inbox', label: 'Inbox', query: 'in:inbox' },
  { id: 'unread', label: 'Unread', query: 'is:unread in:inbox' },
  { id: 'starred', label: 'Starred', query: 'is:starred' },
  { id: 'sent', label: 'Sent', query: 'in:sent' },
  { id: 'drafts', label: 'Drafts', query: 'in:drafts' },
  { id: 'all', label: 'All mail', query: 'in:anywhere -in:spam -in:trash' },
]

export const isBox = (v: string): v is Box => BOXES.some(b => b.id === v)

/**
 * Compose the Gmail query for a box, a label and a search term. Kept as one
 * function so the label filter and the box filter cannot drift apart — a search
 * that silently ignored the selected box would show the wrong mail confidently.
 */
export function queryFor(opts: { box: Box; label?: string | null; q?: string | null }): string {
  const parts = [BOXES.find(b => b.id === opts.box)?.query ?? 'in:inbox']
  if (opts.label) parts.push(`label:${JSON.stringify(opts.label).replace(/\s/g, '-')}`)
  if (opts.q?.trim()) parts.push(opts.q.trim())
  return parts.join(' ')
}

/* -------------------------------- replying -------------------------------- */

/** Recipients for reply / reply-all, with the sender's own addresses removed. */
export function replyRecipients(
  message: MailMessage,
  mine: string[],
  all: boolean,
): { to: Address[]; cc: Address[] } {
  const mineSet = new Set(mine.map(m => m.toLowerCase()))
  const to = message.from ? [message.from] : []
  if (!all) return { to, cc: [] }

  const seen = new Set([...to.map(a => a.addr), ...mineSet])
  const cc: Address[] = []
  for (const a of [...message.to, ...message.cc]) {
    if (seen.has(a.addr)) continue
    seen.add(a.addr)
    cc.push(a)
  }
  return { to, cc }
}

export const formatAddress = (a: Address) => (a.name ? `${a.name} <${a.addr}>` : a.addr)

/** `Re:`/`Fwd:` without stacking a second prefix on a thread that already has one. */
export const replySubject = (subject: string) =>
  /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`
export const forwardSubject = (subject: string) =>
  /^\s*fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`

/** The quoted block a reply or forward carries under the new text. */
export function quoteFor(message: MailMessage, kind: 'reply' | 'forward'): string {
  const who = message.from ? formatAddress(message.from) : 'someone'
  const when = message.ts ? new Date(message.ts).toLocaleString() : 'an earlier message'
  const head =
    kind === 'reply'
      ? `On ${when}, ${who} wrote:`
      : `---------- Forwarded message ----------\nFrom: ${who}\nDate: ${when}\nSubject: ${message.subject ?? ''}\nTo: ${message.to.map(formatAddress).join(', ')}`
  const body = (message.text || '').split('\n').map(l => `> ${l}`).join('\n')
  return `\n\n${head}\n${body}`
}
