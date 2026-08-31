/**
 * The phone desk: failures that only exist on a real device.
 *
 * Every one of these was measured on the deployed site — the first three at
 * 390px, the last four at 375px — and none of them reproduces in a resized
 * desktop window, which is what makes them worth pinning here rather than
 * trusting to a screenshot pass. A laptop has a trackpad, and a trackpad
 * reaches the swipe layer through `wheel` rather than through a pointer, so the
 * horizontal scroll appeared to work; a laptop has no coarse pointer, so half
 * the stylesheet that runs on a phone never loaded; and a laptop is wide enough
 * for the detail pane, so the phone's own detail surface was never on screen at
 * all.
 *
 * **The table's own contracts moved up a band rather than being deleted.** A
 * phone is under `COLUMNS_MIN` now and gets row-cards, and everything from 800
 * to 1024 — a narrow laptop window, a tablet, a phone turned sideways — still
 * gets `PhoneTable` and still has to obey every rule below about reaching its
 * columns. What is pinned there is unchanged; what it is pinned *for* is a
 * viewport where four columns actually fit rather than one where they cannot.
 *
 * That band used to start at 640 and the difference was not cosmetic. The table
 * needs 552 and the shell keeps 248 of every viewport for the rail and the page
 * pad, so 640 through 799 was handed a table wider than the column holding it —
 * 160px over at the bottom of the band, 32 over on an iPad held upright. The
 * boundary is arithmetic now rather than a borrowed Tailwind breakpoint, and
 * the test below reads it out of the source rather than restating it.
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
    // A `<Select>` until this pass, and the control changed rather than left —
    // see `a status is a colour before it is a word` below for what a closed
    // one now has to draw.
    expect(line, 'the row lost its own status control').toContain('<StatusPicker')
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

/**
 * The three things a screenshot of the deployed desk at 375px showed, and what
 * each one now has to be.
 *
 * All three are the same failure in different clothes: a control that is on the
 * screen and says nothing until it is operated. A status that is a grey box
 * with a word in it, a filter that says `Any date`, and four columns that have
 * to be scrolled to before they can be read.
 */
describe('a status is a colour before it is a word', () => {
  /*
   * Twenty rows of identical grey `<select>`s reading `Not started`, `Not
   * started`, `In progress`. The word was there and the state was not: the ring
   * and the hue this product says a status with everywhere else stopped at the
   * edge of the control, so the one column a person taps to see where things
   * stand answered only by being read, row by row, in 13px type.
   */
  const picker = bodyOf(table, 'StatusPicker')

  test('the closed control is the chip, not a box with a word in it', () => {
    expect(picker, 'the closed status control stopped drawing the chip')
      .toContain('<StatusChip status={value} />')
    // Every surface that shows a card's status shows this one. A second closed
    // status control is how the desk and the pane come to disagree about what
    // `In review` looks like.
    for (const row of ['CardRow', 'CardLine', 'RowCard']) {
      expect(bodyOf(table, row), `${row} lost the status control`).toContain('<StatusPicker')
    }
    expect(read('src/web/components/CardDetail.tsx'), 'the pane kept a control of its own')
      .toContain('<StatusPicker')
    expect(code(table), 'a card status went back to a native select').not.toContain('<Select')
  })

  test('the five options are coloured too, and each of them is a thumb wide', () => {
    // The same failure one press deeper. The colour is how you aim at `In
    // review` without reading four labels first, and a picker of plain words
    // hands the whole vocabulary back at the moment it is being used.
    expect(picker, 'the options went back to plain words')
      .toContain('<StatusChip status={s} size="md" />')
    expect(picker, 'an option is smaller than a thumb').toContain('min-h-11')
    expect(picker, 'the picker stopped offering exactly the shared five')
      .toContain('STATUS_ORDER.map')
    // And the tick stays: five chips all wearing their own colour do not say
    // which one the card is currently on.
    expect(picker, 'the picker stopped saying which status is set').toContain('aria-selected')
  })

  test('it keeps no colour table of its own', () => {
    // `status.tsx` is the only file allowed to map the five. `Work.tsx` kept a
    // private set of circles and drifted three states behind the desk; a picker
    // is exactly where that would happen next.
    expect(code(table), 'the picker grew its own hues').not.toMatch(/--color-status-/)
  })

  test('it is a real control on a laptop, and the desk cannot act through it', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab']) {
      expect(picker, `the picker does not answer ${key}`).toContain(`'${key}'`)
    }
    /*
     * Capture, and it stops there. The desk binds `j`, `k`, `Enter`, `Escape`
     * and `e` to `document`, and `e` finishes a card with no confirmation — a
     * picker that let those through would settle the row the cursor happens to
     * be on while somebody was choosing a status for a different one.
     */
    expect(picker, 'the picker stopped taking the keyboard while it is open')
      .toContain("document.addEventListener('keydown', onKey, true)")
    expect(picker, 'a keystroke inside the picker still reaches the desk')
      .toContain('e.stopPropagation()')
  })

  test('and the panel cannot be clipped by the list it opens inside', () => {
    // Every caller is inside a scroll container: the phone list, the page
    // column, the detail pane's own scrolling body. An absolutely positioned
    // panel is cut off by all three.
    expect(picker, 'the panel stopped being a portal').toContain('document.body')
    expect(picker, 'the panel went back to being positioned in the flow')
      .toContain('fixed z-[55]')
  })
})

