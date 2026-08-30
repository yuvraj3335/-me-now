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
import { Button, Chip, Empty, Field, Sheet, inputClass } from '../components/primitives'
import { ago, timeOfDay } from '../lib/time'
import { openLaunch } from '../lib/launch'
import { registerPaletteActions } from '../components/palette'
import { Mic } from '../components/voice'

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

  const list = useThreadList({ box, account, q: query.text, nonce: query.n })
  const listReload = list.reload

  // Enter in the search box, not on every keystroke: mail search is a network
  // round trip per account, and search-as-you-type would fire four of them per
  // word for results nobody reads.
  const submitSearch = () => setQuery(p => ({ text: q, n: p.n + 1 }))
  const clearSearch = () => { setQ(''); setQuery(p => ({ text: '', n: p.n + 1 })) }

  useEffect(() =>
    registerPaletteActions(() => [
      { id: 'mail:compose', label: 'Compose mail', group: 'Mail', icon: <PenLine size={14} />, run: () => setComposing({}) },
      { id: 'mail:refresh', label: 'Refresh mail', group: 'Mail', icon: <RefreshCw size={14} />, run: () => { void reload(true); listReload() } },
      ...(state?.boxes ?? []).map(b => ({
        id: `mail:box:${b.id}`,
        label: `Mail — ${b.label}`,
        group: 'Mail',
        icon: <MailIcon size={14} />,
        run: () => { setBox(b.id); setSelected(null) },
      })),
    ]), [state?.boxes, reload, listReload])

  if (error) return <Empty>Mail is unavailable: {error}</Empty>
  if (!state) return <div className="pt-24"><Empty>Opening the mailbox…</Empty></div>

  if (!state.connected) return <NotConnected state={state} onRetry={() => void reload(true)} />

  return (
    <div className="sm:h-dvh sm:flex sm:gap-0 -mx-4 sm:-mx-6 pb-20 sm:pb-0">
      {/* List */}
      <section className={`sm:w-[360px] lg:w-[400px] xl:w-[440px] sm:shrink-0 sm:border-r sm:border-white/[0.06]
                           sm:overflow-y-auto ${selected ? 'hidden sm:block' : ''}`}>
        <header className="sticky top-0 z-10 bg-ink-900/92 backdrop-blur-xl px-4 sm:px-5 pt-4 pb-2">
          <div className="flex items-center gap-2">
            <h1 className="text-[19px] font-medium tracking-[-0.02em]">Mail</h1>
            <span className="tnum text-[12.5px] text-fg-mute">{list.threads.length}</span>
            <div className="ml-auto flex items-center gap-1">
              <button onClick={() => { void reload(true); list.reload() }}
                className="p-1.5 rounded-lg text-fg-mute hover:text-fg-dim hover:bg-ink-800 transition-colors" title="Refresh">
                <RefreshCw size={14} className={list.loading ? 'animate-spin' : ''} />
              </button>
              <Button variant="accent" onClick={() => setComposing({})}>
                <PenLine size={13} /> Write
              </Button>
            </div>
          </div>

          <div className="mt-2.5 flex items-center gap-2 px-2.5 h-8 rounded-[10px] bg-ink-850">
            <Search size={13} className="text-fg-mute shrink-0" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitSearch(); if (e.key === 'Escape') clearSearch() }}
              placeholder="Search mail — press enter"
              className="flex-1 bg-transparent outline-none text-[13px] text-fg placeholder:text-fg-mute"
            />
            {q && (
              <button onClick={clearSearch} className="text-fg-mute hover:text-fg-dim" title="Clear">
                <X size={12} />
              </button>
            )}
          </div>

          <div className="mt-2 flex gap-1 overflow-x-auto no-scrollbar pb-1">
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
        </header>

        <div className="px-2 sm:px-3">
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

          {!list.loading && !list.threads.length && (
            <Empty>{query.text ? 'Nothing matches that search.' : 'Nothing here.'}</Empty>
          )}
          {list.loading && <p className="text-[12.5px] text-fg-mute py-6 text-center">Loading…</p>}
          {list.hasMore && !list.loading && (
            <button onClick={list.more}
              className="w-full py-3 text-[12.5px] text-fg-mute hover:text-fg-dim transition-colors">
              Load more
            </button>
          )}
        </div>
      </section>

      {/* Thread */}
      <section className={`grow sm:overflow-y-auto ${selected ? '' : 'hidden sm:block'}`}>
        {selected ? (
          <ThreadView
            key={selected.id}
            thread={selected}
            onBack={() => setSelected(null)}
            onCompose={setComposing}
          />
        ) : (
          <div className="hidden sm:flex h-full items-center justify-center">
            <p className="text-[13px] text-fg-mute">Pick a thread.</p>
          </div>
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
function BoxError({ account, error }: { account: string; error: string }) {
  return (
    <div className="px-2 py-2">
      <p className="flex items-start gap-1.5 text-[12px] text-warn leading-snug">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>Wake couldn’t load this box for {account}.</span>
      </p>
      <details className="mt-1 ml-[18px]">
        <summary className="cursor-pointer list-none text-[11.5px] text-fg-mute hover:text-fg-dim transition-colors">
          What went wrong
        </summary>
        <p className="mt-1 text-[11.5px] font-mono text-fg-mute break-words leading-relaxed">{error}</p>
      </details>
    </div>
  )
}

/* --------------------------------- list ----------------------------------- */

function useThreadList(opts: { box: string; account: string; q: string; nonce: number }) {
  const [threads, setThreads] = useState<MailThread[]>([])
  const [cursors, setCursors] = useState<Record<string, string | null>>({})
  const [errors, setErrors] = useState<Array<{ account: string; error: string }>>([])
  const [loading, setLoading] = useState(true)

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
      }
    },
    // `nonce` is deliberately a dependency it never reads: re-submitting the
    // same search has to re-run it, and identity of the query string alone
    // cannot express "again".
    [opts.box, opts.account, opts.q, opts.nonce],
  )

  useEffect(() => { void load(false, {}) }, [load])

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
    hasMore: Object.values(cursors).some(Boolean),
    more: () => void load(true, cursors),
    reload,
  }
}

