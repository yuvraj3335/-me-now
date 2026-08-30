/**
 * The two remote MCP surfaces Wake consumes rather than reimplements.
 *
 * Platform MCP already owns the OpenAPI operation catalog and Truto's own
 * write-policy classification. truto-monitoring already owns suites, runs,
 * issues, docs watches and their cost gates. Copying either into Wake would
 * mean maintaining a second, quietly diverging answer to the same question, so
 * these are thin, honest passthroughs.
 *
 * "Honest" is the operative word: when a surface is not configured or not
 * reachable, these say so. They never fall back to plausible-looking data,
 * because an operator acting on invented monitoring output is worse off than
 * one told the connector is down.
 */

import { HttpTransport, McpSession, McpUnauthorized } from '../mcp/client'
import { MONITORING_MCP_URL, PLATFORM_MCP_URL, PLATFORM_MCP_TOKEN } from '../env'
import { formatUntrusted } from './guard'
import { redactJson } from './redact'

type Remote = { session: McpSession | null; why: string | null }

let platform: Remote | null = null
let monitoring: Remote | null = null

function platformRemote(): Remote {
  if (platform) return platform
  if (!PLATFORM_MCP_TOKEN) {
    platform = {
      session: null,
      why: 'Platform MCP is not configured: set WAKE_PLATFORM_MCP_TOKEN to a Truto API token. Until then use the truto_* CLI tools, which are authenticated through your CLI profiles.',
    }
  } else {
    platform = {
      session: new McpSession('platform', new HttpTransport(PLATFORM_MCP_URL, () => PLATFORM_MCP_TOKEN)),
      why: null,
    }
  }
  return platform
}

function monitoringRemote(): Remote {
  if (monitoring) return monitoring
  monitoring = MONITORING_MCP_URL
    ? { session: new McpSession('monitoring', new HttpTransport(MONITORING_MCP_URL, () => null)), why: null }
    : {
        session: null,
        why: 'truto-monitoring MCP is not configured: set WAKE_MONITORING_MCP_URL to its endpoint. Monitoring data is not available in this conversation — say so rather than describing what it might contain.',
      }
  return monitoring
}

async function call(remote: Remote, label: string, tool: string, args: Record<string, unknown>) {
  if (!remote.session) return { available: false, error: remote.why }
  try {
    const raw = await remote.session.callJson<unknown>(tool, args)
    const value = redactJson(raw)
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return {
      available: true,
      // Both surfaces return provider- and customer-derived content.
      result: formatUntrusted(`${label} · ${tool}`, text.slice(0, 40_000)),
    }
  } catch (e) {
    if (e instanceof McpUnauthorized) {
      return { available: false, error: `${label} rejected the credential — it needs re-authentication.` }
    }
    return { available: false, error: `${label} call failed: ${(e as Error).message}` }
  }
}

async function tools(remote: Remote, label: string) {
  if (!remote.session) return { available: false, error: remote.why }
  try {
    return {
      available: true,
      tools: (await remote.session.listTools()).map(t => ({
        name: t.name,
        description: t.description?.slice(0, 400),
      })),
    }
  } catch (e) {
    return { available: false, error: `${label} is unreachable: ${(e as Error).message}` }
  }
}

export const platformTools = () => tools(platformRemote(), 'Platform MCP')
export const platformCall = (tool: string, args: Record<string, unknown>) =>
  call(platformRemote(), 'Platform MCP', tool, args)

export const monitoringTools = () => tools(monitoringRemote(), 'truto-monitoring')
export const monitoringCall = (tool: string, args: Record<string, unknown>) =>
  call(monitoringRemote(), 'truto-monitoring', tool, args)

/**
 * Whether each remote is configured — surfaced in the UI so an operator can see
 * at a glance that a connector is missing rather than inferring it from an
 * answer that quietly omits monitoring.
 */
export function remoteStatus() {
  return {
    platform: { configured: !!PLATFORM_MCP_TOKEN, url: PLATFORM_MCP_URL, why: platformRemote().why },
    monitoring: { configured: !!MONITORING_MCP_URL, url: MONITORING_MCP_URL || null, why: monitoringRemote().why },
  }
}