describe('the phone spends one row on filter chrome, not two', () => {
  /*
   * Measured at 375px: a full-width `Search`, and `Any date · Any priority ·
   * Any status` wrapped underneath it. Two rows — about 88px — of chrome above
   * a list, on an 812px screen. And the three closed sets on that second row
   * were telling him nothing: a closed set whose value is `Any date` is a
   * control reporting that it is not doing anything.
   */
  const row = bodyOf(home, 'FilterRow')

  test('below sm the four collapse into one control that says how many are set', () => {
    expect(row, 'the phone filter row stopped being one control').toContain('sm:hidden')
    expect(row, 'the button stopped counting what is set')
      .toContain('<CountBadge count={count} />')
    expect(home, 'the count went back to being a yes-or-no')
      .toMatch(/const filterCount = /)
  })

  test('and the four are moved rather than dropped', () => {
    expect(row, 'the filters stopped being reachable at all on a phone').toContain('<Sheet')
    expect(row, 'the sheet lost the search field').toContain('<Field label="Search">')
    expect(row, 'the closed sets went into the sheet unlabelled')
      .toContain('<Field key={label} label={label}>')
    // One set of controls in two arrangements. Two copies of these option lists
    // is how the sheet and the row come to offer different answers.
    expect((row.match(/<Select\b/g) ?? []).length, 'the sheet built its own copy of the sets')
      .toBe(3)
  })

  test('the laptop row is exactly the row it was', () => {
    expect(row, 'the laptop lost the filter row it had no problem with')
      .toContain('hidden sm:flex flex-wrap items-center gap-2 py-2')
    expect(row, 'the laptop search field changed size').toContain('h-8 py-0 w-full sm:w-64')
  })

  test('opening it does not raise the keyboard', () => {
    // The sheet's first field is a search box. Focused on open it covers the
    // three controls under it before they have been seen, for a reader who came
    // here to press `Overdue`.
    expect(code(home), 'a field on the desk grabs focus by itself').not.toContain('autoFocus')
    expect(code(table), 'a cell on the desk grabs focus by itself').not.toContain('autoFocus')
    // And the due cell still has a way out, now that a blur it never receives
    // is not the thing closing it.
    expect(bodyOf(table, 'DueCell'), 'the date editor can no longer be dismissed')
      .toContain("document.addEventListener('pointerdown', away, true)")
  })

  test('the commit strip sits above the bar and above the keyboard', () => {
    // `Sheet`'s footer is a flex sibling of the scrollport and the panel
    // carries `pad-bottom`, so the tab bar and the home indicator are handled.
    // iOS does not shrink the layout viewport for the keyboard, so nothing in
    // CSS can answer that half — the visual viewport is the only thing that
    // knows, and the gap between the two is what the footer pads by.
    expect(row, 'the footer went back inside the scrolling body').toMatch(/footer=\{/)
    expect(row, 'the commit strip stopped measuring the keyboard')
      .toContain('paddingBottom: keyboard')
    expect(home, 'nothing measures the visual viewport any more')
      .toContain('window.visualViewport')
  })
})

describe('below sm a row is a card, and nothing scrolls sideways', () => {
  /*
   * The table shipped at 375px with `Title · Status · Where · Due` in a
   * scroller of its own: 552px of columns inside a 343px page column, so `WHO`
   * was cut off mid-word at the fold before any finger moved. Every argument
   * for those columns is still true and every one of them was reachable only by
   * knowing that the table moves. A column that has to be discovered is not a
   * column.
   */
  const card = bodyOf(table, 'RowCard')

  test('the desk changes layout where the columns stop fitting', () => {
    // Pinned as the arithmetic, not as a literal. The literal is what broke:
    // 640 was written against the viewport while the table is only ever given
    // the page column, so the band it opened — 640 to 799, an iPad upright
    // among them — got the sideways table this describe block exists to have
    // removed. A threshold derived from the widths it is a threshold *for*
    // cannot drift away from them again.
    expect(table, 'the phone boundary went back to a hand-written number')
      .toMatch(/export const COLUMNS_MIN = PHONE_MIN \+ SHELL_FIXED/)

    // And the arithmetic itself, read out of the source the same way the rest
    // of this file reads it, so the widths cannot quietly stop adding up.
    const num = (re: RegExp) => Number(table.match(re)![1])
    const phoneMin =
      num(/PHONE_TITLE_MIN = (\d+)/) + num(/PHONE_W = \{ status: (\d+)/)
      + num(/PHONE_W = \{ status: \d+, where: (\d+)/) + num(/PHONE_W = \{ status: \d+, where: \d+, due: (\d+)/)
    const shell = table.match(/SHELL_FIXED = (\d+) \+ (\d+)/)!
    const columnsMin = phoneMin + Number(shell[1]) + Number(shell[2])
    expect(phoneMin, 'the phone table changed width').toBe(552)
    expect(columnsMin, 'the columns stop fitting somewhere new').toBe(800)
    // The band that shipped broken: a page column narrower than the table.
    expect(768 - Number(shell[1]) - Number(shell[2]))
      .toBeLessThan(phoneMin)
    expect(home, 'the desk stopped choosing a layout for the phone')
      .toContain('const hasColumns = width >= COLUMNS_MIN')
    expect(home, 'the phone went back to the sideways table').toContain('<CardList')
    // And the table it replaces is still what everything above 640 gets.
    expect(home, 'the narrow-window table was deleted with the phone one')
      .toContain('<PhoneTable')
  })

  test('the card carries the four facts the table was drawn for', () => {
    expect(card, 'the title left the row').toContain('{name}')
    expect(card, 'the status left the row').toContain('<StatusPicker')
    expect(card, 'the customer left the row').toContain('{where}')
    expect(card, 'the deadline left the row').toContain("{words ?? '—'}")
  })

  test('and it has no scroller of any kind', () => {
    // This is the honest half of `a page never scrolls sideways`: the page
    // column clips, and this no longer asks it for an exception.
    expect(bodyOf(table, 'CardList'), 'the phone list grew a horizontal scroller')
      .not.toMatch(/overflow-x/)
    expect(card, 'a row grew a scroller of its own').not.toMatch(/overflow-x/)
    // So it needs none of the axis handover the table needs: with nothing
    // competing for the horizontal, the row keeps it and the drawer works from
    // the first pixel.
    expect(card, 'the row-card yields the axis to a table it is not in')
      .not.toContain("'manipulation'")
  })

  test('a row can still be acted on, held, and pointed at', () => {
    expect(card, 'the row lost the drawer').toContain('<SwipeDrawer')
    expect(card, 'the row lost the long press').toContain('useLongPress')
    expect(card, 'a tap stopped opening the card').toContain('actions.onOpen(card)')
    // Selected, focused and unseen from the one function every list uses. A
    // phone has no hover, so a row that says which one it is only on hover says
    // nothing at all.
    expect(card, 'the row stopped saying which one is selected').toContain('rowStateClass(')
  })

  test('the last row clears the tab bar', () => {
    // `pb-24` was 96px against a bar that is 53 plus whatever the device puts
    // under it — a guess that is 43px too much on one phone and not enough on
    // another. `--nav-h` is the strip the bar actually owns, measured once.
    expect(home, 'the list went back to guessing at the height of the bar')
      .toContain("paddingBottom: 'calc(var(--nav-h) + 24px)'")
    // Stripped of prose first: the page explains in a comment what the guess
    // used to be, and a note about history is not a class name.
    expect(code(home), 'a fixed pad came back under the list').not.toMatch(/pb-24/)
  })
})

describe('the phone detail is a page', () => {
  /* The component's own body, not everything after it. Sliced to the end of the
     file, this read the whole rest of `Home.tsx` — so a paragraph about
     viewport units in a component two hundred lines further down failed the
     assertion that *this* surface is not a fraction of the viewport. */
  const page = bodyOf(home, 'DetailPage')

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
