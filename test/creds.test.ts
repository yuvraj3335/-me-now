import { expect, test, describe, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The credential bridge is how Slack and Sentry arrive after
 * `claude mcp login` on the box, so its parsing is worth pinning down against
 * the real shape of ~/.claude/.credentials.json.
 */
const dir = mkdtempSync(join(tmpdir(), 'wake-creds-'))
const credPath = join(dir, '.credentials.json')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

process.env.WAKE_CLAUDE_HOME = dir
process.env.WAKE_DATA_DIR = join(dir, 'data')

const write = (o: unknown) => writeFileSync(credPath, JSON.stringify(o))
const { claudeBridgeToken } = await import('../src/server/mcp/creds')

const future = Date.now() + 3_600_000
const past = Date.now() - 3_600_000

describe('claude credential bridge', () => {
  test('finds a token by server name, ignoring the hash suffix on the key', () => {
    write({ mcpOAuth: { 'slack|38801a7d845718b3': {
      serverName: 'slack', serverUrl: 'https://mcp.slack.com/mcp',
      accessToken: 'xoxp-real-token', expiresAt: future,
    } } })
    expect(claudeBridgeToken('slack')).toBe('xoxp-real-token')
  })

  test('an empty token is not a token', () => {
    // This is the real state left behind by an abandoned `claude mcp login`.
    write({ mcpOAuth: { 'slack|abc': {
      serverName: 'slack', serverUrl: 'https://mcp.slack.com/mcp', accessToken: '',
    } } })
    expect(claudeBridgeToken('slack')).toBeNull()
  })

  test('an expired token is refused rather than passed on', () => {
    // Handing back a dead token turns "not connected" into a confusing 401.
    write({ mcpOAuth: { 'slack|abc': {
      serverName: 'slack', accessToken: 'stale', expiresAt: past,
    } } })
    expect(claudeBridgeToken('slack')).toBeNull()
  })

  test('when several entries match, the longest-lived wins', () => {
    write({ mcpOAuth: {
      'slack|old': { serverName: 'slack', accessToken: 'older', expiresAt: future },
      'slack|new': { serverName: 'slack', accessToken: 'newer', expiresAt: future + 60_000 },
    } })
    expect(claudeBridgeToken('slack')).toBe('newer')
  })

  test('matches a claude.ai connector that wraps the real URL in a proxy URL', () => {
    write({ mcpOAuth: { 'Gmail|66c8': {
      serverName: 'Gmail',
      serverUrl: 'https://api.anthropic.com/v2/ccr-sessions/cse_01/mcp'
        + '?mcp_url=https%3A%2F%2Fgmailmcp.googleapis.com%2Fmcp%2Fv1',
      accessToken: 'ya29-token', expiresAt: future,
    } } })
    expect(claudeBridgeToken('gmail')).toBe('ya29-token')
  })

  test('another server’s token is never returned', () => {
    write({ mcpOAuth: { 'figma|x': {
      serverName: 'plugin:figma:figma', accessToken: 'figma-token', expiresAt: future,
    } } })
    expect(claudeBridgeToken('slack')).toBeNull()
  })

  test('a missing or unparseable file degrades to no token, not a crash', () => {
    writeFileSync(credPath, 'not json at all')
    expect(claudeBridgeToken('slack')).toBeNull()
    rmSync(credPath)
    expect(claudeBridgeToken('slack')).toBeNull()
  })
})
