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
 * Wake is read-only against the outside world. Rather than trusting every future
 * edit to remember that, any tool whose name looks like a mutation is refused
 * here — a mistake becomes a loud error instead of a message sent to a colleague.
 * See DECISIONS.md #7.
 */
const WRITE_TOOL = /(^|_)(send|post|create|update|delete|remove|trash|untrash|archive|label|unlabel|mark|unmark|write|set|add|edit|reply|schedule|invite|join|leave|upload|assign|resolve|close|merge|approve)(_|$)/i

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
  request(method: string, params?: unknown): Promise<any>
  notify(method: string, params?: unknown): Promise<void>
  close(): Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Streamable HTTP                                                            */
/* -------------------------------------------------------------------------- */

export class HttpTransport implements McpTransport {
  private sessionId: string | null = null
  private nextId = 1

  constructor(
    private url: string,
    private getToken: () => Promise<string | null> | string | null,
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

  async request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    const res = await this.send({ jsonrpc: '2.0', id, method, params })

    // The session id is only issued once, on initialize; every later call must
    // echo it back or the server treats us as a new, unauthenticated client.
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid

    if (res.status === 401) {
      throw new McpUnauthorized(`401 from ${this.url}`, res.headers.get('www-authenticate') ?? undefined)
    }
    if (!res.ok) {
      throw new McpError(`HTTP ${res.status} from ${this.url}: ${(await res.text()).slice(0, 300)}`, undefined, res.status)
    }

    const ctype = res.headers.get('content-type') ?? ''
    const payload = ctype.includes('text/event-stream')
      ? await readSseResult(res, id)
      : ((await res.json()) as JsonRpcResponse)

    if (payload.error) throw new McpError(payload.error.message, payload.error.code)
    return payload.result
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

  async listTools(force = false): Promise<McpTool[]> {
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
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (WRITE_TOOL.test(name)) {
      throw new McpError(`refusing to call "${name}": Wake is read-only against external systems`)
    }
    await this.init()
    const r = await this.transport.request('tools/call', { name, arguments: args })
    if (r?.isError) {
      const text = extractText(r)
      throw new McpError(`tool ${name} failed: ${text.slice(0, 400)}`)
    }
    return r
  }

  /** Tool results carry text and/or structured content; prefer the structured form. */
  async callJson<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const r: any = await this.callTool(name, args)
    if (r?.structuredContent !== undefined) return r.structuredContent as T
    const text = extractText(r)
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }

  close() {
    return this.transport.close()
  }
}

export function extractText(result: any): string {
  const content = result?.content
  if (!Array.isArray(content)) return typeof result === 'string' ? result : ''
  return content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
}
