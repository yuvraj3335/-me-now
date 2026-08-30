/**
 * The brief's routing rules are mandatory. A model can be told to load a
 * baseline skill and simply not do it, which is why routing happens in code —
 * and why it needs tests that fail when someone edits the rules out.
 *
 * These run against the real catalogs on disk. If a skill is missing locally
 * the assertion that needs it is skipped rather than failed, so the suite
 * stays honest on a machine that has not cloned every repo.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { reindexSkills, listSkills, getSkill, loadSkill, loadSkillReference } from '../src/server/skills/catalog'
import { routeSkills } from '../src/server/skills/route'
import { rescan, listRepos, resolveCanonical, searchRepos } from '../src/server/registry/scan'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let hasCatalogB = false
let hasCatalogC = false

beforeAll(() => {
  reindexSkills()
  rescan()
  hasCatalogB = listSkills('B').length > 0
  hasCatalogC = listSkills('C').length > 0
})

describe('skill index', () => {
  test('indexes metadata, not bodies', () => {
    const skills = listSkills()
    expect(skills.length).toBeGreaterThan(0)
    for (const s of skills) {
      expect(s).not.toHaveProperty('body')
      expect(s.path).toContain('SKILL.md')
    }
  })

  test('catalogs stay separate because they target different surfaces', () => {
    const surfaces = new Set(listSkills().map(s => s.surface))
    expect(surfaces.size).toBeGreaterThan(1)
  })

  test('a skill body is only read on demand', () => {
    const any = listSkills()[0]!
    const loaded = loadSkill(any.id)
    expect(loaded?.body.length).toBeGreaterThan(0)
    expect(loaded?.references).toBeInstanceOf(Array)
  })

  test('a reference cannot escape its own skill directory', () => {
    const any = listSkills()[0]!
    expect(loadSkillReference(any.id, '../../../../etc/passwd')).toBeNull()
    expect(loadSkillReference(any.id, '/etc/passwd')).toBeNull()
  })

  test('a bare skill name resolves when unambiguous', () => {
    const any = listSkills()[0]!
    expect(getSkill(any.name)?.id).toBe(any.id)
  })
})

describe('mandatory routing rules', () => {
  test('CLI investigations always load the toolbelt first', () => {
    if (!hasCatalogB) return
    for (const mode of ['support', 'account', 'api', 'mappings', 'sync', 'webhooks'] as const) {
      const r = routeSkills({ mode, prompt: 'the sync is failing for acme' })
      expect(r.baseline, `${mode} lost its baseline`).toBe('B/truto-cli-toolbelt')
    }
  })

  test('anything that could mutate also loads the safe-admin operator', () => {
    if (!hasCatalogB || !getSkill('B/truto-safe-admin-operator')) return
    const r = routeSkills({ mode: 'support', prompt: 'update the environment integration override for acme' })
    expect(r.forced).toContain('B/truto-safe-admin-operator')
  })

  test('a read-only question does not drag in the mutation skill', () => {
    if (!hasCatalogB) return
    const r = routeSkills({ mode: 'support', prompt: 'why did acme see a 500 yesterday' })
    expect(r.forced).not.toContain('B/truto-safe-admin-operator')
  })

  test('a *Service.ts change forces the ginger guardrails', () => {
    if (!hasCatalogC || !getSkill('C/ginger-migration-guardrails')) return
    const r = routeSkills({ mode: 'engineering', prompt: 'add a field to syncJobService.ts' })
    expect(r.forced).toContain('C/ginger-migration-guardrails')
  })

  test('an API contract change forces the platform checklist', () => {
    if (!hasCatalogC || !getSkill('C/platform-change-checklist')) return
    const r = routeSkills({ mode: 'engineering', prompt: 'add a new query param to the public api' })
    expect(r.forced).toContain('C/platform-change-checklist')
  })

  test('path-scoped rule files are demanded before editing', () => {
    const cli = routeSkills({ mode: 'engineering', prompt: 'change the output format', files: ['cli/src/x.ts'] })
    expect(cli.repoRules).toContain('cli/CLAUDE.md')
    const sync = routeSkills({ mode: 'engineering', prompt: 'fix pagination', files: ['src/sync-job/v4.ts'] })
    expect(sync.repoRules).toContain('src/sync-job/CLAUDE.md')
  })

  test('routing stays small — one baseline, one specialist', () => {
    const r = routeSkills({ mode: 'support', prompt: 'acme salesforce contacts sync is failing' })
    const total = [r.baseline, r.specialist, ...r.forced].filter(Boolean).length
    expect(total).toBeLessThanOrEqual(3)
  })

  test('every routed skill actually exists in the index', () => {
    for (const mode of ['triage', 'support', 'sync', 'engineering', 'incident'] as const) {
      const r = routeSkills({ mode, prompt: 'something is broken for a customer' })
      for (const id of [r.baseline, r.specialist, ...r.forced].filter(Boolean) as string[]) {
        expect(getSkill(id), `${mode} routed to missing skill ${id}`).not.toBeNull()
      }
    }
  })

  test('routing explains itself', () => {
    const r = routeSkills({ mode: 'sync', prompt: 'sync job v4 keeps failing' })
    expect(r.rules.length).toBeGreaterThan(0)
  })
})

/**
 * The registry is tested against a workspace this file builds, not against
 * whatever happens to be checked out on the machine running the suite. The
 * previous version asserted `listRepos().length > 0`, which passed on the
 * author's laptop and said nothing at all — and the worktree assertions below
 * silently skipped wherever no worktree existed.
 */
