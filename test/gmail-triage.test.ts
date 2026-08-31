/**
 * What earns a Gmail card, and what is not allowed to lose one.
 *
 * The measurement this replaced is worth writing down, because the tests below
 * only make sense against it. On 2026-08-31 the poller asked
 * `is:unread newer_than:14d -category:promotions -category:social` and took the
 * first thirty threads. All thirty were on the desk when the operator looked and
 * not one was a person writing to him: Cloudflare maintenance windows, LinkedIn
 * nudges, Sentry digests, a Notion trend mail, two weekly reports.
 *
 * Read against the live mailbox the same morning, and each number is a clause:
 *
 *   50+ threads matched the old query
 *   26  survived once `updates` and `forums` joined the exclusions
 *    5  survived once the `noreply` address convention did too
 *   42  matched `is:important` — Zoho quota warnings, Mercury 2FA, an Anthropic
 *        receipt, eighteen Claude device alerts. That is why nothing here asks
 *        Gmail what it thinks is important.
 *
 * The query half is pinned as a string because it is the whole contract with
 * Gmail and a typo in it fails silently — a bad operator name does not error,
 * it returns nothing, which reads exactly like a quiet inbox. The survival half
 * is pinned as behaviour, on the message shapes the Gmail MCP actually returns.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  GMAIL_EXCLUDE_CATEGORIES, GMAIL_EXCLUDE_SENDERS, GMAIL_PAGE_SIZE,
  gmailCardQuery, gmailRepliedQuery,
} from '../src/server/env'
import {
  addressOf, addressedToMe, hasUnread, iReplied, rescuedByReply, survivesFilter,
} from '../src/server/mail/triage'

const ME = ['me@example.com', 'team@example.com']

/* --------------------------- the query as a string ------------------------- */

describe('the query the poller asks Gmail', () => {
  test('is unread mail, in the inbox, inside the lookback', () => {
    const q = gmailCardQuery(14)
    expect(q).toContain('is:unread')
    expect(q).toContain('newer_than:14d')
    // `in:inbox` was missing and is the cheapest win in the whole change. His
    // own filters already archive the group mail he does not read; without this
    // the poller reached past them and put it on the desk anyway.
    expect(q).toContain('in:inbox')
  })

  test('reads, in full, as the thing we measured', () => {
    expect(gmailCardQuery(14)).toBe(
      'is:unread in:inbox newer_than:14d' +
      ' -category:promotions -category:social -category:updates -category:forums' +
      ' -from:noreply -from:no-reply -from:donotreply',
    )
  })

  test('excludes every category Gmail already sorts a crowd into', () => {
    const q = gmailCardQuery(14)
    // `forums` is the one that mattered most and the one a person would forget:
    // eng@truto.one and integrations@truto.one are Google Groups, so their mail
    // is forums, and it was most of the flood.
    expect(GMAIL_EXCLUDE_CATEGORIES).toContain('forums')
    expect(GMAIL_EXCLUDE_CATEGORIES).toContain('updates')
    for (const c of GMAIL_EXCLUDE_CATEGORIES) expect(q).toContain(`-category:${c}`)
  })

  test('excludes the addresses that announce themselves as machines', () => {
    const q = gmailCardQuery(14)
    for (const s of GMAIL_EXCLUDE_SENDERS) expect(q).toContain(`-from:${s}`)
    // Not a sender blocklist: Gmail matches these as tokens, so one word covers
    // noreply@mailer.truto.one and no-reply-EeEWwHBV22C0_3tdrmTqIQ@mail.anthropic.com
    // alike, and covers a vendor nobody has heard of yet on their first send.
    expect(GMAIL_EXCLUDE_SENDERS).toContain('noreply')
    expect(GMAIL_EXCLUDE_SENDERS).toContain('no-reply')
  })

  test('never asks Gmail what it thinks is important', () => {
    // Measured, not assumed. `is:important` matched 42 unread threads on this
    // mailbox and liked receipts, quota warnings and eighteen copies of one
    // device alert; 22 of the 26 threads left after the category exclusions
    // carry IMPORTANT. Requiring it keeps the noise and drops the people.
    expect(gmailCardQuery(14)).not.toContain('is:important')
  })

  test('never uses category:primary as the complement of the others', () => {
    // With the tabbed inbox off it matched effectively everything unread — the
    // same 50 the bare query returned — while the negative forms read the
    // underlying CATEGORY_ labels and narrow properly.
    expect(gmailCardQuery(14)).not.toContain('category:primary')
  })

  test('takes the lookback it is given rather than baking one in', () => {
    expect(gmailCardQuery(3)).toContain('newer_than:3d')
    expect(gmailCardQuery(30)).toContain('newer_than:30d')
  })
})

