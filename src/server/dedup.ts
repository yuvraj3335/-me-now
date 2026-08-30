/**
 * Dedup: union-find over hard references (DECISIONS.md #4).
 *
 * The rule is deliberately conservative. Two cards merge only when they share a
 * reference that identifies the *same real thing* — a PR number, a thread id, a
 * Message-ID, a normalized subject. Cards that merely look similar are left
 * alone, because wrongly merging hides something real, and one honest card is
 * better than a clever one.
 */
import type { Pile, RawCard, Ref } from './sources/types'

/* ------------------------------- extraction ------------------------------- */

const GH_URL = /github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/(\d+)/gi
/** "trutohq/truto#2034" and bare "#2034" when a repo is already in context. */
const GH_SHORT = /\b([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)\b/g
const SENTRY_URL = /sentry\.io\/(?:organizations\/[^/]+\/)?issues\/(\d+)/gi
/**
 * Sentry short ids are base36, not decimal: `TRUTO-38`, `TRUTO-2D`, `TRUTO-W`,
 * `TRUTO-APP-1BY`. A `TRUTO-\d+` pattern misses most of them outright, and the
 * `-APP` branch has to be tried *first* or `TRUTO-APP-1BY` is captured as
 * `TRUTO-A` — a reference to an issue that does not exist. The `i` flag is gone
 * with it: a lowercase `truto-38` in prose is a word, not an id, and the push
 * site still upper-cases what it finds.
 *
 * The boundary is spelled out rather than `\b`, because `_` is a word character
 * and the Cursor triage bot writes the id italic — `_TRUTO-38_`. Under `\b`
 * there is no boundary on either side of that, so the one id that message is
 * *about* was the one id invisible to the parser, and the first id it did see
 * was whatever other issue the prose happened to cross-reference.
 */
const TRUTO_SENTRY = /(?<![0-9A-Za-z])TRUTO(?:-APP)?-[0-9A-Z]+(?![0-9A-Za-z])/g
const SLACK_ARCHIVE = /slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/gi

/** Strip the noise that makes the same conversation look like many subjects. */
export function normalizeSubject(s: string): string {
  return s
    .replace(/^\s*(?:(?:re|fwd?|fw|aw|sv|vs|antw)\s*(?:\[\d+\])?\s*:\s*)+/gi, '')
    .replace(/^\s*\[[^\]]{1,40}\]\s*/g, '')   // mailing-list / repo prefixes
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * A title is the weakest signal Wake will merge on, so it is fenced in: only
 * distinctive titles qualify. Without the guard, generic fallbacks ("Session in
 * truto") would collapse unrelated work into one card — the exact failure mode
 * that hides something real.
 */
const GENERIC_TITLE = /^(session in |untitled|new session|no subject|\(no subject\))/i

export function subjectRef(title: string): Ref | null {
  const norm = normalizeSubject(title)
  if (norm.length < 24) return null          // too short to be distinctive
  if (GENERIC_TITLE.test(norm)) return null
  if (!/\s/.test(norm)) return null          // a single token is an id, not a subject
  return { t: 'subject', v: norm }
}

/* --------------------------- elided subjects ------------------------------ */

/**
 * A subject that was cut short, and what it was cut from.
 *
 * Wake truncates a session title it derives from a prompt, and keeps the ellipsis
 * so nobody reads a clipped title as the whole one. That honesty costs a merge:
 * a Claude session opened from PR #2034 carries
 * `subject:fix(mfa): … so 2fa cannot be…` while the PR itself carries
 * `subject:fix(mfa): … so 2fa cannot be bypassed`, and two strings that differ
 * by nine characters share no reference at all — so the same work appeared twice
 * in a count whose whole job is to say how much is open.
 */
const ELIDED = /(?:…|\.\.\.)$/

/** The text before the ellipsis, or null when the subject was not cut. */
export function elidedPrefix(v: string): string | null {
  const m = ELIDED.exec(v)
  if (!m) return null
  return v.slice(0, m.index).replace(/[\s,;:–—-]+$/, '')
}

/** What an elided subject would have been, or the subject itself. */
const core = (v: string) => elidedPrefix(v) ?? v

/**
 * How much of a title has to survive truncation before its prefix is allowed to
 * identify anything. Wake's own cut never lands below ~43 characters, so this is
 * a floor against a pathological short title rather than a tuning knob: a shared
 * 32-character opening is a shared subject, not a shared word.
 */
const MIN_ELIDED_PREFIX = 32

/**
 * Pair each elided subject with the full one it is a prefix of.
 *
 * Conservative on purpose, in the same spirit as everything else here: a
 * candidate set that is not *self*-consistent — two different titles that both
 * begin with this prefix — is ambiguous, and an ambiguous merge hides something
 * real. Those are left alone rather than guessed at.
 */
export function elisionPairs(subjects: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const v of subjects) {
    const prefix = elidedPrefix(v)
    if (!prefix || prefix.length < MIN_ELIDED_PREFIX) continue

    const candidates = subjects.filter(o => o !== v && core(o).startsWith(prefix))
    if (!candidates.length) continue

    // All candidates must be the same title at different truncations: sort by
    // how much of it each one kept, and require every shorter one to be an
    // opening of the longest.
    const longest = candidates.reduce((a, b) => (core(b).length > core(a).length ? b : a))
    if (!candidates.every(o => core(longest).startsWith(core(o)))) continue

    out.push([v, longest])
  }
  return out
}

/**
 * Drop the fragment an ellipsis cut in half.
 *
 * Wake truncates a session title it derives from a prompt and keeps the
 * ellipsis, so nobody reads a clipped title as the whole one. The `ELIDED` guard
 * above already stops a cut *subject* from identifying anything — but the same
 * text was also being run through the GitHub regexes, and there the honesty was
 * not applied at all: `github.com/trutohq/truto/pull/2…` matched, yielding
 * `gh:trutohq/truto#2`. That is a reference to a pull request that does not
 * exist, and because `gh` outranks every other reference type it won the group
 * label — merging two unrelated Claude sessions under a fabricated PR, hiding a
 * 22-turn session completely, and making the card claim a `trutohq/truto` PR
 * while its Open button went to `truto-app/pull/1134`.
 *
 * A reference extracted from text Wake elided is not a reference. Only the token
 * the ellipsis is attached to is dropped: the rest of the line was not cut and
 * is still true.
 */
export function withoutElidedTail(text: string): string {
  return text
    .split('\n')
    .map(line => (ELIDED.test(line.trimEnd()) ? line.replace(/(^|\s)\S+\s*$/, '$1') : line))
    .join('\n')
}

/**
 * Pull every hard reference out of arbitrary text (body, title, permalink).
 *
 * Callers that pass text Wake itself truncated must run it through
 * `withoutElidedTail` first — `extractRefsFromElidable` does both.
 */
export function extractRefs(text: string, contextRepo?: string): Ref[] {
  const out: Ref[] = []
  const seen = new Set<string>()
  const push = (r: Ref) => {
    const k = `${r.t}:${r.v}`
    if (!seen.has(k)) { seen.add(k); out.push(r) }
  }

  for (const m of text.matchAll(GH_URL)) push({ t: 'gh', v: `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() })
  for (const m of text.matchAll(GH_SHORT)) push({ t: 'gh', v: `${m[1]}#${m[2]}`.toLowerCase() })
  for (const m of text.matchAll(SENTRY_URL)) if (m[1]) push({ t: 'sentry', v: m[1] })
  for (const m of text.matchAll(TRUTO_SENTRY)) push({ t: 'sentry', v: m[0].toUpperCase() })
  for (const m of text.matchAll(SLACK_ARCHIVE)) push({ t: 'slackthread', v: `${m[1]}:${m[2]}.${m[3]}` })

  if (contextRepo) {
    for (const m of text.matchAll(/(?:^|\s)#(\d{1,6})\b/g)) {
      push({ t: 'gh', v: `${contextRepo}#${m[1]}`.toLowerCase() })
    }
  }
  return out
}

/** `extractRefs` over text that may have been cut short by Wake's own truncation. */
export const extractRefsFromElidable = (text: string, contextRepo?: string): Ref[] =>
  extractRefs(withoutElidedTail(text), contextRepo)

/**
 * Refs from an alert body. Deliberately blind to GitHub: a Cursor triage
 * message links the *fixing PR*, which is a different unit of work. Letting
 * that rank-0 ref in both merges the alert into the PR's card and relabels
 * the group `gh:trutohq/truto#2037`, so the alert stops being findable as
 * TRUTO-38 and inherits the PR's state. The PR still arrives on its own
 * from the GitHub adapter.
 */
export function extractAlertRefs(text: string): Ref[] {
  const out: Ref[] = []
  const seen = new Set<string>()
  const push = (r: Ref) => {
    const k = `${r.t}:${r.v}`
    if (!seen.has(k)) { seen.add(k); out.push(r) }
  }

  for (const m of text.matchAll(SENTRY_URL)) if (m[1]) push({ t: 'sentry', v: m[1] })
  for (const m of text.matchAll(TRUTO_SENTRY)) push({ t: 'sentry', v: m[0].toUpperCase() })
  for (const m of text.matchAll(SLACK_ARCHIVE)) push({ t: 'slackthread', v: `${m[1]}:${m[2]}.${m[3]}` })
  return out
}

/* ------------------------------- union-find ------------------------------- */

class DSU {
  private parent = new Map<string, string>()
  find(x: string): string {
    let p = this.parent.get(x)
    if (p === undefined) { this.parent.set(x, x); return x }
    if (p !== x) { p = this.find(p); this.parent.set(x, p) }
    return p
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/** A card's own identity, before any merging. */
export const cardId = (c: Pick<RawCard, 'source' | 'source_id'>) => `${c.source}:${c.source_id}`

/**
 * Rank decides which reference becomes the visible group key when several cards
 * merge: prefer the most durable, human-meaningful identifier. A PR number
 * survives forever; a normalized subject is the weakest signal, so it is last.
 */
const REF_RANK: Record<Ref['t'], number> = {
  gh: 0, sentry: 1, slackthread: 2, gmailthread: 3, msgid: 4, url: 5, subject: 6,
}

/**
 * Assign a group key to every card. Cards sharing any reference land in the same
 * group; a card with no shared reference is its own group.
 */
export function groupCards(cards: RawCard[]): Map<string, string> {
  const dsu = new DSU()
  const refNode = (r: Ref) => `ref|${r.t}|${r.v}`

  for (const c of cards) {
    const id = `card|${cardId(c)}`
    dsu.find(id)
    for (const r of c.refs) dsu.union(id, refNode(r))
  }

  // A truncated title and the full one it was cut from name the same thing.
  const subjects = [
    ...new Set(cards.flatMap(c => c.refs.filter(r => r.t === 'subject').map(r => r.v))),
  ]
  for (const [from, to] of elisionPairs(subjects)) {
    dsu.union(`ref|subject|${from}`, `ref|subject|${to}`)
  }

  // Choose a stable, meaningful label per component: the best-ranked reference
  // in it, or the card's own id when the component has no references at all.
  const bestByRoot = new Map<string, { rank: number; key: string }>()
  for (const c of cards) {
    const root = dsu.find(`card|${cardId(c)}`)
    for (const r of c.refs) {
      // A subject that was cut short is a worse label than the same subject
      // whole, even though both are `subject` refs — half a title in a group key
      // is a group key nobody can read.
      // The same rule applied to Sentry: one issue carries both a short id and
      // an opaque numeric id, and with equal ranks the tiebreak below is
      // lexicographic — so `sentry:7700748352` beat `sentry:TRUTO-38` and
      // labelled the group with the number nobody can look up. The numeric ref
      // stays: it is what actually merges the Slack alert with the row the
      // Sentry API returns.
      const rank = REF_RANK[r.t]
        + (r.t === 'subject' && elidedPrefix(r.v) ? 0.5 : 0)
        + (r.t === 'sentry' && /^\d+$/.test(r.v) ? 0.5 : 0)
      const cand = { rank, key: `${r.t}:${r.v}` }
      const cur = bestByRoot.get(root)
      if (!cur || cand.rank < cur.rank || (cand.rank === cur.rank && cand.key < cur.key)) {
        bestByRoot.set(root, cand)
      }
    }
  }

  const out = new Map<string, string>()
  for (const c of cards) {
    const id = cardId(c)
    const root = dsu.find(`card|${id}`)
    out.set(id, bestByRoot.get(root)?.key ?? id)
  }
  return out
}

/* --------------------------------- piles ---------------------------------- */

export type MyState = {
  pile_override?: string | null
  snoozed_until?: number | null
  not_mine?: number
  done_at?: number | null
  status?: string | null
}

/**
 * Piles are computed, never filed (DECISIONS.md #9). A manual move always wins;
 * a snooze expires on its own and the card returns to where the rules put it.
 */
export function pile(card: { pile: Pile }, state: MyState | undefined, at = Date.now()): Pile | 'hidden' {
  // Status is the authoritative claim about the work; `done_at` and `not_mine`
  // are the two columns it grew out of and are kept in sync beside it.
  if (state?.status === 'done' || state?.status === 'wont_do') return 'hidden'
  if (state?.not_mine) return 'hidden'
  if (state?.done_at) return 'hidden'
  if (state?.snoozed_until && state.snoozed_until > at) return 'parked'
  if (state?.pile_override === 'now' || state?.pile_override === 'open' || state?.pile_override === 'parked') {
    return state.pile_override
  }
  return card.pile
}
