/**
 * Mail.
 *
 * A list beside a thread on a laptop, one at a time on a phone. Full-bleed
 * rather than the 760px reading column, because this is a working surface.
 *
 * The rule that shapes the whole page: drafting is free, sending is not. The
 * composer will happily write anything; pressing Send opens a confirmation
 * showing the exact account, recipients, subject and body, backed by a token
 * bound to that text. Edit the body afterwards and the token stops matching, so
 * the old approval cannot carry the new message.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, ChevronDown, CornerUpLeft, CornerUpRight, Forward,
  Image as ImageIcon, Loader2, Mail as MailIcon, Paperclip, PenLine, RefreshCw,
  Search, Send, Terminal, X,
} from 'lucide-react'
import {
  displayName, mailApi, splitAddrs, useMailState,
  type Draft, type MailMessage, type MailState, type MailThread,
} from '../lib/mail'
import {
  Button, Chip, Empty, Field, PageTitle, Sheet, inputClass, rowStateClass, useRail,
} from '../components/primitives'
import { ago, timeOfDay } from '../lib/time'
import { openLaunch } from '../lib/launch'
import { registerPaletteActions } from '../components/palette'
import { Mic } from '../components/voice'
import { actions } from '../lib/api'
import { toast } from '../lib/toast'
import { setParam, useParam } from '../lib/route'

export function Mail() {
  const { state, error, reload } = useMailState()
  const [box, setBox] = useState('inbox')
  const [account, setAccount] = useState('all')
  const [q, setQ] = useState('')
  /**
   * The submitted query, plus the number of times it was submitted.
   *
   * The counter is what makes a second Enter on unchanged text do something:
   * without it, `setQuery(q)` on an identical string is a no-op React skips,
   * and a box whose own placeholder says "press enter" answers the second press
   * with nothing at all.
   */
  const [query, setQuery] = useState({ text: '', n: 0 })
  const [selected, setSelected] = useState<MailThread | null>(null)
  const [composing, setComposing] = useState<Partial<Draft> | null>(null)
  const rail = useRail<HTMLDivElement>()

  const list = useThreadList({ box, account, q: query.text, nonce: query.n })
  const listReload = list.reload

  // Enter in the search box, not on every keystroke: mail search is a network
  // round trip per account, and search-as-you-type would fire four of them per
  // word for results nobody reads.
  const submitSearch = () => setQuery(p => ({ text: q, n: p.n + 1 }))
  const clearSearch = () => { setQ(''); setQuery(p => ({ text: '', n: p.n + 1 })) }

  /**
   * `Compose mail` is a shell command now, because from Now — the one moment a
   * palette is worth having — a command registered by this page's own effect
   * does not exist yet. It arrives as `?compose=1`, which this consumes once.
   */
  const composeParam = useParam('compose')
  useEffect(() => {
    if (composeParam !== '1') return
    setComposing({})
    setParam('compose', null)
  }, [composeParam])

  useEffect(() =>
    registerPaletteActions(() => [
      { id: 'mail:refresh', label: 'Refresh mail', group: 'Mail', icon: <RefreshCw size={14} />, run: () => { void reload(true); listReload() } },
      ...(state?.boxes ?? []).map(b => ({
        id: `mail:box:${b.id}`,
        label: `Mail — ${b.label}`,
        group: 'Mail',
        icon: <MailIcon size={14} />,
        run: () => { setBox(b.id); setSelected(null) },
      })),
    ]), [state?.boxes, reload, listReload])

  if (error) return <div className="pad-x pt-4"><Empty>—</Empty></div>
  // Nothing until the first read lands.
  if (!state) return <div className="pad-x pt-4 flex items-center gap-3"><PageTitle>Mail</PageTitle></div>

  if (!state.connected) return <NotConnected state={state} onRetry={() => void reload(true)} />

  // The pane's resting state is the top thread, not an apology.
  const shown = selected ?? list.threads[0] ?? null

  return (
    /* Same metrics as Now: one page pad per column, the same pane width token,
       the same 44px rows, the same hairline. It used to carry three horizontal
       pads in one page — 20 on the header, 12 on the rows, 24 on the thread —
       after a negative margin that undid the shell's own. */
    <div className="sm:h-dvh sm:flex sm:gap-0 pb-20 sm:pb-0">
      {/* List */}
      <section className={`sm:w-90 2xl:w-100 sm:shrink-0 sm:border-r sm:border-edge
                           sm:overflow-y-auto ${selected ? 'hidden sm:block' : ''}`}>
        <header className="sticky top-0 z-10 bg-ink-900 border-b border-rule pad-x pt-4 pb-2">
          <div className="flex items-center gap-3">
            <PageTitle>Mail</PageTitle>
            {/* A count is a fact, and this one is not known for the first three
                or four seconds. Rendering `threads.length` unconditionally made
                the header assert a zero it had not measured. */}
            {list.answered && <span className="tnum text-sm text-fg-mute">{list.threads.length}</span>}
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="ghost" title="Refresh" ariaLabel="Refresh"
                onClick={() => { void reload(true); list.reload() }}>
                <RefreshCw size={14} className={list.loading ? 'animate-spin' : ''} />
              </Button>
              {/* The one commit on this surface. */}
              <Button size="md" variant="primary" onClick={() => setComposing({})}>
                <PenLine size={14} /> Write
              </Button>
            </div>
          </div>

          {/* No fill and no off-token radius: `bg-ink-850` is pure white in
              light mode, so this was a white box on a grey page. */}
          <div className="mt-2 flex items-center gap-2 h-8 border-b border-rule">
            <Search size={13} className="text-fg-mute shrink-0" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitSearch(); if (e.key === 'Escape') clearSearch() }}
              placeholder="Search"
              className="flex-1 bg-transparent outline-none text-sm text-fg placeholder:text-fg-mute"
            />
            {/* A bare glyph is a 14px target. `Button` paints the same 14px
                and carries the 44 underneath it. */}
            {q && (
              <Button size="sm" variant="ghost" onClick={clearSearch} title="Clear" ariaLabel="Clear">
                <X size={14} />
              </Button>
            )}
          </div>

          {/* `py-1.5` is not decoration: a rail clips its children's overflow,
              so without room for it inside the rail every chip's 44px touch box
              was cut back to the 32px the chip paints. And the rail fades at
              its right edge while there is more past it — six filters need
              384px inside 343, and `All mail` was simply sliced off by the
              screen edge with nothing to say the strip scrolls. */}
          <div className="rail mt-2" data-spill={rail.spill || undefined}>
            <div ref={rail.ref} className="flex gap-2 overflow-x-auto no-scrollbar py-1.5">
              {state.boxes.map(b => (
                <Chip key={b.id} active={box === b.id} onClick={() => { setBox(b.id); setSelected(null) }}>
                  {b.label}
                </Chip>
              ))}
              {state.accounts.length > 1 && (
                <>
                  <span className="w-px bg-ink-700 mx-1 shrink-0" />
                  <Chip active={account === 'all'} onClick={() => setAccount('all')}>All</Chip>
                  {state.accounts.map(a => (
                    <Chip key={a.address} active={account === a.address} onClick={() => setAccount(a.address)}>
                      {a.address.split('@')[0]}
                    </Chip>
                  ))}
                </>
              )}
            </div>
          </div>
        </header>

        <div className="pad-x">
          {list.errors.map(e => <BoxError key={e.account} account={e.account} error={e.error} />)}

          {list.threads.map(t => (
            <ThreadRow
              key={t.id}
              thread={t}
              active={selected?.id === t.id}
              multiAccount={state.accounts.length > 1}
              onOpen={() => setSelected(t)}
            />
          ))}

          {!list.answered && !list.threads.length && <ArrivingRows />}
          {list.answered && !list.threads.length && <Empty />}
          {list.hasMore && !list.loading && (
            <button onClick={list.more}
              className="w-full h-11 text-left text-sm text-fg-mute hover:text-fg-dim transition-colors">
              More
            </button>
          )}
        </div>
      </section>

      {/* Thread */}
      <section className={`grow sm:overflow-y-auto ${selected ? '' : 'hidden sm:block'}`}>
        {/* The first thread, pre-selected. A 720px column centring an
            instruction to choose one is an apology for a decision the page can
            make. */}
        {shown && (
          <ThreadView
            key={shown.id}
            thread={shown}
            onBack={() => setSelected(null)}
            onCompose={setComposing}
          />
        )}
      </section>

      <Composer
        draft={composing}
        state={state}
        onClose={() => setComposing(null)}
        onSent={() => { setComposing(null); list.reload() }}
      />
    </div>
  )
}

