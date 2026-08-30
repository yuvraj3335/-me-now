/**
 * Slack over the official MCP server (https://mcp.slack.com/mcp).
 *
 * Two things here are not guesses and matter a lot:
 *   1. The search tool answers with *Markdown*, not JSON, so this file contains
 *      a real parser for that shape rather than a JSON.parse and a prayer.
 *   2. The signed-in user id is published in the tool's own description
 *      ("Current logged in user's user_id is U…"), so Wake discovers who you are
 *      from the server instead of needing it configured.
 */
import { McpSession, HttpTransport, McpUnauthorized } from '../mcp/client'
import { tokenGetter, resolveToken } from '../mcp/creds'
import { MCP_SERVERS, ME, LOOKBACK_DAYS } from '../env'
import { extractRefs } from '../dedup'
import { NotConnected, type RawCard, type Ref, type SourceAdapter } from './types'

let session: McpSession | null = null
const getSession = () =>
  (session ??= new McpSession('slack', new HttpTransport(MCP_SERVERS.slack!.url, tokenGetter('slack'))))

/* --------------------------- tool discovery --------------------------- */

type Tools = { search?: string; readThread?: string; myUserId?: string }
let toolCache: { at: number; tools: Tools } | null = null

export async function discoverTools(): Promise<Tools> {
  if (toolCache && Date.now() - toolCache.at < 30 * 60_000) return toolCache.tools
  const all = await getSession().listTools()
  const byName = (re: RegExp) => all.find(t => re.test(t.name))?.name

  const search =
    byName(/search.*(public.*private|messages)/i) ??
    byName(/^slack_search(_public)?$/i) ??
    byName(/search/i)

  // The server tells us who we are in prose; that beats hard-coding an id.
  const desc = all.map(t => t.description ?? '').join('\n')
  const myUserId = ME.slackUserId || desc.match(/user_id is (U[A-Z0-9]+)/i)?.[1]

  const tools: Tools = { search, readThread: byName(/read_thread|thread_replies/i), myUserId }
  toolCache = { at: Date.now(), tools }
  return tools
}

/* ------------------------------ parsing ------------------------------- */

export type SlackHit = {
  channelId: string
  channelName: string
  isDm: boolean
  fromName: string
  fromId: string
  ts: string
  epochMs: number
  permalink: string
  text: string
}

/**
 * Parse the Markdown block the Slack MCP returns. Written against the real
 * response; every field is optional-safe because a missing one must degrade to a
 * usable card rather than throw away the whole poll.
 */
/**
 * A Slack ts is "<epoch seconds>.<6 digits>", where the fraction is a sequence
 * number rather than real sub-second time. Parsing it as a float introduces a
 * rounding error, so take the first three digits as milliseconds directly.
 */
export function slackTsToMs(ts: string): number {
  if (!ts) return Date.now()
  const [secs, frac = ''] = ts.split('.')
  const ms = Number(frac.slice(0, 3).padEnd(3, '0'))
  return Number(secs) * 1000 + (Number.isFinite(ms) ? ms : 0)
}

export function parseSlackResults(md: string): SlackHit[] {
  const out: SlackHit[] = []
  for (const block of md.split(/^###\s+Result\s+\d+\s+of\s+\d+\s*$/m).slice(1)) {
    const field = (re: RegExp) => block.match(re)?.[1]?.trim()

    const channelRaw = field(/^Channel:\s*(.+)$/m) ?? ''
    const channelId = channelRaw.match(/\(ID:\s*([A-Z0-9]+)\)/)?.[1] ?? ''
    const channelName = channelRaw.replace(/\s*\(ID:.*?\)\s*/, '').trim()

    const fromRaw = field(/^From:\s*(.+)$/m) ?? ''
    const fromId = fromRaw.match(/\(ID:\s*([A-Z0-9]+)\)/)?.[1] ?? ''
    const fromName = fromRaw.replace(/\s*<[^>]*>\s*/, ' ').replace(/\s*\(ID:.*?\)\s*/, '').trim()

    const ts = field(/^Message_ts:\s*([\d.]+)$/m) ?? ''
    const permalink = block.match(/^Permalink:.*?\((https?:\/\/[^)]+)\)/m)?.[1] ?? ''

    // Text runs to the end of the block or to the --- separator. Done by index
    // rather than by regex: with the /m flag a `$` terminator matches the end of
    // the first *line*, which silently truncates every multi-line message.
    let text = ''
    const tIdx = block.search(/^Text:[ \t]*$/m)
    if (tIdx !== -1) {
      const after = block.slice(block.indexOf('\n', tIdx) + 1)
      const sep = after.search(/^---\s*$/m)
      text = (sep === -1 ? after : after.slice(0, sep)).trim()
    } else {
      text = (block.match(/^Text:[ \t]*(.*)$/m)?.[1] ?? '').trim()
    }

    if (!ts && !permalink) continue
    out.push({
      channelId,
      channelName: channelName || (channelId.startsWith('D') ? 'DM' : channelId),
      isDm: /^DM\b/i.test(channelRaw) || channelId.startsWith('D'),
      fromName: fromName || 'someone',
      fromId,
      ts,
      epochMs: slackTsToMs(ts),
      permalink,
      text,
    })
  }
  return out
}

