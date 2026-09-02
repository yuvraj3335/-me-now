/**
 * The `slack_channels` table: which channels Wake reads from, how, and why.
 *
 * This replaces `DESK_CHANNELS` / `SLACK_CHANNELS` / `WAKE_SLACK_CHANNELS`, a
 * hand-edited array in `env.ts`. The array broke the ordinary way a config
 * array breaks: the only way to add or drop a channel was to edit a TypeScript
 * file and redeploy, and it was edited twice inside one week — once dropping
 * `#truto`, the team's own channel, entirely, because nobody reviewing that diff
 * was thinking about scope at the time. A table edited from Settings has an
 * undo built in: the previous mode is one PUT away, and nothing requires
 * touching this file to fix a channel Wake should or should not be reading.
 *
 * Three facts per channel, independent of each other:
 *
 *   `mode`   — 'off' (never read), 'mentions' (only `<@me>` hits, via the
 *              search query `channelScope()` builds), or 'all' (the whole
 *              channel is read as history, bot-inclusive, every poll).
 *   `label`  — what kind of channel this is to a human reading Settings:
 *              team | customer | partner | alert | crisp. Cosmetic except for
 *              `alert` and `crisp`, which gate on `family` below.
 *   `family` — 'sentry' | 'datadog' | 'grafana' | 'crisp'. Selects the
 *              body parser and card builder for a channel read as history.
 *              Never client-settable: it is a fact about which bot posts here,
 *              not a preference.
 */
import { db } from './db'
import { bareChannel, type AlertChannel } from './env'

export type SlackChannelMode = 'off' | 'mentions' | 'all'
export type SlackChannelLabel = 'team' | 'customer' | 'partner' | 'alert' | 'crisp'
export type SlackChannelFamily = 'sentry' | 'datadog' | 'grafana' | 'crisp'

export type SlackChannelRow = {
  id: string
  name: string
  is_private: boolean | null
  is_ext_shared: boolean | null
  is_member: boolean | null
  mode: SlackChannelMode
  label: SlackChannelLabel | null
  family: SlackChannelFamily | null
  seeded: boolean
  updated_at: number
  last_listed_at: number | null
}

const MODES: SlackChannelMode[] = ['off', 'mentions', 'all']
const LABELS: SlackChannelLabel[] = ['team', 'customer', 'partner', 'alert', 'crisp']

/** A bad request from a client, as distinct from anything unexpected. */
export class ScopeError extends Error {}

type DbRow = {
  id: string
  name: string
  is_private: number | null
  is_ext_shared: number | null
  is_member: number | null
  mode: string
  label: string | null
  family: string | null
  seeded: number
  updated_at: number
  last_listed_at: number | null
}

const toBool = (v: number | null): boolean | null => (v === null ? null : v !== 0)

function fromDb(r: DbRow): SlackChannelRow {
  return {
    id: r.id,
    name: r.name,
    is_private: toBool(r.is_private),
    is_ext_shared: toBool(r.is_ext_shared),
    is_member: toBool(r.is_member),
    mode: r.mode as SlackChannelMode,
    label: r.label as SlackChannelLabel | null,
    family: r.family as SlackChannelFamily | null,
    seeded: r.seeded !== 0,
    updated_at: r.updated_at,
    last_listed_at: r.last_listed_at,
  }
}

/** Every row, oldest-seeded first — the order the migration inserted them in. */
export function listChannels(): SlackChannelRow[] {
  return db.query<DbRow, []>(`SELECT * FROM slack_channels ORDER BY rowid`).all().map(fromDb)
}

export function getChannel(id: string): SlackChannelRow | null {
  const r = db.query<DbRow, [string]>(`SELECT * FROM slack_channels WHERE id = ?`).get(id)
  return r ? fromDb(r) : null
}

function getChannelByName(name: string): SlackChannelRow | null {
  const bare = bareChannel(name)
  if (!bare) return null
  const r = db.query<DbRow, [string]>(`SELECT * FROM slack_channels WHERE lower(name) = ?`).get(bare)
  return r ? fromDb(r) : null
}

/**
 * The default for a channel not on the table at all: read for mentions only,
 * unlabelled. This is exactly today's behaviour for a channel nobody has ever
 * named, minus the hardcoded allowlist refusal `isAllowedSlackChannel` used to
 * make — a fresh channel is reachable until somebody turns it off, not
 * unreachable until somebody turns it on.
 */
const DEFAULT_SCOPE = { mode: 'mentions' as SlackChannelMode, label: null as SlackChannelLabel | null, family: null as SlackChannelFamily | null }

/**
 * The scope a channel answers to, id first because it is the durable half — a
 * renamed channel keeps its id, and a search hit whose `Channel:` line had no
 * readable name arrives with the id standing in for one.
 */
export function scopeFor(
  id: string | null | undefined,
  name?: string | null,
): { mode: SlackChannelMode; label: SlackChannelLabel | null; family: SlackChannelFamily | null } {
  const row = (id && getChannel(id)) || (name ? getChannelByName(name) : null)
  if (!row) return DEFAULT_SCOPE
  return { mode: row.mode, label: row.label, family: row.family }
}

/**
 * Replaces `isAllowedSlackChannel`. A channel is reachable unless it has been
 * explicitly turned off — the DM refusal in `bucketHits` is the other half of
 * the door and lives beside this call, not inside it, for the same reason it
 * always has: a DM is refused by what it *is*, not by configuration.
 */
export function isChannelReachable(id: string | null | undefined, name?: string | null): boolean {
  return scopeFor(id, name).mode !== 'off'
}