describe('repository registry', () => {
  const root = process.env.WAKE_WORKSPACE_ROOT!

  beforeAll(() => {
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(['git', ...args], {
        cwd,
        stdout: 'ignore',
        stderr: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'wake', GIT_AUTHOR_EMAIL: 'wake@example.com',
          GIT_COMMITTER_NAME: 'wake', GIT_COMMITTER_EMAIL: 'wake@example.com',
        } as Record<string, string>,
      })

    mkdirSync(join(root, 'truto'), { recursive: true })
    writeFileSync(join(root, 'truto', 'README.md'), '# truto\n\nThe platform.\n')
    writeFileSync(join(root, 'truto', 'CLAUDE.md'), '# rules\n')
    writeFileSync(
      join(root, 'truto', 'package.json'),
      JSON.stringify({ name: 'truto', scripts: { test: 'vitest', typecheck: 'tsc --noEmit' } }),
    )
    git(join(root, 'truto'), 'init', '-b', 'main')
    git(join(root, 'truto'), 'add', '.')
    git(join(root, 'truto'), 'commit', '-m', 'init')

    // A real linked worktree, so "resolved from git, not from a list of names"
    // is actually exercised rather than skipped.
    git(join(root, 'truto'), 'worktree', 'add', '-b', 'fix/thing', join(root, 'truto-fix'))

    mkdirSync(join(root, 'truto-blog'), { recursive: true })
    writeFileSync(join(root, 'truto-blog', 'README.md'), '# blog\n')
    git(join(root, 'truto-blog'), 'init', '-b', 'main')
    git(join(root, 'truto-blog'), 'add', '.')
    git(join(root, 'truto-blog'), 'commit', '-m', 'init')

    rescan(root)
  })

  test('finds every repository under the workspace root', () => {
    const names = listRepos().map(r => r.name).sort()
    expect(names).toEqual(['truto', 'truto-blog', 'truto-fix'])
  })

  test('a worktree resolves to its canonical repo', () => {
    const wt = listRepos().find(r => r.role === 'worktree')
    expect(wt, 'the fixture worktree was not detected').toBeDefined()
    const resolved = resolveCanonical(wt!.path)
    expect(resolved?.canonical.path).toBe(wt!.upstream!)
    expect(resolved?.canonical.name).toBe('truto')
    expect(resolved?.canonical.role).not.toBe('worktree')
  })

  test('worktrees are detected from git, not from a list of names', () => {
    for (const r of listRepos().filter(x => x.role === 'worktree')) {
      expect(r.upstream).toBeTruthy()
      expect(listRepos().some(x => x.path === r.upstream)).toBe(true)
    }
  })

  test('a content repo is marked rather than hidden', () => {
    expect(listRepos().find(r => r.name === 'truto-blog')?.role).toBe('content')
  })

  test('search returns nothing rather than a wrong repo', () => {
    // The regression that mattered: role bonuses used to give every canonical
    // repo a passing score on a query none of its terms matched.
    expect(searchRepos('zzzznotathinginthisworkspace')).toHaveLength(0)
  })

  test('canonical repos outrank their worktrees', () => {
    const hits = searchRepos('sync job')
    const canonical = hits.findIndex(r => r.name === 'truto')
    const worktree = hits.findIndex(r => r.role === 'worktree')
    if (canonical !== -1 && worktree !== -1) expect(canonical).toBeLessThan(worktree)
  })

  test('verification commands come from the repo, not from a guess', () => {
    const truto = listRepos().find(r => r.name === 'truto')!
    expect(truto.commands.test).toMatch(/^(npm|yarn|pnpm|bun) run test$/)
    for (const r of listRepos()) {
      for (const cmd of Object.values(r.commands)) {
        expect(cmd).toMatch(/^(npm|yarn|pnpm|bun|cargo) run /)
      }
    }
  })
})
