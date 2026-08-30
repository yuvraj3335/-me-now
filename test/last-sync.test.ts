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
