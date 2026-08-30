/**
 * The Gmail MCP adapter, capability-probed.
 *
 * Wake does not assume a tool exists because a name seems obvious. It asks the
 * server what it offers (`tools/list`) and matches by shape, so the Mail page
 * can say "this inbox cannot send" when that is the truth rather than failing
 * at the moment someone presses Send.
 *
 * The write path is deliberately narrow. `McpSession` refuses any tool whose
 * name looks like a mutation — that denylist is what keeps the card ingest
 * read-only — so sending goes through `callWrite`, which uses the client's one
 * named escape hatch and is reached only after a bound confirmation is spent.
 */

import { HttpTransport, McpSession, McpUnauthorized } from '../mcp/client'
import { resolveToken } from '../mcp/creds'
import { GMAIL_ACCOUNTS, MCP_SERVERS } from '../env'

const sessions = new Map<string, McpSession>()

export function sessionFor(account: string): McpSession {
  let s = sessions.get(account)
  if (!s) {
    const getToken = async () =>
      (await resolveToken(`gmail:${account}`)).token ?? (await resolveToken('gmail')).token
    s = new McpSession(`gmail:${account}`, new HttpTransport(MCP_SERVERS.gmail!.url, getToken))
    sessions.set(account, s)
  }
  return s
}

/* ------------------------------ capabilities ------------------------------ */

export type MailCapability = {
  search: string | null
  thread: string | null
  labels: string | null
  send: string | null
  draft: string | null
  modify: string | null
}

export type MailCapabilities = {
  connected: boolean
  reason: string | null
  accounts: Array<{ address: string; connected: boolean; via: string; reason: string | null }>
  tools: MailCapability
  /** Tool names the server actually advertised — shown in Settings, not guessed. */
  discovered: string[]
  canSend: boolean
  canDraft: boolean
}

let capCache: { at: number; value: MailCapabilities } | null = null
const CAP_TTL_MS = 60_000

const pick = (names: string[], want: RegExp[]): string | null => {
  for (const re of want) {
    const hit = names.find(n => re.test(n))
    if (hit) return hit
  }
  return null
}

export function mailCapabilities(): MailCapabilities {
  return capCache?.value ?? emptyCaps('Gmail has not been probed yet in this process.')
}

function emptyCaps(reason: string): MailCapabilities {
  return {
    connected: false,
    reason,
    accounts: GMAIL_ACCOUNTS.map(a => ({ address: a, connected: false, via: 'none', reason })),
    tools: { search: null, thread: null, labels: null, send: null, draft: null, modify: null },
    discovered: [],
    canSend: false,
    canDraft: false,
  }
}

const NOT_CONNECTED =
  'Gmail is not connected. Wake resolves a token from its own OAuth store, then from Claude Code\'s ' +
  '`~/.claude/.credentials.json`, then from WAKE_GMAIL_TOKEN. A claude.ai *connector* does not count: ' +
  'those tokens live in your Claude account and are never written to disk, so there is nothing for Wake to read. ' +
  'Add Gmail as a direct HTTP server (`claude mcp add --transport http gmail …` then `claude mcp login gmail`), ' +
  'or set WAKE_GMAIL_TOKEN.'

/** Probe every configured account. Cached briefly; a failure is reported, not hidden. */
export async function probeMail(force = false): Promise<MailCapabilities> {
  if (!force && capCache && Date.now() - capCache.at < CAP_TTL_MS) return capCache.value

  const accounts: MailCapabilities['accounts'] = []
  let names: string[] = []
  let firstError: string | null = null

  for (const address of GMAIL_ACCOUNTS) {
    const per = await resolveToken(`gmail:${address}`)
    const shared = per.token ? per : await resolveToken('gmail')
    if (!shared.token) {
      accounts.push({ address, connected: false, via: 'none', reason: NOT_CONNECTED })
      continue
    }
    try {
      const tools = await sessionFor(address).listTools()
      if (!names.length) names = tools.map(t => t.name)
      accounts.push({ address, connected: true, via: shared.via, reason: null })
    } catch (e) {
      const reason =
        e instanceof McpUnauthorized
          ? `Gmail rejected the credential for ${address} — it needs re-authorising.`
          : `Gmail is unreachable for ${address}: ${(e as Error).message}`
      firstError ??= reason
      accounts.push({ address, connected: false, via: shared.via, reason })
    }
  }

  const tools: MailCapability = {
    search: pick(names, [/^search_threads$/, /search.*thread/i, /^list_messages$/, /search.*message/i]),
    thread: pick(names, [/^get_thread$/, /get.*thread/i, /^get_message$/]),
    labels: pick(names, [/^list_labels$/, /label/i]),
    send: pick(names, [/^send_message$/, /^send_email$/, /send/i]),
    draft: pick(names, [/^create_draft$/, /draft/i]),
    modify: pick(names, [/^modify_message$/, /^modify_thread$/, /modify|mark/i]),
  }

  const connected = accounts.some(a => a.connected)
  const value: MailCapabilities = {
    connected,
    reason: connected ? null : (firstError ?? NOT_CONNECTED),
    accounts,
    tools,
    discovered: names,
    canSend: !!tools.send,
    canDraft: !!tools.draft,
  }
  capCache = { at: Date.now(), value }
  return value
}

/* --------------------------------- calls ---------------------------------- */

export async function call<T = unknown>(account: string, tool: string, args: Record<string, unknown>): Promise<T> {
  return await sessionFor(account).callJson<T>(tool, args)
}

/**
 * The one write path.
 *
 * `McpSession.callTool` refuses mutation-shaped tool names on purpose, which is
 * what keeps every other caller in this codebase read-only. Sending mail is the
 * single sanctioned exception, so it goes around that check *here*, in a
 * function whose name says what it is, reached only after a bound confirmation
 * has been spent.
 */
export async function callWrite<T = unknown>(account: string, tool: string, args: Record<string, unknown>): Promise<T> {
  return await sessionFor(account).callWriteJson<T>(tool, args)
}
