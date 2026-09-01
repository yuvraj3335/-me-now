/**
 * The session, on screen.
 *
 * This is the page the whole "Open in Claude" chain now ends at: a real Claude
 * Code process, running on the DevBox, in the repository the brief named — its
 * output, its prompts, its permission dialogs — reachable at
 * `/terminal/<session-id>` from a laptop or a phone on the public URL.
 *
 * Four decisions are worth stating, because each of them is the difference
 * between a terminal you can *look* at and one you can *answer*:
 *
 * **A real emulator, not a log.** Claude Code draws a TUI: cursor addressing,
 * alternate lines, colour, a composer that redraws as you type. `capture-pane`
 * into a `<pre>` would show you a still photograph of that, and you could not
 * answer a permission prompt from a photograph. xterm.js is the only honest
 * option, and its `Uint8Array` write path is why the socket sends bytes.
 *
 * **A key bar, because a phone has no Escape.** A soft keyboard has letters and
 * a return key. It has no Escape, no Tab, no arrows and no Control — which is
 * exactly the set Claude Code's dialogs are driven with. Shipping a terminal you
 * cannot cancel out of, or cannot pick option 2 in, from the device he actually
 * has at 7am is shipping the screenshot of a feature. The bar appears on coarse
 * pointers only; a laptop already has these keys.
 *
 * **The terminal keeps its dark ground in both themes.** Everything else in Wake
 * follows `data-theme`. A terminal cannot: the program drawing into it picks its
 * own colours against a dark background, and the greys Claude Code uses for its
 * chrome disappear entirely on an off-white page. The palette below is Wake's
 * own dark tokens pinned by value — see `styles.css` — rather than a second
 * design system.
 *
 * **Type size is a control, not a constant.** On a 390px phone the trade between
 * legibility and columns is real and personal, and Claude Code lays its boxes
 * out against whatever width it is given. Two buttons and a `localStorage` key
 * beat guessing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronLeft, ChevronRight, Keyboard,
  Minus, Plus, Power,
} from 'lucide-react'
import { Button } from '../components/primitives'
import { navigate } from '../lib/route'
import { toast } from '../lib/toast'
import {
  terminalApi, terminalSocketUrl, type Terminal as TerminalInfo,
} from '../lib/terminal'

/**
 * The terminal's palette, which is the one thing on this page that cannot follow
 * the theme.
 *
 * Everything else in Wake repaints from `--color-*` when `data-theme` changes. A
 * terminal cannot, for two reasons that are both about the *program* rather than
 * about the page: xterm takes its colours as concrete strings at construction,
 * and — more to the point — Claude Code chooses its own greys and hues against a
 * dark ground. Repainting its output in light-mode tokens would not theme the
 * TUI, it would erase half of it.
 *
 * So these are pinned dark-theme values from `styles.css`, and they are written
 * as palettes rather than as scattered constants because that is what they are:
 * a ground, the eight ANSI colours and their bright halves, addressed by index
 * by every program that draws here. The hues are still the product's own —
 * `accent` is the yellow, `ok` the green, `bad` the red, and the source dots
 * supply magenta and blue — so a session reads as part of Wake and not as
 * somebody's default xterm.
 *
 * `--color-ink-950` is the ground on purpose: it is the one ink token that stays
 * dark in both themes, because it is also the scrim and the button ink.
 */
const GROUND_PALETTE = { background: '#08080a', foreground: '#e8e8ee', cursor: '#e9a23b', cursorAccent: '#08080a', selectionBackground: '#22232f' } as const
const ANSI_PALETTE = { black: '#17171c', red: '#e08282', green: '#6bd39a', yellow: '#e9a23b', blue: '#8fa4c4', magenta: '#b58ee0', cyan: '#86c8d4', white: '#c4c4d0' } as const
const BRIGHT_PALETTE = { brightBlack: '#6c6c7c', brightRed: '#ef9494', brightGreen: '#8ae0b4', brightYellow: '#f2b962', brightBlue: '#9db1ce', brightMagenta: '#c2a3e8', brightCyan: '#9fd8e2', brightWhite: '#f2f2f5' } as const

const THEME = { ...GROUND_PALETTE, ...ANSI_PALETTE, ...BRIGHT_PALETTE }

