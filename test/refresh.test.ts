/**
 * The refresh path, which is what "Slack disconnected again" actually was.
 *
 * Three separate failures lived here and each one produced the same symptom:
 * a token endpoint stampeded by concurrent callers (where the provider rotates,
 * every loser of that race is left holding an invalidated grant), a refusal
 * classified as "keep serving the old token" (so a dead grant reached the
 * operator as a 401 from an MCP URL instead of as "reconnect"), and a 401 that
 * nothing ever retried.
 *
 * Everything below runs against a fake token endpoint and a fake MCP server, so
 * the assertions are about counts and stored rows rather than about whether
 * Slack happened to be up.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { db } from '../src/server/db'
import { getStored, putStored } from '../src/server/mcp/oauth'
import { forceRefresh, REFRESH_SKEW_MS, resolveToken } from '../src/server/mcp/creds'
import { HttpTransport, McpUnauthorized, type TokenSource } from '../src/server/mcp/client'

const TOKEN_ENDPOINT = 'https://auth.test.invalid/token'
const realFetch = globalThis.fetch

/** What the fake token endpoint will answer next, and how often it was asked. */
let tokenPosts: string[] = []
let tokenReply: () => Response

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)

    // RFC 9728 discovery. Slack publishes no protected-resource document, so the
    // real code falls back to probing the origin — mirror that exactly.
    if (url.endsWith('/.well-known/oauth-protected-resource')) return new Response('', { status: 404 })
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return jsonRes({
        authorization_endpoint: 'https://auth.test.invalid/authorize',
        token_endpoint: TOKEN_ENDPOINT,
      })
    }
    if (url === TOKEN_ENDPOINT) {
      tokenPosts.push(String(init?.body ?? ''))
      return tokenReply()
    }
    throw new Error(`unexpected fetch in test: ${url}`)
  }) as typeof fetch
}

beforeEach(() => {
  tokenPosts = []
  tokenReply = () => jsonRes({ access_token: 'fresh-token', expires_in: 3600 })
  db.query(`DELETE FROM oauth_tokens WHERE server = 'slack'`).run()
  stubFetch()
})

afterEach(() => {
  globalThis.fetch = realFetch
  db.query(`DELETE FROM oauth_tokens WHERE server = 'slack'`).run()
})

/** A grant that expired a minute ago, with everything needed to renew it. */
function staleGrant() {
  putStored('slack', {
    access_token: 'stale-token',
    refresh_token: 'refresh-1',
    client_id: 'client-1',
    client_secret: 'secret-1',
    expires_at: Date.now() - 60_000,
  })
}

describe('the freshness window', () => {
  test('is five minutes, not the one-minute cliff it was', () => {
    // Sixty seconds meant a poll that started inside the last minute of a
    // token's life reached the provider after it had already expired.
    expect(REFRESH_SKEW_MS).toBe(300_000)
  })

  test('a token inside the skew is refreshed before it is used', async () => {
    putStored('slack', {
      access_token: 'nearly-dead',
      refresh_token: 'refresh-1',
      client_id: 'client-1',
      // Four minutes of life left: valid, and not valid for long enough.
      expires_at: Date.now() + 4 * 60_000,
    })
    expect((await resolveToken('slack')).token).toBe('fresh-token')
    expect(tokenPosts).toHaveLength(1)
  })
})

describe('single-flight', () => {
  test('five concurrent callers hit the token endpoint exactly once', async () => {
    staleGrant()
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => resolveToken('slack')))

    expect(tokenPosts, 'the token endpoint was stampeded').toHaveLength(1)
    for (const r of all) {
      expect(r.token).toBe('fresh-token')
      expect(r.via).toBe('wake-oauth')
    }
  })

  test('a success stamps last_auth_ok_at and clears the error', async () => {
    putStored('slack', {
      access_token: 'stale-token', refresh_token: 'refresh-1', client_id: 'client-1',
      expires_at: Date.now() - 60_000, last_auth_error: 'invalid_grant',
    })
    const before = Date.now()
    await forceRefresh('slack')

    const row = getStored('slack')!
    expect(row.last_auth_error).toBeNull()
    expect(row.last_auth_ok_at).toBeGreaterThanOrEqual(before)
  })

  test('a response with no refresh_token keeps the one already stored', async () => {
    staleGrant()
    tokenReply = () => jsonRes({ access_token: 'fresh-token', expires_in: 3600 })
    await forceRefresh('slack')
    expect(getStored('slack')!.refresh_token).toBe('refresh-1')
  })

  test('a rotated refresh token replaces the stored one', async () => {
    staleGrant()
    tokenReply = () => jsonRes({ access_token: 'fresh-token', refresh_token: 'refresh-2', expires_in: 3600 })
    await forceRefresh('slack')
    expect(getStored('slack')!.refresh_token).toBe('refresh-2')
  })
})

