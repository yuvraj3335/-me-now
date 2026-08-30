/**
 * A notification's link has to land somewhere Wake actually is.
 *
 * `describeTarget` used to hand out `${PUBLIC_URL}/tasks` and `/goals`. The SPA
 * fallback serves 200 for anything, and the router resolved an unknown path with
 * `TABS.find(...) ?? TABS[0]` — so tapping a reminder for a task landed on Now
 * with `/tasks` in the address bar, and nothing anywhere said it had missed.
 *
 * This reads the source rather than the DOM for the same reason the other
 * grep-tests do: a link built in a template literal on the server, resolved by a
 * table on the client, has no single runtime moment where the two meet.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/** The destinations the shell actually declares, read out of the tab table. */
const routes = (() => {
  const app = readFileSync('src/web/App.tsx', 'utf8')
  const table = app.slice(app.indexOf('const TABS = ['), app.indexOf('] as const'))
  const found = [...table.matchAll(/path:\s*'([^']+)'/g)].map(m => m[1]!)
  if (!found.length) throw new Error('App.tsx no longer declares its routes as `path:` in TABS')
  return found
})()

describe('every link Wake mints resolves to a route Wake has', () => {
  test('the shell still declares the five destinations', () => {
    expect(routes.sort()).toEqual(['/', '/mail', '/pulse', '/settings', '/work'])
  })

  test('no server-built deep link points at a path the shell does not have', () => {
    const push = readFileSync('src/server/push.ts', 'utf8')
    const links = [...push.matchAll(/\$\{PUBLIC_URL\}(\/[a-z-]*)/g)].map(m => m[1]!)
    expect(links.length, 'push.ts stopped minting deep links').toBeGreaterThan(0)
    for (const l of links) {
      expect(routes, `push.ts links to ${l}, which is not a Wake route`).toContain(l)
    }
  })

  test('a reminder for a task and for a goal both land on Work', () => {
    const push = readFileSync('src/server/push.ts', 'utf8')
    const target = push.slice(push.indexOf('function describeTarget'))
    expect(target).not.toMatch(/\$\{PUBLIC_URL\}\/tasks/)
    expect(target).not.toMatch(/\$\{PUBLIC_URL\}\/goals/)
    expect(target).toMatch(/\$\{PUBLIC_URL\}\/work/)
  })
})
