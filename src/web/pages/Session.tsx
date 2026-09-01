/**
 * One Claude Code session, as a conversation.
 *
 * This is the page the Sessions list exists to reach, and it is the correction
 * of what Wake used to do with a session on a phone. There were two answers
 * before this and both were wrong for the seven-in-the-morning case. One was a
 * `PeekSheet` — the same facts the row already carried, at sheet length, with
 * three icon buttons under them. The other was `/terminal/<id>`: a real VT
 * emulator, 346KB of bundle, 120 columns of tmux on a 375px screen, which is
 * the right tool for answering a permission prompt and the wrong one for
 * reading what you asked for and saying one more thing.
 *
 * So this page is a chat and deliberately not a terminal. There is no xterm on
 * it, no pty, no key bar, and it must not grow one — the terminal page is still
 * there and still owns that job. What is here is turns, a composer, and the
 * four things you might want to do about the session, and every one of those is
 * a phone control before it is a laptop one.
 *
 * Three decisions are worth the ink.
 *
 * **It polls; it does not stream.** An `EventSource` is the obvious shape and it
 * dies the moment the phone backgrounds the tab, which is what a phone does
 * every time you glance at something else — and it dies silently, so the page
 * comes back looking live and showing a conversation that stopped ten minutes
 * ago. `GET /sessions/:id/turns?after=<ts>` asked every few seconds while the
 * document is visible is a worse protocol and a better product.
 *
 * **The composer is gated on `active`, not on the id existing.** A transcript
 * with this name on disk is not a conversation you can add to: the id may name
 * a process that finished last week. That distinction is the entire bug this
 * pass exists to fix — Wake used to hand exactly such an id to `--resume` and
 * let Claude Code be the one to tell him, on his phone, that the session was
 * archived. When the answer is no, this page says so in the server's own words
 * and offers the only thing that actually works: a new session.
 *
 * **Nothing here is focused for you.** There is no `autoFocus` on the composer
 * and there must never be one. Arriving at this page is almost always arriving
 * to *read*, and a keyboard that opens itself takes half the screen and the
 * whole conversation with it. The keyboard opens when a thumb asks it to.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, Loader2, Plus, SendHorizontal, Trash2 } from 'lucide-react'
import { Button, Menu, Sheet } from '../components/primitives'
import { Mic } from '../components/voice'
import { DeleteSheet, rememberedRepo, sessionRoute } from '../components/sessions'
import {
  sessionApi, type OpenSession, type SessionStarting, type SessionTurn, type TurnWindow,
} from '../lib/api'
import {
  DEFAULT_SESSION_MODEL, PERMISSION_MODES, SESSION_MODELS, launchApi, openLaunch,
  type LaunchState, type PermissionMode, type SessionModel, type Session,
} from '../lib/launch'
import { navigate, setParam, useParam } from '../lib/route'
import { ago, wallClock } from '../lib/time'

/* --------------------------------- routing -------------------------------- */

const ROOT = '/sessions'

/**
 * `/sessions/<id>` and `/sessions/new`, parsed once.
 *
 * It lives beside the page rather than in `lib/route.ts` with `terminalIdOf`,
 * which is where the shape of every other Wake address is written down. That is
 * a deliberate exception and not an oversight: `route.ts` belongs to another
 * change this week, and one parser next to its only reader is a smaller risk
 * than two agents editing one file. If both land, this belongs there.
 *
 * `null` for the whole route means "not a session page" — `/sessions` itself is
 * the list and must keep falling through to the tab. `{ id: null }` is the
 * composer for a session that does not exist yet, which is a real destination
 * and the reason this returns a shape rather than a string.
 */
export function sessionRouteOf(path: string): { id: string | null } | null {
  if (!path.startsWith(`${ROOT}/`)) return null
  try {
    // A trailing slash is the same place, not a different one.
    const rest = decodeURIComponent(path.slice(ROOT.length + 1)).replace(/\/+$/, '')
    if (!rest || rest.includes('/')) return null
    return { id: rest === 'new' ? null : rest }
  } catch {
    return null
  }
}

/* ------------------------------- the page --------------------------------- */

/** How often the tail is asked for while the page is being looked at. */
const POLL_MS = 3_500

/**
 * Add to what is already in the composer instead of replacing it.
 *
 * Both callers — dictation and the context menu — used to be one-liners that
 * built a template string, and both got it subtly wrong in the same way:
 * appending to an empty field left a leading space or newline, which on a
 * transcript is a message that starts blank. One function, one rule, and the
 * separator is the caller's because a dictated phrase joins with a space and a
 * pasted path takes a line of its own.
 */
const append = (current: string, added: string, gap: string): string =>
  current.trim() ? `${current.trimEnd()}${gap}${added}` : added

/**
 * The height a phone can actually draw into, less the tab bar.
 *
 * `100dvh` accounts for the browser's own chrome and not for the soft keyboard,
 * so a `dvh` column puts its composer — the one control this page exists for —
 * underneath the keyboard that was opened in order to use it.
 * `visualViewport.height` is the number that moves when the keyboard does, and
 * it is read here rather than assumed because iOS never fires a `resize` on
 * `window` for it.
 *
 * `--nav-h` comes off the bottom because the tab bar stays. This page is a
 * destination inside the shell, not a takeover like the terminal: leaving a
 * conversation must not cost a Back gesture somebody has to know about.
 */
