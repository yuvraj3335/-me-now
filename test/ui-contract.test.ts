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

describe('the hand-off has to be a real link', () => {
  test('Open in Claude is an anchor, not a scripted window.open', () => {
    // This is the whole reason the flow has two steps. On iOS,
    // `https://claude.ai/…` is a universal link and only a genuine link
    // navigation hands it to the Claude app; `window.open(url)` after an await
    // lands in Safari instead, which is exactly what this change was for.
    const sheet = read('src/web/components/launch.tsx')
    expect(sheet).toMatch(/<a\s[^>]*href=\{handoff\.url\}/)
    expect(sheet, 'the hand-off went back to a scripted open').not.toMatch(/window\.open\s*\(/)
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
