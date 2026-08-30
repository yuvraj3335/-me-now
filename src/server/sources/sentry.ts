/**
 * Sentry over its official MCP server. Written adaptively — the tool names are
 * discovered rather than hard-coded — because unlike Slack and Gmail I could not
 * inspect this server's schema before it was authorised.
 */
import { McpSession, HttpTransport, McpUnauthorized } from '../mcp/client'
import { tokenGetter, resolveToken } from '../mcp/creds'
import { MCP_SERVERS, LOOKBACK_DAYS, SENTRY_ORG } from '../env'
import { extractRefs } from '../dedup'
import { NotConnected, settle, type RawCard, type Ref, type SourceAdapter } from './types'

let session: McpSession | null = null
export const getSession = () =>
  (session ??= new McpSession('sentry', new HttpTransport(MCP_SERVERS.sentry!.url, tokenGetter('sentry'))))

let toolCache: { at: number; find?: string } | null = null

export async function findIssuesTool(): Promise<string | undefined> {
  if (toolCache && Date.now() - toolCache.at < 30 * 60_000) return toolCache.find
  const all = await getSession().listTools()
  const find =
    all.find(t => /^(find|search|list)_issues$/i.test(t.name))?.name ??
    all.find(t => /issue/i.test(t.name) && /(find|search|list)/i.test(t.name))?.name
  // Only a hit is worth remembering. Caching the miss meant a token that gained
  // the scope five minutes ago still looked toolless for the next half hour.
  if (find) toolCache = { at: Date.now(), find }
  return find
}

/**
 * The organisation to search in, discovered rather than configured.
 *
 * `search_issues` declares `organizationSlug` as required, and Wake was not
 * sending it — so every Sentry poll answered
 * `Invalid arguments … organizationSlug: Invalid input`, both queries were
 * swallowed by a bare `catch { continue }`, and the run was recorded as a
 * healthy, up-to-the-second sync of zero issues. Sentry has reported `ok: true,
 * count: 0` for its entire life on this deployment while returning nothing at
 * all, and there was no way to tell the two apart from inside the product.
 */
let orgCache: { at: number; slug?: string } | null = null

export async function orgSlug(): Promise<string | undefined> {
  // Configured beats discovered: the answer is one word that has not changed in
  // the product's lifetime, and asking for it costs a round trip that can fail
  // on its own and take the whole poll down with it.
  if (SENTRY_ORG) return SENTRY_ORG
  if (orgCache?.slug && Date.now() - orgCache.at < 30 * 60_000) return orgCache.slug
  const r = await getSession().callJson<any>('find_organizations', {})
  const first = Array.isArray(r?.organizations) ? r.organizations[0] : null
  const slug = typeof first?.slug === 'string' ? first.slug : undefined
  if (slug) orgCache = { at: Date.now(), slug }
  return slug
}

/**
 * Sentry's search tool answers with Markdown, not JSON.
 *
 * Same shape of surprise as Slack's, and the same answer: a real parser written
 * against the real response. `issuesFrom` handled arrays and three JSON envelope
 * shapes and returned `[]` for a string, so even once the organisation slug was
 * supplied not one issue would have landed.
 */
export function parseSentryIssues(md: string): SentryIssue[] {
  const out: SentryIssue[] = []
  for (const block of md.split(/^##\s+\d+\.\s+/m).slice(1)) {
    // `[TRUTO-APP-1BY](url)`. Short ids are base36 — `TRUTO-38`, `TRUTO-2D`,
    // `TRUTO-W` — so the capture stays permissive rather than spelling out a
    // shape; narrowing it can only ever drop an issue Sentry did return.
    const head = /^\[([^\]]+)\]\(([^)]+)\)/.exec(block)
    if (!head) continue
    const shortId = head[1]!
    const permalink = head[2]!

    // The title is the bold line between the heading and the first fact bullet.
    const body = block.slice(head[0].length)
    const beforeFacts = body.split(/^-\s+\*\*/m)[0] ?? ''
    const title = /\*\*([\s\S]+?)\*\*/.exec(beforeFacts)?.[1]?.replace(/\s+/g, ' ').trim()

    const field = (name: string) =>
      new RegExp(`\\*\\*${name}\\*\\*:\\s*\`?([^\`\\n]+)\`?`, 'i').exec(body)?.[1]?.trim()

    out.push({
      id: shortId,
      shortId,
      title: title || shortId,
      culprit: field('Culprit'),
      permalink,
      count: Number(field('Events')) || 0,
      userCount: Number(field('Users')) || 0,
      status: field('Status'),
      lastSeen: relativeToIso(field('Last seen')),
      // The short id's prefix is the project's own code. It is the only project
      // identity in this response, and it is the one Sentry's own UI shows.
      project: shortId.split('-')[0]?.toLowerCase(),
    })
  }
  return out
}

