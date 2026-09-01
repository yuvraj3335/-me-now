/**
 * The workspace repository registry.
 *
 * Discovers every git repository under WORKSPACE_ROOT and records enough about
 * each one to *route* a task without opening it. The whole point is that the
 * agent searches this table first and reads only the repositories a task
 * actually concerns — putting forty repos in a prompt is what this exists to
 * avoid.
 *
 * Worktrees are detected from git itself rather than from a list of names. A
 * linked worktree's `.git` is a file reading `gitdir: <canonical>/.git/worktrees/<n>`,
 * so the upstream repository is a fact we can read, not a naming convention we
 * have to keep in sync.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { db, now } from '../db'
import { WORKSPACE_ROOT } from '../env'

export type Repo = {
  path: string
  name: string
  remote: string | null
  branch: string | null
  default_branch: string | null
  dirty: number
  ahead: number
  behind: number
  language: string | null
  package_manager: string | null
  summary: string | null
  claude_md: string[]
  cursor_rules: string[]
  skills: string[]
  topics: string[]
  commands: Record<string, string>
  role: RepoRole
  upstream: string | null
  last_commit_at: number | null
  scanned_at: number
}

export type RepoRole = 'canonical' | 'worktree' | 'fork' | 'poc' | 'archived' | 'content'

/**
 * Repositories the brief says must not be pulled into the assistant runtime
 * unless a task is specifically about them. Marked, not hidden — a marketing
 * task still needs to find them.
 */
const CONTENT_REPOS = new Set([
  'truto-blog', 'truto-cms', 'truto-cms-render',
  'envoy-frontsite', 'clonepartner-frontsite', 'connectaccount-pages',
])

/** Names that read as scratch work regardless of what git says. */
const POC_PATTERN = /(^|-)(poc|spike|scratch|tmp|experiment)(-|$)|-\d{4}-\d{2}-\d{2}$/i

/**
 * What each repository is actually *about*, in the vocabulary a question
 * arrives in.
 *
 * A README's first line is written for a human who already knows the product,
 * so it routes badly: nothing in truto's README says "salesforce" or "sync
 * job", and a customer report says little else. These are the domain terms that
 * make the registry answerable, taken from how the platform is actually
 * divided. Unlisted repos fall back to their README, which is fine for the ones
 * whose name already is the topic.
 */
const TOPICS: Record<string, string[]> = {
  truto: [
    'backend', 'platform', 'api', 'unified', 'proxy', 'integration', 'sync job', 'sync',
    'webhook', 'workflow', 'mcp', 'assistant', 'cloudflare', 'worker', 'd1', 'kysely',
    'salesforce', 'hubspot', 'netsuite', 'zoom', 'jira', 'linear', 'connector',
    'mapping', 'jsonata', 'integrated account', 'custom api', 'batch', 'export',
  ],
  'truto-app': ['frontend', 'ui', 'vue', 'dashboard', 'app', 'assistant ui', 'console', 'web'],
  envoy: ['assistant', 'chat', 'sse', 'turn', 'approval', 'conversation', 'bun', 'hono', 'agent'],
  wake: ['command center', 'triage', 'cards', 'dashboard', 'personal'],
  cardamom: ['proxy', 'provider', 'engine', 'mcp tool', 'derivation', 'integration'],
  'catalog-core': ['catalog', 'contract', 'integration', 'shared'],
  clove: ['catalog', 'integration', 'service'],
  saffron: ['oauth', 'credential', 'vault', 'connection', 'refresh', 'token', 'auth', 'reauth'],
  elaichi: ['mcp', 'control plane', 'toolbox', 'governance'],
  ginger: ['storage', 'service', 'framework', 'typed', 'migration'],
  chronogate: ['rate limit', 'schedule', 'scheduling', 'throttle'],
  staticgate: ['static egress', 'proxy', 'egress', 'ip'],
  'truto-monitoring': [
    'monitoring', 'health', 'suite', 'run', 'issue', 'docs watch', 'digest',
    'schedule', 'suggestion', 'capture', 'operator',
  ],
  'truto-logs': ['logs', 'victorialogs', 'log', 'investigation', 'query'],
  'truto-docs-2': ['docs', 'documentation', 'search index', 'product docs'],
  'truto-skills': ['skill', 'playbook', 'corpus', 'assistant skill'],
  'truto-ts-sdk': ['sdk', 'typescript', 'client'],
  'truto-jsonata': ['jsonata', 'mapping', 'transform', 'expression'],
  'truto-link-sdk': ['link', 'sdk', 'connect', 'widget', 'embed'],
  'truto-langchainjs-toolset': ['langchain', 'toolset', 'llm'],
  'replace-placeholders': ['placeholder', 'template', 'substitution'],
  'document-parser': ['document', 'parse', 'pdf', 'extraction'],
  'truto-test-api': ['test', 'fixture', 'mock api', 'sandbox'],
  'Cursor-skills': ['skill', 'cursor', 'cli skill', 'investigator', 'playbook'],
}

