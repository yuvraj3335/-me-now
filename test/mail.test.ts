/**
 * Mail's shape-handling and its send gate.
 *
 * The normalizers are pure on purpose: the Gmail MCP on this deployment is a
 * claude.ai connector whose token is never written to disk, so a test that
 * needed a live credential could not run here at all. What CAN be pinned down
 * is every shape the server has been observed to return, and the rule that a
 * send is only ever the send that was approved.
 */

import { describe, expect, test } from 'bun:test'
import {
  BOXES, cursorOf, forwardSubject, isBox, listOf, normalizeMessage, normalizeThread,
  parseAddress, parseAddresses, queryFor, quoteFor, replyRecipients, replySubject,
} from '../src/server/mail/normalize'
import { sanitizeEmailHtml, splitQuoted, htmlToText } from '../src/server/mail/sanitize'
import { sendFingerprintPayload, validateDraft } from '../src/server/mail/service'
import { issueConfirmation, useConfirmation } from '../src/server/security'

const ME = ['me@example.com', 'team@example.com']

describe('address parsing', () => {
  test('a display name and an address', () => {
    expect(parseAddress('Ada Lovelace <ada@example.com>')).toEqual({ name: 'Ada Lovelace', addr: 'ada@example.com' })
  })

  test('a bare address', () => {
    expect(parseAddress('ada@example.com')).toEqual({ name: null, addr: 'ada@example.com' })
  })

  test('a comma inside a quoted name does not split the list', () => {
    // "Lovelace, Ada" <…> is the shape that turns one recipient into two.
    const list = parseAddresses('"Lovelace, Ada" <ada@example.com>, bob@example.com')
    expect(list).toHaveLength(2)
    expect(list[0]!.addr).toBe('ada@example.com')
  })
})

describe('payload shapes', () => {
  test('threads are found under every container the server has used', () => {
    expect(listOf([{ id: 1 }])).toHaveLength(1)
    expect(listOf({ threads: [{ id: 1 }] })).toHaveLength(1)
    expect(listOf({ results: [{ id: 1 }] })).toHaveLength(1)
    expect(listOf({ items: [{ id: 1 }] })).toHaveLength(1)
    expect(listOf(null)).toHaveLength(0)
  })

  test('a page cursor is read under any of its names', () => {
    expect(cursorOf({ nextPageToken: 'a' })).toBe('a')
    expect(cursorOf({ next_page_token: 'b' })).toBe('b')
    expect(cursorOf({})).toBeNull()
  })

  test('a thread normalizes with unread and to-me derived, not trusted', () => {
    const t = normalizeThread(
      'me@example.com',
      {
        threadId: 'T1',
        subject: 'Sync stopped',
        labelIds: ['INBOX', 'UNREAD'],
        messages: [{ sender: 'Ada <ada@x.com>', toRecipients: ['me@example.com'], date: '2026-08-20T10:00:00Z' }],
      },
      ME,
    )!
    expect(t.id).toBe('me@example.com:T1')
    expect(t.unread).toBe(true)
    expect(t.toMe).toBe(true)
    expect(t.ts).toBe(Date.parse('2026-08-20T10:00:00Z'))
  })

  test('a thread cc-ed to me is not "to me"', () => {
    const t = normalizeThread('me@example.com', {
      threadId: 'T2',
      messages: [{ toRecipients: ['someone@else.com'], ccRecipients: ['me@example.com'] }],
    }, ME)!
    expect(t.toMe).toBe(false)
  })

  test('a thread with no id is dropped rather than given a fake one', () => {
    expect(normalizeThread('me@example.com', { subject: 'x' }, ME)).toBeNull()
  })

  test('an epoch-seconds date is not read as 1970', () => {
    const t = normalizeThread('me@example.com', { threadId: 'T', internalDate: '1755684000' }, ME)!
    expect(t.ts).toBeGreaterThan(Date.parse('2020-01-01'))
  })
})

describe('boxes and queries', () => {
  test('every box has a query and is recognised', () => {
    for (const b of BOXES) {
      expect(isBox(b.id)).toBe(true)
      expect(b.query.length).toBeGreaterThan(0)
    }
    expect(isBox('nonsense')).toBe(false)
  })

  test('a search inside a box keeps the box filter', () => {
    // The bug this prevents: searching in Sent and silently getting the inbox.
    const q = queryFor({ box: 'sent', q: 'acme' })
    expect(q).toContain('in:sent')
    expect(q).toContain('acme')
  })
})

