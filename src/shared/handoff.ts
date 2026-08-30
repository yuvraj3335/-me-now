/**
 * How a brief becomes a link — the half both sides need.
 *
 * The server owns what gets written to disk and audited. The browser needs the
 * same arithmetic *live*, because the brief is editable now: the character count
 * under the editor, the trim warning, and the `href` on the Open button all have
 * to move as you type, and a round trip per keystroke is not that.
 *
 * So the rule lives here, imported by both. Two implementations of "how much
 * fits" would drift, and the failure mode is the worst kind — the editor says it
 * all fits and the link quietly carries less.
 */

export type HandoffConfig = {
  /** Where a brief goes, e.g. https://claude.ai/new */
  url: string
  /** The query parameter that prefills the conversation, e.g. `q`. */
  param: string
  maxChars: number
}

export type Handoff = {
  url: string
  /** Characters the link actually carries. */
  sent: number
  /** Characters in the full brief. */
  total: number
  trimmed: boolean
}

/**
 * A note appended to a trimmed brief.
 *
 * Without it the session receives a message that stops mid-sentence and has no
 * way to know it — which is exactly the kind of silent truncation that makes an
 * assistant confidently answer the wrong question.
 */
const trimNote = (total: number, sent: number) =>
  `\n\n---\n[Wake trimmed this brief to fit a URL: ${sent.toLocaleString()} of ${total.toLocaleString()} characters. ` +
  `Ask me for the rest before assuming anything below the cut is missing on purpose.]`

export function handoffFor(brief: string, cfg: HandoffConfig): Handoff {
  const total = brief.length
  const trimmed = total > cfg.maxChars

  // The note has to fit inside the budget too, so the space it needs comes out
  // of the text rather than being added on top of a cap that was already met.
  const note = trimmed ? trimNote(total, cfg.maxChars) : ''
  const body = trimmed ? brief.slice(0, Math.max(0, cfg.maxChars - note.length)) + note : brief

  const url = new URL(cfg.url)
  url.searchParams.set(cfg.param, body)

  return { url: url.toString(), sent: body.length, total, trimmed }
}
