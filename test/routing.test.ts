/**
 * The two indexes a brief is assembled from: the skill catalogs it names, and
 * the repository registry that decides which repository it may name at all.
 *
 * Both run against fixtures built here, not against whatever this machine
 * happens to have cloned. That distinction has already cost this repo twice —
 * a test that asserted three catalogs existed passed on a laptop and failed on
 * the DevBox, and its replacement still needed ~/work/truto-skills and so failed
 * on CI. The invariant is how the indexer behaves, and a fixture states it in a
 * way that is true everywhere.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import {
  reindexSkills, listSkills, getSkill, loadSkill, loadSkillReference, CATALOG_SURFACE,
} from '../src/server/skills/catalog'
import { rescan, listRepos, resolveCanonical, searchRepos } from '../src/server/registry/scan'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'


/** Catalog A is manifest-first and nested; B and C are flat directories. */
function writeCatalogs() {
  const A = process.env.WAKE_SKILLS_TRUTO!
  const B = process.env.WAKE_SKILLS_CURSOR!
  const C = process.env.WAKE_SKILLS_REPO!

  const skill = (dir: string, name: string, fm: string, body: string) => {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'SKILL.md'), `---\n${fm}\n---\n\n${body}\n`)
  }

  // A: under `skills/`, with a manifest whose curated text must win over the
  // file's own frontmatter.
  skill(join(A, 'skills'), 'truto-operator', 'title: from the file\ndescription: platform operations', 'Body A.')
  mkdirSync(join(A, 'manifest'), { recursive: true })
  writeFileSync(
    join(A, 'manifest', 'skills.json'),
    JSON.stringify({ skills: [{ id: 'truto-operator', title: 'from the manifest', whenToUse: 'a platform incident' }] }),
  )

  skill(B, 'truto-cli-toolbelt', 'description: the CLI baseline', 'Body B.')
  // A reference file, so "listed but not inlined" is a real assertion.
  mkdirSync(join(B, 'truto-cli-toolbelt', 'references'), { recursive: true })
  writeFileSync(join(B, 'truto-cli-toolbelt', 'references', 'flags.md'), 'the flags\n')

  skill(C, 'ginger-migration-guardrails', 'description: repo engineering', 'Body C.')
}

beforeAll(() => {
  writeCatalogs()
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

  test('all three catalogs are indexed, one skill each', () => {
    expect(listSkills().map(s => s.id).sort()).toEqual([
      'A/truto-operator',
      'B/truto-cli-toolbelt',
      'C/ginger-migration-guardrails',
    ])
  })

  test('the manifest wins over the file for the fields it curates', () => {
    // The manifest carries whenToUse written for routing; the frontmatter is
    // written for a human opening the file. Identity and path are never
    // overridable, or the index could disagree with the disk.
    const a = getSkill('A/truto-operator')!
    expect(a.title).toBe('from the manifest')
    expect(a.when_to_use).toBe('a platform incident')
    expect(a.path).toContain('truto-operator/SKILL.md')
  })

  test('a skill body is only read on demand, and references are listed not inlined', () => {
    const loaded = loadSkill('B/truto-cli-toolbelt')!
    expect(loaded.body).toContain('Body B.')
    expect(loaded.references).toEqual(['references/flags.md'])
    // The reference's contents are NOT in the body — that is the whole point.
    expect(loaded.body).not.toContain('the flags')
    expect(loadSkillReference('B/truto-cli-toolbelt', 'references/flags.md')).toContain('the flags')
  })

  test('a reference cannot escape its own skill directory', () => {
    const id = 'B/truto-cli-toolbelt'
    expect(loadSkillReference(id, '../../../../etc/passwd')).toBeNull()
    expect(loadSkillReference(id, '/etc/passwd')).toBeNull()
    expect(loadSkillReference(id, 'file:///etc/passwd')).toBeNull()
  })

  test('a bare skill name resolves when unambiguous', () => {
    expect(getSkill('truto-cli-toolbelt')?.id).toBe('B/truto-cli-toolbelt')
    expect(getSkill('not-a-skill')).toBeNull()
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
