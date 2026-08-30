/**
 * Fetch — pipe 2, and the two places it could quietly become something else.
 *
 * The structural half (one spawn site, `--print`, a read-only allowlist, a turn
 * ceiling, a timeout, no free-text input) is asserted in `ui-contract.test.ts`.
 * This file tests the behaviour that decides whether a row is honest: what
 * survives validation, and where `why` comes from.
 */

import { describe, expect, test } from 'bun:test'
import { parseRows } from '../src/server/fetch/claude'
import { whyFrom } from '../src/server/fetch'

describe('only schema-valid objects are read', () => {
  test('a fenced array is unwrapped', () => {
    // Measured against the real binary: asked for JSON, it answers inside a
    // ```json fence about half the time.
    const rows = parseRows('```json\n[{"id":"C1:1.2","title":"ping","bucket":"waiting"}]\n```')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('ping')
  })

  test('prose is dropped rather than rendered', () => {
    // The property that keeps model output off a pixel. Anything that is not an
    // array of objects is not repaired, explained or shown — it is nothing.
    expect(parseRows('I looked and found three things worth your time.')).toEqual([])
    expect(parseRows('{"id":"x","title":"y"}')).toEqual([])
    expect(parseRows('```json\n[not json\n```')).toEqual([])
  })

  test('an element without an id or a title does not become a row', () => {
    const rows = parseRows(JSON.stringify([
      { title: 'no id' },
      { id: 'no title' },
      { id: 'C1:1.2', title: 'both' },
    ]))
    expect(rows.map(r => r.title)).toEqual(['both'])
  })

  test('a url that is not a link is dropped, not rendered', () => {
    // A row's url becomes an `<a href>` and a `{t:'url'}` reference. `javascript:`
    // and `wake:` are neither.
    const rows = parseRows(JSON.stringify([
      { id: 'a', title: 'a', url: 'javascript:alert(1)' },
      { id: 'b', title: 'b', url: 'https://truto.slack.com/archives/C1/p1' },
    ]))
    expect(rows[0]!.url).toBeNull()
    expect(rows[1]!.url).toBe('https://truto.slack.com/archives/C1/p1')
  })

  test('a secret in a collected line is masked before it is stored', () => {
    const rows = parseRows(JSON.stringify([
      { id: 'a', title: 'deploy key', evidence: 'use xoxb-1234567890abcdef to test' },
    ]))
    expect(rows[0]!.evidence).not.toContain('xoxb-1234567890abcdef')
    expect(rows[0]!.evidence).toContain('redacted')
  })

  test('bucket is an enum, not free text', () => {
    // `bucket` decides the pile. Anything unrecognised reads as `open`, so a
    // collector cannot promote its own findings into the Now pile.
    const rows = parseRows(JSON.stringify([
      { id: 'a', title: 'a', bucket: 'urgent' },
      { id: 'b', title: 'b', bucket: 'waiting' },
    ]))
    expect(rows[0]!.bucket).toBe('open')
    expect(rows[1]!.bucket).toBe('waiting')
  })
})

describe('why is a rule firing, not a sentence somebody wrote', () => {
  test('evidence decides it, through the same table the Slack poller uses', () => {
    expect(whyFrom('can you take a look at this today?', 'waiting')).toBe('a direct request')
    expect(whyFrom('I am blocked on the token change', 'waiting')).toBe('someone is blocked')
    expect(whyFrom('any update on the migration', 'waiting')).toBe('someone is chasing an update')
  })

  test('no evidence means a fixed neutral phrase', () => {
    // Never a better guess. A row whose reason cannot be traced to a quoted
    // substring gets the plainest thing that is still true.
    expect(whyFrom(null, 'waiting')).toBe('you were named')
    expect(whyFrom(null, 'open')).toBe('open where you are named')
    expect(whyFrom('the deploy finished', 'open')).toBe('open where you are named')
  })
})