const FONT_KEY = 'wake.terminal.fontSize'
const FONT_MIN = 9
const FONT_MAX = 20

const storedFont = (): number => {
  try {
    const n = Number(localStorage.getItem(FONT_KEY))
    return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? n : 13
  } catch {
    // Private mode, storage off. 13 is the right answer, and neither is an error.
    return 13
  }
}

/**
 * Whether the key bar is needed — asked two ways, because one is not safe enough.
 *
 * `pointer: coarse` is the query that is actually *right*: the bar exists
 * because a soft keyboard has no Escape, no Tab, no arrows and no Control, which
 * is a fact about the input device and not about the width of the window.
 *
 * It is not the only test, because of what happens when it is wrong. A narrow
 * window that reports a fine pointer — a browser that does not emulate touch, a
 * phone in a webview, a device that simply lies — would render a terminal with
 * *no way to press Escape at all*, and answering a permission prompt is the
 * whole reason this page exists. So width is asked as well, at the same 640px
 * the rest of the product calls a phone. The cost of a false positive is one row
 * of buttons on a narrow desktop window; the cost of a false negative is a
 * session he cannot answer. Those are not comparable, so the rule is `or`.
 */
function useKeyBar(): boolean {
  const q = '(pointer: coarse), (max-width: 639px)'
  const [need, setNeed] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setNeed(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return need
}

/**
 * The height a phone can actually draw into.
 *
 * `100dvh` accounts for the browser's own chrome and not for the soft keyboard,
 * so on a phone the bottom third of a `dvh` terminal — the composer, the
 * permission prompt, the key bar — sits underneath the keyboard the operator
 * just opened in order to answer it. `visualViewport.height` is the number that
 * moves when the keyboard does.
 */
function useViewportHeight(): number | null {
  const [h, setH] = useState<number | null>(null)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const on = () => setH(vv.height)
    on()
    vv.addEventListener('resize', on)
    vv.addEventListener('scroll', on)
    return () => { vv.removeEventListener('resize', on); vv.removeEventListener('scroll', on) }
  }, [])
  return h
}

type Status = 'loading' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'gone'

