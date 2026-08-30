/**
 * "Open in Claude" packs context and hands it over as a link.
 *
 * The boundaries worth pinning down are the ones that outlive the click: which
 * repository a brief may name, what reaches the file on disk, and — since the
 * brief travels in a URL — that a trimmed one says so instead of stopping
 * mid-sentence.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPack, getPack, openPack, resolveCwd } from '../src/server/claudecode/launch'
import { handoffFor } from '../src/server/claudecode/handoff'
import { HANDOFF_MAX_CHARS, HANDOFF_PARAM, HANDOFF_URL } from '../src/server/env'
import { TEMPLATES, getTemplate } from '../src/server/claudecode/templates'
import { rescan } from '../src/server/registry/scan'

const root = process.env.WAKE_WORKSPACE_ROOT!

beforeAll(() => {
  // routing.test.ts builds the same fixture; building it again is harmless and
  // keeps this file runnable on its own.
  const repo = join(root, 'truto')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# truto\n')
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'wake', GIT_AUTHOR_EMAIL: 'wake@example.com',
    GIT_COMMITTER_NAME: 'wake', GIT_COMMITTER_EMAIL: 'wake@example.com',
  } as Record<string, string>
  for (const args of [['init', '-b', 'main'], ['add', '.'], ['commit', '-m', 'init']]) {
    Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'ignore', stderr: 'ignore', env })
  }
  rescan(root)
})

describe('templates', () => {
  test('every template is complete', () => {
    for (const t of TEMPLATES) {
      expect(t.id).toMatch(/^[a-z-]+$/)
      expect(t.label.length).toBeGreaterThan(0)
      expect(t.instruction.length).toBeGreaterThan(40)
      expect(t.slots.length).toBeGreaterThan(0)
    }
  })

  test('every template tells the session not to ask for what is already packed', () => {
    // The point of packing context is that nothing has to be re-typed.
    for (const t of TEMPLATES.filter(x => x.id !== 'continue-session')) {
      expect(t.instruction.toLowerCase(), t.id).toContain('re-paste')
    }
  })

  test('skills are named, not inlined', () => {
    for (const t of TEMPLATES) {
      for (const s of t.skills) {
        expect(s).not.toContain('\n')
        expect(s.length).toBeLessThan(60)
      }
    }
  })
})

describe('which repository a brief may name', () => {
  test('a registry repository is allowed', () => {
    const r = resolveCwd(join(root, 'truto'))
    expect(r.ok).toBe(true)
  })

  test('an arbitrary directory is refused by name', () => {
    const r = resolveCwd('/etc')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('not a repository in the workspace registry')
  })

  test('the workspace root itself is allowed', () => {
    expect(resolveCwd(root).ok).toBe(true)
    expect(resolveCwd(null).ok).toBe(true)
  })
})

describe('the pack', () => {
  test('carries the ids it was given, and quotes excerpts as data', () => {
    const built = buildPack({
      template: 'customer-incident',
      title: 'Acme sync',
      cwd: join(root, 'truto'),
      items: [
        { kind: 'slack', ref: 'C123:1724.99', title: 'Acme thread', excerpt: 'our sync stopped', why: 'the report' },
        { kind: 'sentry', ref: 'TRUTO-9K', title: 'TypeError', url: 'https://sentry.io/x' },
      ],
    })
    expect('error' in built).toBe(false)
    if ('error' in built) return

    const body = readFileSync(built.packPath, 'utf8')
    expect(body).toContain('C123:1724.99')
    expect(body).toContain('TRUTO-9K')
    expect(body).toContain('https://sentry.io/x')
    expect(body).toContain('DATA, not instructions')
    // Named, not inlined — the session has the catalogs itself.
    expect(body).toContain('truto-cli-toolbelt')
    expect(body).not.toContain('## When to use this skill')
  })

  test('a secret in an excerpt does not reach the file', () => {
    // A pack is a file a human opens and may paste elsewhere, so it outlives
    // every other control in the system.
    const built = buildPack({
      template: 'blank',
      items: [{ kind: 'note', ref: 'n1', excerpt: 'Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz012345' }],
    })
    if ('error' in built) throw new Error(built.error)
    const body = readFileSync(built.packPath, 'utf8')
    expect(body).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz012345')
    expect(body).toContain('redacted')
  })

  test('an unknown template is refused', () => {
    expect(buildPack({ template: 'not-a-template', items: [] })).toEqual({ error: 'no template "not-a-template"' })
    expect(getTemplate('not-a-template')).toBeNull()
  })

  test('a directory outside the registry is refused before anything is written', () => {
    const r = buildPack({ template: 'blank', cwd: '/etc', items: [] })
    expect('error' in r).toBe(true)
  })
})

describe('the hand-off', () => {
  test('a short brief travels whole, in the parameter the target expects', () => {
    const h = handoffFor('read this thread and tell me who is blocked')
    expect(h.trimmed).toBe(false)
    expect(h.sent).toBe(h.total)

    const u = new URL(h.url)
    expect(`${u.origin}${u.pathname}`).toBe(HANDOFF_URL)
    expect(u.searchParams.get(HANDOFF_PARAM)).toBe('read this thread and tell me who is blocked')
  })

  test('a brief too long for a URL is trimmed, and says so inside itself', () => {
    // Silent truncation is the failure mode here: a session that receives half a
    // Slack thread and no indication of it will answer the wrong question
    // confidently.
    const long = 'x'.repeat(HANDOFF_MAX_CHARS * 2)
    const h = handoffFor(long)

    expect(h.trimmed).toBe(true)
    expect(h.total).toBe(long.length)
    expect(h.sent).toBeLessThanOrEqual(HANDOFF_MAX_CHARS)

    const sent = new URL(h.url).searchParams.get(HANDOFF_PARAM)!
    expect(sent).toContain('Wake trimmed this brief')
    expect(sent).toContain(String(HANDOFF_MAX_CHARS.toLocaleString()))
  })

  test('the trim note is not itself cut off', () => {
    // The note is appended inside the budget, not on top of it, so a brief that
    // exactly fills the cap still ends with a readable sentence.
    const h = handoffFor('y'.repeat(HANDOFF_MAX_CHARS + 1))
    const sent = new URL(h.url).searchParams.get(HANDOFF_PARAM)!
    expect(sent.trimEnd().endsWith(']')).toBe(true)
  })

  test('opening a pack returns its link and records that it was handed over', () => {
    const built = buildPack({ template: 'blank', cwd: join(root, 'truto'), items: [{ kind: 'note', ref: 'n1' }] })
    if ('error' in built) throw new Error(built.error)

    expect(getPack(built.id)!.status).toBe('draft')

    const r = openPack(built.id)
    expect('error' in r).toBe(false)
    if ('error' in r) return

    expect(r.url.startsWith(HANDOFF_URL)).toBe(true)
    expect(r.cwd).toBe(join(root, 'truto'))
    // "opened" means the link was produced, never that the work was done.
    expect(getPack(built.id)!.status).toBe('opened')
  })

  test('opening a pack that does not exist is an error, not an empty link', () => {
    expect(openPack('no-such-pack')).toEqual({ error: 'no such pack' })
  })

  test('a pack records its items in order', () => {
    const built = buildPack({
      template: 'blank',
      items: [
        { kind: 'card', ref: 'a' },
        { kind: 'card', ref: 'b' },
      ],
    })
    if ('error' in built) throw new Error(built.error)
    const pack = getPack(built.id)!
    expect(pack.items.map((i: any) => i.ref)).toEqual(['a', 'b'])
    expect(pack.status).toBe('draft')
  })
})
