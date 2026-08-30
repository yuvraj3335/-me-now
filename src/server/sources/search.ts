/**
 * On-demand search across the same sources the poll loop reads.
 *
 * The card pipeline pulls a fixed set of queries on a timer. An investigation
 * needs the opposite: one specific question, right now ("what did Acme say
 * about Salesforce last Tuesday"). These functions reuse the poll path's
 * sessions and tool discovery rather than opening a second connection, so
 * whatever is authenticated for cards is authenticated here.
 *
 * All of it is read-only. Nothing in this file can post, reply or modify.
 */

import { runSearch, discoverTools, readThread } from './slack'
import { sessionFor as gmailSession } from './gmail'
import { getSession as sentrySession, findIssuesTool } from './sentry'
import { GMAIL_ACCOUNTS } from '../env'
import { extractText } from '../mcp/client'

export type SearchHit = {
  source: string
  title: string
  actor?: string
  excerpt?: string
  url?: string
  ts?: number
  ref?: string
}

export async function searchSlack(query: string, limit = 15): Promise<SearchHit[]> {
  const t = await discoverTools()
  if (!t.search) throw new Error('Slack is connected but exposes no search tool')
  const hits = await runSearch(t.search, query, limit)
  return hits.map(h => ({
    source: 'slack',
    title: h.isDm ? `DM ${h.channelName || h.channelId}` : `#${h.channelName || h.channelId}`,
    actor: h.fromName || h.fromId,
    excerpt: h.text,
    url: h.permalink,
    ts: h.epochMs,
    // `channel:ts` is the same reference the dedup engine keys threads on, so a
    // hit here can be handed straight to slack_thread.
    ref: h.channelId && h.ts ? `${h.channelId}:${h.ts}` : undefined,
  }))
}

/** Read one Slack thread in full — the follow-up to a search hit. */
export async function slackThread(channelId: string, ts: string) {
  return readThread(channelId, ts)
}

export async function searchGmail(query: string, limit = 15): Promise<SearchHit[]> {
  const out: SearchHit[] = []
  for (const account of GMAIL_ACCOUNTS) {
    try {
      const r = await gmailSession(account).callJson<any>('search_threads', { query, maxResults: limit })
      const threads = Array.isArray(r) ? r : (r?.threads ?? r?.results ?? r?.items ?? [])
      for (const t of threads) {
        const m = t.messages?.[0] ?? {}
        out.push({
          source: 'gmail',
          title: t.subject ?? m.subject ?? '(no subject)',
          actor: m.sender ?? m.from ?? t.sender,
          excerpt: t.snippet ?? m.snippet,
          ts: Date.parse(m.date ?? t.date ?? '') || undefined,
          ref: t.threadId ?? t.id,
          url: t.threadId ? `https://mail.google.com/mail/u/0/#all/${t.threadId}` : undefined,
        })
      }
    } catch (e) {
      // One unauthenticated inbox must not blank out the other's results.
      out.push({ source: 'gmail', title: `[${account} unavailable: ${(e as Error).message}]` })
    }
  }
  return out.slice(0, limit)
}

export async function searchSentry(query: string, limit = 15): Promise<SearchHit[]> {
  const tool = await findIssuesTool()
  if (!tool) throw new Error('Sentry is connected but exposes no issue search tool')
  const r = await sentrySession().callJson<any>(tool, { query, limit })
  const rows = Array.isArray(r) ? r : (r?.issues ?? r?.results ?? [])
  if (!rows.length && typeof r === 'string') {
    return [{ source: 'sentry', excerpt: extractText(r).slice(0, 2_000), title: 'Sentry result' }]
  }
  return rows.slice(0, limit).map((i: any) => ({
    source: 'sentry',
    title: i.title ?? i.culprit ?? i.shortId ?? 'issue',
    excerpt: i.metadata?.value ?? i.culprit,
    url: i.permalink ?? i.web_url,
    ts: Date.parse(i.lastSeen ?? i.last_seen ?? '') || undefined,
    ref: i.shortId ?? i.id,
  }))
}

/**
 * GitHub via the `gh` CLI, which already holds a token on this machine. Args
 * are an array — a query string with a semicolon in it is a query string.
 */
export async function searchGithub(query: string, limit = 15): Promise<SearchHit[]> {
  const run = async (args: string[]) => {
    const p = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    if ((await p.exited) !== 0) throw new Error(err.slice(0, 300) || 'gh failed')
    return out
  }

  const fields = 'title,url,number,repository,updatedAt,author,state'
  const [prs, issues] = await Promise.allSettled([
    run(['search', 'prs', query, '--limit', String(limit), '--json', fields]),
    run(['search', 'issues', query, '--limit', String(limit), '--json', fields]),
  ])

  const parse = (r: PromiseSettledResult<string>, kind: string): SearchHit[] => {
    if (r.status !== 'fulfilled') return []
    try {
      return (JSON.parse(r.value) as any[]).map(x => ({
        source: 'github',
        title: `${kind} ${x.repository?.nameWithOwner ?? ''}#${x.number}: ${x.title}`,
        actor: x.author?.login,
        url: x.url,
        ts: Date.parse(x.updatedAt) || undefined,
        ref: `${x.repository?.nameWithOwner}#${x.number}`,
        excerpt: x.state,
      }))
    } catch {
      return []
    }
  }

  return [...parse(prs, 'PR'), ...parse(issues, 'issue')].slice(0, limit)
}