describe('classification', () => {
  test('a refused grant is cleared, and the stale token is not served', async () => {
    staleGrant()
    tokenReply = () => jsonRes({ error: 'invalid_grant' }, 400)

    expect(await forceRefresh('slack')).toBeNull()
    const row = getStored('slack')!
    expect(row.access_token, 'the known-dead token was handed to a caller').toBeNull()
    expect(row.refresh_token).toBeNull()
    expect(row.last_auth_error).toBe('invalid_grant')
  })

  test("Slack's 200-with-ok:false is a refusal too", async () => {
    staleGrant()
    tokenReply = () => jsonRes({ ok: false, error: 'token_revoked' })

    expect(await forceRefresh('slack')).toBeNull()
    expect(getStored('slack')!.last_auth_error).toBe('token_revoked')
  })

  test('a 500 leaves the grant alone — nothing was established', async () => {
    staleGrant()
    tokenReply = () => new Response('upstream is having a bad minute', { status: 500 })

    expect(await forceRefresh('slack')).toBeNull()
    const row = getStored('slack')!
    expect(row.refresh_token, 'a provider outage threw away a working grant').toBe('refresh-1')
    expect(row.last_auth_error).toContain('500')
  })

  test('an unknown error code is transient, not terminal', async () => {
    // The asymmetry is deliberate: a wrong "transient" costs one more failed
    // refresh, a wrong "terminal" costs a re-authorisation nobody asked for.
    staleGrant()
    tokenReply = () => jsonRes({ ok: false, error: 'ratelimited' })

    expect(await forceRefresh('slack')).toBeNull()
    expect(getStored('slack')!.refresh_token).toBe('refresh-1')
  })

  test('an HTML error page is a transport failure, not a parse error', async () => {
    staleGrant()
    tokenReply = () => new Response('<html>502 Bad Gateway</html>', { status: 502 })

    expect(await forceRefresh('slack')).toBeNull()
    expect(getStored('slack')!.last_auth_error).toContain('502')
  })
})

/* ------------------------------ the 401 retry ----------------------------- */

/** A fake MCP server that answers 401 for its first `n` requests, then 200. */
function mcpServer(unauthorizedFor: number) {
  const seen: Array<{ auth: string | null; session: string | null }> = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const h = new Headers(init?.headers as HeadersInit)
    seen.push({ auth: h.get('authorization'), session: h.get('mcp-session-id') })
    if (seen.length <= unauthorizedFor) {
      return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
    }
    const body = JSON.parse(String(init?.body ?? '{}'))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-2' },
    })
  }) as typeof fetch
  return seen
}

function source(tokens: string[]): TokenSource & { refreshes: number } {
  let i = 0
  const get = (() => tokens[Math.min(i, tokens.length - 1)]!) as TokenSource & { refreshes: number }
  get.refreshes = 0
  get.refresh = async () => {
    get.refreshes++
    i++
    return tokens[Math.min(i, tokens.length - 1)]!
  }
  return get
}

describe('a 401 is retried once', () => {
  test('the call is replayed with the new token and succeeds', async () => {
    const seen = mcpServer(1)
    const tok = source(['old', 'new'])
    const t = new HttpTransport('https://mcp.test.invalid/mcp', tok)

    expect(await t.request('tools/call', { name: 'search_threads' })).toEqual({ ok: true })
    expect(tok.refreshes).toBe(1)
    expect(seen).toHaveLength(2)
    expect(seen[0]!.auth).toBe('Bearer old')
    expect(seen[1]!.auth).toBe('Bearer new')
  })

  test('the replay drops the session issued under the refused token', async () => {
    // Mandatory. A fresh bearer with the old `Mcp-Session-Id` re-enters the dead
    // session and earns a second 401 — which is the shape that made a reconnect
    // need a server restart.
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const h = new Headers(init?.headers as HeadersInit)
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (h.get('mcp-session-id')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { replayedInOldSession: true } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (!seenOne) {
        seenOne = true
        return new Response('', { status: 401, headers: { 'mcp-session-id': 'session-1' } })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    let seenOne = false

    const t = new HttpTransport('https://mcp.test.invalid/mcp', source(['old', 'new']))
    expect(await t.request('tools/list')).toEqual({ ok: true })
  })

  test('a second 401 throws rather than looping', async () => {
    const seen = mcpServer(99)
    const tok = source(['old', 'new'])
    const t = new HttpTransport('https://mcp.test.invalid/mcp', tok)

    await expect(t.request('tools/list')).rejects.toBeInstanceOf(McpUnauthorized)
    expect(tok.refreshes, 'the retry refreshed more than once').toBe(1)
    expect(seen, 'the transport retried more than once').toHaveLength(2)
  })

  test('a refresh that yields nothing is not replayed', async () => {
    const seen = mcpServer(99)
    const get = (() => 'old') as TokenSource
    get.refresh = async () => null
    const t = new HttpTransport('https://mcp.test.invalid/mcp', get)

    await expect(t.request('tools/list')).rejects.toBeInstanceOf(McpUnauthorized)
    expect(seen).toHaveLength(1)
  })

  test('a token source that cannot refresh throws on the first 401', async () => {
    const seen = mcpServer(99)
    const t = new HttpTransport('https://mcp.test.invalid/mcp', () => 'old')

    await expect(t.request('tools/list')).rejects.toBeInstanceOf(McpUnauthorized)
    expect(seen).toHaveLength(1)
  })

  test('the write path is never replayed', async () => {
    // A 401 on the response says nothing about whether the send reached Gmail.
    // A duplicate email is worse than a failed one.
    const seen = mcpServer(1)
    const tok = source(['old', 'new'])
    const t = new HttpTransport('https://mcp.test.invalid/mcp', tok)

    await expect(t.request('tools/call', { name: 'send_message' }, false))
      .rejects.toBeInstanceOf(McpUnauthorized)
    expect(seen, 'a send was replayed after a 401').toHaveLength(1)
    expect(tok.refreshes).toBe(0)
  })
})
