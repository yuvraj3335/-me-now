/**
 * The Open in Claude Code sheet.
 *
 * Three decisions, then a handoff. Which template, which objects, which
 * directory — shown as removable chips rather than a brand name, because
 * "Slack" is not a thing a session can read and `C05…:1724…` is.
 *
 * What comes back is deliberately unglamorous: a session id, a working
 * directory, and the exact command to rejoin it in a terminal. No attempt is
 * made to focus a desktop app, because nothing here has verified that such a
 * handoff exists on this machine — and a button that silently does nothing is
 * worse than a command you can paste.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Check, Copy, ExternalLink, FileText, FolderGit2, Loader2, Play, Terminal, X,
} from 'lucide-react'
import { Button, Chip, Field, Sheet, inputClass } from './primitives'
import {
  closeLaunch, launchApi, removeFromLaunch, useLaunchBasket,
  type LaunchState, type Pack, type PackItem,
} from '../lib/launch'
import { ago } from '../lib/time'
import { Mic } from './voice'

const KIND_LABEL: Record<string, string> = {
  card: 'Card', mail: 'Mail', slack: 'Slack', sentry: 'Sentry',
  notion: 'Notion', github: 'GitHub', session: 'Session', note: 'Note',
}

export function LaunchSheet() {
  const basket = useLaunchBasket()
  return (
    <Sheet open={basket.open} onClose={closeLaunch} title="Open in Claude Code">
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
  const [resume, setResume] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Pack | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    launchApi.state().then(setMeta).catch(e => setErr((e as Error).message))
  }, [])

  const chosen = useMemo(() => meta?.templates.find(t => t.id === template) ?? null, [meta, template])

  // The template's default repo pre-fills the directory, and a resumed session
  // overrides it with its own — continuing a session somewhere else is almost
  // never what anyone means.
  useEffect(() => {
    if (resume) {
      const s = meta?.sessions.find(x => x.id === resume)
      if (s) return setCwd(s.cwd)
    }
    if (!chosen?.defaultRepo) return
    const repo = meta?.repos.find(r => r.name === chosen.defaultRepo)
    if (repo) setCwd(repo.path)
  }, [chosen?.id, resume, meta])

  useEffect(() => {
    if (chosen && !instruction.trim()) setInstruction('')
  }, [chosen?.id])

  if (err) return <p className="text-[13px] text-bad py-6">{err}</p>
  if (!meta) return <p className="text-[13px] text-fg-mute py-6">Reading this machine…</p>

  if (!meta.status.ok) {
    return (
      <div className="py-4">
        <p className="text-[13.5px] text-fg leading-relaxed">Claude Code is not usable from here.</p>
        <p className="text-[12.5px] text-fg-mute mt-2 leading-relaxed">{meta.status.reason}</p>
        <p className="text-[11.5px] text-fg-mute mt-3">
          Wake looked for <code className="font-mono">{meta.status.binary}</code>
          {meta.status.version ? ` and found ${meta.status.version}` : ' and could not run it'}.
        </p>
      </div>
    )
  }

  if (result) return <Result pack={result} copied={copied} setCopied={setCopied} />

  const go = async () => {
    setBusy(true)
    setErr(null)
    try {
      const pack = await launchApi.createPack({
        template,
        cwd,
        instruction: instruction.trim() || undefined,
        items,
        resumeSessionId: resume,
      })
      await launchApi.launch(pack.id)
      // Re-read rather than trusting the launch response: the session id is
      // confirmed by the child's own init message a moment later.
      setResult(await launchApi.pack(pack.id))
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
            Nothing attached. The session gets the instruction and the directory only.
          </p>
        )}
      </Field>

      <Field label="Where it runs" hint="Only repositories in the workspace registry can host a session.">
        <select
          value={cwd ?? ''}
          onChange={e => setCwd(e.target.value || null)}
          className={inputClass}
        >
          <option value="">Workspace root</option>
          {meta.repos.map(r => (
            <option key={r.path} value={r.path}>
              {r.name}{r.role !== 'canonical' ? ` (${r.role})` : ''}{r.dirty ? ` · ${r.dirty} dirty` : ''}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Continue a session" hint="Leave blank to start a fresh one.">
        <select value={resume ?? ''} onChange={e => setResume(e.target.value || null)} className={inputClass}>
          <option value="">New session</option>
          {meta.sessions.slice(0, 20).map(s => (
            <option key={s.id} value={s.id}>
              {s.title.slice(0, 60)} · {s.project} · {ago(s.lastTs)}
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

      <Button variant="accent" className="w-full" onClick={go} disabled={busy}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {busy ? 'Starting…' : resume ? 'Continue the session' : 'Open in Claude Code'}
      </Button>
    </div>
  )
}

/** The honest result: what exists now, and how to reach it. */
function Result({ pack, copied, setCopied }: { pack: Pack; copied: boolean; setCopied: (v: boolean) => void }) {
  const [live, setLive] = useState(pack)

  // The status moves from running to done on its own; polling briefly means the
  // sheet shows what actually happened rather than freezing on "running".
  useEffect(() => {
    if (live.status !== 'running') return
    const t = setInterval(async () => {
      try {
        setLive(await launchApi.pack(pack.id))
      } catch {
        clearInterval(t)
      }
    }, 4_000)
    return () => clearInterval(t)
  }, [live.status, pack.id])

  const cmd = live.resumeCommand ?? ''

  return (
    <div className="pt-1 pb-2">
      <div className="flex items-center gap-2 mb-4">
        <span className={`w-2 h-2 rounded-full ${
          live.status === 'running' ? 'bg-accent' : live.status === 'done' ? 'bg-ok' : 'bg-bad'
        }`} />
        <span className="text-[14px] text-fg">
          {live.status === 'running' ? 'Session running' : live.status === 'done' ? 'Session finished' : 'Session failed'}
        </span>
        {live.status === 'running' && <Loader2 size={13} className="animate-spin text-fg-mute" />}
      </div>

      <Row label="Session" value={live.session_id ?? '(not reported)'} mono />
      <Row label="Directory" value={live.cwd} mono icon={<FolderGit2 size={12} />} />
      {live.error && <p className="text-[12.5px] text-bad my-3 leading-relaxed whitespace-pre-wrap">{live.error}</p>}

      {cmd && (
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-[0.08em] text-fg-mute mb-2">Rejoin it in a terminal</div>
          <button
            onClick={() => { void navigator.clipboard?.writeText(cmd); setCopied(true) }}
            className="w-full flex items-center gap-2 bg-ink-800 rounded-[10px] px-3 py-2.5 text-left
                       hover:bg-ink-700 transition-colors"
          >
            <Terminal size={13} className="text-fg-mute shrink-0" />
            <code className="text-[12px] font-mono text-fg-dim truncate grow">{cmd}</code>
            {copied ? <Check size={13} className="text-ok shrink-0" /> : <Copy size={13} className="text-fg-mute shrink-0" />}
          </button>
          <p className="text-[11.5px] text-fg-mute mt-2 leading-relaxed">
            That session is on the machine Wake runs on, under Claude Code’s own permissions.
            Wake did not widen them and cannot answer its prompts for you.
          </p>
        </div>
      )}

      <div className="mt-4 flex gap-1.5">
        <a
          href={launchApi.packFileUrl(pack.id)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 min-h-9 px-3 rounded-[10px] text-[13.5px]
                     text-fg-dim hover:text-fg hover:bg-ink-800 transition-colors"
        >
          <FileText size={14} /> Open the pack <ExternalLink size={12} className="text-fg-mute" />
        </a>
        {live.status === 'running' && (
          <Button variant="ghost" onClick={() => void launchApi.stop(pack.id)}>Stop</Button>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, mono, icon }: { label: string; value: string; mono?: boolean; icon?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="text-[11.5px] text-fg-mute w-[72px] shrink-0">{label}</span>
      <span className={`text-[12.5px] text-fg-dim truncate ${mono ? 'font-mono' : ''}`}>
        {icon}{value}
      </span>
    </div>
  )
}
