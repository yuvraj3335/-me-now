/**
 * The hand-off.
 *
 * Wake packs the context — the Slack thread, the mail thread, the Sentry issue,
 * the card, the template's instruction — and then gets out of the way. What it
 * produces is a URL.
 *
 * That is the whole change from the previous design, and it is deliberate.
 * Wake used to spawn `claude -p` on the box it runs on: a headless process with
 * no terminal attached, whose output nobody could see and whose permission
 * prompts nobody could answer. It was a session in name only.
 *
 * A link is better on every axis that matters here:
 *
 *   - On a laptop it opens a real Claude tab, signed in as you already are.
 *   - On a phone, `https://claude.ai/…` is a universal link, so it opens the
 *     Claude app if it is installed and Safari if it is not. Either way it is
 *     already authenticated; Wake never holds a credential for it.
 *   - Nothing runs on the DevBox, so there is no process to supervise, no pid
 *     to record, and nothing for a restart to orphan.
 *
 * The one real constraint is length. A prefilled prompt travels in the query
 * string, and every layer between here and Claude has its own opinion about how
 * long a URL may be. So the brief is trimmed to a budget, the full pack stays on
 * disk and is downloadable, and the UI says plainly when the two differ rather
 * than quietly handing over a truncated brief.
 */

import { HANDOFF_MAX_CHARS, HANDOFF_PARAM, HANDOFF_URL } from '../env'

export type Handoff = {
  url: string
  /** Characters of the pack the URL actually carries. */
  sent: number
  /** Characters in the full pack. */
  total: number
  trimmed: boolean
}

/** Where a hand-off goes, for the boot log and the Settings page. */
export const handoffTarget = () => HANDOFF_URL

/**
 * A note appended to a trimmed brief.
 *
 * Without it the session receives a message that stops mid-sentence and has no
 * way to know it — which is exactly the kind of silent truncation that makes an
 * assistant confidently answer the wrong question.
 */
const TRIM_NOTE = (total: number, sent: number) =>
  `\n\n---\n[Wake trimmed this brief to fit a URL: ${sent.toLocaleString()} of ${total.toLocaleString()} characters. ` +
  `Ask me for the rest before assuming anything below the cut is missing on purpose.]`

export function handoffFor(packText: string): Handoff {
  const total = packText.length
  const trimmed = total > HANDOFF_MAX_CHARS

  // The note has to fit inside the budget too, so the space it needs comes out
  // of the text rather than being added on top of a cap that was already met.
  const note = trimmed ? TRIM_NOTE(total, HANDOFF_MAX_CHARS) : ''
  const body = trimmed ? packText.slice(0, Math.max(0, HANDOFF_MAX_CHARS - note.length)) + note : packText

  const url = new URL(HANDOFF_URL)
  url.searchParams.set(HANDOFF_PARAM, body)

  return { url: url.toString(), sent: body.length, total, trimmed }
}
