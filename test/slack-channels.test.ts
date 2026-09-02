/**
 * The Slack channel scope is a table, and this file is its specification.
 *
 * It used to be a hand-edited array in `env.ts`, and it broke the way a config
 * array always eventually breaks: editing it was the only way to add or drop a
 * channel, and it was edited twice inside one week — once dropping `#truto`,
 * the team's own channel, silently. What replaced it is `slack_channels`
 * (`db.ts` migration 15, read and written through `slackScope.ts`): one row per
 * channel, three facts per row — `mode`, `label`, `family` — and every one of
 * them changeable from Settings without a deploy.
 *
 * Three things are pinned here, in order of how much they cost when wrong:
 *
 *   1. **The seed.** What ships, and which mode each channel starts in. `#truto`
 *      is back on the desk at `mentions`; the fourteen customer channels and
 *      `#clonepartner` are read wholesale; the three alert channels and Crisp are
 *      read as history under their families; `#framer-clonepartner` is present
 *      and off, because a channel that went quiet in March should be one click
 *      from coming back rather than forgotten.
 *   2. **The refusal.** `mode: 'off'` is enforced in `bucketHits`, beside the DM
 *      rule, so the list is true regardless of what Slack does with a query
 *      string — the `in:#` clause on the search is an economy, not the guarantee.
 *   3. **The wholesale rule.** A channel read as history turns a top-level
 *      message into a row only when somebody outside the team posted it, or when
 *      a conversation is already under way. A teammate's changelog broadcast
 *      with nobody answering is a broadcast, not work.
 *
 * The hits below are built rather than captured, because what is under test is
 * a decision and not a dialect — `test/slack-threads.test.ts` and
 * `test/slack-parse.test.ts` own the parsers.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  alertChannels, channelScope, getChannel, historyChannels, isChannelReachable, listChannels,
  scopeFor, ScopeError, updateChannel, upsertListed,
} from '../src/server/slackScope'
import {
  allChannelCard, bucketHits, historyCardsForRow, parseChannelListing, type SlackHit,
} from '../src/server/sources/slack'
import { ME_ID } from './fixtures/slack'
import { slackCard } from '../src/server/fetch/index'
import type { SearchHit } from '../src/server/sources/search'

/* ------------------------------ the seed ---------------------------------- */

const TRUTO = 'C04D9HKDWAV'
const CRISP = 'C07351C8Z8E'
const FRAMER = 'C06UP5J326B'
const CLONEPARTNER = 'C09BRBLNXNH'
const STAX = 'C09TKFVP6AY'

const CUSTOMERS: Array<[string, string]> = [
  ['spendflo-truto', 'C05CJ0CUV35'], ['thoropass-truto', 'C05P80HPYSK'], ['naq-truto', 'C09REMSHL14'],
  ['stax-truto', STAX], ['evergrowth-truto', 'C0A25L2QEB0'], ['komplai-truto', 'C0A437E7UAU'],
  ['15five-truto', 'C0AHHQMF08L'], ['truto-balkanid', 'C07PMS3UYKB'], ['ex-superhawk-truto', 'C0AACN2HYM7'],
  ['maximor-truto', 'C0A8B267EE9'], ['open-truto', 'C08SS821JHG'], ['docsbot-truto', 'C093QFW4U3E'],
  ['truto-zen', 'C07AVEG7ZHN'], ['sprinto', 'C050LJAMFSN'],
]

/** Every mode change a test makes is undone, so the seed is what every test sees. */
const touched = new Map<string, { mode: string; label: string | null }>()
const setMode = (id: string, mode: 'off' | 'mentions' | 'all') => {
  const before = getChannel(id)!
  if (!touched.has(id)) touched.set(id, { mode: before.mode, label: before.label })
  updateChannel(id, { mode })
}
afterEach(() => {
  for (const [id, was] of touched) updateChannel(id, was)
  touched.clear()
})

