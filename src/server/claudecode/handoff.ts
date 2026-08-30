/**
 * The hand-off.
 *
 * Wake packs the context — the Slack thread, the mail thread, the Sentry issue,
 * the card, the session — and then gets out of the way. What it produces is a
 * URL, and the arithmetic behind that URL lives in `src/shared/handoff.ts`
 * because the editor in the browser needs the same numbers live.
 *
 * Wake used to spawn `claude -p` on the box it runs on: a headless process with
 * no terminal attached, whose output nobody could see and whose permission
 * prompts nobody could answer. It was a session in name only. A link is better
 * on every axis that matters — it opens the Claude app on a phone and a tab on a
 * laptop, both already signed in, and nothing runs on the DevBox at all.
 */

import { HANDOFF_MAX_CHARS, HANDOFF_PARAM, HANDOFF_URL } from '../env'
import { handoffFor as build, type Handoff, type HandoffConfig } from '../../shared/handoff'

export const handoffConfig = (): HandoffConfig => ({
  url: HANDOFF_URL,
  param: HANDOFF_PARAM,
  maxChars: HANDOFF_MAX_CHARS,
})

/** Where a hand-off goes, for the boot log and the Settings page. */
export const handoffTarget = () => HANDOFF_URL

export const handoffFor = (brief: string): Handoff => build(brief, handoffConfig())

export type { Handoff }