/**
 * A worktree is a checkout of its canonical repo, so it inherits that repo's
 * topics — `truto-assistant-fixes` is about sync jobs and mappings for exactly
 * the same reason `truto` is.
 */
function topicsFor(name: string, upstream: string | null): string[] {
  if (TOPICS[name]) return TOPICS[name]
  if (upstream) return TOPICS[basename(upstream)] ?? []
  return []
}

function sh(cwd: string, argv: string[], ms = 5_000): string | null {
  try {
    const p = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'ignore', timeout: ms })
    if (p.exitCode !== 0) return null
    return p.stdout.toString().trim() || null
  } catch {
    return null
  }
}

/** Directories that are never worth descending into. */
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', 'vendor', '.venv'])

/**
 * Depth-limited scan. Repos live one or two levels under the root in practice;
 * going deeper finds vendored checkouts inside dependencies, which are noise.
 */
function findRepos(root: string, depth = 2): string[] {
  const out: string[] = []
  const walk = (dir: string, d: number) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (entries.includes('.git')) {
      out.push(dir)
      return // a repo's subdirectories are its own business
    }
    if (d <= 0) return
    for (const e of entries) {
      if (SKIP_DIR.has(e) || e.startsWith('.')) continue
      const full = join(dir, e)
      try {
        if (statSync(full).isDirectory()) walk(full, d - 1)
      } catch {
        /* a broken symlink is not an error worth failing the scan for */
      }
    }
  }
  walk(root, depth)
  return out
}

/** `.git` as a file means a linked worktree; its contents name the canonical repo. */
function worktreeUpstream(repoPath: string): string | null {
  const dotGit = join(repoPath, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return null
    const m = /gitdir:\s*(.+)/.exec(readFileSync(dotGit, 'utf8'))
    if (!m) return null
    // <canonical>/.git/worktrees/<name>  ->  <canonical>
    const wt = (m[1] ?? '').trim()
    const idx = wt.indexOf('/.git/worktrees/')
    return idx === -1 ? null : wt.slice(0, idx)
  } catch {
    return null
  }
}

