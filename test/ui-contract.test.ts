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
    // `actions.restore(g)` with no second argument clears EVERYTHING keeping a
    // card off the desk. That is right for "bring this back", and wrong for an
    // undo: it also drops a due date and a manual placement that had nothing to
    // do with the action being reversed, which is how one Undo click destroyed
    // a deferral the product could not re-create. Every toast that offers an
    // Undo has to restore a named target.
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

  test('what he finished is reachable without a card to open', () => {
    // The detail is unreachable once a card is off the desk, so the route back
    // cannot start from the card. It used to be a collapsed fourth chapter at
    // the foot of the page with its own row shape and its own restore button;
    // it is the same table with its Status filter set now, so every other
    // filter still applies and the control that put a card away is the control
    // that takes it back out.
    const app = read('src/web/App.tsx')
    expect(app, 'no palette command reaches what he finished').toMatch(/cards:status-done/)
    expect(app, 'the command does not set the filter it names')
      .toMatch(/cards:status-done[\s\S]{0,400}setParam\('status'/)
    expect(app, 'the filter it sets is not Done').toMatch(/setParam\('status', ?'done'\)/)

    const home = read('src/web/pages/Home.tsx')
    expect(home, 'the fourth chapter came back').not.toMatch(/Done and not mine/)
    expect(home, 'the settled list cannot fetch what it shows').toContain('actions.doneCards')
    expect(home, 'nothing brings a card back').toContain('actions.restore')
  })
})

