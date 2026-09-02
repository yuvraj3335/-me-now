/**
 * Every `motion.` element that can freeze at `initial` or never finish an
 * `exit` has to fold in `useStill()`.
 *
 * A hidden tab and `prefers-reduced-motion` both schedule no animation
 * frames — see `lib/motion.ts` — so an entrance that never runs leaves
 * whatever `initial` describes on screen for good (`y: '100%'` is a sheet
 * nobody can reach, `opacity: 0` is a menu nobody can read) and an exit that
 * never runs leaves the outgoing mark on screen forever, because
 * `AnimatePresence` is waiting on a frame that is never coming.
 *
 * This has broken before with no visible symptom until someone happened to
 * test with a hidden tab, which is why it is a standing regression guard
 * rather than a one-time read of the diff: it re-derives the check from the
 * source on every run, so a new `motion.` element that skips the guard fails
 * here rather than shipping.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync('src/web/components/primitives.tsx', 'utf8')

/**
 * Every `name={...}` value in the file, with the JSX-expression braces
 * balanced rather than matched to the first `}` — several of these values are
 * object literals of their own (`{ opacity: 0, y: 4 }`), and a naive
 * non-greedy match stops at the object's own closing brace instead of the
 * prop's.
 */
function props(name: 'initial' | 'exit'): string[] {
  const out: string[] = []
  const marker = `${name}={`
  let from = 0
  for (;;) {
    const at = src.indexOf(marker, from)
    if (at === -1) break
    let i = at + marker.length
    let depth = 1
    const start = i
    while (depth > 0 && i < src.length) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      i++
    }
    out.push(src.slice(start, i - 1))
    from = i
  }
  return out
}

describe('every animated entrance and exit takes useStill()', () => {
  test('initial values are gated on `still`, and fall back to `false`', () => {
    const found = props('initial')
    // A file with none at all is not a pass, it is this test finding nothing
    // to check — the component moved and the guard went with it unnoticed.
    expect(found.length, 'no `initial=` prop found in primitives.tsx at all — did it move or get renamed?')
      .toBeGreaterThan(0)
    for (const p of found) {
      expect(p, `an \`initial\` prop has no \`still\` guard: initial={${p}}`).toMatch(/still/)
      expect(p, `an \`initial\` prop is guarded but does not fall back to \`false\`: initial={${p}}`)
        .toMatch(/false/)
    }
  })

  test('exit values are gated on `still`, and fall back to `undefined`', () => {
    const found = props('exit')
    expect(found.length, 'no `exit=` prop found in primitives.tsx at all — did it move or get renamed?')
      .toBeGreaterThan(0)
    for (const p of found) {
      expect(p, `an \`exit\` prop has no \`still\` guard: exit={${p}}`).toMatch(/still/)
      expect(p, `an \`exit\` prop is guarded but does not fall back to \`undefined\`: exit={${p}}`)
        .toMatch(/undefined/)
    }
  })

  test('a sheet drag is disabled rather than merely un-animated when still', () => {
    // `drag='y'` is itself a transform the moment a gesture starts — a drag
    // enabled under `useStill()` would let a phone with reduced motion pull a
    // sheet to `y: 40%` and leave it there, since the spring that would carry
    // it the rest of the way or back never runs either.
    expect(src, 'the sheet\'s `drag` prop lost its `still` guard').toMatch(/drag=\{still \? false : /)
  })
})
