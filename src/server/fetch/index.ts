/**
 * Fetch — the second pipe.
 *
 * Pipe 1 is Wake's own credentials answering five fixed questions on a
 * three-minute timer. It fills the desk with no click wherever Wake holds a
 * credential of its own, and it is doing that right now for GitHub and for
 * Claude Code. It cannot do it for Slack, because the Slack *app* is not
 * entitled for MCP and every poll 400s with a token that is real and accepted;
 * it cannot do it for Gmail, because Google publishes no OAuth metadata Wake
 * could start a flow against. Two of the three sources that would put something
 * in the Now pile are dark, and the page reports that as the word "Nothing".
 *
 * Fetch is the operator saying *go and find what is on me right now, using
 * whatever this box can reach*. It is one control, one fixed pair of questions,
 * and rows on the same desk. Two properties define it:
 *
 *   1. **It is a collector, not a conversation.** No free-text input exists
 *      anywhere in the flow, no model prose reaches a pixel, there is no
 *      transcript, no streaming, no second turn and no history. Its persistence
 *      is `cards`, `card_state`, one `sync_runs` row per connector asked, and
 *      `audit_events`.
 *   2. **It must work when Wake's own login is missing or refused** — otherwise
 *      it is a refresh button. So each connector takes the best route available:
 *      Wake's own read-only search where Wake holds a working credential, and
 *      the box's own `claude` where it does not. On this deployment that is
 *      Sentry and GitHub through Wake, Slack and Gmail through the box.
 *
 * `why` is never invented. The collector returns *evidence* — the quoted line
 * that makes something an ask — and `whyFrom` below turns evidence into `why`
 * with the same rule table Slack's poller has always used. No evidence means a
 * fixed neutral phrase, not a generated one.
 *
 * References are extracted here too, from the title and the evidence, rather
 * than accepted from the collector: a fabricated `gh:` reference outranks every
 * other reference type and would decide a group's visible key.
 */

import { db, logEvent, now } from './../db'
import { cardId, extractRefs, groupCards } from './../dedup'
import { asRaw, ensureGroupState, ingest, liveCards, migrateState } from './../ingest'
import { FETCH_LOOKBACK_DAYS, FETCH_MAX_ROWS, ME, SLACK_TEAM_ID } from './../env'
import { readsLikeAsk } from './../sources/slack'
import { searchGithub, searchSentry, searchSlack, type SearchHit } from './../sources/search'
import type { Ref, RawCard, SourceName } from './../sources/types'
import { inspect } from './../untrusted'
import { redact } from './../redact'
import { askTheBox, boxCanAsk, type Found } from './claude'
import { reachableConnectors } from './reach'

/** The connectors Fetch will ask, in the order their answers matter. */
const CONNECTORS = ['slack', 'gmail', 'sentry', 'github'] as const
type Connector = (typeof CONNECTORS)[number]

export type ConnectorResult = {
  name: Connector
  /** Which route answered: Wake's own credential, the box's, or neither. */
  via: 'wake' | 'box' | 'none'
  /** Asked and answered, even if the answer was nothing. */
  ok: boolean
  count: number
  ms: number
  error?: string
}

export type FetchReport = {
  at: number
  ms: number
  /** Rows that landed on the desk, deduped against everything already there. */
  found: number
  /** Groups that did not exist before this Fetch. */
  fresh: number
  connectors: ConnectorResult[]
}

let running: Promise<FetchReport> | null = null
let last: FetchReport | null = null

/**
 * One Fetch at a time; a second press joins the first.
 *
 * The same guard `ingest()` has. A second press is never disabled and never
 * scolded — it re-runs, dedups, and answers `0 new`, which is a useful answer.
 */
export function fetchNow(): Promise<FetchReport> {
  if (running) return running
  running = doFetch()
    .then(r => { last = r; return r })
    .finally(() => { running = null })
  return running
}

/**
 * Start one, and answer immediately.
 *
 * A collection through the box takes 40–60 seconds, and holding an HTTP request
 * open for that is a way to lose it: measured, the socket was closed at exactly
 * 60s while the run itself finished fine and landed its rows, so the page
 * reported a failure that had not happened. The browser starts it and then asks
 * what happened, which also means a phone that locks its screen mid-run still
 * sees the result.
 */
export function startFetch(): { running: true } {
  // The report carries the failure; there is nothing for a rejection to reach.
  void fetchNow().catch(() => {})
  return { running: true }
}

