/**
 * Gmail over the Gmail MCP server. Multi-account from the start: each address
 * gets its own credential key ("gmail:<address>"), so two addresses are separate
 * connections rather than one inbox with a filter bolted on. This deployment
 * configures exactly one, `yuvraj@truto.one`.
 *
 * Read-only: only search_threads / get_thread are ever called, and the client's
 * write-tool denylist blocks the rest regardless.
 */
import { McpSession, HttpTransport } from '../mcp/client'
import { resolveToken } from '../mcp/creds'
import { GMAIL_ACCOUNTS, MCP_SERVERS, ME, LOOKBACK_DAYS } from '../env'
import { extractRefs, subjectRef } from '../dedup'
import { NotConnected, settle, type RawCard, type Ref, type SourceAdapter } from './types'

const sessions = new Map<string, McpSession>()

export function sessionFor(account: string): McpSession {
  let s = sessions.get(account)
  if (!s) {
    // Per-account credentials, falling back to a single shared "gmail" token so
    // one connected inbox works before the second is authorised.
    const getToken = async () =>
      (await resolveToken(`gmail:${account}`)).token ?? (await resolveToken('gmail')).token
    s = new McpSession(`gmail:${account}`, new HttpTransport(MCP_SERVERS.gmail!.url, getToken))
    sessions.set(account, s)
  }
  return s
}

type GmailThread = {
  id?: string
  threadId?: string
  snippet?: string
  subject?: string
  sender?: string
  date?: string
  labelIds?: string[]
  labels?: string[]
  messages?: Array<{
    id?: string
    subject?: string
    sender?: string
    from?: string
    date?: string
    snippet?: string
    labelIds?: string[]
    toRecipients?: string[]
    plaintextBody?: string
  }>
}

const addrOf = (s = '') => s.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? s.trim().toLowerCase()
const nameOf = (s = '') => s.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || addrOf(s)

function threadsFrom(payload: any): GmailThread[] {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  return payload.threads ?? payload.results ?? payload.items ?? []
}

export const gmail: SourceAdapter = {
  name: 'gmail',
  label: 'Gmail',

  async status() {
    const per = await Promise.all(
      GMAIL_ACCOUNTS.map(async a => ({ a, ...(await resolveToken(`gmail:${a}`)) })),
    )
    const shared = await resolveToken('gmail')
    const live = per.filter(p => p.token).map(p => p.a)
    if (!live.length && shared.token) {
      // One token, every configured address — `fetch` polls all of them with it,
      // and `/api/mail/state` lists all of them as connected. Calling that
      // "single account" contradicted both wherever the string surfaced.
      return {
        ok: true,
        detail: GMAIL_ACCOUNTS.length === 1
          ? `connected: ${GMAIL_ACCOUNTS[0]}`
          : `connected: ${GMAIL_ACCOUNTS.join(', ')} (one shared token)`,
        via: shared.via,
      }
    }
    if (!live.length) {
      return {
        ok: false,
        detail:
          'Google expects a token Wake cannot obtain on its own, so this one needs a direct connection ' +
          'rather than a claude.ai connector.',
      }
    }
    return { ok: true, detail: `connected: ${live.join(', ')}`, via: per.find(p => p.token)?.via }
  },

  async fetch() {
    const cards: RawCard[] = []
    let anyConnected = false
    // A rejected inbox is a failed poll, not an empty one. `if (e instanceof
    // McpUnauthorized) continue` returned `[]` with `anyConnected` already true,
    // so a dead Gmail token reported a healthy sync and the sweep then marked
    // every Gmail card gone.
    const settled: Array<PromiseSettledResult<unknown>> = []

    for (const account of GMAIL_ACCOUNTS) {
      const tok = (await resolveToken(`gmail:${account}`)).token ?? (await resolveToken('gmail')).token
      if (!tok) continue
      anyConnected = true

      const s = sessionFor(account)
      // Unread mail addressed to me, excluding the automated noise that would
      // otherwise dominate the Now pile.
      const query = `is:unread newer_than:${LOOKBACK_DAYS}d -category:promotions -category:social`

      let payload: any
      try {
        payload = await s.callJson('search_threads', { query, pageSize: 30 })
        settled.push({ status: 'fulfilled', value: payload })
      } catch (e) {
        settled.push({ status: 'rejected', reason: e })
        continue
      }

      for (const th of threadsFrom(payload)) {
        const id = th.threadId ?? th.id
        if (!id) continue

        const last = th.messages?.[th.messages.length - 1]
        const subject = th.subject ?? last?.subject ?? '(no subject)'
        const senderRaw = th.sender ?? last?.sender ?? last?.from ?? ''
        const snippet = th.snippet ?? last?.snippet ?? ''
        const body = last?.plaintextBody ?? ''
        const ts = Date.parse(th.date ?? last?.date ?? '') || Date.now()

        // Directly addressed beats bulk: a thread with me in To: is on me, a
        // thread I am merely cc'd on is not.
        const to = (last?.toRecipients ?? []).map(addrOf)
        const direct = to.some(t => ME.emails.includes(t))

        // The subject goes through subjectRef, not raw normalizeSubject: that
        // guard is what stops every "(no subject)" or two-word thread from
        // sharing one reference and collapsing unrelated mail into one card.
        const subjectOf = subjectRef(subject)
        const refs: Ref[] = [
          { t: 'gmailthread', v: `${account}:${id}` },
          ...(subjectOf ? [subjectOf] : []),
          // A GitHub notification email carries the PR URL, which is what makes
          // it collapse into the PR's card instead of showing up twice.
          ...extractRefs(`${subject}\n${snippet}\n${body}`),
        ]

        cards.push({
          source: 'gmail',
          source_id: `${account}:${id}`,
          account,
          kind: 'email',
          title: subject,
          why: direct ? 'addressed to you, unread' : 'unread in your inbox',
          actor: nameOf(senderRaw),
          actor_id: addrOf(senderRaw),
          // The sender is a person. The display name when there is one, the
          // address when there is not — never an empty string.
          who: nameOf(senderRaw) || addrOf(senderRaw) || undefined,
          excerpt: (snippet || body).slice(0, 400),
          url: `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#inbox/${id}`,
          ts,
          pile: direct ? 'now' : 'open',
          refs,
          meta: { account, thread_id: id, direct, labels: th.labelIds ?? th.labels ?? [] },
        })
      }
    }
    // Every configured address came back without a token: nothing was polled,
    // which is a different answer from "polled and found nothing".
    if (!anyConnected) throw new NotConnected('gmail')
    return settle('gmail', settled, cards)
  },
}
