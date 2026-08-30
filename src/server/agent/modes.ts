/**
 * Daily job modes.
 *
 * A mode is not a label. It changes three things that matter: which tools exist
 * at all for the turn, which skills get loaded before the first token, and what
 * the agent is told the job is. Two modes with the same tool surface and the
 * same workflow would be one mode with two names, so there aren't any.
 *
 * `tools` is an allowlist of Wake's own tool names, checked at call time and not
 * only when the list is built. There is no second allowlist for a subprocess's
 * built-ins any more: the Wake Agent has no shell and no editor. Work that needs
 * those is packed and handed to Claude Code, which applies its own permissions.
 */

export type ModeId =
  | 'triage' | 'support' | 'account' | 'api' | 'mappings'
  | 'sync' | 'webhooks' | 'engineering' | 'incident'

export type Mode = {
  id: ModeId
  label: string
  blurb: string
  /** Read-only modes cannot reach a mutating tool even with an approval. */
  readOnly: boolean
  tools: string[]
  workflow: string
}

/** Tool groups, so a mode's allowlist reads as intent rather than a list. */
const T = {
  core: ['wake_cards', 'wake_tasks', 'ask_user'],
  registry: ['repo_search', 'repo_get', 'repo_diff'],
  skills: ['skill_search', 'skill_load', 'skill_reference'],
  trutoRead: ['truto_whoami', 'truto_run', 'truto_help'],
  trutoWrite: ['truto_apply'],
  platform: ['platform_operations', 'platform_describe', 'platform_call'],
  monitoring: ['monitoring_call'],
  sources: ['slack_search', 'slack_thread', 'gmail_search', 'sentry_search', 'github_search'],
  mail: ['mail_search', 'mail_thread'],
  /** Outbound drafting. Neither of these sends anything on its own. */
  drafting: ['mail_draft', 'slack_draft'],
  /** The launcher: read the machine's sessions, then hand one a packed brief. */
  launch: ['claude_sessions', 'claude_session_excerpt', 'claude_launch'],
}

