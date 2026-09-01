/**
 * Fetch — pipe 2, and the two places it could quietly become something else.
 *
 * The structural half (one spawn site, `--print`, a read-only allowlist, a turn
 * ceiling, a timeout, no free-text input) is asserted below.
 * This file tests the behaviour that decides whether a row is honest: what
 * survives validation, and where `why` comes from.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { parseRows } from '../src/server/fetch/claude'
import { FETCH_SCOPES, isFetchScope, slackCard, whyFrom } from '../src/server/fetch'
import { clean } from '../src/server/sources/slack'
import { CLAUDE_PROJECTS_DIR, FETCH_LEGACY_RUN_DIR, FETCH_RUN_DIR } from '../src/server/env'
import { claudeSessions, listSessions } from '../src/server/sources/claudeSessions'

describe('a Fetch Slack row has exactly one thread identity', () => {
  /** The hit `searchSlack` mints: `ref` is already the thread's parent. */
  const hit = (text: string) => ({
    source: 'slack' as const,
    title: '#truto',
    actor: 'Riya',
    excerpt: text,
    url: 'https://truto.slack.com/archives/C04D9HKDWAV/p1787814249215859?thread_ts=1787812499.720579',
    ts: 1_787_814_249_215,
    ref: 'C04D9HKDWAV:1787812499.720579',
  })

  const threadRefs = (text: string) =>
    (slackCard(hit(text))!.refs ?? []).filter(r => r.t === 'slackthread').map(r => r.v)

  test('a permalink pasted into the message is not a second conversation', () => {
    // The exact failure `buildThreadCard` names: reading a quoted permalink as a
    // thread reference unions this row with whatever row owns that conversation,
    // and one desk row then speaks for two with one Done button between them.
    expect(threadRefs(
      'see <https://truto.slack.com/archives/C0AHHQMF08L/p1787777335863559|this> — same thing',
    )).toEqual(['C04D9HKDWAV:1787812499.720579'])
  })

  test("the hit's own permalink does not re-add the reply's ts", () => {
    // `url` points at the reply. Keying on it is the three-rows-per-thread bug
    // arriving through the other door.
    expect(threadRefs('ptal when you get a minute')).toEqual(['C04D9HKDWAV:1787812499.720579'])
  })

  test('everything else the message mentions still counts', () => {
    const refs = slackCard(hit('TRUTO-38 is back, see trutohq/truto#2034'))!.refs ?? []
    expect(refs.some(r => r.t === 'sentry' && r.v === 'TRUTO-38')).toBe(true)
    expect(refs.some(r => r.t === 'gh')).toBe(true)
  })
})

describe('only schema-valid objects are read', () => {
  test('a fenced array is unwrapped', () => {
    // Measured against the real binary: asked for JSON, it answers inside a
    // ```json fence about half the time.
    const rows = parseRows('```json\n[{"id":"C1:1.2","title":"ping","bucket":"waiting"}]\n```')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('ping')
  })

  test('prose is dropped rather than rendered', () => {
    // The property that keeps model output off a pixel. Anything that is not an
    // array of objects is not repaired, explained or shown — it is nothing.
    expect(parseRows('I looked and found three things worth your time.')).toEqual([])
    expect(parseRows('{"id":"x","title":"y"}')).toEqual([])
    expect(parseRows('```json\n[not json\n```')).toEqual([])
  })

  test('an element without an id or a title does not become a row', () => {
    const rows = parseRows(JSON.stringify([
      { title: 'no id' },
      { id: 'no title' },
      { id: 'C1:1.2', title: 'both' },
    ]))
    expect(rows.map(r => r.title)).toEqual(['both'])
  })

  test('a url that is not a link is dropped, not rendered', () => {
    // A row's url becomes an `<a href>` and a `{t:'url'}` reference. `javascript:`
    // and `wake:` are neither.
    const rows = parseRows(JSON.stringify([
      { id: 'a', title: 'a', url: 'javascript:alert(1)' },
      { id: 'b', title: 'b', url: 'https://truto.slack.com/archives/C1/p1' },
    ]))
    expect(rows[0]!.url).toBeNull()
    expect(rows[1]!.url).toBe('https://truto.slack.com/archives/C1/p1')
  })

  test('a secret in a collected line is masked before it is stored', () => {
    const rows = parseRows(JSON.stringify([
      { id: 'a', title: 'deploy key', evidence: 'use xoxb-1234567890abcdef to test' },
    ]))
    expect(rows[0]!.evidence).not.toContain('xoxb-1234567890abcdef')
    expect(rows[0]!.evidence).toContain('redacted')
  })

  test('bucket is an enum, not free text', () => {
    // `bucket` decides the pile. Anything unrecognised reads as `open`, so a
    // collector cannot promote its own findings into the Now pile.
    const rows = parseRows(JSON.stringify([
      { id: 'a', title: 'a', bucket: 'urgent' },
      { id: 'b', title: 'b', bucket: 'waiting' },
    ]))
    expect(rows[0]!.bucket).toBe('open')
    expect(rows[1]!.bucket).toBe('waiting')
  })
})

