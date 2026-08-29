import type { SourceName } from '../lib/types'

export const SOURCE_COLOR: Record<SourceName, string> = {
  slack: 'var(--color-src-slack)',
  github: 'var(--color-src-github)',
  gmail: 'var(--color-src-gmail)',
  sentry: 'var(--color-src-sentry)',
  claude: 'var(--color-src-claude)',
}

export const SOURCE_LABEL: Record<SourceName, string> = {
  slack: 'Slack', github: 'GitHub', gmail: 'Gmail', sentry: 'Sentry', claude: 'Claude Code',
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

/** Shown when several sources collapsed into one card — the dedup made visible. */
export function SourceTrail({ sources }: { sources: SourceName[] }) {
  const unique = [...new Set(sources)]
  if (unique.length < 2) return null
  return (
    <span className="inline-flex items-center gap-1" title={unique.map(s => SOURCE_LABEL[s]).join(' + ')}>
      {unique.map(s => <SourceDot key={s} source={s} size={5} />)}
      <span className="text-fg-mute text-[11.5px] ml-0.5">{unique.length} sources</span>
    </span>
  )
}
