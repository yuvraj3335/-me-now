/**
 * The Wake Agent.
 *
 * Three panes on a laptop — history, the conversation, an inspector — and one
 * column on a phone. The inspector exists because "why is it doing this" should
 * be answerable from the screen: it shows the mode's actual tool surface, the
 * skills routing chose and the rule that chose them, and every tool call the
 * turn made.
 *
 * This chat runs on the Anthropic API with a key Wake holds. It is not the
 * `claude` CLI — that is the other button, "Open in Claude Code", which packs
 * this context and hands it to a session on the machine. Both exist on this
 * page and they are not aliases.
 */

import { motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp, BookOpen, ChevronDown, GitBranch, KeyRound, Layers, Plus, RotateCcw, Search,
  ShieldCheck, Square, Terminal, Trash2, Wifi, WifiOff, X, Paperclip,
} from 'lucide-react'
import {
  useAgent, useBootstrap, openConversation, newConversation, send, cancel, retryTurn,
  resolveApproval, updateConversation, archiveConversation, previewRoute,
  getAttachments, removeAttachment, clearAttachments, withAttachments,
} from '../lib/agent'
import { SegmentView } from '../components/agent/parts'
import { Button, Sheet, Empty, spring } from '../components/primitives'
import { STATIC_MODE } from '../lib/motion'
import { openLaunch } from '../lib/launch'
import { registerPaletteActions } from '../components/palette'
import { navigate } from '../App'
import { ago } from '../lib/time'
import { Mic } from '../components/voice'