/**
 * A mailbox that would not load.
 *
 * The sentence says what happened; the transport's own words are one click
 * away. They used to be the whole message — an escaped JSON-RPC envelope,
 * status code and endpoint URL included, sitting in a mail list where the
 * threads should be. That detail is worth keeping (it is what makes a failure
 * diagnosable) and worth not leading with.
 */
/** One row, and the transport's own words on `title`. It was a sentence, a
 *  disclosure and an escaped JSON-RPC envelope where the threads should be. */
function BoxError({ account, error }: { account: string; error: string }) {
  return (
    <div className="flex items-center h-11 border-b border-rule min-w-0" title={error}>
      <span className="text-sm font-mono truncate grow min-w-0">{account}</span>
      <span className="text-sm text-fg-mute shrink-0 pl-3">didn't load</span>
    </div>
  )
}

/* --------------------------------- list ----------------------------------- */

function useThreadList(opts: { box: string; account: string; q: string; nonce: number }) {
  const [threads, setThreads] = useState<MailThread[]>([])
  const [cursors, setCursors] = useState<Record<string, string | null>>({})
  const [errors, setErrors] = useState<Array<{ account: string; error: string }>>([])
  const [loading, setLoading] = useState(true)
  /**
   * Whether this list has an answer yet — not whether it is idle.
   *
   * `GET /api/mail/threads` was measured at 2834–4742ms on the box, and for
   * every one of those milliseconds `threads` is `[]` because that is its
   * initial value. A header that counts it says `0`, and a column that maps it
   * paints nothing: the first thing the inbox told you was that there was no
   * mail in it, four seconds before it knew. Nothing may claim the empty case
   * until this is true.
   */
  const [answered, setAnswered] = useState(false)

  const load = useCallback(
    async (append: boolean, cursorsIn: Record<string, string | null>) => {
      setLoading(true)
      try {
        const r = await mailApi.threads({ box: opts.box, account: opts.account, q: opts.q, cursors: cursorsIn })
        setErrors(r.errors ?? [])
        setCursors(r.cursors ?? {})
        setThreads(prev => {
          if (!append) return r.threads
          // Two accounts advancing independently can re-deliver a row; keying by
          // id is what stops "load more" from duplicating the boundary thread.
          const seen = new Set(prev.map(t => t.id))
          return [...prev, ...r.threads.filter(t => !seen.has(t.id))]
        })
      } catch (e) {
        setErrors([{ account: 'mail', error: (e as Error).message }])
      } finally {
        setLoading(false)
        setAnswered(true)
      }
    },
    // `nonce` is deliberately a dependency it never reads: re-submitting the
    // same search has to re-run it, and identity of the query string alone
    // cannot express "again".
    [opts.box, opts.account, opts.q, opts.nonce],
  )

  // A new box or a new search is a new question, so its answer is unknown again
  // and the count goes back to saying nothing rather than saying zero.
  useEffect(() => {
    setAnswered(false)
    void load(false, {})
  }, [load])

  // `reload` is handed to the command palette, which holds it in an effect. A
  // fresh closure on every render would either capture a stale box — refreshing
  // the inbox while the reader is in Sent — or, if added to the effect's
  // dependencies, re-register on every render and loop. Stable, keyed on the
  // query it belongs to, is the only version that is both correct and finite.
  const reload = useCallback(() => void load(false, {}), [load])

  return {
    threads,
    errors,
    loading,
    answered,
    hasMore: Object.values(cursors).some(Boolean),
    more: () => void load(true, cursors),
    reload,
  }
}

