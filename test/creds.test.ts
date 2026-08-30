import { expect, test, describe, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
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
/** Backdate the credential file, which is what bounds an entry with no expiry. */
const written = (msAgo: number) => {
  const t = (Date.now() - msAgo) / 1000
  utimesSync(credPath, t, t)
}
const { claudeBridgeToken, isGoogleWebClientId, pickGmailClientFromClaude } = await import('../src/server/mcp/creds')
const { getStored, putStored } = await import('../src/server/mcp/oauth')

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

  test('an entry with no expiry is trusted only as long as the file is fresh', () => {
    // It used to score `Number.MAX_SAFE_INTEGER` and be served for the life of
    // the process. Claude's Gmail grant is exactly that shape and lasts an hour,
    // so the chain kept preferring a token that had already died over asking
    // Wake's own store for a live one.
    write({ mcpOAuth: { 'slack|noexp': {
      serverName: 'slack', serverUrl: 'https://mcp.slack.com/mcp', accessToken: 'undated',
    } } })
    expect(claudeBridgeToken('slack')).toBe('undated')

    written(2 * 3_600_000)
    expect(claudeBridgeToken('slack')).toBeNull()
  })

  test('a missing or unparseable file degrades to no token, not a crash', () => {
    writeFileSync(credPath, 'not json at all')
    expect(claudeBridgeToken('slack')).toBeNull()
    rmSync(credPath)
    expect(claudeBridgeToken('slack')).toBeNull()
  })
})

describe('Gmail client seed from Claude', () => {
  const googleId = '285417044045-example.apps.googleusercontent.com'
  const uuidId = '66b074ef-4545-4f2e-9fc0-c96356552caa'

  test('only a Google Cloud client is usable against accounts.google.com', () => {
    expect(isGoogleWebClientId(googleId)).toBe(true)
    expect(isGoogleWebClientId(uuidId)).toBe(false)
    expect(isGoogleWebClientId(null)).toBe(false)
  })

  test('skips the claude.ai Gmail UUID when the Google client is also present', () => {
    const picked = pickGmailClientFromClaude({
      mcpOAuth: {
        'Gmail|66c8': {
          serverName: 'Gmail',
          serverUrl: 'https://api.anthropic.com/v2/ccr-sessions/cse_01/mcp'
            + '?mcp_url=https%3A%2F%2Fgmailmcp.googleapis.com%2Fmcp%2Fv1',
          clientId: uuidId,
        },
        'gmail|ccf1': {
          serverName: 'gmail',
          serverUrl: 'https://gmailmcp.googleapis.com/mcp/v1',
          clientId: googleId,
          clientSecret: 'from-entry',
        },
      },
    })
    expect(picked).toEqual({ client_id: googleId, client_secret: 'from-entry' })
  })

  test('reads the secret from mcpOAuthClientConfig when the entry has none', () => {
    const picked = pickGmailClientFromClaude({
      mcpOAuth: {
        'gmail|ccf1': {
          serverName: 'gmail',
          serverUrl: 'https://gmailmcp.googleapis.com/mcp/v1',
          clientId: googleId,
        },
      },
      mcpOAuthClientConfig: { 'gmail|ccf1': { clientSecret: 'from-config' } },
    })
    expect(picked?.client_secret).toBe('from-config')
  })

  test('does not seed a UUID — Google would reject it as client_id', () => {
    expect(pickGmailClientFromClaude({
      mcpOAuth: {
        'Gmail|66c8': { serverName: 'Gmail', clientId: uuidId },
      },
    })).toBeNull()
  })
})

describe('the stored row is patched, not replaced', () => {
  const server = 'test-putstored'

  test('a patch that omits refresh_token keeps the one already there', () => {
    // `{ ...cur, ...patch }` let a bare `undefined` — the shape a caller
    // produces by passing through a field the provider omitted — overwrite a
    // perfectly good stored token. That is the persistence half of "Gmail dies
    // every hour": the authorize URL was fixed, and the write threw the answer
    // away an hour later.
    putStored(server, { access_token: 'a1', refresh_token: 'r1', client_id: 'c1' })
    putStored(server, { access_token: 'a2' })

    const row = getStored(server)!
    expect(row.access_token).toBe('a2')
    expect(row.refresh_token).toBe('r1')
    expect(row.client_id).toBe('c1')
  })

  test('an exchange that returns no refresh_token does not wipe the stored one', () => {
    putStored(server, { access_token: 'a1', refresh_token: 'r1' })
    // Exactly what `connections.ts` hands over on a re-authorisation.
    const fromProvider: { access_token: string; refresh_token: string | null } =
      { access_token: 'a3', refresh_token: null }
    putStored(server, {
      access_token: fromProvider.access_token,
      refresh_token: fromProvider.refresh_token ?? undefined,
    })
    expect(getStored(server)!.refresh_token).toBe('r1')
  })

  test('an explicit null still clears — that is how a dead grant is dropped', () => {
    putStored(server, { access_token: 'a1', refresh_token: 'r1' })
    putStored(server, { access_token: null, refresh_token: null, last_auth_error: 'invalid_grant' })

    const row = getStored(server)!
    expect(row.access_token).toBeNull()
    expect(row.refresh_token).toBeNull()
    expect(row.last_auth_error).toBe('invalid_grant')
  })
})
