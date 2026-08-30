import { expect, test, describe } from 'bun:test'
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
    expect(formatScopeList('channels:read,search:read', 'slack')).toBe('channels:read,search:read')
  })

  test('other servers space-separate scopes', () => {
    expect(formatScopeList('a,b,c', 'sentry')).toBe('a b c')
  })
})
