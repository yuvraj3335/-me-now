/**
 * Mail, as a product rather than as a card feed.
 *
 * The cache is metadata-first and shallow on purpose: a list page stores the
 * thread rows it showed, and a body is stored only for a thread someone
 * actually opened, with a TTL. Copying two mailboxes into SQLite would produce
 * a second, quietly stale mailbox — and a personal console that shows you mail
 * you have already answered is worse than one that takes 400ms to fetch.
 */

import { db, now } from '../db'
import { GMAIL_ACCOUNTS, MAIL_CACHE_TTL_MS, MAIL_PAGE_SIZE, ME } from '../env'
import { formatUntrusted } from '../agent/guard'
import { call, probeMail, callWrite } from './gmail'
import {
  BOXES, cursorOf, formatAddress, listOf, normalizeMessage, normalizeThread, queryFor,
  type Address, type Box, type MailMessage, type MailThread,
} from './normalize'
import { splitQuoted } from './sanitize'

const j = <T,>(v: string | null, fallback: T): T => {
  try {
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

/**
 * Which inboxes a request covers. Intersected with the configured set rather
 * than trusted: an `?account=` naming something Wake does not have would
 * otherwise return an empty list, which reads as "no mail" instead of "no such
 * account".
 */
export const accountsOf = (account?: string | null) =>
  account && account !== 'all' ? GMAIL_ACCOUNTS.filter(a => a === account) : GMAIL_ACCOUNTS

/* --------------------------------- list ----------------------------------- */

export type ListResult = {
  threads: MailThread[]
  cursors: Record<string, string | null>
  accounts: string[]
  errors: Array<{ account: string; error: string }>
  connected: boolean
  reason: string | null
}

/**
 * One page of one box.
 *
 * Cursors are per account, because two inboxes paginate independently and a
 * single token would silently drop the slower one's older mail. The client
 * hands back whatever it was given.
 */
export async function listThreads(opts: {
  box: Box
  account?: string | null
  label?: string | null
  q?: string | null
  cursors?: Record<string, string | null>
  limit?: number
}): Promise<ListResult> {
  const caps = await probeMail()
  const accounts = accountsOf(opts.account)
  const limit = Math.min(opts.limit ?? MAIL_PAGE_SIZE, 100)

  if (!caps.connected || !caps.tools.search) {
    return {
      threads: [],
      cursors: {},
      accounts,
      errors: [],
      connected: false,
      reason: caps.reason ?? 'This Gmail server exposes no thread search tool, so Mail cannot list anything.',
    }
  }

  const query = queryFor({ box: opts.box, label: opts.label, q: opts.q })
  const errors: ListResult['errors'] = []
  const cursors: Record<string, string | null> = {}
  const threads: MailThread[] = []

  await Promise.all(
    accounts.map(async account => {
      const acct = caps.accounts.find(a => a.address === account)
      if (!acct?.connected) {
        if (acct?.reason) errors.push({ account, error: acct.reason })
        return
      }
      try {
        const page = opts.cursors?.[account] ?? undefined
        const payload = await call<any>(account, caps.tools.search!, {
          query,
          maxResults: limit,
          pageSize: limit,
          ...(page ? { pageToken: page, cursor: page } : {}),
        })
        cursors[account] = cursorOf(payload)
        for (const raw of listOf(payload)) {
          const t = normalizeThread(account, raw, ME.emails)
          if (t) threads.push(t)
        }
      } catch (e) {
        errors.push({ account, error: (e as Error).message })
      }
    }),
  )

  threads.sort((a, b) => b.ts - a.ts)
  cacheThreads(threads)

  return { threads, cursors, accounts, errors, connected: true, reason: null }
}

function cacheThreads(threads: MailThread[]) {
  if (!threads.length) return
  const stmt = db.query(
    `INSERT INTO mail_threads (id, account, thread_id, subject, snippet, from_name, from_addr,
                               to_addrs, labels, unread, starred, to_me, msg_count, ts, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       subject = excluded.subject, snippet = excluded.snippet, from_name = excluded.from_name,
       from_addr = excluded.from_addr, to_addrs = excluded.to_addrs, labels = excluded.labels,
       unread = excluded.unread, starred = excluded.starred, to_me = excluded.to_me,
       msg_count = excluded.msg_count, ts = excluded.ts, fetched_at = excluded.fetched_at`,
  )
  const at = now()
  db.transaction(() => {
    for (const t of threads) {
      stmt.run(
        t.id, t.account, t.threadId, t.subject, t.snippet, t.from?.name ?? null, t.from?.addr ?? null,
        JSON.stringify(t.to), JSON.stringify(t.labels), t.unread ? 1 : 0, t.starred ? 1 : 0,
        t.toMe ? 1 : 0, t.messageCount, t.ts, at,
      )
    }
  })()
}

/* -------------------------------- one thread ------------------------------ */

export type ThreadResult = {
  thread: MailThread | null
  messages: MailMessage[]
  cached: boolean
  error?: string
}

export async function getThread(account: string, threadId: string, force = false): Promise<ThreadResult> {
  const key = `${account}:${threadId}`
  const row = db.query<Record<string, any>, [string]>(`SELECT * FROM mail_threads WHERE id = ?`).get(key)

  if (!force && row?.body_fetched_at && now() - row.body_fetched_at < MAIL_CACHE_TTL_MS) {
    return { thread: rowToThread(row), messages: cachedMessages(key), cached: true }
  }

  const caps = await probeMail()
  if (!caps.connected || !caps.tools.thread) {
    return {
      thread: row ? rowToThread(row) : null,
      messages: row ? cachedMessages(key) : [],
      cached: true,
      error: caps.reason ?? 'This Gmail server exposes no thread-read tool.',
    }
  }

  let payload: any
  try {
    payload = await call<any>(account, caps.tools.thread, { threadId, id: threadId, thread_id: threadId })
  } catch (e) {
    // A cached copy beats an empty screen, as long as it is labelled as cached.
    return {
      thread: row ? rowToThread(row) : null,
      messages: row ? cachedMessages(key) : [],
      cached: true,
      error: (e as Error).message,
    }
  }

  const source = payload?.thread ?? payload
  const messages = listOf(source?.messages ?? source, 'messages').map(normalizeMessage)
  // The count comes from what was actually parsed, not from the payload's own
  // claim: a shape whose messages live somewhere unexpected would otherwise
  // report "1 message" over a thread the reader can see has six.
  const thread = normalizeThread(
    account,
    { ...source, threadId, messages: source?.messages ?? [], messageCount: messages.length || undefined },
    ME.emails,
  )
  if (thread) cacheThreads([thread])
  storeMessages(key, account, messages)

  return { thread: thread ?? (row ? rowToThread(row) : null), messages, cached: false }
}

function storeMessages(key: string, account: string, messages: MailMessage[]) {
  if (!messages.length) return
  db.transaction(() => {
    db.query(`DELETE FROM mail_messages WHERE thread_key = ?`).run(key)
    const stmt = db.query(
      `INSERT INTO mail_messages (id, thread_key, account, message_id, rfc_id, from_name, from_addr,
                                  to_addrs, cc_addrs, subject, text_body, html_body, attachments, ts, seq)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    messages.forEach((m, i) =>
      stmt.run(
        `${account}:${m.id}`, key, account, m.id, m.rfcId, m.from?.name ?? null, m.from?.addr ?? null,
        JSON.stringify(m.to), JSON.stringify(m.cc), m.subject, m.text, m.html,
        JSON.stringify(m.attachments), m.ts, i,
      ),
    )
    db.query(`UPDATE mail_threads SET body_fetched_at = ? WHERE id = ?`).run(now(), key)
  })()
}

function cachedMessages(key: string): MailMessage[] {
  return db
    .query<Record<string, any>, [string]>(`SELECT * FROM mail_messages WHERE thread_key = ? ORDER BY seq`)
    .all(key)
    .map(r => ({
      id: r.message_id,
      rfcId: r.rfc_id,
      from: r.from_addr ? { name: r.from_name, addr: r.from_addr } : null,
      to: j<Address[]>(r.to_addrs, []),
      cc: j<Address[]>(r.cc_addrs, []),
      subject: r.subject,
      ts: r.ts,
      text: r.text_body ?? '',
      html: r.html_body ?? null,
      // Recomputing this from the stored HTML would mean re-sanitising on every
      // read; the count only drives a "load images" affordance, so a cached
      // thread simply reports whatever it stored.
      blockedImages: (r.html_body?.match(/data-wake-src=/g) ?? []).length,
      attachments: j(r.attachments, []),
    }))
}

function rowToThread(r: Record<string, any>): MailThread {
  return {
    id: r.id,
    account: r.account,
    threadId: r.thread_id,
    subject: r.subject,
    snippet: r.snippet ?? '',
    from: r.from_addr ? { name: r.from_name, addr: r.from_addr } : null,
    to: j<Address[]>(r.to_addrs, []),
    labels: j<string[]>(r.labels, []),
    unread: !!r.unread,
    starred: !!r.starred,
    toMe: !!r.to_me,
    messageCount: r.msg_count,
    ts: r.ts,
  }
}

/* --------------------------------- labels --------------------------------- */

export async function listLabels(account: string): Promise<{ labels: string[]; error?: string }> {
  const caps = await probeMail()
  if (!caps.connected || !caps.tools.labels) {
    return { labels: [], error: caps.reason ?? 'This Gmail server exposes no label tool.' }
  }
  try {
    const payload = await call<any>(account, caps.tools.labels, {})
    const rows = listOf(payload, 'labels')
    return {
      labels: rows
        .map((l: any) => String(l?.name ?? l?.id ?? l))
        // Gmail's own system labels are already the boxes above; showing them
        // again as "labels" is noise.
        .filter((n: string) => n && !/^(INBOX|SENT|DRAFT|SPAM|TRASH|UNREAD|STARRED|IMPORTANT|CHAT|CATEGORY_.*)$/.test(n)),
    }
  } catch (e) {
    return { labels: [], error: (e as Error).message }
  }
}

/* -------------------------------- sending --------------------------------- */

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

/** The exact shape a confirmation is bound to. Order matters — it is hashed. */
export const sendFingerprintPayload = (d: Draft) => ({
  account: d.account,
  to: d.to.map(s => s.trim().toLowerCase()).filter(Boolean),
  cc: (d.cc ?? []).map(s => s.trim().toLowerCase()).filter(Boolean),
  bcc: (d.bcc ?? []).map(s => s.trim().toLowerCase()).filter(Boolean),
  subject: d.subject.trim(),
  body: d.body,
  threadId: d.threadId ?? null,
})

/**
 * A draft is allowed to be incomplete; a send is not. `requireRecipients` is
 * what separates them, rather than the caller inventing a placeholder address
 * to get past a check that did not apply to it.
 */
export function validateDraft(d: Draft, requireRecipients = true): string | null {
  if (!GMAIL_ACCOUNTS.includes(d.account)) return `"${d.account}" is not a configured mail account`
  const to = (d.to ?? []).map(s => s.trim()).filter(Boolean)
  if (requireRecipients && !to.length) return 'a recipient is required'
  const bad = [...to, ...(d.cc ?? []), ...(d.bcc ?? [])].find(a => a.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.trim()))
  if (bad) return `"${bad}" is not a valid email address`
  if (requireRecipients && !d.subject?.trim()) return 'a subject is required'
  if (requireRecipients && !d.body?.trim()) return 'the message is empty'
  return null
}

export type SendOutcome = { sent: boolean; id?: string; error?: string }

/**
 * Actually send. Reached only from the router, only after `useConfirmation`
 * matched the fingerprint of exactly this draft.
 */
export async function sendMail(d: Draft): Promise<SendOutcome> {
  const caps = await probeMail()
  if (!caps.connected) return { sent: false, error: caps.reason ?? 'Gmail is not connected' }
  if (!caps.tools.send) {
    return {
      sent: false,
      error:
        `This Gmail MCP server exposes no send tool, so Wake cannot send from here. ` +
        `It advertised: ${caps.discovered.join(', ') || '(nothing)'}.`,
    }
  }
  try {
    const r = await callWrite<any>(d.account, caps.tools.send, {
      to: d.to,
      cc: d.cc?.length ? d.cc : undefined,
      bcc: d.bcc?.length ? d.bcc : undefined,
      subject: d.subject,
      body: d.body,
      text: d.body,
      threadId: d.threadId ?? undefined,
      inReplyTo: d.inReplyTo ?? undefined,
    })
    return { sent: true, id: String(r?.id ?? r?.messageId ?? '') || undefined }
  } catch (e) {
    return { sent: false, error: (e as Error).message }
  }
}

export async function saveDraft(d: Draft): Promise<SendOutcome> {
  const caps = await probeMail()
  if (!caps.tools.draft) {
    return { sent: false, error: 'This Gmail MCP server exposes no draft tool; the draft stays in Wake only.' }
  }
  try {
    const r = await callWrite<any>(d.account, caps.tools.draft, {
      to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body: d.body, text: d.body,
      threadId: d.threadId ?? undefined,
    })
    return { sent: true, id: String(r?.id ?? r?.draftId ?? '') || undefined }
  } catch (e) {
    return { sent: false, error: (e as Error).message }
  }
}

/* ------------------------------ for the agent ----------------------------- */

/** A thread rendered for a model — fenced, because it is somebody else's words. */
export function fenceThread(thread: MailThread | null, messages: MailMessage[]): string {
  const head = thread ? `Subject: ${thread.subject}\nAccount: ${thread.account}\n` : ''
  const body = messages
    .map(m => {
      const { body } = splitQuoted(m.text)
      return [
        `From: ${m.from ? formatAddress(m.from) : '(unknown)'}`,
        `To: ${m.to.map(formatAddress).join(', ')}`,
        m.cc.length ? `Cc: ${m.cc.map(formatAddress).join(', ')}` : '',
        `Date: ${m.ts ? new Date(m.ts).toISOString() : '(unknown)'}`,
        '',
        body.slice(0, 6_000),
      ].filter(Boolean).join('\n')
    })
    .join('\n\n---\n\n')
  return formatUntrusted('Gmail thread', `${head}\n${body}`)
}

export { BOXES, formatAddress }
export type { MailThread, MailMessage, Box, Address }
