/**
 * The Open in Claude sheet.
 *
 * Compose, then read what you are about to send, then send it.
 *
 * The middle step is the point. Wake renders a first draft of the brief — the
 * template's instruction, the repository, the skills, every object quoted and
 * fenced — and then hands you the actual text in an editable field. What goes is
 * what you approved, not what Wake happened to render: the stored copy, the file
 * on disk and the link all become the edited version. A record of the draft
 * would not be an audit trail.
 *
 * The thing that opens it is a real `<a>`, and its href is built here from the
 * text as you type (`src/shared/handoff.ts`, the same code the server uses). On
 * a phone `https://claude.ai/…` is a universal link, and only a genuine link
 * navigation hands it to the Claude app; `window.open` after an await lands in
 * the browser instead, which is the one outcome this whole flow exists to avoid.
 * That also means the character count under the field is honest — it is the same
 * arithmetic that decides what the link carries.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight, Check, ChevronLeft, Copy, FileText, Loader2, Scissors, Search, Sparkles, Terminal, X,
} from 'lucide-react'
import { Button, Chip, Field, Sheet, inputClass } from './primitives'
import {
  closeLaunch, launchApi, removeFromLaunch, resetLaunch, useLaunchBasket,
  type LaunchState, type PackItem,
} from '../lib/launch'
import { handoffFor } from '../../shared/handoff'
import { Mic } from './voice'

const KIND_LABEL: Record<string, string> = {
  card: 'Card', mail: 'Mail', slack: 'Slack', sentry: 'Sentry',
  notion: 'Notion', github: 'GitHub', session: 'Session', note: 'Note',
}

export function LaunchSheet() {
  const basket = useLaunchBasket()
  // The sheet widens for the review step, because a brief read through a 460px
  // column of monospace has not really been read.
  const [reviewing, setReviewing] = useState(false)
  useEffect(() => { if (!basket.open) setReviewing(false) }, [basket.open])

  return (
    <Sheet open={basket.open} onClose={closeLaunch} title="Open in Claude" wide={reviewing}>
      {basket.open && (
        <LaunchBody
          items={basket.items}
          preferred={basket.template}
          repoHint={basket.repoHint}
          suggestedTitle={basket.title}
          onReviewing={setReviewing}
        />
      )}
    </Sheet>
  )
}

function LaunchBody({
  items, preferred, repoHint, suggestedTitle, onReviewing,
}: {
  items: PackItem[]
  preferred: string | null
  repoHint: string | null
  suggestedTitle: string | null
  onReviewing: (v: boolean) => void
}) {
  const [meta, setMeta] = useState<LaunchState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [template, setTemplate] = useState(preferred ?? 'blank')
  const [cwd, setCwd] = useState<string | null>(null)
  const [skills, setSkills] = useState<string[] | null>(null)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<{ packId: string; brief: string } | null>(null)

  useEffect(() => {
    launchApi.state().then(setMeta).catch(e => setErr((e as Error).message))
  }, [])

  useEffect(() => { onReviewing(!!draft) }, [draft, onReviewing])

  const chosen = useMemo(() => meta?.templates.find(t => t.id === template) ?? null, [meta, template])

  /**
   * Where the work is. The card's own hint wins over the template's default —
   * a Claude Code session card knows the directory it ran in, and throwing that
   * away is why every brief used to say `cwd /home/yuvraj/work`.
   */
  useEffect(() => {
    if (!meta) return
    const byHint = repoHint
      ? meta.repos.find(r => r.path === repoHint) ?? meta.repos.find(r => r.name === repoHint)
      : null
    if (byHint) return setCwd(byHint.path)
    const byTemplate = chosen?.defaultRepo ? meta.repos.find(r => r.name === chosen.defaultRepo) : null
    if (byTemplate) setCwd(byTemplate.path)
  }, [chosen?.id, meta, repoHint])

  // Null means "whatever the template says", so switching template follows it.
  const effectiveSkills = skills ?? chosen?.skills ?? []

  if (err && !meta) return <p className="text-[13px] text-bad py-6">{err}</p>
  if (!meta) return <p className="text-[13px] text-fg-mute py-6">Reading this machine…</p>

  if (draft) {
    return (
      <Review
        packId={draft.packId}
        initial={draft.brief}
        handoff={meta.handoff}
        onBack={() => setDraft(null)}
      />
    )
  }

  const write = async () => {
    setBusy(true)
    setErr(null)
    try {
      const pack = await launchApi.createPack({
        template,
        title: suggestedTitle ?? undefined,
        cwd,
        instruction: instruction.trim() || undefined,
        items,
        skills: effectiveSkills,
      })
      setDraft({ packId: pack.id, brief: pack.first_message ?? '' })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pt-1">
      <Field label="Template">
        <div className="flex flex-wrap gap-1.5">
          {meta.templates.map(t => (
            <Chip key={t.id} active={template === t.id} onClick={() => { setTemplate(t.id); setSkills(null) }}>
              {t.label}
            </Chip>
          ))}
        </div>
        {chosen && <p className="text-[12px] text-fg-mute mt-2 leading-snug">{chosen.blurb}</p>}
      </Field>

      <Field label={`Context — ${items.length} object${items.length === 1 ? '' : 's'}`}>
        {items.length ? (
          <div className="flex flex-wrap gap-1.5">
            {items.map(i => (
              <span key={`${i.kind}:${i.ref}`}
                className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-full bg-ink-800 text-[12px] text-fg-dim">
                <span className="text-fg-mute">{KIND_LABEL[i.kind] ?? i.kind}</span>
                <span className="max-w-[16ch] truncate">{i.title ?? i.ref}</span>
                <button onClick={() => removeFromLaunch(i.ref)} className="p-0.5 rounded hover:text-bad" title="Remove">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-fg-mute">
            Nothing attached. The brief carries the instruction and the repository only.
          </p>
        )}
      </Field>

      <Field
        label="Repository this is about"
        hint="Named in the brief so the session knows where the code lives. Only repositories in the workspace registry can be named."
      >
        <select value={cwd ?? ''} onChange={e => setCwd(e.target.value || null)} className={inputClass}>
          <option value="">Not about one repository</option>
          {meta.repos.map(r => (
            <option key={r.path} value={r.path}>
              {r.name}{r.role !== 'canonical' ? ` (${r.role})` : ''}{r.dirty ? ` · ${r.dirty} dirty` : ''}
            </option>
          ))}
        </select>
      </Field>

      <SkillPicker
        all={meta.skills}
        selected={effectiveSkills}
        onChange={next => setSkills(next)}
      />

      <Field label="What do you need?" hint={chosen ? 'Blank uses the template’s own instruction.' : undefined}>
        <div className="relative">
          <textarea
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            rows={4}
            placeholder={chosen?.instruction.split('\n')[0] ?? 'What should it do?'}
            className={`${inputClass} resize-y pr-10`}
          />
          <div className="absolute right-2 top-2">
            <Mic onText={t => setInstruction(v => (v ? `${v} ${t}` : t))} title="Dictate the instruction" />
          </div>
        </div>
      </Field>

      {err && <p className="text-[12.5px] text-bad mb-3">{err}</p>}

      <Button variant="accent" className="w-full" onClick={write} disabled={busy}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
        {busy ? 'Writing…' : 'Write the brief'}
      </Button>
    </div>
  )
}

/* ------------------------------ skill picker ------------------------------ */

/**
 * Which skills the brief names.
 *
 * Named, never inlined — a skill body is tens of kilobytes and the brief has to
 * fit in a URL. The template's list is the starting point rather than the
 * answer, because "blank" names none and a blank brief about a sync job still
 * wants the sync-job validator.
 */
function SkillPicker({
  all, selected, onChange,
}: { all: LaunchState['skills']; selected: string[]; onChange: (next: string[]) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)

  const matches = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return all.slice(0, 8)
    return all
      .filter(s => `${s.name} ${s.whenToUse ?? ''}`.toLowerCase().includes(term))
      .slice(0, 8)
  }, [all, q])

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])

  return (
    <Field label="Skills to load first" hint="Named in the brief, not pasted into it — the session loads them itself.">
      <div className="flex flex-wrap gap-1.5">
        {selected.map(id => (
          <span key={id}
            className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-full bg-ink-800 text-[12px] text-fg-dim">
            <Sparkles size={11} className="text-fg-mute" />
            <span className="max-w-[20ch] truncate">{id.split('/').pop()}</span>
            <button onClick={() => toggle(id)} className="p-0.5 rounded hover:text-bad" title="Remove">
              <X size={11} />
            </button>
          </span>
        ))}
        <Chip onClick={() => setOpen(o => !o)}>{open ? 'Done' : selected.length ? 'Add another' : 'Add a skill'}</Chip>
      </div>

      {open && (
        <div className="mt-2">
          <div className="flex items-center gap-2 px-2.5 h-9 rounded-[10px] bg-ink-800">
            <Search size={13} className="text-fg-mute shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder={`Search ${all.length} skills…`}
              className="flex-1 bg-transparent outline-none text-[13px] text-fg placeholder:text-fg-mute"
            />
          </div>
          <div className="mt-1.5 space-y-0.5 max-h-52 overflow-y-auto">
            {matches.map(s => (
              <button
                key={s.id}
                onClick={() => toggle(s.id)}
                className={`w-full text-left px-2.5 py-2 rounded-[10px] transition-colors
                  ${selected.includes(s.id) ? 'bg-ink-800' : 'hover:bg-ink-850'}`}
              >
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded bg-ink-700 text-fg-mute text-[10px]">{s.catalog}</span>
                  <span className="text-[13px] text-fg truncate">{s.name}</span>
                  {selected.includes(s.id) && <Check size={12} className="ml-auto text-ok shrink-0" />}
                </div>
                {s.whenToUse && (
                  <div className="text-[11.5px] text-fg-mute mt-0.5 leading-snug line-clamp-2">{s.whenToUse}</div>
                )}
              </button>
            ))}
            {!matches.length && <p className="text-[12px] text-fg-mute px-2.5 py-3">Nothing matches that.</p>}
          </div>
        </div>
      )}
    </Field>
  )
}