describe('why is a rule firing, not a sentence somebody wrote', () => {
  test('evidence decides it, through the same table the Slack poller uses', () => {
    expect(whyFrom('can you take a look at this today?', 'waiting')).toBe('a direct request')
    expect(whyFrom('I am blocked on the token change', 'waiting')).toBe('someone is blocked')
    expect(whyFrom('any update on the migration', 'waiting')).toBe('someone is chasing an update')
  })

  test('no evidence means a fixed neutral phrase', () => {
    // Never a better guess. A row whose reason cannot be traced to a quoted
    // substring gets the plainest thing that is still true.
    expect(whyFrom(null, 'waiting')).toBe('you were named')
    expect(whyFrom(null, 'open')).toBe('open where you are named')
    expect(whyFrom('the deploy finished', 'open')).toBe('open where you are named')
  })
})

describe('the two pipes land on one desk without fighting', () => {
  test('a Slack search hit is normalised the way the poller normalises it', () => {
    // The poller runs Slack's wire markup through `clean`; a search hit arrives
    // raw. Unguarded, that put `<@U09617LRRDF|Yuvraj Muley> can you look` on the
    // live desk as a row title, overwriting the clean one the poll had written.
    expect(clean('<@U09617LRRDF|Yuvraj Muley> can you look at this?'))
      .toBe('@Yuvraj Muley can you look at this?')
    const search = readFileSync('src/server/sources/search.ts', 'utf8')
    expect(search, 'the search path stopped normalising Slack markup')
      .toContain('clean(h.text)')
  })

  test('the questions Fetch asks are the ones that return rows', () => {
    const src = readFileSync('src/server/fetch/index.ts', 'utf8')
    // `is:unresolved` was the reason Sentry answered nothing: Sentry applies its
    // own status default, and stacking that qualifier on top narrowed a real
    // answer to an empty one.
    expect(src, 'the Sentry question went back to is:unresolved')
      .toContain("searchSentry('assigned_or_suggested:me'")
    expect(src, 'a status qualifier crept back into the Sentry question')
      .not.toMatch(/searchSentry\('[^']*is:unresolved/)
    // Direct messages are not a thing Wake collects, on either pipe.
    expect(src).not.toContain('is_dm')
    expect(src, 'the standing Slack question started asking for direct messages again')
      .toContain('never direct messages')
  })

  test('a collision with a poll row refreshes the sighting and nothing else', () => {
    // Identity dedup, with pipe 1 winning: it has a live credential and a
    // three-minute cadence, and Fetch is a manual snapshot.
    const src = readFileSync('src/server/fetch/index.ts', 'utf8')
    expect(src, 'Fetch went back to overwriting rows the poller owns')
      .toMatch(/found_by === 'poll'[\s\S]{0,400}UPDATE cards SET group_key = \?, last_seen_at = \?, gone = 0/)
  })

  test('the poller cannot sweep a row Fetch put there', () => {
    // Fetch is manual and asks questions the poll never asks, so everything it
    // lands is by definition something the next poll will not return. Without
    // this condition a Fetch row survives under three minutes.
    const ingest = readFileSync('src/server/ingest.ts', 'utf8')
    expect(ingest, "the sweep stopped scoping itself to the pipe that owns the sighting")
      .toMatch(/UPDATE cards SET gone = 1[\s\S]{0,200}found_by = 'poll'/)
  })
})