describe('the replied-thread query', () => {
  test('asks for threads he has spoken in', () => {
    expect(gmailRepliedQuery(14)).toContain('from:me')
    expect(gmailRepliedQuery(14)).toContain('newer_than:14d')
  })

  test('is deliberately not restricted to unread, and that is the whole point', () => {
    // Gmail matches per message even when it returns threads, so
    // `is:unread from:me` wants one message that is both unread and sent by
    // him — verified against the live mailbox, where it answers zero while
    // `from:me newer_than:365d` answers plenty. The unread half is applied in
    // `rescuedByReply` instead.
    expect(gmailRepliedQuery(14)).not.toContain('is:unread')
  })

  test('stays out of the bins', () => {
    expect(gmailRepliedQuery(14)).toContain('-in:trash')
    expect(gmailRepliedQuery(14)).toContain('-in:spam')
  })
})

/* ------------------------ the query as a setting --------------------------- */

/**
 * Read the query back out of a fresh process.
 *
 * The settings are resolved once at import, which is correct for the server and
 * useless for a test in a suite that shares one process — so configurability is
 * checked the way the operator will actually exercise it: by setting the
 * variable and starting Wake.
 */
const queryUnder = (env: Record<string, string>, days = 14): string => {
  const r = Bun.spawnSync({
    cmd: ['bun', '-e', `const m = await import(${JSON.stringify(`${process.cwd()}/src/server/env.ts`)}); console.log(m.gmailCardQuery(${days}) + '\\n' + m.GMAIL_PAGE_SIZE)`],
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return new TextDecoder().decode(r.stdout).trim()
}

describe('the query is a setting, not a string buried in the adapter', () => {
  test('a shorter category list asks a wider question', () => {
    const q = queryUnder({ WAKE_GMAIL_EXCLUDE_CATEGORIES: 'promotions' })
    expect(q).toContain('-category:promotions')
    expect(q).not.toContain('-category:updates')
  })

  test('an empty value clears the list, because widening has to be possible too', () => {
    // `str()` would read an empty value as absent and hand back the default,
    // which is the tool arguing with a person who typed `=` and meant it. If he
    // misses one mail because of this filter, this is the line he edits.
    const q = queryUnder({ WAKE_GMAIL_EXCLUDE_SENDERS: '' })
    expect(q).not.toContain('-from:noreply')
    expect(q).toContain('-category:updates')

    const wide = queryUnder({ WAKE_GMAIL_EXCLUDE_CATEGORIES: '', WAKE_GMAIL_EXCLUDE_SENDERS: '' })
    expect(wide).toContain('is:unread in:inbox newer_than:14d')
    expect(wide).not.toContain('-category:')
    expect(wide).not.toContain('-from:')
  })

  test('an extra clause is appended verbatim, for the query nobody predicted', () => {
    expect(queryUnder({ WAKE_GMAIL_QUERY_EXTRA: '-from:linkedin' })).toContain('-from:linkedin')
  })

  test('the page size is clamped to the 50 the server will actually accept', () => {
    // gmailmcp.googleapis.com answers `page_size must be greater than 0 and less
    // than or equal to 50` and fails the whole request — a poll lost to a number
    // somebody typed.
    expect(queryUnder({ WAKE_GMAIL_PAGE_SIZE: '500' })).toEndWith('\n50')
    expect(queryUnder({ WAKE_GMAIL_PAGE_SIZE: '0' })).toEndWith('\n1')
    expect(GMAIL_PAGE_SIZE).toBeLessThanOrEqual(50)
  })
})

/* -------------------- the rule the narrowing may not overrule -------------- */

const msg = (m: Partial<Parameters<typeof addressedToMe>[0][number]>) => ({ ...m })
const unread = { labelIds: ['UNREAD', 'INBOX'] }

describe('mail addressed to him survives the filter', () => {
  test('he is a named recipient', () => {
    expect(addressedToMe([msg({ toRecipients: ['me@example.com'] })], ME)).toBe(true)
  })

  test('through a display name, and whatever the casing', () => {
    expect(addressedToMe([msg({ toRecipients: ['Me Myself <ME@Example.COM>'] })], ME)).toBe(true)
    expect(addressOf('Ada Lovelace <Ada@Example.com>')).toBe('ada@example.com')
  })

  test('any of his configured addresses counts', () => {
    expect(addressedToMe([msg({ toRecipients: ['team@example.com'] })], ME)).toBe(true)
  })

  test('anywhere in the thread, not only in the newest message', () => {
    // "Yuvraj — can you look at this?" followed by a reply-all to the group is
    // still on him, and it is exactly the shape a filter tuned for noise throws
    // away. Note this is a different question from the card's `direct` flag,
    // which asks only about the newest message and decides the pile.
    const thread = [
      msg({ toRecipients: ['me@example.com'] }),
      msg({ toRecipients: ['everyone@example.com'] }),
    ]
    expect(addressedToMe(thread, ME)).toBe(true)
  })

  test('but mail to a crowd he is not named in does not', () => {
    expect(addressedToMe([msg({ toRecipients: ['everyone@example.com'] })], ME)).toBe(false)
    expect(addressedToMe([msg({})], ME)).toBe(false)
  })

  test('and it survives with no importance marker anywhere in sight', () => {
    // The whole point of rule four: Gmail's opinion is not consulted here.
    const thread = [msg({ toRecipients: ['me@example.com'], labelIds: ['UNREAD'] })]
    expect(survivesFilter(thread, ME)).toBe(true)
  })
})

describe('a thread he has replied to survives the filter', () => {
  test('because he is in it', () => {
    expect(iReplied([msg({ sender: 'Me <me@example.com>' })], ME)).toBe(true)
    expect(iReplied([msg({ from: 'team@example.com' })], ME)).toBe(true)
  })

  test('and a thread he has only been sent is not one he replied to', () => {
    expect(iReplied([msg({ sender: 'someone@example.com' })], ME)).toBe(false)
  })

  test('survivesFilter takes either half', () => {
    expect(survivesFilter([msg({ sender: 'me@example.com' })], ME)).toBe(true)
    expect(survivesFilter([msg({ toRecipients: ['me@example.com'] })], ME)).toBe(true)
    expect(survivesFilter([msg({ sender: 'bulk@example.com', toRecipients: ['all@example.com'] })], ME)).toBe(false)
  })
})

describe('what the replied query is allowed to put back on the desk', () => {
  test('a thread he answered that has something new in it', () => {
    const thread = [msg({ sender: 'me@example.com' }), msg({ sender: 'customer@example.com', ...unread })]
    expect(rescuedByReply(thread, ME)).toBe(true)
  })

  test('but not one he has already read to the end', () => {
    // `from:me` is not restricted to unread, so without this gate the rescue
    // hands back every conversation he has touched in a fortnight — the exact
    // flood the change exists to stop.
    const thread = [msg({ sender: 'me@example.com', labelIds: ['INBOX'] })]
    expect(rescuedByReply(thread, ME)).toBe(false)
  })

  test('and not one that merely claims to be his', () => {
    // An alias, a delegated mailbox or his address quoted inside a forward all
    // satisfy Gmail's `from:me`. The local check is against ME.emails.
    const thread = [msg({ sender: 'someone-else@example.com', ...unread })]
    expect(rescuedByReply(thread, ME)).toBe(false)
  })

  test('unread is read off the label, or off a boolean, or fails closed', () => {
    expect(hasUnread([msg({ labelIds: ['UNREAD'] })])).toBe(true)
    expect(hasUnread([msg({ unread: true })])).toBe(true)
    expect(hasUnread([msg({ isUnread: true })])).toBe(true)
    // No label information at all reads as "not unread": failing closed costs a
    // row, failing open costs the desk.
    expect(hasUnread([msg({})])).toBe(false)
  })
})

/* ---------------------------- the wiring itself ---------------------------- */

/**
 * Read off the source, in the same spirit as `gmail-thread.test.ts`: driving
 * `fetch()` needs a credential and a live MCP session, and what is worth pinning
 * is that the adapter no longer owns the query and no longer produces two rows
 * for one conversation.
 */
const adapter = readFileSync('src/server/sources/gmail.ts', 'utf8')

describe('the adapter asks both questions and joins the answers', () => {
  test('neither query is written in this file any more', () => {
    expect(adapter).toContain('gmailCardQuery()')
    expect(adapter).toContain('gmailRepliedQuery()')
    expect(adapter).not.toMatch(/const query = `is:unread/)
  })

  test('the page size is the setting, not a literal', () => {
    expect(adapter).toContain('pageSize: GMAIL_PAGE_SIZE')
    expect(adapter).not.toContain('pageSize: 30')
  })

  test('one conversation is one card, whichever query found it', () => {
    expect(adapter).toContain('carded.has(id)')
    expect(adapter).toContain('carded.add(id)')
  })

  test('the rescue is gated, and skipped when the first query already failed', () => {
    expect(adapter).toContain('rescuedByReply(th.messages ?? [], ME.emails)')
    expect(adapter).toContain('GMAIL_RESCUE_REPLIED')
  })

  test('both searches are recorded, so half an answer is not reported as a whole one', () => {
    expect(adapter).toMatch(/settled\.push\(\{ status: 'fulfilled'/)
    expect(adapter).toMatch(/settled\.push\(\{ status: 'rejected'/)
  })
})
