/**
 * A pull request, an issue, a thread, a DM, a Sentry alert and a Claude session
 * are six different things, and the row has to say which without being read.
 *
 * Twenty rows used to differ by the hue of one 7px dot — which cannot tell a PR
 * from an issue at all, because both are GitHub. This pins the three axes that
 * replaced it: the glyph is the kind, the colour is the source, and `Where` is
 * the context in the vocabulary its own system uses.
 *
 * It is a unit test rather than a capture because the operator's live piles hold
 * no Sentry, Slack or Gmail card today, so nothing on the page can demonstrate
 * the distinction those three are for.
 */

import { describe, expect, test } from 'bun:test'
import { headTruncate, kindOf, whereOf } from '../src/web/components/kinds'
import type { Card, CardSource } from '../src/web/lib/types'

describe('the glyph is the kind', () => {
  test('every kind gets its own word and its own mark', () => {
    const seen = [
      kindOf('github', 'my_pr', { is_pr: true }),
      kindOf('github', 'assigned', { is_pr: false }),
      kindOf('github', 'review', { is_pr: true }),
      kindOf('slack', 'thread', {}),
      kindOf('slack', 'dm', { is_dm: true }),
      kindOf('gmail', 'email', {}),
      kindOf('sentry', 'error', {}),
      kindOf('claude', 'session', {}),
    ]
    expect(seen.map(k => k.word)).toEqual([
      'PR', 'Issue', 'Review', 'Thread', 'DM', 'Mail', 'Alert', 'Session',
    ])
    // Eight kinds, eight distinct marks — no two share a glyph.
    expect(new Set(seen.map(k => k.Icon)).size).toBe(8)
  })

  test('a PR and an issue from the same source are different marks', () => {
    const pr = kindOf('github', 'assigned', { is_pr: true })
    const issue = kindOf('github', 'assigned', { is_pr: false })
    expect(pr.Icon).not.toBe(issue.Icon)
    // …and the same colour, because they are the same source. Colour is the
    // source; the glyph is the kind.
    expect(pr.source).toBe(issue.source)
  })
})

describe('Where is the context in its own vocabulary', () => {
  const card = (source: CardSource['source'], meta: Record<string, any>, account?: string) => {
    const s = { source, kind: '', url: '', ts: 0, title: '', why: '', meta, account } as CardSource
    return [s, { sources: [s], meta: {} } as unknown as Card] as const
  }

  test('a repo, a channel and a project do not look alike', () => {
    expect(whereOf(...card('github', { repo: 'trutohq/truto' }))).toBe('trutohq/truto')
    expect(whereOf(...card('slack', { channel: 'eng-platform' }))).toBe('#eng-platform')
    expect(whereOf(...card('claude', { project: 'truto' }))).toBe('truto')
    expect(whereOf(...card('sentry', { project: 'truto-api' }))).toBe('truto-api')
    expect(whereOf(...card('gmail', {}, 'yuvraj@truto.one'))).toBe('yuvraj@truto.one')
  })

  test('a direct message says so rather than naming a channel it has none of', () => {
    expect(whereOf(...card('slack', { is_dm: true }))).toBe('DM')
  })

  test('a source that knows no context renders empty, not a guess', () => {
    expect(whereOf(...card('github', {}))).toBeNull()
  })
})

describe('truncation keeps the half that differs', () => {
  test('a long repo is cut from the head', () => {
    // `trutohq/truto-app` cut from the right is `trutohq/tru…`, which is the
    // half that is identical on every row.
    expect(headTruncate('trutohq/truto-app', 13)).toBe('…hq/truto-app')
  })

  test('one that fits is left alone', () => {
    expect(headTruncate('trutohq/truto', 13)).toBe('trutohq/truto')
  })
})

test('a Slack channel is prefixed once', () => {
  // The search result names the channel `#truto` and the poller stores that
  // verbatim; prefixing again rendered `##truto` in the Where column. It was
  // invisible for as long as that column was dropped at every laptop width.
  const card = { meta: {}, sources: [] } as any
  const src = (channel: string) => ({ source: 'slack', meta: { channel }, kind: 'mention' }) as any
  expect(whereOf(src('#truto'), card)).toBe('#truto')
  expect(whereOf(src('truto'), card)).toBe('#truto')
  expect(whereOf({ source: 'slack', meta: { is_dm: true }, kind: 'dm' } as any, card)).toBe('DM')
})