export function Agent() {
  useBootstrap()
  const s = useAgent()
  const [picker, setPicker] = useState<null | 'conversations' | 'mode' | 'profile' | 'repo' | 'skills'>(null)
  const [inspector, setInspector] = useState(false)

  useEffect(() => {
    if (!s.active && s.conversations.length) void openConversation(s.conversations[0]!.id)
  }, [s.conversations.length])

  useEffect(() =>
    registerPaletteActions(() => [
      {
        id: 'agent:new',
        label: 'New agent conversation',
        group: 'Agent',
        icon: <Plus size={14} />,
        run: () => { navigate('/agent'); void newConversation(s.active?.mode ?? 'triage', s.active?.profile) },
      },
      ...(s.meta?.modes ?? []).map(m => ({
        id: `agent:mode:${m.id}`,
        label: `Agent mode — ${m.label}`,
        hint: m.blurb,
        group: 'Agent',
        icon: <Layers size={14} />,
        run: () => { navigate('/agent'); if (s.active) void updateConversation(s.active.id, { mode: m.id }) },
      })),
    ]), [s.meta?.modes, s.active?.id])

  const mode = s.meta?.modes.find(m => m.id === s.active?.mode)

  // Without a key the agent cannot run at all, and everything else on the page
  // would be a working-looking surface that silently does nothing.
  if (s.meta && !s.meta.key.present) return <NoKey />

  return (
    <div className="sm:h-[calc(100dvh-3.5rem)] sm:flex -mx-4 sm:-mx-6">
      {/* History */}
      <aside className="hidden lg:flex lg:w-[248px] shrink-0 flex-col border-r border-white/[0.06] overflow-y-auto">
        <div className="sticky top-0 bg-ink-900/92 backdrop-blur-xl px-3 py-3 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.08em] text-fg-mute">Conversations</span>
          <button
            onClick={() => void newConversation(s.active?.mode ?? 'triage', s.active?.profile)}
            className="ml-auto p-1.5 rounded-lg text-fg-mute hover:text-fg-dim hover:bg-ink-800 transition-colors"
            title="New conversation"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="px-2 pb-4">
          {s.conversations.map(c => (
            <div key={c.id} className="group flex items-center gap-1">
              <button
                onClick={() => void openConversation(c.id)}
                className={`flex-1 min-w-0 text-left px-2.5 py-2 rounded-[10px] transition-colors
                  ${s.active?.id === c.id ? 'bg-ink-800 text-fg' : 'text-fg-dim hover:bg-ink-850'}`}
              >
                <div className="text-[12.5px] truncate">{c.title}</div>
                <div className="text-[10.5px] text-fg-mute mt-0.5 truncate">
                  {c.mode}{c.profile ? ` · ${c.profile}` : ''} · {ago(c.updated_at)}
                </div>
              </button>
              <button
                onClick={() => void archiveConversation(c.id)}
                className="p-1.5 rounded-lg text-fg-mute opacity-0 group-hover:opacity-100 hover:text-bad transition"
                title="Archive"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {!s.conversations.length && <p className="px-2.5 py-4 text-[12px] text-fg-mute">Nothing yet.</p>}
        </div>
      </aside>

      {/* Conversation */}
      <section className="grow min-w-0 flex flex-col">
        <div className="sticky top-0 sm:static z-20 bg-ink-900/92 backdrop-blur-xl px-4 sm:px-5 py-2
                        flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0">
          <Chip icon={<Layers size={12} />} onClick={() => setPicker('conversations')} className="lg:hidden">
            {s.active?.title ?? 'No conversation'}
          </Chip>
          {/* Falls back to the conversation's own mode id, never to a specific
              mode name — /state takes a second to load and naming the wrong mode
              there is worse than naming none. */}
          <Chip icon={<ChevronDown size={12} />} onClick={() => setPicker('mode')} tone={mode?.readOnly ? 'ok' : undefined}>
            {mode?.label ?? s.active?.mode ?? 'mode'}
          </Chip>
          <Chip icon={<ShieldCheck size={12} />} onClick={() => setPicker('profile')} tone={s.active?.profile ? undefined : 'warn'}>
            {s.active?.profile ?? 'no profile'}
          </Chip>
          {s.active?.mode === 'engineering' && (
            <Chip icon={<GitBranch size={12} />} onClick={() => setPicker('repo')} tone={s.active?.repo_path ? undefined : 'warn'}>
              {s.active?.repo_path?.split('/').pop() ?? 'no repo'}
            </Chip>
          )}
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {s.connection === 'reconnecting' && <WifiOff size={13} className="text-warn" />}
            {s.connection === 'open' && s.running && <Wifi size={13} className="text-ok" />}
            <button
              onClick={() => setInspector(v => !v)}
              className="xl:hidden p-1.5 rounded-lg text-fg-mute hover:text-fg-dim hover:bg-ink-800 transition-colors"
              title="Inspector"
            >
              <BookOpen size={14} />
            </button>
            <button
              onClick={() => void newConversation(s.active?.mode ?? 'triage', s.active?.profile)}
              title="New conversation"
              className="lg:hidden p-1.5 rounded-lg text-fg-mute hover:text-fg-dim hover:bg-ink-800 transition-colors"
            >
              <Plus size={15} />
            </button>
          </div>
        </div>

        <div className="grow sm:overflow-y-auto px-4 sm:px-5 pb-44 sm:pb-4">
          {mode && <ModeBanner blurb={mode.blurb} readOnly={mode.readOnly} />}
          <Thread />
        </div>

        <Composer />
      </section>

      {/* Inspector */}
      <aside className="hidden xl:flex xl:w-[300px] shrink-0 flex-col border-l border-white/[0.06] overflow-y-auto">
        <Inspector />
      </aside>

      <Sheet open={inspector} onClose={() => setInspector(false)} title="Inspector">
        <Inspector />
      </Sheet>

      <Pickers which={picker} close={() => setPicker(null)} />
    </div>
  )
}

/* ------------------------------- no key ----------------------------------- */

function NoKey() {
  return (
    <div className="column pt-16 pb-24">
      <div className="flex items-start gap-3">
        <KeyRound size={20} className="text-fg-mute mt-0.5 shrink-0" />
        <div>
          <h1 className="text-[19px] font-medium tracking-[-0.02em]">The agent has no API key</h1>
          <p className="mt-2 text-[13.5px] text-fg-dim leading-relaxed max-w-[54ch]">
            This chat runs on the Anthropic API with a key Wake holds. Add one in Settings → Agent.
          </p>
          <p className="mt-3 text-[12.5px] text-fg-mute leading-relaxed max-w-[54ch]">
            It is a different credential from the <code className="font-mono">claude</code> CLI signed in on this
            machine. That one powers “Open in Claude Code”, and it needs nothing from Wake.
          </p>
          <Button variant="accent" className="mt-4" onClick={() => navigate('/settings')}>
            Open Settings
          </Button>
        </div>
      </div>
    </div>
  )
}

function ModeBanner({ blurb, readOnly }: { blurb: string; readOnly: boolean }) {
  return (
    <div className="mt-2 mb-1 text-[11.5px] text-fg-mute flex items-center gap-1.5">
      {blurb}
      {readOnly && (
        <span className="px-1.5 py-0.5 rounded bg-ok/10 text-ok text-[10px] uppercase tracking-wide">read-only</span>
      )}
    </div>
  )
}

/* --------------------------------- thread --------------------------------- */

function Thread() {
  const s = useAgent()
  const endRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // Follow the stream, but stop following the moment the reader scrolls up —
  // yanking someone back to the bottom mid-read is worse than not following.
  useEffect(() => {
    const el = endRef.current?.parentElement?.parentElement
    const onScroll = (e: Event) => {
      // The scroller is the pane on a laptop and the document on a phone, and
      // the same handler serves both — `document` reports its geometry through
      // documentElement, an element reports its own.
      const box = e.target instanceof HTMLElement ? e.target : document.documentElement
      stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 160
    }
    el?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el?.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
    }
  }, [])

  useEffect(() => {
    if (stick.current && !STATIC_MODE) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [s.live.length, s.messages.length, s.live[s.live.length - 1]?.text?.length])

  if (!s.active) return <Empty>Start a conversation to investigate something.</Empty>

  const showLive = s.live.length > 0 || s.running
  const failed = !s.running && (s.error || s.live.some(x => x.kind === 'error'))

  return (
    <div className="mt-3 space-y-5 max-w-[820px]">
      {s.messages.map(m =>
        m.role === 'user' ? (
          <UserBubble key={m.id} text={m.body} />
        ) : (
          <div key={m.id} className="space-y-1">
            {(m.segments?.length ? m.segments : [{ kind: 'text', text: m.body }]).map((seg, i) => (
              <SegmentView key={i} seg={seg} onResolve={resolveApproval} />
            ))}
          </div>
        ),
      )}

      {showLive && (
        <div className="space-y-1">
          {s.routed && <RoutedSkills routed={s.routed.routed} rules={s.routed.rules} />}
          {s.live.map((seg, i) => (
            <SegmentView key={i} seg={seg} onResolve={resolveApproval} />
          ))}
          {s.running && <Working />}
        </div>
      )}

      {s.error && <div className="text-[12.5px] text-bad">{s.error}</div>}
      {failed && (
        <Button variant="ghost" onClick={() => void retryTurn()}>
          <RotateCcw size={13} /> Try that again
        </Button>
      )}
      {s.usage?.steps != null && !s.running && (
        <div className="text-[11px] text-fg-mute tnum">
          {s.usage.steps} step{s.usage.steps === 1 ? '' : 's'}
          {s.usage.inputTokens ? ` · ${fmtTokens(s.usage.inputTokens)} in` : ''}
          {s.usage.outputTokens ? ` · ${fmtTokens(s.usage.outputTokens)} out` : ''}
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function UserBubble({ text }: { text: string }) {
  // An attached block is quoted context, not the ask. Splitting it keeps the
  // bubble readable when someone attached a 40-line mail thread.
  const [ask, ...rest] = text.split('\n\n## Attached by me for reference\n')
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] px-3.5 py-2.5 rounded-[14px] rounded-br-[6px] bg-ink-800
                      text-[13.5px] text-fg leading-relaxed whitespace-pre-wrap">
        {ask}
        {rest.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11.5px] text-fg-mute list-none">attached context</summary>
            <pre className="mt-1 text-[11.5px] text-fg-mute whitespace-pre-wrap font-mono max-h-56 overflow-y-auto">
              {rest.join('')}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}

function RoutedSkills({ routed, rules }: { routed: string[]; rules: string[] }) {
  const [open, setOpen] = useState(false)
  if (!routed.length) return null
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1.5 text-[11px] text-fg-mute hover:text-fg-dim transition-colors"
      >
        <BookOpen size={11} />
        {routed.map(r => r.split('/').pop()).join(' · ')}
      </button>
      {open && (
        <ul className="mt-1 pl-3 border-l border-white/[0.08] space-y-0.5">
          {rules.map((r, i) => (
            <li key={i} className="text-[11px] text-fg-mute">{r}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Working() {
  return (
    <div className="flex items-center gap-2 text-[12px] text-fg-mute">
      <motion.span
        className="w-1.5 h-1.5 rounded-full bg-accent"
        animate={STATIC_MODE ? undefined : { opacity: [1, 0.25, 1] }}
        transition={{ repeat: Infinity, duration: 1.3 }}
      />
      Working
    </div>
  )
}

/* ------------------------------- inspector -------------------------------- */

function Inspector() {
  const s = useAgent()
  const mode = s.meta?.modes.find(m => m.id === s.active?.mode)

  return (
    <div className="p-4 space-y-5">
      <Block title="Engine">
        <Line k="Chat" v={s.meta?.model ?? '—'} />
        <Line k="Key" v={s.meta?.key.present ? `${s.meta.key.via} · …${s.meta.key.last4}` : 'missing'} tone={s.meta?.key.present ? undefined : 'bad'} />
        <Line
          k="Claude Code"
          v={s.meta?.launcher.ok ? (s.meta.launcher.version ?? 'ready') : 'unavailable'}
          tone={s.meta?.launcher.ok ? undefined : 'warn'}
        />
        {!s.meta?.launcher.ok && s.meta?.launcher.reason && (
          <p className="text-[11px] text-fg-mute leading-snug mt-1">{s.meta.launcher.reason}</p>
        )}
      </Block>

      {mode && (
        <Block title="This mode's surface">
          <p className="text-[11.5px] text-fg-mute leading-relaxed mb-1.5">{mode.blurb}</p>
          {s.meta?.mail && !s.meta.mail.connected && (
            <p className="text-[11px] text-warn leading-snug">Gmail unavailable — mail tools will say so.</p>
          )}
        </Block>
      )}

      {s.routed && (
        <Block title="Skills this turn">
          {s.routed.routed.map(r => (
            <div key={r} className="text-[11.5px] text-fg-dim font-mono truncate">{r}</div>
          ))}
          <ul className="mt-1.5 space-y-0.5">
            {s.routed.rules.map((r, i) => (
              <li key={i} className="text-[11px] text-fg-mute leading-snug">{r}</li>
            ))}
          </ul>
        </Block>
      )}

      <Block title="Tool calls">
        {s.live.filter(x => x.kind === 'tool').length === 0 ? (
          <p className="text-[11.5px] text-fg-mute">None yet in this turn.</p>
        ) : (
          s.live
            .filter(x => x.kind === 'tool')
            .map((t, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[11.5px] py-0.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  t.ok === true ? 'bg-ok' : t.ok === false ? 'bg-bad' : 'bg-accent'
                }`} />
                <span className="font-mono text-fg-dim truncate">{t.name}</span>
                {t.mutates && <span className="ml-auto text-[10px] text-warn uppercase tracking-wide">write</span>}
              </div>
            ))
        )}
      </Block>

      <Block title="Hand off">
        <p className="text-[11.5px] text-fg-mute leading-relaxed mb-2">
          Work that needs to edit files or run tests goes to a Claude Code session on this machine.
        </p>
        <Button
          variant="solid"
          onClick={() =>
            openLaunch(
              s.active
                ? [{
                    kind: 'note' as const,
                    ref: `wake-conversation:${s.active.id}`,
                    title: s.active.title,
                    excerpt: s.messages.slice(-6).map(m => `${m.role}: ${m.body}`).join('\n\n'),
                    why: 'the Wake conversation this came from',
                  }]
                : [],
            )
          }
        >
          <Terminal size={13} /> Open in Claude Code
        </Button>
      </Block>
    </div>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-fg-mute mb-1.5">{title}</div>
      {children}
    </section>
  )
}

function Line({ k, v, tone }: { k: string; v: string; tone?: 'bad' | 'warn' }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="text-[11.5px] text-fg-mute w-[84px] shrink-0">{k}</span>
      <span className={`text-[11.5px] truncate ${tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-fg-dim'}`}>{v}</span>
    </div>
  )
}

/* -------------------------------- composer -------------------------------- */

function Composer() {
  const s = useAgent()
  const [text, setText] = useState('')
  const [route, setRoute] = useState<Awaited<ReturnType<typeof previewRoute>>>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const attachments = getAttachments()

  // Preview the routing decision while typing, so the skills that will load are
  // visible before the turn starts rather than after.
  useEffect(() => {
    if (!s.active || text.trim().length < 12) return setRoute(null)
    const t = setTimeout(() => void previewRoute(s.active!.mode, text).then(setRoute), 450)
    return () => clearTimeout(t)
  }, [text, s.active?.mode])

  const grow = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const submit = () => {
    if (!text.trim() || s.running) return
    void send(withAttachments(text))
    clearAttachments()
    setText('')
    setRoute(null)
    requestAnimationFrame(grow)
  }

  const preview = route ? [route.baseline, route.specialist, ...route.forced].filter(Boolean) : []

  return (
    <div className="fixed sm:static bottom-0 inset-x-0 z-20 sm:pb-4 pointer-events-none sm:pointer-events-auto shrink-0">
      <div className="max-w-[820px] mx-auto px-4 sm:px-5 pointer-events-auto">
        {attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {attachments.map(a => (
              <span key={a.ref}
                className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-full bg-ink-800 text-[11.5px] text-fg-dim">
                <Paperclip size={11} className="text-fg-mute" />
                <span className="max-w-[22ch] truncate">{a.title}</span>
                <button onClick={() => removeAttachment(a.ref)} className="p-0.5 rounded hover:text-bad" title="Remove">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {preview.length > 0 && !s.running && (
          <div className="mb-1.5 text-[11px] text-fg-mute flex items-center gap-1.5">
            <BookOpen size={11} />
            will load {preview.map(p => p!.split('/').pop()).join(' · ')}
          </div>
        )}

        <div className="rounded-[16px] bg-ink-850/95 backdrop-blur-xl border border-white/[0.07]
                        p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:pb-2 shadow-2xl shadow-black/40">
          <div className="flex items-end gap-1.5">
            <textarea
              ref={ref}
              rows={1}
              value={text}
              disabled={!s.active}
              onChange={e => { setText(e.target.value); grow() }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={s.active ? 'Ask, investigate, or describe a change…' : 'Start a conversation first'}
              className="flex-1 bg-transparent resize-none outline-none px-2 py-1.5 max-h-[200px]
                         text-[14px] text-fg placeholder:text-fg-mute leading-relaxed"
            />
            <Mic title="Dictate" onText={t => { setText(v => (v ? `${v} ${t}` : t)); requestAnimationFrame(grow) }} />
            {s.running ? (
              <Button variant="ghost" onClick={() => void cancel()} title="Stop">
                <Square size={13} className="fill-current" />
              </Button>
            ) : (
              <Button variant="accent" onClick={submit} disabled={!text.trim() || !s.active} title="Send">
                <ArrowUp size={15} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------- pickers --------------------------------- */

function Pickers({ which, close }: { which: string | null; close: () => void }) {
  const s = useAgent()
  const [q, setQ] = useState('')

  const repos = useMemo(() => {
    const all = s.meta?.repos ?? []
    const term = q.trim().toLowerCase()
    return (term ? all.filter(r => r.name.toLowerCase().includes(term)) : all).slice(0, 60)
  }, [s.meta?.repos, q])

  const skills = useMemo(() => {
    const all = s.meta?.skills ?? []
    const term = q.trim().toLowerCase()
    return term ? all.filter(k => `${k.name} ${k.whenToUse ?? ''}`.toLowerCase().includes(term)) : all
  }, [s.meta?.skills, q])

  return (
    <>
      <Sheet open={which === 'conversations'} onClose={close} title="Conversations">
        <div className="space-y-1">
          {s.conversations.map(c => (
            <div key={c.id} className="flex items-center gap-2">
              <button
                onClick={() => { void openConversation(c.id); close() }}
                className={`flex-1 text-left px-3 py-2.5 rounded-[10px] transition-colors
                  ${s.active?.id === c.id ? 'bg-ink-800 text-fg' : 'text-fg-dim hover:bg-ink-850'}`}
              >
                <div className="text-[13.5px] truncate">{c.title}</div>
                <div className="text-[11px] text-fg-mute mt-0.5">
                  {c.mode}{c.profile ? ` · ${c.profile}` : ''}{c.messages ? ` · ${c.messages} messages` : ''}
                </div>
              </button>
              <button
                onClick={() => void archiveConversation(c.id)}
                className="p-2 rounded-lg text-fg-mute hover:text-bad transition-colors"
                title="Archive"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!s.conversations.length && <Empty>No conversations yet.</Empty>}
        </div>
      </Sheet>

      <Sheet open={which === 'mode'} onClose={close} title="Mode">
        <div className="space-y-1">
          {s.meta?.modes.map(m => (
            <button
              key={m.id}
              onClick={() => { if (s.active) void updateConversation(s.active.id, { mode: m.id }); close() }}
              className={`w-full text-left px-3 py-2.5 rounded-[10px] transition-colors
                ${s.active?.mode === m.id ? 'bg-ink-800' : 'hover:bg-ink-850'}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13.5px] text-fg">{m.label}</span>
                {m.readOnly && (
                  <span className="px-1.5 py-0.5 rounded bg-ok/10 text-ok text-[10px] uppercase tracking-wide">
                    read-only
                  </span>
                )}
              </div>
              <div className="text-[11.5px] text-fg-mute mt-0.5">{m.blurb}</div>
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={which === 'profile'} onClose={close} title="Truto profile">
        <p className="text-[12px] text-fg-mute mb-2">
          Profiles point at different teams and environments. Nothing runs against the platform until one is chosen.
        </p>
        <div className="space-y-1">
          {(s.meta?.profiles ?? []).map(p => (
            <button
              key={p}
              onClick={() => { if (s.active) void updateConversation(s.active.id, { profile: p }); close() }}
              className={`w-full text-left px-3 py-2.5 rounded-[10px] text-[13.5px] transition-colors
                ${s.active?.profile === p ? 'bg-ink-800 text-fg' : 'text-fg-dim hover:bg-ink-850'}`}
            >
              {p}
            </button>
          ))}
          {!s.meta?.profiles.length && <Empty>No Truto CLI profiles found on this machine.</Empty>}
        </div>
      </Sheet>

      <Sheet open={which === 'repo'} onClose={close} title="Repository">
        <SearchBox value={q} onChange={setQ} placeholder="Filter repositories…" />
        <div className="space-y-1 mt-2">
          {repos.map(r => (
            <button
              key={r.path}
              onClick={() => { if (s.active) void updateConversation(s.active.id, { repo_path: r.path }); close() }}
              className={`w-full text-left px-3 py-2.5 rounded-[10px] transition-colors
                ${s.active?.repo_path === r.path ? 'bg-ink-800' : 'hover:bg-ink-850'}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13.5px] text-fg">{r.name}</span>
                {r.role !== 'canonical' && (
                  <span className="px-1.5 py-0.5 rounded bg-ink-700 text-fg-mute text-[10px] uppercase tracking-wide">
                    {r.role}
                  </span>
                )}
                {r.dirty > 0 && <span className="text-[10.5px] text-warn tnum">{r.dirty} dirty</span>}
              </div>
              <div className="text-[11px] text-fg-mute mt-0.5 truncate">{r.branch}</div>
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={which === 'skills'} onClose={close} title="Skill catalogs">
        <p className="text-[12px] text-fg-mute mb-2">
          Indexed by metadata only. A body is read when a turn actually needs it.
        </p>
        <SearchBox value={q} onChange={setQ} placeholder="Search skills…" />
        <div className="space-y-1 mt-2">
          {skills.map(k => (
            <div key={k.id} className="px-3 py-2.5 rounded-[10px] hover:bg-ink-850">
              <div className="flex items-center gap-2">
                <span className="px-1.5 py-0.5 rounded bg-ink-700 text-fg-mute text-[10px]">{k.catalog}</span>
                <span className="text-[13px] text-fg">{k.name}</span>
                {k.mutating && (
                  <span className="px-1.5 py-0.5 rounded bg-warn/10 text-warn text-[10px] uppercase tracking-wide">
                    mutating
                  </span>
                )}
              </div>
              {k.whenToUse && <div className="text-[11.5px] text-fg-mute mt-1 leading-snug">{k.whenToUse}</div>}
            </div>
          ))}
        </div>
      </Sheet>
    </>
  )
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="flex items-center gap-2 px-3 min-h-9 rounded-[10px] bg-ink-900 border border-white/[0.06]">
      <Search size={13} className="text-fg-mute" />
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent outline-none text-[13.5px] text-fg placeholder:text-fg-mute"
      />
    </div>
  )
}

function Chip({
  children, icon, onClick, tone, className = '',
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  onClick?: () => void
  tone?: 'ok' | 'warn'
  className?: string
}) {
  const toneClass = tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-fg-dim'
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      transition={spring}
      onClick={onClick}
      className={`shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-ink-850
                  text-[12px] max-w-[220px] hover:bg-ink-800 transition-colors ${toneClass} ${className}`}
    >
      {icon}
      <span className="truncate">{children}</span>
    </motion.button>
  )
}
