/**
 * Analytics queries. Everything here reads the append-only `events` log plus
 * the live tables, so the charts show what actually happened rather than a
 * derived guess. All bucketing is done in the user's local timezone, passed in
 * as a UTC offset, because "tasks done on Tuesday" is a local-clock question.
 */
import { Hono } from 'hono'
import { db } from './db'

export const analytics = new Hono()

type Row = Record<string, any>

const DAY = 864e5
const offsetOf = (c: any) => Number(c.req.query('tzOffsetMinutes') ?? 0) || 0

/** Local day key (YYYY-MM-DD) for an epoch, given the client's UTC offset. */
const dayKey = (t: number, offMin: number) => new Date(t - offMin * 60_000).toISOString().slice(0, 10)

function emptyDays(days: number, offMin: number): Map<string, number> {
  const out = new Map<string, number>()
  const today = Date.now()
  for (let i = days - 1; i >= 0; i--) out.set(dayKey(today - i * DAY, offMin), 0)
  return out
}

function seriesOf(rows: Array<{ at: number }>, days: number, offMin: number) {
  const m = emptyDays(days, offMin)
  const cutoff = Date.now() - days * DAY
  for (const r of rows) {
    if (r.at < cutoff) continue
    const k = dayKey(r.at, offMin)
    if (m.has(k)) m.set(k, m.get(k)! + 1)
  }
  return [...m].map(([day, value]) => ({ day, value }))
}

