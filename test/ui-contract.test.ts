/**
 * Contracts the UI keeps that no runtime assertion can.
 *
 * These read the source rather than the DOM. That is unusual, and it is the
 * right tool for exactly this: each one guards a rule that is easy to break
 * with a plausible-looking edit and impossible to notice afterwards — voice
 * quietly gaining the power to send, a page fetching a collection at a path
 * that 404s, an outbound action losing its confirmation.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const p = join(dir, entry)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : []
  })

const web = walk('src/web')
const read = (f: string) => readFileSync(f, 'utf8')

describe('voice never commits anything', () => {
  test('a dictation handler only ever writes into a field', () => {
    // The rule: a transcript lands in an input, and a human still presses the
    // button. `onText={...}` is the only way text leaves the recogniser.
    for (const f of web) {
      for (const m of read(f).matchAll(/onText=\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)) {
        const handler = m[1]!
        expect(handler, `${f}: a dictation handler triggers an action`).not.toMatch(
          /\b(submit|send|launch|post|openLaunch|mailApi\.send|startTurn)\s*\(/,
        )
      }
    }
  })

  test('the recorder uploads and stops there', () => {
    const recorder = read('src/web/components/voice.tsx')
    expect(recorder).toContain('voiceApi.save')
    expect(recorder).not.toMatch(/mailApi\.send|launchApi\.launch|\bsend\(/)
  })
})

describe('outbound actions keep their gate', () => {
  test('the mail composer cannot send without a token', () => {
    // The send call must carry the token from the confirm step; a bare
    // mailApi.send(current()) would be a send nobody approved.
    const sends = read('src/web/pages/Mail.tsx')
      .split('\n')
      .filter(l => l.includes('mailApi.send('))
    expect(sends.length).toBeGreaterThan(0)
    for (const line of sends) {
      expect(line.trim(), 'a send went out without its confirmation token').toContain('token')
    }
  })

  test('editing any field drops a standing confirmation', () => {
    const mail = read('src/web/pages/Mail.tsx')
    // Every field goes through `edit(...)`, which clears `confirm`.
    for (const field of ['setTo', 'setCc', 'setSubject', 'setBody', 'setAccount']) {
      expect(mail, `${field} bypasses the edit wrapper`).toContain(`edit(${field})`)
    }
  })
})

describe('client paths match the routes that exist', () => {
  test('no collection is fetched with a trailing slash', () => {
    // `/api/voice/` falls through to the SPA handler and 404s, which surfaced
    // as an empty voice-notes list saying "not found".
    for (const f of web) {
      for (const m of read(f).matchAll(/fetch\(`?\/api\/[a-z-]+\/`/g)) {
        throw new Error(`${f}: ${m[0]} — a collection path must not end in a slash`)
      }
    }
    expect(true).toBe(true)
  })
})

describe('navigation cannot stall', () => {
  test('the page transition has no exit animation to wait on', () => {
    // AnimatePresence mode="wait" holds the outgoing page until its exit
    // animation completes, and a background tab or a reduced-motion reader
    // never completes one — the app then appears frozen.
    // Matched as JSX props on their own line, so the comment explaining the
    // rule does not trip the rule.
    const props = read('src/web/App.tsx')
      .split('\n')
      .filter(l => /^\s*(exit=\{|mode="wait")/.test(l))
    expect(props, 'the route transition regained something to wait on').toEqual([])
  })
})

describe('nothing waits on a frame that may never come', () => {
  // The same rule the route transition keeps, applied to everything else that
  // animates. A tab that is not being painted schedules no animation frames, so
  // an entrance freezes at `initial` — a sheet stuck a full panel-height below
  // the fold, with its buttons unreachable — and an exit never finishes, which
  // means AnimatePresence never unmounts the row it is animating away: a card
  // marked Done stays on the list, at full opacity, next to a count that has
  // already dropped. Both survive the tab becoming visible again.
  test('`still` covers a document that is not being painted', () => {
    const motion = read('src/web/lib/motion.ts')
    expect(motion, 'useStill no longer notices a hidden document').toContain('document.hidden')
    expect(motion).toContain('visibilitychange')
  })

  test('every entrance and exit is gated on `still`', () => {
    for (const f of web) {
      const src = read(f)
      if (!/\buseStill\b|\bSTATIC_MODE\b/.test(src) && !/initial=\{|exit=\{/.test(src)) continue
      for (const line of src.split('\n')) {
        const m = /^\s*(initial|exit)=\{(.*)$/.exec(line)
        if (!m) continue
        const value = m[2]!
        // `false`, `undefined` and a gate on still/STATIC_MODE are all fine;
        // a bare target object is not.
        // `reduce` is the same `useStill()` under a name several charts use.
        const gated =
          /\b(still|reduce|STATIC_MODE)\b/.test(value) ||
          /^\s*(false|undefined)\s*\}/.test(value) ||
          // `initial` is not a motion prop on every component that has one.
          !/^\s*\{/.test(value)
        expect(gated, `${f}: ${m[1]} is not gated on \`still\`: ${line.trim()}`).toBe(true)
      }
    }
  })
})

describe('a card that leaves the list can come back', () => {
  // Both places a card can be hidden from: the row's own Done button, on the
  // table, and the Done control in the detail pane. `CardSheet.tsx` was the
  // second one until the modal became a pane and a push view; `CardDetail.tsx`
  // is where that behaviour lives now.
  test('Done offers an undo', () => {
    for (const f of ['src/web/pages/Home.tsx', 'src/web/components/CardDetail.tsx']) {
      const src = read(f)
      expect(src, `${f}: Done hides a card with no way back`).toMatch(/toast\(/)
      expect(src, `${f}: the undo does not restore anything`).toContain('actions.restore')
    }
  })

  test('the undo names what it is undoing', () => {
    // `actions.restore(g)` with no argument clears EVERYTHING keeping a card off
    // a pile. That is right for "bring this back" out of the restore list, and
    // wrong for an undo: it also drops a park or a manual pile that had nothing
    // to do with the action being undone, which is how one Undo click destroyed
    // a park the product could not re-create. Every toast that offers an Undo
    // has to restore a named target.
    for (const f of ['src/web/pages/Home.tsx', 'src/web/components/CardDetail.tsx']) {
      const src = read(f)
      const offers = [...src.matchAll(/label:\s*'Undo'([\s\S]{0,240})/g)]
      expect(offers.length, `${f}: nothing offers an undo any more`).toBeGreaterThan(0)
      for (const m of offers) {
        expect(m[1], `${f}: an undo clears more than the action it undoes`)
          .toMatch(/actions\.restore\([^)]+,\s*\w/)
      }
    }
  })

  test('the restore list is reachable without a card to open', () => {
    // The detail is unreachable once a card is off every pile, so the route back
    // cannot start from the card. It is a collapsed group at the foot of Now
    // rather than a modal — a pile of his cards belongs on the page that holds
    // his piles — and a palette command opens Now with that group expanded.
    const app = read('src/web/App.tsx')
    expect(app, 'no palette command opens the restore list').toMatch(/cards:done/)
    expect(app, 'the restore command does not open the group it names')
      .toMatch(/cards:done[\s\S]{0,400}setParam\('done'/)

    const home = read('src/web/pages/Home.tsx')
    expect(home, 'Now no longer renders the restore group').toMatch(/Done and not mine/)
    expect(home, 'the restore group cannot fetch what it lists').toContain('actions.doneCards')
    expect(home, 'nothing in the group brings a card back').toContain('actions.restore')
  })
})

describe('the console does not become a feed again', () => {
  const tsx = web.filter(f => f.endsWith('.tsx'))

  test('Now is a table with a shared colgroup', () => {
    // Three `<tbody>` groups sharing one `<colgroup>` is the whole trick: it is
    // what lets grouping and column alignment coexist without either becoming a
    // mode. A list of divs cannot hold an x-position down the page.
    const table = read('src/web/components/CardTable.tsx')
    expect(table).toContain('<colgroup>')
    expect(table).toMatch(/<thead/)
    const home = read('src/web/pages/Home.tsx')
    expect(home).toContain('<table')
    expect(home).toContain('TableCols')
    expect((home.match(/<tbody>/g) ?? []).length, 'the piles stopped being separate tbody groups')
      .toBeGreaterThanOrEqual(1)
  })

  test('no row action is invisible', () => {
    // `group-hover` never fires on touch, so four buttons at `opacity: 0` were
    // permanently invisible on a phone, permanently 28px of dead layout on all
    // twenty rows, and still tappable — opacity does not disable pointer events.
    for (const f of tsx) {
      const src = read(f)
      expect(src, `${f}: a control is hidden behind opacity rather than not rendered`)
        .not.toMatch(/opacity-0\s+group-hover:opacity-100/)
    }
  })

  test('there is no glass anywhere', () => {
    // Elevation is a 1px edge on a flat surface. Nine sites used backdrop-blur;
    // over a near-black page it reads as smear, and over an off-white one as
    // nothing at all.
    for (const f of tsx) {
      expect(read(f), `${f}: reintroduced a blurred translucent surface`)
        .not.toMatch(/backdrop-blur/)
    }
  })

  test('no structural edge is hard-coded against one theme', () => {
    // `border-white/[0.05]` over `#f7f7f9` is ~1.00:1. Eight sites did this,
    // which is why Settings rendered four bordered cards in dark and zero in
    // light from the identical component.
    for (const f of tsx) {
      expect(read(f), `${f}: an edge that only exists in dark mode`)
        .not.toMatch(/border-(white|black)\/\[/)
    }
  })

  test('a structural token is never used as text', () => {
    // `--rule` and `--edge` are structure. `ink-600` as a colour was the `·`
    // separator, at 1.58:1 dark and 1.65:1 light — 65 instances on Now, and the
    // only elements in the product that failed contrast.
    for (const f of tsx) {
      for (const line of read(f).split('\n')) {
        expect(line, `${f}: a structural token is being painted as text\n  ${line.trim()}`)
          .not.toMatch(/\btext-(rule|edge|ink-600)\b/)
      }
    }
  })

  test('the type scale stays at seven sizes', () => {
    // Wake shipped 19 distinct font sizes, 123 of ~222 declarations under
    // 13.5px — which is the actual content of "dark mode text is too faint".
    // The scale lives in styles.css as `--text-*`; an arbitrary `text-[12.5px]`
    // in a component is a nineteenth size sneaking back in.
    for (const f of tsx) {
      for (const line of read(f).split('\n')) {
        const m = /className[^\n]*?(text-\[[0-9.]+px\])/.exec(line)
        if (m) throw new Error(`${f}: ${m[1]} — use a --text-* token\n  ${line.trim()}`)
      }
    }
    const css = read('src/web/styles.css')
    for (const t of ['--text-eyebrow', '--text-xs', '--text-sm', '--text-base', '--text-md', '--text-lg', '--text-xl']) {
      expect(css, `${t} left the scale`).toContain(`${t}:`)
    }
  })

  test('the eyebrow token is only ever an eyebrow', () => {
    // It carries weight 500 and +0.06em tracking. On a chart axis label or a
    // `kbd` that is not a small label, it is a shouty one — and the token table
    // names `--text-xs` for tabular numerics, tab labels and key hints.
    for (const f of tsx) {
      for (const line of read(f).split('\n')) {
        if (!line.includes('text-eyebrow')) continue
        expect(line, `${f}: the eyebrow token is being used as body chrome\n  ${line.trim()}`)
          .toContain('uppercase')
      }
    }
  })

  test('a desktop row uses columns as its separator, not a dot', () => {
    // 65 `·` on Now, painted in `ink-600` at 1.58:1 — the only elements in the
    // product that failed contrast. The table has no separators because the
    // columns are the separator; the phone's two-line row keeps one muted run,
    // which is what the layout there is, and it is `--fg-mute` at 7.2:1.
    const table = read('src/web/components/CardTable.tsx')
    const row = table.slice(table.indexOf('export function CardRow('), table.indexOf('export function CardLine('))
    expect(row, 'a separator came back into the table row').not.toContain('·')
  })

  test('help text cannot come back through a component prop', () => {
    // Sixty-one explanatory strings shipped across five routes and six overlays.
    // Removing the prop is what stops them returning without a code change.
    const primitives = read('src/web/components/primitives.tsx')
    const field = primitives.slice(primitives.indexOf('export function Field('))
    expect(field.slice(0, 300), 'Field grew a hint again').not.toMatch(/\bhint\b/)

    // The Now page's own section header had the same prop. It is `GroupHead`
    // now, and it takes a count, not a sentence.
    const table = read('src/web/components/CardTable.tsx')
    const head = table.slice(table.indexOf('export function GroupHead('))
    expect(head.slice(0, 400), 'the group header grew a hint').not.toMatch(/\bhint\b/)

    // And Pulse's chart panel, which carried six of them: `tasks finished each
    // day` under `Throughput`, `what is piling up, and how stale it is` under
    // `Ageing`. The prop is what let them exist, so the prop is what is gone.
    const pulse = read('src/web/pages/Pulse.tsx')
    const panel = pulse.slice(pulse.indexOf('function Panel('))
    expect(panel.slice(0, 300), 'the Pulse panel grew a hint').not.toMatch(/\bhint\b/)
    expect(pulse, 'a Pulse panel is being given a hint').not.toMatch(/<Panel[^>]*\shint=/)
    for (const f of tsx) {
      expect(read(f), `${f}: a Field is being given a hint`).not.toMatch(/<Field[^>]*\shint=/)
    }
  })
})

describe('the shell reaches everywhere from both places', () => {
  const app = read('src/web/App.tsx')

  test('all five destinations are on the phone bar', () => {
    // Pulse and Settings used to live behind a More sheet: two taps and a
    // dismissal at exactly the moment something is broken.
    expect(app, 'the phone bar filters the destination list again')
      .not.toMatch(/TABS\.filter\([^)]*mobile/)
    expect(app, 'the More sheet came back').not.toMatch(/\bsetMore\b/)
  })

  test('navigating keeps the harness flag and drops the page-local filter', () => {
    const route = read('src/web/lib/route.ts')
    expect(route, 'go() dropped the query string again').toContain('CARRIED')
    expect(route).toMatch(/'static'/)
  })

  test('the filter and the open row both live in the URL', () => {
    const home = read('src/web/pages/Home.tsx')
    expect(home, 'the source filter went back into useState').toMatch(/useParam\('src'\)/)
    expect(home, 'the open row went back into useState').toContain('useDetailKey')
    const route = read('src/web/lib/route.ts')
    // Opening a row is a push so Back closes it; a filter is a replace so twenty
    // filter clicks are not twenty presses of Back.
    expect(route).toMatch(/openDetail[\s\S]{0,400}pushState/)
    expect(route).toMatch(/setParam[\s\S]{0,400}replaceState/)
  })
})

describe('a destructive key cannot fire through a modal', () => {
  test('the Now shortcuts ask whether an overlay is open', () => {
    // `e` (Done) and `s` (Later) are unmodified, unconfirmed keys bound to the
    // document. A `role="dialog"` panel is not an INPUT, so they used to fire
    // straight through one — and the undo toast rendered under the scrim.
    const home = read('src/web/pages/Home.tsx')
    expect(home, 'the keyboard handler stopped checking for an overlay').toContain('overlayOpen()')
  })

  test('every modal surface counts itself', () => {
    const primitives = read('src/web/components/primitives.tsx')
    const palette = read('src/web/components/palette.tsx')
    expect(primitives, 'Sheet stopped registering as an overlay').toContain('useOverlay(open)')
    expect(palette, 'the palette stopped registering as an overlay').toContain('useOverlay(open)')
  })

  test('the body scroll lock has exactly one owner', () => {
    // `Sheet` used to capture and restore `body.style.overflow` itself, and Work
    // mounts two sheets at once — so two closing in the wrong order restored
    // `hidden` over `''` and froze the page behind them.
    const overlay = read('src/web/lib/overlay.ts')
    expect(overlay).toContain("document.body.style.overflow")
    for (const f of web.filter(x => !x.endsWith('lib/overlay.ts'))) {
      expect(read(f), `${f}: a second owner of the body scroll lock`)
        .not.toMatch(/body\.style\.overflow/)
    }
  })
})

describe('nothing waits on a frame in a hidden document', () => {
  test('focus is not scheduled through requestAnimationFrame', () => {
    // A hidden document schedules no animation frames, so a focus queued in one
    // simply never happens — the palette opens with nothing focused and the
    // brief's caret never restores. `useStill` covers animation and not this.
    for (const f of web) {
      const src = read(f)
      for (const m of src.matchAll(/requestAnimationFrame\(([\s\S]{0,120})/g)) {
        expect(m[1], `${f}: a focus call is waiting on an animation frame`)
          .not.toMatch(/\.focus\(\)|setSelectionRange/)
      }
    }
    expect(true).toBe(true)
  })
})

describe('the hand-off has to be a real link', () => {
  test('Open in Claude is an anchor, not a scripted window.open', () => {
    // This is the whole reason the flow has two steps. On iOS,
    // `https://claude.ai/…` is a universal link and only a genuine link
    // navigation hands it to the Claude app; `window.open(url)` after an await
    // lands in Safari instead, which is exactly what this change was for.
    const sheet = read('src/web/components/launch.tsx')
    // An anchor with a real href and target=_blank, not a button that navigates.
    // The variable name is not the contract; the element is.
    const anchor = /<a\b[\s\S]{0,400}?href=\{[^}]*\.url\}[\s\S]{0,400}?target="_blank"/
    expect(sheet, 'the Open control is no longer a real link').toMatch(anchor)
    expect(sheet, 'the hand-off went back to a scripted open').not.toMatch(/window\.open\s*\(/)
    // preventDefault on that click would cancel the navigation the link exists for.
    expect(sheet, 'the hand-off cancels its own navigation').not.toMatch(/preventDefault/)
  })

  test('the server never spawns the claude binary', () => {
    // Wake used to run `claude -p` on the DevBox: a headless process with no
    // terminal, whose output nobody saw and whose permission prompts nobody
    // could answer. Nothing should reintroduce it.
    //
    // Printing `claude --resume …` for a human to paste is a different thing and
    // stays allowed — the test is about spawning, not about mentioning.
    for (const f of walk('src/server')) {
      const src = read(f)
      expect(src, `${f}: reintroduced the launcher binary`).not.toContain('CLAUDE_BIN')
      for (const m of src.matchAll(/Bun\.spawn(?:Sync)?\(\s*\[([^\]]*)\]/g)) {
        expect(m[1], `${f}: spawns claude`).not.toMatch(/['"`]claude/)
      }
    }
  })
})

describe('the brief is reviewable before it goes', () => {
  const sheet = read('src/web/components/launch.tsx')

  test('the text handed over is the text in the editor', () => {
    // Wake renders a first draft; what goes is what was approved. A link built
    // from anything other than the edited field would make the review theatre.
    expect(sheet).toMatch(/handoffFor\(brief,/)
    expect(sheet).toMatch(/launchApi\.open\(packId, brief\)/)
  })

  test('the brief and the instruction can both be dictated', () => {
    expect([...sheet.matchAll(/<Mic\b/g)].length, 'a Mic went missing').toBeGreaterThanOrEqual(2)
  })

  test('the count comes from the same code the link does', () => {
    // Two implementations of "how much fits" drift, and the failure is the worst
    // kind: the editor says it all fits and the link quietly carries less.
    expect(sheet).toContain("from '../../shared/handoff'")
    expect(read('src/server/claudecode/handoff.ts')).toContain("from '../../shared/handoff'")
  })
})

describe('both themes stay complete', () => {
  const css = read('src/web/styles.css')

  /** The custom properties declared inside one `{ … }` block. */
  const tokensIn = (marker: string) => {
    const at = css.indexOf(marker)
    if (at === -1) throw new Error(`styles.css no longer contains ${marker}`)
    const body = css.slice(at, css.indexOf('\n  }', at))
    return new Set([...body.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map(m => m[1]!))
  }

  const dark = tokensIn(":root[data-theme='dark'] {")
  const light = tokensIn(":root[data-theme='light'] {")
  const system = tokensIn(":root:not([data-theme]) {")

  test('every colour exists in light, dark, and the system fallback', () => {
    // A token added to one block and forgotten in another does not error — it
    // silently inherits the other theme's value, which is how a light-mode page
    // ends up with one black card on it.
    expect([...dark].filter(t => !light.has(t)), 'declared in dark but not light').toEqual([])
    expect([...light].filter(t => !dark.has(t)), 'declared in light but not dark').toEqual([])
    expect([...light].filter(t => !system.has(t)), 'missing from the system fallback').toEqual([])
  })

  test('the system fallback matches the explicit light theme exactly', () => {
    // They are the same palette reached two ways. Letting them drift means
    // "System" and "Light" render differently on the same machine.
    const values = (marker: string) => {
      const at = css.indexOf(marker)
      const body = css.slice(at, css.indexOf('\n  }', at))
      return [...body.matchAll(/(--color-[a-z0-9-]+)\s*:\s*([^;]+);/g)]
        .map(m => `${m[1]}:${m[2]!.trim()}`)
        .sort()
    }
    expect(values(":root:not([data-theme]) {")).toEqual(values(":root[data-theme='light'] {"))
  })

  test('no component hard-codes a colour that cannot follow the theme', () => {
    // A literal hex in a component is a colour that stays put when the theme
    // moves. The palette lives in styles.css; everything else references a token.
    const allowed = /NOTE_COLORS|palette|swatch/i
    for (const f of web.filter(x => !x.endsWith('styles.css'))) {
      for (const line of read(f).split('\n')) {
        if (allowed.test(line) || !/#[0-9a-fA-F]{6}\b/.test(line)) continue
        throw new Error(`${f}: hard-coded colour — use a --color-* token\n  ${line.trim()}`)
      }
    }
    expect(true).toBe(true)
  })
})

