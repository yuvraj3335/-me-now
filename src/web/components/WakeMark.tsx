/**
 * The mark: a sun on a horizon.
 *
 * The rail said the word `Wake` and nothing else, which is a wordmark set in the
 * body font — the same weight and family as the nav item under it, so the
 * product had no mark at all, on either device.
 *
 * This is the shape already shipping as the app icon (`public/icons/icon.svg`),
 * redrawn on a 20-unit grid rather than scaled down from 512: at 16px the true
 * proportions put a 4.7-unit disc under a 1-unit bar and the whole thing reads
 * as a smudge, so the disc is drawn heavier and the horizon sits a fraction
 * high, cutting its foot the way the icon's does. Do not restyle the icon file
 * to match; the two are the same idea at two sizes and each is right for its own.
 *
 * One colour, taken from `currentColor`, so the caller themes the whole mark
 * with a text class and nothing here can drift from the palette. No stroke, no
 * gradient, no second fill — the lower bar is the same ink at a third weight,
 * which is what makes it read as distance rather than as a second object.
 */
export function WakeMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 20 20"
      fill="currentColor" aria-hidden focusable="false"
      className={className}
    >
      <path d="M4 12a6 6 0 0 1 12 0Z" />
      <rect x="1" y="11.3" width="18" height="1.4" rx=".7" />
      <rect x="5" y="15.2" width="10" height="1.4" rx=".7" opacity=".35" />
    </svg>
  )
}
