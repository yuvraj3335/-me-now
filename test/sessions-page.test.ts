/**
 * The Sessions surface, as a phone reads it.
 *
 * These read the source rather than the DOM, which is the same tool
 * this file reads the source rather than a DOM, because there is no layout engine
 * in this suite, and each rule below is one that is easy to break with a
 * plausible-looking edit and impossible to notice afterwards. A composer that
 * quietly grows an `autoFocus`, a delete that quietly grows a text field again,
 * an anchor that becomes an `onClick` — all three ship green and all three are
 * only found on a real phone at seven in the morning.
 *
 * The rules themselves are the corrections this pass made:
 *
 *   1. **The list is what is running.** No view control, no archived row, and
 *      the gate is a function so it can be checked rather than inspected.
 *   2. **A session is a page.** Tapping a row navigates; it does not open a
 *      sheet holding the same facts the row already carried.
 *   3. **Delete needs no keyboard.** Two taps that expire, not six characters
 *      typed into a field the keyboard is covering.
 *   4. **The Claude app is a hatch, not the product.** It stays a real anchor,
 *      because only a link navigation reaches the iOS app — and it is never how
 *      a message gets to a session, because it cannot be.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listedSessions } from '../src/web/components/sessions'
import type { Session } from '../src/web/lib/launch'

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const p = join(dir, entry)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : []
  })

const web = walk('src/web')
const read = (f: string) => readFileSync(f, 'utf8')

/**
 * A file with its comments removed.
 *
 * Anything banning a *word* reads this instead of the source. Every file in
 * this product explains in prose what it used to do and why it stopped, and a
 * note about history is not a label.
 */
const codeOf = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n')

const page = read('src/web/pages/Session.tsx')
const list = read('src/web/components/sessions.tsx')
const app = read('src/web/App.tsx')

