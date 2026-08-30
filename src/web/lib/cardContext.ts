/**
 * Turning a card into context worth reading.
 *
 * This exists because the first version was one line, and that line produced a
 * brief so bad it was worth keeping the post-mortem:
 *
 *     [c.why, c.excerpt, ...c.sources.map(s => `${LABEL[s.source]}: ${s.title}`)].join('\n')
 *
 * Five things wrong with it, all visible in the output:
 *
 *   1. `why` is a UI label — "you were just working on this" — pasted in as if
 *      it were evidence.
 *   2. The source titles are the card's own title, repeated once per source.
 *   3. `excerpt` for a Claude Code session is that session's last prompt, and
 *      when the session was started FROM Wake, that prompt is a Wake brief. So
 *      the brief nested inside itself, and the nested copy carried the stale
 *      title, the stale timestamp and none of the facts.
 *   4. A card seen in Slack AND GitHub AND Gmail — the whole point of the dedup
 *      engine — collapsed into one blob instead of three entries.
 *   5. Everything a source knows was thrown away: the channel, the repo, the PR
 *      number, the Sentry project, the session's working directory.
 *
 * So a card becomes one context entry PER SOURCE, each carrying its own facts
 * as facts. The dedup work finally pays off in the brief rather than only on the
 * card.
 */

import type { Card, CardSource, SourceName } from './types'
import type { PackItem, SlotKind } from './launch'

/**
 * Which templates a card's sources suggest.
 *
 * Every source it was actually seen in, most specific first — because a card
 * that is a Sentry issue *and* a Claude Code session genuinely wants both
 * instructions, and templates are multi-select now. The old version returned one
 * string and, for a bare GitHub card, returned `sentry-issue`: opening a pull
 * request preselected the Sentry template.
 */
export function templatesFor(card: Card): string[] {
  const has = (s: SourceName) => card.sources.some(x => x.source === s)
  const out: string[] = []
  if (has('sentry')) out.push('sentry-issue')
  if (has('slack')) out.push('slack-thread')
  if (has('gmail')) out.push('mail-thread')
  if (has('claude')) out.push('continue-session')
  if (has('github')) out.push('review-pr')
  return out.length ? out : ['blank']
}

/** The single best template, for the callers that still want one. */
export const templateFor = (card: Card): string => templatesFor(card)[0]!

/**
 * Which repository the work concerns, if the card knows.
 *
 * A Claude Code session records its own working directory and a GitHub card
 * records its repo. Both were being discarded, so every brief said `cwd
 * /home/yuvraj/work` — the workspace root — regardless of what it was about.
 */
export function repoHintFor(card: Card): string | null {
  const session = card.sources.find(s => s.source === 'claude')
  if (typeof session?.meta?.cwd === 'string') return session.meta.cwd
  const gh = card.sources.find(s => s.source === 'github')
  if (typeof gh?.meta?.repo === 'string') return gh.meta.repo.split('/').pop() ?? null
  return null
}

const SLOT: Record<SourceName, SlotKind> = {
  slack: 'slack', gmail: 'mail', sentry: 'sentry', github: 'github', claude: 'session',
}

/** A stable identifier for one source of a card, in the shape its tool returns. */
function refFor(s: CardSource, group: string): string {
  const m = s.meta ?? {}
  if (s.source === 'slack' && m.channel_id && m.thread_ts) return `${m.channel_id}:${m.thread_ts}`
  if (s.source === 'gmail' && m.account && m.thread_id) return `${m.account}:${m.thread_id}`
  if (s.source === 'github' && m.repo && m.number) return `${m.repo}#${m.number}`
  if (s.source === 'sentry' && m.short_id) return String(m.short_id)
  if (s.source === 'claude' && m.session_id) return String(m.session_id)
  return group
}

/** The facts a source knows, stated as facts rather than buried in prose. */
function metaFor(s: CardSource): Record<string, string | number | boolean | null> {
  const m = s.meta ?? {}
  const pick = (o: Record<string, unknown>) => {
    const out: Record<string, string | number | boolean | null> = {}
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === undefined || v === '' || typeof v === 'object') continue
      out[k] = v as string | number | boolean
    }
    return out
  }

  switch (s.source) {
    case 'slack':
      return pick({ channel: m.is_dm ? 'a direct message' : m.channel && `#${m.channel}`, reads_like: m.ask })
    case 'gmail':
      return pick({ account: m.account, addressed_to_me: m.direct })
    case 'github':
      return pick({ repository: m.repo, number: m.number, kind: m.is_pr ? 'pull request' : 'issue', draft: m.draft, comments: m.comments })
    case 'sentry':
      return pick({ project: m.project, level: m.level, events: m.events, users_affected: m.users })
    case 'claude':
      return pick({ working_directory: m.cwd, exchanges: m.turns, resume_with: m.resume_cmd })
    default:
      return {}
  }
}

const LABEL: Record<SourceName, string> = {
  slack: 'Slack', github: 'GitHub', gmail: 'Gmail', sentry: 'Sentry', claude: 'Claude Code',
}

/**
 * One entry per place the card was seen.
 *
 * The card's own excerpt goes on the source it came from — the lead one — and
 * every other source contributes its identifiers. `why` is the adapter's plain
 * sentence ("your review is requested"), which IS worth carrying: it says why
 * this is on me, which is the question a brief opens with.
 */
export function cardContext(card: Card): PackItem[] {
  return card.sources.map((s, i) => ({
    kind: SLOT[s.source] ?? 'card',
    ref: refFor(s, card.group_key),
    title: s.title || card.title,
    url: s.url?.startsWith('http') ? s.url : null,
    // Only the lead source carries the body; repeating it per source is how the
    // old version filled a brief with three copies of one sentence.
    excerpt: i === 0 ? (card.excerpt ?? null) : null,
    why: s.why || `seen in ${LABEL[s.source]}`,
    meta: metaFor(s),
  }))
}

/** A one-line title for the brief — the card's, not a template's date stamp. */
export const cardTitle = (card: Card) => card.title.replace(/\s*\.\.\.$/, '').slice(0, 90)