export const MODES: Record<ModeId, Mode> = {
  triage: {
    id: 'triage',
    label: 'Triage',
    blurb: 'What needs my attention right now.',
    readOnly: true,
    tools: [...T.core, ...T.registry, ...T.sources, ...T.mail, ...T.monitoring],
    workflow: `Answer one question: what needs this person's attention?

Read the Wake card piles first (wake_cards) — they are already deduplicated, so
one card is one real thing. Correlate against Slack, Gmail, Sentry, GitHub and
monitoring only where a card is ambiguous or looks like it has a second half.

Rank by who is blocked and for how long, not by recency. For each item give the
single next action. Do not mutate anything and do not draft outbound messages
unless asked — this mode is for deciding what to pick up.`,
  },

  support: {
    id: 'support',
    label: 'Customer support',
    blurb: 'Take a customer report to a root cause and a safe reply.',
    readOnly: false,
    tools: [
      ...T.core, ...T.registry, ...T.skills, ...T.trutoRead, ...T.trutoWrite,
      ...T.sources, ...T.mail, ...T.drafting, ...T.monitoring, ...T.platform, ...T.launch,
    ],
    workflow: `Take a customer report to a root cause.

1. Pin down customer, integration, account id, endpoint and time window. Ask
   (ask_user) rather than guessing when the answer changes where you look.
2. Find the original report in Slack/Gmail; check Sentry and monitoring for
   matching errors in that window.
3. Resolve the profile/environment with truto_whoami BEFORE any other CLI call,
   and state which team and environment you are operating in.
4. Inspect the account, its capabilities, the environment integration and any
   overrides.
5. Query logs for the window.
6. Reproduce with the smallest safe READ call. Compare proxy vs unified when a
   mapping is implicated.
7. If platform behaviour looks broken, search the canonical repo and recent
   commits.

Finish with: impact, evidence, the layer the root cause sits in, your confidence,
who owns it, a workaround, the engineering fix, and a customer-safe draft reply.
Never send the reply. Drafting it is the deliverable; sending is the human's.`,
  },

  account: {
    id: 'account',
    label: 'Account health',
    blurb: 'Credentials, scopes, capabilities, reauthorization.',
    readOnly: false,
    tools: [...T.core, ...T.skills, ...T.trutoRead, ...T.trutoWrite, ...T.platform, ...T.launch],
    workflow: `Audit one integrated account end to end: metadata, credential state,
granted vs requested scopes, available tools/capabilities, the environment
integration behind it, reauthorization state, and recent logs.

Report what is actually broken versus merely unusual. A missing scope is only a
finding if a method the customer uses needs it — say which method.`,
  },

  api: {
    id: 'api',
    label: 'API debugging',
    blurb: 'Reproduce a call exactly, and minimally.',
    readOnly: false,
    tools: [...T.core, ...T.skills, ...T.trutoRead, ...T.trutoWrite, ...T.platform, ...T.launch],
    workflow: `Reproduce a specific call. Establish the exact method, path, query and
body, and whether it is unified, proxy, custom or batch — these behave
differently and conflating them wastes the whole investigation.

Use verbose HTTP only once a plain call has failed and you need headers. Redact
authorization values in everything you show. The deliverable is the smallest CLI
command that reproduces the problem, which the human can paste and run.`,
  },

  mappings: {
    id: 'mappings',
    label: 'Mappings',
    blurb: 'Unified mappings, JSONata, raw vs unified.',
    readOnly: false,
    tools: [...T.core, ...T.skills, ...T.trutoRead, ...T.trutoWrite, ...T.registry, ...T.launch],
    workflow: `Work the mapping, not the symptom.

Capture the raw provider payload, state the expected unified schema, and diff
them explicitly — name the field, its raw path, its mapped path, and what came
out. Validate offline with test-mapping before proposing any published change.

A mapping "looks right" is not a finding. Show the evaluated output.`,
  },

  sync: {
    id: 'sync',
    label: 'Sync jobs',
    blurb: 'Templates, jobs, runs, runtime V4.',
    readOnly: false,
    tools: [...T.core, ...T.skills, ...T.trutoRead, ...T.trutoWrite, ...T.registry, ...T.monitoring, ...T.launch],
    workflow: `Establish the runtime version FIRST — V1 through V4 behave differently and
V4-only advice silently misleads on a V1 job. Then inspect template, job and run
state, the account's capabilities, and the logs for the failing run.

Dry-run before proposing any mutation.`,
  },

  webhooks: {
    id: 'webhooks',
    label: 'Webhooks & workflows',
    blurb: 'Delivery, destinations, workflow runs, retries.',
    readOnly: false,
    tools: [...T.core, ...T.skills, ...T.trutoRead, ...T.trutoWrite, ...T.monitoring, ...T.launch],
    workflow: `Separate "not triggered" from "triggered and not delivered" before anything
else — they have different causes and different owners.

Check the event actually fired, the destination configuration, the delivery log
with its status codes, retry semantics, and workflow run state.`,
  },

  engineering: {
    id: 'engineering',
    label: 'Platform engineering',
    blurb: 'Scope the change, then hand it to Claude Code.',
    readOnly: false,
    tools: [...T.core, ...T.registry, ...T.skills, ...T.launch, ...T.sources],
    workflow: `Scope the work, then hand it over. You have no editor and no shell.

First: resolve the canonical repository (a worktree is not a product) with
repo_search / repo_get, read what the registry says about its rule files and its
real test and typecheck commands, and state the current branch and whether the
tree is dirty (repo_diff).

Then write a launch pack and open a Claude Code session on this machine with
claude_launch. The pack must be self-contained — the session cannot see this
conversation — and must name the rule files and the verification commands rather
than inventing them.

The session runs under Claude Code's own permission model. Do not tell the user
you edited anything: report what you packed, the session id, and the resume
command.`,
  },

  incident: {
    id: 'incident',
    label: 'Incident command',
    blurb: 'Correlate everything, maintain the timeline.',
    readOnly: false,
    tools: [
      ...T.core, ...T.registry, ...T.skills, ...T.trutoRead, ...T.trutoWrite,
      ...T.sources, ...T.mail, ...T.drafting, ...T.monitoring, ...T.platform, ...T.launch,
    ],
    workflow: `Run the incident. Correlate Wake cards, Slack, Gmail, Sentry, monitoring,
Truto logs, GitHub and recent deployments.

Maintain and restate every turn: timeline, live hypotheses, the evidence for
each, causes ELIMINATED (with what eliminated them), current owner, next action.
Keep an internal update and a customer update as separate drafts — they are not
the same document and merging them leaks detail.

Say plainly when something is unknown. An incident channel full of confident
guesses is worse than one with an honest gap.`,
  },
}

export const MODE_LIST = Object.values(MODES)

export const isMode = (v: string): v is ModeId => v in MODES

export function getMode(id: string): Mode {
  return MODES[(isMode(id) ? id : 'triage') as ModeId]
}
