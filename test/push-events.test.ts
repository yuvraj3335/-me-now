/**
 * A push when something actually happened.
 *
 * Until this, `push.ts` had three callers — a reminder he set, a due date he
 * set, and the test button — and `ingest()` never called `notify()` at all, so
 * no card ever buzzed a phone. Four kinds do now, each stated as one rule and
 * each keyed so a re-poll cannot buzz twice; and a fifth, a Claude Code session
 * sitting on a finished turn with nobody looking at it, rides the reminder tick.
 *
 * The guards are as much the subject as the kinds. The first poll after a
 * deploy lands two weeks of newly-scoped channel history as "new" rows, and
 * none of it may become forty buzzes; a group he has settled stays quiet; and
 * routine Datadog volume — the noise Half A just took off the desk — must not
 * come back in through the back door as a notification.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { db, now, uid } from '../src/server/db'
import { notifyOnNewWork, notifySessions } from '../src/server/push'
import { CLAUDE_HOME, CLAUDE_PROJECTS_DIR, PUBLIC_URL } from '../src/server/env'
import { sessionsNeedingAttention } from '../src/server/sources/claudeSessions'
import { detailKeyOf } from '../src/web/lib/route'

const HOUR = 3.6e6
const slackTs = (ms: number) => `${Math.floor(ms / 1000)}.000100`

type CardIn = {
  source?: string; kind: string; title: string; who?: string | null; pile?: string
  ts?: number; firstSeen?: number; meta?: Record<string, unknown>
  status?: string; snoozedUntil?: number | null; notMine?: number
}

/** One stored card with its state row, the way ingest leaves them. */
function card(group: string, c: CardIn): string {
  const id = `${c.source ?? 'slack'}:${group}`
  const at = c.firstSeen ?? now()
  db.query(
    `INSERT INTO cards (id, source, source_id, group_key, kind, title, why, who, url, ts, pile,
                        refs, meta, first_seen_at, last_seen_at, gone)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'[]',?,?,?,0)`,
  ).run(id, c.source ?? 'slack', group, group, c.kind, c.title, 'because', c.who ?? null,
        `https://truto.slack.com/archives/${group.replace(':', '/p')}`, c.ts ?? now(), c.pile ?? 'open',
        JSON.stringify(c.meta ?? {}), at, at)
  db.query(
    `INSERT INTO card_state (group_key, status, snoozed_until, not_mine, first_seen_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(group, c.status ?? 'not_started', c.snoozedUntil ?? null, c.notMine ?? 0, at, at)
  return id
}

const notifications = () =>
  db.query<{ title: string; body: string | null; kind: string | null; url: string | null; dedup_key: string }, []>(
    `SELECT title, body, kind, url, dedup_key FROM notifications ORDER BY created_at, dedup_key`,
  ).all()

/**
 * A subscription to nowhere. `deliver()` tries it, gets a refused connection,
 * counts the failure and moves on — which is exactly the path a phone that is
 * off would take, and it means `push_subs` is not empty, which is the gate
 * `notifyOnNewWork` checks first.
 */
function subscribe() {
  db.query(
    `INSERT INTO push_subs (endpoint, p256dh, auth, ua, created_at) VALUES (?,?,?,?,?)`,
  ).run(`https://127.0.0.1:9/never/${uid()}`, 'BNoKeyAtAll', 'nope', 'test', now())
}

beforeEach(() => {
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
  db.query(`DELETE FROM notifications`).run()
  db.query(`DELETE FROM push_subs`).run()
  subscribe()
})

const run = (ids: string[], at = now()) => notifyOnNewWork({ at, cardIds: ids })

describe('a visitor waiting on Crisp', () => {
  test('buzzes once, with the visitor\'s name, and never twice for one spell', async () => {
    const id = card('C07351C8Z8E:1788320000.000001', {
      kind: 'crisp', title: 'Julie Anne Moore', who: 'Julie Anne Moore', pile: 'now',
      meta: { crisp_state: 'unresolved', visitor: 'Julie Anne Moore', reply_total: 0 },
    })
    await run([id])
    const n = notifications()
    expect(n).toHaveLength(1)
    expect(n[0]!.title).toBe('💬 Julie Anne Moore is waiting on Crisp')
    expect(n[0]!.kind).toBe('crisp')
    expect(n[0]!.dedup_key).toBe('crisp:C07351C8Z8E:1788320000.000001:unresolved')

    await run([id])
    expect(notifications(), 'the same unresolved conversation buzzed on a re-poll').toHaveLength(1)
  })

  test('a resolved conversation is history, not a buzz', async () => {
    const id = card('C07351C8Z8E:1788155451.756859', {
      kind: 'crisp', title: 'Jatin Fulwani', pile: 'open',
      meta: { crisp_state: 'resolved', visitor: 'Jatin Fulwani', reply_total: 4 },
    })
    await run([id])
    expect(notifications()).toHaveLength(0)
  })
})

describe('somebody named him', () => {
  const thread = (entries: Array<{ ts: string; who: string; tagged: boolean; mine?: boolean; text: string }>) => ({
    channel: '#truto', channel_id: 'C04D9HKDWAV', thread_ts: entries[0]!.ts,
    parent: { ...entries[0], who_id: 'U1', mine: entries[0]!.mine ?? false },
    thread: entries.slice(1).map(e => ({ ...e, who_id: 'U1', mine: e.mine ?? false })),
  })

  test('one push per tagged entry, keyed on the entry, so a re-poll is silent', async () => {
    const t0 = slackTs(now() - 10 * 60_000)
    const t1 = slackTs(now() - 5 * 60_000)
    const id = card('C04D9HKDWAV:' + t0, {
      kind: 'mention', title: 'can you look at this', who: 'Roopi', pile: 'now',
      meta: thread([
        { ts: t0, who: 'Roopi', tagged: false, text: 'Deploy is red' },
        { ts: t1, who: 'Roopi', tagged: true, text: '@Yuvraj can you look at this' },
      ]),
    })
    await run([id])
    let n = notifications()
    expect(n).toHaveLength(1)
    expect(n[0]!.title).toBe('👋 Roopi mentioned you in #truto')
    expect(n[0]!.body).toBe('@Yuvraj can you look at this')
    expect(n[0]!.dedup_key).toBe(`mention:C04D9HKDWAV:${t0}:${t1}`)

    await run([id])
    expect(notifications()).toHaveLength(1)

    // A second reply naming him is a second event.
    const t2 = slackTs(now() - 60_000)
    db.query(`UPDATE cards SET meta = ? WHERE id = ?`).run(JSON.stringify(thread([
      { ts: t0, who: 'Roopi', tagged: false, text: 'Deploy is red' },
      { ts: t1, who: 'Roopi', tagged: true, text: '@Yuvraj can you look at this' },
      { ts: t2, who: 'Nidhi', tagged: true, text: '@Yuvraj also this one' },
    ])), id)
    await run([id])
    n = notifications()
    expect(n).toHaveLength(2)
    expect(n.map(x => x.title)).toContain('👋 Nidhi mentioned you in #truto')
  })

  test('his own message and an old mention buried under a fresh reply say nothing', async () => {
    const old = slackTs(now() - 5 * HOUR)
    const fresh = slackTs(now() - 60_000)
    const id = card('C04D9HKDWAV:' + old, {
      // Seen on an earlier poll, so the 🔔 rule for a brand-new `now` row does
      // not apply either — what is under test here is the two entry rules.
      kind: 'mention', title: 't', who: 'Roopi', pile: 'now', ts: now(), firstSeen: now() - 60_000,
      meta: thread([
        { ts: old, who: 'Roopi', tagged: true, text: 'five hours ago' },
        { ts: fresh, who: 'Yuvraj', tagged: true, mine: true, text: 'me, replying' },
      ]),
    })
    await run([id])
    // The card is fresh (its ts is the newest reply) so it passes the card-level
    // age check; the only tagged-by-somebody-else entry is five hours old, and
    // his own reply is his. Neither is news — and nor is the 🔔 rule, because
    // this group was first seen before this poll.
    expect(notifications()).toHaveLength(0)
  })
})

describe('a customer posted in a channel read wholesale', () => {
  test('a new unanswered post is one 🔔, and a tagged thread is never also a 🔔', async () => {
    const at = now()
    const cust = card('C09TKFVP6AY:' + slackTs(at - 60_000), {
      kind: 'mention', title: 'Our sync failed overnight', who: 'Kyle Johnson', pile: 'now', firstSeen: at,
      meta: { channel: '#stax-truto', channel_label: 'customer', parent: { ts: slackTs(at - 60_000), who: 'Kyle Johnson', tagged: false, mine: false, text: 'x' }, thread: [] },
    })
    const tagged = card('C04D9HKDWAV:' + slackTs(at - 30_000), {
      kind: 'mention', title: 'look', who: 'Roopi', pile: 'now', firstSeen: at,
      meta: { channel: '#truto', parent: { ts: slackTs(at - 30_000), who: 'Roopi', tagged: true, mine: false, text: '@Yuvraj look' }, thread: [] },
    })
    await run([cust, tagged], at)
    const titles = notifications().map(n => n.title)
    expect(titles).toContain('🔔 Kyle Johnson is waiting: Our sync failed overnight')
    expect(titles).toContain('👋 Roopi mentioned you in #truto')
    expect(titles, 'a tagged thread buzzed twice under two headings').toHaveLength(2)
  })
})

describe('a monitor', () => {
  const alert = (group: string, meta: Record<string, unknown>) =>
    card(group, { kind: 'alert', title: 'API Error Triage in the Last 24 Hours', pile: meta.paged ? 'now' : 'open', meta })

  test('a page buzzes once, ever', async () => {
    const id = alert('C05UPHVT2CQ:' + slackTs(now() - 60_000), { paged: true, family: 'datadog' })
    await run([id])
    await run([id])
    const n = notifications()
    expect(n).toHaveLength(1)
    expect(n[0]!.title).toBe('🚨 Paged: API Error Triage in the Last 24 Hours')
  })

  test('routine volume never does — that is the noise the desk just took off', async () => {
    const a = alert('C05UPHVT2CQ:' + slackTs(now() - 60_000), { paged: false, family: 'datadog' })
    const b = alert('C0B53TSLGLA:' + slackTs(now() - 50_000), { paged: false, family: 'grafana' })
    const c = alert('C05UPHVT2CQ:' + slackTs(now() - 40_000), { paged: true, alert_state: 'recovered' })
    await run([a, b, c])
    expect(notifications()).toHaveLength(0)
  })
})

describe('the guards', () => {
  test('two weeks of newly scoped history is backlog, not forty buzzes', async () => {
    const stale = card('C07351C8Z8E:1780000000.000001', {
      kind: 'crisp', title: 'Old Visitor', who: 'Old Visitor', pile: 'now', ts: now() - 3 * HOUR,
      meta: { crisp_state: 'unresolved', visitor: 'Old Visitor' },
    })
    await run([stale])
    expect(notifications()).toHaveLength(0)
  })

  test('a group he settled stays quiet, however new the row looks', async () => {
    const done = card('C07351C8Z8E:1788320000.000002', {
      kind: 'crisp', title: 'A', who: 'A', pile: 'now', status: 'done',
      meta: { crisp_state: 'unresolved', visitor: 'A' },
    })
    const parked = card('C07351C8Z8E:1788320000.000003', {
      kind: 'crisp', title: 'B', who: 'B', pile: 'now', snoozedUntil: now() + HOUR,
      meta: { crisp_state: 'unresolved', visitor: 'B' },
    })
    const disowned = card('C07351C8Z8E:1788320000.000004', {
      kind: 'crisp', title: 'C', who: 'C', pile: 'now', status: 'wont_do', notMine: 1,
      meta: { crisp_state: 'unresolved', visitor: 'C' },
    })
    await run([done, parked, disowned])
    expect(notifications()).toHaveLength(0)
  })

  test('with nothing subscribed, nothing is even filed', async () => {
    db.query(`DELETE FROM push_subs`).run()
    const id = card('C07351C8Z8E:1788320000.000005', {
      kind: 'crisp', title: 'D', who: 'D', pile: 'now', meta: { crisp_state: 'unresolved', visitor: 'D' },
    })
    await run([id])
    expect(notifications()).toHaveLength(0)
  })
})

describe('the deep link lands on the card', () => {
  test('the URL round-trips through the router\'s own parsers', async () => {
    const group = 'C07351C8Z8E:1788320000.000006'
    const id = card(group, {
      kind: 'crisp', title: 'E', who: 'E', pile: 'now', meta: { crisp_state: 'unresolved', visitor: 'E' },
    })
    await run([id])
    const url = new URL(notifications()[0]!.url!)
    expect(url.origin + url.pathname).toBe(`${PUBLIC_URL}/`)
    expect(url.searchParams.get('src')).toBe('slack')
    // `useRoute().hash` is the fragment without its `#`, which is what
    // `detailKeyOf` reads — see `route.ts`.
    expect(detailKeyOf(url.hash.slice(1))).toBe(group)
  })
})

/* ------------------------------- sessions --------------------------------- */

const flatten = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const SESSION = 'cccccccc-0000-4000-8000-000000000042'
const CWD = '/Users/me/work/shop'

describe('a session sitting on a finished turn', () => {
  test('is reported when idle past a minute, and does not buzz unless Wake started it', async () => {
    const dir = `${CLAUDE_PROJECTS_DIR}/${flatten(CWD)}`
    mkdirSync(dir, { recursive: true })
    mkdirSync(`${CLAUDE_HOME}/sessions`, { recursive: true })
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
    writeFileSync(`${dir}/${SESSION}.jsonl`, [
      { type: 'user', cwd: CWD, timestamp: at(4 * 60_000), message: { role: 'user', content: 'ship it' } },
      { type: 'assistant', cwd: CWD, timestamp: at(2 * 60_000), message: { role: 'assistant', content: [{ type: 'text', text: 'Shipped. Anything else?' }] } },
    ].map(l => JSON.stringify(l)).join('\n'))
    // The pid has to be one that exists — `liveSessions()` probes it — and the
    // filename only has to be unique to this test.
    const file = `${CLAUDE_HOME}/sessions/${process.pid + 700000}.json`
    writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: SESSION, cwd: CWD, startedAt: Date.now() - 5 * 60_000 }))

    try {
      const waiting = sessionsNeedingAttention().filter(s => s.id === SESSION)
      expect(waiting, 'a live session idle on Claude\'s own last word was not reported').toHaveLength(1)
      expect(waiting[0]!.reason).toBe('finished_turn')

      // Not in `listTerminals()` — a session he opened himself, in his own
      // terminal. He is looking at it. Wake telling him about his own screen
      // is the buzz this refuses.
      await notifySessions()
      expect(notifications().filter(n => n.kind === 'session')).toHaveLength(0)
    } finally {
      rmSync(file, { force: true })
      rmSync(`${dir}/${SESSION}.jsonl`, { force: true })
    }
  })
})
