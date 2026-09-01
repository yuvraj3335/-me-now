/**
 * Work is one tree, and the pane is addressed by the URL.
 *
 * Two failures live here, and they are the same failure at two altitudes.
 *
 * The first is structural: this page used to early-return a differently-shaped
 * subtree when it had nothing on it, so React — which reconciles positionally —
 * unmounted and remounted the header, the pane, the recorder and all three
 * sheets the instant that condition flipped. Saving the first task flipped it,
 * mid-save, with the sheet still open. Nothing about that is observable from a
 * DOM this suite does not have, and all of it is observable in the source: the
 * bug WAS a branch, so the assertion is that the branch is gone.
 *
 * The second is the key the pane is opened by, which is real parsing over a
 * string a person can type. That half is pinned by running it.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { paneKey, paneRef } from '../src/web/pages/Work'

const work = readFileSync('src/web/pages/Work.tsx', 'utf8')
const sheet = readFileSync('src/web/components/TaskSheet.tsx', 'utf8')

/**
 * Source with every comment removed.
 *
 * A source-reading helper, for the reason that half of what this
 * file asserts is "the product no longer says X", and both of these files
 * explain at length what X was and why it went. A note about history is not a
 * label, and an assertion that cannot tell them apart bans the explanation
 * along with the thing.
 */
const speech = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

/** The body of `Work()`, which is the function the one-tree rule is about. */
const body = work.slice(work.indexOf('export function Work()'), work.indexOf('/** An eyebrow and rows'))