describe('what ships in the table', () => {
  test('#truto is back, at mentions — a team channel is not read wholesale', () => {
    const c = getChannel(TRUTO)!
    expect(c, '#truto is not seeded — the channel a prior release dropped is still missing').toBeTruthy()
    expect(c.name).toBe('truto')
    expect(c.mode).toBe('mentions')
    expect(c.label).toBe('team')
    expect(c.family).toBeNull()
  })

  test('the fourteen customer channels are read wholesale', () => {
    for (const [name, id] of CUSTOMERS) {
      const c = getChannel(id)
      expect(c, `${name} is not seeded`).toBeTruthy()
      expect(c!.name, `${id} is named ${c!.name}, not ${name}`).toBe(name)
      expect(c!.mode, `${name} is ${c!.mode}, not all`).toBe('all')
      expect(c!.label, `${name} is labelled ${c!.label}`).toBe('customer')
    }
  })

  test('the active clone-partner channel is on and the dormant one is off, not gone', () => {
    // Two channels match "clone partner"; the choice was made from a live read
    // on 2026-09-02 — `#clonepartner` had posts every day that week and
    // `#framer-clonepartner` had been silent since 2026-03-20.
    expect(getChannel(CLONEPARTNER)).toMatchObject({ name: 'clonepartner', mode: 'all', label: 'partner' })
    expect(getChannel(FRAMER)).toMatchObject({ name: 'framer-clonepartner', mode: 'off', label: 'partner' })
  })

  test('the three alert channels keep their families, in the order the parsers destructure', () => {
    expect(alertChannels()).toEqual([
      { id: 'C0BERTMS9K4', name: 'sentry-alerts', family: 'sentry' },
      { id: 'C05UPHVT2CQ', name: 'truto-api-alerts', family: 'datadog' },
      { id: 'C0B53TSLGLA', name: 'truto-grafana-alerts', family: 'grafana' },
    ])
    for (const a of alertChannels()) expect(getChannel(a.id)!.label).toBe('alert')
  })

  test('Crisp is seeded as its own family, read wholesale', () => {
    expect(getChannel(CRISP)).toMatchObject({ name: 'crisp-chats', mode: 'all', label: 'crisp', family: 'crisp' })
  })

  test('every seeded row says it was seeded', () => {
    const seeded = listChannels().filter(c => c.seeded)
    // 1 team + 14 customers + 2 partners + 3 alerts + 1 crisp.
    expect(seeded.length).toBe(21)
  })
})

/* ------------------------------ the default ------------------------------- */

describe('a channel the table has never heard of', () => {
  test('is reachable for mentions — today\'s behaviour, minus the hardcoded refusal', () => {
    expect(scopeFor('C0NEVERSEEN', 'brand-new')).toEqual({ mode: 'mentions', label: null, family: null })
    expect(isChannelReachable('C0NEVERSEEN', 'brand-new')).toBe(true)
  })

  test('the id answers first, the name second, and a renamed channel keeps its scope', () => {
    // A search hit can arrive with a good id and a useless name; a rename keeps
    // the id. Both halves have to answer.
    expect(scopeFor(FRAMER, 'framer-clonepartner-renamed').mode).toBe('off')
    expect(scopeFor(null, '#Framer-ClonePartner').mode).toBe('off')
    expect(scopeFor(undefined, 'crisp-chats').family).toBe('crisp')
  })
})

/* ------------------------------ the refusal ------------------------------- */

let seq = 0
/** One search hit, with only the fields a refusal is allowed to read. */
const hit = (channelName: string, channelId: string, over: Partial<SlackHit> = {}): SlackHit => {
  const ts = `178781${String(1000 + seq++).slice(-4)}.100000`
  return {
    channelId,
    channelName,
    isDm: channelId.startsWith('D'),
    fromName: 'Nidhi',
    fromId: 'U0BBZV4HQHH',
    ts,
    epochMs: Number(ts.split('.')[0]) * 1000,
    permalink: `https://truto.slack.com/archives/${channelId}/p${ts.replace('.', '')}`,
    text: `<@${ME_ID}> can you look at this`,
    ...over,
  }
}

describe('mode off is refused in code, not only in the query', () => {
  test('a hit from an off channel never opens a bucket', () => {
    expect(bucketHits([hit('#framer-clonepartner', FRAMER)], ME_ID).size).toBe(0)
  })

  test('and one from a mentions or all channel does', () => {
    expect(bucketHits([hit('#truto', TRUTO)], ME_ID).size).toBe(1)
    expect(bucketHits([hit('#stax-truto', STAX)], ME_ID).size).toBe(1)
  })

  test('turning a channel off from Settings takes effect on the next poll, with no deploy', () => {
    expect(bucketHits([hit('#truto', TRUTO)], ME_ID).size).toBe(1)
    setMode(TRUTO, 'off')
    expect(bucketHits([hit('#truto', TRUTO)], ME_ID).size).toBe(0)
    // Split, not a substring test: `in:#truto` is inside `in:#truto-balkanid`.
    expect(channelScope().split(' ')).not.toContain('in:#truto')
  })

  test('one poll of both is only the half that is on', () => {
    const hits = [
      hit('#truto', TRUTO),
      hit('#framer-clonepartner', FRAMER),
      hit('#spendflo-truto', 'C05CJ0CUV35'),
    ]
    expect([...bucketHits(hits, ME_ID).keys()].map(k => k.split(':')[0]))
      .toEqual([TRUTO, 'C05CJ0CUV35'])
  })

  test('a direct message is still refused, and by its own rule', () => {
    // A `D…` conversation has no row and would default to reachable — so the
    // DM rule is the one refusing it, and it must not be lost behind this one.
    for (const id of ['D0BT1ED811Q', 'D0BQQQQ1111']) {
      expect(scopeFor(id, 'DM').mode, 'a DM has a scope row, which it must never have').toBe('mentions')
      expect(bucketHits([hit('DM', id)], ME_ID).size).toBe(0)
    }
  })

  test('a message he wrote himself is still refused', () => {
    expect(bucketHits([hit('#truto', TRUTO, { fromId: ME_ID })], ME_ID).size).toBe(0)
  })

  test('the other door — a manual Fetch — obeys the same table', () => {
    const search = (channel: string, id: string): SearchHit => ({
      source: 'slack', ref: `${id}:1787811801.333333`, title: channel,
      url: `https://truto.slack.com/archives/${id}/p1787811801333333`,
      excerpt: 'can you look', who: 'Nidhi', at: 1787811801333,
    } as unknown as SearchHit)
    expect(slackCard(search('#truto', TRUTO))).toBeTruthy()
    expect(slackCard(search('#framer-clonepartner', FRAMER))).toBeNull()
  })
})

