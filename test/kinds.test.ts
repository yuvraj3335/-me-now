/**
 * A pull request, an issue, a thread, a machine's page, a Sentry alert and a
 * Claude session are six different things, and the row has to say which without
 * being read.
 *
 * Twenty rows used to differ by the hue of one 7px dot — which cannot tell a PR
 * from an issue at all, because both are GitHub. This pins the three axes that
 * replaced it: the glyph is the kind, the colour is the source, and the context
 * is named in the vocabulary its own system uses.
 *
 * It is a unit test rather than a capture because the operator's live desk holds
 * no Sentry, Slack or Gmail card today, so nothing on the page can demonstrate
 * the distinction those three are for.
 */

import { describe, expect, test } from 'bun:test'
import { cardKind, cleanChannel, crispMeta, headTruncate, kindOf, whereOf } from '../src/web/components/kinds'
import { bucketOf } from '../src/web/lib/bucket'
import type { Card, CardSource } from '../src/web/lib/types'

describe('the glyph is the kind', () => {
  test('every kind gets its own word and its own mark', () => {
    const seen = [
      kindOf('github', 'my_pr', { is_pr: true }),
      kindOf('github', 'assigned', { is_pr: false }),
      kindOf('github', 'review', { is_pr: true }),
      kindOf('slack', 'thread', {}),
      kindOf('slack', 'alert', { alert: true }),
      kindOf('gmail', 'email', {}),
      kindOf('sentry', 'error', {}),
      kindOf('claude', 'session', {}),
    ]
    expect(seen.map(k => k.word)).toEqual([
      'PR', 'Issue', 'Review', 'Thread', 'Alert', 'Mail', 'Alert', 'Session',
    ])
    // Eight rows, eight distinct marks — no two share a glyph. Two of them
    // share the *word* `Alert` deliberately: a Sentry issue and the Slack
    // message announcing it are one event told twice, and the dedup engine
    // merges them wherever it can prove they are the same one. The assertion is
    // on the icon set, which is what the eye actually reads.
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

describe('Crisp — a visitor, not a monitor', () => {
  const crispSource = (metaOver: Record<string, any> = {}): CardSource => ({
    source: 'slack', kind: 'crisp', url: '', ts: 0, title: 'Priya', why: '',
    meta: { channel: 'crisp-chats', family: 'crisp', crisp_state: 'unresolved', reply_total: 3, ...metaOver },
  } as CardSource)

  test('its own word and its own mark, distinct from a thread and an alert', () => {
    const chat = kindOf('slack', 'crisp', {})
    expect(chat.word).toBe('Chat')
    expect(chat.Icon).not.toBe(kindOf('slack', 'thread', {}).Icon)
    expect(chat.Icon).not.toBe(kindOf('slack', 'alert', {}).Icon)
  })

  test('it buckets to Slack — a visitor is not a monitor', () => {
    // `kind: 'crisp'` is not `kind: 'alert'`, so the gate in `bucketOf` that
    // sends every Slack alert to the Alerts tab leaves a Crisp conversation
    // exactly where a human thread stays.
    expect(bucketOf(crispSource())).toBe('slack')
  })

  test('an unresolved one reads as waiting, in the bad token rather than the accent', () => {
    const card = { kind: 'crisp', sources: [crispSource()], meta: {} } as unknown as Card
    const kind = cardKind(card)
    expect(kind.word).toBe('waiting')
    expect(kind.tint).toBe('var(--color-bad)')
    expect(crispMeta(card)).toEqual({ unresolved: true, replies: 3 })
  })

  test('a resolved one is a quiet Chat, with nothing spent on it', () => {
    const card = {
      kind: 'crisp',
      sources: [crispSource({ crisp_state: 'resolved', reply_total: 5 })],
      meta: {},
    } as unknown as Card
    const kind = cardKind(card)
    expect(kind.word).toBe('Chat')
    expect(kind.tint).toBeUndefined()
    expect(crispMeta(card)).toEqual({ unresolved: false, replies: 5 })
  })
})

describe('Where is the context in its own vocabulary', () => {
  const card = (source: CardSource['source'], meta: Record<string, any>, account?: string) => {
    const s = { source, kind: '', url: '', ts: 0, title: '', why: '', meta, account } as CardSource
    return [s, { sources: [s], meta: {} } as unknown as Card] as const
  }

  test('a repo, a channel and a project do not look alike', () => {
    expect(whereOf(...card('github', { repo: 'trutohq/truto' }))).toBe('trutohq/truto')
    expect(whereOf(...card('slack', { channel: 'eng-platform' }))).toBe('eng-platform')
    expect(whereOf(...card('claude', { project: 'truto' }))).toBe('truto')
    expect(whereOf(...card('sentry', { project: 'truto-api' }))).toBe('truto-api')
    expect(whereOf(...card('gmail', {}, 'yuvraj@truto.one'))).toBe('yuvraj@truto.one')
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

describe('a channel label drops the part that is on every row', () => {
  // The workspace's own name is in most channel names — `<partner>-truto` for a
  // shared channel, `truto-<topic>` for an internal one — so on a desk read
  // entirely from one workspace it identifies nothing. `#truto-15-5-truto` is
  // the real worst case: the token at both ends, wrapping two characters of
  // actual information.
  test('the workspace token goes, from either end or both', () => {
    expect(cleanChannel('#truto-15-5-truto')).toBe('15-5')
    expect(cleanChannel('#spendflo-truto')).toBe('spendflo')
    expect(cleanChannel('#truto-api-alerts')).toBe('api-alerts')
  })

  test('a name that does not carry it is left alone', () => {
    expect(cleanChannel('#sentry-alerts')).toBe('sentry-alerts')
    expect(cleanChannel('#maximor-truto')).toBe('maximor')
    expect(cleanChannel('#15five-truto')).toBe('15five')
  })

  test('a name made only of the workspace token survives whole', () => {
    // Stripping it would leave an empty label, and a blank is worse than a
    // redundant word.
    expect(cleanChannel('#truto')).toBe('truto')
    expect(cleanChannel('truto')).toBe('truto')
  })

  test('a resolved id trailing the name is not part of the name', () => {
    expect(cleanChannel('#sentry-alerts (ID: C0BERTMS9K4)')).toBe('sentry-alerts')
  })

  test('the prefix is stripped once, however many there are', () => {
    // The search result names the channel `#truto` and the poller stores that
    // verbatim; prefixing again rendered `##truto` in the old Where column.
    const card = { meta: {}, sources: [] } as any
    const src = (channel: string) => ({ source: 'slack', meta: { channel }, kind: 'mention' }) as any
    expect(whereOf(src('#truto'), card)).toBe('truto')
    expect(whereOf(src('truto'), card)).toBe('truto')
  })
})