describe('the console does not become a feed again', () => {
  const tsx = web.filter(f => f.endsWith('.tsx'))

  test('the desk is one table with a shared colgroup', () => {
    // One `<colgroup>` is what holds an x-position down the page; a list of divs
    // cannot. And there is exactly ONE `<tbody>` now — the three chaptered
    // groups are gone, because where a card stands is a value he sets rather
    // than a heading the machine writes above it.
    const table = read('src/web/components/CardTable.tsx')
    expect(table).toContain('<colgroup>')
    expect(table).toMatch(/<thead/)
    const home = read('src/web/pages/Home.tsx')
    expect(home).toContain('<table')
    expect(home).toContain('TableCols')
    expect((home.match(/<tbody>/g) ?? []).length, 'the desk went back to chaptered groups')
      .toBe(1)
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

    // The desk's own group header carried the same prop. Both the prop and the
    // component are gone: there are no groups to head.
    expect(read('src/web/components/CardTable.tsx'), 'the chaptered group header came back')
      .not.toMatch(/export function GroupHead\(/)

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
    for (const f of web) {
      expect(read(f), `${f}: a hidden overflow menu came back`).not.toMatch(/\bsetMore\b/)
    }
  })

  test('navigating keeps the harness flag and drops the page-local filter', () => {
    const route = read('src/web/lib/route.ts')
    expect(route, 'go() dropped the query string again').toContain('CARRIED')
    expect(route).toMatch(/'static'/)
  })

  test('an open card does not cover the phone bar', () => {
    // The detail sheet is `fixed bottom-0 z-50` at 55dvh, and the bar is 53px
    // at `bottom-0` under it: `elementFromPoint` returned something other than
    // the button at all six destinations, and the screenshots show no bar at
    // all. Desk → Mail cost a dismissal first. This is a push sheet — the list
    // stays live underneath it — so the shell has to stay live under that.
    const css = read('src/web/styles.css')
    expect(css, 'the strip the bar owns is no longer measured anywhere')
      .toMatch(/--nav-h:/)
    const home = read('src/web/pages/Home.tsx')
    const sheet = home.slice(home.indexOf('function PushDetail('))
    expect(sheet, 'the sheet went back to sitting on the bottom edge')
      .toMatch(/bottom: 'var\(--nav-h\)'/)
    expect(sheet, 'the sheet can grow over the bar again')
      .toMatch(/maxHeight: '[^']*--nav-h/)
  })

  test('the filter and the open row both live in the URL', () => {
    const home = read('src/web/pages/Home.tsx')
    // Either subscription shape. The desk reads six params at once now, so it
    // takes the plural — what is being pinned is that `src` comes out of the
    // address bar and not out of component state.
    expect(home, 'the source filter went back into useState').toMatch(/useParams?\(\[?[^)]*'src'/)
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

  /**
   * AMENDED, deliberately — see DECISIONS.md #31.
   *
   * This used to assert that no file under `src/server` mentioned `CLAUDE_BIN`
   * or spawned `claude`, on the reasoning in DECISIONS #26: a headless process
   * with no terminal, whose output nobody saw and whose permission prompts
   * nobody could answer. That reasoning is about an *interactive* session, and
   * Fetch is not one — it is a bounded, read-only, allowlisted collection with
   * no writes and no approvals, and it is the only way the desk fills at all
   * while Wake's own Slack login is refused by the provider and Gmail publishes
   * no credential Wake can obtain.
   *
   * So the ban is gone and the invariant it was standing in for is written down
   * instead: exactly one spawn site, non-interactive, read-only, bounded. Every
   * clause below is a way Fetch could quietly turn into an agent.
   */
  test('Fetch is the only thing that starts a model, and it starts a bounded read-only one', () => {
    const COLLECTOR = 'src/server/fetch/claude.ts'
    const spawnSites: string[] = []

    for (const f of walk('src/server')) {
      const src = read(f)
      // A spawn site for this purpose is a file that both starts processes and
      // names the binary. `gh` and `truto` start processes and name neither, so
      // they are not this test's business; `env.ts` names it and starts nothing.
      const startsProcesses = /Bun\.spawn(?:Sync)?\(/.test(src)
      const namesTheBinary = /CLAUDE_BIN/.test(src) ||
        /Bun\.spawn(?:Sync)?\(\s*\[\s*['"`]claude/.test(src)
      if (startsProcesses && namesTheBinary) spawnSites.push(f)

      // `env.ts` declares it, the collector uses it, and that is the whole list.
      if (f === COLLECTOR || f.endsWith('src/server/env.ts')) continue
      expect(src, `${f}: a second file reaches for the claude binary`).not.toContain('CLAUDE_BIN')
    }

    expect(spawnSites, 'the claude binary is spawned somewhere other than Fetch\'s collector')
      .toEqual([COLLECTOR])

    const collector = read(COLLECTOR)

    // Non-interactive. `--print` is what makes "nobody can answer a permission
    // prompt" impossible rather than merely unlikely.
    expect(collector, 'the collector dropped --print and can now open a session')
      .toMatch(/'--print'/)

    // Bounded. A collection that can run for ever, or take another turn to look
    // a bit deeper, is an agent.
    expect(collector, 'the collector lost its turn ceiling').toMatch(/'--max-turns'/)
    expect(collector, 'the collector lost its wall-clock timeout')
      .toMatch(/setTimeout\([\s\S]{0,140}?proc\.kill\(\)/)

    // Read-only. The allowlist is explicit tool names, and not one of them may
    // be write-shaped. A wildcard would allow a whole server, writes included.
    const list = /export const READ_TOOLS[\s\S]*?\n}\n/.exec(collector)
    expect(list, 'the read-only tool allowlist is gone').toBeTruthy()
    const tools = [...list![0].matchAll(/'(mcp__[A-Za-z0-9_]+)'/g)].map(m => m[1]!)
    expect(tools.length, 'the allowlist is empty, which allows everything').toBeGreaterThan(0)
    for (const t of tools) {
      expect(t, `${t} is a write-shaped tool name in a read-only allowlist`)
        .not.toMatch(/send|reply|create|update|delete|trash|label|post|draft|spam|archive|modify|write/i)
    }
    expect(collector, 'the allowlist became a wildcard').not.toMatch(/mcp__[A-Za-z0-9_]*\*/)

    // One shot. No session to resume, no conversation to continue.
    for (const flag of ['--resume', '--continue', '--dangerously-skip-permissions']) {
      expect(collector, `the collector gained ${flag}`).not.toContain(flag)
    }
  })

  test('Fetch takes no text from anywhere', () => {
    // The property that keeps it a collector rather than a chat box: the
    // question is a constant. Nothing a person can type reaches the prompt.
    //
    // This used to be pinned as "the route reads no body at all", which was the
    // right invariant wearing the wrong clothes. Fetch can now be scoped to one
    // source, so the route does read a body — and the guarantee has to be
    // stated as what it always meant: whatever comes off the wire is checked
    // against a closed set before it reaches anything, and the prompt itself is
    // still a constant chosen by connector. A free string would fail the second
    // assertion below even though it passes the first.
    const orchestrator = read('src/server/fetch/index.ts')
    expect(orchestrator, 'promptFor started taking an argument other than the connector')
      .toMatch(/function promptFor\(name: Connector\)/)

    const api = read('src/server/api.ts')
    const route = /api\.post\('\/fetch'[\s\S]{0,400}?\n\}\)/.exec(api)?.[0] ?? ''
    expect(route, 'the fetch route vanished or changed shape').toContain('startFetch')
    expect(route, 'fetch started reading the query string, which nothing validates')
      .not.toMatch(/req\.query|req\.param/)

    // The one value it accepts is checked against the closed scope list, and
    // checked FIRST. Asserting only that the guard is present would pass a
    // route that ran it after the collection had already started, so this is an
    // ordering claim rather than a presence one.
    const guard = route.indexOf('isFetchScope(only)')
    const start = route.indexOf('startFetch')
    expect(guard, 'the fetch route stopped validating its body against the scope list')
      .toBeGreaterThan(-1)
    expect(guard, 'the scope guard runs after the collection it was meant to gate')
      .toBeLessThan(start)

    const scopes = /export const FETCH_SCOPES = \[([^\]]*)\]/.exec(orchestrator)?.[1] ?? ''
    expect(scopes.split(',').filter(Boolean), 'the scope list is no longer a closed set of sources')
      .toHaveLength(5)
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
    expect(readSrv('src/server/api.ts'), '/state stopped reporting the latest run')
      .toContain('latestFinishedRuns')
    expect(readSrv('src/server/connections.ts'), 'Settings lastSync used the GROUP BY lie')
      .toContain('latestFinishedRuns')
    expect(readSrv('src/server/db.ts'), 'latestFinishedRuns must take ok/connected from the same row as MAX(started_at)')
      .toMatch(/JOIN \([\s\S]*MAX\(started_at\)/)
  })

  /**
   * AMENDED. The three states are the same; the place they are said has moved.
   *
   * `SyncLine` was a five-clause 12px paragraph at the foot of Now — measured at
   * y=1324 in a 900px viewport, wrapping mid-list, beginning its second line
   * with an orphan interpunct, and ending in amber about a broken source. It is
   * deleted rather than shortened: failure belongs on the chip you are about to
   * press, and on the row in Settings where you would go to fix it. Now still
   * has to be able to tell the three states apart, so the assertion stays and
   * points at the chip's own title.
   */
  test('a held Slack token is Reconnect, not Disconnect, when the poll failed', () => {
    const settings = readFileSync('src/web/pages/Settings.tsx', 'utf8')
    expect(settings, 'Reconnect was folded back into Disconnect').toContain("'Reconnect'")
    const fn = settings.slice(settings.indexOf('export function stateWord'), settings.indexOf('function AuditSheet'))
    expect(fn, 'stateWord forgot hasWakeToken').toContain('hasWakeToken')
    expect(fn, 'the not-connected lie came back as the first branch')
      .not.toMatch(/if \(!s\.lastSync\?\.connected && !s\.ok\)/)
  })

  test('Now still distinguishes all three states, on the chip', () => {
    const home = readFileSync('src/web/pages/Home.tsx', 'utf8')
    expect(home).toContain('not connected')
    expect(home).toContain('sync failed')
    expect(home, 'the wrapping five-source paragraph came back').not.toMatch(/function SyncLine/)
  })
})

describe('a page has no panels on it', () => {
  test('nothing on a page wraps itself in a card', () => {
    // Settings shipped nine `rounded-panel bg-ink-850 border border-edge p-4`
    // sections in an `items-start` masonry: 160–192px of ragged bottom, a
    // 789×302 hole beside a full column, every section title inset 17px past the
    // page title, and — in light mode, where `ink-850` is pure white — nine
    // white cards on a grey page. A sheet may have an edge. A page may not.
    for (const f of web.filter(x => x.includes('/pages/'))) {
      const src = read(f)
      for (const line of src.split('\n')) {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue
        expect(line, `${f}: a page is drawing a panel\n  ${line.trim()}`)
          .not.toMatch(/rounded-panel[^'"`]*border-edge|border-edge[^'"`]*rounded-panel/)
      }
    }
  })

  test('the page pad has exactly one owner', () => {
    // Four horizontal page pads were in use on the laptop — 12, 16, 20 and 24 —
    // plus the table's own `px-2` on top, so the page title sat at x=216 on Now
    // and x=224 on Settings and every heading moved 8px when you switched tabs.
    // `.pad-x` is the only thing that may set one.
    const css = read('src/web/styles.css')
    expect(css, 'the page pad utility is gone').toContain('.pad-x')
    for (const f of web.filter(x => x.includes('/pages/'))) {
      for (const line of read(f).split('\n')) {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue
        // 16, 20 and 24 were the page pads. 8 and 12 are a control's own
        // padding and are not this rule's business.
        const m = /className[^\n]*?\b((?:sm:|lg:|xl:)?px-[456])\b/.exec(line)
        if (m) throw new Error(`${f}: ${m[1]} — the page pad is \`.pad-x\`\n  ${line.trim()}`)
      }
    }
  })

  test('a filter that matches nothing is one line', () => {
    // Three headings with zeroes beside them and an apology under each cost
    // 331px of an 844px phone to say nothing at all. There is one list now, so
    // there is one empty state, and it is one word on the row grid.
    const home = read('src/web/pages/Home.tsx')
    expect(home, 'the desk went back to rendering a chapter per pile')
      .toMatch(/rows\.length === 0/)
    expect(home, 'the per-group empty phrase came back').not.toMatch(/emptyWord/)
    const table = read('src/web/components/CardTable.tsx')
    expect(table, 'EmptyRow came back').not.toMatch(/export function EmptyRow/)
  })

  test('a count is not asserted before it is known', () => {
    // `GET /api/mail/threads` measured 2834-4742ms on the box, and `threads`
    // starts as `[]` — so the header counted it and said zero, and the column
    // mapped it and painted nothing, for four seconds before either knew. Both
    // claims wait for an answer now, and the column carries the row shape in the
    // meantime so an inbox that has not replied does not read as an empty one.
    //
    // This is asserted by reading the source because it cannot be observed on
    // the deployed box: Gmail resolves no token there, so Mail renders its
    // two-line down state and the list never loads at all.
    const mail = read('src/web/pages/Mail.tsx')
    expect(mail, 'the thread list stopped tracking whether it has an answer')
      .toMatch(/const \[answered, setAnswered\] = useState\(false\)/)
    expect(mail, 'the header went back to counting an array it has not filled')
      .toMatch(/list\.answered && <span[^>]*>\{list\.threads\.length\}/)
    expect(mail, 'the empty state is claimed before the list has answered')
      .toMatch(/list\.answered && !list\.threads\.length && <Empty \/>/)
    expect(mail, 'the first load paints an empty column again')
      .toMatch(/!list\.answered && !list\.threads\.length && <ArrivingRows \/>/)
    // And a new box or a new search is a new question, so the count goes back to
    // saying nothing rather than reporting the previous box's total.
    expect(mail, 'switching box keeps the old answer').toMatch(/setAnswered\(false\)\n\s*void load/)
  })
})

describe('a page never scrolls sideways', () => {
  /*
   * These read the source, not a viewport.
   *
   * The real assertion — `documentElement.scrollWidth <= clientWidth` at 360,
   * 390, 414 and 640 — needs a layout engine, and a layout engine is a browser
   * dependency this suite does not have and should not grow for one rule. So
   * the mechanism is pinned structurally instead: the measurement lives in the
   * screenshot harness, and these keep the two pieces of CSS that make it come
   * out clean from being edited away by a plausible-looking change.
   */

  const tsx = web.filter(f => f.endsWith('.tsx'))

  test('the page column clips its own horizontal overflow', () => {
    // `.hit` hangs a touch target 6px past a control's box on a coarse pointer,
    // and an absolutely positioned box is scrollable overflow whatever it is
    // for. On `/work` the amber `+ Task` is the rightmost thing in the column,
    // so the phone's layout viewport widened to 396 on a 390 screen, the fixed
    // tab bar followed it out, and every width scrolled by exactly 6px.
    const app = read('src/web/App.tsx')
    expect(app, 'the page column stopped clipping and `.hit` can push it wide again')
      .toMatch(/<main className=\{`[^`]*\boverflow-x-clip\b/)
    // `hidden` would make `main` a scroll container; `clip` does not.
    expect(app, 'the page column became a scroll container').not.toMatch(
      /<main className=\{`[^`]*\boverflow-x-hidden\b/,
    )
  })

  test('the touch target is still scoped to fingers', () => {
    // The outset is the thing that overflows. It is worth having, and it is
    // only worth having where there is no mouse — this is what keeps the
    // laptop out of the blast radius entirely.
    const css = read('src/web/styles.css')
    const hit = /@media \(any-pointer: coarse\) \{\s*\.hit::after \{/
    expect(css, '`.hit` left its coarse-pointer scope').toMatch(hit)
  })

  test('every touch target hangs off the control it belongs to', () => {
    // The outset is `position: absolute; inset: -6px`, and that only means "6px
    // around this control" if the control is itself a containing block. Without
    // `relative` the box resolves against the nearest positioned ancestor —
    // `<main>` — so what the control gets is not a collar but a transparent,
    // tap-eating sheet the size of the whole page column. Later content paints
    // over most of it, which is why it does not look like anything; it shows up
    // as a phone that ignores taps in the empty parts of a page. The Due cell
    // and the Work tabs both shipped that way.
    const positioned = /(^|\s)relative(\s|$)/
    const primitives = read('src/web/components/primitives.tsx')
    const sizes = /const SIZE: Record<ButtonSize, string> = \{([^}]*)\}/.exec(primitives)?.[1] ?? ''
    expect(sizes, 'the button size table moved').toContain('hit')

    for (const f of tsx) {
      for (const lit of read(f).match(/`[^`]*`|'[^'\n]*'|"[^"]*"/g) ?? []) {
        const cls = lit.slice(1, -1)
        if (!/(^|\s)hit(\s|$)/.test(cls)) continue
        // `Button` is the one indirection: the size table hands `hit` to a base
        // class list that carries the `relative`, which is checked below.
        if (f.endsWith('primitives.tsx') && sizes.includes(lit)) continue
        expect(cls, `${f}: \`hit\` on a control with no containing block\n  ${cls.split('\n')[0]}`)
          .toMatch(positioned)
      }
    }

    expect(primitives, '`Button` stopped positioning the box its sizes ask for')
      .toMatch(/className=\{`relative[^`]*\$\{SIZE\[size\]\}/)
  })

  test('the phone bar keeps six destinations and its target', () => {
    // The offender scan named this bar, because it is what visibly widened.
    // It was the symptom. It must not be "fixed" by dropping a destination or
    // shrinking the target, which is what a scroll report usually buys.
    const app = read('src/web/App.tsx')
    const tabs = app.match(/^\s*\{ path: '/gm) ?? []
    expect(tabs.length, 'a destination left the tab bar').toBe(6)
    expect(app, 'the tab target dropped below 44px').toMatch(/min-h-12/)
    expect(app, 'the waiting badge lost its accent').toMatch(/bg-accent text-on-accent/)
  })
})

describe('a chart is drawn only when there is a chart to draw', () => {
  test('a series with one marked day is a row, not an axis', () => {
    // `THROUGHPUT`, `ARRIVED` and `CLEARED` each drew seven day-slots across
    // 572px and painted one 12px bar at the far right. An axis exists to put a
    // value beside the values around it; with one day there is nothing to put
    // it beside, so it takes the same one-line row an empty series takes.
    const pulse = read('src/web/pages/Pulse.tsx')
    expect(pulse, 'the sparse test is gone').toMatch(/marked\.length < 2/)
    // `appeared` is not in this list any more: Arrived folded into Flow.
    for (const series of ['done', 'clearedShape']) {
      expect(pulse, `${series} stopped asking whether it has a shape`)
        .toMatch(new RegExp(`empty: ${series}\\.thin`))
    }
    // And it says its number rather than an em dash it would be lying with.
    expect(pulse, 'a series with a value went back to printing an em dash')
      .toMatch(/\{p\.value \?\? '—'\}/)
  })

  test('a sparse series compacts to its own extent', () => {
    // The floor was 7 — a week, which is a fact about calendars and not about
    // this series. A two-day extent was padded back out to seven slots and
    // labelled `08-24 … 08-30` over two marks: the same long empty axis the
    // compaction exists to remove, five sevenths of the way.
    const charts = read('src/web/components/charts.tsx')
    const m = /const MIN_SLOTS = (\d+)/.exec(charts)
    expect(m, 'MIN_SLOTS is gone').not.toBeNull()
    expect(Number(m![1]), 'the slot floor grew back past a short extent')
      .toBeLessThanOrEqual(4)
  })
})

describe('one surface spends the accent once', () => {
  test('the task trigger hands its fill to the sheet it opened', () => {
    // With the sheet up the probe found `+ Task` and `Add task` both painted in
    // the accent. The commit earns it; a trigger already pressed and sitting
    // behind a scrim does not.
    const work = read('src/web/pages/Work.tsx')
    expect(work, 'the page stopped noticing that a sheet is up')
      .toMatch(/const sheetOpen = creating \|\| editing !== null \|\| goalEditing !== null/)
    expect(work, 'the trigger went back to being unconditionally amber')
      .toMatch(/variant=\{sheetOpen \? 'default' : 'primary'\}/)
    // The commit keeps it.
    expect(read('src/web/components/TaskSheet.tsx'), 'the commit lost its fill')
      .toMatch(/variant="primary"/)
  })
})


/**
 * The vocabulary, made irreversible.
 *
 * Seven words left this product in one wave — `Now` as a place, `Open` as a
 * pile, `Parked`, `Later`, `Not mine`, `Wake now`, `DM` — and a rename that is
 * only in the diff comes back one plausible edit at a time. These are the
 * assertions that make it stick. Where the work stands is exactly five words:
 * Not started, In progress, In review, Done, Won't do. The first destination is
 * Desk. `Open` survives only as the verb on a button.
 */
describe('the dead words stay dead', () => {
  const tsx = web.filter(f => f.endsWith('.tsx'))

  /** Source with every comment removed, so a note about history is not a label. */
  const speech = (f: string) =>
    read(f)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n')

  test('no component says a word the product no longer has', () => {
    const BANNED = [
      'Parked', 'Not mine', 'Wake now', 'Later today', 'Move to',
      'Bring it back', 'Done and not mine', 'Let Wake decide',
    ]
    for (const f of tsx) {
      const src = speech(f)
      for (const word of BANNED) {
        expect(src, `${f}: the product says "${word}" again`).not.toContain(word)
      }
    }
  })

  test('a pile is never a label', () => {
    // The machine's own classification is still on the wire and still sorts the
    // list. It is not a heading, a chip or a sentence: reading it as one made a
    // guess about urgency look like a decision he had made.
    for (const f of tsx) {
      const src = speech(f)
      for (const m of src.matchAll(/'[^'\n]*\bpiles?\b[^'\n]*'|>[^<>{}\n]*\bpiles?\b[^<>{}\n]*</gi)) {
        throw new Error(`${f}: a pile is being shown to a person\n  ${m[0].trim()}`)
      }
    }
    expect(true).toBe(true)
  })

  test('there is no direct-message concept left anywhere', () => {
    // DMs are not collected at all now. The field name and the literal both go,
    // because a dead branch that still parses is a branch somebody re-enables.
    for (const f of [...walk('src/server'), ...web]) {
      const src = read(f)
      expect(src, `${f}: is_dm came back`).not.toContain('is_dm')
      expect(src, `${f}: a 'dm' kind came back`).not.toContain("'dm'")
    }
  })

  test('nothing in the product is an emoji', () => {
    // Push notification bodies are the one exception, and they are the one
    // surface the operating system renders rather than this design does.
    for (const f of web) {
      const m = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.exec(read(f))
      if (m) throw new Error(`${f}: an emoji reached the DOM — ${m[0]}`)
    }
    expect(true).toBe(true)
  })
})

/**
 * Everything is in one visible view.
 *
 * A menu behind a glyph is where controls go to be forgotten: the overflow menu
 * this replaces held every deferral control in the product, opened them 1400px
 * below the viewport, and was the reason nobody could find them. A control
 * worth hiding was worth a button; one not worth a button was not worth
 * shipping.
 */
describe('nothing hides behind a glyph', () => {
  test('there is no overflow menu, anywhere, for any reason', () => {
    for (const f of web) {
      const src = read(f)
      expect(src, `${f}: an overflow menu came back`)
        .not.toMatch(/MoreHorizontal|MoreVertical|EllipsisVertical/)
      expect(src, `${f}: an overflow trigger came back`).not.toContain('More actions')
      expect(src, `${f}: an ellipsis trigger came back`).not.toContain('⋯')
    }
  })

  test('the detail pane shows status, priority and due without being asked', () => {
    // All three used to be behind the menu. They are the three facts a person
    // opens a card to change, so they are the three that are never hidden.
    const detail = read('src/web/components/CardDetail.tsx')
    for (const label of ['Status', 'Priority', 'Due']) {
      expect(detail, `the ${label} control went back behind a menu`)
        .toMatch(new RegExp(`<Row label="${label}"`))
    }
  })
})

/**
 * Every repeating list pages, and pages the same way.
 *
 * `slice(0, 40)` is not pagination — it is a silent floor under everything past
 * the fortieth row, and the reader is never told. One `Pager`, one `PAGE_SIZE`,
 * and the page in the URL so a reload and the Back button both work.
 */
describe('a long list is paged, not truncated', () => {
  const PAGED = [
    'src/web/pages/Home.tsx',
    'src/web/pages/Settings.tsx',
    'src/web/components/sessions.tsx',
  ]

  test('every repeating row list reaches for the one pager', () => {
    for (const f of PAGED) {
      // A file that has not landed yet cannot be asserted about; App.tsx
      // imports each of these, so a missing one fails the build rather than
      // slipping through here.
      let src: string
      try { src = read(f) } catch { continue }
      expect(src, `${f}: a repeating list that does not page`).toContain('Pager')
    }
  })

  test('the page lives in the URL', () => {
    // A page held in `useState` cannot be bookmarked and does not survive the
    // reload that happens mid-triage — the same reason the filter is a param.
    expect(read('src/web/pages/Home.tsx'), 'the desk page went back into useState')
      .toMatch(/setParam\('page'/)
  })

  test('the page in the URL is not clamped before the list has arrived', () => {
    // Measured: `/?page=3` became `/` about 40ms after load, while the table
    // still held zero rows. The clamp effect runs on the first commit, when
    // `state` is null — so `rows.length` is 0, `pageCount` answers 1, and every
    // reloaded or bookmarked page-N link landed on page 1 and rewrote itself on
    // the way. An unread list and an empty one have to be distinguishable
    // before anything is allowed to move the reader off a page.
    const home = read('src/web/pages/Home.tsx')
    expect(home, 'the desk cannot tell an unread list from an empty one')
      .toMatch(/const loaded = /)
    expect(home, 'the page clamp fires again before any card exists to count')
      .toMatch(/if \(!loaded\) return\s*\n\s*if \(page > pages\)/)
  })

  test('how the desk is ordered lives in the URL beside what it shows', () => {
    // There was no ordering at all: the Due header was inert, so an overdue
    // card sat below one due in three weeks and the only way to find what was
    // due soonest was to read all 112 rows. It is a URL parameter rather than
    // header state for the same reason the filter and the page are — it has to
    // survive a reload and go in a bookmark.
    const home = read('src/web/pages/Home.tsx')
    expect(home, 'the desk lost its ordering control').toMatch(/setParam\('sort'/)
    expect(home, 'the order stopped being read from the address bar')
      .toMatch(/p\.sort === 'due'/)
    const table = read('src/web/components/CardTable.tsx')
    expect(table, 'the Due header stopped announcing which way it sorts')
      .toMatch(/aria-sort=/)
  })

  test('one page size, shared by the pager and everything it counts', () => {
    // A caller that sliced by 25 under a pager counting by 50 prints a range
    // that does not describe the rows beneath it.
    const primitives = read('src/web/components/primitives.tsx')
    expect(primitives).toMatch(/export const PAGE_SIZE = \d+/)
    expect((primitives.match(/PAGE_SIZE/g) ?? []).length, 'the pager stopped using its own constant')
      .toBeGreaterThan(1)
  })
})

/**
 * The desk's own four columns, and the ingestion rules the alert channels need.
 *
 * The column count is a design decision one plausible line undoes; the Slack
 * rules are the difference between reading a bot channel and reading nothing.
 */
describe('the desk shows four columns and the alert channels are really read', () => {
  test('four headings, four cols', () => {
    const table = read('src/web/components/CardTable.tsx')
    const head = table.slice(table.indexOf('export function TableHead('), table.indexOf('export function TableCols('))
    expect((head.match(/<th\b/g) ?? []).length, 'the desk grew or lost a column').toBe(4)
    const cols = table.slice(table.indexOf('export function TableCols('))
    expect((cols.slice(0, 600).match(/<col\b/g) ?? []).length).toBe(4)
  })

  test('a missing Slack tool is an error, not an empty desk', () => {
    // The whole failure this wave exists to fix: a source that cannot answer
    // reporting `ok: 1, count: 0`, which is indistinguishable from a healthy
    // sync of a quiet morning.
    const slack = read('src/server/sources/slack.ts')
    const fetchFn = slack.slice(slack.indexOf('async fetch()'))
    expect(fetchFn, 'the Slack poll swallows a failure as an empty list')
      .not.toMatch(/\breturn \[\]/)
  })

  test('bots are included on a channel read and never on a search', () => {
    // `include_bots` belongs to the search API. Passing it beside a
    // `channel_id` is the shape that reads as "we asked for bot messages" while
    // asking a call that does not take the parameter.
    const slack = read('src/server/sources/slack.ts')
    expect(slack, 'the alert channels stopped asking for bot messages').toContain('include_bots: true')
    for (const m of slack.matchAll(/include_bots/g)) {
      const around = slack.slice(Math.max(0, m.index! - 200), m.index! + 200)
      expect(around, 'include_bots is being passed to a channel read')
        .not.toContain('channel_id:')
    }
  })

  test('a drawn path animates only when frames are being produced', () => {
    // The generic gate above covers every `initial=` in `src/web`; this names
    // the one component whose marks are drawn rather than laid out, because a
    // path stuck at `pathLength: 0` is an invisible chart rather than a chart
    // that has not finished moving.
    const charts = read('src/web/components/charts.tsx')
    for (const m of charts.matchAll(/<motion\.path\b([\s\S]{0,400}?)\/>/g)) {
      const el = m[1]!
      if (!/initial=/.test(el)) continue
      expect(el, 'a drawn path animates in a document that is not being painted')
        .toMatch(/\b(still|reduce|STATIC_MODE)\b/)
    }
    expect(true).toBe(true)
  })
})

/* ------------------------ one row per thread, and the swipe ---------------- */

describe('the count and the highlight are one fact', () => {
  const table = read('src/web/components/CardTable.tsx')

  test('both are keyed on the same expression', () => {
    // `+2` and the amber edge answer the same question, so they are drawn from
    // the same predicate. Two predicates is how they come to disagree, and a
    // row wearing an edge with no number on it is unreadable.
    const uses = [...table.matchAll(/card\.activity\.count\s*(?:>|<=)\s*0/g)]
    expect(uses.length, 'the badge and the edge stopped sharing a predicate')
      .toBeGreaterThanOrEqual(3)
    expect(table, 'the edge is no longer the 2px inset the docblock reserved')
      .toMatch(/inset 2px 0 0 var\(--color-accent\)/)
  })

  test('the browser never recomputes what the server counted', () => {
    // The whole reason the number is computed server-side is that a second
    // implementation would drift. Arithmetic on it here is that second
    // implementation arriving one operator at a time.
    for (const f of web) {
      expect(read(f), `${f}: the activity count is being recomputed`)
        .not.toMatch(/activity\.count\s*[+\-*/]/)
      expect(read(f), `${f}: the activity count is being assigned`)
        .not.toMatch(/activity\.count\s*=[^=]/)
    }
  })

  test('being named changes the word and not the number', () => {
    expect(table, 'the tagged flag started deciding whether the edge is drawn')
      .not.toMatch(/activity\.tagged[^\n]*inset 2px/)
  })

  test("the reply total is the source's, not the array's length", () => {
    // Only the newest twenty replies are stored and Slack's own header carries
    // the real total, so counting the array would report a long thread as short.
    const thread = read('src/web/lib/thread.ts')
    expect(thread.slice(thread.indexOf('export function replyTotal')),
      'the reply total went back to counting what was kept').not.toMatch(/\.length/)
  })
})

describe('reading a row is what clears it', () => {
  const detail = read('src/web/components/CardDetail.tsx')
  const home = read('src/web/pages/Home.tsx')

  test('the pane acknowledges a card somebody opened', () => {
    expect(detail, 'the detail stopped acknowledging anything').toContain('actions.ack(')
  })

  test('the resting pane acknowledges nothing', () => {
    // This is the subtlety the whole feature turns on. The pane shows the top
    // row before anything is clicked, every morning — if that counts as reading
    // it, the `+N` and the edge are cleared by the desk loading, and the feature
    // silently destroys itself at 7am with nothing to see.
    const effect = detail.slice(detail.indexOf('if (resting) return'))
    expect(effect.slice(0, 400), 'the resting guard is gone from the acknowledgement')
      .toContain('actions.ack(')
    expect(detail, 'the pane no longer knows whether it was asked for')
      .toMatch(/resting\?: boolean/)
    // `!selected`, not `!selectedKey`: `shown` also falls back to the top row
    // when the key in the URL names a card that is no longer on the desk — one
    // he finished, or one a poll swept out from under the open pane — and the
    // key alone cannot tell that apart from a card he is actually reading.
    expect(home, 'the desk stopped telling the pane it is resting')
      .toMatch(/resting=\{!selected\}/)
    expect(home, 'the resting flag went back to reading the URL rather than the row')
      .not.toMatch(/resting=\{!selectedKey\}/)
  })

  test('and the phone sheet says it too', () => {
    // The sheet is gated on `selectedKey`, which is still set in every case
    // `shown` falls back to the top row — so a `CardDetail` rendered here
    // without `resting` acknowledges a card nobody opened, at the width he
    // actually reads on. Every viewport below the pane width takes this path.
    const sheet = home.slice(home.indexOf('function PushDetail('))
    expect(sheet, 'the sheet stopped passing the flag through to the detail')
      .toMatch(/<CardDetail[^>]*resting=\{resting\}/)
    expect(home, 'the desk stopped telling the sheet it is resting')
      .toMatch(/<PushDetail card=\{shown\} resting=\{!selected\}/)
  })

  test('nothing else on the desk acknowledges anything', () => {
    // A row rendering is not a row being read, and neither is a list scrolling
    // past one.
    expect(home, 'the desk page acknowledges cards by itself').not.toContain('actions.ack(')
    expect(read('src/web/components/CardTable.tsx'), 'a row acknowledges itself')
      .not.toContain('actions.ack(')
  })

  test('an ack is not a card cleared', () => {
    // The pane acknowledges automatically now, so counting one as throughput
    // reports a thread still sitting on the desk as work that left it.
    const analytics = read('src/server/analytics.ts')
    const cleared = analytics.slice(analytics.indexOf('const cleared ='))
    expect(cleared.slice(0, 200), 'reading a row went back to counting as clearing it')
      .not.toContain('card_acked')
  })
})

describe('a row can be acted on without being opened', () => {
  const swipe = read('src/web/components/swipe.tsx')
  const css = read('src/web/styles.css')

  test('every row with a status has the same three actions', () => {
    for (const f of ['src/web/components/CardTable.tsx', 'src/web/pages/Work.tsx']) {
      expect(read(f), `${f}: rows here have no drawer`).toContain('<SwipeDrawer')
    }
    // Words, not glyphs. A thumb-sized box with a picture in it is a guess.
    expect(swipe).toMatch(/label="Done"/)
    expect(swipe).toMatch(/label="Status"/)
    expect(swipe).toMatch(/label="Delete"/)
  })

  test('the drawer is not rendered while it is shut', () => {
    // Not at `opacity: 0` and not at `width: 0` with live buttons inside it:
    // `group-hover` never fires on touch, so that shape is a control which is
    // permanently invisible and permanently tappable.
    expect(swipe, 'the drawer renders while the row is closed')
      .toMatch(/if \(dx === 0\) return null/)
    for (const f of web) {
      expect(read(f), `${f}: a swipe action is hidden behind opacity`)
        .not.toMatch(/opacity-0\s+group-hover:opacity-100/)
    }
  })

  test('the gesture works with a trackpad as well as a thumb', () => {
    // React attaches wheel listeners passively and a passive listener cannot
    // `preventDefault`, so without the manual binding the same two fingers that
    // open the drawer also trigger the browser's back gesture and the reader
    // leaves Wake.
    expect(swipe, 'the horizontal wheel binding is gone')
      .toMatch(/addEventListener\('wheel',[^)]*\{ passive: false \}/)
    expect(swipe, 'the pointer binding stopped being pointer-type agnostic')
      .toMatch(/onPointerDown/)

    /*
     * And its settle timer does not get to overrule a row that opened after it.
     *
     * A wheel has no `pointerup`, so the end of one is a 120ms gap — extended by
     * every frame of macOS momentum. The wheel path publishes on its *first*
     * engaged frame, so by the time the timer lands another row may legitimately
     * own the store: flick one row half-open, flick the next, and the first
     * row's timer would shut the drawer under the thumb, or steal back the key
     * the desk hands the keyboard to.
     */
    const settle = swipe.slice(swipe.indexOf('const end = () => {'))
    expect(settle.slice(0, 1200), 'the wheel settle timer publishes over whatever is open now')
      .toMatch(/if \(openSwipeKey\(\) !== key\)/)
  })

  test('a swipe is not a tap, and the page still scrolls', () => {
    expect(swipe, 'a gesture no longer suppresses the click it produced')
      .toMatch(/onClickCapture/)
    expect(swipe, 'the swipe layer stopped yielding the vertical axis')
      .toMatch(/touch: SwipeTouch = 'pan-y'/)

    /*
     * And the declaration has to reach an element that can take it.
     *
     * `touch-action` does not apply to a table row — rows, row groups, columns
     * and column groups are excluded by the property itself — so an inline
     * `touchAction` on the desk's `<tr>` is dropped by every browser while a
     * test happily pins the string. It lives in the stylesheet, on the cells,
     * and the rows carry the attribute that selects it.
     */
    expect(
      swipe.slice(swipe.indexOf('const bind: SwipeBind')),
      'the touch policy went back to an inline style on a <tr>',
    ).not.toMatch(/touchAction/)
    expect(css, 'the swipe rows lost their touch-action rule')
      .toMatch(/\[data-swipe='pan-y'\],\s*\n\s*\[data-swipe='pan-y'\] > td \{ touch-action: pan-y; \}/)
    // Every element that takes the gesture, not one per file: the attribute is
    // what selects the rule, so an element bound to the pointer handlers without
    // it is an element whose touch policy is silently `auto`.
    for (const f of ['src/web/components/CardTable.tsx', 'src/web/pages/Work.tsx']) {
      const src = read(f)
      const bound = src.split("data-swipe={swipe.bind['data-swipe']}").length - 1
      const rows = src.split('swipe.bind.onPointerDown').length - 1
      expect(bound, `${f}: ${rows - bound} swipeable element(s) declare no touch policy`).toBe(rows)
      /*
       * And the same totality for the gesture's own style, which is where
       * `user-select: none` lives while the drawer is moving. The single
       * `removeAllRanges()` at engage clears only what the first twelve pixels
       * selected; without the style the rest of a mouse drag highlights the
       * row's title and detail blue under the open drawer, and leaves them
       * highlighted after the button comes up. `Reorder.Item` spreads a given
       * style before adding its own `x`/`y`/`zIndex`, so it takes this too.
       */
      // Counted on the reference rather than on one spelling: the desk's phone
      // row spreads it beside the amber edge, which is still the gesture's style
      // reaching the element.
      const styled = src.split('swipe.bind.style').length - 1
      expect(styled, `${f}: ${rows - styled} swipeable element(s) can be text-selected mid-drag`)
        .toBe(rows)
    }

    /*
     * The Work page's draggable rows are the exception, and it has to stay
     * deliberate — as does the fact that it applies to those rows only.
     *
     * framer owns a `Reorder.Item`'s vertical axis for drag-to-reorder and
     * writes `pan-x` inline to get it, so writing `pan-y` over that would kill
     * reordering while still looking like it works. But `pan-x` also hands the
     * browser the horizontal axis — the one the swipe is made of — so the row
     * asks for `none`, and the rule needs `!important` to outrank an inline
     * style.
     *
     * A static row — the Done list — is not a `Reorder.Item`. Nothing writes
     * `pan-x` on it and nothing catches a vertical drag, so `none` there takes
     * the page's scroll away and hands it to nobody: a thumb dragging up the
     * Done list moves nothing at all. `none` is conditional on being draggable
     * for exactly that reason.
     */
    expect(read('src/web/pages/Work.tsx'), 'the task row gave an axis back to the browser')
      .toMatch(/useSwipe\(`task:\$\{task\.id\}`, 3, isStatic \? 'pan-y' : 'none'\)/)
    expect(css, "the task row's touch policy stopped outranking framer's inline one")
      .toMatch(/\[data-swipe='none'\] \{ touch-action: none !important; \}/)
  })

  test('exactly one row is open, whichever input opened it', () => {
    /*
     * Two ways for the store to fall out of step with what is on screen, and
     * both of them were live.
     *
     * The wheel path moved a row's drawer on the first event and only published
     * to the store after a 120ms idle timer, so two rows sat fully open beside
     * each other for the length of a trackpad gesture plus all of macOS's
     * momentum. And nothing released the key when the row holding it unmounted —
     * so opening a drawer on Work with a trackpad (no `pointerdown` anywhere)
     * and then navigating away left `openKey` set for the rest of the session,
     * which is what the desk checks before every keyboard shortcut: j, k, Enter,
     * e and Escape dead, with no drawer on screen to explain it.
     */
    const wheel = swipe.slice(swipe.indexOf('const onWheel'), swipe.indexOf('const bind'))
    expect(wheel, 'the wheel path went back to publishing only when the fingers stop')
      .toMatch(/setOpenSwipe\(key\)\s*\n\s*put\(next\)/)
    expect(swipe, 'a row that unmounts no longer releases the drawer it was holding')
      .toMatch(/if \(openSwipeKey\(\) === key\) setOpenSwipe\(null\)/)
    expect(read('src/web/pages/Home.tsx'), 'the desk keyboard stopped yielding to an open drawer')
      .toContain('if (openSwipeKey()) return')

    // And the wheel engages on the same 12px the finger does. A trackpad's
    // vertical scroll decelerates through frames where `deltaY` has decayed to
    // zero and a pixel of horizontal residue is left; without a threshold each
    // one opened whichever row the cursor was over by a pixel.
    expect(wheel, 'the wheel path opens a drawer on a pixel of scroll drift')
      .toMatch(/travelled < SWIPE_ENGAGE_PX/)
  })

  test('every option in the status picker is a target, not a word', () => {
    // Sized by its label alone, `Done` is four characters — a 36px box, the
    // narrowest interactive thing in the product, sitting immediately left of
    // `Won't do`, which takes the card off the desk.
    expect(swipe.slice(swipe.indexOf('if (picking && status)')).slice(0, 1400),
      'the picker went back to label-width targets on a phone').toContain('min-w-11')
  })

  test('the drawer paints under the header it scrolls past', () => {
    // Two positioned elements at one z-index in one stacking context paint in
    // tree order, and a `<tbody>` comes after a `<thead>` — so an open drawer
    // painted its solid 264px block over Title / Status / Kind / Due as its row
    // scrolled up under the sticky header.
    expect(read('src/web/components/CardTable.tsx'),
      "the sticky header dropped back to the drawer's own layer").toMatch(/sticky top-0 z-20/)
    expect(swipe, 'the drawer climbed above the header').toMatch(/right-0 z-10/)
  })

  test('the picker offers what the row can actually be', () => {
    // Five for a card, three for a task, two for a goal — and all of them from
    // the one label table, so the product cannot grow a second vocabulary and a
    // picker cannot offer a value the route refuses.
    expect(read('src/web/components/CardTable.tsx'), 'the card picker stopped using the shared five')
      .toMatch(/STATUS_ORDER\.map/)
    const work = read('src/web/pages/Work.tsx')
    expect(work, 'the task picker invented its own labels').toContain('STATUS_LABEL.not_started')
    expect(work, 'the task picker offered a state a task cannot be in')
      .toMatch(/const TASK_CHOICES = \[\s*\n\s*\{ id: 'todo'/)
  })

  test("delete on a card is the dismissal Wake already had", () => {
    // A red button that irreversibly destroyed a card would be the only
    // irreversible action in the product. On a card `Delete` sets `Won't do`,
    // which takes it off the desk, keeps it reachable through the Status filter,
    // and undoes through the same record every other status write uses.
    const table = read('src/web/components/CardTable.tsx')
    expect(table, 'the swipe grew a destructive delete for cards')
      .toMatch(/onDelete: \(\) => actions\.onStatus\(card, 'wont_do'\)/)
  })
})

describe('the thread is legible in a 320px pane', () => {
  const detail = read('src/web/components/CardDetail.tsx')
  const row = detail.slice(detail.indexOf('function ThreadRow('))

  test('every body clips to three lines', () => {
    // One Cursor root-cause post is 1,400 characters. Unclipped, the pane is one
    // message and a scrollbar.
    expect(row, 'a reply body can own the whole pane again').toContain('line-clamp-3')
  })

  test('a reply that names him says so', () => {
    expect(row, 'the mark that explains why a row lit up is gone').toContain('@you')
    expect(row, 'the amber rule on a naming reply is gone').toContain('border-l-2 border-l-accent')
  })

  test('the fresh marks survive the ack that clears the count', () => {
    /*
     * Opening a card posts `/ack` and reloads, and `baselineOf` reads exactly
     * the `acked_at` that write moves — so within one round trip every line the
     * thread had just drawn in the brighter ink was older than the baseline
     * again and went back to muted. The pane's own promise is that the `+3` on
     * the row and the three brighter lines in here are the same three messages;
     * unfrozen, the second half of it was true for about twenty milliseconds.
     */
    expect(detail, 'the thread baseline moved with the ack again')
      .toMatch(/const opened = useRef\(\{ key: card\.group_key, baseline: baselineOf\(card\) \}\)/)
    expect(detail, 'the thread went back to reading the live baseline')
      .toMatch(/<Thread card=\{card\} lines=\{conversation\} baseline=\{opened\.current\.baseline\}/)
    const thread = detail.slice(detail.indexOf('function Thread('), detail.indexOf('function ThreadRow('))
    expect(thread, 'the thread recomputed a baseline of its own').not.toMatch(/baselineOf\(/)
  })

  test('a degraded row says so wherever it draws', () => {
    /*
     * The mark used to live only inside the thread list, and the list only draws
     * at two messages or more — while the shape a degraded row most often takes
     * is exactly one: he is named in a reply, the read failed, and the search
     * returned that one hit. So the one case the mark was written for was the
     * one case it could not render in, and a thread that would not load looked
     * identical to a short one.
     */
    expect(detail, 'the partial mark went back inside the thread list')
      .toMatch(/const partial = card\.sources\.some/)
    const excerpt = detail.slice(detail.indexOf('{!conversation.length && card.excerpt'))
    expect(excerpt.slice(0, 400), 'an excerpt-only row stopped saying its thread would not load')
      .toContain('{partial && ')
  })

  test('the conversation is not printed twice', () => {
    // A Slack card's excerpt is built from the thread it belongs to and a Gmail
    // card's is its newest message's snippet, so drawing both is the same text
    // above itself.
    expect(detail, 'the excerpt came back on a card that already shows its thread')
      .toMatch(/\{!conversation\.length && card\.excerpt && \(/)
  })

  test('but one message is an excerpt, not a thread of one', () => {
    // Every single-message alert row — Datadog, Grafana, the digest — carries an
    // `excerpt` its own family curated: the transport lines dropped, or the
    // triage triple lifted out of the prose. The thread entry beside it is the
    // raw body at 280 characters. Drawing the list for one line threw the
    // curation away and quoted `Attachment:` back at him.
    expect(detail, 'a one-message card draws a thread again')
      .toMatch(/const conversation = lines\.length > 1 \? lines : \[\]/)
    expect(detail, 'the thread stopped reading the gated list')
      .toMatch(/<Thread card=\{card\} lines=\{conversation\}/)
  })
})

describe('a thread is one row, all the way down', () => {
  test('the card is keyed on the parent the permalink names', () => {
    const slack = read('src/server/sources/slack.ts')
    // The one line the whole thing turned on: `thread_ts: hit.ts` made every
    // message its own thread.
    expect(slack, 'the bucket went back to keying on the message rather than the thread')
      .toMatch(/const parent = parentTs\(h\)\s*\n\s*const key = `\$\{h\.channelId\}:\$\{parent\}`/)
    expect(slack, 'a thread card stopped storing its parent')
      .toMatch(/thread_ts: b\.parent/)
  })

  test('the whole conversation is read for references, not just the parent', () => {
    // A `TRUTO-38` posted in a reply is what unions the row with the Sentry
    // issue, and it is the reason collapsing a thread has to read all of it.
    const slack = read('src/server/sources/slack.ts')
    expect(slack.slice(slack.indexOf('export function buildThreadCard')),
      'references went back to being read off the parent alone')
      .toMatch(/extractRefs\(said\.join\('\\n'\)\)/)
  })

  test('a pasted permalink is not a second identity for the row', () => {
    const slack = read('src/server/sources/slack.ts')
    expect(slack.slice(slack.indexOf('export function buildThreadCard')),
      'a quoted Slack link can union two unrelated conversations again')
      .toMatch(/\.filter\(r => r\.t !== 'slackthread'\)/)
  })

  test('and the state he set follows the thread rather than being stranded', () => {
    // The identity changed under the data, so a Done pressed on what turned out
    // to be a reply has to move with it.
    expect(read('src/server/db.ts'), 'the rekey migration is gone')
      .toContain('export function rekeySlackThreadGroups')
  })
})
