/**
 * The phone desk: three failures that only exist on a real device.
 *
 * Every one of these was measured on the deployed site at 390px and none of
 * them reproduces in a resized desktop window, which is what makes them worth
 * pinning here rather than trusting to a screenshot pass. A laptop has a
 * trackpad, and a trackpad reaches the swipe layer through `wheel` rather than
 * through a pointer, so the horizontal scroll appeared to work; a laptop has no
 * coarse pointer, so half the stylesheet that runs on a phone never loaded; and
 * a laptop is wide enough for the detail pane, so the phone's own detail
 * surface was never on screen at all.
 *
 * These read the source rather than a DOM, like the rest of the suite: there is
 * no layout engine here, and what is being pinned is what the components and
 * the stylesheet *declare*.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (f: string) => readFileSync(f, 'utf8')

const table = read('src/web/components/CardTable.tsx')
const swipe = read('src/web/components/swipe.tsx')
const css = read('src/web/styles.css')
const home = read('src/web/pages/Home.tsx')
const detail = read('src/web/components/CardDetail.tsx')
const primitives = read('src/web/components/primitives.tsx')

/**
 * The same source with its prose taken out.
 *
 * Two of these tests are about what a component *renders*, and this file's own
 * house style argues at length, in comments, about the thing that was removed —
 * so a plain `not.toContain` on the file would fail on the paragraph explaining
 * why the string is gone. Comments are evidence; they are not output.
 */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** One component's body, so a `<td>` quoted in a comment is not counted. */
const bodyOf = (src: string, name: string) => {
  const at = src.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`${name} is gone`)
  const next = src.indexOf('\nfunction ', at + 1)
  const nextExport = src.indexOf('\nexport function ', at + 1)
  const ends = [next, nextExport].filter(n => n !== -1)
  return src.slice(at, ends.length ? Math.min(...ends) : undefined)
}

describe('a phone can reach every column of its own table', () => {
  test('the whole phone row hands the browser both axes', () => {
    /*
     * `pan-y` gives the browser the vertical axis and the app the horizontal
     * one. On a row whose table is 540px wide inside 358px of screen that is
     * the table's axis being spent on a drawer: measured on the live site, the
     * scroller was scrollable (clientWidth 358, scrollWidth 540, nothing
     * clipping it) and the pinned Title cell — widest, always on screen, where
     * a thumb lands — computed `touch-action: pan-y`.
     */
    expect(table, 'the phone row went back to keeping the horizontal axis')
      .toContain("useSwipe(card.group_key, 3, 'manipulation')")
    expect(css, 'the row policy that yields both axes is gone')
      .toMatch(/\[data-swipe='manipulation'\],\s*\n\s*\[data-swipe='manipulation'\] > td \{ touch-action: manipulation; \}/)
    // And no cell re-declares one. The per-cell split — Title for the drawer,
    // the rest for the table — is precisely what failed, because a thumb does
    // not aim at the column whose gesture it wants.
    expect(table, 'a phone cell states its own touch policy again')
      .not.toContain('touchAction')
  })

  test('a finger is the table\'s until the table runs out, and the drawer\'s after', () => {
    /*
     * Reported from a real phone: with the axis given to the table outright,
     * `Done · Status · Delete` could not be reached at all — a row could only be
     * acted on by opening it first, which on a phone is the most expensive thing
     * on the screen.
     *
     * The two are not simultaneous. While there is table to the right a drag
     * means "show me the rest"; at the end of the scroll it cannot mean that, so
     * it is free to mean the drawer. `data-atend` is the handover, and it is
     * declared in both places at once — the stylesheet, because `touch-action`
     * is read by the compositor when the gesture starts, and the pointer path,
     * because a decision made only in CSS leaves the handler still running.
     */
    expect(css, 'the axis stopped coming back at the end of the scroll')
      .toMatch(/\[data-atend\] \[data-swipe='manipulation'\],\s*\n\s*\[data-atend\] \[data-swipe='manipulation'\] > td \{ touch-action: pan-y; \}/)
    expect(swipe, 'the swipe layer went back to refusing every touch')
      .not.toMatch(/const takesTouch = touch !== 'manipulation'/)
    expect(swipe, 'the pointer path stopped asking where the scroller stands')
      .toContain("scroller.hasAttribute('data-atend')")
    expect(swipe, 'the decline stopped being conditional')
      .toContain("if (e.pointerType === 'touch' && !touchIsOurs(e.target)) return")
    expect(table, 'the phone scroller stopped saying when it is out of travel')
      .toContain("data-atend={scroller.spill ? undefined : ''}")
    expect(table, 'the scroller is no longer findable from the row')
      .toContain('data-hscroll=""')
  })

  test('nothing else gives its axis away', () => {
    // The trade is bounded: a list that does not scroll sideways has no second
    // claim on the axis, so its rows keep the drawer under a finger. Work's
    // tasks are the one row that asks for `none`, and framer is why.
    expect(css, 'the ordinary swipe row lost its policy')
      .toMatch(/\[data-swipe='pan-y'\] > td \{ touch-action: pan-y; \}/)
    expect(read('src/web/pages/Work.tsx'), 'a task row started yielding to a table it is not in')
      .not.toContain("'manipulation'")
    expect(bodyOf(table, 'CardRow'), 'the laptop row gave its axis away too')
      .not.toContain("'manipulation'")
  })

  test('the row keeps every other way in', () => {
    // Every way in survives the axis being lent to the table for the first part
    // of the gesture: a tap opens the card, a long press peeks it, `Done` is one
    // control away in the row's own Status column, and the drawer itself is
    // reached by swiping on past the end of the scroll.
    const line = bodyOf(table, 'CardLine')
    expect(line, 'tap-to-open is gone from the phone row').toContain('actions.onOpen(card)')
    expect(line, 'long-press-to-peek is gone from the phone row').toContain('useLongPress')
    expect(line, 'the row lost its own status control').toContain('<Select')
    // And the drawer itself stays, for the mouse and the trackpad on the narrow
    // laptop that renders this same table.
    expect(line, 'the drawer was deleted rather than yielded').toContain('<SwipeDrawer')
  })
})

