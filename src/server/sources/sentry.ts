/**
 * Sentry over its official MCP server. Written adaptively — the tool names are
 * discovered rather than hard-coded — because unlike Slack and Gmail I could not
 * inspect this server's schema before it was authorised.
 */
import { McpSession, HttpTransport, McpUnauthorized } from '../mcp/client'
import { tokenGetter, resolveToken } from '../mcp/creds'
import { MCP_SERVERS, LOOKBACK_DAYS } from '../env'
import { extractRefs } from '../dedup'
import type { RawCard, Ref, SourceAdapter } from './types'

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
  toolCache = { at: Date.now(), find }
  return find
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
  if (Array.isArray(payload)) return payload
  return payload.issues ?? payload.results ?? payload.data ?? []
}

const projectSlug = (p: SentryIssue['project']) => (typeof p === 'string' ? p : p?.slug) ?? ''

export const sentry: SourceAdapter = {
  name: 'sentry',
  label: 'Sentry',

  async status() {
    const { token, via } = await resolveToken('sentry')
    if (!token) {
      // Sentry supports dynamic client registration, so Connect really is all
      // it takes — worth saying, because the other two are not like that.
      return { ok: false, detail: 'Unresolved issues assigned to you, and issues waiting for review. Connect needs no setup.' }
    }
    try {
      const find = await findIssuesTool()
      return find
        ? { ok: true, detail: `connected (${find})`, via }
        : { ok: false, detail: 'connected, but no issue-search tool found', via }
    } catch (e) {
      if (e instanceof McpUnauthorized) return { ok: false, detail: 'token rejected — reconnect', via }
      return { ok: false, detail: (e as Error).message, via }
    }
  },

  async fetch() {
    const { token } = await resolveToken('sentry')
    if (!token) return []
    const tool = await findIssuesTool()
    if (!tool) return []

    // Unresolved and assigned to me — errors nobody owns are not "on me".
    const queries = [
      { q: 'is:unresolved assigned:me', why: 'assigned to you in Sentry', pile: 'now' as const },
      { q: 'is:unresolved is:for_review', why: 'waiting for review in Sentry', pile: 'open' as const },
    ]

    const cards: RawCard[] = []
    const seen = new Set<string>()

    for (const g of queries) {
      let payload: any
      try {
        payload = await getSession().callJson(tool, {
          query: g.q,
          naturalLanguageQuery: g.q,
          statsPeriod: `${Math.min(LOOKBACK_DAYS, 14)}d`,
          limit: 25,
        })
      } catch { continue }

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
    return cards
  },
}
