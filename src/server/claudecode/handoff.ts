/**
 * The hand-off — now the secondary one.
 *
 * Wake packs the context — the Slack thread, the mail thread, the Sentry issue,
 * the card, the session — and this is what turns the packed brief into a URL.
 * The arithmetic behind that URL lives in `src/shared/handoff.ts` because the
 * editor in the browser needs the same numbers live.
 *
 * This used to be the whole feature: Wake stopped spawning `claude -p` — a
 * headless process with no terminal attached, whose output nobody could see and
 * whose permission prompts nobody could answer — and a link to the Claude app
 * was what replaced it, on the reasoning that it opens on a phone and a tab on
 * a laptop, both already signed in, with nothing running on the DevBox at all.
 *
 * `terminal.ts` is what replaced *that* reasoning: `claude.ai/new?q=` opens a
 * different product, with no repository, no tools and no way to reach an
 * existing conversation — a link cannot resume a session, however good the
 * arithmetic behind its URL is. So `HANDOFF_MAX_CHARS` below and the trimming
 * it does are still real, but they bound one link on the composer's footer, the
 * one to use away from this box entirely — not the brief a session actually
 * receives, which travels whole as a process argument and answers to
 * `MAX_BRIEF_BYTES` in `terminal.ts` instead.
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
