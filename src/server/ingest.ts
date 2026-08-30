/**
 * Poll every source, normalize, group, and persist.
 *
 * The subtle part is group migration. Group keys are not stable over time: a
 * Slack message linking to PR #2034 can arrive *after* that PR's own card, and
 * at that moment two existing groups become one. When that happens the merged
 * group must inherit the union of my state — otherwise something I already
 * acknowledged would reappear as new, and something I was already reminded
 * about could notify me a second time. That inheritance is what makes the
 * brief's hard requirement hold across time rather than only within one poll.
 */
import { db, logEvent, now } from './db'
import { cardId, groupCards } from './dedup'
import { NotConnected, type RawCard, type SourceAdapter, type SourceName } from './sources/types'
import { github } from './sources/github'
import { claudeSessions } from './sources/claudeSessions'
import { slack } from './sources/slack'
import { gmail } from './sources/gmail'
import { sentry } from './sources/sentry'

export const ADAPTERS: SourceAdapter[] = [slack, github, gmail, sentry, claudeSessions]
export const adapterFor = (n: string) => ADAPTERS.find(a => a.name === n)

export type IngestReport = {
  at: number
  sources: Array<{
    source: SourceName
    ok: boolean
    /**
     * Whether there was anything to poll. A source nobody has connected is not
     * a failure and not a success — reporting it as either is what made the
     * Home page say "Slack now" about an account that does not exist.
     */
    connected: boolean
    count: number
    ms: number
    error?: string
  }>
  groups: number
  newGroups: number
}

let running: Promise<IngestReport> | null = null

/** Never let two polls overlap; a slow source would otherwise stack them up. */
export function ingest(only?: SourceName): Promise<IngestReport> {
  if (running) return running
  running = doIngest(only).finally(() => { running = null })
  return running
}

async function doIngest(only?: SourceName): Promise<IngestReport> {
  const at = now()
  const adapters = only ? ADAPTERS.filter(a => a.name === only) : ADAPTERS
  const report: IngestReport = { at, sources: [], groups: 0, newGroups: 0 }

  const fetched = new Map<SourceName, RawCard[]>()

  await Promise.all(
    adapters.map(async a => {
      const t0 = Date.now()
      const runId = db.query(`INSERT INTO sync_runs (source, started_at) VALUES (?, ?) RETURNING id`)
        .get(a.name, t0) as { id: number } | null
      try {
        const cards = await a.fetch()
        fetched.set(a.name, cards)
        report.sources.push({ source: a.name, ok: true, connected: true, count: cards.length, ms: Date.now() - t0 })
        db.query(`UPDATE sync_runs SET finished_at = ?, ok = 1, connected = 1, count = ? WHERE id = ?`)
          .run(Date.now(), cards.length, runId?.id ?? 0)
      } catch (e) {
        // "Nobody has connected this" is recorded as a run that did not happen,
        // not as one that failed: there is nothing wrong to fix, and calling it
        // an error would put a warning on the Home page for every source the
        // reader has deliberately not set up.
        const disconnected = e instanceof NotConnected
        const error = (e as Error).message
        report.sources.push({
          source: a.name, ok: false, connected: !disconnected,
          count: 0, ms: Date.now() - t0, error,
        })
        db.query(`UPDATE sync_runs SET finished_at = ?, ok = 0, connected = ?, error = ? WHERE id = ?`)
          .run(Date.now(), disconnected ? 0 : 1, error.slice(0, 500), runId?.id ?? 0)
      }
    }),
  )

  // Group over *all* live cards, not just this round's, so a card that arrives
  // now can merge with one stored days ago.
  const survivors: RawCard[] = []
  for (const [, cards] of fetched) survivors.push(...cards)

  const keptSources = new Set(fetched.keys())
  const existing = db.query<any, []>(`SELECT * FROM cards WHERE gone = 0`).all()
  for (const row of existing) {
    // A source that failed this round keeps its cards; one that succeeded is
    // authoritative, and anything it no longer returns is gone.
    if (keptSources.has(row.source) && report.sources.find(s => s.source === row.source)?.ok) continue
    survivors.push({
      source: row.source, source_id: row.source_id, account: row.account ?? undefined,
      kind: row.kind, title: row.title, why: row.why, actor: row.actor ?? undefined,
      actor_id: row.actor_id ?? undefined, who: row.who ?? undefined,
      excerpt: row.excerpt ?? undefined, url: row.url,
      ts: row.ts, pile: row.pile ?? 'open', refs: JSON.parse(row.refs || '[]'),
      meta: JSON.parse(row.meta || '{}'),
    })
  }

  const groups = groupCards(survivors)

  const tx = db.transaction(() => {
    const fresh = new Set<string>()

    for (const [, cards] of fetched) {
      for (const c of cards) {
        const id = cardId(c)
        const gk = groups.get(id) ?? id
        fresh.add(id)

        const prev = db.query<{ group_key: string; first_seen_at: number }, [string]>(
          `SELECT group_key, first_seen_at FROM cards WHERE id = ?`,
        ).get(id)

        db.query(
          `INSERT INTO cards (id, source, source_id, account, group_key, kind, title, why, actor, actor_id,
                              who, excerpt, url, ts, pile, refs, meta, first_seen_at, last_seen_at, gone)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
           ON CONFLICT(id) DO UPDATE SET
             group_key = excluded.group_key, kind = excluded.kind, title = excluded.title,
             why = excluded.why, actor = excluded.actor, who = excluded.who,
             excerpt = excluded.excerpt,
             url = excluded.url, ts = excluded.ts, pile = excluded.pile,
             refs = excluded.refs, meta = excluded.meta,
             last_seen_at = excluded.last_seen_at, gone = 0`,
        ).run(
          id, c.source, c.source_id, c.account ?? null, gk, c.kind, c.title, c.why,
          c.actor ?? null, c.actor_id ?? null, c.who ?? null,
          c.excerpt ?? null, c.url, c.ts, c.pile,
          JSON.stringify(c.refs), JSON.stringify(c.meta ?? {}),
          prev?.first_seen_at ?? at, at,
        )

        if (prev && prev.group_key !== gk) migrateState(prev.group_key, gk)
      }
    }

    // Cards a healthy source stopped returning are marked gone, not deleted:
    // history is what the analytics page is made of.
    for (const s of report.sources) {
      if (!s.ok) continue
      const ids = [...fresh].filter(i => i.startsWith(`${s.source}:`))
      const ph = ids.length ? ids.map(() => '?').join(',') : "''"
      db.query(`UPDATE cards SET gone = 1 WHERE source = ? AND gone = 0 AND id NOT IN (${ph})`)
        .run(s.source, ...ids)
    }

    // Ensure a state row per live group, and count the genuinely new ones.
    const liveGroups = db.query<{ group_key: string; ts: number }, []>(
      `SELECT group_key, MAX(ts) AS ts FROM cards WHERE gone = 0 GROUP BY group_key`,
    ).all()
    report.groups = liveGroups.length

    for (const g of liveGroups) {
      const had = db.query<{ group_key: string }, [string]>(
        `SELECT group_key FROM card_state WHERE group_key = ?`,
      ).get(g.group_key)
      if (had) continue
      db.query(
        `INSERT INTO card_state (group_key, first_seen_at, updated_at) VALUES (?, ?, ?)`,
      ).run(g.group_key, at, at)
      logEvent('card_appeared', { group_key: g.group_key, at })
      report.newGroups++
    }
  })

  tx()
  return report
}

