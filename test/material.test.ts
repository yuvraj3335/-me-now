/**
 * Liquid Glass, and the two things about it that are not matters of taste.
 *
 * **The blur is rationed.** `backdrop-filter` makes the compositor re-sample
 * everything behind the element on every frame it paints. One of those on a
 * fixed bar is free; one per row on a 74-row list is a list that stops tracking
 * the thumb, which is the complaint this whole change started from. So `.glass`
 * and `.glass-bar` blur, and `.glass-card` — which is what a row, a chip and a
 * cell wear — does not. If a future edit "makes the rows properly glassy" by
 * adding a blur there, the phone gets slower and nothing on screen says why.
 *
 * **The material costs contrast, and the budget is spent, not ignored.** A
 * translucent row sits on a lighter ground than the page it replaced, so every
 * token is read against something brighter than the value it was picked for.
 * This file re-derives the composite grounds from the stylesheet's own numbers
 * and measures every text and mark token against all of them — against this
 * file's stated floors, and against what the same token measured on the flat
 * scheme, so the material cannot quietly make anything worse than it was.
 *
 * The ratios are computed here rather than written down. A table of expected
 * numbers is a table that goes stale the first time a token moves; the floors
 * are the thing worth pinning.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/web/styles.css', 'utf8')

/* --------------------------------- colour --------------------------------- */

type RGB = [number, number, number]

const hex = (s: string): RGB => {
  const h = s.replace('#', '')
  const p = h.length === 3 ? h.split('').map(c => c + c) : (h.match(/../g) as string[])
  return [parseInt(p[0]!, 16), parseInt(p[1]!, 16), parseInt(p[2]!, 16)]
}

const luminance = ([r, g, b]: RGB) => {
  const f = (c: number) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** `src` composited over `dst` at `alpha`. How a translucent surface resolves. */
const over = (src: RGB, alpha: number, dst: RGB): RGB =>
  [0, 1, 2].map(i => src[i]! * alpha + dst[i]! * (1 - alpha)) as RGB

/* ---------------------- what the stylesheet actually says ------------------- */

/**
 * One theme's block, so the dark values are not read out of the light one.
 *
 * The file declares each token three times — the dark `:root`, the explicit
 * light theme, and the `prefers-color-scheme` fallback — and a naive search
 * would find whichever came first.
 */
function block(marker: string): string {
  const at = css.indexOf(marker)
  if (at === -1) throw new Error(`styles.css no longer has the ${marker} block`)
  const end = css.indexOf('\n  }', at)
  return css.slice(at, end === -1 ? undefined : end)
}

const DARK = block(":root[data-theme='dark']")
const LIGHT = block(":root[data-theme='light']")

const token = (scope: string, name: string): string => {
  const m = scope.match(new RegExp(`${name}:\\s*([^;]+);`))
  if (!m) throw new Error(`${name} is gone from this theme`)
  return m[1]!.trim()
}

const colour = (scope: string, name: string) => hex(token(scope, name))

/** The alpha out of an `rgb(r g b / a)` token. */
const alphaOf = (scope: string, name: string) => {
  const v = token(scope, name)
  const m = v.match(/\/\s*([\d.]+)\s*\)/)
  if (!m) throw new Error(`${name} is not an rgb(… / a) value: ${v}`)
  return Number(m[1])
}
const rgbOf = (scope: string, name: string): RGB => {
  const n = token(scope, name).match(/[\d.]+/g)!.slice(0, 3).map(Number)
  return n as RGB
}

/* ------------------------------- the grounds ------------------------------- */

/**
 * Every ground a token can be read on, worst case.
 *
 * `ambient` stacks BOTH washes, which is stronger than anything on screen — they
 * are radial gradients at opposite corners, each fading out at 70% of its
 * radius, so nowhere gets the full sum. Measuring the impossible case is the
 * point: pass here and every real pixel passes.
 */
function grounds(scope: string) {
  const page = colour(scope, '--color-ink-900')
  const ambient = over(
    rgbOf(scope, '--ambient-2'), alphaOf(scope, '--ambient-2'),
    over(rgbOf(scope, '--ambient-1'), alphaOf(scope, '--ambient-1'), page),
  )
  const card = over(
    rgbOf(scope, '--glass-card-tint'), alphaOf(scope, '--glass-card-tint'), ambient,
  )
  return {
    page, ambient, card,
    panel: colour(scope, '--color-ink-850'),
    hover: colour(scope, '--color-ink-800'),
    pressed: colour(scope, '--color-ink-700'),
    rowNew: colour(scope, '--color-row-new'),
    rowSel: colour(scope, '--color-row-sel'),
  }
}

/** Text read to decide; the file's floor for it is 7:1 dark, 6:1 light. */
const TEXT = ['--color-fg', '--color-fg-dim', '--color-fg-mute'] as const
/** A mark that carries meaning on its own. The file's floor is 5.5:1. */
const MARKS = [
  '--color-accent-ink', '--color-ok', '--color-warn', '--color-bad',
  '--color-status-idle', '--color-status-live', '--color-status-review',
  '--color-status-done', '--color-status-drop',
  '--color-src-slack', '--color-src-github', '--color-src-gmail',
  '--color-src-sentry', '--color-src-claude',
] as const

