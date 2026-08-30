/**
 * Open in Claude.
 *
 * Three named steps with a clickable rail: `1 Context · 2 Instruction ·
 * 3 Read it`. What this replaces is one 460px scroll containing five
 * undifferentiated fields, four explanatory paragraphs, and a primary action
 * that sat at y735 in a 700px viewport with no sticky footer and no cue.
 *
 * The third step is unchanged, and deliberately so. Wake renders a first draft
 * of the brief and then hands over the actual text in an editable field: what
 * goes is what was approved, and the stored copy, the file on disk and the link
 * all become the edited version. A record of the draft would not be an audit
 * trail.
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
  ArrowUpRight, Check, Copy, FileText, Loader2, Scissors, Search, Sparkles, Terminal, X,
} from 'lucide-react'
import { Button, Field, Sheet, inputClass } from './primitives'
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

type Step = 1 | 2 | 3
const STEPS: Array<{ n: Step; label: string }> = [
  { n: 1, label: 'Context' },
  { n: 2, label: 'Instruction' },
  { n: 3, label: 'Read it' },
]

export function LaunchSheet() {
  const basket = useLaunchBasket()
  return (
    <Sheet open={basket.open} onClose={closeLaunch} title="Open in Claude" wide>
      {basket.open && (
        <LaunchBody
          items={basket.items}
          preferred={basket.templates}
          repoHint={basket.repoHint}
          suggestedTitle={basket.title}
        />
      )}
    </Sheet>
  )
}

function LaunchBody({
  items, preferred, repoHint, suggestedTitle,
}: {
  items: PackItem[]
  preferred: string[]
  repoHint: string | null
  suggestedTitle: string | null
}) {
  const [meta, setMeta] = useState<LaunchState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [step, setStep] = useState<Step>(1)
  const [templates, setTemplates] = useState<string[]>(preferred.length ? preferred : ['blank'])
  const [cwd, setCwd] = useState<string | null>(null)
  const [skills, setSkills] = useState<string[] | null>(null)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<{ packId: string; brief: string } | null>(null)

  useEffect(() => {
    launchApi.state().then(setMeta).catch(e => setErr((e as Error).message))
  }, [])

  const chosen = useMemo(
    () => (meta?.templates ?? []).filter(t => templates.includes(t.id)),
    [meta, templates],
  )

  /**
   * Where the work is. The card's own hint wins over the templates' default —
   * a Claude Code session card knows the directory it ran in, and throwing that
   * away is why every brief used to say `cwd /home/yuvraj/work`.
   */
  useEffect(() => {
    if (!meta) return
    const byHint = repoHint
      ? meta.repos.find(r => r.path === repoHint) ?? meta.repos.find(r => r.name === repoHint)
      : null
    if (byHint) return setCwd(byHint.path)
    const named = chosen.find(t => t.defaultRepo)?.defaultRepo
    const byTemplate = named ? meta.repos.find(r => r.name === named) : null
    if (byTemplate) setCwd(byTemplate.path)
  }, [meta, repoHint, templates.join(',')])

  /**
   * Null means "whatever the templates say", so selecting one folds its skills
   * into step 1 and the count there changes with it.
   */
  const templateSkills = useMemo(
    () => [...new Set(chosen.flatMap(t => t.skills))],
    [chosen],
  )
  const effectiveSkills = skills ?? templateSkills

  if (err && !meta) return <p className="text-sm text-bad py-6">{err}</p>
  if (!meta) return <p className="text-sm text-fg-mute py-6">Reading this machine…</p>

  const write = async () => {
    setBusy(true)
    setErr(null)
    try {
      const pack = await launchApi.createPack({
        templates,
        title: suggestedTitle ?? undefined,
        cwd,
        instruction: instruction.trim() || undefined,
        items,
        skills: effectiveSkills,
      })
      setDraft({ packId: pack.id, brief: pack.first_message ?? '' })
      setStep(3)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Rail step={step} onStep={n => { if (n < 3 || draft) setStep(n) }} hasDraft={!!draft} />

      {step === 1 && (
        <ContextStep
          items={items} meta={meta} cwd={cwd} setCwd={setCwd}
          skills={effectiveSkills} setSkills={setSkills}
        />
      )}

      {step === 2 && (
        <InstructionStep
          meta={meta} templates={templates}
          onToggle={id => {
            setTemplates(t => (t.includes(id) ? t.filter(x => x !== id) : [...t, id]))
            // A template's skills are a starting point, not an answer: dropping
            // the manual override lets the new selection's union show through.
            setSkills(null)
          }}
          instruction={instruction} setInstruction={setInstruction}
        />
      )}

      {step === 3 && draft && (
        <Review packId={draft.packId} initial={draft.brief} handoff={meta.handoff}
          provenance={`${items.length} object${items.length === 1 ? '' : 's'} · ${
            cwd ? (meta.repos.find(r => r.path === cwd)?.name ?? 'no repository') : 'no repository'
          } · ${effectiveSkills.length} skill${effectiveSkills.length === 1 ? '' : 's'} · ${
            templates.length} template${templates.length === 1 ? '' : 's'}`} />
      )}

      {err && step !== 3 && <p className="text-sm text-bad mt-3">{err}</p>}

      {/* One primary, always in view: the sheet's own footer, not the bottom of
          a scroll. `Write the brief` used to sit at y735 in a 700px viewport. */}
      {step !== 3 && (
        <div className="sticky bottom-0 -mx-4 mt-4 px-4 py-3 bg-ink-850 border-t border-rule
                        flex items-center gap-2">
          {step === 1 ? (
            <Button size="lg" variant="primary" className="ml-auto" onClick={() => setStep(2)}>
              Instruction
            </Button>
          ) : (
            <>
              <Button size="md" variant="ghost" onClick={() => setStep(1)}>Context</Button>
              <Button size="lg" variant="primary" className="ml-auto" onClick={write} disabled={busy}>
                {busy ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
                {busy ? 'Writing…' : 'Write the brief'}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Rail({ step, onStep, hasDraft }: { step: Step; onStep: (n: Step) => void; hasDraft: boolean }) {
  return (
    <div className="flex items-center gap-1 pb-4 border-b border-rule">
      {STEPS.map(s => (
        <button
          key={s.n}
          onClick={() => onStep(s.n)}
          disabled={s.n === 3 && !hasDraft}
          aria-current={step === s.n}
          className={`hit relative inline-flex items-center gap-2 h-8 px-3 rounded-control text-sm
            font-medium transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none
            ${step === s.n ? 'bg-ink-800 text-fg' : 'text-fg-mute hover:text-fg-dim hover:bg-ink-800'}`}
        >
          <span className="tnum text-xs text-fg-mute">{s.n}</span>
          {s.label}
        </button>
      ))}
    </div>
  )
}

/* --------------------------------- step 1 --------------------------------- */

/**
 * Three hairline-separated blocks, each a heading and no paragraph.
 *
 * The objects are full-width rows rather than 16-character chips: a card with
 * three sources rendered three chips he could not tell apart, two of them
 * different Claude sessions. A row is the only place two sessions differ.
 */
function ContextStep({
  items, meta, cwd, setCwd, skills, setSkills,
}: {
  items: PackItem[]
  meta: LaunchState
  cwd: string | null
  setCwd: (v: string | null) => void
  skills: string[]
  setSkills: (v: string[]) => void
}) {
  return (
    <div className="divide-y divide-rule">
      <section className="py-4">
        <h3 className="text-eyebrow uppercase text-fg-mute mb-2">
          Objects — {items.length}
        </h3>
        {items.length === 0 && <p className="text-sm text-fg-mute h-11 flex items-center">Nothing attached</p>}
        {items.map(i => (
          <div key={`${i.kind}:${i.ref}`} className="flex items-start gap-3 py-2 border-b border-rule last:border-0">
            <span className="text-xs text-fg-mute w-16 shrink-0 pt-0.5">{KIND_LABEL[i.kind] ?? i.kind}</span>
            <span className="grow min-w-0">
              <span className="block text-sm text-fg-dim line-clamp-2">{i.title ?? i.ref}</span>
              <span className="block text-xs text-fg-mute font-mono truncate">{i.ref}</span>
            </span>
            {/* What this attachment costs the link, before Write rather than
                after: the budget is the URL, and one long quote can spend it. */}
            <span className="text-xs text-fg-mute tnum shrink-0 pt-0.5">
              {Math.min(i.excerpt?.length ?? 0, 2000).toLocaleString()}c
            </span>
            <Button size="sm" variant="ghost" title="Remove" ariaLabel="Remove"
              onClick={() => removeFromLaunch(i.ref)}>
              <X size={13} />
            </Button>
          </div>
        ))}
      </section>

      <section className="py-4">
        <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Repository</h3>
        <select value={cwd ?? ''} onChange={e => setCwd(e.target.value || null)} className={inputClass}>
          <option value="">Not about one repository</option>
          {meta.repos.map(r => (
            <option key={r.path} value={r.path}>
              {r.name}{r.role !== 'canonical' ? ` (${r.role})` : ''}{r.dirty ? ` · ${r.dirty} dirty` : ''}
            </option>
          ))}
        </select>
      </section>

      <SkillPicker all={meta.skills} selected={skills} onChange={setSkills} />
    </div>
  )
}

/**
 * Which skills the brief names.
 *
 * Named, never inlined — a skill body is tens of kilobytes and the brief has to
 * fit in a URL. The search is inline and always visible rather than behind an
 * "Add a skill" toggle.
 */
function SkillPicker({
  all, selected, onChange,
}: { all: LaunchState['skills']; selected: string[]; onChange: (next: string[]) => void }) {
  const [q, setQ] = useState('')

  const matches = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return []
    return all.filter(s => `${s.name} ${s.whenToUse ?? ''}`.toLowerCase().includes(term)).slice(0, 6)
  }, [all, q])

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])

  return (
    <section className="py-4">
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Skills — {selected.length}</h3>

      {selected.map(id => (
        <div key={id} className="flex items-center gap-2 h-8 border-b border-rule last:border-0">
          <Sparkles size={12} className="text-fg-mute shrink-0" />
          <span className="text-sm text-fg-dim truncate grow font-mono">{id.split('/').pop()}</span>
          <Button size="sm" variant="ghost" title="Remove" ariaLabel="Remove" onClick={() => toggle(id)}>
            <X size={13} />
          </Button>
        </div>
      ))}

      <div className="mt-2 flex items-center gap-2 px-2 h-8 rounded-control border border-edge bg-ink-850">
        <Search size={13} className="text-fg-mute shrink-0" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={`Search ${all.length} skills`}
          className="flex-1 bg-transparent outline-none text-sm text-fg placeholder:text-fg-mute"
        />
      </div>
      {matches.map(s => (
        <button
          key={s.id}
          onClick={() => { toggle(s.id); setQ('') }}
          className="w-full flex items-center gap-2 h-8 text-left hover:bg-ink-800 px-2 -mx-2
                     transition-colors duration-100"
        >
          <span className="text-xs text-fg-mute w-4 shrink-0">{s.catalog}</span>
          <span className="text-sm text-fg truncate grow">{s.name}</span>
          {selected.includes(s.id) && <Check size={12} className="text-ok shrink-0" />}
        </button>
      ))}
      {!!q.trim() && !matches.length && <p className="text-sm text-fg-mute h-8 flex items-center">No match</p>}
    </section>
  )
}

/* --------------------------------- step 2 --------------------------------- */

/**
 * Templates as a multi-select list — nine rows, not a chip cloud where clicking
 * a second one cleared the first. Selecting one unions its skills into step 1.
 */
function InstructionStep({
  meta, templates, onToggle, instruction, setInstruction,
}: {
  meta: LaunchState
  templates: string[]
  onToggle: (id: string) => void
  instruction: string
  setInstruction: (v: string) => void
}) {
  return (
    <div className="divide-y divide-rule">
      <section className="py-4">
        <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Templates — {templates.length}</h3>
        {meta.templates.map(t => {
          const on = templates.includes(t.id)
          return (
            <button
              key={t.id}
              onClick={() => onToggle(t.id)}
              aria-pressed={on}
              className="w-full flex items-start gap-3 py-2 text-left border-b border-rule last:border-0
                         hover:bg-ink-800 px-2 -mx-2 transition-colors duration-100"
            >
              <span className={`mt-0.5 w-4 h-4 shrink-0 rounded-chip border flex items-center justify-center
                ${on ? 'bg-accent border-accent' : 'border-edge'}`}>
                {on && <Check size={11} className="text-on-accent" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm text-fg">{t.label}</span>
                <span className="block text-xs text-fg-mute truncate">{t.blurb}</span>
              </span>
            </button>
          )
        })}
      </section>

      <section className="py-4">
        <h3 className="text-eyebrow uppercase text-fg-mute mb-2">What do you need?</h3>
        <div className="relative">
          <textarea
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            rows={5}
            placeholder="Leave blank to use the templates' own instructions"
            className={`${inputClass} resize-y pr-10`}
          />
          <div className="absolute right-2 top-2">
            <Mic onText={t => setInstruction(instruction ? `${instruction} ${t}` : t)} title="Dictate the instruction" />
          </div>
        </div>
      </section>
    </div>
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
  packId, initial, handoff, provenance,
}: {
  packId: string
  initial: string
  handoff: LaunchState['handoff']
  provenance: string
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
    // Not `requestAnimationFrame`: a hidden document never fires one, so the
    // focus and the caret restore would simply never happen.
    setTimeout(() => {
      el.focus()
      const pos = at + text.length + 1
      el.setSelectionRange(pos, pos)
    }, 0)
  }

  return (
    <div className="pt-4">
      <p className="text-sm text-fg-mute mb-2 tnum">
        {provenance} · {link.trimmed
          ? `${link.sent.toLocaleString()} of ${link.total.toLocaleString()}`
          : `${link.total.toLocaleString()} / ${handoff.maxChars.toLocaleString()}`}
      </p>

      <div className="relative">
        <textarea
          ref={ref}
          value={brief}
          onChange={e => setBrief(e.target.value)}
          spellCheck={false}
          className={`${inputClass} font-mono text-xs leading-relaxed resize-y
                      h-[48vh] min-h-[240px] pr-10`}
        />
        <div className="absolute right-2 top-2">
          <Mic onText={insert} title="Dictate into the brief" />
        </div>
      </div>

      {link.trimmed && (
        <p className="mt-2 flex items-start gap-2 text-xs text-warn">
          <Scissors size={12} className="mt-0.5 shrink-0" />
          Longer than a link can carry. The brief will say so inside itself and ask before assuming
          anything is missing — but cutting it here is better than letting Wake choose.
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          // Record what actually went, without blocking the navigation. The tab
          // opens in the background, so this completes either way.
          onClick={() => { void launchApi.open(packId, brief).catch(() => {}); resetLaunch() }}
          className="relative inline-flex items-center justify-center gap-2 h-[38px] px-4
                     rounded-control bg-accent text-on-accent font-medium text-base
                     hover:brightness-110 transition-colors duration-100"
        >
          <Terminal size={16} /> Open in Claude <ArrowUpRight size={15} />
        </a>
        <Button
          size="md"
          variant="default"
          onClick={async () => {
            try { await navigator.clipboard?.writeText(brief); setCopied(true) }
            catch { setCopied(false) }
          }}
        >
          {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy the brief'}
        </Button>
      </div>

      {/* A safety string, not help text: it is the claim the product keeps about
          what this button does and does not do. */}
      <p className="mt-3 text-xs text-fg-mute">
        Opens the Claude app on a phone and a new tab on a laptop, signed in as you already are.
        Wake holds no credential for it and starts nothing of its own.
      </p>
    </div>
  )
}