/* ---------------------------- the search clause --------------------------- */

describe('the mention search names the channels whose mentions matter', () => {
  test('mentions and all rows are in it; off rows and family rows are not', () => {
    const scope = channelScope()
    const terms = scope.split(' ')
    expect(terms).toContain('in:#truto')
    expect(scope).toContain('in:#stax-truto')
    expect(scope).toContain('in:#clonepartner')
    expect(scope).not.toContain('in:#framer-clonepartner')
    // Alert and Crisp channels are read as history — search cannot see a bot's
    // post, so a term naming one is a slot spent on a known empty answer.
    expect(scope).not.toContain('in:#sentry-alerts')
    expect(scope).not.toContain('in:#crisp-chats')
  })

  test('repeated `in:` and no boolean operator, which is the syntax Slack has', () => {
    const scope = channelScope()
    expect(scope).not.toMatch(/\bOR\b/)
    expect(scope.split(' ').every(t => t.startsWith('in:#'))).toBe(true)
  })
})

/* ------------------------------ what is read ------------------------------ */

describe('which channels a poll reads as history', () => {
  test('every all-mode row, plus every family row that is not off', () => {
    const ids = new Set(historyChannels().map(c => c.id))
    for (const [, id] of CUSTOMERS) expect(ids.has(id), `${id} is not read`).toBe(true)
    expect(ids.has(CLONEPARTNER)).toBe(true)
    expect(ids.has(CRISP)).toBe(true)
    for (const a of alertChannels()) expect(ids.has(a.id)).toBe(true)
    // Mentions-only without a family is searched, not read.
    expect(ids.has(TRUTO)).toBe(false)
    expect(ids.has(FRAMER)).toBe(false)
  })

  test('an alert channel at mentions is still read — the mode narrows to pages', () => {
    setMode('C05UPHVT2CQ', 'mentions')
    expect(historyChannels().some(c => c.id === 'C05UPHVT2CQ')).toBe(true)
  })

  test('an alert channel turned off is not read at all', () => {
    setMode('C0B53TSLGLA', 'off')
    expect(historyChannels().some(c => c.id === 'C0B53TSLGLA')).toBe(false)
    expect(alertChannels().map(a => a.id)).toContain('C0B53TSLGLA')
  })
})

/* --------------------------- the wholesale rule --------------------------- */

const external = (text: string, over: Partial<SlackHit> = {}) => hit('#stax-truto', STAX, {
  fromName: 'Kyle Johnson', fromId: 'U086NAYULRZ', fromEmail: 'kyle@stax.ai', text, ...over,
})
const teammate = (text: string, over: Partial<SlackHit> = {}) => hit('#stax-truto', STAX, {
  fromName: 'Nidhi', fromId: 'U0BBZV4HQHH', fromEmail: 'nidhi@truto.one', text, ...over,
})

