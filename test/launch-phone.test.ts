/**
 * The composer on a phone: a field, a Send, and a way back that costs nothing.
 *
 * Two different kinds of test, because the change has two different kinds of
 * claim in it.
 *
 * The first half reads the source, like `phone-desk.test.ts` does and for the
 * same reason: there is no layout engine in this suite, and what is being
 * pinned is what the components *declare* — that below `sm` the composer stops
 * being a modal, that it stops at `--nav-h` so the six destinations stay one tap
 * away, that the first thing on it is the field and the last is the commit, and
 * that neither the template blurbs nor the skill search can come back onto the
 * first screen. Every one of those is a one-word edit away from silently
 * regressing and none of them would fail anything else.
 *
 * The second half runs the real store. "Back loses the half-written brief" is
 * the one failure this work was not allowed to have, and it is a property of
 * `lib/launch.ts` rather than of any component — so it is tested there, against
 * the three cases that have to hold at once: leaving keeps everything, coming
 * back to the same brief resumes it, and opening a different one starts clean.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  closeLaunch, launchBasket, launchDraft, openLaunch, rememberLaunch, resetLaunch,
  type PackItem,
} from '../src/web/lib/launch'

const read = (f: string) => readFileSync(f, 'utf8')

const launch = read('src/web/components/launch.tsx')
const detail = read('src/web/components/CardDetail.tsx')
const primitives = read('src/web/components/primitives.tsx')
const home = read('src/web/pages/Home.tsx')
const css = read('src/web/styles.css')

/**
 * The same source with its prose taken out.
 *
 * This file's own house style argues at length, in comments, about the shapes
 * it has just removed — so a plain `not.toContain` on the file would fail on the
 * paragraph explaining why the string is gone. Comments are evidence; they are
 * not output.
 */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

/** One named function's body, so a rule about one component is tested on it. */
const fn = (src: string, name: string) => {
  const at = src.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`launch.tsx no longer has a ${name}`)
  const next = src.indexOf('\nfunction ', at + 1)
  return src.slice(at, next === -1 ? undefined : next)
}

/**
 * The branch that paints the first screen, and only it.
 *
 * The whole point of these assertions is what is *absent* from the first paint,
 * and everything absent from it is present a few lines further down in the
 * branch that draws the rooms. Slicing at `<PanelPath` is what keeps a negative
 * from quietly testing the whole file.
 */
const composeBranch = () => {
  const src = code(launch)
  const from = src.indexOf('const body = panel === null ? (')
  const to = src.indexOf('<PanelPath', from)
  if (from === -1 || to === -1) throw new Error('the composer no longer has a first-screen branch')
  return src.slice(from, to)
}

/* --------------------------- the room it is drawn in ---------------------- */

