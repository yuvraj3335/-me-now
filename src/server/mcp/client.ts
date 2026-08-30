/**
 * A real MCP client: Streamable HTTP (2025-06-18) and stdio.
 *
 * No model is involved anywhere in this file. Wake calls `tools/call` directly
 * and normalizes whatever comes back — see DECISIONS.md #3.
 */

const PROTOCOL_VERSION = '2025-06-18'

export type JsonRpcResponse = { jsonrpc: '2.0'; id: number | string; result?: any; error?: { code: number; message: string; data?: unknown } }

export type McpTool = { name: string; description?: string; inputSchema?: unknown }

/**
 * Wake's ingest path is read-only against the outside world. Rather than
 * trusting every future edit to remember that, any tool whose name looks like a
 * mutation is refused here — a mistake becomes a loud error instead of a message
 * sent to a colleague. See DECISIONS.md #7.
 *
 * `modify` and `patch` are on the list because Gmail's own mutation for marking
 * read and changing labels is `modify_message`, which the first version of this
 * pattern waved straight through: it names an operation nobody would call
 * "send", and it changes a real mailbox.
 *
 * Sending mail is the one sanctioned exception, and it goes through
 * `callWriteTool` below — a named door, not a hole.
 */
const WRITE_TOOL =
  /(^|_)(send|post|create|update|patch|modify|move|delete|remove|trash|untrash|archive|label|unlabel|mark|unmark|star|unstar|write|set|add|insert|import|edit|reply|forward|schedule|invite|join|leave|upload|assign|resolve|close|merge|approve)(_|$)/i

export class McpError extends Error {
  constructor(message: string, readonly code?: number, readonly status?: number) {
    super(message)
    this.name = 'McpError'
  }
}

/** Raised when the server says 401 — the caller should re-run the OAuth flow. */
export class McpUnauthorized extends McpError {
  constructor(message = 'MCP server requires authentication', readonly wwwAuthenticate?: string) {
    super(message, undefined, 401)
    this.name = 'McpUnauthorized'
  }
}

export interface McpTransport {
  /**
   * `retryable` is false for the audited write path. A replayed read costs a
   * duplicate GET; a replayed `send_message` can deliver an email twice, because
   * a 401 on the response says nothing about whether the request reached Gmail.
   */
  request(method: string, params?: unknown, retryable?: boolean): Promise<any>
  notify(method: string, params?: unknown): Promise<void>
  close(): Promise<void>
}

/**
 * Where a transport gets its bearer token, and how it asks for a new one.
 *
 * A bare function is still a valid source and simply never retries. `refresh` is
 * what makes a 401 recoverable: the transport does not know which credential it
 * is holding and has no business knowing, while the thing that produced the
 * token does. Wiring the renewal through the token source rather than through a
 * fourth constructor argument is what lets a session built anywhere in the
 * codebase get the retry without naming its server twice.
 */
export type TokenSource = (() => Promise<string | null> | string | null) & {
  refresh?: () => Promise<string | null>
}

/* -------------------------------------------------------------------------- */
/* Streamable HTTP                                                            */
/* -------------------------------------------------------------------------- */

export class HttpTransport implements McpTransport {
  private sessionId: string | null = null
  private nextId = 1