function ThreadRow({
  thread, active, multiAccount, onOpen,
}: { thread: MailThread; active: boolean; multiAccount: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors
        ${active ? 'bg-ink-800' : 'hover:bg-ink-850'}`}
    >
      <div className="flex items-baseline gap-2">
        {thread.unread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0 translate-y-[-1px]" />}
        <span className={`text-[13.5px] truncate ${thread.unread ? 'text-fg' : 'text-fg-dim'}`}>
          {displayName(thread.from)}
        </span>
        {thread.messageCount > 1 && <span className="tnum text-[11px] text-fg-mute">{thread.messageCount}</span>}
        <span className="ml-auto tnum text-[11.5px] text-fg-mute shrink-0">{ago(thread.ts)}</span>
      </div>
      <div className={`mt-0.5 text-[13px] truncate ${thread.unread ? 'text-fg' : 'text-fg-dim'}`}>
        {thread.subject}
      </div>
      <div className="mt-0.5 text-[12px] text-fg-mute truncate">{thread.snippet}</div>
      {(multiAccount || thread.toMe) && (
        <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-fg-mute">
          {thread.toMe && <span className="text-accent-ink/80">to you</span>}
          {multiAccount && <span className="truncate">{thread.account}</span>}
        </div>
      )}
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
    <div className="px-4 sm:px-6 pt-4 pb-16">
      <div className="flex items-start gap-2">
        <button onClick={onBack} className="sm:hidden p-2 -ml-2 text-fg-mute" title="Back">
          <ArrowLeft size={16} />
        </button>
        <div className="grow min-w-0">
          <h2 className="text-[18px] leading-snug tracking-[-0.015em] font-medium">{thread.subject}</h2>
          <p className="mt-1 text-[12.5px] text-fg-mute">
            {thread.account} · {messages.length || thread.messageCount} message{(messages.length || thread.messageCount) > 1 ? 's' : ''}
            {cached && ' · cached'}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button variant="solid" onClick={() => void reply('reply')}><CornerUpLeft size={13} /> Reply</Button>
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
        <p className="mt-3 flex items-start gap-1.5 text-[12.5px] text-warn leading-snug">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />{err}
        </p>
      )}
      {loading && <p className="mt-6 text-[12.5px] text-fg-mute">Reading the thread…</p>}

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
        <span className="text-[13.5px] text-fg truncate">{displayName(message.from)}</span>
        <span className="text-[11.5px] text-fg-mute truncate hidden sm:inline">
          to {message.to.map(displayName).join(', ') || 'you'}
        </span>
        <span className="ml-auto tnum text-[11.5px] text-fg-mute shrink-0">
          {message.ts ? timeOfDay(message.ts) : ''}
        </span>
        <ChevronDown size={13} className={`text-fg-mute transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-2.5">
          {message.attachments.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {message.attachments.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-ink-800 text-[11.5px] text-fg-mute">
                  <Paperclip size={11} />
                  {a.filename}
                  {a.size ? <span className="tnum">{Math.round(a.size / 1024)}kb</span> : null}
                </span>
              ))}
              <span className="self-center text-[11px] text-fg-mute">
                metadata only — Wake does not download attachments
              </span>
            </div>
          )}

          {showHtml && html ? (
            <>
              {message.blockedImages > 0 && !showImages && (
                <button onClick={() => setShowImages(true)}
                  className="mb-2 inline-flex items-center gap-1.5 text-[11.5px] text-fg-mute hover:text-fg-dim transition-colors">
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
            <pre className="text-[13.5px] leading-[1.65] text-fg-dim whitespace-pre-wrap font-sans break-words">
              {message.text || '(no text content)'}
            </pre>
          )}

          {message.html && message.text && (
            <button onClick={() => setShowHtml(v => !v)}
              className="mt-2 text-[11.5px] text-fg-mute hover:text-fg-dim transition-colors">
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
          <p className="text-[13px] text-ok text-center py-1">{sent}</p>
        ) : confirm ? (
          <div className="space-y-2">
            <div className="rounded-[10px] bg-warn/[0.06] border border-warn/30 p-3">
              <p className="text-[12px] text-fg-dim leading-relaxed">
                This will send from <strong className="text-fg">{confirm.preview.account}</strong> to{' '}
                <strong className="text-fg">{confirm.preview.to.join(', ')}</strong>
                {confirm.preview.cc?.length ? <> (cc {confirm.preview.cc.join(', ')})</> : null}.
              </p>
              <p className="text-[11.5px] text-fg-mute mt-1.5">
                Editing anything below cancels this approval.
              </p>
            </div>
            <div className="flex gap-1.5">
              <Button variant="accent" className="flex-1" onClick={send} disabled={busy}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send now
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(null)}>Back</Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <Button variant="accent" className="flex-1" onClick={ask}
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
        <p className="mb-3 flex items-start gap-1.5 text-[12.5px] text-warn leading-relaxed">
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

      {err && <p className="text-[12.5px] text-bad leading-snug">{err}</p>}
    </Sheet>
  )
}

/* ------------------------------ not connected ----------------------------- */

/**
 * The honest empty state.
 *
 * Gmail on this deployment is a claude.ai connector, whose token lives in the
 * Claude account and is never written to disk — so there is nothing for Wake to
 * read. Saying that, with the exact fix, beats an inbox of invented mail.
 */
function NotConnected({ state, onRetry }: { state: MailState; onRetry: () => void }) {
  return (
    <div className="column pt-16 pb-24">
      <div className="flex items-start gap-3">
        <MailIcon size={20} className="text-fg-mute mt-0.5 shrink-0" />
        <div>
          <h1 className="text-[19px] font-medium tracking-[-0.02em]">Gmail is not connected</h1>
          <p className="mt-2 text-[13.5px] text-fg-dim leading-relaxed max-w-[52ch]">{state.reason}</p>
        </div>
      </div>

      <div className="mt-6">
        <div className="text-[11px] uppercase tracking-[0.08em] text-fg-mute mb-2">Accounts</div>
        {state.accounts.map(a => (
          <div key={a.address} className="flex items-center gap-2 py-2 hairline last:border-0">
            <span className="w-1.5 h-1.5 rounded-full bg-fg-mute shrink-0" />
            <span className="text-[13.5px] text-fg-dim">{a.address}</span>
            <span className="ml-auto text-[12px] text-fg-mute">not connected</span>
          </div>
        ))}
      </div>

      <details className="mt-6 group">
        <summary className="cursor-pointer text-[12.5px] text-fg-mute hover:text-fg-dim transition-colors list-none">
          Fix it from a terminal
        </summary>
        {/* The resolution order, the dotfile and the environment variable live
            here rather than in the paragraph above: they are the answer to
            "how", and only for a reader who has already asked. */}
        {state.reasonDetail && (
          <p className="mt-2 text-[12.5px] text-fg-mute leading-relaxed max-w-[62ch]">
            {state.reasonDetail}
          </p>
        )}
        <pre className="mt-2 p-3 rounded-[10px] bg-ink-850 text-[12px] font-mono text-fg-dim overflow-x-auto leading-relaxed">
{`claude mcp add --transport http gmail https://gmailmcp.googleapis.com/mcp/v1
claude mcp login gmail`}
        </pre>
        <p className="mt-2 text-[11.5px] text-fg-mute leading-relaxed max-w-[56ch]">
          It must be a directly-added HTTP server, not a claude.ai connector — both show as
          “Connected”, but only the direct one writes a token Wake can read.
        </p>
      </details>

      <div className="mt-6">
        <Button variant="solid" onClick={onRetry}><RefreshCw size={13} /> Check again</Button>
      </div>
    </div>
  )
}