/**
 * The rows that have been asked for and have not arrived.
 *
 * A mail list is the one surface in this product with a slow first read —
 * measured at 2834–4742ms on the box, against `/api/state`'s tens — and for that
 * whole time the column had nothing in it. An empty inbox and an inbox that has
 * not answered look identical, and the first one is a claim.
 *
 * So the shape arrives before the content: the same 44px row, the same hairline,
 * a bar where a name goes and a bar where a subject goes. No word, because a
 * word here would be chrome that teaches, and nothing that moves, because the
 * refresh glyph in the header is already spinning and a second animation on a
 * document that may never be painted is a frame this page would then wait on.
 */
function ArrivingRows() {
  const WIDTHS = ['w-1/2', 'w-3/4', 'w-2/3', 'w-1/2', 'w-3/5', 'w-3/4', 'w-2/5', 'w-2/3']
  return (
    <div aria-hidden>
      {WIDTHS.map((w, i) => (
        <div key={i} className="flex items-center gap-3 h-11 border-b border-rule">
          <span className="h-2 w-20 rounded-chip bg-rule shrink-0 opacity-60" />
          <span className={`h-2 rounded-chip bg-rule opacity-60 ${w}`} />
        </div>
      ))}
    </div>
  )
}

/**
 * One row treatment, shared with the desk and with Work.
 *
 * Two things were wrong here and they were the same thing. `active` and hover
 * were both `bg-ink-800`, so the thread the pane was actually showing was
 * indistinguishable from whichever one the pointer happened to be over — the
 * desk's bug, in the other list. And unread was told *twice* in type and not at
 * all in the row: the sender went `font-medium text-fg` and the subject went
 * `text-fg`, two marks for one fact, both of them a shade of grey you have to
 * compare two rows to see.
 *
 * `rowStateClass` answers both. Selection gets its own ground (`row-sel`, a
 * lightness above hover, so it stays lit while you read it) and unread gets the
 * warm full-row wash (`row-new`, a hue, because "this arrived" is not a degree
 * of "your pointer is here"). `active` is the helper's own synonym for
 * `selected`, so this page keeps its vocabulary.
 *
 * The type then stops carrying unread and carries hierarchy instead: subject,
 * sender, snippet, in that order, on every row. A read thread used to be two
 * lines of one dim grey; now the line you scan is the line you can read.
 */