describe('the address bar says what the pane is standing on', () => {
  test('a key round-trips through both halves', () => {
    expect(paneRef(paneKey('task', 'abc'))).toEqual({ kind: 'task', id: 'abc' })
    expect(paneRef(paneKey('goal', 'abc'))).toEqual({ kind: 'goal', id: 'abc' })
  })

  test('an id keeps every colon after the first', () => {
    // The prefix is the part before the FIRST colon, not a fixed five
    // characters — a `slice(5)` is the parse that silently survives a rename.
    expect(paneRef('task:a:b')).toEqual({ kind: 'task', id: 'a:b' })
  })

  test('anything it does not recognise is nothing at all', () => {
    // The parameter is user-editable and a stale link outlives the row it
    // names, so junk arrives in the normal course of things. None of it may
    // become a lookup against an empty id.
    for (const junk of [null, '', 'task', 'task:', ':abc', 'card:abc', 'TASK:abc', ':']) {
      expect(paneRef(junk), `${JSON.stringify(junk)} resolved to a row`).toBeNull()
    }
  })

  test('the page reads the key through the parser rather than by hand', () => {
    expect(body, 'the pane went back to slicing the prefix by length')
      .not.toMatch(/openKey[?.]*\.slice\(\d/)
    expect(body, 'the pane stopped parsing its own key').toContain('paneRef(openKey)')
  })
})

describe('emptiness changes what is in a slot, never which slots exist', () => {
  test('nothing in the page body returns early', () => {
    // Every `return` inside `Work()` other than the one at the end is a second
    // shape for React to reconcile against the first. There is exactly one.
    const returns = body.match(/^\s{2}return /gm) ?? []
    expect(returns.length, 'Work() grew a second root').toBe(1)
    expect(body, 'the first-load branch came back').not.toMatch(/if \(!state\) return/)
    expect(body, 'the empty-page branch came back')
      .not.toMatch(/if \(!tasks\.length/)
  })

  test('the pane column and the sheets are rendered unconditionally', () => {
    // One `<aside>`, one of each sheet, none of them inside a branch — this is
    // what makes "he closed the task and the pane went with it" impossible.
    expect((body.match(/<aside/g) ?? []).length, 'the pane column is conditional now').toBe(1)
    expect((body.match(/<TaskSheet/g) ?? []).length).toBe(2)
    expect((body.match(/<GoalSheet/g) ?? []).length).toBe(1)
    // And the read sheet, which is what a tap on a title opens on a phone.
    expect((body.match(/<TaskRead/g) ?? []).length, 'the phone read sheet is conditional').toBe(1)
    expect((body.match(/<RailSheet/g) ?? []).length, 'the rail sheet is conditional').toBe(1)
  })

  test('an unread list is not an empty one', () => {
    // Without this the page says "nothing here yet, add one" for the length of
    // the first fetch, on every load.
    expect(body, 'the page stopped distinguishing not-read-yet from empty')
      .toMatch(/const loaded = !!state/)
    expect(body, 'the empty state paints before the first read lands')
      .toMatch(/\{loaded && !tasks\.length/)
  })

  test('the empty state is a line and a button, not a bare word', () => {
    const blank = work.slice(work.indexOf('function Blank('))
    expect(blank.slice(0, 900), 'the empty state lost its call to action')
      .toMatch(/Add a task/)
    // And it does not spend the accent: the page's own `+ Task` is a primary
    // forty pixels above it, and one surface spends the accent once.
    expect(blank.slice(0, 900), 'a second amber fill landed on one surface')
      .not.toMatch(/variant="primary"/)
  })
})

describe('the list is grouped, and the finished half is folded away', () => {
  test('the live sections are three, in the order a phone reads them', () => {
    // In progress first because it is what he is holding; Not started last
    // because it is the biggest and the least urgent. The headings are the
    // shared labels rather than strings of this page's own, so a rename lands
    // on the desk and the list at once.
    expect(work, 'the live sections were reordered or renamed')
      .toMatch(/const LIVE_GROUPS = \['in_progress', 'in_review', 'not_started'\]/)
    expect(work, 'a section heading went back to a literal of its own')
      .toMatch(/<Group key=\{status\} label=\{STATUS_LABEL\[status\]\}>/)
    expect(body, 'an empty section started rendering its own heading')
      .toMatch(/rows\.length === 0 \? null/)
  })

  test('Done and Won\'t do are counted, folded and paged separately', () => {
    const settled = work.slice(work.indexOf('function Settled('))
    expect(settled.slice(0, 1200), 'the fold lost its Show control').toMatch(/'Hide' : 'Show'/)
    expect(settled.slice(0, 1200), 'an empty settled list started drawing a heading')
      .toMatch(/if \(!rows\.length\) return null/)
    // The count is on the heading, so a fold never hides how much is behind it.
    expect(body, 'the Done heading lost its count')
      .toMatch(/\$\{STATUS_LABEL\.done\} — \$\{done\.length\}/)
    expect(body, "the Won't do list is gone, or lost its count")
      .toMatch(/\$\{STATUS_LABEL\.wont_do\} — \$\{dropped\.length\}/)
    // One page parameter each: `Show`ing the second list would otherwise land
    // it on whatever page the first was left at.
    expect(body).toMatch(/setParam\('page'/)
    expect(body).toMatch(/setParam\('wpage'/)
  })

  test('the glyph is the same picker every other surface uses', () => {
    /*
     * REPLACES 'the glyph is a switch, not a five-way cycle'.
     *
     * The old test pinned a two-state toggle and a `beforeDone` map, on the
     * reasoning that a five-step **cycle** puts the fourth state four presses
     * away and makes every mis-tap something to undo. That reasoning is sound
     * and it is not an argument against a picker: the picker shows the five at
     * once, so no state is further away than any other, and the value is seen
     * before it is written rather than after.
     *
     * What the toggle actually cost is why it is gone — one glyph with two
     * behaviours depending which page it was drawn on. The identical chip on the
     * desk opened a picker; here it silently sent `In review` to `Done`.
     *
     * The quick path the old comment was defending is still one motion. It is
     * the swipe drawer's `Done`, asserted below.
     */
    const row = work.slice(work.indexOf('function TaskRow('), work.indexOf('function GoalList('))
    expect(row, 'the task row went back to its own status control')
      .toMatch(/<StatusPicker\s+value=\{task\.status\}/)
    // The declaration and the prop, not the word: the note beside
    // `setTaskStatus` quotes the old comment in full so the reasoning it
    // carried is answered rather than deleted, and prose about history is not
    // a control coming back.
    expect(work, 'the tap-to-toggle came back')
      .not.toMatch(/const toggleDone =|onToggle[=:]/)
    expect(work, 'the tick is remembering a previous status again')
      .not.toMatch(/beforeDone\.(set|get)\(/)

    // One motion for the common case, which is what the toggle was for.
    expect(row, 'the one-gesture Done went missing with the toggle')
      .toMatch(/onDone=\{/)
  })

  test('a row is a status, a title and its meta', () => {
    const row = work.slice(work.indexOf('function TaskRow('), work.indexOf('function GoalList('))
    // The chip is inside `StatusPicker` now rather than painted by this row.
    // What is pinned is that the row draws exactly one status control and does
    // not grow a second one of its own beside it.
    expect(row, 'the row paints a status of its own again').not.toContain('<StatusChip')
    expect(row, 'the row stopped showing a status at all').toContain('<StatusPicker')
    expect(row, 'a terminal came back onto every row in the list')
      .not.toContain('SquareTerminal')
  })

  test('the last row clears the tab bar', () => {
    // `--nav-h` is the strip the phone's tab bar owns. Without the reserve the
    // final row of the list sits under it: unreadable, and unswipeable.
    expect(body, 'the page stopped reserving the tab bar').toMatch(/pb-\[var\(--nav-h\)\]/)
  })
})

describe('the pane holds its frame rather than blinking out', () => {
  test('a row that leaves the store does not blank the column', () => {
    expect(body, 'the pane stopped holding the last row it resolved')
      .toMatch(/const lastPane = useRef/)
    expect(body, 'the pane went back to substituting whatever row is nearest')
      .not.toMatch(/paneTask = openTask \?\? tasks\[0\]/)
  })

  test('and it says so instead of pretending it is still live', () => {
    const detail = work.slice(work.indexOf('function TaskDetail('))
    expect(detail.slice(0, 4000), 'a held frame still offers controls that write to a dead id')
      .toContain('gone ? (')
  })

  test('the pane closes on its own cross', () => {
    expect(work, 'the pane lost its close control').toMatch(/const closePane = \(\) => setParam\('open', null\)/)
    expect(work, 'the close cross is not wired to anything').toMatch(/onClose=\{closePane\}/)
  })
})

describe('the sheet reaches the store rather than a snapshot of it', () => {
  test('the edit sheet is addressed by id', () => {
    // `task={editing}` was a frozen object: `reload()` replaces every task in
    // the store and nothing re-pointed it, so a note added inside an open sheet
    // did not appear until the sheet was closed and opened again.
    expect(body, 'the sheet went back to holding a snapshot')
      .toMatch(/const \[editingId, setEditingId\] = useState<string \| null>\(null\)/)
    expect(body, 'the open task stopped being resolved against the store')
      .toMatch(/tasks\.find\(t => t\.id === editingId\)/)
  })
})

describe('a time is picked on a calendar', () => {
  test('both fields on the task sheet are the picker', () => {
    // Five chips — three of which were rendered with no `active` at all, so
    // picking one left every one of them unpressed.
    expect((sheet.match(/<DateTimePicker/g) ?? []).length, 'a time field lost its calendar').toBe(1)
    expect((sheet.match(/<TimeField/g) ?? []).length, 'a time field stopped using the shared one').toBe(2)
    expect(speech(sheet), 'the preset ladder came back').not.toMatch(/Tomorrow 9am/)
    expect(speech(sheet), 'the native field came back as the escape hatch')
      .not.toMatch(/type="datetime-local"/)
  })

  test('a field with nothing set still answers its own question', () => {
    expect(sheet, 'an unset deadline went back to saying nothing').toContain("'No deadline'")
    expect(sheet, 'an unset reminder went back to saying nothing').toContain("'No reminder'")
  })

  test('the repeat rule survived', () => {
    for (const word of ['Once', 'Daily', 'Weekdays', 'Weekly']) {
      expect(sheet, `the reminder lost ${word}`).toContain(`'${word}'`)
    }
  })

  test("and the goal's target date is a calendar too", () => {
    const goalSheet = work.slice(work.indexOf('function GoalSheet('))
    expect(speech(goalSheet), 'the target date went back to a bare native input')
      .not.toMatch(/type="date"/)
    expect(goalSheet, 'the target date lost its picker').toContain('<DateTimePicker')
  })
})

describe('the primary commit is in the pinned footer, not the scrolled body', () => {
  test('both sheets on this page pass one', () => {
    // With the iOS keyboard up, a commit inside the scroller is below the fold
    // with nothing obvious to scroll.
    expect(sheet, 'the task sheet dropped its footer').toMatch(/footer=\{/)
    expect(sheet.slice(sheet.indexOf('footer={'), sheet.indexOf('</Sheet>')))
      .toContain('variant="primary"')
    const goalSheet = work.slice(work.indexOf('function GoalSheet('))
    expect(goalSheet, 'the goal sheet dropped its footer').toMatch(/footer=\{/)
  })
})

describe('Tasks and Goals is a control, not two words', () => {
  test('the page reaches for the segmented primitive', () => {
    expect(body, 'the pill pair went back to two bare buttons').toContain('<Segmented<Tab>')
    expect(body, 'the tab lives somewhere other than the URL')
      .toMatch(/setParam\('tab'/)
  })
})