/** What the last press did, and whether one is still going. */
export const fetchStatus = (): { running: boolean; report: FetchReport | null } =>
  ({ running: !!running, report: last })

async function doFetch(): Promise<FetchReport> {
  const t0 = Date.now()
  try {
    return await collectAll(t0)
  } catch (e) {
    // A failure is a report, not a rejection: the browser reads the report.
    return {
      at: now(), ms: Date.now() - t0, found: 0, fresh: 0,
      connectors: CONNECTORS.map(name => ({
        name, via: 'none' as const, ok: false, count: 0, ms: 0, error: (e as Error).message,
      })),
    }
  }
}

async function collectAll(t0: number): Promise<FetchReport> {
  // Pipe 1 first, so Fetch is never a worse refresh than the button it replaced.
  await ingest().catch(() => {})

  const reach = reachableConnectors()
  const results = await Promise.all(CONNECTORS.map(c => collect(c, reach)))

  const cards = results.flatMap(r => r.cards)
  const landed = land(cards)

  return {
    at: now(),
    ms: Date.now() - t0,
    found: landed.written,
    fresh: landed.fresh,
    connectors: results.map(r => r.result),
  }
}

/* ------------------------------ collection -------------------------------- */

const since = () => new Date(Date.now() - FETCH_LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10)

/**
 * One connector, one `sync_runs`-shaped record, three distinguishable outcomes.
 *
 * "asked, answered, nothing", "asked, did not answer" and "not asked at all" are
 * three different facts, and pipe 1 conflates the first two in four files. The
 * row is written under `fetch:<connector>` so it cannot be mistaken for a poll —
 * `/api/state` and `/api/connections` both exclude that prefix.
 */
async function collect(name: Connector, reach: Set<string>) {
  const t0 = Date.now()
  const runId = db.query(`INSERT INTO sync_runs (source, started_at) VALUES (?, ?) RETURNING id`)
    .get(`fetch:${name}`, t0) as { id: number } | null

  const finish = (r: Omit<ConnectorResult, 'name' | 'ms'>, cards: RawCard[]) => {
    db.query(`UPDATE sync_runs SET finished_at = ?, ok = ?, connected = ?, count = ?, error = ? WHERE id = ?`)
      .run(Date.now(), r.ok ? 1 : 0, r.via === 'none' ? 0 : 1, r.count, r.error?.slice(0, 500) ?? null, runId?.id ?? 0)
    return { result: { name, ms: Date.now() - t0, ...r } as ConnectorResult, cards }
  }

  // Wake's own read-only search first, where Wake holds a credential that works.
  try {
    const own = await viaWake(name)
    if (own) return finish({ via: 'wake', ok: true, count: own.length }, own)
  } catch (e) {
    // Not fatal, and not silent either: this is the case Fetch exists for, so it
    // falls through to the box rather than reporting a failure Wake can route
    // around. Slack lands here on every run of this deployment.
    void e
  }

  if (!boxCanAsk() || !reach.has(name)) {
    return finish({ via: 'none', ok: false, count: 0, error: 'nothing on this machine can reach it' }, [])
  }

  try {
    const run = await askTheBox(name, promptFor(name))
    const cards = run.rows.map(r => toCard(name, r)).filter((c): c is RawCard => !!c)
    return finish({ via: 'box', ok: true, count: cards.length }, cards)
  } catch (e) {
    return finish({ via: 'box', ok: false, count: 0, error: (e as Error).message }, [])
  }
}

/**
 * Route A: Wake's own adapters, through `sources/search.ts`.
 *
 * Returns `null` when Wake has no route of its own for this connector, which is
 * different from a route that threw — the caller falls through to the box in
 * both cases, but only one of them is worth a line in the report.
 *
 * The questions are deliberately not the poller's. GitHub's poll asks four
 * questions about review requests, assignment, authorship and mentions;
 * `involves:` also catches the threads he has actually commented on, which is
 * most of what "named on" means in practice. Sentry's poll asks about issues
 * assigned to him; `assigned_or_suggested:me` widens that to the issues Sentry
 * itself thinks are his.
 */