describe('a source nobody connected is not a healthy sync', () => {
  // `ok: 1, count: 0` was recorded for a source with no account attached, and
  // the Home page rendered that as "Slack, just now" — a fresh, successful
  // sync of something that does not exist. The two facts are now separate.
  const server = walk('src/server')
  const readSrv = (f: string) => readFileSync(f, 'utf8')

  test('no adapter answers a missing credential with an empty list', () => {
    for (const f of server.filter(f => f.includes('/sources/') && !f.endsWith('types.ts'))) {
      const src = readSrv(f)
      // The shape being outlawed: `if (!token) return []`.
      expect(src, `${f}: a missing credential is reported as a successful empty poll`)
        .not.toMatch(/if\s*\(!\s*(token|tok|t)\s*\)\s*return\s*\[\]/)
    }
  })

  test('the run records whether there was anything to poll', () => {
    const ingest = readSrv('src/server/ingest.ts')
    expect(ingest).toContain('NotConnected')
    expect(ingest).toMatch(/connected\s*=/)
    expect(readSrv('src/server/api.ts'), '/state stopped reporting `connected`')
      .toMatch(/SELECT source, MAX\(started_at\) AS at, ok, connected/)
  })

  test('the sync line distinguishes all three states', () => {
    const home = readFileSync('src/web/pages/Home.tsx', 'utf8')
    expect(home).toContain('not connected')
    expect(home).toContain('sync failed')
  })
})
