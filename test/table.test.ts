/**
 * The desk is four columns, and the pane can never take the fourth one away.
 *
 * Two different failures, pinned together because they are the same rule seen
 * from both ends. The column count is a design decision that a plausible edit —
 * "just add a Why column back, there's room" — undoes in one line; the clamp is
 * arithmetic that a plausible edit undoes silently, because a pane dragged too
 * wide does not error, it just squeezes the title column into an ellipsis.
 *
 * The first two read the source rather than a DOM, for the same reason the rest
 * of this suite does: there is no layout engine here, and the invariant is about
 * what the component declares, not about what a browser makes of it.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { maxPaneFor, TITLE_MIN, W } from '../src/web/components/CardTable'
import { dueWords } from '../src/web/lib/typography'

const table = readFileSync('src/web/components/CardTable.tsx', 'utf8')

/** The body of one exported component, so a `<th>` in a comment is not counted. */
const bodyOf = (name: string) => {
  const at = table.indexOf(`export function ${name}(`)
  if (at === -1) throw new Error(`CardTable.tsx no longer exports ${name}`)
  const next = table.indexOf('\nexport ', at + 1)
  return table.slice(at, next === -1 ? undefined : next)
}

describe('four columns, and only four', () => {
  test('the header declares Title, Status, Kind, Due', () => {
    const head = bodyOf('TableHead')
    expect((head.match(/<th\b/g) ?? []).length, 'the header grew or lost a column').toBe(4)
    for (const word of ['Title', 'Status', 'Kind', 'Due']) {
      expect(head, `the ${word} heading is gone`).toContain(`>${word}<`)
    }
    // The seven-column version's headings, by name. Every one of these is a
    // fact about a card nobody has opened yet, paid for on all twenty rows.
    for (const gone of ['Why', 'Where', 'When']) {
      expect(head, `${gone} came back as a column`).not.toContain(`>${gone}<`)
    }
  })

  test('the colgroup matches the header', () => {
    // A colgroup and a header that disagree is the one way `table-fixed` stops
    // holding an x-position down the page, and it looks like nothing until a
    // long title lands on row nine.
    expect((bodyOf('TableCols').match(/<col\b/g) ?? []).length).toBe(4)
  })

  test('exactly one column is elastic', () => {
    // Title is the unsized `<col>`; under `table-fixed` the one column with no
    // width absorbs everything the others leave. Two unsized columns share it,
    // which puts Title's right edge somewhere different on every viewport.
    const cols = bodyOf('TableCols')
    expect((cols.match(/<col \/>/g) ?? []).length, 'Title stopped being the only elastic column').toBe(1)
  })
})

describe('the pane can never squeeze the title out', () => {
  test('the clamp leaves Title its floor at every laptop width', () => {
    const fixed = W.status + W.kind + W.due
    const RAIL_AND_PAD = 248

    for (const width of [1280, 1440, 1536, 1920]) {
      for (const wanted of [320, 500, 720, 2000]) {
        // The same expression `Home.tsx` applies, and it has to be: a clamp
        // written twice is a clamp that disagrees with itself at one width.
        const pane = Math.min(Math.max(wanted, 320), Math.min(720, maxPaneFor(width)))
        const title = width - RAIL_AND_PAD - pane - fixed
        expect(title, `Title collapsed to ${title}px at ${width} with a ${wanted}px pane`)
          .toBeGreaterThanOrEqual(TITLE_MIN)
        expect(pane, 'the pane went below the width a detail can be read at')
          .toBeGreaterThanOrEqual(320)
      }
    }
  })

  test('a viewport too narrow for everything still opens a readable pane', () => {
    // The floor wins over the arithmetic on purpose. A 1024px laptop cannot
    // satisfy both, and the answer is a pane you can read rather than a pane
    // 40px wide that technically preserves a column.
    expect(maxPaneFor(1024)).toBe(320)
  })
})

describe('a due date is said in the fewest words that still commit', () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0).getTime()

  test('no date renders nothing at all', () => {
    expect(dueWords(null)).toBeNull()
  })

  test('a date that has passed leads with how long ago', () => {
    const now = at(2026, 9, 10)
    expect(dueWords(at(2026, 9, 8), now)).toBe('Overdue 2d')
    // Less than a day late is still late, and `Overdue 0d` reads as not late.
    expect(dueWords(now - 3.6e6, now)).toBe('Overdue')
  })

  test('today keeps the time and drops the date', () => {
    const now = at(2026, 9, 10, 9)
    expect(dueWords(at(2026, 9, 10, 18), now)).toBe('Today 18:00')
  })

  test('anything further out is a date with no time on it', () => {
    // 96px of column. `Sep 12` scans; `Sep 12, 6:00 pm` is read.
    const words = dueWords(at(2026, 9, 12, 18), at(2026, 9, 10))!
    expect(words).toMatch(/12/)
    expect(words, 'the table cell grew a clock').not.toMatch(/:/)
  })
})