describe('nothing is pinned, so every column moves under a thumb', () => {
  test('the Title column scrolls with the rest of the table', () => {
    /*
     * Reported from a real phone, and visible in the screenshot: only the other
     * columns moved. Title was `sticky left-0`, so the one column a thumb
     * actually lands on was the one that would not travel — and `Select` is
     * `relative`, so the Status picker slid *underneath* the pinned cell and
     * left a status column that was nothing but a chevron.
     *
     * What the pinning protected against is real — scroll to the far right and
     * the row has no name on screen — and it is the smaller problem, undone by
     * the same finger that caused it.
     */
    // Stripped of comments first: this file explains at length why the pinning
    // went, and a grep over the prose finds the very string it is arguing about.
    expect(code(bodyOf(table, 'PhoneHead')), 'the phone heading pinned a column again')
      .not.toContain('sticky left-0')
    expect(code(bodyOf(table, 'CardLine')), 'the Title cell pinned itself again')
      .not.toContain('sticky left-0')
    // The drawer's anchor is the exception and stays: it is a 0px hook, not a
    // column, and covering the row is the whole of its job.
    expect(code(bodyOf(table, 'CardLine')), 'the drawer lost the cell it hangs off')
      .toContain('sticky right-0')
  })

  test('the edge that marked the pinning went with it', () => {
    expect(table, 'the unconditional 1px rule came back')
      .not.toContain('shadow-[1px_0_0_0_var(--color-rule)]')
    expect(css, 'the pinned-column edge outlived the pinned column')
      .not.toContain('.pin-edge {')
    expect(code(table), 'a cell still asks to be edged as a pinned column')
      .not.toContain('pin-edge')
    // And the opaque ground the pinning needed, so the columns could pass
    // beneath it, has nothing left to hide from.
    expect(code(table), 'the Title cell is still painted opaque for a scroll that no longer passes under it')
      .not.toContain('groundOf')
  })
})

