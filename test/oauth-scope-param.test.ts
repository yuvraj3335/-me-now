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

  test('Slack MCP is asked for granular search scopes, and not files:write', () => {
    const names = (MCP_SERVERS.slack!.scopes ?? '').split(',')
    for (const need of [
      'search:read.public',
      'search:read.private',
      'search:read.im',
      'search:read.mpim',
      'search:read.users',
      'search:read.files',
    ]) {
      expect(names, `missing ${need}`).toContain(need)
    }
    expect(names).not.toContain('files:write')
  })
})
