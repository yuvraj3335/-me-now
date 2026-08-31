/**
 * The wire between a browser and a live session.
 *
 * One WebSocket, one pty bridge, one tmux client. The bridge is per *connection*
 * rather than per session, and that is the whole design: a tmux session may have
 * any number of clients, so a laptop and a phone each get their own attachment
 * to the same screen, each resizes independently, and either can go away without
 * the other noticing. Nothing here is shared state to be reconciled — tmux is.
 *
 * Frames are typed by *kind*, not by a field:
 *
 *   server → client   binary  raw pty bytes, straight into `term.write()`
 *                     text    JSON: {"t":"open"} {"t":"exit"} {"t":"error"}
 *   client → server   text    JSON: {"t":"i","d":…} {"t":"r",cols,rows} {"t":"ping"}
 *
 * Output is binary on purpose. A pty emits UTF-8 in whatever chunks the kernel
 * gives it, and a multi-byte character routinely straddles two reads — decoding
 * each chunk to a string here would turn every such split into a replacement
 * character on screen. xterm.js accepts `Uint8Array` and does the stateful
 * decoding itself, so the bytes are handed over untouched.
 */

import { Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import { ALLOWED_ORIGINS, TERMINAL_COLS, TERMINAL_ROWS } from '../env'
import { attachArgv, getTerminal, isSessionId, sizeFileFor } from './terminal'

const { upgradeWebSocket, websocket: handlers } = createBunWebSocket<ServerWebSocket>()

/**
 * Bun's handlers, with the one option that decides whether a terminal survives
 * being read.
 *
 * Bun closes a WebSocket after 120 seconds with no traffic **in either
 * direction**, and a Claude Code session is silent for exactly as long as it is
 * waiting for the operator — which is precisely the moment he is reading the
 * screen and deciding what to type. The default would drop the socket during
 * every pause longer than two minutes, redraw the whole screen on reconnect, and
 * do it again on the next pause.
 *
 * Belt as well as braces: the page also sends `{"t":"ping"}` every 30 seconds,
 * which keeps the timer from ever being reached and doubles as the client's own
 * way of noticing a socket that died silently on a sleeping phone. The ceiling
 * is raised anyway, because a keepalive that stops firing must not also mean a
 * session that closes.
 */
export const websocket = { ...handlers, idleTimeout: 300 }

export const terminalSocket = new Hono()

const clamp = (v: string | undefined, fallback: number, max: number) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 8 && n <= max ? n : fallback
}

/**
 * The origin check `originGuard()` cannot do.
 *
 * A WebSocket upgrade is a GET, so `security.ts` waves it through — and this is
 * the one GET in the product that opens a writable channel into a shell. A page
 * on any other site can open a socket to this URL, and the browser will attach
 * the Cloudflare Access cookie to it exactly as it would to a same-origin
 * request; Access proves who is asking and says nothing about which page asked.
 *
 * Browsers always send `Origin` on a WebSocket handshake, so the absent case is
 * not a browser — `websocat` on the box, or the test suite — and is allowed for
 * the same reason `originGuard` allows it: those callers are already behind
 * Access or already in-process.
 */
const SOCKET = '/api/claude/terminals/:id/socket'

terminalSocket.get(SOCKET, async (c, next) => {
  const origin = c.req.header('origin')
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return c.json({ error: `origin ${origin} may not attach to a session here` }, 403)
  }

  const id = c.req.param('id')
  if (!isSessionId(id)) return c.json({ error: 'that is not a session id' }, 400)
  // Checked before the upgrade, so "that session is not running any more" is an
  // HTTP status the page can read rather than a socket that opens and shuts.
  if (!getTerminal(id)) return c.json({ error: 'that session is not running on this machine' }, 404)

  return next()
})