  constructor(
    private url: string,
    private getToken: TokenSource,
    private timeoutMs = 30_000,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      // Both are advertised: servers may answer a single JSON body or an SSE
      // stream for the very same request, and we handle each below.
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    }
    const token = await this.getToken()
    if (token) h.Authorization = `Bearer ${token}`
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId
    return h
  }

  private async send(body: unknown): Promise<Response> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), this.timeoutMs)
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
    } finally {
      clearTimeout(t)
    }
  }

  async request(method: string, params?: unknown, retryable = true): Promise<any> {
    let retried = false

    for (;;) {
      const id = this.nextId++
      const res = await this.send({ jsonrpc: '2.0', id, method, params })

      // The session id is only issued once, on initialize; every later call must
      // echo it back or the server treats us as a new, unauthenticated client.
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid

      if (res.status === 401) {
        // Exactly once, and only for a read. The token in hand may simply have
        // been rotated out from under a long-running poll, which is a state the
        // expiry check cannot see and one round-trip can fix.
        if (retryable && !retried && this.getToken.refresh) {
          retried = true
          // Mandatory: the session was issued against the credential the server
          // has just refused. Replaying with a fresh bearer but the old
          // `Mcp-Session-Id` re-enters that dead session and earns a second 401.
          this.sessionId = null
          if (await this.getToken.refresh()) continue
        }
        throw new McpUnauthorized(`401 from ${this.url}`, res.headers.get('www-authenticate') ?? undefined)
      }
      if (!res.ok) {
        throw new McpError(`${res.status} from ${this.url}: ${friendlyBody(await res.text())}`, undefined, res.status)
      }

      const ctype = res.headers.get('content-type') ?? ''
      const payload = ctype.includes('text/event-stream')
        ? await readSseResult(res, id)
        : ((await res.json()) as JsonRpcResponse)

      if (payload.error) throw new McpError(payload.error.message, payload.error.code)
      return payload.result
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    // Notifications have no id and expect no body back.
    await this.send({ jsonrpc: '2.0', method, params }).catch(() => {})
  }

  async close() {
    if (!this.sessionId) return
    await fetch(this.url, { method: 'DELETE', headers: await this.headers() }).catch(() => {})
    this.sessionId = null
  }
}

/**
 * Streamable HTTP may answer a POST with an SSE stream that carries unrelated
 * server-initiated traffic alongside our answer, so we read frames until the id
 * we asked for shows up rather than taking the first message.
 */
async function readSseResult(res: Response, wantId: number | string): Promise<JsonRpcResponse> {
  if (!res.body) throw new McpError('SSE response had no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let sep: number
      // Frames are separated by a blank line; \r\n\r\n is legal too.
      while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buf.slice(0, sep)
        buf = buf.slice(sep + (buf[sep] === '\r' ? 4 : 2))

        const data = frame
          .split(/\r?\n/)
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trim())
          .join('\n')
        if (!data) continue

        let msg: JsonRpcResponse
        try {
          msg = JSON.parse(data)
        } catch {
          continue
        }
        if (msg.id === wantId) return msg
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  throw new McpError('SSE stream ended before a matching response arrived')
}

/* -------------------------------------------------------------------------- */
/* stdio                                                                      */
/* -------------------------------------------------------------------------- */

export class StdioTransport implements McpTransport {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private stdin: { write(s: string): void } | null = null
  private nextId = 1
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private buf = ''

  constructor(private cmd: string[], private env: Record<string, string> = {}) {}

  private ensure() {
    if (this.proc) return
    this.proc = Bun.spawn(this.cmd, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, ...this.env } as Record<string, string>,
    })
    this.stdin = this.proc.stdin as unknown as { write(s: string): void }
    void this.pump()
  }

  private async pump() {
    const dec = new TextDecoder()
    // @ts-expect-error Bun's stdout is a ReadableStream when piped
    for await (const chunk of this.proc!.stdout) {
      this.buf += dec.decode(chunk, { stream: true })
      let nl: number
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as JsonRpcResponse
          const p = this.pending.get(msg.id)
          if (!p) continue
          this.pending.delete(msg.id)
          msg.error ? p.reject(new McpError(msg.error.message, msg.error.code)) : p.resolve(msg.result)
        } catch {
          /* a server logging to stdout is not fatal; skip the line */
        }
      }
    }
  }

  request(method: string, params?: unknown): Promise<any> {
    this.ensure()
    const id = this.nextId++
    const p = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new McpError(`stdio timeout on ${method}`))
      }, 30_000)
    })
    this.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return p
  }

  async notify(method: string, params?: unknown) {
    this.ensure()
    this.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  async close() {
    this.proc?.kill()
    this.proc = null
    this.stdin = null
  }
}

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

export class McpSession {
  private ready: Promise<void> | null = null
  private tools: McpTool[] | null = null