export function TerminalPage({ id }: { id: string }) {
  const host = useRef<HTMLDivElement | null>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const sock = useRef<WebSocket | null>(null)
  /** Set when the operator leaves or ends it, so the reconnect loop stands down. */
  const done = useRef(false)
  const tries = useRef(0)

  /**
   * Bumped once per attachment, and the only thing the emulator effect below
   * depends on.
   *
   * It was `status === 'connecting'`, which is a boolean that goes *false* the
   * moment the socket opens — so React ran the cleanup and disposed the terminal
   * one tick after it connected. The screen was black, the status said Live, and
   * both were telling the truth about different objects. A counter that only
   * ever counts up cannot express "tear this down because it worked".
   */
  const [attach, setAttach] = useState(0)
  const [status, setStatus] = useState<Status>('loading')
  const [info, setInfo] = useState<TerminalInfo | null>(null)
  const [session, setSession] = useState<{ title: string; cwd: string; project: string; branch: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [font, setFont] = useState(storedFont)
  const [ending, setEnding] = useState(false)

  const showKeys = useKeyBar()
  const vh = useViewportHeight()

  /* --------------------------- what is running --------------------------- */

  useEffect(() => {
    let alive = true
    void terminalApi.get(id)
      .then(r => {
        if (!alive) return
        setInfo(r.terminal)
        setSession(r.session)
        setStatus(r.terminal ? 'connecting' : 'gone')
        if (r.terminal) setAttach(a => a + 1)
      })
      .catch(e => {
        if (!alive) return
        setError((e as Error).message)
        setStatus('gone')
      })
    return () => { alive = false }
  }, [id])

  /* ------------------------------ the wire ------------------------------- */

  const send = useCallback((msg: unknown) => {
    const ws = sock.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  /** Type into the session. Everything the key bar sends goes through here. */
  const type = useCallback((d: string) => {
    send({ t: 'i', d })
    term.current?.focus()
  }, [send])

  /**
   * Raise the soft keyboard without sending anything.
   *
   * It has to run inside the gesture that asked for it: a phone opens its
   * keyboard for a `focus()` that a tap caused and ignores one that arrives on
   * its own, which is why this is a callback the key bar invokes from
   * `onPointerDown` rather than an effect.
   */
  const focusInput = useCallback(() => { term.current?.focus() }, [])

  const connect = useCallback(() => {
    if (done.current || !term.current || !fit.current) return
    const { cols, rows } = term.current
    const ws = new WebSocket(terminalSocketUrl(id, { cols, rows }))
    ws.binaryType = 'arraybuffer'
    sock.current = ws

    ws.onopen = () => {
      tries.current = 0
      setStatus('live')
      // The size the emulator settled on, not the one the URL guessed at: the
      // fit runs against a container whose height only exists after layout.
      send({ t: 'r', cols: term.current!.cols, rows: term.current!.rows })
    }

    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data) as { t?: string; code?: number; message?: string }
        // The session's own process ended — Claude Code exited, or it was
        // closed from another device. That is not a connection to retry.
        if (msg.t === 'exit') { done.current = true; setStatus('ended') }
        if (msg.t === 'error' && msg.message) setError(msg.message)
        /*
         * The size, again, now that there is something on the far end to hear it.
         *
         * A resize is a write to a file plus a SIGWINCH — fire and forget, with
         * no acknowledgement — so one sent before the bridge has forked its pty
         * and tmux has attached is simply lost, and the window keeps whatever
         * the URL guessed. Measured: a resize sent on `onopen` left the window
         * at 120x34; the identical message three seconds later moved it to
         * 48x40. Losing it costs a phone a 120-column TUI on a 390px screen,
         * which is the one place the size actually matters.
         *
         * `open` is the frame that says the pty is live, so it is the honest
         * moment to state a size. The `onopen` send stays: it is right far more
         * often than not, and two identical resizes cost nothing.
         */
        if (msg.t === 'open' && term.current) {
          send({ t: 'r', cols: term.current.cols, rows: term.current.rows })
        }
        return
      }
      // Bytes, straight through. xterm does the UTF-8 decoding statefully,
      // which is what keeps a character split across two reads a character.
      term.current?.write(new Uint8Array(e.data as ArrayBuffer))
    }

    ws.onclose = () => {
      if (done.current) return
      // A phone that locked, a tunnel that blipped, a laptop that slept. The
      // session is still there — tmux holds it — so the only right answer is to
      // attach again rather than to tell him it is gone.
      tries.current += 1
      if (tries.current > 8) { setStatus('ended'); return }
      setStatus('reconnecting')
      setTimeout(connect, Math.min(500 * tries.current, 4_000))
    }
  }, [id, send])

  /* ---------------------------- the emulator ----------------------------- */

  useEffect(() => {
    if (!attach || !host.current) return
    done.current = false
    tries.current = 0

    const t = new XTerm({
      fontSize: font,
      // A stack rather than one name: the box has DejaVu, a Mac has Menlo, and a
      // terminal in a proportional font is unreadable in a way nothing else is.
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      lineHeight: 1.15,
      theme: THEME,
      cursorBlink: true,
      // Enough to read back one long tool run. tmux keeps its own history too;
      // this is what a scroll gesture moves through without a round trip.
      scrollback: 5_000,
      // The pty already sends CRLF. Converting again would double every line.
      convertEol: false,
      allowTransparency: false,
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    f.fit()
    term.current = t
    fit.current = f

    // Everything typed — and everything pasted, which arrives here too, so a
    // long brief pasted from the phone's clipboard reaches the composer intact.
    t.onData(d => send({ t: 'i', d }))
    t.focus()

    connect()

    return () => {
      done.current = true
      sock.current?.close()
      t.dispose()
      term.current = null
      fit.current = null
    }
    // Only `attach`. `font` has an effect of its own and `connect` is a stable
    // callback; putting either here would dispose a live terminal to change a
    // type size, which is how this went wrong the first time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attach])

  /* ------------------------------ geometry ------------------------------- */

  const refit = useCallback(() => {
    if (!fit.current || !term.current) return
    try { fit.current.fit() } catch { return /* the container has no size yet */ }
    send({ t: 'r', cols: term.current.cols, rows: term.current.rows })
  }, [send])

  useEffect(() => {
    if (!host.current) return
    const ro = new ResizeObserver(() => refit())
    ro.observe(host.current)
    return () => ro.disconnect()
  }, [refit, attach])

  // A rotation, a keyboard opening, a laptop window dragged wider.
  useEffect(() => { refit() }, [vh, refit])

  useEffect(() => {
    if (!term.current) return
    term.current.options.fontSize = font
    refit()
    try { localStorage.setItem(FONT_KEY, String(font)) } catch { /* see storedFont */ }
  }, [font, refit])

  /**
   * A frame every thirty seconds, so the socket is never idle.
   *
   * Bun closes a WebSocket that has carried nothing either way for a while, and
   * a session waiting for the operator to decide what to type carries nothing in
   * either direction — so the pause where he is *reading the screen* is exactly
   * the pause that would drop the connection. The server raises its own ceiling
   * too; this is the half that means the ceiling is never approached.
   */
  useEffect(() => {
    const t = setInterval(() => send({ t: 'ping' }), 30_000)
    return () => clearInterval(t)
  }, [send])

  /**
   * Coming back to a tab that was asleep.
   *
   * A backgrounded phone browser closes sockets without firing anything useful
   * first, so the reconnect loop above may already have given up by the time he
   * looks again. Returning to the tab is the clearest possible signal that he
   * wants to see it now.
   */
  useEffect(() => {
    const on = () => {
      if (document.visibilityState !== 'visible') return
      if (done.current || sock.current?.readyState === WebSocket.OPEN) return
      tries.current = 0
      connect()
    }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [connect])

  /* ------------------------------- actions ------------------------------- */

  const back = () => {
    // History if there is any — he arrived here from the sheet or the Sessions
    // list and that is where "back" means. A cold deep link from a push
    // notification has none, and Sessions is the page this belongs to.
    if (window.history.length > 1) window.history.back()
    else navigate('/sessions')
  }

  /**
   * What a stopped session actually offers, which is not a resume.
   *
   * This used to `POST /terminals {sessionId}` again, on the theory that the
   * transcript is still here so the conversation can be picked up. Claude Code
   * does not agree once the process is gone: the id names a record, `--resume`
   * is where "this session has been archived" comes from, and Wake now refuses
   * to hand a non-running id to it at all — so the button was a request that
   * could only ever come back as an error toast.
   *
   * A new conversation in the same directory is the honest offer, and it is the
   * one the Sessions page already makes. The repository travels so he does not
   * have to find it again; the transcript stays where it is and is still
   * readable on the session page.
   */
  const startFresh = () => {
    const where = session?.cwd ?? info?.cwd
    navigate(where ? `/sessions/new?repo=${encodeURIComponent(where)}` : '/sessions/new')
  }

  const end = async () => {
    // Two presses, no dialog. Ending a session is recoverable — the transcript
    // survives and it can be resumed — so a modal would be ceremony; a single
    // press next to a thumb would be an accident.
    if (!ending) { setEnding(true); setTimeout(() => setEnding(false), 4_000); return }
    done.current = true
    try {
      await terminalApi.close(id)
      setStatus('ended')
      toast('Session ended. Its transcript is still in Sessions.')
    } catch (e) {
      toast((e as Error).message)
    }
  }

  const repo = info?.repo ?? session?.project ?? null
  const title = session?.title ?? 'Session'
  const branch = session?.branch ?? null

  return (
    <div
      className="flex flex-col bg-ink-900"
      // The keyboard-aware height. `100dvh` is the fallback for anything that
      // does not publish a visual viewport.
      style={{ height: vh ? `${vh}px` : '100dvh' }}
    >
      <header className="shrink-0 flex items-center gap-2 h-12 px-2 sm:px-3 border-b border-edge pad-top">
        <button
          onClick={back}
          aria-label="Back"
          // `relative`, because `.hit` draws its 44px touch box absolutely and
          // an unpositioned host hands it to the nearest positioned ancestor —
          // which is how a small button acquires a page-sized target that eats
          // every tap on the route. See the note on `.hit` in styles.css.
          className="hit relative shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-control
                     text-fg-mute hover:text-fg hover:bg-raise transition-colors duration-100"
        >
          <ChevronLeft size={18} />
        </button>

        {/* The path, as chevrons. Two of the four are links, because "get back
            to the desk without guessing" is the requirement and a breadcrumb
            that is only decoration fails it. */}
        <nav className="min-w-0 flex items-center gap-1 text-sm">
          <Crumb onClick={() => navigate('/')}>Wake</Crumb>
          <ChevronRight size={13} className="shrink-0 text-fg-mute" />
          <Crumb onClick={() => navigate('/sessions')}>Sessions</Crumb>
          {repo && (
            <>
              <ChevronRight size={13} className="shrink-0 text-fg-mute" />
              <span className="shrink-0 text-fg-dim">{repo}</span>
            </>
          )}
          <ChevronRight size={13} className="shrink-0 text-fg-mute hidden sm:block" />
          <span className="hidden sm:block truncate text-fg" title={title}>{title}</span>
        </nav>

        <div className="ml-auto shrink-0 flex items-center gap-2">
          <Live status={status} />
          {status === 'ended' || status === 'gone' ? (
            <Button size="sm" variant="secondary" onClick={startFresh}>New session</Button>
          ) : (
            <Button
              size="sm"
              variant={ending ? 'danger' : 'ghost'}
              onClick={() => void end()}
              title="End the process. The transcript survives."
            >
              <Power size={13} />
              <span className="hidden sm:inline">{ending ? 'End it?' : 'End'}</span>
            </Button>
          )}
        </div>
      </header>

      {/* The one-time trust prompt, said before he meets it. Wake reads that
          flag out of ~/.claude.json and never writes it: answering whether a
          directory is trusted is his, and this terminal is real enough for him
          to answer it here. */}
      {info && !info.trusted && status !== 'gone' && (
        <p className="shrink-0 px-3 py-2 text-sm text-fg-dim bg-row-new border-b border-edge">
          Claude Code has not been told to trust <span className="text-fg">{info.cwd}</span> yet, so it
          will ask before it starts. Answer it below.
        </p>
      )}

      {error && (
        <p className="shrink-0 px-3 py-2 text-sm text-bad border-b border-edge">{error}</p>
      )}

      {status === 'gone' ? (
        <Gone id={id} session={session} onOpen={startFresh} />
      ) : (
        <>
          {/* Tapping the screen focuses xterm's own input. It has to happen
              inside the gesture: a phone opens its keyboard for a focus() that
              a tap caused and ignores one that arrives on its own. */}
          <div
            ref={host}
            onPointerDown={() => term.current?.focus()}
            className="min-h-0 flex-1 overflow-hidden px-1"
            style={{ background: THEME.background }}
          />

          {showKeys && <KeyBar onKey={type} onFocus={focusInput} font={font} setFont={setFont} />}
        </>
      )}
    </div>
  )
}

function Crumb({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="shrink-0 text-fg-mute hover:text-fg transition-colors duration-100"
    >
      {children}
    </button>
  )
}

/**
 * One dot and one word.
 *
 * Amber means something is waiting — that is the only thing amber means in this
 * product — so a healthy attached session is deliberately *not* amber. It is the
 * ok green when it is live, and the accent only while it is trying to get back.
 */
function Live({ status }: { status: Status }) {
  const [dot, word] = (
    {
      loading: ['bg-fg-mute', 'Opening'],
      connecting: ['bg-fg-mute', 'Attaching'],
      live: ['bg-ok', 'Live'],
      reconnecting: ['bg-accent', 'Reconnecting'],
      ended: ['bg-fg-mute', 'Ended'],
      gone: ['bg-fg-mute', 'Not running'],
    } as const
  )[status]
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-fg-mute">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className="hidden sm:inline">{word}</span>
    </span>
  )
}

/**
 * The keys a soft keyboard does not have.
 *
 * Every one of these is here because a Claude Code dialog needs it: Escape
 * cancels, the arrows move the selection, Enter takes it, Tab completes a path,
 * and Ctrl-C stops a run that is going the wrong way. The digits are not here —
 * a numbered menu is answered from the letter keyboard he already has.
 *
 * They are one row, scrollable sideways rather than wrapped, because a second
 * row of chrome costs the terminal two lines on the device with the fewest.
 */
function KeyBar({
  onKey, onFocus, font, setFont,
}: {
  onKey: (d: string) => void
  onFocus: () => void
  font: number
  setFont: (n: number) => void
}) {
  const keys: Array<[string, React.ReactNode, string]> = useMemo(() => [
    ['esc', 'esc', '\x1b'],
    ['tab', 'tab', '\t'],
    ['up', <ArrowUp key="u" size={14} />, '\x1b[A'],
    ['down', <ArrowDown key="d" size={14} />, '\x1b[B'],
    ['left', <ArrowLeft key="l" size={14} />, '\x1b[D'],
    ['right', <ArrowRight key="r" size={14} />, '\x1b[C'],
    ['enter', '⏎', '\r'],
    ['ctrlc', '^C', '\x03'],
  ], [])

  return (
    <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-t border-edge bg-ink-900 pad-bottom
                    overflow-x-auto">
      {keys.map(([id, label, seq]) => (
        <button
          key={id}
          // The press must not steal focus from xterm's textarea: losing it is
          // what closes the soft keyboard, and a bar that shuts the keyboard
          // every time you press Escape is a bar you cannot use.
          onPointerDown={e => { e.preventDefault(); onKey(seq) }}
          // `relative` for the same reason the back control carries it: an
          // unpositioned `.hit` host gives its 44px box to an ancestor, and a
          // key bar whose targets reach up the page would swallow every tap on
          // the terminal above it.
          className="hit relative shrink-0 min-w-10 h-9 px-2 inline-flex items-center justify-center
                     rounded-control border border-edge glass-raise text-sm text-fg-dim
                     active:bg-ink-700 transition-colors duration-75"
        >
          {label}
        </button>
      ))}

      <span className="ml-auto shrink-0 flex items-center gap-1">
        <SizeKey onPress={() => setFont(Math.max(FONT_MIN, font - 1))} disabled={font <= FONT_MIN}>
          <Minus size={13} />
        </SizeKey>
        <SizeKey onPress={() => setFont(Math.min(FONT_MAX, font + 1))} disabled={font >= FONT_MAX}>
          <Plus size={13} />
        </SizeKey>
        {/* The explicit way in, for when a tap on the screen did not raise the
            keyboard — which happens, and leaves no way to type at all. It sends
            nothing; it only asks for focus. */}
        <SizeKey onPress={onFocus}>
          <Keyboard size={14} />
        </SizeKey>
      </span>
    </div>
  )
}

function SizeKey({
  onPress, disabled, children,
}: { onPress: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      disabled={disabled}
      onPointerDown={e => { e.preventDefault(); onPress() }}
      className="hit relative shrink-0 w-9 h-9 inline-flex items-center justify-center rounded-control
                 border border-edge glass-raise text-fg-mute disabled:opacity-40
                 active:bg-ink-700 transition-colors duration-75"
    >
      {children}
    </button>
  )
}

/**
 * The session is not running.
 *
 * Reached two ways and it matters which: the process finished while the phone
 * was locked, or the link is old. Both end here, and both have the same one
 * answer — open it again, resuming *this* id, so the conversation continues
 * rather than restarting.
 */
function Gone({
  id, session, onOpen,
}: {
  id: string
  session: { title: string; cwd: string; project: string; branch: string | null } | null
  onOpen: () => void
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 pad-x text-center">
      <p className="text-sm text-fg-dim">
        {session
          ? <>This session is not running any more. Its transcript is still on this machine and is readable on the session page — but Claude Code will not continue a conversation whose process has gone, so the way on is a new one in the same repository.</>
          : <>There is no session <span className="tnum">{id.slice(0, 8)}</span> on this machine.</>}
      </p>
      {session && (
        <>
          <p className="text-sm text-fg-mute">
            {session.title} · {session.cwd}{session.branch ? ` · ${session.branch}` : ''}
          </p>
          <Button variant="primary" size="lg" onClick={onOpen}>Start a new session here</Button>
        </>
      )}
      <Button variant="ghost" onClick={() => navigate('/sessions')}>Back to Sessions</Button>
    </div>
  )
}

export default TerminalPage
