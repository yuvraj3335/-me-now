/**
 * Seed a *local* Wake database with plausible history, so the analytics page
 * can be designed against real-looking shapes instead of empty axes.
 *
 * Development only. It refuses to touch the default data directory, so it can
 * never scribble demo rows into the real one on the DevBox.
 *
 *   WAKE_DATA_DIR=~/.local/share/wake-test bun tools/seed-demo.ts
 */
import { homedir } from 'node:os'

const dir = process.env.WAKE_DATA_DIR
if (!dir || dir === `${homedir()}/.local/share/wake`) {
  console.error('refusing to seed: set WAKE_DATA_DIR to a scratch directory first')
  process.exit(1)
}

const { db, logEvent, uid } = await import('../src/server/db')

const DAY = 864e5
const now = Date.now()

db.query(`DELETE FROM events`).run()
db.query(`DELETE FROM tasks`).run()
db.query(`DELETE FROM goals`).run()

const goals = [
  { title: 'Ship the connections widget', color: '#e9a23b' },
  { title: 'Cut Cloudflare spend in half', color: '#b58ee0' },
  { title: 'Get Truto to 99.9% uptime', color: '#6bd39a' },
]
const goalIds = goals.map(g => {
  const id = uid()
  db.query(`INSERT INTO goals (id, title, color, sort, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(id, g.title, g.color, 0, now - 40 * DAY, now)
  return id
})

const titles = [
  'Fix the 2FA login-token bypass', 'Review PR #2034', 'Reply to Ramesh about tax line items',
  'Ship granular API token scopes', 'Debug the 15Five sync livelock', 'Write the migration for 0155',
  'Chase Zoom OAuth app approval', 'Cut the CLI release', 'Audit the admin action framework',
  'Fix Sentry alert noise', 'Update the docs monitor', 'Triage the Spendflo 5xx spike',
]

/** Real work is bursty and weekday-weighted; a flat random series looks fake. */
function volumeFor(daysAgo: number): number {
  const d = new Date(now - daysAgo * DAY).getDay()
  const weekend = d === 0 || d === 6
  const base = weekend ? 0.5 : 3.1
  // A gentle upward trend, so "pace" has something honest to report.
  const trend = 1 + (30 - daysAgo) / 90
  return Math.max(0, Math.round((base * trend + (Math.random() * 2.4 - 1.2))))
}

let created = 0, done = 0
for (let daysAgo = 45; daysAgo >= 0; daysAgo--) {
  const n = volumeFor(daysAgo)
  for (let i = 0; i < n; i++) {
    // Cluster around a morning and an evening peak rather than uniform hours.
    const peak = Math.random() < 0.62 ? 10 : 21
    const hour = Math.min(23, Math.max(6, Math.round(peak + (Math.random() * 5 - 2.5))))
    const at = new Date(now - daysAgo * DAY).setHours(hour, Math.floor(Math.random() * 60), 0, 0)
    if (at > now) continue

    const id = uid()
    const title = titles[Math.floor(Math.random() * titles.length)]!
    const goal = Math.random() < 0.55 ? goalIds[Math.floor(Math.random() * goalIds.length)]! : null
    // A real backlog always has stragglers, so leave some old work open too.
    const isDone = daysAgo > 1 ? Math.random() < 0.86 : Math.random() < 0.4

    db.query(
      `INSERT INTO tasks (id, title, status, goal_id, sort, created_at, updated_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, title, isDone ? 'done' : (Math.random() < 0.4 ? 'doing' : 'todo'), goal, -at,
          at - 3.6e6, at, isDone ? at : null)

    logEvent('task_created', { task_id: id, at: at - 3.6e6 })
    created++
    if (isDone) { logEvent('task_done', { task_id: id, at }); done++ }
  }

  // Cards arriving and being cleared, with a realistic response lag.
  const arrivals = Math.round(volumeFor(daysAgo) * 1.4)
  for (let i = 0; i < arrivals; i++) {
    const g = `demo:${daysAgo}:${i}`
    const at = now - daysAgo * DAY - Math.random() * DAY
    logEvent('card_appeared', { group_key: g, at, source: ['slack', 'github', 'gmail'][i % 3] })
    if (Math.random() < 0.82) {
      // Lag shrinks over time, so the response-time trend actually trends.
      const lag = (0.4 + Math.random() * 6) * 3.6e6 * (1 + daysAgo / 40)
      const ackAt = at + lag
      if (ackAt < now) logEvent('card_acked', { group_key: g, at: ackAt })
    }
  }
}

console.log(`seeded ${created} tasks (${done} done) + ${goals.length} goals across 45 days`)