/** `4 minutes ago` → an ISO instant. Sentry states ages, not timestamps. */
const UNIT_MS: Record<string, number> = {
  second: 1000, minute: 60_000, hour: 3.6e6, day: 864e5, week: 6.048e8, month: 2.592e9, year: 3.156e10,
}
export function relativeToIso(v: string | undefined): string | undefined {
  if (!v) return undefined
  const m = /^(?:about\s+)?(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i.exec(v.trim())
  if (!m) return undefined
  const ms = UNIT_MS[m[2]!.toLowerCase()]
  if (!ms) return undefined
  return new Date(Date.now() - Number(m[1]) * ms).toISOString()
}

type SentryIssue = {
  id?: string
  shortId?: string
  short_id?: string
  title?: string
  culprit?: string
  permalink?: string
  count?: number | string
  userCount?: number
  level?: string
  lastSeen?: string
  last_seen?: string
  project?: string | { slug?: string }
  assignedTo?: unknown
  status?: string
}

function issuesFrom(payload: any): SentryIssue[] {
  if (!payload) return []
  if (typeof payload === 'string') return parseSentryIssues(payload)
  if (Array.isArray(payload)) return payload
  const rows = payload.issues ?? payload.results ?? payload.data
  if (Array.isArray(rows)) return rows
  if (typeof payload.results === 'string') return parseSentryIssues(payload.results)
  return []
}

const projectSlug = (p: SentryIssue['project']) => (typeof p === 'string' ? p : p?.slug) ?? ''

export const sentry: SourceAdapter = {
  name: 'sentry',
  label: 'Sentry',

  async status() {
    const { token, via } = await resolveToken('sentry')
    if (!token) {
      // Sentry supports dynamic client registration, so Connect really is one
      // click. A row states what is true; the button says what to do about it.
      return { ok: false, detail: 'not connected' }
    }
    try {
      const find = await findIssuesTool()
      if (!find) return { ok: false, detail: 'connected, but no issue-search tool found', via }
      const org = await orgSlug()
      return { ok: true, detail: org ? `connected to ${org}` : 'connected', via }
    } catch (e) {
      if (e instanceof McpUnauthorized) return { ok: false, detail: 'token rejected — reconnect', via }
      return { ok: false, detail: (e as Error).message, via }
    }
  },

  async fetch() {
    const { token } = await resolveToken('sentry')
    if (!token) throw new NotConnected('sentry')
    const tool = await findIssuesTool()
    if (!tool) throw new Error('the Sentry server exposes no issue-search tool')
    const org = await orgSlug()
    if (!org) throw new Error('Sentry named no organisation for this token')

    /*
     * Three questions, none of them `is:unresolved`.
     *
     * That qualifier was the reason this source returned nothing. Sentry's
     * search applies its own default status filter, and stacking `is:unresolved`
     * on top of `assigned:me` narrowed a real answer to an empty one — the
     * issues firing in #sentry-alerts right now were never in it. What is left
     * is three claims about ownership: assigned to me, suggested as mine, and
     * queued for review. Errors nobody owns are still not "on me".
     */
    const queries = [
      { q: 'assigned:me', why: 'assigned to you in Sentry', pile: 'now' as const },
      { q: 'assigned_or_suggested:me', why: 'Sentry suggests you own this', pile: 'now' as const },
      { q: 'is:for_review', why: 'waiting for review in Sentry', pile: 'open' as const },
    ]

    const cards: RawCard[] = []
    const seen = new Set<string>()
    // A thrown query and an empty query used to be the same observable outcome:
    // `try { … } catch { continue }` meant a Sentry that failed both searches
    // reported a green, up-to-the-second sync of zero issues, and there was no
    // way to tell from the product whether that meant "nothing for you" or
    // "failed silently, twice". Now the failures are carried out.
    const settled: Array<PromiseSettledResult<unknown>> = []

    for (const g of queries) {
      let payload: any
      try {
        payload = await getSession().callJson(tool, {
          organizationSlug: org,
          query: g.q,
          naturalLanguageQuery: g.q,
          statsPeriod: `${Math.min(LOOKBACK_DAYS, 14)}d`,
          limit: 25,
        })
        settled.push({ status: 'fulfilled', value: payload })
      } catch (e) {
        settled.push({ status: 'rejected', reason: e })
        continue
      }

      for (const it of issuesFrom(payload)) {
        const short = it.shortId ?? it.short_id ?? it.id
        if (!short || seen.has(short)) continue
        seen.add(short)

        const url = it.permalink ?? `https://sentry.io/issues/${it.id ?? short}/`
        const refs: Ref[] = [{ t: 'sentry', v: String(short) }, ...extractRefs(`${it.title ?? ''} ${url}`)]

        cards.push({
          source: 'sentry',
          source_id: String(short),
          kind: 'error',
          title: it.title ?? String(short),
          why: g.why,
          // A project slug, not a person — kept because it is the honest label
          // for "where this came from", and deliberately not promoted to `who`.
          // Nobody is waiting on a Sentry issue; it is waiting on him.
          actor: projectSlug(it.project) || undefined,
          excerpt: it.culprit ?? undefined,
          url,
          ts: Date.parse(it.lastSeen ?? it.last_seen ?? '') || Date.now(),
          pile: g.pile,
          refs,
          meta: {
            short_id: short,
            level: it.level,
            events: Number(it.count ?? 0) || 0,
            users: it.userCount ?? 0,
            project: projectSlug(it.project),
          },
        })
      }
    }
    return settle('sentry', settled, cards)
  },
}
