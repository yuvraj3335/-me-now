/**
 * What a brief carries out of a Slack row, and — the part worth a test — what
 * it does not.
 *
 * A desk Slack row is a thread *parent*, and until now that was the whole of
 * what a brief could quote: the question, none of the answers. The sheet lists
 * the replies Wake already stored and he picks the ones that matter.
 *
 * The failure this file exists to prevent is a specific and tempting one. It is
 * very easy to write a picker whose "select" is a checkbox over a list that is
 * *already* being sent — a filter drawn on top of an attachment set that never
 * narrowed — and nothing on screen would look any different. So the property
 * pinned hardest below is a negative: a reply he did not pick is not in the
 * pack, not in the brief, and not in the file on disk.
 *
 * The items come from the real route, over a card built by the real adapter
 * from the real captured payloads, so what is picked from is what the poll
 * would have stored. The mapping under test is `packItemFor` in
 * `src/web/lib/slackThreads.ts` — HANDOFF_SLACK_API.md §1.4 — and the selection
 * model is the launch basket itself, which is the same store the attachments
 * list on the sheet renders.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { db, now } from '../src/server/db'
import { api } from '../src/server/api'
import { bucketHits, buildThreadCard, parseSlackResults, parseThreadRead } from '../src/server/sources/slack'
import type { RawCard } from '../src/server/sources/types'
import { ME_ID, SEARCH_ONE_THREAD, THREAD_READ } from './fixtures/slack'
import { buildPack } from '../src/server/claudecode/launch'
import { readFileSync } from 'node:fs'
import { messageWord, packItemFor, slackLinkFor, type SlackThread } from '../src/web/lib/slackThreads'
import { launchBasket, openLaunch, removeFromLaunch, resetLaunch } from '../src/web/lib/launch'
import type { PackItem } from '../src/web/lib/launch'

/**
 * What the sheet would send to `POST /packs`.
 *
 * The launch basket *is* the selection: a picked reply is an attachment like
 * every other object, in the same list, removable from either place. That is
 * what makes "the ones he did not pick are not in the pack" true by
 * construction rather than by a filter somebody has to remember to write — and
 * it is why these assertions read the real store rather than a fixture.
 */
const currentItems = (): PackItem[] => [...launchBasket().items]

type Any = Record<string, any>

const CH = 'C04D9HKDWAV'
const PARENT = '1787812499.720579'
const GROUP = `slackthread:${CH}:${PARENT}`

/** The card the poll would have stored for the live `#truto` thread. */
function threadCard(): RawCard {
  const hits = parseSlackResults(SEARCH_ONE_THREAD)
  const bucket = bucketHits(hits, ME_ID).get(`${CH}:${PARENT}`)!
  return buildThreadCard(bucket, parseThreadRead(THREAD_READ), ME_ID)!
}

function store(card: RawCard) {
  db.query(
    `INSERT INTO cards (id, source, source_id, group_key, kind, title, why, url, ts, pile,
                        refs, meta, first_seen_at, last_seen_at, gone)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, ts = excluded.ts`,
  ).run(
    `${card.source}:${card.source_id}`, card.source, card.source_id, GROUP, card.kind,
    card.title, card.why, card.url, card.ts, card.pile,
    JSON.stringify(card.refs), JSON.stringify(card.meta ?? {}), now(), now(),
  )
}

const threadsFor = async (group = GROUP): Promise<SlackThread[]> => {
  const r = await api.request(`/cards/${encodeURIComponent(group)}/slack`)
  return ((await r.json()) as Any).threads as SlackThread[]
}

beforeEach(() => {
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
  // The basket is module state shared by every surface that can start a brief.
  resetLaunch()
})

/* ---------------------------- one message, mapped ---------------------------- */

describe('a Slack message as an object a brief can carry', () => {
  test('the fields are the ones a session can act on', async () => {
    store(threadCard())
    const [thread] = await threadsFor()
    const reply = thread!.replies.find(r => r.who === 'Riya')!
    const item = packItemFor(reply)

    expect(item.kind).toBe('slack')
    // `<channel>:<ts>` — unique per message, so two replies are two items.
    expect(item.ref).toBe(`${CH}:${reply.ts}`)
    expect(item.title).toBe('Riya')
    expect(item.excerpt).toBe(reply.excerpt)
    expect(item.why).toBe('a reply on that thread')
    expect(item.meta!.channel).toBe('#truto')
    expect(item.meta!.at).toBe(reply.at)
  })

  test('the stored link is the permalink and the app link travels beside it', async () => {
    store(threadCard())
    const [thread] = await threadsFor()
    const reply = thread!.replies[0]!
    const item = packItemFor(reply)

    // The durable https form is what gets stored and shared, and it is what
    // `SLACK_ARCHIVE` in dedup.ts reads a thread reference back out of. Putting
    // the `slack://` form here would put a URL nobody else can open into a pack
    // file and break the parser that reads it.
    expect(item.url).toStartWith('https://')
    expect(item.url).toContain(`/archives/${CH}/p${reply.ts.replace('.', '')}`)

    // And the app link is carried as its own fact, pointed at THIS message
    // rather than at the channel or at the parent.
    expect(item.meta!.open_in_app).toBe(`slack://channel?team=T04CWR1AM1R&id=${CH}&message=${reply.ts}`)

    // Which is also what a control on the sheet sends him to: the app when
    // there are ids to build one, the permalink when there are not.
    expect(reply.app_url).not.toBeNull()
    expect(slackLinkFor(reply)).toBe(reply.app_url!)
    expect(slackLinkFor({ ...reply, app_url: null })).toBe(reply.url)
  })

  test('the parent collapses onto the card it is the card of', async () => {
    store(threadCard())
    const [thread] = await threadsFor()

    // `refFor` in cardContext.ts mints `channel_id:thread_ts` for a whole Slack
    // card, and the parent's ref is the same string by construction. So the
    // card and its own parent message are one attachment, with no special case
    // anywhere: this is what stops the sheet quoting the opening message twice.
    expect(thread!.parent!.ref).toBe(`${CH}:${PARENT}`)

    const card: PackItem = { kind: 'slack', ref: `${CH}:${PARENT}`, title: 'the desk row' }
    openLaunch([card])
    openLaunch([packItemFor(thread!.parent!)])
    expect(currentItems().filter(i => i.ref === `${CH}:${PARENT}`)).toHaveLength(1)
  })
})