function ThreadRow({
  thread, active, multiAccount, onOpen,
}: { thread: MailThread; active: boolean; multiAccount: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      aria-current={active ? 'true' : undefined}
      className={`w-full text-left py-2 border-b border-rule
        ${rowStateClass({ active, unseen: thread.unread })}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-fg-dim truncate">{displayName(thread.from)}</span>
        {thread.messageCount > 1 && <span className="tnum text-sm text-fg-mute">{thread.messageCount}</span>}
        <span className="ml-auto tnum text-sm text-fg-mute shrink-0">{ago(thread.ts)}</span>
      </div>
      <div className="mt-0.5 text-sm text-fg truncate">
        {thread.subject}
      </div>
      <div className="mt-0.5 text-sm text-fg-mute truncate">
        {thread.toMe && <span className="text-fg-dim">to you · </span>}
        {thread.snippet}
      </div>
      {multiAccount && <div className="mt-1 text-sm text-fg-mute truncate">{thread.account}</div>}
    </button>
  )
}

/* -------------------------------- thread ---------------------------------- */

function ThreadView({
  thread, onBack, onCompose,
}: {
  thread: MailThread
  onBack: () => void
  onCompose: (d: Partial<Draft>) => void
}) {
  const [messages, setMessages] = useState<MailMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [cached, setCached] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    mailApi
      .thread(thread.account, thread.threadId)
      .then(r => {
        if (!live) return
        setMessages(r.messages)
        setCached(r.cached)
        setErr(r.error ?? null)
      })
      .catch(e => live && setErr((e as Error).message))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [thread.id])

  const reply = async (mode: 'reply' | 'reply_all' | 'forward') => {
    try {
      onCompose(await mailApi.compose({ account: thread.account, threadId: thread.threadId, mode }))
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const excerpt = useMemo(
    () => messages.map(m => `${displayName(m.from)}: ${m.text.slice(0, 1_500)}`).join('\n\n---\n\n'),
    [messages],
  )

  return (
    <div className="pad-x pt-4 pb-16">
      <div className="flex items-start gap-2">
        <button onClick={onBack} className="sm:hidden p-2 -ml-2 text-fg-mute" title="Back">
          <ArrowLeft size={16} />
        </button>
        <div className="grow min-w-0">
          <h2 className="text-md leading-snug font-medium">{thread.subject}</h2>
          <p className="mt-1 text-sm text-fg-mute">
            {thread.account} · {messages.length || thread.messageCount} message{(messages.length || thread.messageCount) > 1 ? 's' : ''}
            {cached && ' · cached'}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="default" onClick={() => void reply('reply')}><CornerUpLeft size={13} /> Reply</Button>
        <Button variant="ghost" onClick={() => void reply('reply_all')}><CornerUpRight size={13} /> Reply all</Button>
        <Button variant="ghost" onClick={() => void reply('forward')}><Forward size={13} /> Forward</Button>
        <span className="grow" />
        <Button
          variant="ghost"
          title="Pack this thread and open it in Claude"
          onClick={() =>
            openLaunch(
              [{
                kind: 'mail',
                ref: `${thread.account}:${thread.threadId}`,
                title: thread.subject,
                excerpt,
                why: 'the thread this is about',
                meta: { account: thread.account, from: thread.from?.addr ?? null, messages: messages.length },
              }],
              { template: 'mail-thread', title: thread.subject },
            )
          }
        >
          <Terminal size={13} /> Open in Claude Code
        </Button>
      </div>

      {err && (
        <p className="mt-3 flex items-start gap-2 text-sm text-fg-mute leading-snug">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />{err}
        </p>
      )}
      

      <div className="mt-5">
        {messages.map((m, i) => (
          <MessageView key={m.id} message={m} expanded={i === messages.length - 1} />
        ))}
      </div>
    </div>
  )
}

function MessageView({ message, expanded }: { message: MailMessage; expanded: boolean }) {
  const [open, setOpen] = useState(expanded)
  const [showImages, setShowImages] = useState(false)
  const [showHtml, setShowHtml] = useState(!message.text && !!message.html)

  // Remote images stay unloaded until asked for: a tracking pixel reports that
  // you opened the mail, and from where.
  const html = useMemo(() => {
    if (!message.html) return null
    return showImages ? message.html.replace(/data-wake-src=/g, 'src=') : message.html
  }, [message.html, showImages])

  return (
    <article className="py-3 hairline last:border-0">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-baseline gap-2 text-left">
        <span className="text-sm text-fg truncate">{displayName(message.from)}</span>
        <span className="text-sm text-fg-mute truncate hidden sm:inline">
          to {message.to.map(displayName).join(', ') || 'you'}
        </span>
        <span className="ml-auto tnum text-sm text-fg-mute shrink-0">
          {message.ts ? timeOfDay(message.ts) : ''}
        </span>
        <ChevronDown size={13} className={`text-fg-mute transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-2">
          {message.attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {message.attachments.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-2 h-8 px-2 rounded-control bg-ink-800 text-sm text-fg-mute">
                  <Paperclip size={11} />
                  {a.filename}
                  {a.size ? <span className="tnum">{Math.round(a.size / 1024)}kb</span> : null}
                </span>
              ))}
              <span className="self-center text-sm text-fg-mute">
                metadata only — Wake does not download attachments
              </span>
            </div>
          )}

          {showHtml && html ? (
            <>
              {message.blockedImages > 0 && !showImages && (
                <button onClick={() => setShowImages(true)}
                  className="mb-2 inline-flex items-center gap-2 text-sm text-fg-mute hover:text-fg-dim transition-colors">
                  <ImageIcon size={12} />
                  Load {message.blockedImages} remote image{message.blockedImages > 1 ? 's' : ''}
                </button>
              )}
              {/* The HTML was sanitized to an allowlist server-side (mail/sanitize.ts):
                  scripts, styles, frames and event handlers are removed before it
                  is ever stored, and only a short list of tags survives. */}
              <div className="mail-body" dangerouslySetInnerHTML={{ __html: html }} />
            </>
          ) : (
            <pre className="text-sm leading-[1.65] text-fg-dim whitespace-pre-wrap font-sans break-words">
              {message.text || '(no text content)'}
            </pre>
          )}

          {message.html && message.text && (
            <button onClick={() => setShowHtml(v => !v)}
              className="mt-2 text-sm text-fg-mute hover:text-fg-dim transition-colors">
              {showHtml ? 'Show plain text' : 'Show formatted'}
            </button>
          )}
        </div>
      )}
    </article>
  )
}