/**
 * The `in:#a in:#b` clause for the mention search — every row whose mode says
 * the operator's mentions there matter, at all or exclusively.
 *
 * A row carrying a `family` (alert and Crisp channels) is left out even when
 * its mode is 'all' or 'mentions': those are read wholesale as history by
 * `family`-specific logic, and search cannot see what they post anyway — a bot
 * row comes back from search with empty text, measured on this workspace. A
 * search term naming one would be a slot spent asking a question already known
 * to answer nothing.
 */
export function channelScope(): string {
  return listChannels()
    .filter(c => (c.mode === 'mentions' || c.mode === 'all') && !c.family)
    .map(c => `in:#${c.name}`)
    .join(' ')
}

/**
 * Every channel read wholesale as history on this poll: `mode = 'all'`
 * (customer and partner channels with no family), plus any row carrying a
 * `family` whose mode is not 'off' (alert and Crisp channels — 'mentions'
 * there narrows what becomes a card, not whether the channel is read at all).
 */
export function historyChannels(): SlackChannelRow[] {
  return listChannels().filter(c => c.mode !== 'off' && (c.mode === 'all' || !!c.family))
}

/**
 * The alert channels, as the typed triple the family parsers take. Derived
 * from the table rather than a literal array, so a channel silenced from
 * Settings stops being read without a code change — `alertCards` is never
 * asked to parse a channel `historyChannels()` did not include.
 */
export function alertChannels(): AlertChannel[] {
  return listChannels()
    .filter((c): c is SlackChannelRow & { family: 'sentry' | 'datadog' | 'grafana' } =>
      c.label === 'alert' && (c.family === 'sentry' || c.family === 'datadog' || c.family === 'grafana'))
    .map(c => ({ id: c.id, name: c.name, family: c.family }))
}

/** The one Crisp row, if any, and whatever mode it is set to. */
export function crispChannel(): SlackChannelRow | null {
  return listChannels().find(c => c.family === 'crisp') ?? null
}

/**
 * Update a channel's `mode` and/or `label` from Settings. `family` is never
 * accepted here — it is discovered, not chosen — and `label` of `alert` or
 * `crisp` is refused on a row with no `family`, because that label is a claim
 * about which bot posts there and an operator cannot make that claim true by
 * typing it into a form.
 */
export function updateChannel(id: string, patch: { mode?: string; label?: string | null }): SlackChannelRow {
  const existing = getChannel(id)
  if (!existing) throw new ScopeError(`no such channel: ${id}`)

  if (patch.mode !== undefined && !MODES.includes(patch.mode as SlackChannelMode)) {
    throw new ScopeError(`invalid mode: ${patch.mode}`)
  }
  if (patch.label !== undefined && patch.label !== null) {
    if (!LABELS.includes(patch.label as SlackChannelLabel)) {
      throw new ScopeError(`invalid label: ${patch.label}`)
    }
    if ((patch.label === 'alert' || patch.label === 'crisp') && !existing.family) {
      throw new ScopeError(`label '${patch.label}' needs a channel family, and this channel has none`)
    }
  }

  const mode = (patch.mode as SlackChannelMode) ?? existing.mode
  const label = patch.label === undefined ? existing.label : (patch.label as SlackChannelLabel | null)
  db.query(`UPDATE slack_channels SET mode = ?, label = ?, updated_at = ? WHERE id = ?`)
    .run(mode, label, Date.now(), id)
  return getChannel(id)!
}

export type ListedChannel = {
  id: string
  name: string
  isPrivate?: boolean | null
  isMember?: boolean | null
  isExtShared?: boolean | null
}

/**
 * Fold a fresh `slack_list_user_channels` page into the table.
 *
 * Refreshes `name` / `is_private` / `is_member` / `is_ext_shared` /
 * `last_listed_at` on a row that already exists — never `mode`, `label` or
 * `family`, which are somebody's decision and a listing carries no opinion
 * about them. A channel the listing has never seen before is inserted at
 * `mode: 'mentions'`, unlabelled — the same default `scopeFor` hands back for
 * a channel with no row at all, so discovering a channel changes nothing about
 * how it is treated until a person decides otherwise.
 */
export function upsertListed(rows: ListedChannel[]): { added: number } {
  const now = Date.now()
  let added = 0
  for (const r of rows) {
    const isPrivate = r.isPrivate === undefined ? null : r.isPrivate
    const isMember = r.isMember === undefined ? null : r.isMember
    const isExtShared = r.isExtShared === undefined ? null : r.isExtShared
    const existing = getChannel(r.id)
    if (existing) {
      db.query(
        `UPDATE slack_channels
            SET name = ?, is_private = ?, is_ext_shared = ?, is_member = ?, last_listed_at = ?
          WHERE id = ?`,
      ).run(r.name, boolToInt(isPrivate), boolToInt(isExtShared), boolToInt(isMember), now, r.id)
    } else {
      db.query(
        `INSERT INTO slack_channels
           (id, name, is_private, is_ext_shared, is_member, mode, label, family, seeded, updated_at, last_listed_at)
         VALUES (?, ?, ?, ?, ?, 'mentions', NULL, NULL, 0, ?, ?)`,
      ).run(r.id, r.name, boolToInt(isPrivate), boolToInt(isExtShared), boolToInt(isMember), now, now)
      added++
    }
  }
  return { added }
}

function boolToInt(v: boolean | null): number | null {
  return v === null ? null : (v ? 1 : 0)
}
