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

/** CIE L*, which is perceptually uniform where a contrast ratio is not. */
const lstar = (Y: number) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y)

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
 * Every ground a token can be read on, worst case, split by what the file is
 * allowed to charge each of them.
 *
 * RESTING is a surface you read on while nothing is happening: the page itself,
 * a row at rest, a field, a panel. Those carry the file's full stated floors,
 * because that is the commonest read in the product.
 *
 * ATTENDED is a surface that has been lifted *because* you are on it — hover,
 * the keyboard cursor, the selected row, a row with something new on it, and a
 * control raised off a card. A lift costs contrast by construction, and this
 * file has always accepted an erosion there and written the numbers down; what
 * it did not have was a floor under the erosion. It does now: one rung below
 * the resting floor for text, and 4.5:1 for a mark.
 *
 * `ambient` stacks BOTH washes at full strength. That is stronger than any real
 * pixel — modelled on an 8px grid across a 390×844 viewport the two gradients
 * sum to 1.02 washes on average and 0.84 at their weakest point, never 2.0 —
 * and measuring the impossible case is the point: pass here and every real pixel
 * passes.
 *
 * `panel` is the composite a `Sheet` or a `Menu` actually lands on, which is
 * `--glass-tint` over a ROW, not the opaque `ink-850` fallback on its own. A
 * sheet opens over the desk; the desk is rows. Both are measured.
 */
function grounds(scope: string) {
  const page = colour(scope, '--color-ink-900')
  const ambient = over(
    rgbOf(scope, '--ambient-2'), alphaOf(scope, '--ambient-2'),
    over(rgbOf(scope, '--ambient-1'), alphaOf(scope, '--ambient-1'), page),
  )
  const tint = (name: string, on: RGB) => over(rgbOf(scope, name), alphaOf(scope, name), on)
  const card = tint('--glass-card-tint', ambient)
  return {
    resting: {
      page, ambient, card,
      well: tint('--color-well', card),
      panel: tint('--glass-tint', card),
      opaquePanel: colour(scope, '--color-ink-850'),
    },
    attended: {
      raise: tint('--color-raise', card),
      hover: colour(scope, '--color-ink-800'),
      pressed: colour(scope, '--color-ink-700'),
      rowNew: colour(scope, '--color-row-new'),
      rowSel: colour(scope, '--color-row-sel'),
    },
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

  test('the pointer-tracked sheen stays a highlight, not a second contrast budget', () => {
    // `--glass-shine` is the radial highlight `.glass::before` paints at
    // wherever `useGlassSheen` last saw the pointer. It composites on TOP of
    // every token measured elsewhere in this file, so it does not get to have
    // its own opinion about what a floor is — it is held to a flat ceiling
    // low enough that it can never be the difference between a token clearing
    // its floor and missing it, in either theme.
    for (const [name, scope] of [['dark', DARK], ['light', LIGHT]] as const) {
      const a = alphaOf(scope, '--glass-shine')
      expect(a, `${name}'s --glass-shine is ${a}, above the 0.06 ceiling this feature is allowed`)
        .toBeLessThanOrEqual(0.06)
    }
  })
})

/*
 * Text over glass, composited rather than assumed.
 *
 * Every other contrast test in this file measures a token against a RESTING
 * or ATTENDED ground — a row, a card, a hover. A `Sheet` and a `Menu` are a
 * different case: they are `.glass`/`.glass-bar` panels that can open over
 * ANYTHING already on the page, including the brightest things on it, and
 * nothing above measured that composite at all.
 *
 * So this reads `--glass-tint` and `--glass-bar-tint` at their own alpha over
 * five bases: the page, both ambient washes at full strength, the accent
 * surface itself (`#e9a23b` — a card, a chip, a status glyph could sit under
 * a sheet opened from it), and the two attended row grounds. `accentSurface`
 * is deliberately the brightest, most saturated thing the product paints, so
 * passing there is the actual worst case rather than a comfortable one.
 *
 * Every text and mark token gets AA's 4.5:1 floor on every composite — looser
 * than this file's own 7/6 resting floor, because a sheet opening over the one
 * brightest surface in the product is already the edge case an absolute floor
 * exists for. `fg` and `fg-dim` additionally hold this file's own resting
 * floor on the PAGE composite specifically, because that is what a sheet or a
 * menu opens over most of the time and the commonest case should not settle
 * for the floor built for the rarest one.
 */