/**
 * Merge my state from an old group key into the new one. Every field takes the
 * "already handled" side of the merge: if either group was acknowledged or
 * notified, the merged group counts as acknowledged and notified.
 */
function migrateState(from: string, to: string) {
  const src = db.query<any, [string]>(`SELECT * FROM card_state WHERE group_key = ?`).get(from)
  if (!src) return
  const dst = db.query<any, [string]>(`SELECT * FROM card_state WHERE group_key = ?`).get(to)

  const maxN = (a: number | null, b: number | null) => (a && b ? Math.max(a, b) : (a ?? b))
  const minN = (a: number | null, b: number | null) => (a && b ? Math.min(a, b) : (a ?? b))

  if (!dst) {
    db.query(
      `INSERT INTO card_state (group_key, pile_override, snoozed_until, acked_at, notified_at,
                               not_mine, done_at, pinned, first_seen_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(to, src.pile_override, src.snoozed_until, src.acked_at, src.notified_at,
          src.not_mine, src.done_at, src.pinned, src.first_seen_at, now())
  } else {
    db.query(
      `UPDATE card_state SET
         pile_override = COALESCE(pile_override, ?), snoozed_until = ?, acked_at = ?,
         notified_at = ?, not_mine = ?, done_at = ?, pinned = ?, first_seen_at = ?, updated_at = ?
       WHERE group_key = ?`,
    ).run(
      src.pile_override,
      maxN(dst.snoozed_until, src.snoozed_until),
      maxN(dst.acked_at, src.acked_at),
      // Earliest notification wins: once notified, always notified.
      minN(dst.notified_at, src.notified_at),
      dst.not_mine || src.not_mine ? 1 : 0,
      maxN(dst.done_at, src.done_at),
      dst.pinned || src.pinned ? 1 : 0,
      Math.min(dst.first_seen_at, src.first_seen_at),
      now(), to,
    )
  }

  // Anything pointing at the old key follows it, so a task or a live reminder
  // made from one source survives that source merging into another.
  db.query(`UPDATE tasks SET source_card_group = ? WHERE source_card_group = ?`).run(to, from)
  db.query(
    `UPDATE OR IGNORE reminders SET target_id = ?
     WHERE target_kind = 'card' AND target_id = ?`,
  ).run(to, from)
  db.query(`UPDATE events SET group_key = ? WHERE group_key = ?`).run(to, from)
  db.query(`DELETE FROM card_state WHERE group_key = ?`).run(from)
}
