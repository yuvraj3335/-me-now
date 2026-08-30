/**
 * Gmail's smaller version of the same bug.
 *
 * A mail thread was already one card, so the row-per-message problem never
 * existed here — but the *later* messages in that thread were thrown away. The
 * card's `ts` moved when somebody replied and nothing said why, so a
 * conversation that had moved on looked exactly like one that had not.
 *
 * Read off the source rather than driven through the adapter, deliberately:
 * `fetch()` needs a credential and a live MCP session, and the fact being pinned
 * is that the `messages` array `search_threads` already returns reaches `meta`
 * at all. A test that mocked the transport would be pinning the mock.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const gmail = readFileSync('src/server/sources/gmail.ts', 'utf8')

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

  test('the thread key is the thread, so a reply lands on the card that exists', () => {
    // The identity was never the bug here and it must not become one: two
    // messages of one conversation share `account:threadId`, which is what makes
    // the second an update rather than a row.
    expect(gmail).toContain('source_id: `${account}:${id}`')
    expect(gmail).toContain("{ t: 'gmailthread', v: `${account}:${id}` }")
  })
})