  constructor(readonly name: string, private transport: McpTransport) {}

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await this.transport.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'wake', version: '0.1.0' },
      })
      await this.transport.notify('notifications/initialized')
    })().catch(err => {
      this.ready = null // a failed handshake must not poison every later call
      throw err
    })
    return this.ready
  }

  /**
   * Forget the handshake and the tool list.
   *
   * Both were established under one credential. After a 401 that survived the
   * transport's retry, keeping them is how a reconnect went on serving the
   * previous token's tool surface for the rest of the process — the shape that
   * made "disconnect Slack, reconnect Slack" need a server restart.
   */
  async reset() {
    this.ready = null
    this.tools = null
    await this.transport.close().catch(() => {})
  }

  async listTools(force = false): Promise<McpTool[]> {
    try {
      await this.init()
      if (this.tools && !force) return this.tools
      const out: McpTool[] = []
      let cursor: string | undefined
      do {
        const r = await this.transport.request('tools/list', cursor ? { cursor } : {})
        out.push(...(r?.tools ?? []))
        cursor = r?.nextCursor
      } while (cursor)
      this.tools = out
      return out
    } catch (e) {
      if (e instanceof McpUnauthorized) await this.reset()
      throw e
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (WRITE_TOOL.test(name)) {
      throw new McpError(`refusing to call "${name}": Wake is read-only against external systems`)
    }
    return this.invoke(name, args, true)
  }

  /**
   * The sanctioned way past the denylist above.
   *
   * The card ingest and every search path must stay read-only, and the denylist
   * is what guarantees that without trusting each future edit to remember. But
   * "Wake can never send" stopped being true when Mail grew a Send button, and
   * a denylist with a quiet bypass is worse than one with a named door.
   *
   * Callers reach this only after a confirmation token bound to the exact
   * arguments has been spent (`security.ts`), and every call is audited.
   */
  async callWriteTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // Never replayed. A 401 arriving on the response is silent about whether the
    // send happened, and a duplicate email is worse than a failed one.
    return this.invoke(name, args, false)
  }

  private async invoke(name: string, args: Record<string, unknown>, retryable: boolean): Promise<unknown> {
    try {
      await this.init()
      const r = await this.transport.request('tools/call', { name, arguments: args }, retryable)
      if (r?.isError) {
        const text = extractText(r)
        throw new McpError(`tool ${name} failed: ${text.slice(0, 400)}`)
      }
      return r
    } catch (e) {
      if (e instanceof McpUnauthorized) await this.reset()
      throw e
    }
  }

  /** Tool results carry text and/or structured content; prefer the structured form. */
  async callJson<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return unwrap<T>(await this.callTool(name, args))
  }

  /** `callJson`'s counterpart for the audited write path. */
  async callWriteJson<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return unwrap<T>(await this.callWriteTool(name, args))
  }

  close() {
    return this.transport.close()
  }
}

function unwrap<T>(r: any): T {
  if (r?.structuredContent !== undefined) return r.structuredContent as T
  const text = extractText(r)
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

export function extractText(result: any): string {
  const content = result?.content
  if (!Array.isArray(content)) return typeof result === 'string' ? result : ''
  return content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
}

/**
 * A non-2xx response body is, in practice, the same JSON-RPC envelope a
 * successful call would have returned — the human sentence is nested inside
 * `result.content[].text` or `error.message`, and everything around it is
 * transport wrapper nobody reading a card or a mail row asked to see. Surface
 * the nested sentence; only fall back to the raw body when it isn't JSON at
 * all (an HTML error page, a plain-text 502 from a proxy in front of the MCP
 * server).
 */
function friendlyBody(text: string): string {
  try {
    const j = JSON.parse(text)
    const nested = j?.error?.message ?? (extractText(j?.result) || j?.message)
    if (typeof nested === 'string' && nested) return nested.slice(0, 300)
  } catch { /* not JSON — the raw text below is the whole message */ }
  return text.slice(0, 300)
}