async function viaWake(name: Connector): Promise<RawCard[] | null> {
  if (name === 'slack') {
    /*
     * Wake's own Slack credential works again — the app is entitled and the
     * grant now carries Slack MCP's granular search scopes — so the cheap,
     * free, deterministic route is the right one, and the box stays the
     * fallback it exists to be. It still fires for Gmail today, and it fires
     * for Slack again the moment this token stops being accepted.
     *
     * The question is not the poller's. The poll asks `to:me` and `<@me>`;
     * this asks for his *name*, which is how people address someone in a
     * channel without typing a handle — and is the half of "named on" that
     * a mention search never sees.
     */
    const hits = await searchSlack(`"${ME.name}" after:${since()}`, FETCH_MAX_ROWS)
    return hits.map(h => slackCard(h)).filter((c): c is RawCard => !!c)
  }
  if (name === 'github') {
    const hits = await searchGithub(
      ['--owner', ME.githubOrg, '--involves', ME.githubLogin, '--state', 'open', '--updated', `>=${since()}`],
      FETCH_MAX_ROWS,
    )
    return hits.map(h => fromHit('github', h, 'open')).filter((c): c is RawCard => !!c)
  }
  if (name === 'sentry') {
    // No `is:unresolved`: Sentry applies its own status default, and stacking
    // that qualifier on top narrowed a real answer to an empty one.
    const hits = await searchSentry('assigned_or_suggested:me', FETCH_MAX_ROWS)
    return hits.map(h => fromHit('sentry', h, 'open')).filter((c): c is RawCard => !!c)
  }
  // Gmail has an adapter and no credential Wake can obtain — Google publishes
  // no OAuth metadata to start a flow against — so it is the box's, always.
  return null
}

/**
 * A Slack search hit, as a card.
 *
 * Not through `fromHit`: `searchSlack` puts the channel in `title` and the
 * message in `excerpt`, which is the right shape for a search result and the
 * wrong one for a row. A row's title is what was said.
 */
