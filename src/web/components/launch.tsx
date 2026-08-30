/**
 * The Open in Claude sheet.
 *
 * Three decisions, then a hand-off. Which template, which objects, which
 * repository — shown as removable chips rather than a brand name, because
 * "Slack" is not a thing a session can read and `C05…:1724…` is.
 *
 * Two steps on purpose, and the second one is a real link.
 *
 * Preparing the brief and opening it are separate because you should be able to
 * read what is about to be sent — how much of it fits, what got trimmed — before
 * it goes. And because the thing that opens it has to be an actual `<a>`: on a
 * phone, `https://claude.ai/…` is a universal link, and only a genuine link
 * navigation hands it to the Claude app. A button that calls `window.open`
 * after an await lands in the browser instead, which is the one outcome this
 * whole change exists to avoid.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight, Check, Copy, ExternalLink, FileText, FolderGit2, Loader2, Scissors, Terminal, X,
} from 'lucide-react'
import { Button, Chip, Field, Sheet, inputClass } from './primitives'
import {
  closeLaunch, launchApi, removeFromLaunch, useLaunchBasket,
  type Handoff, type LaunchState, type PackItem,
} from '../lib/launch'
import { Mic } from './voice'

const KIND_LABEL: Record<string, string> = {
  card: 'Card', mail: 'Mail', slack: 'Slack', sentry: 'Sentry',
  notion: 'Notion', github: 'GitHub', session: 'Session', note: 'Note',
}

export function LaunchSheet() {
  const basket = useLaunchBasket()
  return (
    <Sheet open={basket.open} onClose={closeLaunch} title="Open in Claude">
      {basket.open && <LaunchBody items={basket.items} preferred={basket.template} />}
    </Sheet>
  )
}

function LaunchBody({ items, preferred }: { items: PackItem[]; preferred: string | null }) {
  const [meta, setMeta] = useState<LaunchState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [template, setTemplate] = useState(preferred ?? 'blank')
  const [cwd, setCwd] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Handoff | null>(null)

  useEffect(() => {
    launchApi.state().then(setMeta).catch(e => setErr((e as Error).message))
  }, [])

  const chosen = useMemo(() => meta?.templates.find(t => t.id === template) ?? null, [meta, template])

  // The template's default repository pre-fills the field it is about.
  useEffect(() => {
    if (!chosen?.defaultRepo) return
    const repo = meta?.repos.find(r => r.name === chosen.defaultRepo)
    if (repo) setCwd(repo.path)
  }, [chosen?.id, meta])

  if (err) return <p className="text-[13px] text-bad py-6">{err}</p>
  if (!meta) return <p className="text-[13px] text-fg-mute py-6">Reading this machine…</p>
  if (result) return <Result handoff={result} />

  const prepare = async () => {
    setBusy(true)
    setErr(null)
    try {
      const pack = await launchApi.createPack({
        template,
        cwd,
        instruction: instruction.trim() || undefined,
        items,
      })
      setResult(await launchApi.open(pack.id))
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
            <Chip key={t.id} active={template === t.id} onClick={() => setTemplate(t.id)}>
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

      <Field label="Instruction" hint={chosen ? 'Blank uses the template’s own instruction.' : undefined}>
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

      {chosen?.skills.length ? (
        <p className="text-[11.5px] text-fg-mute -mt-1 mb-3">
          It will be told to load: {chosen.skills.join(', ')}.
        </p>
      ) : null}

      {err && <p className="text-[12.5px] text-bad mb-3">{err}</p>}

      <Button variant="accent" className="w-full" onClick={prepare} disabled={busy}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
        {busy ? 'Packing…' : 'Prepare the brief'}
      </Button>
    </div>
  )
}

/**
 * What was packed, and the link that opens it.
 *
 * The anchor is the whole point of this panel, so it is the largest thing in it
 * and it says where it goes. Everything else answers "is this complete?" before
 * you tap it.
 */
function Result({ handoff }: { handoff: Handoff }) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="pt-1 pb-2">
      <a
        href={handoff.url}
        target="_blank"
        rel="noreferrer"
        className="w-full inline-flex items-center justify-center gap-2 min-h-12 rounded-[12px]
                   bg-accent text-on-accent font-medium text-[15px] hover:brightness-110 transition"
      >
        <Terminal size={16} /> Open in Claude <ArrowUpRight size={15} />
      </a>

      <p className="mt-2.5 text-[11.5px] text-fg-mute leading-relaxed">
        Opens the Claude app on a phone and a new tab on a laptop, signed in as you already are.
        Wake holds no credential for it and starts nothing of its own.
      </p>

      <div className="mt-4">
        <Row label="Repository" value={handoff.cwd} mono icon={<FolderGit2 size={12} />} />
        <Row
          label="Brief"
          value={
            handoff.trimmed
              ? `${handoff.sent.toLocaleString()} of ${handoff.total.toLocaleString()} characters`
              : `${handoff.total.toLocaleString()} characters, whole`
          }
        />
      </div>

      {handoff.trimmed && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warn leading-relaxed">
          <Scissors size={12} className="mt-0.5 shrink-0" />
          Too long for a link, so the brief says so inside itself and asks before assuming
          anything is missing. The whole thing is below.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-1.5">
        <a
          href={launchApi.packFileUrl(handoff.packId)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 min-h-9 px-3 rounded-[10px] text-[13.5px]
                     text-fg-dim hover:text-fg hover:bg-ink-800 transition-colors"
        >
          <FileText size={14} /> Read the whole brief <ExternalLink size={12} className="text-fg-mute" />
        </a>
        <Button
          variant="ghost"
          onClick={async () => {
            try {
              const text = await fetch(launchApi.packFileUrl(handoff.packId)).then(r => r.text())
              await navigator.clipboard?.writeText(text)
              setCopied(true)
            } catch {
              setCopied(false)
            }
          }}
        >
          {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy it'}
        </Button>
      </div>
    </div>
  )
}

function Row({ label, value, mono, icon }: { label: string; value: string; mono?: boolean; icon?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="text-[11.5px] text-fg-mute w-[78px] shrink-0">{label}</span>
      <span className={`text-[12.5px] text-fg-dim truncate ${mono ? 'font-mono' : ''}`}>
        {icon}{value}
      </span>
    </div>
  )
}