analytics.get('/', c => {
  const off = offsetOf(c)
  const days = Math.min(Number(c.req.query('days') ?? 30) || 30, 180)
  const since = Date.now() - days * DAY

  const ev = (kind: string) =>
    db.query<{ at: number }, [string, number]>(
      `SELECT at FROM events WHERE kind = ? AND at >= ?`,
    ).all(kind, since)

  const done = ev('task_done')
  const appeared = ev('card_appeared')
  /**
   * What actually takes a card off the list.
   *
   * This counted `card_acked`, which nothing in the product emits any more — so
   * "Cleared" was an empty chart at every range, and "The pile" was permanently
   * half a panel. Done and Not-mine are the two events that remove a card, and
   * an acknowledgement still counts because it is also a card he dealt with.
   */
  const cleared = [...ev('card_done'), ...ev('card_not_mine'), ...ev('card_acked')]
    .sort((a, b) => a.at - b.at)

  /* --- throughput ------------------------------------------------------- */
  const throughput = {
    done: seriesOf(done, days, off),
    appeared: seriesOf(appeared, days, off),
    cleared: seriesOf(cleared, days, off),
  }

  /* --- response time: how long a thing waits before I touch it ---------- */
  const responses = db.query<Row, [number]>(
    `SELECT a.group_key AS g, MIN(a.at) AS appeared, MIN(k.at) AS acked
       FROM events a
       JOIN events k ON k.group_key = a.group_key AND k.kind IN ('card_acked','card_done') AND k.at >= a.at
      WHERE a.kind = 'card_appeared' AND a.at >= ?
      GROUP BY a.group_key`,
  ).all(since)

  const latencies = responses.map(r => r.acked - r.appeared).filter(n => n >= 0).sort((a, b) => a - b)
  const pct = (p: number) => (latencies.length ? latencies[Math.floor((latencies.length - 1) * p)]! : 0)

  const responseTime = {
    count: latencies.length,
    p50: pct(0.5), p90: pct(0.9),
    // Same measure, per day, so "am I getting faster?" is answerable.
    daily: (() => {
      const buckets = new Map<string, number[]>()
      for (const r of responses) {
        const k = dayKey(r.appeared, off)
        let arr = buckets.get(k)
        if (!arr) buckets.set(k, (arr = []))
        arr.push(r.acked - r.appeared)
      }
      return [...emptyDays(days, off).keys()].map(day => {
        const v = (buckets.get(day) ?? []).sort((a, b) => a - b)
        return { day, value: v.length ? v[Math.floor((v.length - 1) * 0.5)]! : null }
      })
    })(),
  }

  /* --- rate of work: this period against the one before ----------------- */
  //
  // Against the SELECTED period, not a fixed week. The range control moved only
  // the x-axis before this: every tile and panel was character-identical across
  // 7d, 30d and 90d, which reads as a control that does nothing.
  //
  // `delta` is null rather than 1 when the previous period was empty. Zero to
  // three is not a hundred per cent increase, and printing one on a page that
  // ends "nothing is estimated" is the page contradicting itself.
  const countIn = (rows: Array<{ at: number }>, from: number, to: number) =>
    rows.filter(r => r.at >= from && r.at < to).length
  const span = days * DAY
  const t = Date.now()
  const allDoneEvents = db.query<{ at: number }, []>(
    `SELECT at FROM events WHERE kind = 'task_done'`,
  ).all()
  const period = countIn(done, t - span, t)
  const previous = countIn(allDoneEvents, t - 2 * span, t - span)
  const pace = {
    days,
    period,
    previous,
    delta: previous === 0 ? null : (period - previous) / previous,
  }

  /* --- rhythm: when I actually work ------------------------------------- */
  // Windowed, like `pace` already was. Unbounded, "when you work" was the one
  // panel the range control could not move: 7d, 30d and 90d drew a
  // character-identical clock, which reads as a control that does nothing.
  const windowDone = db.query<{ at: number }, [number]>(
    `SELECT at FROM events WHERE kind IN ('task_done','card_acked') AND at >= ?`,
  ).all(since)
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, value: 0 }))
  const byWeekday = Array.from({ length: 7 }, (_, d) => ({ weekday: d, value: 0 }))
  for (const r of windowDone) {
    const local = new Date(r.at - off * 60_000)
    byHour[local.getUTCHours()]!.value++
    byWeekday[local.getUTCDay()]!.value++
  }

  /* --- streak: consecutive local days with something finished ----------- */
  // Deliberately its own, unbounded query. A streak is an all-time fact and the
  // page labels it as one; reading it off the windowed set would silently cap it
  // at the range and make "best 14" become "best 7" for no reason the reader can
  // see.
  const everDone = db.query<{ at: number }, []>(
    `SELECT at FROM events WHERE kind IN ('task_done','card_acked')`,
  ).all()
  const doneDays = new Set(everDone.map(r => dayKey(r.at, off)))
  // Count back from today. An empty *today* does not break the streak — the day
  // is not over yet — but an empty earlier day does.
  let streak = 0
  for (let i = 0; i < 365; i++) {
    const k = dayKey(Date.now() - i * DAY, off)
    if (doneDays.has(k)) { streak++; continue }
    if (i > 0) break
  }
  const bestStreak = (() => {
    const sorted = [...doneDays].sort()
    let best = 0, run = 0, prev = ''
    for (const d of sorted) {
      run = prev && Date.parse(d) - Date.parse(prev) === DAY ? run + 1 : 1
      best = Math.max(best, run)
      prev = d
    }
    return best
  })()

  /* --- what is piling up ------------------------------------------------ */
  // `status`, not `done_at`/`not_mine`. Those two are kept in sync by the card
  // API and still work, but they are the old vocabulary — a card is off the desk
  // because he said Done or Won't do, and a row whose state predates the status
  // column has NULL there and is still on it.

  // No snooze clause, and that is the fix rather than an omission. This set is
  // the donut's slices; `openNow` below is the number printed in the middle of
  // it, and the two have to select the same rows or the ring reports a whole it
  // does not add up to. It did: one snoozed card made the slices sum to 111
  // against a centre of 112, and the percentages beside them totalled 99%. A
  // snoozed card is still on the desk — `/api/state` sends it, the table renders
  // it, and its status is still one of the three that means it is on him — so
  // the answer is for the slices to count it, not for the centre to stop.
  const aging = db.query<{ source: string; first_seen_at: number }, []>(
    `SELECT c.source AS source, s.first_seen_at AS first_seen_at
       FROM cards c
       JOIN card_state s ON s.group_key = c.group_key
      WHERE c.gone = 0 AND (s.status IS NULL OR s.status NOT IN ('done','wont_do'))
      GROUP BY c.group_key
      -- Ordered, so the donut's slices keep their positions between polls. An
      -- unordered GROUP BY let two sources swap places on a refresh, which reads
      -- as the data having moved.
      ORDER BY c.source`,
  ).all()

  const BUCKETS: Array<[string, number, number]> = [
    ['today', 0, 1], ['2–3d', 1, 3], ['4–7d', 3, 7], ['1–2w', 7, 14], ['older', 14, Infinity],
  ]
  const agingBySource = new Map<string, Record<string, number>>()
  for (const a of aging) {
    const ageDays = (Date.now() - a.first_seen_at) / DAY
    const bucket = BUCKETS.find(([, lo, hi]) => ageDays >= lo && ageDays < hi)?.[0] ?? 'older'
    const rec = agingBySource.get(a.source) ?? Object.fromEntries(BUCKETS.map(b => [b[0], 0]))
    rec[bucket]!++
    agingBySource.set(a.source, rec)
  }

  /* --- goals ------------------------------------------------------------ */
  const goals = db.query<Row, []>(
    `SELECT g.id, g.title, g.color, g.target_date,
            COUNT(t.id) AS total,
            SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
       FROM goals g LEFT JOIN tasks t ON t.goal_id = g.id
      WHERE g.archived = 0
      GROUP BY g.id ORDER BY g.sort`,
  ).all()

  const openNow = db.query<Row, []>(
    `SELECT COUNT(DISTINCT c.group_key) AS n FROM cards c
       JOIN card_state s ON s.group_key = c.group_key
      WHERE c.gone = 0 AND (s.status IS NULL OR s.status NOT IN ('done','wont_do'))`,
  ).get()!.n

  return c.json({
    days,
    throughput,
    responseTime,
    pace,
    rhythm: { byHour, byWeekday, streak, bestStreak },
    aging: [...agingBySource].map(([source, buckets]) => ({ source, buckets })),
    agingBuckets: BUCKETS.map(b => b[0]),
    goals,
    // `doneAllTime` and `tasksOpen` were two COUNT queries nothing rendered.
    // `openNow` is the canonical count of what is on the desk, and the `aging`
    // query above is required to be the same set. The donut's centre is summed
    // from its own slices now rather than sent — a centre that arrives beside
    // the arcs instead of out of them is a number that can disagree with them,
    // and it did — so this is the thing the ring is checked *against* rather
    // than the thing it prints.
    totals: { openNow },
  })
})