describe('a channel read wholesale', () => {
  const row = () => getChannel(STAX)!

  test('a customer posting with no reply is on him, now', () => {
    const c = allChannelCard(row(), external('Our NetSuite sync failed overnight, can someone look?'), ME_ID)!
    expect(c).toBeTruthy()
    expect(c.kind).toBe('mention')
    expect(c.pile).toBe('now')
    expect(c.who).toBe('Kyle Johnson')
    expect(c.why).toContain('nobody has answered')
    expect(c.why).toContain('#stax-truto')
    expect(c.meta?.channel_label).toBe('customer')
    expect(c.refs).toContainEqual({ t: 'slackthread', v: c.source_id })
  })

  test('a customer post somebody already answered is open, not now', () => {
    const c = allChannelCard(row(), external('Sync failed overnight\nThread: 3 replies (latest: 2026-09-01 10:00:00 IST)'), ME_ID)!
    expect(c.pile).toBe('open')
    expect(c.who).toBeUndefined()
    expect(c.meta?.replies).toBe(3)
  })

  test('a teammate broadcast nobody replied to is not a row — the weekly changelog', () => {
    expect(allChannelCard(row(), teammate('Hi everyone :wave:\nHere is the Truto changelog for Year 4, Week 35'), ME_ID)).toBeNull()
  })

  test('a teammate post with replies is a conversation, and is open', () => {
    const c = allChannelCard(row(), teammate('Shipping the fix today\nThread: 2 replies (latest: x)'), ME_ID)!
    expect(c.pile).toBe('open')
  })

  test('an author with no address is treated as external — the expensive miss is a customer', () => {
    const c = allChannelCard(row(), external('Hello?', { fromEmail: undefined }), ME_ID)!
    expect(c.pile).toBe('now')
  })

  test('his own post and a join notice are never rows', () => {
    expect(allChannelCard(row(), external('anything', { fromId: ME_ID }), ME_ID)).toBeNull()
    expect(allChannelCard(row(), external('<@U0A2Y4VC874|Ankit Bhadoria> has joined the channel'), ME_ID)).toBeNull()
  })

  test('a partner channel says partner', () => {
    const c = allChannelCard(getChannel(CLONEPARTNER)!, hit('#clonepartner', CLONEPARTNER, {
      fromName: 'Abdul Aleem', fromEmail: 'abdul@clonepartner.com', text: 'please join the meeting link',
    }), ME_ID)!
    expect(c.why).toBe('a partner posted in #clonepartner and nobody has answered')
    expect(c.meta?.channel_label).toBe('partner')
  })

  test('historyCardsForRow applies the rule across a read', () => {
    const cards = historyCardsForRow(row(), [
      external('question one'),
      teammate('changelog'),
      teammate('a thread\nThread: 4 replies (latest: x)'),
    ], ME_ID)
    expect(cards.map(c => c.pile)).toEqual(['now', 'open'])
  })
})

/* ------------------------------- the edits -------------------------------- */

describe('editing a row from Settings', () => {
  test('mode and label are validated, and family is never a client\'s to set', () => {
    expect(() => updateChannel(TRUTO, { mode: 'loud' })).toThrow(ScopeError)
    expect(() => updateChannel(TRUTO, { label: 'vip' })).toThrow(ScopeError)
    expect(() => updateChannel('C0NOSUCH', { mode: 'off' })).toThrow(ScopeError)
  })

  test('alert and crisp labels need a family — a customer channel cannot be declared a monitor', () => {
    expect(() => updateChannel(STAX, { label: 'alert' })).toThrow(ScopeError)
    expect(() => updateChannel(STAX, { label: 'crisp' })).toThrow(ScopeError)
  })

  test('a label can be cleared, and a mode changed, independently', () => {
    const before = getChannel(STAX)!
    touched.set(STAX, { mode: before.mode, label: before.label })
    expect(updateChannel(STAX, { label: null }).label).toBeNull()
    expect(getChannel(STAX)!.mode).toBe('all')
    expect(updateChannel(STAX, { mode: 'mentions' })).toMatchObject({ mode: 'mentions', label: null })
  })
})

/* ------------------------------- the listing ------------------------------ */

describe('a refresh from Slack', () => {
  test('parses the listing the connected tool actually returns', () => {
    const md = [
      '## My Channels (showing 2 of 2 total)', '',
      '### #stax-truto', '- **ID:** C09TKFVP6AY', '- **Type:** Private Channel', '- **Archived:** No', '',
      '### #brand-new', '- **ID:** C0NEWNEW001', '- **Type:** Public Channel', '- **Archived:** No', '',
      'Pagination: More results available. Use cursor: "aWQ6NTA0"',
    ].join('\n')
    const { channels, nextCursor } = parseChannelListing(md)
    expect(channels).toEqual([
      { id: 'C09TKFVP6AY', name: 'stax-truto', isPrivate: true },
      { id: 'C0NEWNEW001', name: 'brand-new', isPrivate: false },
    ])
    expect(nextCursor).toBe('aWQ6NTA0')
  })

  test('never overwrites a decision, and lands a new channel at mentions', () => {
    const before = getChannel(STAX)!
    const { added } = upsertListed([
      { id: STAX, name: 'stax-truto', isPrivate: true },
      { id: 'C0NEWNEW001', name: 'brand-new', isPrivate: false },
    ])
    expect(added).toBe(1)
    const after = getChannel(STAX)!
    expect(after.mode).toBe(before.mode)
    expect(after.label).toBe(before.label)
    expect(after.family).toBe(before.family)
    expect(after.is_private).toBe(true)
    expect(after.last_listed_at).toBeGreaterThan(0)
    expect(getChannel('C0NEWNEW001')).toMatchObject({ mode: 'mentions', label: null, family: null, seeded: false })
  })
})