describe('below sm the composer is a page and not a modal over the desk', () => {
  test('it is a portal that stops at the tab bar, exactly like the card detail', () => {
    // `DetailPage` in Home.tsx is the reference and the point is that this is
    // the same thing, not a second thing that looks like it: the same portal,
    // the same `pad-top` for the notch, the same stop at `--nav-h`.
    expect(home, 'the phone card detail stopped honouring --nav-h')
      .toContain("style={{ bottom: 'var(--nav-h)' }}")
    expect(code(launch), 'the phone composer no longer stops above the tab bar')
      .toContain("'var(--nav-h)'")
    expect(code(launch), 'the phone composer is drawn inside the page again')
      .toContain('createPortal(')
    expect(code(launch), 'the composer lost its safe-area top')
      .toMatch(/fixed inset-x-0 top-0 z-\[52\] pad-top/)

    // And `--nav-h` still means the tab bar below sm, which is the whole reason
    // the number is a variable.
    expect(css, '--nav-h stopped accounting for the phone tab bar')
      .toMatch(/:root \{ --nav-h: calc\(53px \+ max\(env\(safe-area-inset-bottom\), 0px\)\); \}/)
  })

  test('the page rides above the keyboard rather than under it', () => {
    /*
     * `position: fixed` is placed against the LAYOUT viewport, which iOS does
     * not shrink when the keyboard comes up — so a footer pinned above
     * `--nav-h` sits behind the keyboard on the one surface whose first act is
     * to put a caret in a field. `visualViewport` is the only thing that
     * reports the real area, and it reports it as a resize.
     */
    expect(code(launch), 'the composer stopped measuring the keyboard')
      .toContain('visualViewport')
    expect(code(launch), 'the page no longer moves for the keyboard')
      .toMatch(/bottom: kb > 0 \? `\$\{kb\}px` : 'var\(--nav-h\)'/)
  })

  test('the page ranks above the card detail it covers and below its own menus', () => {
    /*
     * The ladder: 50 for a sheet and for the card detail page, 52 for this,
     * 55 for `Menu` — which is what the repository and session chips on this
     * surface open as — and 60 for the palette. Two equal z-indexes would leave
     * "does the composer cover the card it was opened from" to DOM insertion
     * order, which is true today and is not a thing to depend on.
     */
    expect(code(home)).toContain('z-50 pad-top')
    expect(code(launch)).toContain('z-[52]')
    expect(code(primitives), 'Menu stopped ranking above the surfaces it opens over')
      .toContain('z-[55]')
  })

  test('the width that decides is the one the stylesheet already uses', () => {
    // 640 is where the shell swaps its rail for a tab bar, where `--nav-h`
    // grows, and where every `sm:` in the composer flips. One number.
    expect(read('src/web/lib/launch.ts'))
      .toContain("export const PHONE_COMPOSER = '(max-width: 639.98px)'")
    expect(css).toContain('@media (max-width: 639.98px)')
    // Not a pointer test. A touchscreen laptop at 1440px has a coarse pointer
    // and acres of room; this is a question about the room.
    expect(code(launch), 'the composer started deciding its room by pointer type')
      .not.toMatch(/pointer:\s*coarse/)
  })

  test('a laptop still gets the sheet, at the width it has always had', () => {
    // AMENDED: the sheet is mounted only while the composer is open now, so
    // `open` is a bare prop rather than `open={basket.open}`. What the rule was
    // protecting — a laptop keeps the modal, and it keeps the reading width — is
    // unchanged and is what is asserted.
    expect(code(launch), 'the laptop lost its modal')
      .toMatch(/<Sheet open onClose=\{closeLaunch\}[\s\S]{0,120}wide>/)
    expect(code(primitives), 'the wide sheet is no longer 760px')
      .toContain("sm:max-w-[760px]")
  })
})

