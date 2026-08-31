/**
 * Gmail over the Gmail MCP server. Multi-account from the start: each address
 * gets its own credential key ("gmail:<address>"), so two addresses are separate
 * connections rather than one inbox with a filter bolted on. This deployment
 * configures exactly one, `yuvraj@truto.one`.
 *
 * Read-only: only search_threads / get_thread are ever called, and the client's
 * write-tool denylist blocks the rest regardless.
 *
 * Two searches per inbox, and neither of their queries lives in this file. The
 * first is the narrow one — what Gmail's own categories and his own filters say
 * is worth a row — and the second exists because that narrowing has to be
 * overrulable: a thread he has already answered is his, whatever Gmail decided
 * about it. Both are assembled from settings in `env.ts`, which is also where
 * the measurements that chose each clause are written down. This file decides
 * what a thread *becomes*; it no longer decides which threads he is shown.
 */
import { resolveToken } from '../mcp/creds'
import {
  GMAIL_ACCOUNTS, GMAIL_PAGE_SIZE, GMAIL_RESCUE_REPLIED, gmailCardQuery, gmailRepliedQuery, ME,
} from '../env'
import { extractRefs, subjectRef } from '../dedup'
import { gmailThreadUrl, probeMail, sessionFor } from '../mail/gmail'
import { plainBody, plainText } from '../mail/sanitize'
import { rescuedByReply } from '../mail/triage'
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

  /**
   * Ask Google, rather than ask whether a token exists.
   *
   * This was the one adapter of four that answered from a *string*. Slack calls
   * `discoverTools`, Sentry calls `findIssuesTool`, GitHub calls
   * `api.github.com/user` — each of them round-trips and each of them turns an
   * `McpUnauthorized` into "reconnect". Gmail returned `ok: true` as soon as
   * `resolveToken` handed back any token at all.
   *
   * `resolveToken` is a real check and #36 is why — a credential that cannot
   * refresh comes back null rather than stale. What it cannot see is the token
   * that has not expired and has been *revoked*, which is precisely what
   * happens when a Google grant is withdrawn from the account page: nothing
   * expires, no refresh is attempted, so Settings kept saying `connected:
   * yuvraj@truto.one` while every fetch 401'd. "A source nobody connected is
   * not a healthy sync" is already a suite in this repo; this is the same rule
   * one tier down.
   *
   * `probeMail` is the probe the mail surface already runs, so this adds no new
   * mechanism and no new round trip in the common case: it is cached behind
   * `CAP_TTL_MS`, deduplicated through a single in-flight promise, and
   * deliberately *not* cached when every inbox was rejected, so a reconnect
   * shows up here immediately instead of looking like it did nothing.
   */
  async status() {
    const caps = await probeMail()
    const live = caps.accounts.filter(a => a.connected)

    if (!live.length) {
      return { ok: false, detail: caps.reason ?? 'not connected' }
    }

    // One token, every configured address — `fetch` polls all of them with it,
    // and `/api/mail/state` lists all of them as connected. Calling that
    // "single account" contradicted both wherever the string surfaced.
    const shared = live.length < GMAIL_ACCOUNTS.length ? '' : ' (one shared token)'
    const detail = live.length === 1
      ? `connected: ${live[0]!.address}`
      : `connected: ${live.map(a => a.address).join(', ')}${shared}`

    return { ok: true, detail, via: live[0]!.via }
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

      /**
       * One search, recorded whichever way it goes.
       *
       * Two queries now run per inbox and both belong in `settled`: a poll that
       * asked twice and was refused once has half an answer, and the sweep that
       * marks cards gone is entitled to know that before it decides a thread has
       * disappeared. `null` rather than `[]` for the same reason the account
       * loop keeps `anyConnected` — a query that failed is not a query that
       * found nothing.
       */
      const ask = async (query: string): Promise<GmailThread[] | null> => {
        try {
          const payload = await s.callJson('search_threads', { query, pageSize: GMAIL_PAGE_SIZE })
          settled.push({ status: 'fulfilled', value: payload })
          return threadsFrom(payload)
        } catch (e) {
          settled.push({ status: 'rejected', reason: e })
          return null
        }
      }

      // Thread ids this inbox has already produced a row for. The two queries
      // overlap by design — a thread he answered that is also unread and in the
      // inbox satisfies both — and the desk wants one card for one conversation.
      const carded = new Set<string>()

      const build = (th: GmailThread, rescued: boolean) => {
        const id = th.threadId ?? th.id
        if (!id || carded.has(id)) return
        carded.add(id)

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
          // A rescued row is on the desk for a different reason from the rest and
          // says so. It reached the card query's exclusions and was let through
          // anyway, because he had already answered it — and a row that survived
          // a filter should be able to explain that to the person reading it.
          why: rescued
            ? 'you replied — this thread has moved since'
            : direct ? 'addressed to you, unread' : 'unread in your inbox',
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

      /*
       * What Gmail already knows, asked once.
       *
       * The query is assembled in `env.ts` from settings rather than written
       * here, because it is a judgement about somebody else's mail and the
       * person whose mail it is has to be able to change it. See that file for
       * what each clause was measured to remove.
       */
      const inbox = await ask(gmailCardQuery())
      if (inbox) {
        for (const th of inbox) build(th, false)

        /*
         * And the rule the narrowing is not allowed to overrule.
         *
         * A thread he has answered is a thread he is in, whatever Gmail decided
         * about its category and whoever the sending address belongs to. It has
         * to be a second search because Gmail matches per message even when it
         * returns threads, so `is:unread from:me` wants one message that is both
         * and answers zero — the two halves are asked separately and joined
         * here, on thread id, by `carded`.
         *
         * Only when the first query answered. A second round trip against a
         * credential that was just refused buys another copy of the same 401.
         */
        if (GMAIL_RESCUE_REPLIED) {
          for (const th of (await ask(gmailRepliedQuery())) ?? []) {
            // `from:me` is Gmail's claim, not a fact: an alias, a delegated
            // mailbox or his address quoted inside a forward all satisfy it. And
            // that query is deliberately not restricted to unread, so without
            // this gate every conversation he has touched in a fortnight lands
            // on the desk — the exact failure this whole change is undoing.
            if (!rescuedByReply(th.messages ?? [], ME.emails)) continue
            build(th, true)
          }
        }
      }
    }
    // Every configured address came back without a token: nothing was polled,
    // which is a different answer from "polled and found nothing".
    if (!anyConnected) throw new NotConnected('gmail')
    return settle('gmail', settled, cards)
  },
}
