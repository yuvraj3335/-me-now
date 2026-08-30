/**
 * GitHub via the token `gh` already holds on the box — no extra auth, which is
 * why this source has real data from the first boot.
 */
import { ME, LOOKBACK_DAYS } from '../env'
import { extractRefs, subjectRef } from '../dedup'
import { NotConnected, settle, type RawCard, type SourceAdapter } from './types'

/** Cut on a word boundary, and say so — never silently mid-word. */
function clip(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:–—-]+$/, '') + '…'
}

/**
 * The `gh` binary, resolvable from the environment for the same reason
 * `wake.service` pins an absolute path to bun: a systemd unit's PATH is not a
 * login shell's, and "gh is not logged in on this machine" is what a missing
 * binary looked like from the outside.
 */
const GH_BIN = process.env.WAKE_GH_BIN?.trim() || 'gh'
const TOKEN_TTL_MS = 10 * 60_000
/**
 * How long a *miss* is remembered.
 *
 * A miss used to be cached for the same ten minutes as a hit, so one transient
 * `gh` hiccup — a slow keyring, a laptop that had just woken — pinned "GitHub is
 * not connected" for the next ten minutes and three polls. This is the disconnect
 * being reported. Fifteen seconds is enough to keep a burst of callers from each
 * spawning a process, and short enough that the next poll re-asks.
 */
const MISS_TTL_MS = 15_000
/** `gh` has no `AbortSignal`; without this it can hang the GitHub poll for ever. */
const GH_SPAWN_TIMEOUT_MS = 5_000

let cachedToken: { value: string | null; at: number } | null = null

/**
 * Forget the cached token. Called when GitHub itself says the token is no good,
 * which is a fact the TTL cannot know and the only one worth re-asking `gh` for
 * immediately.
 */
export function revalidate() {
  cachedToken = null
}

async function ghToken(): Promise<string | null> {
  const ttl = cachedToken?.value ? TOKEN_TTL_MS : MISS_TTL_MS
  if (cachedToken && Date.now() - cachedToken.at < ttl) return cachedToken.value

  let value: string | null = process.env.GITHUB_TOKEN?.trim() || null
  if (!value) {
    try {
      const p = Bun.spawn([GH_BIN, 'auth', 'token'], { stdout: 'pipe', stderr: 'ignore' })
      const timer = setTimeout(() => p.kill(), GH_SPAWN_TIMEOUT_MS)
      try {
        const out = (await new Response(p.stdout).text()).trim()
        if ((await p.exited) === 0 && out) value = out
      } finally {
        clearTimeout(timer)
      }
    } catch { /* gh not installed — reported by status() */ }
  }
  cachedToken = { value, at: Date.now() }
  return value
}

/**
 * GitHub says this token is not a token.
 *
 * Distinct from every other failure on purpose. A rate limit is transient and
 * belongs on the `PartialPoll` path, where the cards that did land are kept; a
 * rejected credential is a fact he can act on, and it has to reach Settings as
 * "not connected" rather than as a search error nobody can read.
 */
export class GithubUnauthorized extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubUnauthorized'
  }
}

type SearchItem = {
  id: number
  number: number
  title: string
  html_url: string
  updated_at: string
  created_at: string
  state: string
  draft?: boolean
  pull_request?: unknown
  user?: { login?: string; avatar_url?: string }
  repository_url?: string
  body?: string
  comments?: number
}

