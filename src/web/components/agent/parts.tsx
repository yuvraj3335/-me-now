/**
 * Segment renderers.
 *
 * Markdown is rendered by a small local formatter rather than a dependency: the
 * agent's output is prose, fenced code, lists and inline code, and a full
 * CommonMark parser would be the largest thing in the bundle for that.
 * Everything here escapes by construction — text becomes React children, never
 * `dangerouslySetInnerHTML`.
 */

import { AlertTriangle, Check, ChevronRight, X, Wrench, Brain, Info } from 'lucide-react'
import { motion } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { Button } from '../primitives'
import type { Segment } from '../../lib/agent'

/* ------------------------------- markdown --------------------------------- */

/** Inline: `code`, **bold**, *italic*, [text](url). */
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))|(\*[^*\n]+\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = key

  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(
        <code key={i++} className="px-1 py-0.5 rounded bg-ink-800 text-[0.92em] font-mono text-fg-dim">
          {tok.slice(1, -1)}
        </code>,
      )
    } else if (tok.startsWith('**')) {
      out.push(<strong key={i++} className="text-fg font-medium">{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('[')) {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!
      out.push(
        <a key={i++} href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          {label}
        </a>,
      )
    } else {
      out.push(<em key={i++} className="italic">{tok.slice(1, -1)}</em>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  let k = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!)
      i++
      blocks.push(
        <pre key={k++} className="my-2 p-3 rounded-[10px] bg-ink-850 overflow-x-auto text-[12.5px] font-mono
                                   text-fg-dim leading-relaxed">
          {lang && <div className="text-[10.5px] uppercase tracking-wide text-fg-mute mb-1.5">{lang}</div>}
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push(
        <div key={k++} className={`mt-3 mb-1 font-medium text-fg ${h[1]!.length <= 2 ? 'text-[14.5px]' : 'text-[13.5px]'}`}>
          {inline(h[2]!)}
        </div>,
      )
      i++
      continue
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={k++} className="my-1.5 space-y-1">
          {items.map((it, n) => (
            <li key={n} className="flex gap-2">
              <span className="text-fg-mute mt-[3px] text-[10px]">•</span>
              <span className="flex-1">{inline(it)}</span>
            </li>
          ))}
        </ul>,
      )
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.startsWith('```') && !/^#{1,4}\s/.test(lines[i]!)) {
      para.push(lines[i++]!)
    }
    blocks.push(<p key={k++} className="my-1.5">{inline(para.join(' '))}</p>)
  }

  return <div className="text-[13.5px] leading-[1.6] text-fg-dim [&>*:first-child]:mt-0">{blocks}</div>
}

/* ------------------------------- tool card -------------------------------- */

const MUTATING_TOOLS = /^(truto_apply|claude_launch|mail_draft)$/

