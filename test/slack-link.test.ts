/**
 * A Slack link somebody pasted.
 *
 * The desk lists what the poll found, and the operator can always see one more
 * thing than the poll asked about — a message in a channel Wake does not read, a
 * link a colleague sent him. So a pasted URL has to become the same attachable
 * item a listed reply is, or the brief simply cannot carry it.
 *
 * Every URL below is a real format this codebase already mints or already
 * parses, not one invented for a test:
 *
 *   * the archive form is what `SLACK_ARCHIVE` in `src/server/dedup.ts` reads a
 *     thread reference back out of, and what `parseChannelMessages` and
 *     `buildThreadCard` in `sources/slack.ts` mint when Slack gave them no
 *     permalink;
 *   * the `slack://` form is what `slackAppUrl` in `src/web/lib/appLinks.ts`
 *     builds for the Open button.
 *
 * The three refusals are pinned as hard as the successes. A parser that guesses
 * at a link it does not understand produces an item quoting nothing, in a brief
 * nobody re-reads before sending.
 */

import { describe, expect, test } from 'bun:test'
import { parseSlackLink, slackTsToMs, slackTsMs } from '../src/shared/slackThread'

const TEAM = 'T04CWR1AM1R'
const CH = 'C04D9HKDWAV'
const PARENT = '1787812499.720579'
const REPLY = '1787814333.427979'

/** The parser is pure, so an `ok` result can simply be unwrapped. */
const item = (input: string, teamId: string | null = TEAM) => {
  const r = parseSlackLink(input, { teamId })
  if (!r.ok) throw new Error(`expected a link, got a refusal: ${r.reason}`)
  return r.item
}

const refusal = (input: string) => {
  const r = parseSlackLink(input, { teamId: TEAM })
  expect(r.ok).toBe(false)
  return r.ok ? '' : r.reason
}

/* ------------------------- 1. the https archive form ---------------------- */

describe('the archive link a person copies out of Slack', () => {
  test('a bare permalink is its own parent', () => {
    // The same rule `parentTs` applies: a permalink with no `thread_ts` on it is
    // a top-level message, and a top-level message is the parent of the thread
    // that may one day hang off it.
    const i = item(`https://truto.slack.com/archives/${CH}/p1787812499720579`)

    expect(i.channel_id).toBe(CH)
    expect(i.ts).toBe(PARENT)
    expect(i.thread_ts).toBe(PARENT)
    expect(i.parent).toBe(true)
    expect(i.at).toBe(slackTsToMs(PARENT))
  })

  test('a reply link keeps the thread it hangs off', () => {
    const i = item(
      `https://truto.slack.com/archives/${CH}/p1787814333427979?thread_ts=${PARENT}&cid=${CH}`,
    )

    expect(i.ts).toBe(REPLY)
    expect(i.thread_ts).toBe(PARENT)
    expect(i.parent).toBe(false)
    // The `cid` and the path agree, and both name the channel.
    expect(i.channel_id).toBe(CH)
  })

  test('the item is a pack item: a kind, and a ref unique to the message', () => {
    const parent = item(`https://truto.slack.com/archives/${CH}/p1787812499720579`)
    const reply = item(`https://truto.slack.com/archives/${CH}/p1787814333427979?thread_ts=${PARENT}`)

    expect(parent.kind).toBe('slack')
    // `channel:ts` — the same string `refFor` in `src/web/lib/cardContext.ts`
    // already mints for a whole Slack card, so the parent's item and the card's
    // own item collapse in the basket rather than stacking.
    expect(parent.ref).toBe(`${CH}:${PARENT}`)
    expect(reply.ref).toBe(`${CH}:${REPLY}`)
    expect(reply.ref).not.toBe(parent.ref)
  })

  test('the app link points at the message, not merely at the channel', () => {
    const reply = item(`https://truto.slack.com/archives/${CH}/p1787814333427979?thread_ts=${PARENT}`)

    // `message=` is the REPLY's own ts. A reply's app link that lands on the
    // parent is a link to the wrong thing, said three messages ago.
    expect(reply.app_url).toBe(`slack://channel?team=${TEAM}&id=${CH}&message=${REPLY}`)
    expect(reply.url).toBe(
      `https://truto.slack.com/archives/${CH}/p1787814333427979?thread_ts=${PARENT}`,
    )
  })

  test('the workspace it was pasted from is the workspace it links back to', () => {
    const i = item(`https://acme.slack.com/archives/${CH}/p1787812499720579`)
    expect(i.url.startsWith('https://acme.slack.com/')).toBe(true)
  })

  test('no team means no app link, rather than one that opens the wrong thing', () => {
    // `slack://channel` missing a team opens Slack on whatever was last shown,
    // which is indistinguishable from a link that worked. `slackAppUrl` refuses
    // for the same reason and this has to agree with it.
    const i = item(`https://truto.slack.com/archives/${CH}/p1787812499720579`, null)
    expect(i.team_id).toBeNull()
    expect(i.app_url).toBeNull()
    // And the item is still perfectly usable.
    expect(i.url).toContain('/archives/')
  })

  test('what dedup parses, this parses — the same two-part timestamp', () => {
    // `SLACK_ARCHIVE` reads ten digits of epoch seconds and six of Slack's
    // uniqueness tail. Anything looser here would read `p17878124` as an instant
    // in 1970 and hand back a link to a message that does not exist.
    expect(item(`https://truto.slack.com/archives/${CH}/p1787812499720579`).ts).toBe(PARENT)
    expect(refusal(`https://truto.slack.com/archives/${CH}/p17878124`))
      .toBe('that Slack link does not point at a message')
  })
})