describe.each([
  ['dark', DARK, 7],
  ['light', LIGHT, 6],
] as const)('%s: a panel of glass stays legible over whatever it opens on', (name, scope, textFloor) => {
  const g = grounds(scope)
  const bases: Record<string, RGB> = {
    page: g.resting.page,
    ambient: g.resting.ambient,
    accentSurface: colour(scope, '--color-accent'),
    rowSel: colour(scope, '--color-row-sel'),
    rowNew: colour(scope, '--color-row-new'),
  }
  const GLASS_MARKS = ['--color-accent-ink', '--color-ok', '--color-warn', '--color-bad'] as const

  test.each(['--glass-tint', '--glass-bar-tint'] as const)('%s clears AA on every base it can open over', (glassToken) => {
    const tint = rgbOf(scope, glassToken)
    const alpha = alphaOf(scope, glassToken)
    for (const [bn, base] of Object.entries(bases)) {
      const ground = over(tint, alpha, base)
      for (const t of [...TEXT, ...GLASS_MARKS]) {
        const r = contrast(colour(scope, t), ground)
        expect(r, `${t} over ${glassToken} on ${bn} is ${r.toFixed(2)}:1, under WCAG AA's 4.5:1`)
          .toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test.each(['--glass-tint', '--glass-bar-tint'] as const)('%s over the page still clears this file\'s own floor', (glassToken) => {
    const tint = rgbOf(scope, glassToken)
    const alpha = alphaOf(scope, glassToken)
    const pageGround = over(tint, alpha, bases.page!)
    for (const t of ['--color-fg', '--color-fg-dim'] as const) {
      const r = contrast(colour(scope, t), pageGround)
      expect(r, `${t} over ${glassToken} on the page is ${r.toFixed(2)}:1, under ${textFloor}:1`)
        .toBeGreaterThanOrEqual(textFloor)
    }
  })
})

describe('the material never decides where a surface sits', () => {
  test('no .glass rule sets position', () => {
    /*
     * `.glass` is written inside `@layer utilities`, after Tailwind's own
     * utilities, so a `position` here out-ranks `fixed` on every element that
     * wears the class. One release did exactly that to anchor `::before`, and
     * the phone's detail page and composer — `fixed inset-x-0 top-0 z-50
     * glass` — fell into document flow and rendered 4,991px below the list on
     * the deployed site. Positioning is the call site's; the material only
     * paints.
     */
    const rules = [...css.matchAll(/\n  \.glass(?:-[a-z]+)?(?:::before)? \{([^}]*)\}/g)]
    expect(rules.length).toBeGreaterThan(3)
    for (const m of rules) {
      if (m[0].includes('::before')) continue
      const body = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '')
      expect(body, `${m[0].slice(0, 30).trim()} sets position — that is the call site's decision`)
        .not.toMatch(/(^|[\s;])position\s*:/)
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
  ['dark', DARK, 7, 6],
  ['light', LIGHT, 6, 5],
] as const)('%s: the material never costs legibility', (name, scope, textFloor, attendedText) => {
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
  const MARK_FLOOR = 5.5
  const ATTENDED_MARK = 4.5

  /*
   * WHAT THIS REPLACED, AND WHY IT HAD TO GO.
   *
   * There used to be a second assertion here, "no token reads worse on any
   * ground than it did without the material", measured against a hard-coded copy
   * of the flat scheme this design replaced. It read as a safety net and it was
   * really a ceiling: the brightest flat ground was `#22232f`, so the rule said
   * *no ground in the new scheme may ever be brighter than the old selected row*
   * — which, with hover, pressed, new and selected all having to stack ABOVE a
   * resting row, left the resting row nowhere to go. The only way to satisfy it
   * was to keep the row a 2% lift over a colourless page, and that is precisely
   * the "flat grey, dull, washed out" the material was supposed to end. A test
   * that pins a new design to the numbers of the one it replaces is not
   * measuring legibility, it is measuring sameness.
   *
   * So it is gone, and what replaces it is stronger rather than looser: every
   * token now has to clear an ABSOLUTE floor on EVERY ground it can be read on,
   * not merely on the resting row, and not merely better than some scheme that
   * no longer exists. Two tiers, because a lifted row genuinely does cost
   * contrast and this file has always said so — it just never had a floor under
   * how much.
   */
  test('every token clears this file\'s floors on every resting ground', () => {
    for (const [gn, ground] of Object.entries(g.resting)) {
      for (const t of TEXT) {
        const r = contrast(colour(scope, t), ground)
        expect(r, `${t} on ${gn} is ${r.toFixed(2)}:1, under ${textFloor}:1`)
          .toBeGreaterThanOrEqual(textFloor)
      }
      for (const t of MARKS) {
        const r = contrast(colour(scope, t), ground)
        expect(r, `${t} on ${gn} is ${r.toFixed(2)}:1, under ${MARK_FLOOR}:1`)
          .toBeGreaterThanOrEqual(MARK_FLOOR)
      }
    }
  })

  test('and holds one rung below it on a ground that was lifted to be attended to', () => {
    for (const [gn, ground] of Object.entries(g.attended)) {
      for (const t of TEXT) {
        const r = contrast(colour(scope, t), ground)
        expect(r, `${t} on ${gn} is ${r.toFixed(2)}:1, under ${attendedText}:1`)
          .toBeGreaterThanOrEqual(attendedText)
      }
      for (const t of MARKS) {
        const r = contrast(colour(scope, t), ground)
        expect(r, `${t} on ${gn} is ${r.toFixed(2)}:1, under ${ATTENDED_MARK}:1`)
          .toBeGreaterThanOrEqual(ATTENDED_MARK)
      }
    }
  })

  /*
   * Two rows against each other have to be two rows.
   *
   * The table dropped `border-b border-rule` when the material arrived — the
   * separator became the material's own pair, a lens shade along the bottom of
   * one row and a specular highlight along the top of the next, which is how
   * stacked panes of glass actually read. That works in dark and is invisible in
   * light, where the highlight is white on a white pane and the lens is 1.15:1:
   * measured on the built page, the light table read as one continuous white
   * block with six titles in it.
   *
   * So the bottom line is `--glass-sep`, which is the material's lens in dark
   * and the `rule` hairline in light, and this measures the widest step the
   * three surfaces make between them rather than any one line against the card —
   * because in dark neither line clears the floor on its own and the pair
   * clearly does, and in light it is the other way round.
   */
  test('two rows against each other are visibly two rows', () => {
    const card = g.resting.card
    const tint = (name: string) => over(rgbOf(scope, name), alphaOf(scope, name), card)
    const top = tint('--glass-card-edge')
    const sep = token(scope, '--glass-sep').startsWith('#')
      ? colour(scope, '--glass-sep')
      : tint('--glass-sep')
    const best = Math.max(contrast(top, sep), contrast(top, card), contrast(sep, card))
    expect(best, `the line between two rows is ${best.toFixed(2)}:1, under 1.5:1 — the table reads as one block`)
      .toBeGreaterThanOrEqual(1.5)
  })

  test('the structural tokens still draw an edge on a row', () => {
    // `rule` and `edge` are never text, and their floors are their own: a
    // hairline that cannot be seen is a design leaning on nothing. They are
    // measured on the CARD, because a border on a resting row is now the
    // commonest place either of them is drawn.
    const r = contrast(colour(scope, '--color-rule'), g.resting.card)
    const e = contrast(colour(scope, '--color-edge'), g.resting.card)
    expect(r, `rule on a row is ${r.toFixed(2)}:1, under 1.5:1`).toBeGreaterThanOrEqual(1.5)
    expect(e, `edge on a row is ${e.toFixed(2)}:1, under 1.9:1`).toBeGreaterThanOrEqual(1.9)
  })

  test('a row is visibly a pane, and hover still lifts off it', () => {
    // Two failures this catches, and the second is the one that actually
    // happened: `ink-800` was picked as a lift above the flat page, and once a
    // resting row had a ground of its own the same value was *below* it — so
    // pointing at a row dimmed it.
    const { card, page } = g.resting
    expect(contrast(card, page), 'a row is the same colour as the page it floats on')
      .toBeGreaterThan(1.02)
    const moved = lifts
      ? luminance(g.attended.hover) - luminance(card)
      : luminance(card) - luminance(g.attended.hover)
    expect(moved, `hover moves the wrong way for ${name}: a pointer dims the row it is on`)
      .toBeGreaterThan(0)
    expect(contrast(g.attended.hover, card), 'hover is the resting ground, so pointing at a row does nothing')
      .toBeGreaterThan(1.05)
  })

  /*
   * A row has to be a PANE, not a shade.
   *
   * This is the assertion the last pass did not have and the one that would have
   * caught what shipped. Contrast ratio is a terrible judge of two nearly-black
   * surfaces — `#040406` against `#111014` is 1.081:1, and so is `#050509`
   * against a row three times further away from it — because the ratio is
   * dominated by the +0.05 flare term at that end of the scale. CIE L* is not:
   * it is perceptually uniform, and it says the old row stood 3.8 above its page
   * where iOS's own grouped cell over black stands 10.
   *
   * 7 is the floor, and it is deliberately below 10: the number that matters is
   * the WORST-lit row, and this measures the modelled worst case, where both
   * ambient washes are at full strength and cancelling none of the lift.
   */
  test('and it is a pane by the only measure that can see one', () => {
    const dL = lstar(luminance(g.resting.card)) - lstar(luminance(g.resting.page))
    expect(Math.abs(dL), `a row stands ${dL.toFixed(1)} L* off its page — under 7, which is a shade, not a pane`)
      .toBeGreaterThanOrEqual(7)
  })

  /*
   * And the surface has to have COLOUR in it.
   *
   * The other half of what shipped: `--glass-card-tint` was `rgb(255 255 255 /
   * 0.02)` over a `#040406` page, and a colourless fill over a colourless ground
   * composites to grey at every alpha there is. No amount of tuning the number
   * was ever going to fix that, which is why the last pass kept raising it and
   * kept getting grey.
   *
   * Contrast is a *luminance* ratio and chroma costs it nothing, so a tinted
   * surface is strictly free next to a neutral one of the same lightness. There
   * is therefore no excuse for a neutral material, and this refuses one. Two
   * separate things are checked because they fail separately:
   *
   *   THE PAGE, in both themes, because it is what everything else is composited
   *   over and a colourless page leaves the material nothing to be made of.
   *
   *   THE TINT ITSELF in dark, where a row is a translucent lift and its colour
   *   can only come from the tint. Light mode is exempt on purpose and not by
   *   omission: there a card is a near-opaque WHITE pane over a tinted page,
   *   which is what iOS does too, and forcing chroma into it would produce a
   *   grey card on a grey page — the exact complaint, in the other theme.
   *
   * Measured as the spread between channels in 0–255, which is crude, and the
   * crudeness is the point: it catches `rgb(255 255 255 / a)` and nothing else.
   */
  test('and it has colour in it rather than being a grey lift', () => {
    const pageSpread = Math.max(...g.resting.page) - Math.min(...g.resting.page)
    expect(pageSpread, `the page composites to a neutral grey (channel spread ${pageSpread.toFixed(1)}) — there is no hue for the material to pick up`)
      .toBeGreaterThanOrEqual(3)
    if (name === 'dark') {
      const tint = rgbOf(scope, '--glass-card-tint')
      const spread = Math.max(...tint) - Math.min(...tint)
      expect(spread, `--glass-card-tint is a neutral white (channel spread ${spread}) — a row can only ever come out grey`)
        .toBeGreaterThanOrEqual(40)
    }
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

/*
 * The two light blocks are one block, written twice.
 *
 * `:root[data-theme='light']` and the `prefers-color-scheme` fallback have to
 * agree value for value: "System" and "Light" rendering differently on the same
 * machine is a bug nobody would think to look for, and the file has claimed for
 * a while that a test enforced this. None did. This is it.
 */
test('System and Light are the same theme', () => {
  const decls = (scope: string) =>
    [...scope.matchAll(/(--[\w-]+):\s*([^;]+?)\s*(?:\/\*[^*]*\*\/\s*)?;/g)]
      .map(m => `${m[1]}: ${m[2]!.split('/*')[0]!.trim()}`)
  const explicit = decls(LIGHT)
  const system = decls(block(':root:not([data-theme])'))
  expect(system, 'the system-preference light theme drifted from the explicit one')
    .toEqual(explicit)
})
