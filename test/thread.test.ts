/**
 * The conversation the detail pane draws.
 *
 * Everything here is already on the card — the Slack adapter reads each thread
 * once per poll, Gmail's search returns its own `messages` array — so this is
 * about shaping, not fetching, and about one number the UI must never compute
 * for itself. `+N` and the amber edge are the server's arithmetic; this file
 * decides only what is shown, in what order, and which lines carry a mark.
 *
 * The timestamp conversion is the part that silently breaks. A Slack ts is
 * seconds with six digits of microseconds after the dot, and reading the whole
 * fraction as milliseconds puts every message twelve minutes late — late enough
 * to look plausible and wrong enough to mis-mark which replies are new.
 */

import { describe, expect, test } from 'bun:test'
import { baselineOf, entryMs, replyTotal, threadLines } from '../src/web/lib/thread'
import type { Card, CardSource } from '../src/web/lib/types'

const source = (over: Partial<CardSource>): CardSource => ({
  source: 'slack', kind: 'thread', url: 'https://truto.slack.com/archives/C1/p1',
  ts: 1_787_812_499_720, title: 'a thread', why: 'you were mentioned in #truto',
  meta: {}, ...over,
})

const card = (over: Partial<Card>): Card => ({
  group_key: 'slackthread:C04D9HKDWAV:1787812499.720579',
  pile: 'now', title: 'a thread', why: 'you were mentioned in #truto',
  url: 'https://truto.slack.com/archives/C1/p1', kind: 'mention',
  ts: 1_787_812_499_720, first_seen_at: 1_787_000_000_000,
  status: 'not_started', activity: { count: 0, tagged: false, at: null },
  meta: {}, sources: [], state: null, tasks: [], ...over,
})

/** The live shape, from FIXTURES §1: parent, replies, his own among them. */
const slackThread = () =>
  card({
    sources: [source({
      meta: {
        channel: '#truto', channel_id: 'C04D9HKDWAV', is_dm: false,
        thread_ts: '1787812499.720579', replies: 10,
        parent: {
          ts: '1787812499.720579', who: 'Nidhi', who_id: 'U0BBZV4HQHH',
          text: '@Yuvraj Muley, can you confirm the clearing behavior',
          tagged: true, mine: false,
        },
        thread: [
          {
            ts: '1787814333.427979', who: 'Yuvraj Muley', who_id: 'U09617LRRDF',
            text: 'all they care is they need a trigger', tagged: false, mine: true,
          },
          {
            ts: '1787820616.819949', who: 'Riya', who_id: 'U0B5V7G3NQ5',
            text: 'Added comments', tagged: false, mine: false,
          },
        ],
      },
    })],
  })

describe('a timestamp means the same thing whichever system stamped it', () => {
  test('a Slack ts keeps only the milliseconds of its fraction', () => {
    // `.720579` is 720ms and a uniqueness tail, not 720 seconds.
    expect(entryMs('1787812499.720579')).toBe(1_787_812_499_720)
    expect(entryMs('1787814333.427979')).toBe(1_787_814_333_427)
  })

  test('a short fraction is padded rather than misread', () => {
    expect(entryMs('1787812499.7')).toBe(1_787_812_499_700)
    expect(entryMs('1787812499.72')).toBe(1_787_812_499_720)
  })

  test('a Gmail epoch is already milliseconds', () => {
    expect(entryMs(1_787_812_499_720)).toBe(1_787_812_499_720)
    expect(entryMs('1787812499720')).toBe(1_787_812_499_720)
  })

  test('anything that is not a timestamp is null, not zero', () => {
    // Zero renders as 1970, which reads as a real date. Null renders as nothing.
    expect(entryMs(undefined)).toBeNull()
    expect(entryMs(null)).toBeNull()
    expect(entryMs('')).toBeNull()
    expect(entryMs('not a ts')).toBeNull()
    expect(entryMs(Number.NaN)).toBeNull()
  })
})