async function search(q: string, token: string): Promise<SearchItem[]> {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=40`
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'wake',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200)
    // A 403 is usually the rate limiter — transient, and the cards that landed
    // are still good. The same status also carries "Bad credentials", and that
    // one is the grant, not the budget.
    if (r.status === 401 || (r.status === 403 && /bad credential|requires authentication/i.test(body))) {
      throw new GithubUnauthorized(`GitHub rejected the token (${r.status}): ${body}`)
    }
    throw new Error(`github search ${r.status}: ${body}`)
  }
  return ((await r.json()) as { items?: SearchItem[] }).items ?? []
}

const repoOf = (it: SearchItem) =>
  it.repository_url?.replace('https://api.github.com/repos/', '') ??
  it.html_url.split('/').slice(3, 5).join('/')

export const github: SourceAdapter = {
  name: 'github',
  label: 'GitHub',

  async status() {
    const t = await ghToken()
    if (!t) return { ok: false, detail: 'gh is not logged in on this machine (run: gh auth login)' }
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${t}`, 'User-Agent': 'wake' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!r.ok) return { ok: false, detail: `token rejected (${r.status})` }
      const u = (await r.json()) as { login?: string }
      return { ok: true, detail: `signed in as ${u.login}`, via: process.env.GITHUB_TOKEN ? 'env' : 'gh cli' }
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  },

  async fetch() {
    const token = await ghToken()
    if (!token) throw new NotConnected('github')
    const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10)
    const me = ME.githubLogin

    // Four questions, each mapping to a different "why this is on me".
    const queries: Array<{ q: string; kind: string; why: string; pile: RawCard['pile'] }> = [
      { q: `is:open is:pr review-requested:${me} updated:>=${since}`, kind: 'review', why: 'your review is requested', pile: 'now' },
      { q: `is:open assignee:${me} updated:>=${since}`, kind: 'assigned', why: 'assigned to you', pile: 'now' },
      { q: `is:open is:pr author:${me} updated:>=${since}`, kind: 'my_pr', why: 'your open pull request', pile: 'open' },
      { q: `is:open mentions:${me} updated:>=${since}`, kind: 'mention', why: 'you were mentioned', pile: 'now' },
    ]

    const results = await Promise.allSettled(queries.map(g => search(g.q, token)))
    const cards: RawCard[] = []
    const seen = new Set<string>()

    results.forEach((res, i) => {
      if (res.status !== 'fulfilled') return
      const g = queries[i]!
      for (const it of res.value) {
        // A PR can match several queries; keep the first (highest-priority) one.
        if (seen.has(String(it.id))) continue
        seen.add(String(it.id))

        const repo = repoOf(it)
        const isPr = !!it.pull_request
        const num = `${repo}#${it.number}`.toLowerCase()
        const subject = subjectRef(it.title)

        cards.push({
          source: 'github',
          source_id: String(it.id),
          kind: g.kind,
          title: it.title,
          why: g.why,
          actor: it.user?.login,
          actor_id: it.user?.login,
          // `is:pr author:me` returns rows whose author is the operator. Naming
          // him as the person waiting on him is worse than naming nobody.
          who: it.user?.login && it.user.login !== me ? it.user.login : undefined,
          // Cut on a word boundary and say so, rather than stopping mid-word —
          // the card sheet has no "read more", so a silent clip reads as the
          // whole description.
          excerpt: clip(it.body, 400) || undefined,
          url: it.html_url,
          ts: Date.parse(it.updated_at) || Date.now(),
          pile: g.pile,
          // The PR/issue reference is what lets a Slack thread or a notification
          // email about this same PR collapse into one card.
          refs: [
            { t: 'gh', v: num },
            // The title too: a Claude session opened for this PR copies the PR
            // title, and that is what collapses the two into one card.
            ...(subject ? [subject] : []),
            ...extractRefs(`${it.title}\n${it.body ?? ''}`, repo),
          ],
          meta: {
            repo,
            number: it.number,
            is_pr: isPr,
            draft: it.draft ?? false,
            comments: it.comments ?? 0,
            avatar: it.user?.avatar_url,
          },
        })
      }
    })
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    const refused = rejected.filter(r => r.reason instanceof GithubUnauthorized)
    // GitHub itself has said the token is no good, which the ten-minute TTL
    // cannot know. Drop it now so the next poll re-asks `gh` rather than
    // presenting the same rejected credential four more times.
    if (refused.length) revalidate()
    // And when that was every question, this is not a failed poll: it is an
    // unconnected source. Saying so is what makes `ingest.ts` record
    // `connected = 0` and Settings offer Reconnect, instead of `status()` and
    // the sync row disagreeing about the same token in the same second.
    if (refused.length === results.length) throw new NotConnected('github')
    // Four `search/issues` calls, every one of them rate-limitable. Dropping the
    // rejections recorded `ok, 0 rows`, and the sweep then marked every stored
    // GitHub card gone: a swallowed 403 wiped the desk and reported "synced".
    return settle('github', results, cards)
  },
}
