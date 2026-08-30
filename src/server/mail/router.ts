/**
 * Mail's HTTP surface.
 *
 * Drafting is free; sending is not. A send needs a confirmation token issued
 * against the exact draft — account, recipients, subject and body — so editing
 * the body after pressing Allow invalidates the Allow rather than sending
 * something nobody approved.
 */

import { Hono } from 'hono'
import { audit } from '../db'
import { GMAIL_ACCOUNTS, ME } from '../env'
import { issueConfirmation, useConfirmation } from '../security'
import { probeMail } from './gmail'
import { BOXES, isBox, replyRecipients, replySubject, forwardSubject, quoteFor, formatAddress, type Box } from './normalize'
import {
  getThread, listLabels, listThreads, saveDraft, sendMail, sendFingerprintPayload, validateDraft, type Draft,
} from './service'

export const mail = new Hono()

const bad = (m: string) => ({ error: m })

mail.get('/state', async c => {
  const caps = await probeMail(c.req.query('refresh') === '1')
  return c.json({
    connected: caps.connected,
    reason: caps.reason,
    reasonDetail: caps.reasonDetail,
    accounts: caps.accounts,
    boxes: BOXES.map(b => ({ id: b.id, label: b.label })),
    me: ME.emails,
    canSend: caps.canSend,
    canDraft: caps.canDraft,
    // What the server actually advertised, so "why can't I send" is answerable
    // from the screen instead of from a log.
    tools: caps.tools,
    discovered: caps.discovered,
  })
})

mail.get('/threads', async c => {
  const box = c.req.query('box') ?? 'inbox'
  if (!isBox(box)) return c.json(bad(`unknown box "${box}"`), 400)

  // Cursors arrive as JSON because they are per account — two inboxes paginate
  // independently and one shared token would drop the slower one's older mail.
  let cursors: Record<string, string | null> = {}
  try {
    cursors = JSON.parse(c.req.query('cursors') ?? '{}')
  } catch {
    cursors = {}
  }

  return c.json(
    await listThreads({
      box: box as Box,
      account: c.req.query('account'),
      label: c.req.query('label'),
      q: c.req.query('q'),
      cursors,
      limit: Number(c.req.query('limit')) || undefined,
    }),
  )
})

mail.get('/threads/:account/:id', async c => {
  const account = decodeURIComponent(c.req.param('account'))
  if (!GMAIL_ACCOUNTS.includes(account)) return c.json(bad('unknown account'), 404)
  return c.json(await getThread(account, decodeURIComponent(c.req.param('id')), c.req.query('refresh') === '1'))
})

mail.get('/labels', async c => {
  const account = c.req.query('account') ?? GMAIL_ACCOUNTS[0] ?? ''
  if (!account) return c.json({ labels: [], error: 'no mail accounts configured (WAKE_EMAILS)' })
  return c.json(await listLabels(account))
})

/**
 * Prefill a reply / reply-all / forward from a message already fetched. Doing
 * this on the server keeps one implementation of "who does a reply-all go to",
 * which is a question with a wrong answer that emails the customer's whole team.
 */
mail.post('/compose', async c => {
  const b = await c.req.json<{ account: string; threadId: string; messageId?: string; mode: 'reply' | 'reply_all' | 'forward' }>()
  if (!GMAIL_ACCOUNTS.includes(b.account)) return c.json(bad('unknown account'), 400)

  const { thread, messages, error } = await getThread(b.account, b.threadId)
  if (!messages.length) return c.json(bad(error ?? 'that thread has no readable messages'), 404)

  const target = (b.messageId && messages.find(m => m.id === b.messageId)) || messages[messages.length - 1]!
  const forward = b.mode === 'forward'
  const { to, cc } = forward ? { to: [], cc: [] } : replyRecipients(target, ME.emails, b.mode === 'reply_all')

  return c.json({
    account: b.account,
    to: to.map(formatAddress),
    cc: cc.map(formatAddress),
    subject: forward ? forwardSubject(thread?.subject ?? '') : replySubject(thread?.subject ?? ''),
    body: quoteFor(target, forward ? 'forward' : 'reply'),
    threadId: forward ? null : b.threadId,
    inReplyTo: forward ? null : target.rfcId,
  })
})

/**
 * Step one of a send: describe exactly what will go out, and mint a token bound
 * to it. The UI shows this back verbatim — account, recipients, subject and the
 * body as it will be sent — because "confirm" is only meaningful if the thing
 * confirmed is the thing shown.
 */
mail.post('/send/confirm', async c => {
  const draft = await c.req.json<Draft>()
  const problem = validateDraft(draft)
  if (problem) return c.json(bad(problem), 400)

  const caps = await probeMail()
  if (!caps.canSend) {
    return c.json(
      bad(
        caps.connected
          ? `This Gmail server exposes no send tool, so Wake cannot send. It advertised: ${caps.discovered.join(', ') || '(nothing)'}.`
          : (caps.reason ?? 'Gmail is not connected'),
      ),
      409,
    )
  }

  const payload = sendFingerprintPayload(draft)
  const { token, expiresAt } = issueConfirmation(
    'mail.send',
    payload,
    `${draft.account} → ${payload.to.join(', ')}: ${payload.subject}`,
  )
  return c.json({ token, expiresAt, preview: payload })
})

mail.post('/send', async c => {
  const b = await c.req.json<Draft & { token: string }>()
  const problem = validateDraft(b)
  if (problem) return c.json(bad(problem), 400)

  const check = useConfirmation(b.token, 'mail.send', sendFingerprintPayload(b))
  if (!check.ok) {
    audit('mail.send', { target: b.to?.join(', '), ok: false, error: check.reason })
    return c.json(bad(check.reason), 409)
  }

  const r = await sendMail(b)
  audit('mail.send', {
    target: `${b.account} → ${b.to.join(', ')}`,
    detail: { subject: b.subject, cc: b.cc, bcc: b.bcc, threadId: b.threadId, bytes: b.body.length },
    ok: r.sent,
    error: r.error ?? null,
  })
  return r.sent ? c.json(r) : c.json(bad(r.error ?? 'send failed'), 502)
})

/** Drafts are not outbound, so they need no confirmation — and may be half-written. */
mail.post('/draft', async c => {
  const b = await c.req.json<Draft>()
  const problem = validateDraft(b, false)
  if (problem) return c.json(bad(problem), 400)
  const r = await saveDraft(b)
  audit('mail.draft', { target: b.account, ok: r.sent, error: r.error ?? null })
  return c.json(r)
})