function firstProse(md: string): string | null {
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('![') || line.startsWith('[!')) continue
    if (line.startsWith('>') || line.startsWith('---') || line.startsWith('|')) continue
    return line.replace(/[*_`]/g, '').slice(0, 240)
  }
  return null
}

function readmeSummary(repoPath: string): string | null {
  for (const n of ['README.md', 'readme.md', 'README.markdown', 'README']) {
    const p = join(repoPath, n)
    if (!existsSync(p)) continue
    try {
      return firstProse(readFileSync(p, 'utf8').slice(0, 8_000))
    } catch {
      return null
    }
  }
  return null
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Every CLAUDE.md in the repo — the root one plus the path-scoped ones. */
function claudeMds(repoPath: string): string[] {
  const found: string[] = []
  if (existsSync(join(repoPath, 'CLAUDE.md'))) found.push('CLAUDE.md')
  const walk = (rel: string, d: number) => {
    if (d <= 0) return
    for (const e of listFiles(join(repoPath, rel))) {
      if (SKIP_DIR.has(e)) continue
      const childRel = rel ? `${rel}/${e}` : e
      const full = join(repoPath, childRel)
      try {
        if (!statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      if (existsSync(join(full, 'CLAUDE.md'))) found.push(`${childRel}/CLAUDE.md`)
      walk(childRel, d - 1)
    }
  }
  for (const top of ['src', 'cli', 'packages', 'apps']) {
    if (!existsSync(join(repoPath, top))) continue
    // The directory's own CLAUDE.md counts too — `cli/CLAUDE.md` is exactly the
    // kind of path-scoped rule file the brief requires be loaded before editing.
    if (existsSync(join(repoPath, top, 'CLAUDE.md'))) found.push(`${top}/CLAUDE.md`)
    walk(top, 3)
  }
  return found
}

function detectLanguage(repoPath: string, files: string[]): string | null {
  if (files.includes('package.json')) {
    return existsSync(join(repoPath, 'tsconfig.json')) ? 'typescript' : 'javascript'
  }
  if (files.includes('Cargo.toml')) return 'rust'
  if (files.includes('go.mod')) return 'go'
  if (files.includes('pyproject.toml') || files.includes('requirements.txt')) return 'python'
  if (files.some(f => f.endsWith('.xcodeproj') || f === 'Package.swift')) return 'swift'
  return null
}

function detectPackageManager(files: string[]): string | null {
  if (files.includes('bun.lock') || files.includes('bun.lockb')) return 'bun'
  if (files.includes('pnpm-lock.yaml')) return 'pnpm'
  if (files.includes('yarn.lock')) return 'yarn'
  if (files.includes('package-lock.json')) return 'npm'
  if (files.includes('Cargo.lock')) return 'cargo'
  return files.includes('package.json') ? 'npm' : null
}

/**
 * Verification commands, read from the repo's own package.json rather than
 * guessed. An agent that runs the wrong test command reports a false pass.
 */
function detectCommands(repoPath: string, pm: string | null): Record<string, string> {
  const pkgPath = join(repoPath, 'package.json')
  if (!existsSync(pkgPath) || !pm) return {}
  let scripts: Record<string, string> = {}
  try {
    scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {}
  } catch {
    return {}
  }
  const run = (s: string) => (pm === 'npm' ? `npm run ${s}` : `${pm} run ${s}`)
  const pick = (...names: string[]) => names.find(n => scripts[n])

  const out: Record<string, string> = {}
  const test = pick('test', 'test:unit', 'vitest')
  // `bun test` and `bun run test` are different commands; only the latter is a script.
  if (test) out.test = run(test)
  const tc = pick('typecheck', 'type-check', 'tsc', 'check-types')
  if (tc) out.typecheck = run(tc)
  const build = pick('build', 'compile')
  if (build) out.build = run(build)
  const dev = pick('dev', 'start', 'serve')
  if (dev) out.dev = run(dev)
  return out
}

function repoSkills(repoPath: string): string[] {
  const dir = join(repoPath, '.claude', 'skills')
  return listFiles(dir).filter(e => existsSync(join(dir, e, 'SKILL.md')))
}

function cursorRules(repoPath: string): string[] {
  const out: string[] = []
  for (const rel of ['.cursorrules', '.cursor/rules']) {
    const p = join(repoPath, rel)
    if (!existsSync(p)) continue
    try {
      if (statSync(p).isDirectory()) out.push(...listFiles(p).map(f => `${rel}/${f}`))
      else out.push(rel)
    } catch {
      /* ignore */
    }
  }
  return out
}

function classify(name: string, upstream: string | null, remote: string | null): RepoRole {
  if (upstream) return 'worktree'
  if (CONTENT_REPOS.has(name)) return 'content'
  if (POC_PATTERN.test(name)) return 'poc'
  // A remote pointing somewhere other than the org this workspace belongs to.
  if (remote && !/[:/](trutohq|yuvraj3335)\//i.test(remote)) return 'fork'
  return 'canonical'
}

export function scanRepo(repoPath: string): Repo {
  const name = basename(repoPath)
  const files = listFiles(repoPath)
  const upstream = worktreeUpstream(repoPath)
  const remote = sh(repoPath, ['git', 'remote', 'get-url', 'origin'])
  const branch = sh(repoPath, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])

  // origin/HEAD is only present when someone has set it; fall back to the
  // conventional names rather than claiming we don't know.
  const originHead = sh(repoPath, ['git', 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  let defaultBranch = originHead?.replace('refs/remotes/origin/', '') ?? null
  if (!defaultBranch) {
    for (const cand of ['main', 'master']) {
      if (sh(repoPath, ['git', 'rev-parse', '--verify', `refs/heads/${cand}`])) {
        defaultBranch = cand
        break
      }
    }
  }

  /*
   * `dirty` is **tracked** changes, and the flag is the whole finding.
   *
   * This was bare `git status --porcelain`, whose default counts untracked
   * paths as well — collapsing an untracked directory to one line, which is its
   * own kind of wrong. Measured across the workspace: `truto` 37, `truto-app`
   * 37, `wake` 4, and `--untracked-files=no` **0 for every repository on the
   * box**. There was not one uncommitted tracked change anywhere. All 78 of
   * those lines were agent debris — QA reports, `.playwright-mcp/`, and 27
   * screenshots in `truto` alone, which expand to 327 under `-uall`.
   *
   * So the picker said "37 dirty" beside a repository with nothing uncommitted
   * in it. Arithmetically correct, semantically the opposite of what a person
   * reads it as, and on the one control where the number is supposed to answer
   * "is there work in progress here".
   *
   * `-uno` is the number that answers that question. An untracked file is also
   * the one thing git cannot lose in a merge or a checkout, so it is not work at
   * risk; a modified tracked file is.
   */
  const status = sh(repoPath, ['git', 'status', '--porcelain', '--untracked-files=no'])
  const dirty = status ? status.split('\n').filter(Boolean).length : 0

  let ahead = 0
  let behind = 0
  const counts = sh(repoPath, ['git', 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
  if (counts) {
    const [b, a] = counts.split(/\s+/).map(Number)
    behind = Number.isFinite(b) ? (b as number) : 0
    ahead = Number.isFinite(a) ? (a as number) : 0
  }

  const lastCommit = sh(repoPath, ['git', 'log', '-1', '--format=%ct'])
  const pm = detectPackageManager(files)

  return {
    path: repoPath,
    name,
    remote,
    branch,
    default_branch: defaultBranch,
    dirty,
    ahead,
    behind,
    language: detectLanguage(repoPath, files),
    package_manager: pm,
    summary: readmeSummary(repoPath),
    claude_md: claudeMds(repoPath),
    cursor_rules: cursorRules(repoPath),
    skills: repoSkills(repoPath),
    topics: topicsFor(name, upstream),
    commands: detectCommands(repoPath, pm),
    role: classify(name, upstream, remote),
    upstream,
    last_commit_at: lastCommit ? Number(lastCommit) * 1000 : null,
    scanned_at: now(),
  }
}

const UPSERT = `
INSERT INTO repos (path, name, remote, branch, default_branch, dirty, ahead, behind,
                   language, package_manager, summary, claude_md, cursor_rules, skills,
                   topics, commands, role, upstream, last_commit_at, scanned_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(path) DO UPDATE SET
  name=excluded.name, remote=excluded.remote, branch=excluded.branch,
  default_branch=excluded.default_branch, dirty=excluded.dirty, ahead=excluded.ahead,
  behind=excluded.behind, language=excluded.language, package_manager=excluded.package_manager,
  summary=excluded.summary, claude_md=excluded.claude_md, cursor_rules=excluded.cursor_rules,
  skills=excluded.skills, topics=excluded.topics, commands=excluded.commands, role=excluded.role,
  upstream=excluded.upstream, last_commit_at=excluded.last_commit_at,
  scanned_at=excluded.scanned_at`

export function rescan(root = WORKSPACE_ROOT): { scanned: number; ms: number } {
  const t0 = Date.now()
  const paths = findRepos(root)
  const stmt = db.query(UPSERT)

  const write = db.transaction((repos: Repo[]) => {
    for (const r of repos) {
      stmt.run(
        r.path, r.name, r.remote, r.branch, r.default_branch, r.dirty, r.ahead, r.behind,
        r.language, r.package_manager, r.summary, JSON.stringify(r.claude_md),
        JSON.stringify(r.cursor_rules), JSON.stringify(r.skills), JSON.stringify(r.topics),
        JSON.stringify(r.commands),
        r.role, r.upstream, r.last_commit_at, r.scanned_at,
      )
    }
    // A repo that has been deleted or moved must not linger as a routing target.
    const keep = new Set(repos.map(r => r.path))
    for (const row of db.query<{ path: string }, []>(`SELECT path FROM repos`).all()) {
      if (!keep.has(row.path)) db.query(`DELETE FROM repos WHERE path = ?`).run(row.path)
    }
  })

  write(paths.map(scanRepo))
  return { scanned: paths.length, ms: Date.now() - t0 }
}

type Row = Record<string, any>

function hydrate(r: Row): Repo {
  const j = (v: string, d: unknown) => {
    try {
      return JSON.parse(v)
    } catch {
      return d
    }
  }
  return {
    ...r,
    claude_md: j(r.claude_md, []),
    cursor_rules: j(r.cursor_rules, []),
    skills: j(r.skills, []),
    topics: j(r.topics, []),
    commands: j(r.commands, {}),
  } as Repo
}

export function listRepos(): Repo[] {
  return db
    .query<Row, []>(`SELECT * FROM repos ORDER BY role = 'canonical' DESC, name`)
    .all()
    .map(hydrate)
}

export function getRepo(pathOrName: string): Repo | null {
  const abs = resolve(pathOrName)
  const byPath = db.query<Row, [string]>(`SELECT * FROM repos WHERE path = ?`).get(abs)
  if (byPath) return hydrate(byPath)
  const byName = db.query<Row, [string]>(`SELECT * FROM repos WHERE name = ?`).get(pathOrName)
  return byName ? hydrate(byName) : null
}

/**
 * Resolve a repository the way the brief requires: a worktree must report its
 * canonical upstream rather than passing itself off as a separate product.
 */
export function resolveCanonical(pathOrName: string): { repo: Repo; canonical: Repo } | null {
  const repo = getRepo(pathOrName)
  if (!repo) return null
  if (!repo.upstream) return { repo, canonical: repo }
  const canonical = getRepo(repo.upstream)
  return { repo, canonical: canonical ?? repo }
}

/** Keyword search over the registry — this is what runs before any repo is opened. */
export function searchRepos(q: string, limit = 8): Repo[] {
  const terms = q.toLowerCase().split(/[^a-z0-9-]+/i).filter(t => t.length > 2)
  if (!terms.length) return listRepos().filter(r => r.role === 'canonical').slice(0, limit)

  const scored = listRepos().map(r => {
    const hay = `${r.name} ${r.summary ?? ''} ${r.language ?? ''} ${r.path} ${r.topics.join(' ')}`.toLowerCase()
    let score = 0
    for (const t of terms) {
      if (r.name.toLowerCase() === t) score += 10
      else if (r.name.toLowerCase().includes(t)) score += 5
      else if (hay.includes(t)) score += 1
    }
    // Role only ever *breaks a tie*. Applied unconditionally it would give every
    // canonical repo a passing score on a query none of its terms matched, which
    // is how "salesforce" once returned an unrelated proxy engine.
    if (score === 0) return { r, score: 0 }
    if (r.role === 'canonical') score += 2
    // A worktree is a checkout of something else; the canonical repo answers first.
    if (r.role === 'worktree') score -= 2
    if (r.role === 'content' || r.role === 'archived') score -= 3
    return { r, score }
  })

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.r)
}
