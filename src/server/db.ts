import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DATA_DIR } from './env'

const DB_PATH = `${DATA_DIR}/wake.sqlite`
mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH, { create: true })

// WAL keeps the poll loop's writes from blocking the UI's reads. `busy_timeout`
// is the difference between a transient lock and a 500 on someone's phone.
db.exec(`PRAGMA journal_mode = WAL`)
db.exec(`PRAGMA busy_timeout = 5000`)
db.exec(`PRAGMA foreign_keys = ON`)
db.exec(`PRAGMA synchronous = NORMAL`)

db.exec(`
-- ---------------------------------------------------------------------------
-- OUTSIDE WORLD (read-only mirror). One row per thing per source. Wake never
-- writes back to any of these systems; rows here are a cache of a tool result.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cards (
  id            TEXT PRIMARY KEY,          -- "<source>:<source_id>", stable identity
  source        TEXT NOT NULL,             -- slack | gmail | github | sentry | claude
  source_id     TEXT NOT NULL,
  account       TEXT,                      -- which inbox/org this came from
  group_key     TEXT NOT NULL,             -- dedup unit; several cards may share one
  kind          TEXT NOT NULL,             -- dm | mention | thread | review | issue | email | session | error
  title         TEXT NOT NULL,
  why           TEXT NOT NULL,             -- why this is on me, in plain words
  actor         TEXT,                      -- who put it there
  actor_id      TEXT,
  excerpt       TEXT,
  url           TEXT NOT NULL,             -- deep link into the real app
  ts            INTEGER NOT NULL,          -- when it happened (epoch ms)
  pile          TEXT NOT NULL DEFAULT 'open', -- the source's own claim, before my state
  refs          TEXT NOT NULL DEFAULT '[]',-- extracted hard references, JSON array
  meta          TEXT NOT NULL DEFAULT '{}',
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  gone          INTEGER NOT NULL DEFAULT 0 -- vanished upstream; kept for history
);
CREATE INDEX IF NOT EXISTS cards_group  ON cards(group_key);
CREATE INDEX IF NOT EXISTS cards_ts     ON cards(ts DESC);
CREATE INDEX IF NOT EXISTS cards_source ON cards(source, gone);

-- ---------------------------------------------------------------------------
-- MY STATE, keyed by GROUP rather than by card. This is what makes "don't show
-- me the same thing twice" and "one reminder per thing" hold: a second source
-- for the same underlying thing lands on a group that is already acknowledged,
-- so it cannot resurface as new and cannot notify again.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_state (
  group_key     TEXT PRIMARY KEY,
  pile_override TEXT,                      -- manual move always beats the rule
  snoozed_until INTEGER,
  acked_at      INTEGER,
  notified_at   INTEGER,                   -- set once, ever
  not_mine      INTEGER NOT NULL DEFAULT 0,
  done_at       INTEGER,
  pinned        INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- MY OWN WORK. Independent of cards on purpose: a task made from a Slack
-- message must survive that message being deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS goals (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  detail       TEXT,
  color        TEXT,
  target_date  INTEGER,
  archived     INTEGER NOT NULL DEFAULT 0,
  sort         REAL NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  detail            TEXT,
  status            TEXT NOT NULL DEFAULT 'todo',  -- todo | doing | done
  goal_id           TEXT REFERENCES goals(id) ON DELETE SET NULL,
  source_card_group TEXT,                          -- provenance, not a dependency
  due_at            INTEGER,
  color             TEXT,
  sort              REAL NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  started_at        INTEGER,
  completed_at      INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, sort);
CREATE INDEX IF NOT EXISTS tasks_goal   ON tasks(goal_id);
CREATE INDEX IF NOT EXISTS tasks_due    ON tasks(due_at) WHERE due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  goal_id    TEXT REFERENCES goals(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  color      TEXT,
  sort       REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_task ON notes(task_id);
CREATE INDEX IF NOT EXISTS notes_goal ON notes(goal_id);

-- ---------------------------------------------------------------------------
-- REMINDERS. The partial UNIQUE index below is the hard requirement in schema
-- form: a target can have at most one *live* reminder, so a duplicate source
-- physically cannot create a second notification.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminders (
  id           TEXT PRIMARY KEY,
  target_kind  TEXT NOT NULL,              -- task | goal | card
  target_id    TEXT NOT NULL,              -- task id | goal id | group_key
  fire_at      INTEGER NOT NULL,
  label        TEXT,
  repeat_rule  TEXT,                       -- null | daily | weekdays | weekly
  fired_at     INTEGER,
  dismissed_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reminders_one_live_per_target
  ON reminders(target_kind, target_id)
  WHERE fired_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(fire_at) WHERE fired_at IS NULL;

-- ---------------------------------------------------------------------------
-- PUSH. "dedup_key" is UNIQUE so the same thing can never be pushed twice,
-- independent of how many sources or poll cycles produced it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  ua         TEXT,
  label      TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  dedup_key  TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  body       TEXT,
  url        TEXT,
  kind       TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at DESC);

-- ---------------------------------------------------------------------------
-- ANALYTICS. An append-only log; every chart is a query over this, so the
-- analytics page shows what actually happened rather than a derived guess.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL,                 -- card_appeared | card_acked | task_created | task_done | ...
  group_key TEXT,
  task_id   TEXT,
  source    TEXT,
  at        INTEGER NOT NULL,
  meta      TEXT
);
CREATE INDEX IF NOT EXISTS events_at   ON events(at DESC);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, at DESC);

-- ---------------------------------------------------------------------------
-- CONNECTIONS. Wake's own OAuth store (chain step 1 in DECISIONS.md #2).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_tokens (
  server        TEXT PRIMARY KEY,
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    INTEGER,
  scope         TEXT,
  client_id     TEXT,
  client_secret TEXT,
  metadata      TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_pending (
  state      TEXT PRIMARY KEY,
  server     TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  redirect   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  meta       TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  ok          INTEGER,
  count       INTEGER,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS sync_runs_source ON sync_runs(source, started_at DESC);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`)

export function kvGet(k: string): string | null {
  const r = db.query<{ v: string }, [string]>(`SELECT v FROM kv WHERE k = ?`).get(k)
  return r?.v ?? null
}
export function kvSet(k: string, v: string) {
  db.query(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v)
}

export function logEvent(kind: string, fields: { group_key?: string; task_id?: string; source?: string; at?: number; meta?: unknown } = {}) {
  db.query(`INSERT INTO events (kind, group_key, task_id, source, at, meta) VALUES (?, ?, ?, ?, ?, ?)`).run(
    kind,
    fields.group_key ?? null,
    fields.task_id ?? null,
    fields.source ?? null,
    fields.at ?? Date.now(),
    fields.meta === undefined ? null : JSON.stringify(fields.meta),
  )
}

export const now = () => Date.now()
export const uid = () => crypto.randomUUID()
