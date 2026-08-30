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
import { readFileSync } from 'node:fs'
import { db } from '../src/server/db'
import {
  BOXES, cursorOf, forwardSubject, isBox, listOf, normalizeMessage, normalizeThread,
  parseAddress, parseAddresses, queryFor, quoteFor, replyRecipients, replySubject,
} from '../src/server/mail/normalize'
import {
  decodeEntities, htmlToText, plainBody, plainText, sanitizeEmailHtml, splitQuoted,
} from '../src/server/mail/sanitize'
import { sendFingerprintPayload, validateDraft } from '../src/server/mail/service'
import { onlyDeclared } from '../src/server/mail/gmail'
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

describe('mail text is decoded once, where it is made', () => {
  /**
   * All three strings below were read off `/api/state` on the live box, and all
   * three were rendered verbatim — in a card excerpt, in a Now row and in the
   * detail pane — because Google escapes its snippets and every surface that
   * shows one renders text rather than markup. Fixing it in a view component
   * would have meant fixing it in four of them and remembering for the fifth.
   */
  const JOBBER = 'Jobber let&#39;s you send quotes in minutes, not hours'
  const BURNS = 'Section Manager at Burns &amp; McDonnell India \u034f \u034f \u034f \u034f \u034f'
  const ANYTHING = 'you don&#39;t need to do anything'

  test('the escapes off the live board are gone from the text', () => {
    expect(plainText(JOBBER)).toBe("Jobber let's you send quotes in minutes, not hours")
    expect(plainText(ANYTHING)).toBe("you don't need to do anything")
    expect(plainText(BURNS)).toBe('Section Manager at Burns & McDonnell India')
  })

  test('a snippet carries neither the escape nor the padding onto a card', () => {
    // The exact path: a thread from the Gmail MCP becomes a list row, and the
    // same normaliser feeds the card excerpt behind Now.
    const t = normalizeThread('me@example.com', {
      threadId: 't1', subject: JOBBER, snippet: BURNS, sender: 'Burns &amp; McDonnell <hr@example.com>',
    }, ME)!
    expect(t.subject).not.toContain('&#39;')
    expect(t.snippet).not.toContain('&amp;')
    expect(t.snippet).not.toContain('\u034f')
    expect(t.snippet.endsWith('India')).toBe(true)
    expect(t.from!.name).toBe('Burns & McDonnell')
  })

  test('a body keeps its line breaks and loses its padding', () => {
    const m = normalizeMessage({ id: 'm1', plaintextBody: 'line one \u034f \u034f\nline  two' }, 0)
    expect(m.text).toBe('line one\nline  two')
  })

  test('the decode is one pass, so an escaped entity stays text', () => {
    // `&amp;lt;` is a message that is talking *about* `&lt;`. Decoding until it
    // settles would turn it into a tag the sender never wrote.
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;')
    // And the HTML fallback must not decode a second time on top of that.
    expect(htmlToText('<p>&amp;lt;b&amp;gt;</p>')).toBe('&lt;b&gt;')
  })

  test('an entity that names nothing is left as written', () => {
    expect(plainText('100 &widget; wide')).toBe('100 &widget; wide')
    expect(plainBody('&#xZZ; &#99999999;')).toBe('&#xZZ; &#99999999;')
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

describe('only what the tool says it takes', () => {
  // Wake could not know whether a search tool wanted `maxResults` or `pageSize`,
  // so it sent both. Google's Gmail MCP rejects the whole request over the one
  // it does not recognise — `Unknown name "maxResults"` — which took out every
  // mailbox at once, and surfaced as an escaped JSON-RPC envelope where the
  // threads should have been.
  test('an undeclared argument is dropped', () => {
    expect(onlyDeclared({ query: 'x', maxResults: 20, pageSize: 20 }, ['query', 'pageSize']))
      .toEqual({ query: 'x', pageSize: 20 })
  })

  test('a tool that declares nothing gets exactly what the caller passed', () => {
    // Narrowing against a schema that does not exist would be guessing, and a
    // dropped argument is as broken as an extra one.
    const args = { query: 'x', maxResults: 20 }
    expect(onlyDeclared(args, undefined)).toBe(args)
    expect(onlyDeclared(args, [])).toBe(args)
  })
})

describe('the escapes already in the database are repaired, not left to the next poll', () => {
  test('migration 8 rewrites stored Gmail text through the same decode', () => {
    // Gmail on this deployment has no credential Wake can obtain, so a row
    // written before the normaliser decoded anything would never be written
    // again — the escapes would have outlived the fix. The migration is scoped
    // to the one source whose text is escaped HTML by construction.
    const src = readFileSync('src/server/db.ts', 'utf8')
    const m = /\{\s*id: 8,[\s\S]*?\n  \},\n/.exec(src)
    expect(m, 'the stored-text repair left the migration list').toBeTruthy()
    expect(m![0], 'the repair stopped covering the card fields the desk renders')
      .toMatch(/repair\('cards', `source = 'gmail'`[\s\S]{0,200}excerpt/)
    expect(m![0], 'a message body was collapsed like a one-line field')
      .toContain("['text_body', plainBody]")
  })

  test('it ran, on a database made by this build', () => {
    // A migration that throws leaves its id unrecorded and the next boot tries
    // again — so the presence of the row is the proof that the repair executed
    // against a real schema rather than merely compiling.
    const row = db.query<{ name: string }, []>(
      `SELECT name FROM schema_migrations WHERE id = 8`,
    ).get()
    expect(row?.name).toBe('decode-stored-mail-text')
  })

  test('a row that is already clean is not rewritten', () => {
    // The repair compares before it writes, so re-running it is free and a
    // body that never carried an escape keeps its exact bytes.
    const clean = 'Deploy notes\n\n  indented line'
    expect(plainBody(clean)).toBe(clean)
    expect(plainText('Already fine')).toBe('Already fine')
  })
})