describe('the way back is one control, and it says where it goes', () => {
  test('a chevron path with a back control shaped like the card detail’s', () => {
    // `DetailPath` is the pattern: the first segment is the control, the rest
    // is the sentence it completes, and the control carries a word rather than
    // being a bare chevron.
    expect(home, 'the card detail’s back control stopped naming where it goes')
      .toContain('ariaLabel="Back to the desk"')
    expect(code(launch), 'the composer’s back control stopped naming the desk')
      .toContain("'Back to the desk'")
    expect(code(launch), 'the composer’s path is no longer a breadcrumb')
      .toContain('aria-label="Breadcrumb"')
    // The last crumb is what this surface does, which is the verb rather than
    // the product: "open" is what the Sessions page does.
    expect(code(launch)).toContain("const COMPOSER_TITLE = 'Send to Claude Code'")
  })

  test('a second room can be left without leaving the composer', () => {
    // `+ Context` and `Shape` replace the body rather than pushing history, so
    // each one has to carry its own way back or the only exit is the OS gesture,
    // which closes the whole composer and the brief goes with the view.
    expect(code(launch), 'a panel opened with no way back to the field')
      .toMatch(/function PanelPath\(/)
    expect(code(launch)).toContain('ariaLabel="Back to the brief"')
  })

  test('the overflow has a name, and it is not a glyph or the word More', () => {
    // There is an overflow on this surface now — the permission mode, the packed
    // brief and the way into the session with nothing to say are all genuinely
    // secondary. What it may not be is anonymous: an ellipsis on a phone is a
    // lozenge you tap to find out what it does, and `More` is the same anonymity
    // spelled in letters. `pages/Session.tsx` reached `Details` first and this
    // matches it rather than inventing a second word.
    for (const [name, src] of [['launch', launch], ['detail', detail]] as const) {
      expect(src, `${name} grew a kebab`).not.toMatch(/MoreHorizontal|MoreVertical|EllipsisVertical/)
      expect(src, `${name} grew an ellipsis trigger`).not.toContain('⋯')
      expect(code(src), `${name} grew a "More" control`).not.toMatch(/>\s*More\s*</)
    }
    expect(code(launch), 'the overflow lost its name')
      .toMatch(/<Chip onClick=\{\(\) => setPanel\('run'\)\}[\s\S]{0,160}Details/)
  })

  test('opening the composer no longer closes the card underneath it', () => {
    /*
     * One removed line, and it is the whole of "Back puts him back where he
     * was". `onClose` here is `closeDetail`, which on a phone unwinds the
     * pushed `#card/<key>` entry — so pressing Back out of the composer landed
     * on the desk with the card gone.
     */
    const claude = code(detail).slice(code(detail).indexOf('openLaunch(cardContext(card)') - 400)
    expect(claude.slice(0, 400), 'the Claude action closes the card again')
      .not.toMatch(/onClose\(\)\s*\n\s*openLaunch\(cardContext/)
  })
})

/* --------------------- the first screen is a field and Send --------------- */

describe('the composer opens on the thing he came to type', () => {
  test('the field is the first thing in the body, and the chips come after it', () => {
    /*
     * Measured before this: 2,431px of scroll above the field on a 375px
     * screen — a repository menu, a session menu, eleven template rows with
     * their blurbs, twenty-eight skill rows with theirs, the attachments, the
     * Slack replies. He opened this to type a sentence and was handed a
     * settings screen.
     */
    const body = composeBranch()
    const field = body.indexOf('<GrowingField')
    const chips = body.indexOf('flex flex-wrap items-center gap-2 mt-3')
    expect(field, 'the field is no longer on the first screen').toBeGreaterThan(-1)
    expect(chips, 'the chip rail went missing').toBeGreaterThan(field)
  })

  test('repository, session, context and shape are chips, not sections', () => {
    // Configuration is opt-in. Each of these was a full section with a heading
    // on the first screen; three of them are answered for him on most briefs.
    const compose = composeBranch()
    expect(compose).toContain('<RepoChip')
    expect(compose).toContain('<SessionChip')
    expect(compose).toContain('+ Context')
    expect(compose).toContain('Shape')
    // And the two browsable lists are only rendered inside a room he opened.
    expect(compose, 'the template list came back to the first screen')
      .not.toContain('<TemplatePicker')
    expect(compose, 'the skill list came back to the first screen')
      .not.toContain('<SkillPicker')
  })

  test('nothing on this surface takes focus', () => {
    // Opening the composer must not raise the keyboard: on a phone the keyboard
    // covers the field it was raised for. The one exception is the skill search,
    // and only after the button that reveals it has been pressed — a tap that
    // asked for a keyboard.
    expect(code(launch), 'something autofocuses on open').not.toContain('autoFocus')
    const focuses = [...code(launch).matchAll(/\.focus\(\)/g)]
    expect(focuses.length, 'a new focus call appeared on the composer').toBe(2)
    expect(code(launch), 'the search field focuses without being asked for')
      .toMatch(/if \(searching\) field\.current\?\.focus\(\)/)
  })

  test('the three things deleted from the first screen stay deleted', () => {
    const src = code(launch)
    // A `36c` column with no header and no unit, measuring a URL budget that no
    // longer exists.
    expect(src, 'the Characters column came back').not.toMatch(/Characters/)
    // A paragraph explaining what a `--permission-mode` flag is, above a control
    // whose two labels already say it.
    expect(src, 'the permission essay came back')
      .not.toMatch(/--permission-mode, and the brief says so/)
    // And the failure this whole pass is named for: a command line for him to
    // paste into a terminal he has to go and find.
    expect(src, 'a resume command came back').not.toMatch(/claude --resume/)
  })

  test('writing the brief is not a step', () => {
    // There used to be two presses for one intention: `Write the brief`, which
    // produced 600 lines of Markdown he did not write, and only then a commit.
    // Send packs. The packed brief is still readable, behind `Details`.
    expect(code(launch), 'the composer asks him to write the brief again')
      .not.toMatch(/>\s*\{?busy \? 'Writing' : 'Write the brief'/)
    expect(code(launch), 'the packed brief stopped being reachable at all')
      .toContain('Show the packed brief')
    expect(code(launch), 'the review is on the first screen again')
      .toMatch(/panel === 'run' && \(/)
  })
})

/* ------------------------------ the two lists ----------------------------- */

describe('a list of names, with the sentence one press away', () => {
  test('the blurb is not painted on a phone', () => {
    // Ten templates and twenty-eight skills, each carrying a wrapped sentence,
    // is the wall this pass exists to remove. Above `sm` there is room beside
    // the name and it stays.
    expect(fn(code(launch), 'PickRow'), 'the blurb wraps under the name again')
      .toMatch(/hidden sm:block[^\n]*\{blurb\}/)
  })

  test('the row is 44px and the ⓘ is a real target', () => {
    expect(code(launch), 'a picker row stopped being a 44px target')
      .toMatch(/const NAME_CELL = [^\n]*min-h-11/)
    // Not `.hit`, which draws its collar outside the control: in a list every
    // row's collar overlaps its neighbours' and the last one painted takes the
    // tap, which here means reading one row while meaning to tick another.
    expect(fn(code(launch), 'PickRow'), 'the blurb disclosure is smaller than a thumb')
      .toMatch(/h-11 w-11/)
    expect(fn(code(launch), 'PickRow')).toMatch(/aria-label=\{`What \$\{label\} is for`\}/)
  })

  test('the skill search is a button until it is asked for', () => {
    // It was a live `<input>`, always mounted, in the scroll path of the first
    // thing this surface painted — so opening the composer could raise the
    // keyboard before he had decided anything.
    const picker = fn(code(launch), 'SkillPicker')
    expect(picker, 'the search field is mounted again with nothing asking for it')
      .toMatch(/searching \? \(/)
    expect(picker, 'nothing reveals the search field')
      .toMatch(/onClick=\{\(\) => setSearching\(true\)\}/)
  })

  test('search still matches what a person half-remembers', () => {
    // Searching only `name` meant "customer" found nothing while three skills
    // said "customer issue" in their own descriptions.
    const picker = fn(code(launch), 'SkillPicker')
    expect(picker, 'the skill search stopped reading the description')
      .toContain('s.description')
    expect(picker, 'the skill search stopped reading whenToUse')
      .toContain('s.whenToUse')
  })
})

/* ------------------------------- the commit ------------------------------- */

describe('the commit is a sibling of the scroll, and it names what it does', () => {
  test('it lives in Sheet’s footer rather than in a sticky box', () => {
    // A `position: sticky` strip is held inside the scroll container, can be
    // pushed by its padding, can be overlapped by the content it is holding
    // above, and vanishes entirely if an ancestor grows an `overflow: hidden`.
    expect(code(launch), 'the commit went back inside the scroller')
      .toMatch(/<Sheet open onClose=\{closeLaunch\}[\s\S]{0,120}footer=\{footer\}/)
    expect(code(launch), 'the phone page lost its footer slot')
      .toMatch(/function LaunchPage\(\{ footer, children \}/)
    expect(code(launch), 'a sticky commit strip came back')
      .not.toMatch(/sticky bottom-0/)
    expect(code(primitives), 'Sheet lost the footer slot this depends on')
      .toMatch(/\{footer && \(/)
  })

  test('the primary verb is Send, and the secondary is honest about being a hatch', () => {
    const src = code(launch)
    expect(src, 'the primary stopped being a send').toContain("'Send to session'")
    expect(src, 'a new conversation stopped being a start').toContain("'Start a session'")
    // The old primary label, over a control that opened a chat surface.
    expect(src, '"Open in Claude" came back as a primary label')
      .not.toMatch(/>\s*Open in Claude\s*</)
  })

  test('the hatch is a real anchor, and it can never carry a session id', () => {
    /*
     * A universal link on iOS is handed to the app only by a genuine link
     * navigation; `window.open` after an await lands in the browser. So it stays
     * an `<a href>`, and the href is built from the server's own hand-off config
     * rather than a literal, which is also what makes a deployment that moves
     * `WAKE_HANDOFF_URL` followed rather than contradicted.
     *
     * It opens a NEW conversation — there is no URL that reaches an existing one
     * — so the id must never appear in it, and the label has to say so.
     */
    const src = code(launch)
    expect(src, 'the hatch stopped being an anchor')
      .toMatch(/<a\s+href=\{claudeAppUrl\(meta\.handoff, draft\?\.brief \?\? instruction\)\}/)
    expect(src, 'the hatch lost target="_blank"').toMatch(/href=\{claudeAppUrl[\s\S]{0,120}target="_blank"/)
    expect(src, 'the hatch is not labelled').toContain('Open in the Claude app')
    expect(src, 'the hatch stopped saying it starts a new conversation')
      .toMatch(/const APP_HATCH =[\s\S]{0,200}new conversation/)
    // The href is a function of the text and nothing else. A session id in it
    // would be a promise no URL can keep.
    expect(src, 'a session id reached the hatch')
      .not.toMatch(/claudeAppUrl\([^)]*session/)
    expect(read('src/web/lib/launch.ts'), 'the hatch stopped using the shared arithmetic')
      .toMatch(/export const claudeAppUrl[\s\S]{0,120}handoffFor\(text, cfg\)/)
  })

  test('the review is prose, not a terminal', () => {
    // `font-mono` in a fixed `44vh` box is most of why this product read as a
    // console: a brief is prose with a few paths in it, and setting the whole of
    // it in monospace says the reader is expected to parse rather than read.
    const review = fn(code(launch), 'Review')
    expect(review, 'the brief went back into monospace').not.toContain('font-mono')
    expect(review, 'the brief is back in a 44vh slot').not.toContain('44vh')
    expect(review, 'the editor stopped being the source of what is sent')
      .toContain('onChange={e => setBrief(e.target.value)}')
  })
})

/* ---------------------- leaving does not cost the brief ------------------- */

const card = (ref: string): PackItem => ({ kind: 'card', ref, title: ref })

describe('Back suspends the composer; it does not throw the brief away', () => {
  beforeEach(() => resetLaunch())

  test('leaving keeps every object, template and word', () => {
    openLaunch([card('slack:a'), card('slack:b')], { template: 'slack-thread', repoHint: 'truto' })
    rememberLaunch({ instruction: 'find out why the sync 500s', cwd: '/home/me/work/truto' })

    closeLaunch()

    expect(launchBasket().open).toBe(false)
    expect(launchBasket().items.map(i => i.ref)).toEqual(['slack:a', 'slack:b'])
    expect(launchBasket().templates).toEqual(['slack-thread'])
    expect(launchBasket().repoHint).toBe('truto')
    expect(launchDraft().instruction).toBe('find out why the sync 500s')
    expect(launchDraft().cwd).toBe('/home/me/work/truto')
  })

  test('coming back to the same brief resumes it', () => {
    openLaunch([card('slack:a')], { template: 'slack-thread', repoHint: 'truto' })
    rememberLaunch({ instruction: 'half a sentence', brief: { packId: 'p1', text: '# a brief' } })
    closeLaunch()

    // The same card, opened again — same objects, same templates, same hint.
    openLaunch([card('slack:a')], { template: 'slack-thread', repoHint: 'truto' })

    expect(launchBasket().open).toBe(true)
    expect(launchDraft().instruction).toBe('half a sentence')
    expect(launchDraft().brief).toEqual({ packId: 'p1', text: '# a brief' })
    // And the object is still there once, not twice.
    expect(launchBasket().items.map(i => i.ref)).toEqual(['slack:a'])
  })

  test('a different brief starts clean, which is the leak the old rule prevented', () => {
    /*
     * The reported bug: open one card's brief, dismiss it, open a different
     * card, and the sheet read `CONTEXT — 4 OBJECTS`, three of them from the
     * card he walked away from — with `repoHint` sticky too, so an abandoned
     * card's repository could become the next brief's working directory. The
     * fix used to be "every dismissal empties"; it is now "a fresh open of a
     * different subject empties", which is the same guarantee at the point it
     * would actually become visible.
     */
    openLaunch([card('slack:a')], { template: 'slack-thread', repoHint: 'truto' })
    rememberLaunch({ instruction: 'about the first card', cwd: '/home/me/work/truto' })
    closeLaunch()

    openLaunch([card('gh:9')], { template: 'pull-request', repoHint: 'wake' })

    expect(launchBasket().items.map(i => i.ref)).toEqual(['gh:9'])
    expect(launchBasket().templates).toEqual(['pull-request'])
    expect(launchBasket().repoHint).toBe('wake')
    expect(launchDraft().instruction).toBe('')
    expect(launchDraft().cwd).toBeNull()
  })

  test('a fresh open with no template of its own inherits nothing', () => {
    /*
     * The subject is built from what the call asks for, never from what is left
     * in the basket. `templates` falls back to `basket.templates`, which is
     * right for an attach from inside an open composer and would be a leak
     * here: a fresh open with no template would compute its signature from the
     * previous brief's templates and then write them back over the clear that
     * had just removed them.
     */
    openLaunch([card('slack:a')], { template: 'slack-thread', repoHint: 'truto' })
    closeLaunch()

    openLaunch([card('session:9f2c')])

    expect(launchBasket().items.map(i => i.ref)).toEqual(['session:9f2c'])
    expect(launchBasket().templates, 'the previous brief’s template came along')
      .toEqual([])
    expect(launchBasket().repoHint).toBeNull()
  })

  test('attaching from inside the composer adds, and never restarts', () => {
    // The Slack reply picker and the session picker both attach through
    // `openLaunch` while it is open. Neither is a new brief.
    openLaunch([card('slack:a')], { template: 'slack-thread' })
    rememberLaunch({ instruction: 'keep me' })

    openLaunch([card('slack:reply-1')])
    openLaunch([card('slack:reply-2')])

    expect(launchBasket().items.map(i => i.ref)).toEqual(['slack:a', 'slack:reply-1', 'slack:reply-2'])
    expect(launchBasket().templates).toEqual(['slack-thread'])
    expect(launchDraft().instruction).toBe('keep me')
  })

  test('committing clears it, draft and all', () => {
    // `resetLaunch` is the success path — the session has the message and the
    // page has moved to it.
    openLaunch([card('slack:a')], { template: 'slack-thread' })
    rememberLaunch({ instruction: 'sent', brief: { packId: 'p1', text: '# a brief' } })

    resetLaunch()

    expect(launchBasket().items).toEqual([])
    expect(launchBasket().templates).toEqual([])
    expect(launchDraft().instruction).toBe('')
    expect(launchDraft().brief).toBeNull()

    // And the next open of what was just sent is a new brief, not a resume.
    openLaunch([card('slack:a')], { template: 'slack-thread' })
    expect(launchDraft().instruction).toBe('')
  })
})