export function ToolCard({ seg }: { seg: Segment }) {
  const [open, setOpen] = useState(false)
  const failed = seg.ok === false
  const pending = seg.ok === undefined
  const mutates = seg.mutates || MUTATING_TOOLS.test(seg.name ?? '')

  return (
    <div className="my-1.5 rounded-[10px] bg-ink-850 border border-white/[0.04] overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-ink-800 transition-colors"
      >
        <ChevronRight
          size={13}
          className={`text-fg-mute transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {mutates ? <AlertTriangle size={13} className="text-warn" /> : <Wrench size={13} className="text-fg-mute" />}
        <span className="font-mono text-[12.5px] text-fg-dim">{seg.name}</span>
        {pending && (
          <motion.span
            className="ml-auto w-1.5 h-1.5 rounded-full bg-accent"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ repeat: Infinity, duration: 1.4 }}
          />
        )}
        {failed && <X size={13} className="ml-auto text-bad" />}
        {seg.ok === true && <Check size={13} className="ml-auto text-ok" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-white/[0.04] pt-2">
          <Labeled label="input">{json(seg.input)}</Labeled>
          {seg.result !== undefined && (
            <Labeled label={failed ? 'error' : 'result'}>
              {typeof seg.result === 'string' ? seg.result : json(seg.result)}
            </Labeled>
          )}
        </div>
      )}
    </div>
  )
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-fg-mute mb-1">{label}</div>
      <pre className="text-[11.5px] font-mono text-fg-dim whitespace-pre-wrap break-all
                      max-h-64 overflow-y-auto leading-relaxed">
        {children}
      </pre>
    </div>
  )
}

const json = (v: unknown) => {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/* ----------------------------- approval card ------------------------------ */

/**
 * What is actually being asked for. Calling an engineering session a "Mutation"
 * is close enough to be believed and wrong enough to mislead — the label has to
 * match the risk class the server assigned.
 */
const RISK_LABEL: Record<string, string> = {
  high_risk: 'High-risk provider mutation',
  mutation: 'Mutation',
  provider_read: 'Provider read',
  engineering: 'Engineering session',
}

export function ApprovalCard({
  seg, onResolve,
}: {
  seg: Segment
  onResolve: (id: string, state: 'approved' | 'denied', answer?: string) => void
}) {
  const resolved = seg.state && seg.state !== 'pending'
  const isQuestion = seg.kind === 'question'
  const options: Array<{ label: string; description?: string }> = seg.options ?? seg.payload?.options ?? []
  const [typed, setTyped] = useState('')

  const tone = isQuestion
    ? 'border-accent/30 bg-accent-soft/30'
    : seg.risk === 'high_risk'
      ? 'border-bad/40 bg-bad/[0.06]'
      : 'border-warn/30 bg-warn/[0.05]'

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className={`my-2 rounded-[12px] border p-3 ${resolved ? 'border-white/[0.06] bg-ink-850 opacity-70' : tone}`}
    >
      <div className="flex items-start gap-2">
        {isQuestion ? (
          <Info size={14} className="text-accent mt-0.5 shrink-0" />
        ) : (
          <AlertTriangle size={14} className={`mt-0.5 shrink-0 ${seg.risk === 'high_risk' ? 'text-bad' : 'text-warn'}`} />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] text-fg leading-snug">{seg.title}</div>
          {!isQuestion && (
            <div className="text-[11px] text-fg-mute mt-0.5">
              {RISK_LABEL[seg.risk] ?? 'Mutation'} · {seg.tool}
            </div>
          )}
        </div>
      </div>

      {seg.detail && (
        <pre className="mt-2 text-[11.5px] font-mono text-fg-dim whitespace-pre-wrap break-words
                        max-h-72 overflow-y-auto leading-relaxed bg-ink-900/60 rounded-lg p-2.5">
          {seg.detail}
        </pre>
      )}

      {resolved ? (
        <div className="mt-2 text-[12px] text-fg-mute">
          {seg.state === 'approved' ? 'Approved' : seg.state === 'denied' ? 'Declined' : 'Expired'}
          {seg.answer ? ` — ${seg.answer}` : ''}
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {isQuestion && options.length > 0 &&
            options.map(o => (
              <Button key={o.label} variant="solid" onClick={() => onResolve(seg.id, 'approved', o.label)} title={o.description}>
                {o.label}
              </Button>
            ))}

          {isQuestion && options.length === 0 && (
            <form
              className="flex gap-2 w-full"
              onSubmit={e => {
                e.preventDefault()
                if (typed.trim()) onResolve(seg.id, 'approved', typed.trim())
              }}
            >
              <input
                autoFocus
                value={typed}
                onChange={e => setTyped(e.target.value)}
                placeholder="Your answer…"
                className="flex-1 min-h-9 px-3 rounded-[10px] bg-ink-900 border border-white/[0.06]
                           text-[13.5px] text-fg placeholder:text-fg-mute outline-none focus:border-accent/40"
              />
              <Button type="submit" variant="accent" disabled={!typed.trim()}>Answer</Button>
            </form>
          )}

          {!isQuestion && (
            <>
              <Button variant="accent" onClick={() => onResolve(seg.id, 'approved')}>Approve</Button>
              <Button variant="ghost" onClick={() => onResolve(seg.id, 'denied')}>Decline</Button>
            </>
          )}
        </div>
      )}
    </motion.div>
  )
}

/* -------------------------------- segments -------------------------------- */

export function SegmentView({
  seg, onResolve,
}: {
  seg: Segment
  onResolve: (id: string, state: 'approved' | 'denied', answer?: string) => void
}) {
  switch (seg.kind) {
    case 'text':
      return <Markdown text={seg.text ?? ''} />

    case 'thinking':
      return <Thinking text={seg.text ?? ''} />

    case 'tool':
      return <ToolCard seg={seg} />

    case 'approval':
    case 'question':
      return <ApprovalCard seg={seg} onResolve={onResolve} />

    case 'notice':
      return (
        <div className="my-1.5 flex items-start gap-2 text-[12.5px] text-fg-mute">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>{seg.text}</span>
        </div>
      )

    case 'error':
      return (
        <div className="my-1.5 flex items-start gap-2 text-[12.5px] text-bad">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap">{seg.text}</span>
        </div>
      )

    default:
      return null
  }
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1.5">
      <button
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1.5 text-[11.5px] text-fg-mute hover:text-fg-dim transition-colors"
      >
        <Brain size={12} />
        Reasoning
        <ChevronRight size={11} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 pl-3 border-l border-white/[0.08] text-[12.5px] text-fg-mute
                        whitespace-pre-wrap leading-relaxed">
          {text}
        </div>
      )}
    </div>
  )
}
