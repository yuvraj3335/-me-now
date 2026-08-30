/**
 * Intent → skills.
 *
 * The brief's routing rules are mandatory ("always load truto-cli-toolbelt
 * before a Truto CLI investigation", "before any mutation, additionally load
 * truto-safe-admin-operator"), so they are encoded here rather than described
 * in a system prompt and hoped for. A prompt can be ignored by the model; a
 * missing baseline here is a bug with a test against it.
 *
 * The output is deliberately small: one baseline, at most one specialist, plus
 * whatever a hard rule forces. Everything else is discoverable — the agent has
 * a `skills_search` tool and can pull a second specialist when it finds it
 * needs one.
 */

import { listSkills, getSkill, type Skill } from './catalog'
import type { ModeId } from '../agent/modes'

export type Routing = {
  baseline: string | null
  specialist: string | null
  forced: string[]
  /** Human-readable reasons, shown in the Agent inspector. */
  rules: string[]
  /** Repo rule files that must be read before editing. */
  repoRules: string[]
}

/** Every mode's baseline skill, and the catalog its specialists come from. */
const MODE_BASELINE: Record<ModeId, { baseline: string | null; catalog: 'A' | 'B' | 'C' | null }> = {
  triage: { baseline: null, catalog: null },
  support: { baseline: 'B/truto-cli-toolbelt', catalog: 'B' },
  account: { baseline: 'B/truto-cli-toolbelt', catalog: 'B' },
  api: { baseline: 'B/truto-cli-toolbelt', catalog: 'B' },
  mappings: { baseline: 'B/truto-cli-toolbelt', catalog: 'B' },
  sync: { baseline: 'B/truto-cli-toolbelt', catalog: 'B' },
  webhooks: { baseline: 'B/truto-cli-toolbelt', catalog: 'B' },
  engineering: { baseline: null, catalog: 'C' },
  incident: { baseline: 'A/truto-operator', catalog: 'B' },
}

/** The specialist each mode reaches for when the prompt gives no better signal. */
const MODE_DEFAULT_SPECIALIST: Partial<Record<ModeId, string>> = {
  support: 'B/truto-customer-issue-debugger',
  account: 'B/truto-account-health-auditor',
  api: 'B/truto-api-call-reproducer',
  mappings: 'B/truto-mapping-tester',
  sync: 'B/truto-sync-job-validator',
  webhooks: 'B/truto-webhook-workflow-debugger',
  incident: 'B/truto-customer-issue-debugger',
}

/**
 * Extra routing vocabulary per specialist. `whenToUse` is written for a human
 * deciding whether to open the skill, so it under-represents the words a report
 * actually arrives in ("401", "429", "missing rows").
 */
const SPECIALIST_HINTS: Record<string, string[]> = {
  'B/truto-customer-issue-debugger': ['customer', 'ticket', 'reported', 'complain', 'slack thread', 'email thread', 'sentry'],
  'B/truto-account-health-auditor': ['credential', 'scope', 'reauth', 'reauthoriz', 'token expired', 'disconnected', '401', 'unauthorized', 'account health'],
  'B/truto-api-call-reproducer': ['reproduce', 'repro', 'curl', 'request', 'response', '500', '502', '404', 'endpoint', 'status code'],
  'B/truto-mapping-tester': ['mapping', 'jsonata', 'unified model', 'field missing', 'transform', 'normaliz', 'raw vs unified'],
  'B/truto-integration-config-auditor': ['integration config', 'pagination', 'auth config', 'resource', 'provider doc', 'schema'],
  'B/truto-integration-build-planner': ['build integration', 'new integration', 'add integration', 'provider documentation'],
  'B/truto-environment-override-auditor': ['override', 'environment integration', 'env-specific', 'base url', 'per-env'],
  'B/truto-sync-job-validator': ['sync job', 'sync', 'runtime v4', 'dry run', 'job run', 'durable'],
  'B/truto-webhook-workflow-debugger': ['webhook', 'workflow', 'delivery', 'notification', 'event', 'retry', 'trigger'],
  'B/truto-docs-capabilities-auditor': ['documentation row', 'capabilities', 'mcp tool', 'ai readiness', 'doc row'],
  'B/truto-export-diff-analyst': ['export', 'diff', 'missing data', 'row count', 'compare account'],
  'B/truto-cli-investigator': ['investigate', 'look into', 'debug'],
}

const norm = (s: string) => s.toLowerCase()

/** Score a skill against the prompt using its own routing text plus hints. */
function score(skill: Skill, prompt: string): number {
  const p = norm(prompt)
  let n = 0

  for (const hint of SPECIALIST_HINTS[skill.id] ?? []) {
    if (p.includes(hint)) n += 4
  }

  // Distinctive words from the skill's own whenToUse. Short words match
  // everything, so they are worth nothing here.
  const text = norm(`${skill.when_to_use ?? ''} ${skill.description ?? ''}`)
  const words = new Set(text.split(/[^a-z0-9]+/).filter(w => w.length > 5))
  for (const w of words) {
    if (p.includes(w)) n += 1
  }

  // The name itself being mentioned is the strongest signal there is.
  if (p.includes(skill.name)) n += 20
  return n
}

