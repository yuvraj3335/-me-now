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
