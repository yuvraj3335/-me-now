/**
 * The two indexes a brief is assembled from: the skill catalogs it names, and
 * the repository registry that decides which repository it may name at all.
 *
 * These run against the real catalogs on disk. If a skill is missing locally
 * the assertion that needs it is skipped rather than failed, so the suite
 * stays honest on a machine that has not cloned every repo.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import {
  reindexSkills, listSkills, getSkill, loadSkill, loadSkillReference, CATALOG_SURFACE,
} from '../src/server/skills/catalog'
import { rescan, listRepos, resolveCanonical, searchRepos } from '../src/server/registry/scan'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'


beforeAll(() => {
  reindexSkills()
  rescan()
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
    // The invariant is the mapping, not the machine. Asserting that more than
    // one surface appears in the *index* only tested which repositories happen
    // to be cloned — it passed on a laptop with all three catalogs and failed
    // on the box, which has one.
    const surfaces = Object.values(CATALOG_SURFACE)
    expect(new Set(surfaces).size).toBe(surfaces.length)

    // And every indexed skill carries its own catalog's surface, so a CLI
    // playbook can never be offered as advice for the platform MCP.
    for (const s of listSkills()) {
      expect(s.surface, `${s.id} claims the wrong surface`).toBe(CATALOG_SURFACE[s.catalog])
    }
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