/* ----------------------------- hard rules -------------------------------- */

/**
 * Repo paths whose rule files must be read before an edit lands.
 *
 * The leading alternation has to include whitespace, not just `^` and `/`: these
 * are matched against the prompt and the file list joined together, so a path
 * almost always has a space in front of it rather than a slash.
 */
const PATH_RULES: Array<{ test: RegExp; file: string; why: string }> = [
  { test: /(^|[\s/"'`(])cli\//, file: 'cli/CLAUDE.md', why: 'work under cli/' },
  { test: /(^|[\s/"'`(])src\/sync-job\//, file: 'src/sync-job/CLAUDE.md', why: 'work under src/sync-job/' },
]

const GINGER_FILE = /\w+(Service|Schema|Router)\.ts\b/
const CONTRACT_CHANGE =
  /\b(openapi|api contract|public api|breaking change|new route|new endpoint|query param|response shape|migration|webhook event type)\b/i

/**
 * Words that mean the turn intends to change something. Used only to *add*
 * safety skills — the real gate is the approval flow in the tool layer, which
 * does not consult this.
 */
const MUTATION_INTENT =
  /\b(update|create|delete|remove|apply|fix|change|set|override|patch|write|publish|deploy|migrate|refresh|rotate|enable|disable)\b/i

export function routeSkills(opts: {
  mode: ModeId
  prompt: string
  repoPath?: string | null
  /** Paths the turn is expected to touch, when known up front. */
  files?: string[]
}): Routing {
  const { mode, prompt } = opts
  const rules: string[] = []
  const forced: string[] = []
  const repoRules: string[] = []

  const modeCfg = MODE_BASELINE[mode] ?? { baseline: null, catalog: null }
  const baseline = modeCfg.baseline
  if (baseline) {
    rules.push(
      baseline === 'B/truto-cli-toolbelt'
        ? 'Truto CLI work always loads truto-cli-toolbelt first'
        : `${mode} mode loads ${baseline} as its baseline`,
    )
  }

  /* specialist */
  let specialist: string | null = null
  if (modeCfg.catalog) {
    const candidates = listSkills(modeCfg.catalog).filter(s => s.id !== baseline)
    const ranked = candidates
      .map(s => ({ s, n: score(s, prompt) }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n)
    const top = ranked[0]
    specialist = top?.s.id ?? MODE_DEFAULT_SPECIALIST[mode] ?? null
    if (top) rules.push(`"${top.s.name}" matched the request most closely`)
    else if (specialist) rules.push(`no specialist matched; using ${mode} mode's default`)
  }

  /* engineering: repo rule files and the two mandatory skills */
  if (mode === 'engineering') {
    const hay = `${prompt} ${(opts.files ?? []).join(' ')}`
    for (const r of PATH_RULES) {
      if (r.test.test(hay)) {
        repoRules.push(r.file)
        rules.push(`${r.why} → read ${r.file}`)
      }
    }
    if (GINGER_FILE.test(hay)) {
      forced.push('C/ginger-migration-guardrails')
      rules.push('a *Service/*Schema/*Router file is in scope → ginger-migration-guardrails is mandatory')
    }
    if (CONTRACT_CHANGE.test(hay)) {
      forced.push('C/platform-change-checklist')
      rules.push('the change touches the public API/CLI contract → platform-change-checklist is mandatory')
    }
    if (!specialist && !forced.length) {
      const ranked = listSkills('C')
        .map(s => ({ s, n: score(s, prompt) }))
        .filter(x => x.n > 0)
        .sort((a, b) => b.n - a.n)
      const top = ranked[0]
      specialist = top?.s.id ?? null
      if (top) rules.push(`"${top.s.name}" matched the request most closely`)
    }
  }

  /* mutation safety */
  const willMutate = MUTATION_INTENT.test(prompt)
  const specialistSkill = specialist ? getSkill(specialist) : null
  if (mode !== 'engineering' && (willMutate || specialistSkill?.mutating)) {
    if (getSkill('B/truto-safe-admin-operator')) {
      forced.push('B/truto-safe-admin-operator')
      rules.push('the request could mutate state → truto-safe-admin-operator is mandatory')
    }
  }

  // Never hand back a skill that is not actually indexed.
  const real = (id: string | null) => (id && getSkill(id) ? id : null)

  return {
    baseline: real(baseline),
    specialist: real(specialist),
    forced: [...new Set(forced)].filter(id => getSkill(id)),
    rules,
    repoRules,
  }
}

/** Free-text search over the index, for the agent's own `skills_search` tool. */
export function searchSkills(q: string, limit = 6): Array<Skill & { score: number }> {
  return listSkills()
    .map(s => ({ ...s, score: score(s, q) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