/**
 * "Anything that reads like a task or ask aimed at me" — the brief asked for
 * this, and it is done with rules rather than a model, so you can read exactly
 * why any given message was flagged. Deliberately tuned to under-claim.
 */
const ASK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(can|could|would)\s+you\b/i, 'a direct request'],
  [/\b(pls|please)\b/i, 'a direct request'],
  [/\bneed\s+(you|this|your)\b/i, 'someone needs something from you'],
  [/\b(any\s+update|update\s+on|status\s+on|eta\b)/i, 'someone is chasing an update'],
  [/\b(blocked|blocker|waiting\s+on\s+you|stuck)\b/i, 'someone is blocked'],
  [/\b(review|take\s+a\s+look|have\s+a\s+look|ptal)\b/i, 'a review request'],
  [/\?\s*$/m, 'a question for you'],
]

export function readsLikeAsk(text: string): string | null {
  for (const [re, why] of ASK_PATTERNS) if (re.test(text)) return why
  return null
}

const clean = (t: string) =>
  t.replace(/<@([A-Z0-9]+)\|([^>]+)>/g, '@$2')
   .replace(/<@([A-Z0-9]+)>/g, '@$1')
   .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
   .replace(/<(https?:\/\/[^>]+)>/g, '$1')
   .replace(/\s+/g, ' ')
   .trim()

/* ------------------------------ adapter ------------------------------- */

export async function runSearch(tool: string, query: string, limit = 20): Promise<SlackHit[]> {
  const r = await getSession().callJson<any>(tool, {
    query,
    sort: 'timestamp',
    sort_dir: 'desc',
    limit,
    include_context: false,
    response_format: 'detailed',
  })
  const md = typeof r === 'string' ? r : (r?.results ?? '')
  return typeof md === 'string' ? parseSlackResults(md) : []
}

export const slack: SourceAdapter = {
  name: 'slack',
  label: 'Slack',

  async status() {
    const { token, via } = await resolveToken('slack')
    if (!token) {
      // Product copy, not a command. Settings offers Connect, and keeps the
      // terminal route behind a disclosure for when that is the faster answer.
      return { ok: false, detail: 'Wake reads DMs, mentions and asks addressed to you. Connect it to start.' }
    }
    try {
      const t = await discoverTools()
      if (!t.search) return { ok: false, detail: 'connected, but the server exposes no search tool', via }
      return { ok: true, detail: t.myUserId ? `connected as ${t.myUserId}` : 'connected', via }
    } catch (e) {
      if (e instanceof McpUnauthorized) return { ok: false, detail: 'token rejected — reconnect', via }
      return { ok: false, detail: (e as Error).message, via }
    }
  },

  async fetch() {
    const { token } = await resolveToken('slack')
    if (!token) throw new NotConnected('slack')

    const t = await discoverTools()
    if (!t.search) throw new Error('the Slack server exposes no search tool')

    const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10)
    const me = t.myUserId

    const queries: Array<{ q: string; kind: string; why: string }> = [
      { q: `to:me after:${since}`, kind: 'dm', why: 'sent directly to you' },
    ]
    if (me) queries.push({ q: `<@${me}> after:${since}`, kind: 'mention', why: 'you were mentioned' })

    const results = await Promise.allSettled(queries.map(g => runSearch(t.search!, g.q)))

    const cards: RawCard[] = []
    const seen = new Set<string>()

    results.forEach((res, i) => {
      if (res.status !== 'fulfilled') return
      const g = queries[i]!
      for (const h of res.value) {
        // Never surface my own messages back to me.
        if (me && h.fromId === me) continue
        const key = `${h.channelId}:${h.ts}`
        if (seen.has(key)) continue
        seen.add(key)

        const text = clean(h.text)
        const ask = readsLikeAsk(text)

        const refs: Ref[] = [
          { t: 'slackthread', v: key },
          ...extractRefs(h.text),
        ]

        cards.push({
          source: 'slack',
          source_id: key,
          kind: h.isDm ? 'dm' : g.kind,
          title: text.slice(0, 120) || `Message from ${h.fromName}`,
          // Prefer the sharper reason when the message reads like an ask.
          why: ask ?? (h.isDm ? g.why : 'you were mentioned'),
          actor: h.fromName,
          actor_id: h.fromId,
          excerpt: text.slice(0, 400),
          url: h.permalink,
          ts: h.epochMs,
          pile: 'now',
          refs,
          meta: {
            channel: h.channelName,
            channel_id: h.channelId,
            is_dm: h.isDm,
            thread_ts: h.ts,
            ask: ask ?? null,
          },
        })
      }
    })
    return cards
  },
}

/** On-demand thread read, used when a card is opened rather than on every poll. */
export async function readThread(channelId: string, messageTs: string) {
  const t = await discoverTools()
  if (!t.readThread) return null
  const r = await getSession().callJson<any>(t.readThread, {
    channel_id: channelId,
    message_ts: messageTs,
    limit: 50,
    response_format: 'detailed',
  })
  const md = typeof r === 'string' ? r : (r?.results ?? r?.messages ?? '')
  return typeof md === 'string' ? { raw: md, messages: parseSlackResults(md) } : r
}