describe('a session is a conversation you can add to', () => {
  test('the page renders a composer', () => {
    // The whole point of the page. It used to be reachable only as a terminal
    // — 346KB of VT emulator and 120 columns of tmux on a 375px screen — or as
    // a sheet of facts with no way to say anything at all.
    expect(page, 'the session page has no field to type in').toMatch(/<textarea/)
    // Bound to the state the send reads. A field wired to anything else is a
    // review surface that sends something other than what is on screen.
    expect(page, 'the composer is not bound to what gets sent').toMatch(/value=\{text\}/)
    expect(page, 'nothing on the page commits the message').toMatch(/onClick=\{\(\) => void send\(\)\}/)

    // Enter sends, Shift+Enter breaks the line, and an IME candidate is
    // neither: confirming a Japanese or Chinese word is an Enter, and without
    // the guard the half-typed one is what leaves.
    expect(page, 'Enter no longer sends').toMatch(/e\.key !== 'Enter' \|\| e\.shiftKey/)
    expect(page, 'an IME confirmation would send the half-typed word')
      .toMatch(/isComposing/)
  })

  test('nothing on this surface opens the keyboard by itself', () => {
    // Arriving at a session is almost always arriving to read. A composer that
    // focuses itself takes half a phone screen and the conversation with it,
    // and on this page the thing it covers is the thing you came for.
    //
    // Scoped to the two files this surface is made of rather than to `src/web`.
    // The desk's table focuses its own cell editor on a laptop, which is a
    // different control on a different device answering a different question —
    // banning the attribute product-wide would be this rule overreaching into
    // somebody else's screen.
    for (const f of ['src/web/pages/Session.tsx', 'src/web/components/sessions.tsx']) {
      expect(codeOf(f), `${f}: a control focuses itself on arrival`).not.toMatch(/\bautoFocus\b/)
    }
  })

  test('the composer is gated on the session being alive, in the server’s words', () => {
    // The failure this whole pass exists to fix: Wake handed an id belonging to
    // a finished session to `--resume` and let Claude Code be the one to say,
    // on his phone, that it had been archived. The page checks first, and when
    // the answer is no it offers the only thing that works.
    expect(page, 'the composer stopped asking whether the session is running')
      .toMatch(/id && !active \?/)
    expect(page, 'a dead session has nothing to offer instead')
      .toContain('Start a new session')

    // And a refusal is printed as it arrived. "That session is not running any
    // more" and "that session is open in a terminal Wake did not start" are two
    // different true things about two different situations, and one
    // client-side apology in their place is how you stop being able to tell
    // which just happened. The page holds the sentence and renders it; it never
    // reads it.
    expect(page, 'the server’s refusal is not being rendered').toMatch(/\{refused\}/)
    expect(page, 'the refusal is the message the server sent')
      .toMatch(/setRefused\(\(e as Error\)\.message\)/)
    expect(codeOf('src/web/pages/Session.tsx'), 'the page is matching on refusal text')
      .not.toMatch(/\.message\.(includes|startsWith|match)/)
  })

  test('it polls while visible and never opens a stream', () => {
    // A phone backgrounds its tab and an SSE stream dies with it — silently, so
    // the page comes back looking live over a conversation that stopped ten
    // minutes ago.
    // Read with the comments off: this file and the page both explain in prose
    // why the stream is not there, and a note about history is not a stream.
    for (const f of web) {
      expect(codeOf(f), `${f}: something opened an event stream`).not.toMatch(/EventSource/)
    }
    expect(page, 'the page stopped following the conversation').toMatch(/sessionApi\.since\(/)
    expect(page, 'the poll runs in a hidden tab').toMatch(/if \(document\.hidden\) return/)
    // `after` is a timestamp and not an index. The server reads a bounded tail
    // of a file that is being appended to, so an index means something
    // different on every read.
    expect(page, 'the poll went back to asking by position').toMatch(/after\.current/)
  })

  test('turns are read as messages, not as a log', () => {
    // The one thing separating this page from the terminal it replaces: a
    // transcript set in monospace is a log whatever it says.
    expect(page, 'the turn stopped being body text').toMatch(/text-base leading-\[1\.7\]/)
    expect(page, 'a turn lost its reading width').toMatch(/max-w-\[80%\]/)
    // Monospace survives only inside a fenced block and a backticked span,
    // where the character grid is carrying meaning.
    const bubble = page.slice(page.indexOf('function Turn('), page.indexOf('function Tools('))
    expect(bubble, 'the message body went back to monospace').not.toMatch(/font-mono/)

    // Eight tool names between two sentences a person wrote is a wall. The
    // count is the fact worth having at reading speed.
    expect(page, 'the tools went back to being printed in full')
      .toMatch(/\{names\.length\} tool/)
  })
})

describe('the list is what is running', () => {
  const row = (p: Partial<Session>): Session => ({
    id: 'x', title: 't', cwd: '/w', project: 'w', lastPrompt: null, turns: 1,
    lastTs: 1, path: '/p', pr: null, live: true, ...p,
  })

  test('the default view cannot render a row with archived: true', () => {
    expect(listedSessions([row({ id: 'a', lastTs: 2 }), row({ id: 'b', archived: true })])
      .map(s => s.id), 'an archived row reached the default view').toEqual(['a'])
    // Every shape the flag arrives in, including the one that predates it.
    expect(listedSessions([row({ archived: true })])).toEqual([])
    expect(listedSessions([row({ archived: false })])).toHaveLength(1)
    expect(listedSessions([row({})])).toHaveLength(1)
  })

  test('and there is no control that could put one back', () => {
    // The segmented `Active / Archived / All` is how archived work leaked onto
    // the same surface as live work, and a default is not a fix — one tap
    // undoes a default. The control is gone, so there is nothing to tap.
    const code = codeOf('src/web/components/sessions.tsx')
    expect(code, 'the view control came back').not.toMatch(/\bSegmented\b/)
    expect(code, 'a session view is being chosen again').not.toMatch(/matchesView|readView/)
    expect(code, 'the list is painting an Archived row again').not.toContain('Archived')
    // And the rows it draws come through the one gate rather than past it.
    expect(list, 'the list stopped drawing what `listedSessions` returns')
      .toMatch(/listedSessions\(inRepo\)/)
  })

  test('a row is a title, a line, a dot and an age — and no buttons', () => {
    /*
     * AMENDED: the slice ends at the drawer's *use*, not at a drawer defined
     * here, because there is no drawer defined here any more.
     *
     * `SessionDrawer` was a private copy of the desk's `SwipeDrawer` living in
     * this file. It has been deleted — the shared component takes an optional
     * `status` and a session simply does not pass one — so the old end marker
     * `function SessionDrawer(` no longer exists and `indexOf` returned -1,
     * which sliced the row body to nothing and passed every assertion below
     * against an empty string. A marker that can vanish is a test that can stop
     * testing without failing, so this one is bounded by the next function
     * instead and asserts it actually found a body.
     *
     * The rule is untouched and is still the point: **no control is painted on
     * the row itself.** Three icon buttons were 110px of a 375px screen,
     * measured, and the title column got 133px against a 438px string. Actions
     * live behind the swipe, which costs the row nothing at rest.
     */
    const at = list.indexOf('function Row(')
    // Both markers: what follows `Row` is a block comment and then an
    // `export function`, so bounding on a bare `\nfunction ` alone runs to the
    // end of the file and picks up the delete sheet's buttons.
    const ends = ['\nfunction ', '\nexport function ']
      .map(m => list.indexOf(m, at + 1))
      .filter(n => n !== -1)
    const body = list.slice(at, ends.length ? Math.min(...ends) : undefined)
    expect(body.length, 'the Row body could not be found').toBeGreaterThan(200)
    expect(body, 'the Row body ran past the row').not.toMatch(/DeleteSheet/)
    expect(body, 'the live dot is not the status token').toMatch(/bg-status-live/)
    expect(body, 'the row stopped saying when it was last active').toMatch(/ago\(s\.lastTs\)/)
    expect(body, 'a control came back onto the row').not.toMatch(/<Button/)
    expect(body, 'the branch came back onto the phone row').not.toMatch(/s\.branch/)
  })

  test('a session row swipes to the same actions every other row has', () => {
    /*
     * The desk, Work and this page share one drawer now. What a session gets is
     * `Task`, `Done` and `Delete`; what it does not get is `Status`, and that is
     * a decision rather than an omission — see the comment in `sessions.tsx`.
     *
     * A session has two facts about its state and neither is a status: whether
     * the process is up, which is Claude Code's answer and which the row already
     * draws as the live dot, and whether it is on Wake's list, which is what
     * `Done` writes. `status` is optional on the drawer precisely so a row with
     * no lifecycle can decline it instead of inventing five values.
     */
    expect(list, 'the session row went back to a private drawer')
      .not.toMatch(/function SessionDrawer\(/)
    expect(list, 'the session row stopped using the shared drawer')
      .toMatch(/<SwipeDrawer/)
    expect(list, 'a session grew a status it cannot honestly have')
      .not.toMatch(/<SwipeDrawer[\s\S]{0,400}status=\{/)
    // Three actions, and the width the hook is asked for has to match them.
    expect(list, 'the drawer width no longer matches the actions in it')
      .toMatch(/useSwipe\(`session:\$\{s\.id\}`, 3\)/)
    for (const prop of ['onTask', 'onDone', 'onDelete']) {
      expect(list, `the session drawer lost ${prop}`).toMatch(new RegExp(`${prop}=\\{`))
    }
  })

  test('tapping a row goes to the page, not to a sheet', () => {
    expect(list, 'the row stopped navigating').toMatch(/navigate\(sessionRoute\(s\.id\)\)/)
    expect(codeOf('src/web/components/sessions.tsx'), 'the peek sheet came back')
      .not.toMatch(/PeekSheet/)
    // And the shell knows the route exists, without it becoming a seventh tab.
    expect(app, 'the shell stopped routing to a conversation').toMatch(/sessionRouteOf\(path\)/)
    expect((app.match(/^\s*\{ path: '/gm) ?? []).length, 'a destination was added or lost').toBe(6)
    // The tab that leads to a chat may not wear a terminal.
    const tab = app.split('\n').find(l => l.includes("path: '/sessions'")) ?? ''
    expect(tab, 'the Sessions tab is still a terminal').not.toMatch(/SquareTerminal/)
  })
})

describe('deleting a session costs two taps and no typing', () => {
  test('there is no confirmation word to type, anywhere', () => {
    // It used to require the word `delete` in a text field, which is the
    // pattern for a console you visit on a laptop once a quarter. On a phone it
    // raises a keyboard that covers the four paths the dialog exists to show —
    // and a person who can type `delete` has not thereby read them.
    for (const f of web) {
      expect(read(f), `${f}: a typed confirmation came back`).not.toMatch(/CONFIRM_WORD/)
    }
    const sheet = list.slice(list.indexOf('export function DeleteSheet('))
    expect(sheet, 'the delete dialog grew a field again').not.toMatch(/<input|inputClass/)
  })

  test('the second tap is a different button, and it expires', () => {
    // Deliberateness is what the typing was standing in for, and two taps
    // express it. The expiry is what keeps a sheet left open in a pocket from
    // being completed by an accident an hour later.
    expect(list, 'the delete no longer arms before it fires')
      .toMatch(/armed \? void run\(\) : setArmed\(true\)/)
    expect(list, 'the armed button does not say what the next tap does')
      .toContain('Tap again to delete')
    expect(list, 'an armed delete stays armed forever')
      .toMatch(/setTimeout\(\(\) => setArmed\(false\), ARMED_MS\)/)
    expect(list, 'the disarm window left the source').toMatch(/const ARMED_MS = 4_000/)
  })

  test('the server’s token still gates it, and the buttons stay above the fold', () => {
    // The token is minted against this exact session id and spent by the
    // delete, so approving one session and deleting another is unreachable.
    // Removing the typing did not remove that.
    expect(list, 'the delete stopped asking the server what it is about')
      .toMatch(/confirmDeleteSession\(session\.id\)/)
    expect(list, 'the delete stopped spending its token')
      .toMatch(/deleteSession\(session\.id, ready\.token\)/)
    // Both ways out live in the sheet's pinned footer rather than at the end of
    // a scrolled body, where a phone puts them below the fold.
    expect(list, 'the delete buttons went back into the scrolling body')
      .toMatch(/footer=\{session && \(/)
    // A live session is refused in prose, on screen, rather than by a disabled
    // icon whose `title` no touch device can ever show.
    expect(list, 'the live refusal stopped being a sentence')
      .toContain('running on this machine right now')
  })
})

describe('the Claude app is a hatch, and it is not the send path', () => {
  test('it is a real anchor', () => {
    // `https://claude.ai/…` is a universal link on iOS: only a genuine link
    // navigation hands it to the Claude app. A `window.open` after an await
    // lands in Safari instead, which is a different product with none of his
    // conversations in it.
    expect(page, 'the hatch stopped being a link').toMatch(/<a\s+href=\{chatUrl\}/)
    const hatch = page.slice(page.indexOf('<a\n              href={chatUrl}'))
      .slice(0, page.slice(page.indexOf('<a\n              href={chatUrl}')).indexOf('</a>'))
    expect(hatch, 'the hatch became a click handler').not.toMatch(/onClick/)
    expect(hatch, 'the hatch stopped leaving this tab').toMatch(/target="_blank"/)
  })

  test('it is labelled as the new conversation it opens', () => {
    // The Claude app cannot resume a Claude Code session — no URL reaches one —
    // so a link that named this session's id would be a promise the
    // destination cannot keep. That promise is the exact bug this pass exists
    // to stop, arriving through the one control still allowed to leave Wake.
    expect(page, 'the hatch no longer says what it opens').toContain('a new conversation')
    expect(page, 'the hatch is building a URL of its own')
      .toMatch(/chatUrl=\{env\?\.handoff\.url/)
    expect(codeOf('src/web/pages/Session.tsx'), 'the hatch is carrying a session id')
      .not.toMatch(/chatUrl[^\n]*(session|\?q=|searchParams)/)
  })

  test('and a message reaches the session without it', () => {
    // The hatch is a way out of Wake, not a way into a session. Both real send
    // paths go to this box: one starts a session, the other adds a turn to one
    // that is already running.
    expect(page, 'the page cannot start a session').toMatch(/sessionApi\.create\(/)
    expect(page, 'the page cannot add a turn').toMatch(/sessionApi\.send\(id, body\)/)
    // And the id it sends to is one it was given, never one it composed.
    expect(page, 'the send is aimed at something other than this page’s session')
      .not.toMatch(/sessionApi\.send\((?!id,)/)
  })
})
