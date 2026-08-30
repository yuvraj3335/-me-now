/**
 * "Open in Claude Code" is the one feature that starts a process on the machine,
 * so the things worth pinning down are the boundaries: where a session may run,
 * what reaches the pack file, and whether the resume command shown in the UI is
 * the id that was actually used.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPack, getPack, launcherStatus, launchPack, resolveCwd, resumeCommand } from '../src/server/claudecode/launch'
import { TEMPLATES, getTemplate } from '../src/server/claudecode/templates'
import { rescan } from '../src/server/registry/scan'
import { db } from '../src/server/db'

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

describe('where a session may run', () => {
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

describe('launching', () => {
  test('the resume command names the session and the binary that was used', () => {
    const bin = process.env.WAKE_CLAUDE_BIN!
    expect(resumeCommand('abc-123', '/w/truto')).toBe(`cd /w/truto && ${bin} --resume abc-123`)
    expect(resumeCommand('abc-123')).toBe(`${bin} --resume abc-123`)
  })

  test('a missing binary fails visibly rather than silently', () => {
    const built = buildPack({ template: 'blank', cwd: join(root, 'truto'), items: [] })
    if ('error' in built) throw new Error(built.error)

    const before = process.env.WAKE_CLAUDE_BIN
    // The launcher reads the binary through env at import time, so this test
    // drives the same refusal through the recorded status instead.
    const status = launcherStatus()
    if (!status.ok) {
      const r = launchPack(built.id)
      expect(r.launched).toBe(false)
      expect(r.error).toBe(status.reason)
    } else {
      // On a machine that does have Claude Code, prove the other half: a pack
      // whose directory has been made invalid is refused before any spawn.
      db.query(`UPDATE launch_packs SET cwd = '/etc' WHERE id = ?`).run(built.id)
      const r = launchPack(built.id)
      expect(r.launched).toBe(false)
      expect(r.error).toContain('not a repository')
    }
    process.env.WAKE_CLAUDE_BIN = before
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