describe('replying', () => {
  const message = normalizeMessage(
    {
      id: 'm1',
      sender: 'Ada <ada@x.com>',
      toRecipients: ['me@example.com', 'bob@x.com'],
      ccRecipients: ['carol@x.com', 'team@example.com'],
      plaintextBody: 'the question',
      date: '2026-08-20T10:00:00Z',
    },
    0,
  )

  test('reply goes to the sender only', () => {
    const { to, cc } = replyRecipients(message, ME, false)
    expect(to.map(a => a.addr)).toEqual(['ada@x.com'])
    expect(cc).toHaveLength(0)
  })

  test('reply-all keeps everyone else and drops my own addresses', () => {
    // Getting this wrong emails the customer's whole team, or emails yourself.
    const { to, cc } = replyRecipients(message, ME, true)
    expect(to.map(a => a.addr)).toEqual(['ada@x.com'])
    expect(cc.map(a => a.addr).sort()).toEqual(['bob@x.com', 'carol@x.com'])
  })

  test('a subject is not prefixed twice', () => {
    expect(replySubject('Re: hello')).toBe('Re: hello')
    expect(replySubject('hello')).toBe('Re: hello')
    expect(forwardSubject('Fwd: hello')).toBe('Fwd: hello')
  })

  test('the quoted block carries the original', () => {
    expect(quoteFor(message, 'reply')).toContain('> the question')
  })
})

describe('sanitizing email HTML', () => {
  test('scripts go, with their contents', () => {
    const { html } = sanitizeEmailHtml('<p>hi</p><script>steal()</script>')
    expect(html).toContain('<p>')
    expect(html).not.toContain('steal')
    expect(html.toLowerCase()).not.toContain('script')
  })

  test('event handlers and javascript: URLs do not survive', () => {
    const { html } = sanitizeEmailHtml('<a href="javascript:evil()" onclick="evil()">x</a>')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('onclick')
  })

  test('an unclosed script tag is still removed', () => {
    expect(sanitizeEmailHtml('<script src="//evil">').html.toLowerCase()).not.toContain('script')
  })

  test('remote images are held back and counted', () => {
    const r = sanitizeEmailHtml('<img src="https://tracker.example/pixel.gif">')
    expect(r.blockedImages).toBe(1)
    expect(r.html).toContain('data-wake-src="https://tracker.example/pixel.gif"')
    expect(r.html).not.toMatch(/\ssrc=/)
  })

  test('links open away from the app and do not leak the referrer', () => {
    const { html } = sanitizeEmailHtml('<a href="https://example.com">x</a>')
    expect(html).toContain('rel="noreferrer noopener nofollow"')
    expect(html).toContain('target="_blank"')
  })

  test('a conditional comment cannot smuggle markup past the scanner', () => {
    expect(sanitizeEmailHtml('<!--[if mso]><script>x()</script><![endif]-->').html).not.toContain('script')
  })

  test('ordinary formatting survives', () => {
    const { html } = sanitizeEmailHtml('<p>Hello <strong>there</strong></p><ul><li>one</li></ul>')
    expect(html).toContain('<strong>')
    expect(html).toContain('<li>')
  })

  test('html falls back to readable text', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo')
  })

  test('quoted history is split off rather than deleted', () => {
    const { body, quoted } = splitQuoted('my reply\n\nOn Tuesday, Ada <a@b.c> wrote:\n> original')
    expect(body).toBe('my reply')
    expect(quoted).toContain('original')
  })
})

describe('the send gate', () => {
  const draft = {
    account: 'me@example.com',
    to: ['customer@acme.com'],
    subject: 'Re: sync',
    body: 'We found the cause.',
  }

  test('a draft is validated before anything is minted', () => {
    expect(validateDraft(draft)).toBeNull()
    expect(validateDraft({ ...draft, to: [] })).toContain('recipient')
    expect(validateDraft({ ...draft, to: ['not-an-address'] })).toContain('not a valid')
    expect(validateDraft({ ...draft, subject: '' })).toContain('subject')
    expect(validateDraft({ ...draft, body: '  ' })).toContain('empty')
    expect(validateDraft({ ...draft, account: 'someone@else.com' })).toContain('not a configured')
  })

  test('a send cannot happen without a confirmation', () => {
    expect(useConfirmation('', 'mail.send', sendFingerprintPayload(draft)).ok).toBe(false)
  })

  test('an approved body, then an edited body, is refused', () => {
    const { token } = issueConfirmation('mail.send', sendFingerprintPayload(draft))
    const edited = { ...draft, body: 'We found the cause. Also, here is a refund.' }
    const r = useConfirmation(token, 'mail.send', sendFingerprintPayload(edited))
    expect(r.ok).toBe(false)
    // And the original approval is still spendable, because it was never used.
    expect(useConfirmation(token, 'mail.send', sendFingerprintPayload(draft)).ok).toBe(true)
  })

  test('the fingerprint ignores address case and padding but not content', () => {
    const a = sendFingerprintPayload({ ...draft, to: ['  Customer@Acme.com '] })
    const b = sendFingerprintPayload(draft)
    expect(a).toEqual(b)
  })
})
