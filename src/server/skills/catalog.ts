/**
 * The skill catalogs, indexed metadata-first.
 *
 * The rule this file exists to enforce: never put every SKILL.md in a prompt.
 * Startup indexes only `id / name / description / whenToUse / path`, routing
 * picks a baseline and at most one specialist, and the body is read through
 * `loadSkill` at the moment it is needed. A corpus of ~30 skills is well over
 * 200KB of Markdown; the index is a few KB.
 *
 * Catalogs are kept separate because they target different execution surfaces.
 * A CLI playbook that says "run `truto integrations get`" is wrong advice for
 * the platform MCP, and a repo skill about ginger is wrong advice for both.
 */

import { readdirSync, readFileSync, existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { db, now } from '../db'
import { CLAUDE_HOME, SKILL_PATHS } from '../env'

export type Catalog = 'A' | 'B' | 'C'

/** Which tool surface a catalog's advice is written for. */
export const CATALOG_SURFACE: Record<Catalog, string> = {
  A: 'platform_mcp',
  B: 'truto_cli',
  C: 'repo_engineering',
}

export type Skill = {
  id: string
  catalog: Catalog
  name: string
  title: string | null
  description: string | null
  when_to_use: string | null
  surface: string
  requires: string[]
  mutating: number
  path: string
  sha: string | null
  bytes: number
  indexed_at: number
  /**
   * Whether a Claude Code session could actually load this by name, and where.
   *
   * The brief names skills and never inlines them, on the argument that "the
   * session can read them itself, and it has the same catalogs Wake indexes".
   * The second half of that sentence was not true. Wake indexes three trees;
   * a session resolves a name from `~/.claude/skills` and from
   * `<cwd>/.claude/skills`, and those are not the same set:
   *
   *   - Catalog B is `~/work/Cursor-skills/.cursor/skills`, fifteen skills.
   *     Exactly one of them — `humanizer-voice` — is symlinked into
   *     `~/.claude/skills`. The other fourteen are loadable by nothing, and Wake
   *     was offering all fourteen as chips in the composer and writing whichever
   *     were chosen into a brief that says "load them from your own catalogs".
   *   - Catalog C is `~/work/truto/.claude/skills`, which a session running in
   *     `truto` finds and a session running in `truto-app` does not — while
   *     `review-pr`, whose `defaultRepo` is null and which is the template for
   *     any repository's pull request, names `platform-change-checklist` out of
   *     exactly that tree.
   *
   * So reach is computed rather than assumed, at read time rather than at index
   * time, because it is a fact about the filesystem now and not about when the
   * index last ran. `user` is loadable from anywhere; `project` is loadable
   * under `root` and nowhere else; `none` cannot be loaded by any session on
   * this machine, and a brief that names one is a brief giving an order that
   * cannot be carried out.
   */
  reach: 'user' | 'project' | 'none'
  /** For `project` reach, the directory a session has to be inside. */
  root: string | null
}

/* --------------------------- frontmatter parsing -------------------------- */

/**
 * A deliberately small YAML reader: these frontmatter blocks are flat
 * `key: value` with occasional block scalars, and a YAML dependency would be
 * the only one in the project.
 */
function frontmatter(md: string): Record<string, string> {
  if (!md.startsWith('---')) return {}
  const end = md.indexOf('\n---', 3)
  if (end === -1) return {}
  const body = md.slice(4, end)

  const out: Record<string, string> = {}
  let key: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (key) out[key] = buf.join('\n').trim()
    key = null
    buf = []
  }


  for (const line of body.split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line)
    if (m) {
      flush()
      key = m[1] ?? null
      const v = (m[2] ?? '').trim()
      // `key: >-` / `key: |` open a block scalar; the value is the lines below.
      buf = v === '>' || v === '>-' || v === '|' || v === '|-' ? [] : [v]
    } else if (key && /^\s+\S/.test(line)) {
      buf.push(line.trim())
    }
  }
  flush()

  for (const k of Object.keys(out)) out[k] = (out[k] ?? '').replace(/^["']|["']$/g, '')
  return out
}

function sha(s: string): string {
  return new Bun.CryptoHasher('sha256').update(s).digest('hex').slice(0, 16)
}

function dirsIn(p: string): string[] {
  try {
    return readdirSync(p).filter(e => {
      try {
        return statSync(join(p, e)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

/**
 * Skills whose advice ends in a write. Routing pairs these with the safe-admin
 * baseline rather than trusting the model to remember it — the brief makes that
 * pairing mandatory, so it belongs in code.
 */
const MUTATING = new Set([
  'B/truto-safe-admin-operator',
  'B/truto-integration-build-planner',
  'B/truto-environment-override-auditor',
  'A/truto-operator',
  'A/truto-integrations-build',
  'A/truto-unified-mappings',
  'C/migrate-service-to-ginger',
  'C/add-catalog-entry',
  'C/cli-release',
])

/* -------------------------------- indexing ------------------------------- */

/**
 * Reach is deliberately not part of what gets indexed.
 *
 * It is a fact about the filesystem *now* — which names `~/.claude/skills`
 * currently carries — and the index is a snapshot of what was read at startup.
 * Storing it would let the two disagree, and the disagreement would be silent
 * in exactly the direction that hurts: a brief going on naming a skill after the
 * symlink that made it loadable was removed. So the row on disk is identity and
 * metadata, and `hydrate` computes reach on every read.
 */
type IndexedSkill = Omit<Skill, 'reach' | 'root'>

function readSkillDir(catalog: Catalog, root: string, name: string, extra: Partial<Skill> = {}): IndexedSkill | null {
  const file = join(root, name, 'SKILL.md')
  if (!existsSync(file)) return null
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const fm = frontmatter(raw)
  const id = `${catalog}/${name}`

  // `extra` carries curated manifest text, and may only influence the two
  // descriptive fields. Identity, path and the content hash are derived from
  // the file we just read and are not overridable — a caller that could
  // override them could make the index disagree with the disk.
  return {
    id,
    catalog,
    name,
    title: extra.title ?? fm.title ?? name,
    description: fm.description ?? null,
    // whenToUse is the field routing actually reads; description is the fallback.
    when_to_use: extra.when_to_use ?? fm.whenToUse ?? fm.when_to_use ?? fm.description ?? null,
    surface: CATALOG_SURFACE[catalog],
    requires: [],
    mutating: MUTATING.has(id) ? 1 : 0,
    path: file,
    sha: sha(raw),
    bytes: raw.length,
    indexed_at: now(),
  }
}

/** Catalog A — the published Truto skill corpus, metadata from its own manifest. */
function indexCatalogA(): IndexedSkill[] {
  const root = SKILL_PATHS.truto
  const skillsDir = join(root, 'skills')
  if (!existsSync(skillsDir)) return []

  // The manifest carries curated whenToUse text; prefer it over the frontmatter,
  // then fall back to walking the directory so a skill added but not yet
  // manifested is still findable.
  const manifest = new Map<string, { title?: string; whenToUse?: string }>()
  const mPath = join(root, 'manifest', 'skills.json')
  if (existsSync(mPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mPath, 'utf8'))
      for (const s of parsed.skills ?? []) manifest.set(s.id, s)
    } catch {
      /* a malformed manifest degrades to directory scanning, not to nothing */
    }
  }

  return dirsIn(skillsDir)
    .map(name => {
      const m = manifest.get(name)
      return readSkillDir('A', skillsDir, name, {
        title: m?.title ?? name,
        when_to_use: m?.whenToUse ?? null,
      })
    })
    .filter((s): s is IndexedSkill => s !== null)
}

function indexFlat(catalog: Catalog, root: string): IndexedSkill[] {
  if (!existsSync(root)) return []
  return dirsIn(root)
    .map(name => readSkillDir(catalog, root, name))
    .filter((s): s is IndexedSkill => s !== null)
}

const UPSERT = `
INSERT INTO skills (id, catalog, name, title, description, when_to_use, surface,
                    requires, mutating, path, sha, bytes, indexed_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  catalog=excluded.catalog, name=excluded.name, title=excluded.title,
  description=excluded.description, when_to_use=excluded.when_to_use,
  surface=excluded.surface, requires=excluded.requires, mutating=excluded.mutating,
  path=excluded.path, sha=excluded.sha, bytes=excluded.bytes, indexed_at=excluded.indexed_at`

export function reindexSkills(): { indexed: number; byCatalog: Record<string, number> } {
  const all = [
    ...indexCatalogA(),
    ...indexFlat('B', SKILL_PATHS.cursor),
    ...indexFlat('C', SKILL_PATHS.repo),
  ]

  const stmt = db.query(UPSERT)
  db.transaction(() => {
    for (const s of all) {
      stmt.run(
        s.id, s.catalog, s.name, s.title, s.description, s.when_to_use, s.surface,
        JSON.stringify(s.requires), s.mutating, s.path, s.sha, s.bytes, s.indexed_at,
      )
    }
    const keep = new Set(all.map(s => s.id))
    for (const r of db.query<{ id: string }, []>(`SELECT id FROM skills`).all()) {
      if (!keep.has(r.id)) db.query(`DELETE FROM skills WHERE id = ?`).run(r.id)
    }
  })()

  const byCatalog: Record<string, number> = {}
  for (const s of all) byCatalog[s.catalog] = (byCatalog[s.catalog] ?? 0) + 1
  return { indexed: all.length, byCatalog }
}

/* --------------------------------- reads --------------------------------- */

/**
 * The names a session can load from anywhere on this machine.
 *
 * `~/.claude/skills` is Claude Code's personal catalog and it is mostly
 * symlinks, so the *name* is what matters rather than the target — a session
 * asks for `truto-cli` and Claude Code looks for a directory of that name. The
 * realpath is read as well so a skill indexed under its true location is
 * recognised as the same thing.
 *
 * Re-read when the directory's mtime moves. Skills are symlinked in and out by
 * hand and a cached answer would go on offering a name that stopped resolving,
 * which is the failure this whole field exists to end.
 */
/*
 * Under `CLAUDE_HOME`, not under `homedir()`.
 *
 * They are the same directory on this machine and they are not the same *fact*:
 * `WAKE_CLAUDE_HOME` is where Wake has been told Claude Code keeps its things,
 * and reach is a claim about what the session Wake is about to start will find.
 * Reading `~` instead would also make this answer depend on the developer's own
 * home from inside a test suite that redirects everything else.
 */
const USER_SKILLS_DIR = `${CLAUDE_HOME}/skills`
let userSkills: { at: number; names: Set<string>; paths: Set<string> } | null = null

function userCatalog(): { names: Set<string>; paths: Set<string> } {
  let at = 0
  try { at = statSync(USER_SKILLS_DIR).mtimeMs } catch { /* absent is an empty catalog */ }
  if (userSkills && userSkills.at === at) return userSkills

  const names = new Set<string>()
  const paths = new Set<string>()
  try {
    for (const e of readdirSync(USER_SKILLS_DIR)) {
      const p = join(USER_SKILLS_DIR, e)
      if (!existsSync(join(p, 'SKILL.md'))) continue
      names.add(e)
      try { paths.add(realpathSync(p)) } catch { /* a broken symlink is not reach */ }
    }
  } catch { /* no personal catalog on this machine */ }

  userSkills = { at, names, paths }
  return userSkills
}

/**
 * A skill's own directory, and the project root it would be scoped to.
 *
 * A project skill lives at `<root>/.claude/skills/<name>/SKILL.md`, so the root
 * is four levels up from the file. Anything not in that shape has no project
 * root — it is either personal or it is out of reach.
 */
function projectRootOf(path: string): string | null {
  const skillsDir = dirname(dirname(path))
  return skillsDir.endsWith('/.claude/skills') ? skillsDir.slice(0, -'/.claude/skills'.length) : null
}

function reachOf(r: { name: string; path: string }): { reach: Skill['reach']; root: string | null } {
  const user = userCatalog()
  if (user.names.has(r.name)) return { reach: 'user', root: null }
  let real = r.path
  try { real = realpathSync(r.path) } catch { /* the indexed path is the best we have */ }
  if (user.paths.has(dirname(real))) return { reach: 'user', root: null }
  const root = projectRootOf(real)
  return root ? { reach: 'project', root } : { reach: 'none', root: null }
}

/** Whether a session running in `cwd` can load this skill by name. */
export const skillReaches = (s: Pick<Skill, 'reach' | 'root'>, cwd: string | null | undefined): boolean =>
  s.reach === 'user' || (s.reach === 'project' && !!cwd && !!s.root && (cwd === s.root || cwd.startsWith(`${s.root}/`)))

function hydrate(r: Record<string, any>): Skill {
  let requires: string[] = []
  try {
    requires = JSON.parse(r.requires)
  } catch {
    /* keep the empty default */
  }
  return { ...r, requires, ...reachOf(r as { name: string; path: string }) } as Skill
}

export function listSkills(catalog?: Catalog): Skill[] {
  const rows = catalog
    ? db.query<Record<string, any>, [string]>(`SELECT * FROM skills WHERE catalog = ? ORDER BY name`).all(catalog)
    : db.query<Record<string, any>, []>(`SELECT * FROM skills ORDER BY catalog, name`).all()
  return rows.map(hydrate)
}

export function getSkill(id: string): Skill | null {
  const r = db.query<Record<string, any>, [string]>(`SELECT * FROM skills WHERE id = ?`).get(id)
  if (r) return hydrate(r)
  // Accept a bare name when it is unambiguous — "truto-cli-toolbelt" is how a
  // person refers to it, and demanding "B/truto-cli-toolbelt" is friction.
  const byName = db
    .query<Record<string, any>, [string]>(`SELECT * FROM skills WHERE name = ? ORDER BY catalog`)
    .all(id)
  return byName.length === 1 && byName[0] ? hydrate(byName[0]) : null
}

export type LoadedSkill = {
  id: string
  name: string
  catalog: Catalog
  sha: string | null
  body: string
  references: string[]
}

const MAX_SKILL_BYTES = 120_000

/**
 * Read one skill body. References are *listed*, never inlined — following them
 * is a second, deliberate call, which is what keeps a skill with a large
 * `references/` directory from silently costing 100KB of context.
 */
export function loadSkill(id: string): LoadedSkill | null {
  const s = getSkill(id)
  if (!s) return null
  let body: string
  try {
    body = readFileSync(s.path, 'utf8')
  } catch {
    return null
  }
  if (body.length > MAX_SKILL_BYTES) {
    body = body.slice(0, MAX_SKILL_BYTES) + '\n\n[…truncated by Wake: skill exceeds the per-skill byte cap]'
  }

  const dir = s.path.replace(/\/SKILL\.md$/, '')
  const references: string[] = []
  for (const sub of ['references', 'agents']) {
    const p = join(dir, sub)
    try {
      for (const f of readdirSync(p)) references.push(`${sub}/${f}`)
    } catch {
      /* no references directory is the common case */
    }
  }
  return { id: s.id, name: s.name, catalog: s.catalog, sha: s.sha, body, references }
}

/** Read one file from a skill's own directory. Confined to that directory. */
export function loadSkillReference(id: string, ref: string): string | null {
  const s = getSkill(id)
  if (!s) return null
  const dir = s.path.replace(/\/SKILL\.md$/, '')
  // Resolve, then require the result to still be inside the skill's directory,
  // so "../../../.ssh/id_rsa" cannot be reached through a reference name.
  const target = Bun.fileURLToPath(new URL(ref, `file://${dir}/`))
  if (!target.startsWith(dir + '/')) return null
  try {
    const body = readFileSync(target, 'utf8')
    return body.length > MAX_SKILL_BYTES ? body.slice(0, MAX_SKILL_BYTES) + '\n[…truncated]' : body
  } catch {
    return null
  }
}
