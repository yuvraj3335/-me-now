/**
 * Gmail over the Gmail MCP server. Multi-account from the start: each address
 * gets its own credential key ("gmail:<address>"), so two addresses are separate
 * connections rather than one inbox with a filter bolted on. This deployment
 * configures exactly one, `yuvraj@truto.one`.
 *
 * Read-only: only search_threads / get_thread are ever called, and the client's
 * write-tool denylist blocks the rest regardless.
 */
import { resolveToken } from '../mcp/creds'
import { GMAIL_ACCOUNTS, ME, LOOKBACK_DAYS } from '../env'
import { extractRefs, subjectRef } from '../dedup'
import { gmailThreadUrl, sessionFor } from '../mail/gmail'
import { plainBody, plainText } from '../mail/sanitize'
import { NotConnected, settle, type RawCard, type Ref, type SourceAdapter } from './types'

// The session map lives in `mail/gmail.ts`. There used to be a byte-identical
// copy here under the same name and the same key space, and neither was ever
// cleared — so after a Gmail reconnect both went on replaying the
// `Mcp-Session-Id` issued under the old token, and the poller and the Mail page
// each blamed the other's ghost.
export { sessionFor }

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
      return { ok: false, detail: 'Connect — Google\'s hourly token expired and cannot be refreshed' }
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

        const msgs = th.messages ?? []
        const last = msgs[msgs.length - 1]
        // Through the mail normaliser's own decode, not raw. Google returns
        // HTML-escaped text and marketing mail pads it with invisible joiners,
        // and a card's title and excerpt are rendered as text on four surfaces:
        // `Jobber let&#39;s you send quotes` was a live row.
        const subject = plainText(th.subject ?? last?.subject) || '(no subject)'
        const senderRaw = plainText(th.sender ?? last?.sender ?? last?.from)
        const snippet = plainText(th.snippet ?? last?.snippet)
        const body = plainBody(last?.plaintextBody ?? '')
        /*
         * When the newest thing on this thread happened.
         *
         * `th.date` is the thread's own stamp and is *usually* its newest
         * message. "Usually" is not good enough for the number the desk sorts
         * on: a payload that stamps a thread with the date it *started* leaves a
         * conversation answered this morning sitting under one nobody has
         * touched since Tuesday, and there is nothing on the row to say why.
         * The messages array is already in hand — it is what `activity` in
         * `api.ts` counts replies out of — so the newest of it is read directly
         * rather than trusted to be the same fact by another name.
         *
         * The trailing `0` is not decoration: `Math.max()` of nothing is
         * `-Infinity`, and a thread whose messages all carry unparseable dates
         * would land on the desk stamped before the epoch.
         */
        const ts =
          Math.max(
            Date.parse(th.date ?? last?.date ?? '') || 0,
            ...msgs.map(m => Date.parse(m.date ?? '') || 0),
            0,
          ) || Date.now()

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
          url: gmailThreadUrl(account, id),
          ts,
          pile: direct ? 'now' : 'open',
          refs,
          meta: {
            account, thread_id: id, direct,
            labels: th.labelIds ?? th.labels ?? [],
            /*
             * A later message in a thread is activity on this card, not a
             * second card.
             *
             * The identity was never the problem — a Gmail row has been keyed on
             * `account:threadId` since the first commit — but the *arrival* of a
             * reply was invisible: the card's `ts` moved and nothing said why,
             * so a thread that had been answered twice looked exactly like one
             * nobody had touched. `search_threads` already returns the whole
             * `messages` array, so the fact was in hand and thrown away. This is
             * the list `activity` in `api.ts` counts, under the same rule it
             * counts a Slack thread's replies by.
             */
            replies: Math.max(msgs.length - 1, 0),
            messages: msgs.slice(-20).map(m => {
              const from = m.sender ?? m.from ?? ''
              return {
                ts: Date.parse(m.date ?? '') || ts,
                who: plainText(nameOf(from)) || null,
                snippet: plainText(m.snippet ?? '').slice(0, 280),
                // Replying to a thread is not the thread demanding something of
                // him. Carried on the message because the desk computes activity
                // long after the address that decided this is out of scope.
                mine: ME.emails.includes(addrOf(from)),
              }
            }),
          },
        })
      }
    }
    // Every configured address came back without a token: nothing was polled,
    // which is a different answer from "polled and found nothing".
    if (!anyConnected) throw new NotConnected('gmail')
    return settle('gmail', settled, cards)
  },
}
