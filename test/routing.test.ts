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
  reindexSkills, listSkills, getSkill, loadSkill, loadSkillReference, skillReaches,
  CATALOG_SURFACE,
} from '../src/server/skills/catalog'
import { buildPack } from '../src/server/claudecode/launch'
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

/* ---------------------------------------------------------------------------
 * Whether the session can actually load what the brief names.
 * ------------------------------------------------------------------------- */

/**
 * "Named, never inlined" rests on one claim, and the claim was false twice.
 *
 * The brief tells a session to load a skill by name on the argument that it has
 * the same catalogs Wake indexes. It does not. A Claude Code session resolves a
 * name from `~/.claude/skills` and from `<cwd>/.claude/skills`, and on the
 * machine this product runs on, fourteen of the thirty-two skills Wake indexes
 * are in neither place — they live only under an old `Cursor-skills` tree that
 * nothing points at. Wake was offering all fourteen as chips in the composer and
 * writing whichever were chosen into a brief that says "load them from your own
 * catalogs before starting".
 *
 * Nine more are project skills of one repository, while `review-pr` — whose
 * `defaultRepo` is null, so it opens wherever the pull request is — names one of
 * them. An order that cannot be carried out is worse than no order: the session
 * either gives up quietly or loads something with a similar name, and it was
 * measured doing the second.
 */
describe('which skills a session could actually load', () => {
  const HOME_SKILLS = join(process.env.WAKE_CLAUDE_HOME!, 'skills')
  const REPO = join(process.env.WAKE_WORKSPACE_ROOT!, 'truto')

  beforeAll(() => {
    // The personal catalog: what a session finds wherever it is running. On the
    // real machine this is mostly symlinks, so the *name* is what matters.
    mkdirSync(join(HOME_SKILLS, 'truto-cli'), { recursive: true })
    writeFileSync(join(HOME_SKILLS, 'truto-cli', 'SKILL.md'), '---\ndescription: the CLI\n---\n\nbody\n')
    reindexSkills()
  })

  test('a skill in the personal catalog is reachable from anywhere', () => {
    const s = listSkills().find(x => x.name === 'truto-cli')
    // It is indexed out of a catalog directory and reachable because a
    // directory of the same name is in the personal catalog. Both spellings of
    // "the same skill" have to land on `user`, because the session resolves by
    // name and Wake indexes by path.
    expect(s?.reach ?? 'user').toBe('user')
    expect(skillReaches({ reach: 'user', root: null }, '/anywhere/at/all')).toBe(true)
  })

  test('a project skill is reachable only inside its repository', () => {
    const s = listSkills().find(x => x.name === 'ginger-migration-guardrails')!
    expect(s.reach).toBe('project')
    expect(s.root).toBe(REPO)
    expect(skillReaches(s, REPO), 'unreachable in its own repository').toBe(true)
    expect(skillReaches(s, join(REPO, 'src', 'deep')), 'unreachable in a subdirectory').toBe(true)
    expect(skillReaches(s, join(process.env.WAKE_WORKSPACE_ROOT!, 'other')), 'reachable from a sibling repo').toBe(false)
  })

  test('a skill in no catalog a session reads is reachable from nowhere', () => {
    const s = listSkills().find(x => x.name === 'truto-cli-toolbelt')!
    expect(s.reach).toBe('none')
    expect(skillReaches(s, REPO)).toBe(false)
    expect(skillReaches(s, '/anywhere')).toBe(false)
  })

  test('the brief names what is reachable and reports what is not', () => {
    const built = buildPack({
      template: 'blank',
      cwd: REPO,
      skills: ['ginger-migration-guardrails', 'truto-cli-toolbelt'],
      items: [],
    })
    if ('error' in built) throw new Error(built.error)
    const body = built.firstMessage
    // Reachable here, so it is an order the session can carry out.
    expect(body).toContain('`ginger-migration-guardrails`')
    // Not reachable anywhere, so it is reported rather than ordered.
    expect(body).toContain('cannot load')
    expect(body).toContain('not in any catalog a Claude Code session reads')
    expect(body).toContain('truto-cli-toolbelt')
    expect(built.skills, 'an unloadable skill stayed on the pack').not.toContain('truto-cli-toolbelt')
  })

  test('and the same brief opened in another repository loses the project skill', () => {
    const built = buildPack({
      template: 'blank',
      cwd: null,
      skills: ['ginger-migration-guardrails'],
      items: [],
    })
    if ('error' in built) throw new Error(built.error)
    expect(built.firstMessage).toContain('only inside')
    expect(built.skills).toHaveLength(0)
  })

  test('a name Wake does not recognise is passed on rather than overruled', () => {
    // It may be a plugin skill, or one he knows and Wake has not indexed.
    // Refusing to name it would be Wake overruling him with its own ignorance.
    const built = buildPack({ template: 'blank', cwd: REPO, skills: ['some-plugin-skill'], items: [] })
    if ('error' in built) throw new Error(built.error)
    expect(built.firstMessage).toContain('`some-plugin-skill`')
  })
})
