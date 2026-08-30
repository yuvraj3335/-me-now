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

-- ===========================================================================
-- THE WORKSPACE. What Wake indexes so a brief can name a real repository and a
-- real skill, and the audit trail of everything it ran or handed over.
--
-- Wake used to run a model in-process, with tables for conversations, turns,
-- events and approvals. It does not any more: "Open in Claude" hands a packed
-- brief to Claude under your own login, so there is no loop here to narrate and
-- no credential here to hold. Migration 4 drops what that left behind.
-- ===========================================================================

-- One row per git repository discovered under the workspace root.
CREATE TABLE IF NOT EXISTS repos (
  path            TEXT PRIMARY KEY,        -- canonical absolute path
  name            TEXT NOT NULL,
  remote          TEXT,
  branch          TEXT,
  default_branch  TEXT,
  dirty           INTEGER NOT NULL DEFAULT 0,
  ahead           INTEGER NOT NULL DEFAULT 0,
  behind          INTEGER NOT NULL DEFAULT 0,
  language        TEXT,
  package_manager TEXT,
  summary         TEXT,                    -- first meaningful README line
  claude_md       TEXT NOT NULL DEFAULT '[]', -- paths, JSON array
  cursor_rules    TEXT NOT NULL DEFAULT '[]',
  skills          TEXT NOT NULL DEFAULT '[]', -- repo-local skill ids
  topics          TEXT NOT NULL DEFAULT '[]', -- curated routing keywords
  commands        TEXT NOT NULL DEFAULT '{}', -- {test,typecheck,build,dev}
  role            TEXT NOT NULL DEFAULT 'canonical', -- canonical|worktree|fork|poc|archived|content
  upstream        TEXT,                    -- for worktrees: the canonical repo path
  last_commit_at  INTEGER,
  scanned_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS repos_role ON repos(role);
CREATE INDEX IF NOT EXISTS repos_name ON repos(name);

-- Skill metadata only. Bodies are read through the loader on demand and never
-- stored here, which is what keeps "manifest-first" true rather than aspirational.
CREATE TABLE IF NOT EXISTS skills (
  id            TEXT PRIMARY KEY,          -- "<catalog>/<name>"
  catalog       TEXT NOT NULL,             -- A|B|C
  name          TEXT NOT NULL,
  title         TEXT,
  description   TEXT,
  when_to_use   TEXT,
  surface       TEXT,                      -- which tool surface it targets
  requires      TEXT NOT NULL DEFAULT '[]',-- prerequisite skill ids, JSON array
  mutating      INTEGER NOT NULL DEFAULT 0,-- needs truto-safe-admin-operator alongside
  path          TEXT NOT NULL,             -- file to load lazily
  sha           TEXT,                      -- content hash at index time
  bytes         INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS skills_catalog ON skills(catalog);

-- Every command the adapter ran, whether or not it mutated anything.
CREATE TABLE IF NOT EXISTS cli_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile     TEXT,
  argv        TEXT NOT NULL,               -- redacted, JSON array
  class       TEXT NOT NULL,               -- read | provider_read | mutation | high_risk
  exit_code   INTEGER,
  ms          INTEGER,
  ok          INTEGER NOT NULL DEFAULT 0,
  stdout_head TEXT,
  stderr_head TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cli_audit_at ON cli_audit(at DESC);

-- A backup taken before an admin write, so a bad apply is reversible.
CREATE TABLE IF NOT EXISTS admin_backups (
  id         TEXT PRIMARY KEY,
  resource   TEXT NOT NULL,
  ref        TEXT NOT NULL,
  profile    TEXT,
  before     TEXT NOT NULL,                -- redacted snapshot, JSON
  after      TEXT,
  applied_at INTEGER,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_backups_at ON admin_backups(at DESC);

-- NOTE: eng_sessions used to be created here. Migration 2 drops it, and a
-- CREATE IF NOT EXISTS in this block runs on every boot -- so leaving it would
-- resurrect the table on the restart after the migration and make the drop a
-- lie. A table a migration removes must not also be in the baseline.

`)

/* ==========================================================================
 * MIGRATIONS
 *
 * Everything above is the baseline schema, written with CREATE IF NOT EXISTS so
 * it is safe to re-run. Everything a later version adds goes below, numbered and
 * recorded, because "add another CREATE to the boot block" stops working the
 * moment a change is not idempotent — an ALTER, a backfill, a DROP. The runner
 * is four lines; the discipline is the point.
 * ======================================================================== */

db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`)

/**
 * A migration is SQL, code, or both.
 *
 * Code is not a convenience: SQLite has no `DROP COLUMN IF EXISTS`, and a
 * migration that removes a column the baseline no longer creates would fail on a
 * fresh database while succeeding on an old one. That is the same
 * fresh-versus-upgraded divergence migrations exist to prevent, so the check has
 * to happen at runtime.
 */
type Migration = { id: number; name: string; sql?: string; run?: () => void }

const hasColumn = (table: string, column: string) =>
  db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(c => c.name === column)

/** Idempotent column removal, for a column the baseline may or may not create. */
function dropColumn(table: string, column: string) {
  if (hasColumn(table, column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'operations-console',
    sql: `
-- Every tool call a turn made, with what it cost and whether a human gated it.
-- turn_events already carries these for the UI; this is the queryable form the
-- inspector and the audit view read, without parsing JSON payloads.
CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL,
  conv_id     TEXT,
  name        TEXT NOT NULL,
  cls         TEXT,                       -- read | provider_read | mutation | high_risk
  mutates     INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER,
  ms          INTEGER,
  approval_id TEXT,
  error       TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_tool_calls_turn ON agent_tool_calls(turn_id, at);

-- The SECURITY audit log. Deliberately not the "events" table: that one feeds
-- the Pulse page, it is written by the card pipeline on every poll, and
-- mixing "a task moved to done" with "an email was sent to a customer" makes
-- both unreadable and lets a retention policy on one quietly delete the other.
CREATE TABLE IF NOT EXISTS audit_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind     TEXT NOT NULL,                 -- mail.send | claude.pack | claude.handoff | …
  actor    TEXT NOT NULL DEFAULT 'user',
  target   TEXT,                          -- what it acted on, in one line
  detail   TEXT,                          -- redacted JSON
  ok       INTEGER NOT NULL DEFAULT 1,
  error    TEXT,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_at   ON audit_events(at DESC);
CREATE INDEX IF NOT EXISTS audit_events_kind ON audit_events(kind, at DESC);

-- A confirmation token bound to the exact arguments it was granted for. The
-- fingerprint is what makes "edit the body after approving" fail closed: a
-- changed body hashes differently, so the token no longer describes the send.
CREATE TABLE IF NOT EXISTS confirmations (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  summary     TEXT,
  state       TEXT NOT NULL DEFAULT 'issued',  -- issued | used | expired
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX IF NOT EXISTS confirmations_expiry ON confirmations(expires_at);

-- Mail cache. Metadata for a list page; bodies only for threads actually opened,
-- with a TTL. Copying a mailbox into SQLite would be a second, stale mailbox.
CREATE TABLE IF NOT EXISTS mail_threads (
  id           TEXT PRIMARY KEY,          -- "<account>:<threadId>"
  account      TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  subject      TEXT NOT NULL DEFAULT '',
  snippet      TEXT,
  from_name    TEXT,
  from_addr    TEXT,
  to_addrs     TEXT NOT NULL DEFAULT '[]',
  labels       TEXT NOT NULL DEFAULT '[]',
  unread       INTEGER NOT NULL DEFAULT 0,
  starred      INTEGER NOT NULL DEFAULT 0,
  to_me        INTEGER NOT NULL DEFAULT 0,
  msg_count    INTEGER NOT NULL DEFAULT 1,
  ts           INTEGER NOT NULL,
  body_fetched_at INTEGER,
  fetched_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_threads_account ON mail_threads(account, ts DESC);
CREATE INDEX IF NOT EXISTS mail_threads_ts      ON mail_threads(ts DESC);

CREATE TABLE IF NOT EXISTS mail_messages (
  id          TEXT PRIMARY KEY,           -- "<account>:<messageId>"
  thread_key  TEXT NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  account     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  rfc_id      TEXT,
  from_name   TEXT,
  from_addr   TEXT,
  to_addrs    TEXT NOT NULL DEFAULT '[]',
  cc_addrs    TEXT NOT NULL DEFAULT '[]',
  subject     TEXT,
  text_body   TEXT,
  html_body   TEXT,                       -- sanitized at write time, never raw
  attachments TEXT NOT NULL DEFAULT '[]', -- metadata only; Wake stores no blobs
  ts          INTEGER NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mail_messages_thread ON mail_messages(thread_key, seq);

-- A brief and the objects packed into it. Nothing here records a process,
-- because Wake starts none: "opened" means the link was produced.
CREATE TABLE IF NOT EXISTS launch_packs (
  id            TEXT PRIMARY KEY,
  template      TEXT NOT NULL,
  title         TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  repo_name     TEXT,
  status        TEXT NOT NULL,            -- draft | opened
  first_message TEXT NOT NULL DEFAULT '',
  skills        TEXT NOT NULL DEFAULT '[]',
  pack_path     TEXT,
  created_at    INTEGER NOT NULL,
  launched_at   INTEGER                   -- when the link was produced
);
CREATE INDEX IF NOT EXISTS launch_packs_created ON launch_packs(created_at DESC);

CREATE TABLE IF NOT EXISTS launch_pack_items (
  id      TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES launch_packs(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,                  -- card | mail | slack | sentry | notion | github | session | note
  ref     TEXT NOT NULL,
  title   TEXT,
  url     TEXT,
  excerpt TEXT,
  why     TEXT,
  sort    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS launch_pack_items_pack ON launch_pack_items(pack_id, sort);

-- Voice notes. The audio lives on disk under the data dir; this is the index.
CREATE TABLE IF NOT EXISTS voice_notes (
  id           TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  duration_ms  INTEGER,
  title        TEXT,
  transcript   TEXT,
  transcript_state TEXT NOT NULL DEFAULT 'none', -- none | client | server | failed
  transcript_error TEXT,
  task_id      TEXT,
  card_group   TEXT,
  pack_id      TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS voice_notes_created ON voice_notes(created_at DESC);
`,
  },
  {
    id: 2,
    name: 'drop-eng-sessions',
    // Engineering sessions were Wake spawning Claude Code ad hoc. "Open in
    // Claude Code" is the same act, productised — one pack, one persisted
    // session id, one resume command — so keeping a second, half-implemented
    // path would mean two answers to "where did that session go".
    sql: `DROP TABLE IF EXISTS eng_sessions;`,
  },
  {
    id: 3,
    name: 'drop-eng-sessions-for-real',
    // Migration 2 dropped the table, and the baseline block above re-created it
    // on the very next boot — so every database that lived through that release
    // still carries an empty, unreferenced eng_sessions while a fresh one does
    // not. The baseline no longer creates it; this converges the two. Safe by
    // inspection: nothing has written to that table since migration 2 ran.
    sql: `DROP TABLE IF EXISTS eng_sessions;`,
  },
  {
    id: 4,
    name: 'remove-the-agent',
    // Wake ran a model in-process, with an Anthropic key of its own. It does
    // not any more — "Open in Claude" hands a packed brief to Claude under the
    // login you already have, which is both simpler and one fewer credential to
    // hold. These tables and columns have no reader left.
    //
    // The conversation history goes with them. That is the intended loss: it is
    // a transcript of a feature that no longer exists, and keeping an
    // unreachable copy of it is how a schema becomes a museum.
    sql: `
DROP TABLE IF EXISTS turn_events;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS agent_tool_calls;
DROP TABLE IF EXISTS turns;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;

DELETE FROM kv WHERE k = 'agent:anthropic_key';

-- A pack left mid-flight by the old launcher has no process behind it now.
UPDATE launch_packs SET status = 'opened' WHERE status NOT IN ('draft', 'opened');
`,
    run() {
      // Guarded, because a database created after this release never had them.
      for (const c of ['turn_id', 'approval_id']) dropColumn('cli_audit', c)
      for (const c of ['turn_id', 'conv_id']) dropColumn('audit_events', c)
      for (const c of ['session_id', 'resumed_from', 'pid', 'error', 'finished_at']) {
        dropColumn('launch_packs', c)
      }
    },
  },
]

const applied = new Set(
  db.query<{ id: number }, []>(`SELECT id FROM schema_migrations`).all().map(r => r.id),
)
for (const m of MIGRATIONS) {
  if (applied.has(m.id)) continue
  // Each migration is one transaction: a half-applied schema is worse than an
  // unapplied one, because the next boot would skip the half it thinks ran.
  db.transaction(() => {
    if (m.sql) db.exec(m.sql)
    m.run?.()
    db.query(`INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)`)
      .run(m.id, m.name, Date.now())
  })()
}

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

/**
 * The security audit log. Separate from `logEvent` on purpose: that one feeds
 * Pulse, this one answers "what did this system do to the outside world".
 */
export function audit(kind: string, fields: {
  actor?: string
  target?: string | null
  detail?: unknown
  ok?: boolean
  error?: string | null
} = {}) {
  db.query(
    `INSERT INTO audit_events (kind, actor, target, detail, ok, error, at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    kind,
    fields.actor ?? 'user',
    fields.target ?? null,
    fields.detail === undefined ? null : JSON.stringify(fields.detail),
    fields.ok === false ? 0 : 1,
    fields.error ?? null,
    Date.now(),
  )
}

export const now = () => Date.now()
export const uid = () => crypto.randomUUID()