/**
 * The flat scheme this replaced, as the regression floor.
 *
 * Not "what looks fine" — what the product actually delivered before the
 * material existed. Every token has to measure at least this well against its
 * own worst ground, or the glass has been paid for with legibility.
 */
const FLAT_DARK = {
  page: '#0a0a0c', panel: '#101014', hover: '#17171c',
  pressed: '#1e1e25', rowNew: '#1b1509', rowSel: '#22232f',
}
const FLAT_LIGHT = {
  page: '#f7f7f9', panel: '#ffffff', hover: '#eeeef2',
  pressed: '#e5e6ec', rowNew: '#faf2e4', rowSel: '#e2e6f2',
}

describe('the material is rationed, which is what makes it fast', () => {
  const rule = (name: string) => {
    const at = css.indexOf(`\n  .${name} {`)
    if (at === -1) throw new Error(`.${name} is gone`)
    return css.slice(at, css.indexOf('\n  }', at))
  }

  test('chrome blurs', () => {
    for (const n of ['glass', 'glass-bar', 'glass-scrim']) {
      expect(rule(n), `.${n} stopped blurring, so it is a flat tint now`)
        .toContain('backdrop-filter: blur(')
    }
  })

  test('content does not', () => {
    // The one that matters. `.glass-card` is worn by every row, chip and cell —
    // 50 of them on a phone screenful. A `backdrop-filter` here is 50
    // full-viewport re-samples per frame and the list stops following the thumb.
    expect(rule('glass-card'), 'a row blurs now, and the phone list will drop frames')
      .not.toContain('backdrop-filter')
    expect(rule('glass-edge'), 'the edge-only weight grew a blur')
      .not.toContain('backdrop-filter')
  })

  test('every blurred surface carries the -webkit- prefix', () => {
    // iOS Safari has never shipped the unprefixed property, and this is read on
    // a phone. An unprefixed-only rule is a transparent panel over live content.
    for (const n of ['glass', 'glass-bar', 'glass-scrim']) {
      expect(rule(n), `.${n} is unblurred on every iPhone`)
        .toContain('-webkit-backdrop-filter: blur(')
    }
  })

  test('and it degrades rather than breaking where the filter is refused', () => {
    // Firefox with the pref off, an old WebView, a device under memory pressure:
    // without a fallback the panel is 72% transparent with no blur, which is not
    // a softer version of this, it is unreadable text over live content.
    const guard = css.slice(css.indexOf('@supports not ((backdrop-filter'))
    expect(guard, 'the opaque fallback for .glass is gone').toMatch(/\.glass \{ background:/)
    expect(guard, 'the opaque fallback for .glass-bar is gone').toMatch(/\.glass-bar \{ background:/)
  })

  test('a press answers the finger without eating the colour fade', () => {
    /*
     * `transition-property` is one property, and every element wearing `.press`
     * also wears Tailwind's `transition-colors`. Whichever the cascade puts last
     * wins outright — so a bare `transition: transform` in `.press`, which is
     * written after the Tailwind import, deleted the colour fade from every
     * button, chip and nav item in the product. Hover snapped, and nothing said
     * why. Both halves have to be in the one declaration.
     */
    const press = css.slice(css.indexOf('\n  .press,'), css.indexOf('.press:active'))
    expect(press, 'the press transition stopped carrying the transform')
      .toMatch(/transform 220ms/)
    for (const prop of ['color', 'background-color', 'border-color']) {
      expect(press, `\`${prop}\` fell out of the press transition, so hover snaps now`)
        .toMatch(new RegExp(`\\b${prop} \\d+ms`))
    }
  })

  test('reduced motion turns the blur off, and keeps the tint readable', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {', css.indexOf('.glass {')))
    for (const n of ['glass', 'glass-bar']) {
      expect(reduced, `.${n} keeps blurring under reduced motion`)
        .toMatch(new RegExp(`\\.${n} \\{[^}]*backdrop-filter: none`))
    }
  })
})

describe('a row is a pane, and the pane holds its own drawer', () => {
  /** The three lists whose rows carry a swipe drawer. Mail's does not. */
  const swipeRows = {
    'the desk phone list': 'src/web/components/CardTable.tsx',
    'Work': 'src/web/pages/Work.tsx',
    'Sessions': 'src/web/components/sessions.tsx',
  }
  /** Every list whose rows are panes, drawer or not. */
  const paneRows = { ...swipeRows, Mail: 'src/web/pages/Mail.tsx' }

  test('every row is a rounded pane with the specular pair', () => {
    for (const [name, path] of Object.entries(paneRows)) {
      const src = readFileSync(path, 'utf8')
      expect(src, `${name}'s row went back to being a strip between hairlines`)
        .toContain('rounded-card')
      expect(src, `${name}'s row lost the edge that makes it read as glass`)
        .toContain('glass-edge')
    }
  })

  test('and the swipeable ones clip to their own corner radius', () => {
    /*
     * `overflow-hidden` on a swipeable row looks like something to delete —
     * this file's own history has a note about *not* clipping there, because the
     * drawer used to clip its own reveal and a hidden overflow ate the status
     * control's 44px collar. Both of those were true of a square row.
     *
     * A rounded one changes it: the drawer is a solid block pinned to the row's
     * right edge, and unclipped it paints its square red `Delete` end straight
     * through a 14px corner. The row then reads as broken at exactly the moment
     * it is being acted on. The collar is safe because the drawer is `inset`,
     * not outset — it never reaches past the row it belongs to.
     */
    for (const [name, path] of Object.entries(swipeRows)) {
      const src = readFileSync(path, 'utf8')
      expect(src, `${name}'s row stopped clipping, so its drawer paints past the corner`)
        .toMatch(/overflow-hidden[\s\S]{0,120}rounded-card|rounded-card[\s\S]{0,120}overflow-hidden/)
    }
  })

  test('and the lists put air between them rather than a hairline', () => {
    // The separator is the gap now. A rounded pane with a rule under it is a
    // card in a table, which is neither thing.
    const table = readFileSync('src/web/components/CardTable.tsx', 'utf8')
    expect(table, 'the phone list went back to stacking rows against each other')
      .toContain('<ul className="flex flex-col gap-2 pt-2">')
  })
})

describe.each([
  ['dark', DARK, FLAT_DARK, 7],
  ['light', LIGHT, FLAT_LIGHT, 6],
] as const)('%s: the material never costs legibility', (name, scope, flat, textFloor) => {
  /*
   * Which way "attended to" points, which is not the same in the two themes.
   *
   * Dark mode lifts: a hovered row is lighter than a resting one, the way the
   * whole ink scale climbs away from a near-black page. Light mode does the
   * opposite — a card is already white, so there is nowhere up to go and hover
   * is a step *down* into grey. The invariant is that hover is visibly not the
   * resting ground; the direction is the theme's.
   */
  const lifts = name === 'dark'
  const g = grounds(scope)
  const all = Object.values(g)
  const flatGrounds = Object.values(flat).map(hex)

  test('a resting row clears this file\'s own floors', () => {
    // The commonest read in the product: body text on a row nobody is pointing
    // at. This is the ground the material actually created, so it is the one
    // that has to clear the stated floor rather than merely not regress.
    for (const t of TEXT) {
      const r = contrast(colour(scope, t), g.card)
      expect(r, `${t} on a resting row is ${r.toFixed(2)}:1, under ${textFloor}:1`)
        .toBeGreaterThanOrEqual(textFloor)
    }
    for (const t of MARKS) {
      const r = contrast(colour(scope, t), g.card)
      expect(r, `${t} on a resting row is ${r.toFixed(2)}:1, under 5.5:1`)
        .toBeGreaterThanOrEqual(5.5)
    }
  })

  test('and no token reads worse on any ground than it did without the material', () => {
    for (const t of [...TEXT, ...MARKS]) {
      const c = colour(scope, t)
      const before = Math.min(...flatGrounds.map(b => contrast(c, b)))
      const after = Math.min(...all.map(b => contrast(c, b)))
      expect(after, `${t} fell from ${before.toFixed(2)}:1 to ${after.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(before - 0.01)
    }
  })

  test('the structural tokens still draw an edge on a row', () => {
    // `rule` and `edge` are never text, and their floors are their own: a
    // hairline that cannot be seen is a design leaning on nothing. They are
    // measured on the CARD, because a border on a resting row is now the
    // commonest place either of them is drawn.
    const r = contrast(colour(scope, '--color-rule'), g.card)
    const e = contrast(colour(scope, '--color-edge'), g.card)
    expect(r, `rule on a row is ${r.toFixed(2)}:1, under 1.5:1`).toBeGreaterThanOrEqual(1.5)
    expect(e, `edge on a row is ${e.toFixed(2)}:1, under 1.9:1`).toBeGreaterThanOrEqual(1.9)
  })

  test('a row is visibly a pane, and hover still lifts off it', () => {
    // Two failures this catches, and the second is the one that actually
    // happened: `ink-800` was picked as a lift above the flat page, and once a
    // resting row had a ground of its own the same value was *below* it — so
    // pointing at a row dimmed it.
    expect(contrast(g.card, g.page), 'a row is the same colour as the page it floats on')
      .toBeGreaterThan(1.02)
    const moved = lifts
      ? luminance(g.hover) - luminance(g.card)
      : luminance(g.card) - luminance(g.hover)
    expect(moved, `hover moves the wrong way for ${name}: a pointer dims the row it is on`)
      .toBeGreaterThan(0)
    expect(contrast(g.hover, g.card), 'hover is the resting ground, so pointing at a row does nothing')
      .toBeGreaterThan(1.05)
  })

  test('the ambient wash stays a wash', () => {
    // It is the thing the material refracts, and the one number that can quietly
    // eat the whole contrast budget: every token above is measured through it.
    for (const n of ['--ambient-1', '--ambient-2']) {
      expect(alphaOf(scope, n), `${n} is strong enough to be a background, not a wash`)
        .toBeLessThanOrEqual(0.07)
    }
  })
})