describe('the pane reads downward', () => {
  test('the parent comes first and the replies follow in order', () => {
    const lines = threadLines(slackThread())
    expect(lines.map(l => l.text)).toEqual([
      '@Yuvraj Muley, can you confirm the clearing behavior',
      'all they care is they need a trigger',
      'Added comments',
    ])
    expect(lines[0]!.parent).toBe(true)
    expect(lines[1]!.parent).toBe(false)
  })

  test('a reply that names him carries the mark that explains the row', () => {
    const lines = threadLines(slackThread())
    expect(lines[0]!.tagged).toBe(true)
    expect(lines.filter(l => l.tagged).length).toBe(1)
  })

  test('his own replies are still drawn — they are just not news', () => {
    // `mine` is what the server excluded from the count. The pane still shows
    // them, because a conversation with his own answers removed is not one.
    const lines = threadLines(slackThread())
    expect(lines.filter(l => l.mine).length).toBe(1)
  })

  test('a thread with no read still draws whatever it has', () => {
    const partial = card({
      sources: [source({ meta: { thread_partial: true, replies: 0, parent: null, thread: [] } })],
    })
    expect(threadLines(partial)).toEqual([])
  })

  test('a Gmail thread is the same list from a different shape', () => {
    const mail = card({
      kind: 'email',
      sources: [source({
        source: 'gmail', kind: 'email', account: 'yuvraj@truto.one',
        meta: {
          replies: 2,
          messages: [
            { ts: 1_787_800_000_000, who: 'Ana', snippet: 'the first one', mine: false },
            { ts: 1_787_900_000_000, who: null, snippet: 'the second', mine: true },
          ],
        },
      })],
    })
    const lines = threadLines(mail)
    expect(lines.map(l => l.text)).toEqual(['the first one', 'the second'])
    expect(lines[0]!.at).toBe(1_787_800_000_000)
    expect(lines[1]!.mine).toBe(true)
    // Gmail carries no notion of being named: that is the card's `why`, not a
    // mark on one message.
    expect(lines.some(l => l.tagged)).toBe(false)
  })

  test('one conversation seen on two member cards is drawn once', () => {
    const dup = slackThread()
    const twin = { ...dup, sources: [...dup.sources, dup.sources[0]!] }
    expect(threadLines(twin).length).toBe(threadLines(dup).length)
  })

  test('an empty body never becomes a line', () => {
    const blank = card({
      sources: [source({
        meta: {
          parent: { ts: '1.0', who: 'A', who_id: 'U1', text: '', tagged: false, mine: false },
          thread: [{ ts: '2.0', who: 'B', who_id: 'U2', text: '', tagged: false, mine: false }],
        },
      })],
    })
    expect(threadLines(blank)).toEqual([])
  })

  test('a card with nothing conversational on it has no thread at all', () => {
    expect(threadLines(card({ sources: [source({ source: 'github', kind: 'my_pr' })] }))).toEqual([])
  })
})

describe('the counts come from the source, not from the array', () => {
  test('the reply total is what Slack itself reported', () => {
    // Only the newest twenty are stored, and the thread header's number is
    // authoritative. Counting the array would call a long thread short.
    expect(replyTotal(slackThread())).toBe(10)
    expect(threadLines(slackThread()).length).toBe(3)
  })

  test('a card with no total reports none rather than guessing', () => {
    expect(replyTotal(card({ sources: [source({ meta: {} })] }))).toBe(0)
  })
})

describe('the baseline is the same one the server counted against', () => {
  test('an acknowledged card measures from the acknowledgement', () => {
    const c = card({
      state: {
        acked_at: 1_787_500_000_000, snoozed_until: null, notified_at: null,
        pinned: false, pile_override: null,
      },
    })
    expect(baselineOf(c)).toBe(1_787_500_000_000)
  })

  test('an untouched card measures from when it first appeared', () => {
    // Otherwise a thread that already had ten replies on it the moment it
    // arrived would draw all ten in the brighter ink as though they were new.
    expect(baselineOf(card({}))).toBe(1_787_000_000_000)
  })
})