function slackCard(h: SearchHit): RawCard | null {
  const text = redact(h.excerpt ?? '').replace(/\s+/g, ' ').trim()
  if (!h.ref || !text) return null
  // A conversation id beginning `D` is a direct message, and one of those is
  // thrown away before it becomes a card. `searchSlack` already filters them;
  // this is the second gate, because the shape of the id is the durable fact
  // and a title prefix is not.
  if (h.ref.startsWith('D')) return null
  const channel = (h.title ?? '').replace(/^#/, '')
  return {
    source: 'slack',
    source_id: h.ref,
    kind: 'mention',
    title: text.slice(0, 200),
    why: whyFrom(text, 'waiting'),
    who: h.actor || undefined,
    actor: h.actor,
    excerpt: text.slice(0, 400),
    url: h.url ?? `wake:fetch/slack/${encodeURIComponent(h.ref)}`,
    ts: h.ts ?? Date.now(),
    pile: 'now',
    refs: [{ t: 'slackthread', v: h.ref }, ...extractRefs(`${text}\n${h.url ?? ''}`)],
    meta: {
      found_by: 'fetch',
      channel,
      channel_id: h.ref.split(':')[0],
      thread_ts: h.ref.split(':')[1],
      team_id: SLACK_TEAM_ID,
    },
  }
}

/* -------------------------------- prompts --------------------------------- */

/**
 * The two standing questions, asked once per connector.
 *
 * Fixed text. There is no input anywhere in the product that reaches this
 * string, which is the property that keeps Fetch from being a chat box. The
 * shape it asks for is the shape `parseRows` validates, and `why` and `refs` are
 * conspicuously not in it.
 */
function promptFor(name: Connector): string {
  const who = `${ME.name} (${ME.emails.join(', ')}, GitHub ${ME.githubLogin})`
  const what: Record<Connector, string> = {
    slack:
      `Search Slack for two things in the last ${FETCH_LOOKBACK_DAYS} days, in channels only — never direct messages: ` +
      `(a) channel messages that mention ${who} by name or handle; ` +
      `(b) threads in ${ME.org} channels where he is named and someone is waiting on an answer.`,
    gmail:
      `Search Gmail for two things in the last ${FETCH_LOOKBACK_DAYS} days: ` +
      `(a) unread mail addressed directly to ${who} that asks him for something; ` +
      `(b) threads about ${ME.org} where he is named and has not replied.`,
    sentry:
      `Search Sentry for two things: ` +
      `(a) unresolved issues assigned to ${who} or waiting for his review; ` +
      `(b) unresolved issues in ${ME.org} projects that he owns or is named on.`,
    github: '',
  }

  return [
    what[name],
    '',
    'Return ONLY a JSON array. No prose, no explanation, no markdown outside the array.',
    'Each element must be exactly:',
    '{"id":"<the source\'s own identifier>","title":"<what it is, max 120 chars>",' +
    '"evidence":"<one verbatim sentence from the item that shows why it is on him, or null>",' +
    '"who":"<the person waiting, or null>","url":"<a permalink, or null>",' +
    '"when":"<ISO 8601 timestamp>","bucket":"waiting|open"}',
    '',
    'Use bucket "waiting" for (a) and "open" for (b).',
    `Return at most ${FETCH_MAX_ROWS} elements, newest first. If nothing matches, return [].`,
    'Do not summarise, rank, advise or add fields. Quote evidence verbatim; never paraphrase it.',
  ].join('\n')
}

/* ------------------------------ normalising ------------------------------- */

/**
 * Evidence becomes `why`. Nothing else is allowed to.
 *
 * This is the surviving half of DECISIONS #3: "why is this on me" is a rule
 * firing over text somebody actually wrote, not a sentence a model produced. The
 * rule table is `readsLikeAsk`, which the Slack poller has used since the first
 * release, so a Fetch row and a poll row of the same message reach the same
 * words. No evidence means the fixed neutral phrase — never a better guess.
 */
export function whyFrom(evidence: string | null, bucket: 'waiting' | 'open'): string {
  const ask = evidence ? readsLikeAsk(evidence) : null
  if (ask) return ask
  return bucket === 'waiting' ? 'you were named' : 'open where you are named'
}

const KIND: Record<Connector, string> = {
  slack: 'mention', gmail: 'email', sentry: 'error', github: 'mention',
}

/** A collector's object, as a card. Everything untrusted is fenced or dropped. */
function toCard(name: Connector, f: Found): RawCard | null {
  const title = redact(f.title).slice(0, 200)
  if (!title) return null
  // Same rule as the poller and as `slackCard`: a direct message never becomes
  // a card, whichever pipe found it.
  if (name === 'slack' && f.id.startsWith('D')) return null

  const evidence = f.evidence ? redact(f.evidence).slice(0, 400) : null
  const ts = f.when ? Date.parse(f.when) : NaN
  const url = f.url ?? ''

  // Wake extracts its own references, from the text and the link only.
  const refs: Ref[] = [...extractRefs(`${title}\n${evidence ?? ''}\n${url}`)]
  if (name === 'slack' && /^[A-Z0-9]+:\d+\.\d+$/.test(f.id)) refs.push({ t: 'slackthread', v: f.id })
  if (name === 'gmail') refs.push({ t: 'gmailthread', v: `${ME.emails[0]}:${f.id}` })
  if (name === 'sentry') refs.push({ t: 'sentry', v: f.id })
  if (url) refs.push({ t: 'url', v: url })

  const suspicious = inspect(`${title}\n${evidence ?? ''}`)

  return {
    source: name as SourceName,
    source_id: f.id,
    kind: KIND[name],
    title,
    why: whyFrom(evidence, f.bucket),
    who: f.who ? redact(f.who).slice(0, 80) : undefined,
    actor: f.who ? redact(f.who).slice(0, 80) : undefined,
    excerpt: evidence ?? undefined,
    url: url || `wake:fetch/${name}/${encodeURIComponent(f.id)}`,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    pile: f.bucket === 'waiting' ? 'now' : 'open',
    refs,
    meta: {
      found_by: 'fetch',
      ...(name === 'slack' && f.id.includes(':')
        ? { channel_id: f.id.split(':')[0], thread_ts: f.id.split(':')[1], team_id: SLACK_TEAM_ID }
        : {}),
      ...(suspicious.suspicious ? { untrusted: suspicious.reasons.join('; ') } : {}),
    },
  }
}

/** A `search.ts` hit, as a card. Same rules, no model involved. */
function fromHit(name: Connector, h: SearchHit, bucket: 'waiting' | 'open'): RawCard | null {
  const title = redact(h.title ?? '').slice(0, 200)
  if (!title || !h.ref) return null
  const excerpt = h.excerpt ? redact(h.excerpt).slice(0, 400) : null
  const refs: Ref[] = [...extractRefs(`${title}\n${excerpt ?? ''}\n${h.url ?? ''}`)]
  if (name === 'github' && /#\d+$/.test(h.ref)) refs.push({ t: 'gh', v: h.ref.toLowerCase() })
  if (name === 'sentry') refs.push({ t: 'sentry', v: h.ref })
  if (h.url) refs.push({ t: 'url', v: h.url })

  return {
    source: name as SourceName,
    source_id: h.ref,
    kind: name === 'github' ? 'mention' : 'error',
    title,
    why: whyFrom(excerpt, bucket),
    who: h.actor && h.actor !== ME.githubLogin ? h.actor : undefined,
    actor: h.actor,
    excerpt: excerpt ?? undefined,
    url: h.url ?? `wake:fetch/${name}/${encodeURIComponent(h.ref)}`,
    ts: h.ts ?? Date.now(),
    pile: bucket === 'waiting' ? 'now' : 'open',
    refs,
    // The source's own facts, so a Fetch row's detail pane knows the repository
    // and the number rather than being the one row on the desk with no facts.
    meta: { found_by: 'fetch', ...(h.meta ?? {}) },
  }
}

/* -------------------------------- landing --------------------------------- */

/**
 * Fetch's rows join the desk through the same door pipe 1 uses.
 *
 * Grouping runs over everything live, so a Slack message Fetch found about
 * PR #2034 merges with that PR's own card by union-find, with no special case —
 * and the merged group inherits the state, so something already acknowledged
 * cannot resurface as new.
 *
 * `found_by = 'fetch'` is what keeps it there. The poller's sweep marks gone
 * every card of a healthy source it did not return, and it runs every three
 * minutes asking questions Fetch did not ask; scoping that sweep to
 * `found_by = 'poll'` is the difference between Fetch working and Fetch looking
 * like it does nothing.
 */
function land(incoming: RawCard[]): { written: number; fresh: number } {
  if (!incoming.length) return { written: 0, fresh: 0 }
  const at = now()

  const stored = liveCards()
  const survivors: RawCard[] = [...incoming, ...stored.map(asRaw)]
  const groups = groupCards(survivors)

  let written = 0
  let fresh = 0

  const tx = db.transaction(() => {
    for (const c of incoming) {
      const id = cardId(c)
      const gk = groups.get(id) ?? id
      const prev = db.query<{ group_key: string; first_seen_at: number; found_by: string }, [string]>(
        `SELECT group_key, first_seen_at, found_by FROM cards WHERE id = ?`,
      ).get(id)

      /*
       * If pipe 1 owns this row, pipe 1 wins.
       *
       * The two pipes read the same message and normalise it differently — the
       * poller runs Slack's markup through `clean`, and a search hit arrives
       * raw — so an unguarded upsert let Fetch replace a clean title with
       * `<@U09617LRRDF|Yuvraj Muley> can you look`, on rows the poller owns, on
       * the live desk. Beyond the normalisation, pipe 1 has a live credential
       * and a three-minute cadence; Fetch is a manual snapshot. So a collision
       * only refreshes the sighting: the group it belongs to, that it is still
       * there, and when it was last seen.
       */
      if (prev?.found_by === 'poll') {
        db.query(`UPDATE cards SET group_key = ?, last_seen_at = ?, gone = 0 WHERE id = ?`)
          .run(gk, at, id)
        written++
        if (prev.group_key !== gk) migrateState(prev.group_key, gk)
        continue
      }

      db.query(
        `INSERT INTO cards (id, source, source_id, account, group_key, kind, title, why, actor, actor_id,
                            who, excerpt, url, ts, pile, refs, meta, first_seen_at, last_seen_at, gone, found_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'fetch')
         ON CONFLICT(id) DO UPDATE SET
           group_key = excluded.group_key, title = excluded.title, why = excluded.why,
           who = excluded.who, excerpt = excluded.excerpt, url = excluded.url,
           ts = excluded.ts, refs = excluded.refs, meta = excluded.meta,
           last_seen_at = excluded.last_seen_at, gone = 0`,
      ).run(
        id, c.source, c.source_id, c.account ?? null, gk, c.kind, c.title, c.why,
        c.actor ?? null, c.actor_id ?? null, c.who ?? null,
        c.excerpt ?? null, c.url, c.ts, c.pile,
        JSON.stringify(c.refs), JSON.stringify(c.meta ?? {}),
        prev?.first_seen_at ?? at, at,
      )
      written++
      if (prev && prev.group_key !== gk) migrateState(prev.group_key, gk)
    }

    // A Fetch row can merge two groups that were separate a second ago. The
    // stored cards have to follow, or the desk shows the merge on one row and
    // not on the other.
    for (const row of stored) {
      const gk = groups.get(cardId(row))
      if (!gk || gk === row.group_key) continue
      db.query(`UPDATE cards SET group_key = ? WHERE id = ?`).run(gk, cardId(row))
      migrateState(row.group_key, gk)
    }

    const seen = ensureGroupState(at)
    fresh = seen.fresh
  })

  tx()
  logEvent('fetch_ran', { at, meta: { written, fresh } })
  return { written, fresh }
}
