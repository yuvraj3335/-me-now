/**
 * Gmail's two smaller versions of the same two bugs.
 *
 * A mail thread was already one card, so the row-per-message problem never
 * existed here — but the *later* messages in that thread were thrown away, so a
 * conversation that had moved on looked exactly like one that had not. And the
 * card's link was not a link: `mail/u/<address>` is not a Gmail URL, because the
 * `u/` segment is an account index rather than a mailbox name.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const gmail = readFileSync('src/server/sources/gmail.ts', 'utf8')

describe('a Gmail card links somewhere Gmail actually is', () => {
  test('no url interpolates an address into the account index', () => {
    // `https://mail.google.com/mail/u/yuvraj%40truto.one/#inbox/…` either 404s
    // or lands on whichever mailbox happens to be signed in first. The segment
    // takes a number.
    expect(gmail).not.toMatch(/mail\/u\/\$\{/)
    expect(gmail).toContain('https://mail.google.com/mail/u/0/#inbox/')
  })

  test('and nowhere else builds one either', () => {
    for (const f of ['src/server/sources/search.ts', 'src/server/mail/service.ts']) {
      expect(readFileSync(f, 'utf8'), `${f} mints an address-indexed Gmail url`)
        .not.toMatch(/mail\/u\/\$\{/)
    }
  })
})

describe('a later message in a thread is activity, not a new card', () => {
  test('the card carries the messages the search already returned', () => {
    // `search_threads` hands back the whole `messages` array; the poller read
    // the last one for a snippet and dropped the rest on the floor.
    expect(gmail).toMatch(/messages:\s*msgs\.slice\(-20\)/)
    expect(gmail).toMatch(/replies:\s*Math\.max\(msgs\.length - 1, 0\)/)
  })

  test('and marks his own, so replying is not the thread chasing him', () => {
    expect(gmail).toMatch(/mine:\s*ME\.emails\.includes/)
  })
})