function useColumnHeight(): string {
  const [vv, setVv] = useState<number | null>(null)
  useEffect(() => {
    const v = window.visualViewport
    if (!v) return
    const on = () => setVv(v.height)
    on()
    v.addEventListener('resize', on)
    v.addEventListener('scroll', on)
    return () => { v.removeEventListener('resize', on); v.removeEventListener('scroll', on) }
  }, [])
  // The shell already spent the top safe area as `main`'s own padding, so it
  // comes off here too or the column runs exactly that far past the fold.
  const top = 'env(safe-area-inset-top, 0px)'
  return vv
    ? `calc(${vv}px - var(--nav-h) - ${top})`
    : `calc(100dvh - var(--nav-h) - ${top})`
}

export function SessionPage({ id }: { id: string | null }) {
  const height = useColumnHeight()

  /** What the machine can offer: repositories, the default mode, where a chat lives. */
  const [env, setEnv] = useState<LaunchState | null>(null)
  const [loaded, setLoaded] = useState<{ session: OpenSession; paths: string[] } | null>(null)
  const [turns, setTurns] = useState<SessionTurn[]>([])
  /**
   * Whether a message can be delivered at all.
   *
   * True for a session that has not been created yet, because the act that
   * would create it is the same act that starts the process — there is nothing
   * to be dead. For an existing one it is the server's answer and nothing else.
   */
  const [active, setActive] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  /**
   * Started, but holding a dialog open and therefore not on disk yet.
   *
   * Almost always the one-time "is this a project you trust?", which Claude Code
   * asks the first time it is pointed at a directory. It is the operator's
   * answer to give — Wake reads the flag and will not write it on his behalf —
   * so the page's job is to say where the question is, not to route around it.
   */
  const [starting, setStarting] = useState<SessionStarting | null>(null)
  /**
   * What the reader could see, so an empty page can say which empty it is.
   *
   * Measured on this machine: two of thirteen live sessions rendered a blank
   * conversation under a row claiming fourteen turns, because the whole window
   * the server read was `thinking`, `tool_use` and `tool_result` — the session
   * had been working without speaking for a quarter of a megabyte. The old
   * sentence for that was "Nothing has been said in this session yet", which is
   * the one thing it was not.
   */
  const [window_, setWindow] = useState<TurnWindow | null>(null)

  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  /** The server's own refusal sentence, rendered verbatim. See `sessionApi.send`. */
  const [refused, setRefused] = useState<string | null>(null)
  /**
   * What he has said that the transcript has not caught up with.
   *
   * Sending is a paste into tmux; the turn appears on disk when Claude Code
   * writes it, which is a second or two later. Without this the message
   * vanishes on Send and comes back from nowhere, which on a slow tunnel reads
   * as a send that failed.
   */
  const [pending, setPending] = useState<Array<{ text: string; ts: number }>>([])

  const askedRepo = useParam('repo')
  const [repo, setRepo] = useState<string | null>(null)
  const [mode, setMode] = useState<PermissionMode | null>(null)
  /**
   * Which model a *new* conversation starts on.
   *
   * Local state rather than the launch basket's remembered preference: this
   * composer is reached directly (`/sessions/new`) rather than through the
   * pack composer, and the two do not share a surface. It resets to `Default`
   * each time, which is the honest resting state — Wake has no opinion until
   * he expresses one, and a sticky model on a page he opens to start something
   * unrelated is a preference applying itself where it was not meant to.
   */
  const [model, setModel] = useState<SessionModel>(DEFAULT_SESSION_MODEL)
  const [sheet, setSheet] = useState<'menu' | 'delete' | null>(null)

  /* ------------------------------- reading ------------------------------- */

  useEffect(() => {
    let alive = true
    launchApi.state()
      .then(d => { if (alive) setEnv(d) })
      // The page still works without it: what is lost is the repository picker
      // and the mode control, both of which only a brand new session needs.
      .catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => {
    setLoaded(null)
    setTurns([])
    setPending([])
    setRefused(null)
    setErr(null)
    if (!id) {
      setActive(true)
      return
    }
    let alive = true
    sessionApi.get(id)
      .then(d => {
        if (!alive) return
        setLoaded({ session: d.session, paths: d.paths })
        setTurns(d.turns)
        setActive(d.session.active)
        setStarting(d.starting ?? null)
        setWindow(d.window ?? null)
      })
      .catch(e => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [id])

  /**
   * The timestamp the poll asks from, held in a ref rather than a dependency.
   *
   * As state it would tear the interval down and build a new one on every
   * arriving turn, which on a busy session means the timer never actually runs
   * to completion and the page updates only when something else re-renders it.
   */
  const after = useRef(0)
  useEffect(() => { after.current = turns.length ? turns[turns.length - 1]!.ts : 0 }, [turns])

  useEffect(() => {
    if (!id) return
    let alive = true

    const tick = async () => {
      if (document.hidden) return
      try {
        const d = await sessionApi.since(id, after.current)
        if (!alive) return
        setActive(d.active)
        // A session waiting on its trust dialog answers every poll this way
        // until he answers it, and then stops — so the notice clears itself
        // without the page having to be reopened.
        setStarting(d.starting ?? null)
        if (d.window) setWindow(d.window)
        if (!d.turns.length) return
        /*
         * Merged against what is actually held, not against what was asked for.
         *
         * `after.current` is written by an effect that runs when the turns
         * change, so on a cold open there is a window — the first read is slow,
         * the first poll fires at 3.5 seconds and asks from zero — where the
         * tail comes back in full and lands on top of the same turns the open
         * had just delivered. That is a conversation printed twice, and it
         * cannot be fixed by moving the write, because any race between two
         * requests can produce it. Comparing against the last turn in hand
         * makes the merge correct however the two answers happen to arrive.
         */
        setTurns(t => {
          const edge = t.length ? t[t.length - 1]!.ts : 0
          const fresh = d.turns.filter(x => x.ts > edge)
          return fresh.length ? [...t, ...fresh] : t
        })
        // Anything he said that has now arrived off the transcript stops being
        // his local copy. Matched on the text rather than on a timestamp: the
        // transcript's clock is the session's, not this browser's.
        const said = new Set(d.turns.filter(t => t.role === 'user').map(t => t.text.trim()))
        if (said.size) setPending(p => p.filter(x => !said.has(x.text.trim())))
      } catch {
        // A poll that fails is a tunnel that blipped. The next one is 3.5
        // seconds away and an error line for each would be a page of noise
        // about a condition that fixes itself.
      }
    }

    const timer = setInterval(() => void tick(), POLL_MS)
    // And immediately on coming back, because the first thing he does after
    // unlocking the phone is look at this page, not wait 3.5 seconds.
    const onShow = () => { if (!document.hidden) void tick() }
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('focus', onShow)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onShow)
      window.removeEventListener('focus', onShow)
    }
  }, [id])

  /* ------------------------- staying at the bottom ------------------------ */

  const scroller = useRef<HTMLDivElement | null>(null)
  /**
   * Whether the newest turn is what he is looking at.
   *
   * A conversation that jumps to the bottom while he is reading four turns up
   * is a conversation he cannot read. The threshold is generous — within one
   * short turn of the end counts as "at the end" — because a thumb rarely
   * lands a scroll exactly on the last pixel.
   */
  const stick = useRef(true)
  const onScroll = () => {
    const el = scroller.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [turns, pending])

  /* -------------------------------- writing ------------------------------- */

  const session = loaded?.session ?? null
  /**
   * Where a new session would start, in order of who has the better claim.
   *
   * An existing session's own directory is not a choice at all. Then what he
   * just picked, then what the link asked for, then the repository the list
   * remembers him working in — checked against the registry, because a memory
   * of a directory that is no longer a repository is a memory the server will
   * refuse. The registry's first entry is the last resort and the only guess.
   */
  const kept = useMemo(rememberedRepo, [])
  const fallback = env?.repos.find(r => r.path === kept)?.path ?? env?.repos[0]?.path ?? null
  const cwd = session?.cwd ?? repo ?? askedRepo ?? fallback
  const permission: PermissionMode =
    mode ?? (env?.defaultPermissionMode ?? 'bypassPermissions')

  /**
   * Two guards against one tap becoming two sessions, because neither is enough.
   *
   * `busy` is state, so two taps in the same tick both read `false` from the
   * same closure and both fire — which on a phone is not hypothetical: the
   * first tap shows nothing until tmux has answered, so the natural thing to do
   * is press it again. The ref closes that within this component.
   *
   * `sending` closes the rest of it. A reload mid-flight, a second tab, or a
   * request that timed out on a flaky tunnel and was retried are all outside
   * one component's memory, and the server used to answer each of them with a
   * fresh `randomUUID()` — a second Claude Code in the same repository, holding
   * the same first message. The id is minted once per outstanding send and the
   * server derives the session id from it, so every retry lands on one session.
   */
  const inFlight = useRef(false)
  const sending = useRef<string | null>(null)

  const send = useCallback(async () => {
    const body = text.trim()
    if (!body || busy || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setRefused(null)
    try {
      if (!id) {
        if (!cwd) { setRefused('Name a repository to start in.'); return }
        sending.current ??= crypto.randomUUID()
        const r = await sessionApi.create({
          repo: cwd, text: body, permissionMode: permission, model, clientId: sending.current,
        })
        setText('')
        sending.current = null
        // The session exists and is running by the time this resolves, so the
        // page it lands on is a live one rather than a hopeful one.
        navigate(sessionRoute(r.id))
      } else {
        await sessionApi.send(id, body)
        setText('')
        setPending(p => [...p, { text: body, ts: Date.now() }])
      }
    } catch (e) {
      // `sending.current` is deliberately kept: this send is the one being
      // retried, and a fresh id would make the retry a second session.
      setRefused((e as Error).message)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [text, busy, id, cwd, permission, model])

  /**
   * The composer grows with what is in it, up to about six lines.
   *
   * Reset to zero first: a textarea's `scrollHeight` includes whatever height
   * it currently has, so measuring without clearing it makes the box a
   * one-way ratchet that never shrinks after a delete.
   */
  const field = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 148)}px`
  }, [text])

  /* --------------------------------- what ------------------------------- */

  const title = session?.title ?? (id ? 'Session' : 'New session')
  const place = session?.project ?? (cwd ? cwd.split('/').pop() ?? cwd : null)
  const subtitle = [
    place,
    session?.branch ?? null,
    id ? (active ? 'live' : 'idle') : modeWord(permission),
  ].filter(Boolean).join(' · ')

  const shown = useMemo(
    () => [...turns, ...pending.map(p => ({ role: 'user' as const, text: p.text, ts: p.ts, tools: [] }))],
    [turns, pending],
  )

  /** Put a fact into the message rather than into a menu he has to remember. */
  const addContext = (pick: string) => {
    if (pick === 'brief' && session) return briefFor(session)
    const value = pick === 'repo' ? session?.cwd ?? cwd : session?.branch ?? null
    if (value) setText(t => append(t, value, '\n'))
  }

  const contextItems = [
    { id: 'repo', label: 'Repository path', meta: place ?? '' },
    ...(session?.branch ? [{ id: 'branch', label: 'Branch', meta: session.branch }] : []),
    ...(session ? [{ id: 'brief', label: 'Write a brief instead', meta: '' }] : []),
  ]

  return (
    <div className="flex flex-col" style={{ height }}>
      {/* `.glass-bar`: a strip pinned above a scrolling region, with the
          transcript passing under its bottom edge — which is the condition the
          thin blurred weight exists for, whether the pinning is `sticky` or, as
          here, a `shrink-0` flex sibling of the scrollport. `bleed-x` so the
          strip reaches the page edges: 16px of un-tinted gutter either side of a
          glass bar is the tell that it is painted on rather than in front. */}
      <header className="shrink-0 bleed-x glass-bar">
        <div className="flex items-center gap-2 h-11">
          <button
            onClick={() => navigate(ROOT)}
            // `relative`, because `.hit` draws its 44px touch box absolutely and
            // an unpositioned host hands it to the nearest positioned ancestor —
            // which is how a small button acquires a page-sized target that eats
            // every tap on the route.
            className="hit relative shrink-0 inline-flex items-center gap-1 h-8 -ml-1 px-1 rounded-control
                       text-sm text-fg-mute hover:text-fg hover:bg-raise transition-colors duration-100"
          >
            <ChevronLeft size={16} />
            Sessions
          </button>
          <span className="min-w-0 grow truncate text-md font-medium" title={title}>{title}</span>
          {/*
            The overflow, with a name instead of a glyph.

            Four things live behind this — the permission mode, the hatch to
            the Claude app, the facts, and Delete — and every one of them is
            genuinely secondary: you can hold a whole conversation without
            touching any. So they are behind one control. What that control may
            not be is a bare ellipsis, which this codebase bans outright and is
            right to: the overflow menu it stands for is where controls go to be
            forgotten, and an anonymous glyph on a phone is a lozenge you have
            to tap to find out what it does.

            `Details` and not `More`, which is the same anonymity spelled in
            letters — it is the word two other surfaces in this product had
            their overflow controls removed for. This one names the biggest
            thing in the sheet it opens, which is what a person is looking for
            when they reach up here.
          */}
          <Button
            variant="ghost"
            onClick={() => setSheet('menu')}
            ariaLabel="Details and actions for this session"
          >
            Details
          </Button>
        </div>
        {subtitle && (
          <p className="pb-2 text-sm text-fg-mute truncate border-b border-rule">{subtitle}</p>
        )}
      </header>

      {/* The conversation. Newest at the bottom, against the composer, which is
          where a thumb already is and where every chat surface he uses puts it. */}
      <div
        ref={scroller}
        onScroll={onScroll}
        className="grow min-h-0 overflow-y-auto overscroll-contain py-3"
      >
        {err && <p className="text-sm text-bad">{err}</p>}

        {/*
          The session exists and is waiting on him, and this is the sentence
          that says so.

          Without it this page read `no such session on this machine` under a
          subtitle that said `live` — measured, on a repository Claude Code had
          never been pointed at before. Both halves were wrong in different
          directions, and the fix is not to hide the state but to name it and
          say where the question is. Wake will not answer a trust prompt on his
          behalf; that is the whole of #39's last paragraph.
        */}
        {!err && starting && (
          <div>
            <p className="text-sm text-fg-dim">
              {starting.trusted
                ? 'The session is starting. The first turn will appear here.'
                : `Claude Code is asking whether it can trust ${loaded?.session.project ?? 'this repository'}. It is waiting in the terminal, and this conversation starts as soon as you answer.`}
            </p>
            {!starting.trusted && (
              <Button
                variant="secondary"
                className="mt-3"
                onClick={() => navigate(starting.route)}
              >
                Answer it in the terminal
              </Button>
            )}
          </div>
        )}

        {!err && !starting && !shown.length && (
          id
            ? <Quiet window={window_} active={active} />
            : (
              /*
                No greeting, and no "How can I help?".

                A fabricated first message is a lie about who has spoken — it
                makes the transcript start with a turn nobody took. What an
                empty composer needs is the three facts that decide what
                happens when he types: where it will run, what it may do
                without asking, and what else can be attached.
              */
              <div className="flex flex-wrap items-center gap-2">
                <Menu
                  items={(env?.repos ?? []).map(r => ({ id: r.path, label: r.name, meta: r.branch ?? '' }))}
                  value={cwd}
                  onPick={p => { setRepo(p); setParam('repo', p) }}
                  label="Repository"
                  placeholder="Choose one"
                  ariaLabel="Repository"
                />
                <Menu
                  items={PERMISSION_MODES.map(m => ({ id: m.id, label: m.label }))}
                  value={permission}
                  onPick={m => setMode(m)}
                  label="Permission"
                  ariaLabel="Permission mode"
                />
                {/*
                  Only while starting one. A conversation that is already
                  running was started on a model and cannot be moved to
                  another, so the control would do nothing but imply it could
                  — the same rule the permission sentence keeps further down.
                */}
                {!id && (
                  <Menu
                    items={SESSION_MODELS.map(m => ({ id: m.id, label: m.label }))}
                    value={model}
                    onPick={m => setModel(m)}
                    label="Model"
                    ariaLabel="Model"
                  />
                )}
                <Menu
                  items={contextItems}
                  value={null}
                  onPick={addContext}
                  ariaLabel="Add context"
                  trigger={({ toggle }) => (
                    <Button variant="ghost" onClick={toggle}>
                      <Plus size={14} /> Context
                    </Button>
                  )}
                />
              </div>
            )
        )}

        <div className="flex flex-col gap-3">
          {shown.map(t => <Turn key={`${t.role}:${t.ts}:${t.text.length}`} turn={t} />)}
          <Working window={window_} active={active} />
        </div>
      </div>

      {/* ------------------------------ composer ----------------------------- */}

      {/* No composer at all when the read failed. The only way to get here is a
          404 — an id that names nothing on this machine, usually a link from
          before a delete — and a field offering to send a message to it would
          be a control that cannot work, under an error saying so. */}
      {!err && (
      /* The composer is chrome the conversation scrolls under, and it is the
         one strip on this page a thumb lives on. Same weight as the sheet
         footer and the tab bar. */
      <div className="shrink-0 pt-2 pb-3 bleed-x glass-bar border-t border-edge">
        {refused && <p className="pb-2 text-sm text-bad leading-snug">{refused}</p>}

        {id && !active && starting ? (
          /*
            Not running *yet*, which is the opposite of the case below it.

            Both are `active: false` and they must not share a sentence. This
            page shipped for one deploy saying `This session is not running any
            more` under a notice explaining that it was starting — two
            statements about the same session, one of them wrong, three lines
            apart. A session waiting on its trust dialog has nothing to read and
            nothing to retry; the notice above already says where the question
            is, so this only has to not contradict it.
          */
          <p className="text-sm text-fg-mute leading-snug">
            {starting.trusted
              ? 'Starting — the composer opens when the session does.'
              : 'The composer opens once you have answered the prompt in the terminal.'}
          </p>
        ) : id && !active ? (
          /*
            The one refusal that is a state rather than an event.

            It is not an error and it is not something to retry: the process
            that was holding this transcript open has finished. Saying so where
            the composer would have been — rather than letting him type a
            paragraph and then rejecting it — is the difference between a
            product that knows what it can do and one that finds out.
          */
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 grow text-sm text-fg-mute leading-snug">
              This session is not running any more, so Wake cannot type into it. What was said is
              still here to read.
            </p>
            <Button
              variant="primary"
              size="lg"
              onClick={() => { navigate(`${ROOT}/new`); if (session) setParam('repo', session.cwd) }}
            >
              Start a new session
            </Button>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <Menu
              items={contextItems}
              value={null}
              onPick={addContext}
              ariaLabel="Add context"
              trigger={({ toggle }) => (
                <button
                  onClick={toggle}
                  aria-label="Add context"
                  title="Add context"
                  className="hit relative shrink-0 inline-flex items-center justify-center h-11 w-9
                             rounded-control text-fg-mute hover:text-fg hover:bg-raise
                             transition-colors duration-100"
                >
                  <Plus size={18} />
                </button>
              )}
            />

            <div className="grow min-w-0 flex items-end gap-1 rounded-control border border-edge glass-well px-2">
              <textarea
                ref={field}
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => {
                  // Enter sends and Shift+Enter breaks the line, which is what
                  // every chat surface he uses does. `isComposing` is not
                  // optional: an IME candidate is confirmed with Enter, and
                  // without the guard the half-typed word is sent instead.
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  void send()
                }}
                rows={1}
                placeholder={id ? 'Reply' : 'What do you want to start?'}
                spellCheck={false}
                className="grow min-w-0 resize-none bg-transparent py-2.5 text-base text-fg
                           leading-[1.5] placeholder:text-fg-mute outline-none"
              />
              {/* Dictation writes into the field and stops there. Nothing about
                  a transcript arriving is a decision to send it.

                  The wrapper carries the bottom margin because `Mic` paints a
                  26px box and the field beside it is 40px tall: aligned on
                  `items-end` without it, the glyph sits on the composer's floor
                  rather than on the line of text it is dictating into. */}
              <div className="shrink-0 mb-1.5">
                <Mic onText={said => setText(v => append(v, said, ' '))} />
              </div>
            </div>

            {/*
              44px, and the one control on this page that commits.

              `lg` is 40px painted with `.hit` taking the target to 44 on a
              coarse pointer, which is the rule the whole product keeps — a
              hand-set 44px box here would be the second answer to a question
              that already has one.
            */}
            <Button
              size="lg"
              variant="primary"
              disabled={busy || !text.trim()}
              onClick={() => void send()}
              ariaLabel="Send"
              title="Send"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <SendHorizontal size={16} />}
            </Button>
          </div>
        )}
      </div>
      )}

      <SessionSheet
        open={sheet === 'menu'}
        onClose={() => setSheet(null)}
        session={session}
        paths={loaded?.paths ?? []}
        active={active}
        permission={permission}
        onPermission={setMode}
        chatUrl={env?.handoff.url ?? null}
        onDelete={() => setSheet('delete')}
      />

      <DeleteSheet
        session={sheet === 'delete' ? session : null}
        onClose={() => setSheet(null)}
        // The files are gone, so the page standing over them has to go too.
        onDone={() => { setSheet(null); navigate(ROOT) }}
      />
    </div>
  )
}

/**
 * What it is doing right now, under the last thing it said.
 *
 * One line that gets replaced rather than a turn that gets appended, and the
 * difference is the whole of it. Tool calls made since the last sentence used to
 * be dropped on the floor, so a page watching a session work showed nothing
 * moving for minutes at a time; the first attempt at fixing that pushed them in
 * as a turn with no text, and because the poll asks `?after=<last turn ts>` and
 * appends, a page left open accumulated a fresh chip every 3.5 seconds. State
 * belongs at the bottom, once, and it disappears the moment the session speaks.
 *
 * `active` gates it because a finished session's trailing tools are not
 * something it is still doing — they are the last thing it did before it
 * stopped, and a spinner over them would be the page inventing a live process.
 */
function Working({ window: w, active }: { window: TurnWindow | null; active: boolean }) {
  const [open, setOpen] = useState(false)
  const names = w?.pending ?? []
  if (!active || !names.length) return null
  return (
    <div className="flex justify-start">
      <button
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="hit relative inline-flex items-start gap-2 max-w-[80%] min-w-0 text-left
                   text-sm text-fg-mute hover:text-fg-dim transition-colors duration-100"
      >
        <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" aria-hidden />
        <span className="min-w-0">
          {open
            ? <span className="font-mono break-words">{names.join(' · ')}</span>
            : `Working — ${names.length} tool${names.length === 1 ? '' : 's'} since it last said anything`}
        </span>
      </button>
    </div>
  )
}

/**
 * An empty conversation, saying which kind of empty it is.
 *
 * There are three and they used to share a sentence. A session that has never
 * answered has nothing to show; a session whose whole read window was tool work
 * has plenty going on and nothing said in it; and a session that is finished and
 * quiet is simply over. "Nothing has been said in this session yet" was true of
 * the first and a lie about the second, which is the one it was most often shown
 * for — measured on two of the thirteen sessions live on this box, both of which
 * rendered a blank page under a row claiming double-figure turns.
 *
 * The numbers are in it because they are the answer to the next question. "90
 * records and 38 tool calls in the last 256 KB of 1.3 MB" says both that the
 * session is busy and that the conversation is further back than the reader
 * went, which is a thing to know before concluding anything.
 */
function Quiet({ window: w, active }: { window: TurnWindow | null; active: boolean }) {
  if (w && w.records > 0) {
    const kb = (n: number) => `${Math.round(n / 1024).toLocaleString()} KB`
    return (
      <p className="text-sm text-fg-mute leading-relaxed">
        {active ? 'This session is working.' : 'Nothing was said in the part of this conversation Wake read.'}{' '}
        The last {kb(w.bytes)} of {kb(w.ofBytes)} holds {w.records} record{w.records === 1 ? '' : 's'}
        {w.tools > 0 && ` and ${w.tools} tool call${w.tools === 1 ? '' : 's'}`}, and no message.
        {w.ofBytes > w.bytes && ' Whatever was last said is further back than that.'}
      </p>
    )
  }
  return <p className="text-sm text-fg-mute">Nothing has been said in this session yet.</p>
}

/* --------------------------------- a turn --------------------------------- */

/**
 * One turn, as a message rather than as a log line.
 *
 * His on the right in an `ink-800` bubble, Claude's on the left with no bubble
 * at all — the page's own ground is the surface Claude speaks on, which is what
 * keeps a long answer from being a long grey slab. Both are body text at
 * `--text-base` with a 1.7 line height, and neither is monospace. That is the
 * single biggest thing separating this page from the terminal it replaces: a
 * transcript set in a monospace font is a log, whatever it says, and this is a
 * conversation.
 *
 * Monospace survives in exactly two places, both inside `Prose`: a fenced block
 * and a backticked span. Those are code and paths, where the character grid is
 * carrying meaning.
 *
 * `max-w-[80%]` on both sides. A message that runs the full width of a 1440px
 * laptop has no shape, and the ragged right edge is most of how you tell at a
 * glance who said what.
 */
function Turn({ turn }: { turn: SessionTurn }) {
  const mine = turn.role === 'user'
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      {/* Mine is a raised pane; Claude's is the page. The asymmetry is the
          point and it is unchanged — a long answer in a bubble is a long grey
          slab — but the bubble itself is now a piece of the material rather
          than a rectangle of `ink-800`, which is the row-hover token and made
          every message I sent look like a row somebody was pointing at. */}
      <div className={`max-w-[80%] min-w-0 ${mine ? 'glass-raise rounded-panel px-3 py-2' : ''}`}>
        <div className={`text-base leading-[1.7] ${mine ? 'text-fg' : 'text-fg-dim'}`}>
          <Prose text={turn.text} />
        </div>
        <Tools names={turn.tools} />
      </div>
    </div>
  )
}

/**
 * The tools a turn reached for, as one chip.
 *
 * Claude Code runs eight of these in a turn without thinking about it, and
 * printing eight names is a wall of machine vocabulary between two sentences a
 * person wrote. The count is the fact worth having at reading speed — something
 * happened, this much of it — and the names are one tap away for the times the
 * answer is "which file did it read".
 */
function Tools({ names }: { names: string[] }) {
  const [open, setOpen] = useState(false)
  if (!names.length) return null

  if (open) {
    return (
      <span className="mt-1 block text-xs text-fg-mute font-mono break-words">
        {names.join(' · ')}
      </span>
    )
  }
  return (
    <button
      onClick={() => setOpen(true)}
      className="hit relative mt-1 inline-flex items-center h-6 px-2 rounded-chip
                 glass-raise border border-edge text-xs text-fg-mute
                 hover:text-fg-dim hover:brightness-125 transition-colors duration-100"
    >
      {names.length} tool{names.length === 1 ? '' : 's'}
    </button>
  )
}

/**
 * A turn's text, with its code left as code.
 *
 * Deliberately not a markdown renderer. Two constructs carry meaning that a
 * proportional font destroys — a fenced block and a backticked span — and every
 * other piece of markdown in a transcript reads perfectly well as the
 * characters it is. A full renderer here would mean bold, links and lists
 * arriving on a surface whose whole point is that it is quiet, and it would
 * mean parsing untrusted text into elements, which is a much larger promise
 * than this page needs to make.
 */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split('```').map((block, i) => (
        i % 2
          ? (
            <pre key={i} className="my-2 overflow-x-auto rounded-control glass-well p-2
                                    font-mono text-sm text-fg-dim">
              {block.replace(/^[\w-]*\n/, '')}
            </pre>
          )
          : <span key={i} className="whitespace-pre-wrap break-words">{inlineCode(block)}</span>
      ))}
    </>
  )
}

