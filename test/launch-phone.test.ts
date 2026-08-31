/**
 * The composer on a phone: a page, with a way back that costs nothing.
 *
 * Two different kinds of test, because the change has two different kinds of
 * claim in it.
 *
 * The first half reads the source, like `phone-desk.test.ts` does and for the
 * same reason: there is no layout engine in this suite, and what is being
 * pinned is what the components *declare* — that below `sm` the composer stops
 * being a modal, that it stops at `--nav-h` so the six destinations stay one tap
 * away, and that a laptop's sheet is untouched at the width it has always been.
 * Every one of those is a one-word edit away from silently regressing and none
 * of them would fail anything else.
 *
 * The second half runs the real store. "Back loses the half-written brief" is
 * the one failure this work was not allowed to have, and it is a property of
 * `lib/launch.ts` rather than of any component — so it is tested there, against
 * the three cases that have to hold at once: leaving keeps everything, coming
 * back to the same brief resumes it, and opening a different one starts clean.
 * That third case is the bug the old "empty on every dismissal" rule existed to
 * prevent, and it is the one a preserving Back could plausibly reintroduce.
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

/* --------------------------- the room it is drawn in ---------------------- */

describe('below sm the composer is a page and not a modal over the desk', () => {
  test('it is a portal that stops at the tab bar, exactly like the card detail', () => {
    // `DetailPage` in Home.tsx is the reference and the point is that this is
    // the same thing, not a second thing that looks like it: the same portal,
    // the same `pad-top` for the notch, the same stop at `--nav-h`.
    expect(home, 'the phone card detail stopped honouring --nav-h')
      .toContain("style={{ bottom: 'var(--nav-h)' }}")
    expect(launch, 'the phone composer no longer stops above the tab bar')
      .toContain("style={{ bottom: 'var(--nav-h)' }}")
    expect(code(launch), 'the phone composer is drawn inside the page again')
      .toContain('createPortal(')
    expect(code(launch), 'the composer lost its safe-area top')
      .toMatch(/fixed inset-x-0 top-0 z-\[52\] pad-top/)

    // And `--nav-h` still means the tab bar below sm, which is the whole reason
    // the number is a variable.
    expect(css, '--nav-h stopped accounting for the phone tab bar')
      .toMatch(/:root \{ --nav-h: calc\(53px \+ max\(env\(safe-area-inset-bottom\), 0px\)\); \}/)
  })

  test('the page ranks above the card detail it covers and below its own menus', () => {
    /*
     * The ladder: 50 for a sheet and for the card detail page, 52 for this,
     * 55 for `Menu` — which is what the repository and session pickers on this
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
    expect(code(launch), 'the laptop lost its modal')
      .toMatch(/<Sheet open=\{basket\.open\} onClose=\{closeLaunch\}[\s\S]{0,80}wide>/)
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
    // The last crumb is this place, named in full — the two missing words were
    // once the whole bug.
    expect(code(launch)).toContain("const COMPOSER_TITLE = 'Open in Claude Code'")
  })

  test('there is no kebab and no More anywhere on either surface', () => {
    for (const [name, src] of [['launch', launch], ['detail', detail]] as const) {
      expect(code(src), `${name} grew an overflow menu`).not.toMatch(/MoreHorizontal|MoreVertical|EllipsisVertical/)
      expect(code(src), `${name} grew a "More" control`).not.toMatch(/>\s*More\s*</)
    }
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

/* ------------------------ the detail, at 390px ---------------------------- */

describe('the card detail stops eliding the things a phone came to read', () => {
  test('the fact rows spend less of a 358px row on chrome', () => {
    // 96px of label, 20px of mark and two 12px gaps is 140px spent before the
    // value starts, for words never longer than `Repository`.
    expect(code(detail), 'the fact row went back to a 96px label on a phone')
      .toContain('w-20 sm:w-24 shrink-0 text-sm text-fg-mute')
    expect(code(detail)).toContain('gap-2 sm:gap-3 min-h-11')
    // `min-h-11`, so a value that wraps makes room instead of being clipped.
    expect(code(detail), 'the fact row is a fixed height again')
      .not.toMatch(/flex items-center gap-\d sm:gap-\d h-11 border-t/)
  })

  test('why · who · when gets two lines rather than one elided one', () => {
    // It is the sentence that says what the card is doing on the desk, and at
    // 390px it is not one line.
    expect(code(detail)).toMatch(/line-clamp-2 leading-snug[\s\S]{0,120}card\.why, card\.who, ago\(card\.ts\)/)
  })

  test('a fact that is prose wraps; a fact that is a formatted value elides', () => {
    // A string is a sentence somebody wrote. An element is `<Mono>` around a
    // path, a channel or an id — scanned, not read, and no better across two
    // lines.
    expect(code(detail)).toMatch(/typeof v === 'string'[\s\S]{0,200}line-clamp-2 leading-snug/)
    expect(code(detail)).toMatch(/typeof v === 'string'[\s\S]{0,260}text-fg-dim truncate/)
  })

  test('the two rows of actions cannot steal each other’s taps', () => {
    /*
     * `.hit` gives each button a 44px touch box centred on 32px of ink, so
     * every collar reaches 6px past itself; two rows 8px apart overlap by 4px
     * and the last painted wins. The one below is `Done`, which settles the
     * card. 12px is two collars touching and never overlapping.
     */
    expect(code(detail), 'the action grid went back to an 8px row gap')
      .toContain('grid grid-cols-2 gap-x-2 gap-y-3')
    expect(css, 'the 44px collar this arithmetic is about is gone')
      .toMatch(/\.hit::after \{[\s\S]{0,200}width: max\(100%, 44px\);\s*\n\s*height: max\(100%, 44px\);/)
  })

  test('a thread clipped at three lines says so and can be opened', () => {
    // The excerpt directly below already won this argument for itself: a silent
    // clip reads as the whole message. One control for the list rather than one
    // per message — a thread has up to twenty replies.
    expect(code(detail)).toContain('const CLIPPED = 160')
    expect(code(detail)).toMatch(/clipped && <ShowAll open=\{full\}/)
    expect(code(detail), 'a thread line is clamped with no way past it')
      .toContain("${full ? '' : 'line-clamp-3'}")
    // And the disclosure is one 44px control rather than an 18px line, on both
    // of the two places that show clipped text.
    expect(code(detail)).toMatch(/function ShowAll[\s\S]{0,400}min-h-11/)
    expect(code(detail)).toMatch(/excerpt\.length > CLIPPED && <ShowAll open=\{expanded\}/)
    // A pasted Slack permalink is a 200-character token with nowhere to break,
    // which is the one thing that can make this column wider than the screen.
    expect(code(detail)).toContain('whitespace-pre-wrap break-words')
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
    // `resetLaunch` is the success path — the session has started and the page
    // has moved to the terminal.
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
