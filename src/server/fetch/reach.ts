/**
 * What this machine can actually reach, as opposed to what Wake knows a URL for.
 *
 * Wake's own knowledge of MCP is a three-entry map in `env.ts`, and it describes
 * the servers *Wake* speaks to. Fetch needs the other inventory: the connectors
 * the operator has signed this box into, which is exactly the set Wake's own
 * credentials do not cover. Nothing in the codebase read that before.
 *
 * `~/.claude.json` is the honest, cheap answer. `claudeAiMcpEverConnected` lists
 * the claude.ai connector names and `mcpServers` lists the directly-added ones —
 * names only, never tokens, which is the whole point: Wake borrows the reach and
 * never sees the credential. `claude mcp list` would be more current and costs a
 * health check against every server, which is not a thing to do on a button
 * press; a name that is listed and no longer works comes back as a connector
 * that was asked and did not answer, which is a state Fetch reports rather than
 * hides.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { CLAUDE_HOME } from '../env'

/** Where the connector inventory lives. Beside `.claude/`, not inside it. */
const inventoryPath = () => `${CLAUDE_HOME.replace(/\/\.claude\/?$/, '') || homedir()}/.claude.json`

/**
 * Connector keys this box can reach, lower-cased and stripped of the
 * `claude.ai ` prefix — so `claude.ai Slack` and a directly-added `slack` both
 * answer to `slack`.
 */
export function reachableConnectors(): Set<string> {
  let parsed: { claudeAiMcpEverConnected?: unknown; mcpServers?: unknown }
  try {
    parsed = JSON.parse(readFileSync(inventoryPath(), 'utf8'))
  } catch {
    return new Set()
  }

  const out = new Set<string>()
  const add = (raw: unknown) => {
    if (typeof raw !== 'string') return
    const key = raw.replace(/^claude\.ai\s+/i, '').trim().toLowerCase()
    if (key) out.add(key)
  }

  const ever = parsed.claudeAiMcpEverConnected
  if (Array.isArray(ever)) for (const n of ever) add(n)

  const direct = parsed.mcpServers
  if (direct && typeof direct === 'object') for (const n of Object.keys(direct)) add(n)

  return out
}