/* --------------------------- read it, then send it ------------------------ */

/**
 * The brief, editable, with the link built from what is in the field.
 *
 * Everything here answers one question before you tap: *is this what I want to
 * send?* So the text is the largest thing on screen, the count is live and honest,
 * and the Open button carries whatever the field currently says.
 */
function Review({
  packId, initial, handoff, onBack,
}: {
  packId: string
  initial: string
  handoff: LaunchState['handoff']
  onBack: () => void
}) {
  const [brief, setBrief] = useState(initial)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  // The same function the server runs, so the count and the link agree.
  const link = useMemo(() => handoffFor(brief, handoff), [brief, handoff])

  /** Dictation lands where the cursor is, not always at the end. */
  const insert = (text: string) => {
    const el = ref.current
    if (!el) return setBrief(v => (v ? `${v} ${text}` : text))
    const at = el.selectionStart ?? brief.length
    const end = el.selectionEnd ?? at
    const next = `${brief.slice(0, at)}${brief.slice(0, at).match(/\S$/) ? ' ' : ''}${text}${brief.slice(end)}`
    setBrief(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = at + text.length + 1
      el.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="pt-1 pb-2">
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-[12.5px] text-fg-mute hover:text-fg-dim transition-colors"
        >
          <ChevronLeft size={13} /> Change what is in it
        </button>
        <span className={`ml-auto tnum text-[11.5px] ${link.trimmed ? 'text-warn' : 'text-fg-mute'}`}>
          {link.trimmed
            ? `${link.sent.toLocaleString()} of ${link.total.toLocaleString()}`
            : `${link.total.toLocaleString()} / ${handoff.maxChars.toLocaleString()}`}
        </span>
      </div>

      <div className="relative">
        <textarea
          ref={ref}
          value={brief}
          onChange={e => setBrief(e.target.value)}
          spellCheck={false}
          className={`${inputClass} font-mono text-[12.5px] leading-relaxed resize-y
                      h-[52vh] min-h-[280px] pr-10`}
        />
        <div className="absolute right-2 top-2">
          <Mic onText={insert} title="Dictate into the brief" />
        </div>
      </div>

      {link.trimmed && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warn leading-relaxed">
          <Scissors size={12} className="mt-0.5 shrink-0" />
          Longer than a link can carry. The brief will say so inside itself and ask before assuming
          anything is missing — but cutting it here is better than letting Wake choose.
        </p>
      )}

      <a
        href={link.url}
        target="_blank"
        rel="noreferrer"
        // Record what actually went, without blocking the navigation. The tab
        // opens in the background, so this completes either way.
        onClick={() => { void launchApi.open(packId, brief).catch(() => {}); resetLaunch() }}
        className="mt-4 w-full inline-flex items-center justify-center gap-2 min-h-12 rounded-[12px]
                   bg-accent text-on-accent font-medium text-[15px] hover:brightness-110 transition"
      >
        <Terminal size={16} /> Open in Claude <ArrowUpRight size={15} />
      </a>

      <p className="mt-2.5 text-[11.5px] text-fg-mute leading-relaxed">
        Opens the Claude app on a phone and a new tab on a laptop, signed in as you already are.
        Wake holds no credential for it and starts nothing of its own.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button
          variant="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard?.writeText(brief)
              setCopied(true)
            } catch {
              setCopied(false)
            }
          }}
        >
          {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy the brief'}
        </Button>
      </div>
    </div>
  )
}
