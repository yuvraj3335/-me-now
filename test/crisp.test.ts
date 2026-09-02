/**
 * Crisp, through Slack.
 *
 * Crisp posts one message per website conversation into `#crisp-chats`, from
 * the `Truto` bot, and carries the conversation's state as an attachment:
 * `:white_check_mark: Conversation is resolved.` or `:bangbang: Conversation is
 * unresolved. Please reply.` The second is the only Crisp fact that is on him —
 * a visitor is sitting in a chat window waiting — so it is the one that lands
 * in `now`, carries `who`, and (in `push.ts`) buzzes.
 *
 * The wire text below is the shape `slack_read_channel` answered with on
 * 2026-09-02, with one unresolved conversation added in the documented shape:
 * every read that day happened to be resolved, and a parser tested only on the
 * quiet case is a parser tested on the case that does not matter.
 */

import { describe, expect, test } from 'bun:test'
import { crispCard, historyCardsForRow, parseChannelMessages } from '../src/server/sources/slack'
import { getChannel, updateChannel } from '../src/server/slackScope'
import { ME_ID } from './fixtures/slack'

const CRISP = 'C07351C8Z8E'

const WIRE = `Channel: #crisp-chats (C07351C8Z8E)

=== Message from Truto (B072X3H2YCF) at 2026-08-31 11:20:51 IST ===
Message TS: 1788155451.756859
:speech_balloon: Crisp conversation from Jatin Fulwani.
Thread: 4 replies (latest: 2026-08-31 11:22:17 IST)
Attachment: :white_check_mark: Conversation is resolved.

=== Message from Truto (B072X3H2YCF) at 2026-09-02 09:00:00 IST ===
Message TS: 1788320000.000001
:speech_balloon: Crisp conversation from Julie Anne Moore.
Attachment: :bangbang: Conversation is unresolved. Please reply.

=== Message from Nidhi <nidhi@truto.one> (U0BBZV4HQHH) at 2026-08-26 11:23:38 IST ===
Message TS: 1787723618.004999
<@U09PY5XUE3V|Sidharth Verma> can you check the Crisp chat and reply, or direct me
Thread: 10 replies (latest: 2026-08-26 11:42:43 IST)

=== Message from Truto (B072X3H2YCF) at 2026-08-28 00:50:35 IST ===
Message TS: 1787858435.563339
:speech_balloon: Crisp conversation from Rautlata59.
Thread: 8 replies (latest: 2026-08-28 01:04:09 IST)
Attachment: :white_check_mark: Conversation is resolved.
`

const hits = () => parseChannelMessages(WIRE, CRISP)
const row = () => getChannel(CRISP)!

describe('the channel read survives the parser with what Crisp needs', () => {
  test('four messages, the bot id on three, the attachment line kept', () => {
    const h = hits()
    expect(h).toHaveLength(4)
    expect(h.filter(x => x.fromId === 'B072X3H2YCF')).toHaveLength(3)
    expect(h[0]!.text).toContain('Attachment: :white_check_mark: Conversation is resolved.')
    expect(h[1]!.text).toContain('Conversation is unresolved')
    expect(h[2]!.fromEmail).toBe('nidhi@truto.one')
  })
})

describe('a Crisp card', () => {
  test('an unresolved conversation is a visitor waiting, now', () => {
    const c = crispCard(row(), hits()[1]!)!
    expect(c).toMatchObject({
      source: 'slack',
      kind: 'crisp',
      source_id: `${CRISP}:1788320000.000001`,
      title: 'Julie Anne Moore',
      who: 'Julie Anne Moore',
      pile: 'now',
      why: 'a visitor is waiting for a reply on Crisp',
    })
    expect(c.meta).toMatchObject({
      channel: 'crisp-chats', channel_id: CRISP, family: 'crisp',
      crisp_state: 'unresolved', visitor: 'Julie Anne Moore', reply_total: 0,
    })
    expect(c.refs).toEqual([{ t: 'slackthread', v: `${CRISP}:1788320000.000001` }])
    expect(c.url).toBe(`https://truto.slack.com/archives/${CRISP}/p1788320000000001`)
  })

  test('a resolved one is history — open, no `who`, quiet', () => {
    const c = crispCard(row(), hits()[0]!)!
    expect(c.pile).toBe('open')
    expect(c.who).toBeUndefined()
    expect(c.meta?.crisp_state).toBe('resolved')
    expect(c.meta?.reply_total).toBe(4)
    expect(c.why).toBe('a Crisp conversation, resolved')
  })

  test('an attachment it does not recognise reads as unresolved — the expensive miss', () => {
    const odd = { ...hits()[0]!, text: ':speech_balloon: Crisp conversation from Someone.\nAttachment: :grey_question: Conversation state unknown.' }
    expect(crispCard(row(), odd)!.meta?.crisp_state).toBe('unresolved')
  })

  test('a bot post that is not a Crisp conversation is not a Crisp card', () => {
    expect(crispCard(row(), { ...hits()[0]!, text: 'Deploy finished.' })).toBeNull()
  })

  test('the visitor\'s words are never the title — only their name is', () => {
    // The excerpt is what carries what was said, redacted and cut like every
    // other Slack card; the title is the name Crisp gave, which is the one
    // field the desk sorts and searches on.
    const c = crispCard(row(), hits()[1]!)!
    expect(c.title).toBe('Julie Anne Moore')
    expect(c.excerpt).not.toContain('Attachment:')
  })
})

describe('the whole channel, through the history rule', () => {
  test('bot posts become Crisp cards and a human post follows the wholesale rule', () => {
    const cards = historyCardsForRow(row(), hits(), ME_ID)
    const kinds = cards.map(c => c.kind).sort()
    // Three Crisp cards, and Nidhi's thread — a teammate post WITH replies is an
    // open conversation, so it is a row.
    expect(kinds).toEqual(['crisp', 'crisp', 'crisp', 'mention'])
    const human = cards.find(c => c.kind === 'mention')!
    expect(human.pile).toBe('open')
    expect(human.meta?.replies).toBe(10)
  })

  test('at mentions, only the visitor still waiting comes through', () => {
    const before = row()
    updateChannel(CRISP, { mode: 'mentions' })
    try {
      const cards = historyCardsForRow(row(), hits(), ME_ID)
      expect(cards.map(c => c.title)).toEqual(['Julie Anne Moore'])
    } finally {
      updateChannel(CRISP, { mode: before.mode })
    }
  })
})
