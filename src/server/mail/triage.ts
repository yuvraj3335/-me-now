/**
 * Which mail is on him, decided without a model and without a sender list.
 *
 * The Gmail-side query in `env.ts` does the narrowing, because Gmail already
 * knows things about this mailbox that Wake would have to reinvent badly — which
 * senders are mailing lists, which mail is a receipt, which of his own filters
 * archived something before he ever saw it. What Gmail cannot answer is the one
 * question that keeps the narrowing honest: *did he already speak in this
 * thread*. Its search runs per message even when it returns threads, so
 * `is:unread from:me` asks for a single message that is both unread and sent by
 * him and answers nothing at all.
 *
 * So the adapter asks that half separately and the answer is checked here,
 * against the addresses in `ME.emails` rather than against Gmail's idea of
 * "me" — an alias, a delegated mailbox or a quoted address in a forward can all
 * satisfy `from:me` without him having typed a word.
 *
 * These are pure and take the message shapes the Gmail MCP actually returns,
 * which is what makes them testable on a machine with no Gmail credential.
 */

/** The fields of a Gmail MCP message these rules read. Everything is optional. */
export type TriageMessage = {
  sender?: string
  from?: string
  toRecipients?: string[]
  labelIds?: string[]
  unread?: boolean
  isUnread?: boolean
}

/**
 * `Ada Lovelace <ada@example.com>` → `ada@example.com`.
 *
 * The same shape `sources/gmail.ts` reads for `actor_id`, kept here so the
 * survival rule cannot quietly disagree with the card about who sent something.
 */
export const addressOf = (s = ''): string =>
  s.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? s.trim().toLowerCase()

const mine = (me: string[]) => new Set(me.map(m => m.trim().toLowerCase()).filter(Boolean))

/**
 * Is he a named recipient anywhere in this thread?
 *
 * Thread-wide on purpose, and deliberately *not* the same question as the
 * `direct` flag on the card. `direct` asks whether the newest message is
 * addressed to him and decides which pile the row lands in; this asks whether
 * the conversation was ever his, and decides whether the row is allowed to exist
 * at all. A thread that opened "Yuvraj — can you look at this?" and whose last
 * message is a reply-all to the group is still on him, and it is exactly the
 * shape a filter tuned for noise would throw away.
 *
 * To: only. Being cc'd is being kept informed, which is what the `open` pile is
 * for, and treating it as "addressed to him" would readmit every group thread
 * the category exclusions just removed.
 */
export const addressedToMe = (messages: TriageMessage[], me: string[]): boolean => {
  const set = mine(me)
  return messages.some(m => (m.toRecipients ?? []).some(t => set.has(addressOf(t))))
}

/** Has he written in this thread? The strongest signal a mailbox offers that a thread is his. */
export const iReplied = (messages: TriageMessage[], me: string[]): boolean => {
  const set = mine(me)
  return messages.some(m => set.has(addressOf(m.sender ?? m.from ?? '')))
}

/**
 * Is there anything here he has not read?
 *
 * Gmail reports unread as a label, and some payload shapes also carry a boolean;
 * both are accepted, as they are in `normalize.ts`. A thread whose messages
 * carry no label information at all reads as false rather than true, because
 * this gate is what stops the replied-thread query — which is not itself
 * restricted to unread mail — from putting his entire correspondence on the
 * desk. Failing closed costs a row; failing open costs the desk.
 */
export const hasUnread = (messages: TriageMessage[]): boolean =>
  messages.some(m => (m.labelIds ?? []).includes('UNREAD') || m.unread === true || m.isUnread === true)

/**
 * The rule the narrowing is not allowed to overrule.
 *
 * Mail addressed to him, or a thread he has answered, is mail he may be waiting
 * on, and no amount of category tuning is worth losing one of those. Everything
 * else has to earn its row.
 *
 * What this cannot do is rescue what was never fetched. Gmail's categories are
 * applied before Wake sees anything, so a customer whose mail Google decides is
 * `category:updates` is invisible to the card query and invisible to this
 * function — the replied-thread query is the only reason such a thread can come
 * back at all, and only once he has answered it once. That is the trade: the
 * desk is quiet, and the price is that the very first message from a stranger
 * Gmail has misfiled waits in the Mail page instead of ringing the bell.
 */
export const survivesFilter = (messages: TriageMessage[], me: string[]): boolean =>
  addressedToMe(messages, me) || iReplied(messages, me)

/**
 * Should a thread the replied-query returned become a card?
 *
 * Both halves matter. `survivesFilter` re-establishes locally what `from:me`
 * only claimed, and `hasUnread` is the half Gmail refused to answer in the same
 * breath — without it this returns every thread he has touched in a fortnight,
 * read or not.
 */
export const rescuedByReply = (messages: TriageMessage[], me: string[]): boolean =>
  hasUnread(messages) && survivesFilter(messages, me)
