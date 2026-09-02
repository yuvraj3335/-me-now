import type { SourceName } from '../lib/types'
import type { Bucket } from '../lib/bucket'

export const SOURCE_COLOR: Record<SourceName, string> = {
  slack: 'var(--color-src-slack)',
  github: 'var(--color-src-github)',
  gmail: 'var(--color-src-gmail)',
  sentry: 'var(--color-src-sentry)',
  claude: 'var(--color-src-claude)',
}

/**
 * A source's own name, for the places that mean the *pipe* — a connection row
 * in Settings, the Sync menu, a card's `Seen in` line. Sentry stays Sentry
 * here: it is still the credential and the connector Settings shows, and
 * disconnecting it is a different act from tapping a tab.
 */
export const SOURCE_LABEL: Record<SourceName, string> = {
  slack: 'Slack', github: 'GitHub', gmail: 'Gmail', sentry: 'Sentry', claude: 'Claude Code',
}

/**
 * A tab's own name, for the desk's strip and for anything else that means the
 * *bucket* a row is filed under rather than the pipe that carried it. Four of
 * these are the same word as `SOURCE_LABEL`'s; `alerts` is the one tab with no
 * pipe of its own — see `Bucket` in `lib/bucket.ts`.
 */
export const BUCKET_LABEL: Record<Bucket, string> = {
  slack: 'Slack', github: 'GitHub', gmail: 'Gmail', alerts: 'Alerts', claude: 'Claude Code',
}

/**
 * A source is identified by a small coloured dot rather than a logo. Logos at
 * 14px are mud, and five brand palettes at once would wreck the one-accent rule.
 */
export function SourceDot({ source, size = 6 }: { source: SourceName; size?: number }) {
  return (
    <span
      aria-hidden
      className="rounded-full shrink-0 block"
      style={{ width: size, height: size, background: SOURCE_COLOR[source] }}
    />
  )
}
