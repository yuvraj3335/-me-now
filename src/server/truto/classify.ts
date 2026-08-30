/**
 * What a Truto CLI invocation is allowed to do.
 *
 * Four tiers, and the rule that matters most is the last one: anything this
 * file does not recognise is a mutation. A classifier that guesses "probably a
 * read" on an unknown verb is the single failure that would let an unreviewed
 * write through, so unknown fails closed and the agent gets told to ask.
 *
 * The distinction the brief insists on — and which is easy to lose — is that a
 * *provider* read is not a plain read. `truto unified crm contacts` reaches a
 * real customer's Salesforce with their credentials. It changes nothing, but it
 * is a real API call against a live account and it is disclosed as such.
 */

export type CommandClass = 'read' | 'provider_read' | 'mutation' | 'high_risk'

export const CLASS_LABEL: Record<CommandClass, string> = {
  read: 'Read',
  provider_read: 'Provider read',
  mutation: 'Mutation',
  high_risk: 'High-risk provider mutation',
}

export const NEEDS_APPROVAL: Record<CommandClass, boolean> = {
  read: false,
  // Disclosed, not gated: a provider read is how nearly every investigation
  // starts, and stopping for approval on each one makes the tool unusable.
  provider_read: false,
  mutation: true,
  high_risk: true,
}

/** Subcommand verbs that only read, wherever they appear. */
const READ_VERBS = new Set([
  'list', 'get', 'search', 'show', 'show-override', 'describe', 'tools',
  'unified-apis', 'validate', 'lint', 'help', 'current', 'status', 'health',
  'schema', 'capabilities', 'context', 'whoami', 'categories', 'preview',
])

/** Subcommand verbs that write. */
const WRITE_VERBS = new Set([
  'create', 'update', 'delete', 'remove', 'apply', 'init', 'add-method',
  'override', 'refresh', 'refresh-credentials', 'run', 'trigger', 'test-delivery',
  'upload', 'install', 'uninstall', 'reauthorize', 'rotate', 'revoke', 'use',
  'login', 'logout', 'upgrade', 'build', 'set', 'enable', 'disable', 'reset',
])

/** Top-level commands that never write, whatever follows them. */
const READ_ONLY_COMMANDS = new Set([
  'whoami', 'current', 'context', 'schema', 'capabilities', 'logs', 'log',
  'categories', 'category', 'jsonata', 'diff', 'open', 'help', 'scim-groups',
  'scim-group',
])

/** Commands whose arguments name a real third-party account. */
const PROVIDER_COMMANDS = new Set(['unified', 'proxy', 'custom', 'export', 'batch'])

/** Provider methods that only read. Everything else on a provider is a write. */
const PROVIDER_READ_METHODS = new Set(['list', 'get', 'search', 'download', 'head'])

export type Classification = {
  cls: CommandClass
  /** Why, in words a person can check. */
  reason: string
  /** True when the call reaches a third-party system with real credentials. */
  touchesProvider: boolean
}

function flagValue(argv: string[], ...names: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue
    for (const n of names) {
      if (a === n) return argv[i + 1] ?? null
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1)
    }
  }
  return null
}

/**
 * `argv` is the arguments AFTER the binary — e.g. `['integrations','get','x']`.
 */
export function classify(argv: string[]): Classification {
  const args = argv.filter(a => a !== '--')
  const positional = args.filter(a => !a.startsWith('-'))
  const cmd = positional[0] ?? ''
  const sub = positional[1] ?? ''

  if (!cmd) {
    return { cls: 'mutation', reason: 'empty command — refusing rather than guessing', touchesProvider: false }
  }

  if (READ_ONLY_COMMANDS.has(cmd)) {
    // `logs` and `diff` read Truto's own records, not the provider's.
    return { cls: 'read', reason: `"${cmd}" is a read-only command`, touchesProvider: false }
  }

  if (PROVIDER_COMMANDS.has(cmd)) {
    // `batch` carries its operations in a file or body, so the method flag does
    // not describe it. It is treated as high risk unless proven otherwise.
    if (cmd === 'batch') {
      return {
        cls: 'high_risk',
        reason: 'batch bodies can contain writes, and the CLI flags do not reveal which',
        touchesProvider: true,
      }
    }
    const method = flagValue(args, '-m', '--method') ?? flagValue(args, '-X') ?? 'list'
    const isRead = PROVIDER_READ_METHODS.has(method) || PROVIDER_READ_METHODS.has(method.toLowerCase())
    if (isRead) {
      return {
        cls: 'provider_read',
        reason: `"${cmd} --method ${method}" reads from a live integrated account`,
        touchesProvider: true,
      }
    }
    return {
      cls: 'high_risk',
      reason: `"${cmd} --method ${method}" writes to a live third-party account`,
      touchesProvider: true,
    }
  }

  if (!sub) {
    // A bare resource command prints help in this CLI, but relying on that is a
    // guess about someone else's argument parser.
    return { cls: 'read', reason: `"${cmd}" with no subcommand lists or prints help`, touchesProvider: false }
  }

  if (READ_VERBS.has(sub)) {
    return { cls: 'read', reason: `"${cmd} ${sub}" is a read`, touchesProvider: false }
  }
  if (WRITE_VERBS.has(sub)) {
    // Refreshing credentials talks to the provider's token endpoint.
    const touches =
      sub.startsWith('refresh') || sub === 'reauthorize' || (cmd === 'integrations' && sub === 'build')
    return { cls: 'mutation', reason: `"${cmd} ${sub}" modifies Truto state`, touchesProvider: touches }
  }

  return {
    cls: 'mutation',
    reason: `"${cmd} ${sub}" is not a recognised read — treated as a mutation because unknown commands fail closed`,
    touchesProvider: false,
  }
}

/**
 * Resources that use optimistic locking. The brief requires a fresh read
 * immediately before an update, because a stale `version` either fails loudly
 * or — worse, on a resource that ignores it — silently overwrites someone.
 */
export const OPTIMISTIC_LOCK_RESOURCES = new Set([
  'integrations', 'integration',
  'unified-models', 'unified-model',
  'unified-model-mappings', 'unified-model-mapping',
  'env-unified-model-mappings', 'env-unified-model-mapping',
  'env-unified-models', 'env-unified-model',
  'environment-integrations', 'environment-integration',
])

export function needsPreflightRead(argv: string[]): boolean {
  const positional = argv.filter(a => !a.startsWith('-'))
  return OPTIMISTIC_LOCK_RESOURCES.has(positional[0] ?? '') && positional[1] === 'update'
}

/**
 * `environment-integrations update` REPLACES the whole override rather than
 * deep-merging it, and secrets come back redacted on read — so the
 * read-modify-write an agent naturally reaches for wipes any pinned client
 * secret. Worth saying at the moment of the call, not in a doc nobody opens.
 */
export function hazardNote(argv: string[]): string | null {
  const p = argv.filter(a => !a.startsWith('-'))
  if ((p[0] === 'environment-integrations' || p[0] === 'environment-integration') && p[1] === 'update') {
    return 'This REPLACES the entire override rather than merging it. Secrets are redacted on read, so a read-modify-write will wipe any client secret pinned in the override — resend the full override including secrets.'
  }
  if (p[0] === 'integrations' && p[1] === 'update') {
    return 'Integrations use optimistic locking. Re-read immediately before applying; a stale version must not be retried blindly.'
  }
  return null
}
