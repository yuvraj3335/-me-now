import { expect, test, describe } from 'bun:test'
import { MCP_SERVERS } from '../src/server/env'
import { formatScopeList, scopeQueryParam } from '../src/server/mcp/oauth'

describe('OAuth scope query param', () => {
  test('Slack MCP v2_user authorize reads scope, not user_scope', () => {
    expect(scopeQueryParam('https://slack.com/oauth/v2_user/authorize', 'slack')).toBe('scope')
  })

  test('classic Slack workspace install still uses user_scope', () => {
    expect(scopeQueryParam('https://slack.com/oauth/v2/authorize', 'slack')).toBe('user_scope')
  })

  test('Sentry and everyone else use scope', () => {
    expect(scopeQueryParam('https://mcp.sentry.dev/authorize', 'sentry')).toBe('scope')
  })

  test('Slack keeps comma-separated scopes', () => {
    expect(formatScopeList('channels:read,search:read.public', 'slack')).toBe('channels:read,search:read.public')
  })

  test('other servers space-separate scopes', () => {
    expect(formatScopeList('a,b,c', 'sentry')).toBe('a b c')
  })

  test('Slack MCP is asked for granular search scopes, not classic search:read', () => {
    const scopes = MCP_SERVERS.slack!.scopes ?? ''
    for (const need of [
      'search:read.public',
      'search:read.private',
      'search:read.im',
      'search:read.mpim',
    ]) {
      expect(scopes, `missing ${need}`).toContain(need)
    }
    // Classic search:read is accepted at authorize time and then Slack MCP
    // exposes no search tool. A bare `search:read` (no suffix) must not be
    // in the list — `search:read.public`.startsWith('search:read') is true,
    // so test the comma-delimited names.
    const names = scopes.split(',')
    expect(names).not.toContain('search:read')
    expect(names).not.toContain('team:read')
  })
})