/* -------------------------------- composer -------------------------------- */

function Composer({
  draft, state, onClose, onSent,
}: { draft: Partial<Draft> | null; state: MailState; onClose: () => void; onSent: () => void }) {
  const [account, setAccount] = useState('')
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [confirm, setConfirm] = useState<{ token: string; preview: any } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!draft) return
    setAccount(draft.account ?? state.accounts.find(a => a.connected)?.address ?? '')
    setTo((draft.to ?? []).join(', '))
    setCc((draft.cc ?? []).join(', '))
    setSubject(draft.subject ?? '')
    setBody(draft.body ?? '')
    setConfirm(null)
    setErr(null)
    setSent(null)
  }, [draft])

  // Any edit kills a standing confirmation. The server would refuse the stale
  // token anyway; dropping it here means the button says "Send" again rather
  // than failing after the click.
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    setConfirm(null)
    set(v)
  }

  const current = (): Draft => ({
    account,
    to: splitAddrs(to),
    cc: splitAddrs(cc),
    subject,
    body,
    threadId: draft?.threadId ?? null,
    inReplyTo: draft?.inReplyTo ?? null,
  })

  const ask = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await mailApi.confirm(current())
      setConfirm({ token: r.token, preview: r.preview })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (!confirm) return
    setBusy(true)
    setErr(null)
    try {
      await mailApi.send({ ...current(), token: confirm.token })
      setSent('Sent.')
      setTimeout(onSent, 900)
    } catch (e) {
      setErr((e as Error).message)
      setConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={!!draft}
      onClose={onClose}
      title={draft?.threadId ? 'Reply' : 'New message'}
      footer={
        sent ? (
          <p className="text-sm text-ok text-center py-1">{sent}</p>
        ) : confirm ? (
          <div className="space-y-2">
            <div className="border-b border-rule pb-3">
              <p className="text-sm text-fg-dim leading-relaxed">
                This will send from <strong className="text-fg">{confirm.preview.account}</strong> to{' '}
                <strong className="text-fg">{confirm.preview.to.join(', ')}</strong>
                {confirm.preview.cc?.length ? <> (cc {confirm.preview.cc.join(', ')})</> : null}.
              </p>
              <p className="text-sm text-fg-mute mt-2">
                Editing anything below cancels this approval.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" className="flex-1" onClick={send} disabled={busy}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send now
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(null)}>Back</Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" onClick={ask}
              disabled={busy || !state.canSend || !to.trim() || !subject.trim() || !body.trim()}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {state.canSend ? 'Review and send' : 'Sending unavailable'}
            </Button>
            {state.canDraft && (
              <Button variant="ghost" onClick={async () => {
                try { await mailApi.draft(current()); setSent('Saved as a draft.') }
                catch (e) { setErr((e as Error).message) }
              }}>
                Save draft
              </Button>
            )}
          </div>
        )
      }
    >
      {!state.canSend && (
        <p className="mb-3 flex items-start gap-2 text-sm text-fg-mute leading-relaxed">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          This Gmail connection exposes no send tool, so Wake can draft but cannot send. It advertised:{' '}
          {state.discovered.join(', ') || '(nothing)'}.
        </p>
      )}

      {state.accounts.length > 1 && (
        <Field label="From">
          <select value={account} onChange={e => edit(setAccount)(e.target.value)} className={inputClass}>
            {state.accounts.map(a => (
              <option key={a.address} value={a.address} disabled={!a.connected}>
                {a.address}{a.connected ? '' : ' (not connected)'}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="To">
        <input className={inputClass} value={to} onChange={e => edit(setTo)(e.target.value)}
          placeholder="someone@example.com, another@example.com" />
      </Field>
      <Field label="Cc">
        <input className={inputClass} value={cc} onChange={e => edit(setCc)(e.target.value)} placeholder="optional" />
      </Field>
      <Field label="Subject">
        <input className={inputClass} value={subject} onChange={e => edit(setSubject)(e.target.value)} />
      </Field>
      <Field label="Message">
        <div className="relative">
          <textarea
            ref={bodyRef}
            className={`${inputClass} min-h-[220px] resize-y pr-10 leading-relaxed`}
            value={body}
            onChange={e => edit(setBody)(e.target.value)}
          />
          <div className="absolute right-2 top-2">
            <Mic title="Dictate the message" onText={t => edit(setBody)(body ? `${body} ${t}` : t)} />
          </div>
        </div>
      </Field>

      {err && <p className="text-sm text-bad leading-snug">{err}</p>}
    </Sheet>
  )
}

/* ------------------------------ not connected ----------------------------- */

/**
 * Gmail, down.
 *
 * Two lines in the list column, on the same grid as everything else. What it
 * replaced was a whole page: a `text-lg` heading restating the source's name and
 * its state, a paragraph about claude.ai connectors, an amber `lg` primary
 * labelled Connect, a re-check button that repainted an identical screen with no
 * spinner and no timestamp, and a `<details>` holding two shell commands and a
 * paragraph of transport trivia — 590px of chrome inside a 720px reading column
 * on a full-bleed working surface, teaching a terminal command as the fix.
 *
 * There is no Connect button, because there is nothing to press:
 * `gmailmcp.googleapis.com` publishes no OAuth metadata, so Wake cannot build an
 * authorize URL and the button could only ever answer 400. The reason is on
 * `title` and the row in Settings is where a source is diagnosed.
 */
function NotConnected({ state }: { state: MailState; onRetry: () => void }) {
  return (
    <div className="pad-x pt-4 pb-24">
      <header className="pb-2 flex items-center gap-3">
        <PageTitle>Mail</PageTitle>
      </header>
      {state.accounts.map(a => (
        <div key={a.address} className="flex items-center h-11 border-b border-rule min-w-0">
          <span className="text-sm font-mono truncate grow min-w-0">{a.address}</span>
          <span className="text-sm text-fg-mute shrink-0 pl-3" title={state.reason ?? undefined}>
            not connected
          </span>
        </div>
      ))}
    </div>
  )
}