describe('the phone detail is a page', () => {
  const page = home.slice(home.indexOf('function DetailPage('))

  test('it fills the screen the shell allows it', () => {
    // 55dvh of an 844px phone is a title, three controls, a fact grid, a
    // conversation and four buttons read through a ~460px slot.
    expect(page, 'the phone detail went back to a fraction of the viewport')
      .not.toMatch(/\d+dvh/)
    expect(page, 'the phone detail stopped starting at the top of the screen')
      .toMatch(/top-0/)
    expect(page, 'the phone detail starts under the notch').toContain('pad-top')
    // And it still stops at the tab bar. `styles.css` states that as a rule.
    expect(page, 'the phone detail covers the tab bar').toMatch(/bottom: 'var\(--nav-h\)'/)
  })

  test('the way back is on the screen, and it is the way back everything uses', () => {
    // The routing model already made Back work — `openDetail` pushes — but a
    // reader who does not think in browser buttons needs to see it. One
    // control, and a path that says what it returns to.
    expect(page, 'the detail page lost its path').toContain('<DetailPath')
    const path = home.slice(home.indexOf('function DetailPath('))
    expect(path, 'the back control is gone').toContain('ariaLabel="Back to the desk"')
    expect(path, 'the path stopped naming where it goes back to').toContain('Desk')
    expect(path, 'the path stopped naming the source').toContain('SOURCE_LABEL[kind.source]')
    expect(path, 'the path lost its chevrons').toContain('<ChevronRight')
    // `closeDetail`, not a local dismissal: the fragment is the open card, and
    // `closeDetail` is the one function that knows the difference between
    // "closed on purpose" and "never chose". See `lib/route.ts`.
    expect(page, 'the page dismisses itself outside the router')
      .toContain('onBack={closeDetail}')
  })

  test('there is one way out of it, and every other close still works', () => {
    // The pane's cross exists because a pane has no other exit. The page has a
    // labelled one above it, and two dismissals a few pixels apart is a
    // question a reader should not have to answer.
    expect(page, 'the page draws a second dismissal').toContain('backProvided')
    expect(detail, 'the cross stopped being conditional').toContain('{!backProvided && (')
    expect(detail, 'the cross stopped closing the detail')
      .toMatch(/onClick=\{onClose\} title="Close"/)
    // The laptop pane is unchanged and still asks for the cross by not asking.
    expect(home, 'the desk pane grew a suppressed close button')
      .toMatch(/<CardDetail card=\{shown\} onClose=\{closeDetail\} resting=\{!selected\}/)
  })
})

/**
 * The one control on this pane that starts something on the box.
 *
 * It lives here rather than with the desk's own contracts because the
 * requirement that failed twice is a phone requirement: what stood here was a
 * `claude --resume <id>` line to copy, which asks a person holding a phone to
 * go and find a terminal. A session is reachable from the browser now, so the
 * pane offers the session rather than the instructions for reaching it.
 */
describe('a session card opens the session', () => {
  test('there is no shell line left to copy, anywhere in the pane', () => {
    // Not as a fallback and not in a tooltip. A copyable command sitting under
    // a button that already works is a second, worse route with nothing to
    // recommend it — and the one a reader reaches for at 7am.
    const rendered = code(detail)
    expect(rendered, 'the resume command came back').not.toContain('resume_cmd')
    expect(rendered, 'the pane still prints a shell line').not.toContain('--resume')
    expect(rendered, 'the pane went back to putting a command on the clipboard')
      .not.toContain('clipboard')
  })

  test('the control opens the real session, by the id the card still carries', () => {
    expect(detail, 'the session id is no longer read off the card')
      .toContain("const sessionId = claude?.meta?.session_id as string | undefined")
    expect(detail, 'the pane stopped opening the session')
      .toContain('openTerminalAndGo({ sessionId })')
    // One step, not two: `lib/terminal.ts` says why a route that starts a
    // process and the navigation that shows it must not be separated.
    expect(detail, 'the pane started a session without going to it')
      .not.toMatch(/terminalApi\.open\(/)
    // And a refusal is the server's own sentence, which is what a toast wants.
    expect(detail, 'a refused session fails silently').toMatch(/\.catch\(e =>/)
  })

  test('and it is on the phone page, not only in the laptop pane', () => {
    // `CardDetail` is one component on both surfaces, so this is really a claim
    // about *where* in it the control sits: the scrolling body, which on the
    // phone is the page, rather than a hover affordance or a menu.
    const body = detail.slice(detail.indexOf('grow min-h-0 overflow-y-auto'))
    expect(body.slice(0, body.indexOf('<SeenIn')), 'the session control left the body')
      .toContain('Open session')
    expect(detail, 'the session control is not full width on a phone')
      .toMatch(/className="w-full" disabled=\{opening\}/)
  })
})