terminalSocket.get(
  SOCKET,
  upgradeWebSocket(c => {
    // Narrowed rather than asserted. The guard above has already refused
    // anything that is not a session id, so this is only ever the empty string
    // in a world where Hono stopped matching `:id` — and `attachArgv` refuses
    // that by shape rather than trusting this line.
    const id = c.req.param('id') ?? ''
    const cols = clamp(c.req.query('cols'), TERMINAL_COLS, 500)
    const rows = clamp(c.req.query('rows'), TERMINAL_ROWS, 300)

    // Per-connection, so two devices resizing at once cannot write each other's
    // size into one file.
    const token = randomUUID()
    const sizeFile = sizeFileFor(token)

    let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | null = null
    let closed = false

    const stop = () => {
      if (closed) return
      closed = true
      try { proc?.kill() } catch { /* already gone is the state we wanted */ }
      // The tmux session is untouched: killing a client detaches it, which is
      // the entire reason the session survives the tab closing.
      try { unlinkSync(sizeFile) } catch { /* likewise */ }
    }

    return {
      onOpen(_evt, ws) {
        const argv = attachArgv({ id, cols, rows, sizeFile })
        if (!argv) {
          ws.send(JSON.stringify({ t: 'error', message: 'that is not a session id' }))
          return ws.close()
        }

        writeFileSync(sizeFile, `${cols},${rows}`, 'utf8')

        proc = Bun.spawn(argv, {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          // A terminal that does not say it is a terminal renders as a teletype.
          // xterm.js speaks xterm-256color, and tmux translates from there to
          // whatever the inner program asked for.
          env: { ...process.env, TERM: 'xterm-256color' },
        }) as Bun.Subprocess<'pipe', 'pipe', 'pipe'>

        ws.send(JSON.stringify({ t: 'open', cols, rows }))

        void (async () => {
          // A reader rather than `for await`. Bun's stdout is a ReadableStream
          // and TypeScript's DOM lib does not give it an async iterator, so the
          // explicit reader is the portable spelling of the same loop.
          const reader = proc!.stdout.getReader()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              // readyState 1 is OPEN. A closed socket that is still being
              // written to is how a detached tab turns into a memory leak.
              if (ws.readyState !== 1) break
              // Copied into a buffer of its own before it is handed to the
              // socket: the stream's chunk is backed by a buffer Bun may reuse
              // for the next read, and a send that has not been flushed yet
              // would then carry whatever landed there afterwards.
              if (value) ws.send(new Uint8Array(value).slice())
            }
          } catch { /* the pipe went away; the exit below is the real news */ }
          finally { try { reader.releaseLock() } catch { /* already released */ } }
        })()

        void (async () => {
          const code = await proc!.exited
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ t: 'exit', code }))
            ws.close()
          }
          stop()
        })()
      },

      onMessage(evt, ws) {
        if (typeof evt.data !== 'string' || !proc) return
        let msg: { t?: string; d?: string; cols?: number; rows?: number }
        try { msg = JSON.parse(evt.data) } catch { return }

        if (msg.t === 'i' && typeof msg.d === 'string') {
          try {
            proc.stdin.write(msg.d)
            proc.stdin.flush()
          } catch {
            ws.send(JSON.stringify({ t: 'error', message: 'the session stopped accepting input' }))
          }
          return
        }

        // A keepalive, and nothing else. Receiving it is the whole effect —
        // Bun's idle timer resets on any frame — so there is nothing to answer.
        if (msg.t === 'ping') return

        if (msg.t === 'r') {
          const w = clamp(String(msg.cols), cols, 500)
          const h = clamp(String(msg.rows), rows, 300)
          try {
            // The file carries the value; the signal carries the event. See
            // `ptybridge.py` for why a resize crosses the process boundary this
            // way rather than down the same pipe as the keystrokes.
            writeFileSync(sizeFile, `${w},${h}`, 'utf8')
            if (proc.pid) process.kill(proc.pid, 'SIGWINCH')
          } catch { /* the next resize carries the same information */ }
        }
      },

      onClose() { stop() },
      onError() { stop() },
    }
  }),
)