describe("Fetch's own runs never land back on the desk", () => {
  /**
   * The failure this pins, one layer down from the handoff-pack dump.
   *
   * Fetch spawns `claude`, and Claude Code writes a transcript for every run it
   * makes. Those transcripts used to land in the same bucket a person gets when
   * they open a session from `~`, so the Claude Code source read them back and
   * put them on the desk as work left open — two of nine session cards on the
   * live board were Wake quoting its own Slack question, growing by one per
   * connector per press.
   *
   * The fix is structural rather than textual: a collection runs in a directory
   * of Wake's own and the source skips that directory. So this test writes a
   * transcript that is Fetch-shaped in *every* way — the real prompt, the real
   * turn count, the real recency — and asserts it is still not a card. A test
   * that matched the prompt string would go green again the moment the question
   * is reworded, which is exactly the rot being avoided.
   */
  const projects = `${CLAUDE_PROJECTS_DIR}`
  const flatten = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

  const FETCH_PROMPT =
    'Search Slack for two things in the last 14 days: (a) messages addressed to ' +
    'Yuvraj Muley — direct messages to him, and messages that mention him by name.'

  /** A transcript with a working directory, a prompt and two user turns. */
  const transcript = (cwd: string, prompt: string) =>
    [
      { type: 'user', cwd, message: { role: 'user', content: prompt } },
      { type: 'user', cwd, message: { role: 'user', content: 'continue' } },
      { type: 'last-prompt', lastPrompt: prompt },
    ].map(l => JSON.stringify(l)).join('\n')

  const write = (cwd: string, id: string, prompt: string) => {
    const dir = `${projects}/${flatten(cwd)}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/${id}.jsonl`, transcript(cwd, prompt))
  }

  beforeEach(() => {
    rmSync(projects, { recursive: true, force: true })
    mkdirSync(projects, { recursive: true })
  })

  test('a run in the Fetch directory is not a session card', async () => {
    write(FETCH_RUN_DIR, 'aaaaaaaa-0000-0000-0000-000000000001', FETCH_PROMPT)
    expect(await claudeSessions.fetch()).toEqual([])
  })

  test('a run from where Fetch used to live is not one either', async () => {
    // The transcripts written before Fetch had a directory of its own are still
    // on disk, and the poller runs every three minutes: a swept card that comes
    // back before you have finished reading the sweep is not swept.
    write(FETCH_LEGACY_RUN_DIR, 'aaaaaaaa-0000-0000-0000-000000000002', FETCH_PROMPT)
    expect(await claudeSessions.fetch()).toEqual([])
  })

  test('a session you actually opened still becomes one', async () => {
    // The control. Without it this suite would pass just as well if the source
    // had stopped producing cards altogether.
    write('/home/someone/work/app', 'aaaaaaaa-0000-0000-0000-000000000003', 'fix the login redirect')
    const cards = await claudeSessions.fetch()
    expect(cards).toHaveLength(1)
    expect(cards[0]!.meta?.cwd).toBe('/home/someone/work/app')
  })

  test('the launcher is not offered one to resume either', () => {
    // `listSessions` feeds the Open-in-Claude picker. A transcript of Wake
    // asking Slack a question is not work to carry into a new session.
    write(FETCH_RUN_DIR, 'aaaaaaaa-0000-0000-0000-000000000004', FETCH_PROMPT)
    write('/home/someone/work/app', 'aaaaaaaa-0000-0000-0000-000000000005', 'fix the login redirect')
    expect(listSessions().map(s => s.cwd)).toEqual(['/home/someone/work/app'])
  })
})

