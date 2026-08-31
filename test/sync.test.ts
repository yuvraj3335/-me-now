/**
 * Sync — the second pipe's button, and the one thing it has to get right.
 *
 * `POST /api/refresh` used to take no argument at all, so "re-poll just Slack"
 * did not exist. Now that it takes one, the argument is the whole risk:
 * `ingest()` selects its adapters by name, so a name it does not recognise
 * selects none of them and the run reports a clean, successful, entirely empty
 * poll. A green tick over a question nobody asked is worse than an error, which
 * is why the scope is checked against a closed list before anything runs.
 *
 * The rest of this is the result line. It reads the report rather than the
 * request, because those are not always the same poll — and because a source
 * with no credential attached must never be rendered as one that synced fine.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { db } from '../src/server/db'
import { api } from '../src/server/api'
import { syncLine } from '../src/web/components/sync'
import { timeOfDay } from '../src/web/lib/time'
import type { SyncReport } from '../src/web/lib/api'

const sync = (body?: unknown) =>
  api.request('/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

beforeEach(() => {
  // A poll groups every live card, so leaving other files' fixtures on the desk
  // would make this file's runs depend on which one ran before it.
  db.query(`DELETE FROM cards`).run()
  db.query(`DELETE FROM card_state`).run()
  db.query(`DELETE FROM sync_runs`).run()
})

describe('a poll can be aimed at one source', () => {
  test('a source Wake does not have is refused, not quietly ignored', async () => {
    const r = await sync({ only: 'jira' })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'unknown source' })
    // Refused means nothing ran: an empty poll that recorded runs would still
    // have moved every source's "last synced" forward.
    expect(db.query(`SELECT COUNT(*) AS n FROM sync_runs`).get()).toEqual({ n: 0 })
  })

  test('a named source is the only one polled', async () => {
    const report = await (await sync({ only: 'slack' })).json() as SyncReport
    expect(report.sources.map(s => s.source)).toEqual(['slack'])
  })

  test('no name polls all five', async () => {
    const report = await (await sync()).json() as SyncReport
    expect(report.sources.map(s => s.source).sort())
      .toEqual(['claude', 'github', 'gmail', 'sentry', 'slack'])
  })

  test('no body at all is still a poll, not a parse error', async () => {
    // What the command palette has always sent, and what the route used to be
    // able to assume. Reading a body it may not have is exactly how a route
    // that took no argument breaks the caller that never passed one.
    const r = await api.request('/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as SyncReport).sources).toHaveLength(5)
  })

  test('the scope is checked before the poll it gates', () => {
    // Presence alone would pass a route that validated after `ingest()` had
    // already started — the same ordering claim the Fetch route carries.
    const src = readFileSync('src/server/api.ts', 'utf8')
    const route = /api\.post\('\/refresh'[\s\S]{0,400}?\n\}\)/.exec(src)?.[0] ?? ''
    expect(route, 'the refresh route vanished or changed shape').toContain('ingest(')
    const guard = route.indexOf('isFetchScope(only)')
    expect(guard, 'the refresh route stopped validating its body').toBeGreaterThan(-1)
    expect(guard, 'the scope guard runs after the poll it was meant to gate')
      .toBeLessThan(route.indexOf('ingest('))
  })
})

const AT = Date.UTC(2026, 7, 31, 9, 30)

const src = (
  source: SyncReport['sources'][number]['source'],
  over: Partial<SyncReport['sources'][number]> = {},
): SyncReport['sources'][number] => ({
  source, ok: true, connected: true, authoritative: true, count: 0, ms: 12, ...over,
})

const report = (sources: SyncReport['sources'], newGroups = 0): SyncReport =>
  ({ at: AT, sources, groups: sources.length, newGroups })

describe('the line says what actually happened', () => {
  test('one source that answered is a sentence about that source', () => {
    const { text } = syncLine(report([src('slack', { count: 12 })], 3))
    expect(text).toBe(`Slack synced 12 · 3 new · ${timeOfDay(AT)}`)
  })

  test('one source nobody connected does not report a successful poll', () => {
    const { text } = syncLine(report([src('sentry', { ok: false, connected: false })]))
    expect(text).toBe(`Sentry not connected · ${timeOfDay(AT)}`)
    // The count of new groups is the part that would read as a green tick.
    expect(text).not.toContain('new')
    expect(text).not.toContain('synced')
  })

  test('one source that went quiet says so instead of counting to zero', () => {
    const { text } = syncLine(report([src('gmail', { ok: false, authoritative: false })]))
    expect(text).toBe(`Gmail didn't answer · ${timeOfDay(AT)}`)
  })

  test('several sources are a tally with the exceptions named', () => {
    const { text } = syncLine(report([
      src('slack', { count: 30 }),
      src('github', { count: 11 }),
      src('gmail', { ok: false, authoritative: false }),
      src('sentry', { ok: false, connected: false }),
      src('claude', { ok: false, connected: false, }),
    ], 3))
    expect(text).toBe(
      `Synced 41 · 3 new · Gmail didn't answer · Sentry and Claude Code not connected · ${timeOfDay(AT)}`,
    )
  })

  test('the rows counted are the rows the sources returned', () => {
    // A partial poll keeps the rows it got. Dropping them from the total would
    // report zero over a source that really did land eight cards.
    const { text } = syncLine(report([
      src('slack', { count: 8, ok: false, authoritative: false }),
      src('github', { count: 2 }),
    ], 1))
    expect(text).toContain('Synced 10')
  })

  test('the reason a source is quiet is on the line that named it', () => {
    const { title } = syncLine(report([
      src('slack', { count: 4 }),
      src('gmail', { ok: false, error: 'rate limited' }),
    ]))
    expect(title.split('\n')).toEqual(['Slack: 4 in 12ms', 'Gmail: rate limited'])
  })
})