/* ---------------------------- 2. the slack:// form ------------------------ */

describe('the app link Slack and Wake both mint', () => {
  test('team, channel and message come straight off the query', () => {
    const i = item(`slack://channel?team=${TEAM}&id=${CH}&message=${REPLY}`)

    expect(i.team_id).toBe(TEAM)
    expect(i.channel_id).toBe(CH)
    expect(i.ts).toBe(REPLY)
    expect(i.app_url).toBe(`slack://channel?team=${TEAM}&id=${CH}&message=${REPLY}`)
  })

  test('an undotted timestamp is the same timestamp', () => {
    // Some clients write the ts without its separator. It is the same sixteen
    // digits, and reading it as `1787814333427979` seconds would land in the
    // year 58,000.
    const i = item(`slack://channel?team=${TEAM}&id=${CH}&message=1787814333427979`)
    expect(i.ts).toBe(REPLY)
    expect(i.at).toBe(slackTsMs(REPLY))
  })

  test('the round trip: what the item offers, parsed back, is the same message', () => {
    const first = item(`https://truto.slack.com/archives/${CH}/p1787814333427979?thread_ts=${PARENT}`)
    const back = item(first.app_url!)

    expect(back.ts).toBe(first.ts)
    expect(back.channel_id).toBe(first.channel_id)
    expect(back.team_id).toBe(first.team_id)
  })
})

/* ------------------------------ 3. the refusals --------------------------- */

describe('what a pasted link may not be', () => {
  test('a direct message, in either form', () => {
    // This is the door. `bucketHits` in `sources/slack.ts` throws a `D…`
    // conversation away before it can become a card, so nothing served out of
    // stored cards can be one — and a link somebody pastes is exactly the way
    // round that refusal. `isDmChannel` is the same predicate, applied here.
    const dm = 'Wake does not carry direct messages'
    expect(refusal(`https://truto.slack.com/archives/D0BT1ED811Q/p1787808801580799`)).toBe(dm)
    expect(refusal(`slack://channel?team=${TEAM}&id=D0BT1ED811Q&message=${REPLY}`)).toBe(dm)
    // The group-DM shape from the live capture spells its id the same way.
    expect(refusal(`https://truto.slack.com/archives/D0BQQQQ1111/p1787810601111111`)).toBe(dm)
  })

  test('a channel whose name merely starts with a D is a channel', () => {
    // `#dm-tools` is `C0DMTOOLS1`. The refusal is about the id's first letter,
    // which is Slack's own type marker, not about the word "dm" anywhere.
    const i = item(`https://truto.slack.com/archives/C0DMTOOLS1/p1787811201222222`)
    expect(i.channel_id).toBe('C0DMTOOLS1')
  })

  test('a channel with no message in it', () => {
    // It names a place, not something somebody said. Accepting it would put an
    // item in a brief that quotes nothing.
    expect(refusal(`slack://channel?team=${TEAM}&id=${CH}`))
      .toContain('opens a channel rather than a message')
  })

  test('something that is not a Slack link at all', () => {
    expect(refusal('https://github.com/trutohq/truto/pull/2034')).toBe('that is not a Slack link')
    expect(refusal('not a url at all')).toBe('that is not a link')
    expect(refusal('')).toBe('paste a Slack message link')
  })

  test('a Slack URL that points somewhere other than a message', () => {
    expect(refusal('https://truto.slack.com/team/U09617LRRDF'))
      .toBe('that Slack link does not point at a message')
  })
})

/* ------------------------------ 4. timestamps ----------------------------- */

describe('a ts this cannot read is null, not now', () => {
  test('the strict reader refuses rather than guesses', () => {
    // `slackTsToMs` answers `Date.now()` for an unreadable ts, which is right
    // inside a parser — a message with a broken header is still a message and
    // the poll must not lose the whole thread over it. It is wrong on the wire:
    // "just now" printed beside a message from March is a lie the reader has no
    // way to doubt.
    expect(slackTsMs('1787812499.720579')).toBe(1787812499720)
    expect(slackTsMs('')).toBeNull()
    expect(slackTsMs('not a ts')).toBeNull()
    expect(slackTsMs(undefined)).toBeNull()
    expect(slackTsToMs('1787812499.720579')).toBe(1787812499720)
  })
})