/**
 * Fetching one source rather than all of them.
 *
 * This shipped late, and it shipped late because nothing anywhere asserted it —
 * the requirement was in the brief, absent from every prompt written from that
 * brief, and therefore invisible to the review that followed. These are the
 * assertions that would have caught its absence.
 */
describe('Fetch can be scoped to one source', () => {
  test('the scope list is exactly the five sources the desk offers', () => {
    // Not the four Fetch connectors: `claude` has no pipe-2 collector, and
    // scoping to it is still a meaningful thing to ask for — it re-reads this
    // machine's transcripts through pipe 1 alone.
    expect([...FETCH_SCOPES].sort()).toEqual(['claude', 'github', 'gmail', 'sentry', 'slack'])
  })

  test('only a real source name passes the guard', () => {
    for (const ok of FETCH_SCOPES) expect(isFetchScope(ok), ok).toBe(true)
    for (const no of ['all', 'Slack', 'notion', '', 'slack ', '__proto__']) {
      expect(isFetchScope(no), `${no} was accepted as a source`).toBe(false)
    }
    for (const no of [null, undefined, 1, {}, ['slack']]) {
      expect(isFetchScope(no), `${JSON.stringify(no)} was accepted as a source`).toBe(false)
    }
  })

  test('a scoped run narrows pipe 1 as well as pipe 2', () => {
    // The half that is easy to get wrong. Scoping only the connectors would
    // leave `ingest()` re-polling every source, so "fetch just Slack" would be
    // true of the collector and false of the poll underneath it — and the
    // inbox would refill on a press that said Slack.
    const src = readFileSync('src/server/fetch/index.ts', 'utf8')
    const body = /async function collectAll\([\s\S]*?\n\}/.exec(src)?.[0] ?? ''
    expect(body, 'collectAll no longer exists in a readable shape').toContain('askedBy')
    expect(body, 'a scoped Fetch still re-polls every source through ingest()')
      .toMatch(/ingest\(only\)/)
  })

  test('a scoped run that fails blames only what it meant to ask', () => {
    // A scoped run reporting an error against three connectors it never
    // intended to touch is the same lie as a green sync over a channel nobody
    // read: it makes a claim about a source that was not asked.
    const src = readFileSync('src/server/fetch/index.ts', 'utf8')
    const body = /async function doFetch\([\s\S]*?\n\}\n/.exec(src)?.[0] ?? ''
    expect(body, 'doFetch vanished').toContain('connectors:')
    expect(body, 'the failure report still names every connector, scoped or not')
      .not.toMatch(/connectors:\s*CONNECTORS\.map/)
  })

  test('the desk scopes Fetch by the source tab, and says so on the button', () => {
    // The affordance is the label. A control that silently changed what it did
    // based on a filter elsewhere on the page would be a trap.
    const home = readFileSync('src/web/pages/Home.tsx', 'utf8')
    const fn = /function Fetch\(\{[\s\S]*?\n\}\n/.exec(home)?.[0] ?? ''
    // AMENDED: the unfiltered tab is `null`, not `'all'`.
    //
    // Both assertions pinned the old spelling rather than the rule. What has to
    // stay true is that Fetch is scoped by whichever tab you are standing on,
    // and that standing on the unfiltered one asks every connector — which is
    // now `source ?? undefined` rather than a ternary against a magic string.
    expect(fn, 'Fetch stopped taking the current source').toMatch(/source:\s*SourceName\s*\|\s*null/)
    expect(fn, 'Fetch stopped passing the source to the collector').toMatch(/fetchNow\(only\)/)
    expect(fn, 'the unfiltered tab stopped meaning "everything"').toMatch(/source \?\? undefined/)
    expect(fn, 'the button no longer names the source it is about to ask').toContain('SOURCE_LABEL[only]')
  })
})