/* ------------------------ the picking is real picking ----------------------- */

describe('a reply he did not pick is not in the brief', () => {
  test('only the selected replies become attachments', async () => {
    store(threadCard())
    const [thread] = await threadsFor()
    const replies = thread!.replies
    expect(replies.length).toBeGreaterThanOrEqual(3)

    // He picks the first and the last, and leaves everything between them.
    const picked = [replies[0]!, replies[replies.length - 1]!]
    const skipped = replies.slice(1, -1)
    expect(skipped.length).toBeGreaterThan(0)

    for (const r of picked) openLaunch([packItemFor(r)])
    const items = currentItems()

    for (const r of picked) {
      expect(items.some(i => i.ref === r.ref), `${r.who}'s reply was picked and is missing`).toBe(true)
    }
    for (const r of skipped) {
      expect(items.some(i => i.ref === r.ref), `${r.who}'s reply was not picked and is in the pack`)
        .toBe(false)
    }
  })

  test('and un-picking one takes it back out', async () => {
    store(threadCard())
    const [thread] = await threadsFor()
    const [first, second] = [thread!.replies[0]!, thread!.replies[1]!]

    openLaunch([packItemFor(first)])
    openLaunch([packItemFor(second)])
    expect(currentItems()).toHaveLength(2)

    removeFromLaunch(first.ref)
    const refs = currentItems().map(i => i.ref)
    expect(refs).toEqual([second.ref])
  })

  test('the file on disk quotes the picked reply and never the skipped one', async () => {
    store(threadCard())
    const [thread] = await threadsFor()
    const replies = thread!.replies
    const picked = replies[0]!
    const skipped = replies.find(r => r.ref !== picked.ref && r.excerpt.length > 12)!

    // The end of the chain: what the picker produced, through the real packer,
    // into the real file. A "selection" that never narrows the attachment set
    // passes every assertion above this one and fails here.
    const built = buildPack({ template: 'slack-thread', items: [packItemFor(picked)] })
    if ('error' in built) throw new Error(built.error)
    const body = readFileSync(built.packPath, 'utf8')

    expect(body).toContain(picked.excerpt.slice(0, 40))
    expect(body).not.toContain(skipped.excerpt.slice(0, 40))
    expect(body).not.toContain(skipped.ref)
  })

  test('the sheet-only routing key never reaches the pack', async () => {
    // `PackItem.group` is how the sheet knows which row to ask for replies. It
    // is not a fact about the object, and a pack file that carried it would be
    // recording how the sheet found something rather than what the brief is.
    const built = buildPack({
      template: 'blank',
      items: [{ kind: 'slack', ref: `${CH}:${PARENT}`, title: 'a message', excerpt: 'words' } as PackItem],
    })
    if ('error' in built) throw new Error(built.error)
    expect(readFileSync(built.packPath, 'utf8')).not.toContain(GROUP)
  })
})

/* ------------------------------ how it reads ------------------------------ */

describe('what the picker says about a thread', () => {
  test('the count is Slack’s, not the length of what Wake kept', async () => {
    store(threadCard())
    const [thread] = await threadsFor()

    // Ten were said; the capture is abridged and fewer arrived. Only the newest
    // twenty are ever stored, so the array length is "what Wake has" and would
    // report a long conversation as a short one.
    expect(thread!.reply_total).toBe(10)
    expect(messageWord(thread!, thread!.reply_total)).toBe('10 replies')
    expect(thread!.reply_total).toBeGreaterThan(thread!.replies.length)
  })

  test('one reply is not "1 replies"', () => {
    const t = { alert: false } as SlackThread
    expect(messageWord(t, 1)).toBe('1 reply')
    expect(messageWord({ alert: true } as SlackThread, 1)).toBe('1 message')
  })

  test('an alert row has messages, not replies, and no parent to draw', async () => {
    store(threadCard())
    const [thread] = await threadsFor()
    // A thread row has a parent; the word for what hangs off it is "reply".
    expect(thread!.alert).toBe(false)
    expect(thread!.parent).not.toBeNull()

    // An alert row's members are separate top-level messages that Wake grouped,
    // so calling them replies would say they answer something that was never
    // asked — and there is no parent row to render for one.
    const alert = { ...thread!, alert: true, parent: null }
    expect(messageWord(alert, 3)).toBe('3 messages')
    expect(alert.parent).toBeNull()
  })

  test('a row with nothing said under it offers nothing to pick', async () => {
    store(threadCard())
    const [thread] = await threadsFor()

    // The rule the sheet renders: a thread with no replies is not a section
    // with an empty state in it, it is nothing at all. The parent is already an
    // attachment, so a heading here would head a fact already on screen.
    const empty: SlackThread = { ...thread!, replies: [], reply_total: 0 }
    expect([empty].filter(t => t.replies.length > 0)).toHaveLength(0)
  })
})