const inlineCode = (s: string) =>
  s.split(/(`[^`\n]+`)/).map((part, i) =>
    part.length > 2 && part.startsWith('`') && part.endsWith('`')
      ? <code key={i} className="font-mono text-sm text-fg">{part.slice(1, -1)}</code>
      : <span key={i}>{part}</span>,
  )

/* ------------------------------- the overflow ------------------------------ */

/**
 * Everything about this session that is not the conversation.
 *
 * One sheet rather than a menu that opens more menus. On a phone a stack of
 * menus is a stack of things to dismiss, and three of the four things here are
 * not a single tap anyway — the permission mode is a choice, the details are a
 * list to read, and the delete is a dialog of its own.
 */
function SessionSheet({
  open, onClose, session, paths, active, permission, onPermission, chatUrl, onDelete,
}: {
  open: boolean
  onClose: () => void
  session: OpenSession | null
  paths: string[]
  active: boolean
  permission: PermissionMode
  onPermission: (m: PermissionMode) => void
  /** Where a *new* chat lives, straight off `/state`. Never built here. */
  chatUrl: string | null
  onDelete: () => void
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={session?.title ?? 'Session'}
      footer={(
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="lg" onClick={onClose}>Done</Button>
          <Button
            variant="ghost"
            size="lg"
            className="ml-auto"
            disabled={!session}
            onClick={() => { onClose(); onDelete() }}
          >
            <Trash2 size={14} /> Delete
          </Button>
        </div>
      )}
    >
      <div>
        <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Permission</h3>
        {session ? (
          <p className="text-sm text-fg-mute leading-snug">
            {session.permissionMode
              ? <>Started under <span className="text-fg-dim">{modeWord(session.permissionMode)}</span>. A
                  running session keeps the mode it was started with — Claude Code reads that flag
                  once, at launch, so changing it here would be a control that lies.</>
              : <>This session did not record which permission mode it was started under.</>}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {PERMISSION_MODES.map(m => (
              <Button
                key={m.id}
                variant={permission === m.id ? 'secondary' : 'ghost'}
                onClick={() => onPermission(m.id)}
              >
                {m.label}
              </Button>
            ))}
          </div>
        )}

        {/*
          The hatch, and it has to be a real anchor.

          `https://claude.ai/…` is a universal link on iOS: a genuine link
          navigation hands it to the Claude app, and a `window.open` after an
          await lands in Safari instead — which is a different product with none
          of his conversations in it. So this is an `<a>`, always, and nothing
          here may turn it into an onClick.

          The URL comes off `/state` rather than being written down here. That
          keeps the one place this product knows where a chat lives in the
          server's environment, where it is already configurable — and it keeps
          the literal out of the browser bundle, which a contract test enforces
          for the good reason that it was once how every hand-off worked.

          It is labelled as a new conversation because that is what it opens.
          The Claude app cannot resume a Claude Code session — no URL reaches
          one — so naming this session's id on the link would be a promise the
          destination cannot keep, which is exactly the failure this whole pass
          exists to stop.
        */}
        {chatUrl && (
          <>
            <h3 className="text-eyebrow uppercase text-fg-mute mt-4 mb-2">Elsewhere</h3>
            <a
              href={chatUrl}
              target="_blank"
              rel="noreferrer"
              className="hit relative flex items-center justify-between gap-3 h-11 px-2 -mx-2
                         rounded-control text-sm text-fg-dim
                         hover:text-fg hover:bg-raise transition-colors duration-100"
            >
              New chat in the Claude app
              <span className="shrink-0 text-fg-mute">not this session</span>
            </a>
          </>
        )}

        {session && (
          <>
            <h3 className="text-eyebrow uppercase text-fg-mute mt-4 mb-2">This session</h3>
            <Fact label="Repository" mono>{session.cwd}</Fact>
            {session.branch && <Fact label="Branch" mono>{session.branch}</Fact>}
            <Fact label="Running">{active ? 'on this machine right now' : 'not any more'}</Fact>
            <Fact label="Started">{wallClock(session.startedAt)}</Fact>
            <Fact label="Last active">{ago(session.lastTs)}</Fact>
            {session.version && <Fact label="Claude Code" mono>{session.version}</Fact>}
            <Fact label="Session" mono>{session.id}</Fact>
            {session.pr && (
              <Fact label="Pull request">
                <a href={session.pr.url} target="_blank" rel="noreferrer"
                  className="text-accent-ink hover:underline">
                  {session.pr.repo}#{session.pr.number}
                </a>
              </Fact>
            )}
            {/* Named here because they are what Delete removes, and a person is
                entitled to see that before the dialog rather than only inside
                it. Four paths under `~/.claude`, one of which is the edit-undo
                history for real source files. */}
            {!!paths.length && (
              <Fact label="On disk" wrap mono>{paths.join('\n')}</Fact>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}

/**
 * A labelled fact, on the row grid the rest of the product reads at.
 *
 * `wrap` is for the one fact here that is a list rather than a value.
 * Truncation is right for a path and a branch — they are long because they are
 * precise — and wrong for four of them stacked, where the second half is the
 * part that differs.
 */
function Fact({
  label, mono, wrap, children,
}: { label: string; mono?: boolean; wrap?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-2 border-b border-rule last:border-0">
      <span className="text-sm text-fg-mute w-24 shrink-0">{label}</span>
      <span className={`text-sm text-fg-dim min-w-0 ${wrap ? 'whitespace-pre-wrap break-words' : 'truncate'}
                        ${mono ? 'font-mono' : ''}`}>
        {children}
      </span>
    </div>
  )
}

/**
 * The launch sheet's word for a permission mode, or the raw enum.
 *
 * `Mode  bypassPermissions` printed a `--permission-mode` value at a reader who
 * is offered the same two values as `Bypass permissions` and `Accept edits`
 * four taps away. One product, one word — so the words come from that control's
 * own list rather than from a second copy of it here. `plan` and `default` are
 * the two Claude Code modes a brief never offers and a transcript can still
 * record; anything past those four is printed verbatim, because inventing a
 * title-cased phrase for a mode this build has never heard of is a guess
 * wearing prose.
 */
const EXTRA_MODES: Record<string, string> = { plan: 'Plan', default: 'Ask before acting' }
const modeWord = (m: string): string =>
  PERMISSION_MODES.find(x => x.id === m)?.label ?? EXTRA_MODES[m] ?? m

/**
 * Hand this session to the brief composer, with what the brief needs to resume it.
 *
 * The other half of `+`. This composer takes plain text; that one takes objects
 * — a card, a thread, a task, a skill — and packs them into a document that is
 * reviewed before it goes. Offering it from here is what keeps the two from
 * being rival ways of saying the same thing: one is a message, the other is a
 * brief.
 */
function briefFor(s: Session): void {
  openLaunch(
    [{
      kind: 'session',
      ref: `session:${s.id}`,
      title: s.title,
      excerpt: s.lastPrompt,
      why: 'work already underway on my machine',
      meta: {
        session_id: s.id,
        cwd: s.cwd,
        branch: s.branch ?? null,
        // `turns_in_view` and not `turns`. The reader of this key is a model
        // rather than a person, and the number is a floor read off the tail of
        // the transcript — the caveat rides the key name, which is the one
        // place a model will see it before treating it as a total.
        turns_in_view: s.turns,
      },
    }],
    { templates: ['continue-session'], repoHint: s.cwd, session: s.id, title: s.title },
  )
}

export default SessionPage
