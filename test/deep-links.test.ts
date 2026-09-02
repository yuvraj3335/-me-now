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
import { gmailWebUrl, openTarget, slackAppUrl } from '../src/web/lib/appLinks'
import type { Card } from '../src/web/lib/types'

/** The destinations the shell actually declares, read out of the tab table. */
const routes = (() => {
  const app = readFileSync('src/web/App.tsx', 'utf8')
  const table = app.slice(app.indexOf('const TABS = ['), app.indexOf('] as const'))
  const found = [...table.matchAll(/path:\s*'([^']+)'/g)].map(m => m[1]!)
  if (!found.length) throw new Error('App.tsx no longer declares its routes as `path:` in TABS')
  return found
})()

describe('every link Wake mints resolves to a route Wake has', () => {
  test('the shell still declares the six destinations', () => {
    expect(routes.sort()).toEqual(['/', '/mail', '/pulse', '/sessions', '/settings', '/work'])
  })

  test('no server-built deep link points at a path the shell does not have', () => {
    /*
     * `/terminal/<id>` is a destination without a tab: a session's own screen,
     * routed by `terminalIdOf` in `route.ts` rather than by an entry in TABS,
     * because it is a page you arrive at from a push or a composer and not one
     * you switch to from the strip. So it is checked against the router's own
     * parser rather than against the tab table — the parser is what makes it a
     * route, and a link that `terminalIdOf` cannot read is a link to nothing.
     */
    const router = readFileSync('src/web/lib/route.ts', 'utf8')
    expect(router, 'route.ts no longer parses /terminal/<id>').toMatch(/export function terminalIdOf/)
    const known = [...routes, '/terminal']

    const push = readFileSync('src/server/push.ts', 'utf8')
    const links = [...push.matchAll(/\$\{PUBLIC_URL\}(\/[a-z-]*)/g)].map(m => m[1]!)
    expect(links.length, 'push.ts stopped minting deep links').toBeGreaterThan(0)
    for (const l of links) {
      expect(known, `push.ts links to ${l}, which is not a Wake route`).toContain(l)
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


/**
 * `Open` has to end in the application that owns the thing.
 *
 * The desk's whole job is to hand him off, and every Open landed in a browser
 * tab — a second Slack, scrolled to the wrong place, with the real one already
 * running behind it. The permalink stays the card's `url` because it is the
 * durable, shareable form and `SLACK_ARCHIVE` in `dedup.ts` parses it back out;
 * the button is what changes.
 */
describe('Open launches the app, and says where the browser link is', () => {
  const slackCard = (meta: Record<string, unknown>): Card => ({
    group_key: 'g', pile: 'now', status: 'not_started', priority: 2, due_at: null,
    title: 't', why: 'w', url: 'https://truto.slack.com/archives/C0BERTMS9K4/p1788094379882969',
    kind: 'alert', ts: 0, activity_at: 0, first_seen_at: 0, meta: {}, state: null, tasks: [],
    activity: { count: 0, tagged: false, at: null },
    sources: [{ source: 'slack', kind: 'alert', url: '', ts: 0, title: 't', why: 'w', meta }],
  })

  test('a Slack card with the ids builds the scheme the app registers', () => {
    expect(slackAppUrl({
      team_id: 'T04CWR1AM1R',
      channel_id: 'C0BERTMS9K4',
      thread_ts: '1788094379.882969',
    })).toBe('slack://channel?team=T04CWR1AM1R&id=C0BERTMS9K4&message=1788094379.882969')
  })

  test('a missing team id is null, not a link that opens the wrong place', () => {
    // `slack://channel` without a team opens Slack on whatever was last shown,
    // which looks exactly like a link that worked.
    expect(slackAppUrl({ channel_id: 'C0BERTMS9K4', thread_ts: '1788094379.882969' })).toBeNull()
    expect(slackAppUrl({ team_id: 'T04CWR1AM1R', thread_ts: '1788094379.882969' })).toBeNull()
    expect(slackAppUrl({})).toBeNull()
  })

  test('with no message ts it still opens the channel', () => {
    expect(slackAppUrl({ team_id: 'T1', channel_id: 'C1' }))
      .toBe('slack://channel?team=T1&id=C1')
  })

  test('the card keeps the permalink alongside the app link', () => {
    const t = openTarget(slackCard({ team_id: 'T04CWR1AM1R', channel_id: 'C0BERTMS9K4' }))
    expect(t.app).toBe('slack://channel?team=T04CWR1AM1R&id=C0BERTMS9K4')
    expect(t.href, 'the shareable permalink was replaced rather than kept')
      .toBe('https://truto.slack.com/archives/C0BERTMS9K4/p1788094379882969')
  })

  test('a card we cannot build an app link for offers only the web one', () => {
    const t = openTarget(slackCard({ channel_id: 'C0BERTMS9K4' }))
    expect(t.app).toBeNull()
    expect(t.href).toStartWith('https://')
  })

  test('the browser link is rendered whenever an app link exists', () => {
    // `slack://` with no handler does not throw, does not fire an error event
    // and does not navigate — so there is no honest fallback timer to write,
    // and the escape hatch has to be a link a person can see.
    const detail = readFileSync('src/web/components/CardDetail.tsx', 'utf8')
    expect(detail, 'the Open button stopped preferring the app').toMatch(/href=\{app \?\? href\}/)
    expect(detail, 'the visible browser link is gone').toMatch(/\{app && [\s\S]{0,400}Open in browser/)
  })

  test('a Gmail address is not percent-encoded into the path', () => {
    // `encodeURIComponent('yuvraj@truto.one')` is `yuvraj%40truto.one`, and
    // Google's `/u/` segment wants the literal address — the escaped form does
    // not resolve, which was visible on the live desk.
    const url = gmailWebUrl('yuvraj@truto.one', '1a0523ad5d40b187')
    expect(url).not.toContain('%40')
    expect(url).toBe('https://mail.google.com/mail/u/yuvraj@truto.one/#inbox/1a0523ad5d40b187')
  })
})
