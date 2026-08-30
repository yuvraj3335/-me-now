/**
 * The last finished poll per source must be one row, not a collage.
 *
 * SQLite's `SELECT source, MAX(started_at), ok, connected GROUP BY source`
 * takes `MAX(started_at)` from the latest run and `connected` from any row
 * in the group. That is how a Slack holding a real token rendered
 * "not connected" — an older NotConnected row donated `connected = 0`.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { db, latestFinishedRuns } from '../src/server/db'

beforeEach(() => {
  db.query(`DELETE FROM sync_runs`).run()
})

describe('latestFinishedRuns', () => {
  test('ok and connected come from the same row as the latest started_at', () => {
    db.query(
      `INSERT INTO sync_runs (source, started_at, finished_at, ok, connected, count, error)
       VALUES ('slack', 100, 110, 0, 0, NULL, 'not connected'),
              ('slack', 200, 210, 0, 1, NULL, 'no search tool')`,
    ).run()

    const slack = latestFinishedRuns().find(r => r.source === 'slack')
    expect(slack).toEqual({
      source: 'slack',
      at: 200,
      ok: 0,
      connected: 1,
      count: null,
      error: 'no search tool',
    })
  })

  test('a partial poll that landed rows is still a failed run', () => {
    // The failure this whole alert path exists to make impossible: three of four
    // Slack queries answered, one alert channel could not be read, seven cards
    // landed — and the row must say `ok: 0` with the reason. A source that keeps
    // its count and loses its `ok` is what stops the sweep from deleting the
    // alerts nobody managed to ask about, and stops the desk from rendering a
    // green "synced 2m ago" over a channel that was never read.
    db.query(
      `INSERT INTO sync_runs (source, started_at, finished_at, ok, connected, count, error)
       VALUES ('slack', 400, 410, 0, 1, 7, '1 of 4 queries failed: slack channel read returned object, not text')`,
    ).run()

    const slack = latestFinishedRuns().find(r => r.source === 'slack')
    expect(slack!.ok).toBe(0)
    expect(slack!.connected).toBe(1)
    expect(slack!.count).toBe(7)
    expect(slack!.error).toContain('1 of 4 queries failed')
  })

  test('in-flight and fetch: rows are ignored', () => {
    db.query(
      `INSERT INTO sync_runs (source, started_at, finished_at, ok, connected, count, error)
       VALUES ('slack', 100, 110, 1, 1, 3, NULL),
              ('slack', 200, NULL, NULL, 1, NULL, NULL),
              ('fetch:slack', 300, 310, 1, 1, 0, NULL)`,
    ).run()

    expect(latestFinishedRuns()).toEqual([
      { source: 'slack', at: 100, ok: 1, connected: 1, count: 3, error: null },
    ])
  })
})
