/**
 * Open in Claude — one screen.
 *
 * There was a three-step wizard here: `1 Context · 2 Instruction · 3 Read it`,
 * with a clickable rail, a step whose primary action was a 38px amber button
 * labelled `Instruction` — a filled accent slab whose entire job was "go to the
 * next tab" — and a native `<select>` for the repository whose popup painted
 * over the object list it was supposed to sit under. Five amber marks in one
 * 460px sheet, for an operation whose real content is "confirm this text, then
 * tap".
 *
 * So: one scroll, in the order the decision is actually made — which session,
 * which repository, which templates, which skills, what is attached, what you
 * want, and how it should run. The brief is the next beat, at a size you can
 * read. The only commit is the link.
 *
 * That link is a real `<a>`, and its href is built here from the text as you
 * type (`src/shared/handoff.ts`, the same code the server uses). On a phone
 * `https://claude.ai/…` is a universal link, and only a genuine link navigation
 * hands it to the Claude app; `window.open` after an await lands in the browser
 * instead, which is the one outcome this whole flow exists to avoid. It also
 * means the character count under the field is honest — it is the same
 * arithmetic that decides what the link carries.
 *
 * **The session picker targets context, not continuity.** `claude.ai/new?q=`
 * opens a *new* conversation and no URL reaches an existing one, so choosing a
 * session puts its directory, its branch and its last exchanges into the brief
 * and prints the `claude --resume` line for the terminal. The UI says that in
 * those words rather than implying a resume it cannot perform. DECISIONS.md #35.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight, Check, Copy, FileText, Loader2, Scissors, Search, Sparkles, SquareTerminal, X,
} from 'lucide-react'
import { Button, Segmented, Sheet, inputClass } from './primitives'
import {
  PERMISSION_MODES, closeLaunch, launchApi, openLaunch, removeFromLaunch,
  resetLaunch, resolveSkillIds, resumeCommand, setLaunchPermissionMode, setLaunchSession,
  useLaunchBasket, type LaunchState, type PackItem, type PermissionMode, type Session,
} from '../lib/launch'
import { handoffFor } from '../../shared/handoff'
import { Mic } from './voice'

const KIND_LABEL: Record<string, string> = {
  card: 'Card', mail: 'Mail', slack: 'Slack', sentry: 'Sentry',
  notion: 'Notion', github: 'GitHub', session: 'Session', note: 'Note',
  // A task attached from Work rendered the raw string `task` in this column —
  // the one kind the map forgot, and the newest one.
  task: 'Task',
}

const sessionRef = (id: string) => `session:${id}`

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
          session={basket.session}
          permissionMode={basket.permissionMode}
        />
      )}
    </Sheet>
  )
}

function LaunchBody({
  items, preferred, repoHint, suggestedTitle, session, permissionMode,
}: {
  items: PackItem[]
  preferred: string[]
  repoHint: string | null
  suggestedTitle: string | null
  session: string | null
  permissionMode: PermissionMode
}) {
  const [meta, setMeta] = useState<LaunchState | null>(null)
  const [err, setErr] = useState<string | null>(null)
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
   * into the list above and the count changes with it.
   *
   * Both lists go through `resolveSkillIds` before they meet. A template names
   * `truto-cli-toolbelt`; the picker stores `B/truto-cli-toolbelt`; without
   * this the check never appeared on the row a template had already chosen, and
   * clicking it added a second copy of the same skill.
   */
  const templateSkills = useMemo(
    () => resolveSkillIds(meta?.skills ?? [], chosen.flatMap(t => t.skills)),
    [meta, chosen],
  )
  const effectiveSkills = skills ?? templateSkills

  if (err && !meta) return <p className="text-sm text-bad py-6">{err}</p>
  // Nothing while the machine is read. It takes one round trip and a sentence
  // saying so is chrome that teaches.
  if (!meta) return null

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
        sessionId: session,
        permissionMode,
      })
      setDraft({ packId: pack.id, brief: pack.first_message ?? '' })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /*
   * One scroll, in reading order: which session this is about, where the work
   * is, which templates and skills, what is attached, what you need and how it
   * should run — and then the brief itself, which is the last beat and the only
   * commit.
   */
  return (
    <div>
      <Composer
        items={items} meta={meta} cwd={cwd} setCwd={setCwd}
        skills={effectiveSkills} setSkills={setSkills}
        templates={templates}
        onToggleTemplate={id => {
          setTemplates(t => (t.includes(id) ? t.filter(x => x !== id) : [...t, id]))
          // A template's skills are a starting point, not an answer: dropping the
          // manual override lets the new selection's union show through.
          setSkills(null)
        }}
        instruction={instruction} setInstruction={setInstruction}
        session={session} permissionMode={permissionMode}
      />

      {draft ? (
        <Review packId={draft.packId} initial={draft.brief} handoff={meta.handoff}
          provenance={`${items.length} object${items.length === 1 ? '' : 's'} · ${
            cwd ? (meta.repos.find(r => r.path === cwd)?.name ?? 'no repository') : 'no repository'
          } · ${effectiveSkills.length} skill${effectiveSkills.length === 1 ? '' : 's'}`} />
      ) : (
        <div className="sticky bottom-0 -mx-4 mt-4 px-4 py-3 bg-ink-850 border-t border-rule
                        flex items-center">
          {/* The one commit on this surface, and the only amber on it. */}
          <Button size="lg" variant="primary" className="ml-auto" onClick={write} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
            {busy ? 'Writing' : 'Write the brief'}
          </Button>
        </div>
      )}

      {err && <p className="text-sm text-bad mt-3">{err}</p>}
    </div>
  )
}

/* -------------------------------- the sheet -------------------------------- */

/**
 * Hairline-separated blocks, each a heading and no paragraph.
 *
 * The objects are full-width rows rather than 16-character chips: a card with
 * three sources rendered three chips he could not tell apart, two of them
 * different Claude sessions. A row is the only place two sessions differ.
 */
function Composer({
  items, meta, cwd, setCwd, skills, setSkills, templates, onToggleTemplate,
  instruction, setInstruction, session, permissionMode,
}: {
  items: PackItem[]
  meta: LaunchState
  cwd: string | null
  setCwd: (v: string | null) => void
  skills: string[]
  setSkills: (v: string[]) => void
  templates: string[]
  onToggleTemplate: (id: string) => void
  instruction: string
  setInstruction: (v: string) => void
  session: string | null
  permissionMode: PermissionMode
}) {
  return (
    <div className="divide-y divide-rule">
      <SessionPicker
        sessions={meta.sessions} repos={meta.repos} value={session} setCwd={setCwd}
      />

      {/* An inline field, not a native `<select>`: its popup painted over the
          object list above it, which is the third clause of the fail photograph
          this sheet was in. */}
      <RepoPicker repos={meta.repos} cwd={cwd} setCwd={setCwd} />

      <section className="py-4">
        <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Templates — {templates.length}</h3>
        {meta.templates.map(t => {
          const on = templates.includes(t.id)
          return (
            <button
              key={t.id}
              onClick={() => onToggleTemplate(t.id)}
              aria-pressed={on}
              className="w-full flex items-center h-11 text-left border-b border-rule last:border-0
                         hover:bg-ink-800 transition-colors duration-100"
            >
              {/* A check, not a filled amber box. One selected template used to
                  be one accent mark, so choosing three spent the budget. */}
              <span className="w-40 shrink-0 flex items-center gap-2 pr-4">
                <Check size={14} className={`shrink-0 ${on ? 'text-fg' : 'text-transparent'}`} />
                <span className={`text-sm truncate ${on ? 'text-fg' : 'text-fg-mute'}`}>{t.label}</span>
              </span>
              <span className="text-sm text-fg-mute truncate grow min-w-0">{t.blurb}</span>
            </button>
          )
        })}
      </section>

      <SkillPicker all={meta.skills} selected={skills} onChange={setSkills} />

      <section className="py-4">
        <h3 className="text-eyebrow uppercase text-fg-mute mb-2">
          Attachments — {items.length}
        </h3>
        {items.length === 0 && <p className="text-sm text-fg-mute h-11 flex items-center">—</p>}
        {items.map(i => (
          <div key={`${i.kind}:${i.ref}`} className="flex items-center h-11 border-b border-rule last:border-0">
            <span className="text-sm text-fg-mute w-24 shrink-0">{KIND_LABEL[i.kind] ?? i.kind}</span>
            <span className="text-sm text-fg-dim truncate grow min-w-0" title={i.ref}>
              {i.title ?? i.ref}
            </span>
            {/* What this attachment costs the link, before Write rather than
                after: the budget is the URL, and one long quote can spend it. */}
            <span className="text-sm text-fg-mute tnum shrink-0 pl-3">
              {Math.min(i.excerpt?.length ?? 0, 2000).toLocaleString()}c
            </span>
            <span className="shrink-0 pl-2">
              <Button size="sm" variant="ghost" title="Remove" ariaLabel="Remove"
                onClick={() => removeFromLaunch(i.ref)}>
                <X size={14} />
              </Button>
            </span>
          </div>
        ))}
      </section>

      <section className="py-4">
        <h3 className="text-eyebrow uppercase text-fg-mute mb-2">What do you need?</h3>
        <GrowingField
          value={instruction}
          onChange={setInstruction}
          placeholder="Type what you need. The templates above fill this in if you leave it empty."
        />
      </section>

      <PermissionModeBlock mode={permissionMode} session={session} />
    </div>
  )
}

/**
 * The instruction field, at the size of the thing being written.
 *
 * It was `rows={4}` — a four-line box for the one paragraph on this sheet that
 * nobody else can write for him, under a list of templates each of which gets a
 * full row. So it grows with its content from a floor of 8rem, the way a
 * composer does, and stops at a height that still leaves the commit visible;
 * past that it scrolls.
 *
 * The height is set from `scrollHeight`, which needs the box collapsed first —
 * otherwise a deletion never shrinks it, because `scrollHeight` never drops
 * below the height already applied.
 */
function GrowingField({
  value, onChange, placeholder,
}: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`
  }, [value])

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${inputClass} min-h-32 leading-relaxed resize-none overflow-y-auto pr-10`}
      />
      <div className="absolute right-2 top-2">
        <Mic onText={t => onChange(value ? `${value} ${t}` : t)} title="Dictate the instruction" />
      </div>
    </div>
  )
}

/* ------------------------------- the session ------------------------------ */

/**
 * Which session this brief is about — and the honest word for what that means.
 *
 * The sessions were already being fetched on every sheet open and thrown away.
 * Picking one does three things: it fills the working directory from the
 * directory that session actually ran in, it attaches the session as an object
 * so its last exchanges travel, and it puts the `claude --resume` line into the
 * brief. It does not resume anything, and the sentence under the heading says
 * so rather than leaving him to find out.
 */
function SessionPicker({
  sessions, repos, value, setCwd,
}: {
  sessions: Session[]
  repos: LaunchState['repos']
  value: string | null
  setCwd: (v: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const current = sessions.find(s => s.id === value) ?? null

  /** Grouped by the directory each session recorded, newest group first. */
  const groups = useMemo(() => {
    const by = new Map<string, Session[]>()
    for (const s of sessions) {
      const key = s.project || s.cwd
      const list = by.get(key)
      list ? list.push(s) : by.set(key, [s])
    }
    return [...by.entries()]
  }, [sessions])

  const pick = (s: Session | null) => {
    // The previous session's object goes with the previous session. Leaving it
    // attached would quote a transcript the brief no longer claims to be about.
    if (value) removeFromLaunch(sessionRef(value))
    setOpen(false)
    if (!s) return setLaunchSession(null)

    setLaunchSession(s.id)
    const repo = repos.find(r => r.path === s.cwd) ?? repos.find(r => s.cwd.startsWith(`${r.path}/`))
    if (repo) setCwd(repo.path)
    attachSession(s)
  }

  return (
    <section className="py-4">
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Session</h3>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center h-11 border-b border-rule text-left
                   hover:text-fg transition-colors duration-100">
        <span className="text-sm text-fg-dim truncate grow min-w-0">
          {current ? current.title : 'A new conversation'}
        </span>
        <span className="text-sm text-fg-mute shrink-0 pl-3">{open ? 'Close' : 'Change'}</span>
      </button>

      {open && (
        <div className="max-h-64 overflow-y-auto">
          <button onClick={() => pick(null)}
            className="w-full flex items-center h-11 border-b border-rule text-left text-sm
                       text-fg-mute hover:bg-ink-800 transition-colors duration-100">
            A new conversation
          </button>
          {groups.map(([repo, list]) => (
            <div key={repo}>
              <p className="text-eyebrow uppercase text-fg-mute pt-3 pb-1">{repo}</p>
              {list.map(s => (
                <button key={s.id} onClick={() => pick(s)}
                  className="w-full flex items-center gap-2 h-11 border-b border-rule text-left
                             hover:bg-ink-800 transition-colors duration-100">
                  <SquareTerminal size={14} className="text-fg-mute shrink-0" />
                  <span className="text-sm text-fg-dim truncate grow min-w-0">{s.title}</span>
                  {s.live && <span className="text-sm text-ok shrink-0">live</span>}
                  <span className="text-sm text-fg-mute tnum shrink-0">{s.turns} in view</span>
                </button>
              ))}
            </div>
          ))}
          {!sessions.length && <p className="text-sm text-fg-mute h-11 flex items-center">—</p>}
        </div>
      )}

      {current && (
        <p className="text-sm text-fg-mute mt-2 leading-snug">
          Carried as context, not resumed — the link opens a new conversation. Its directory,
          branch and last exchanges go into the brief, with the command to rejoin it here.
        </p>
      )}
    </section>
  )
}

/** The session, as an object a brief can carry. */
function attachSession(s: Session) {
  openLaunch([{
    kind: 'session',
    ref: sessionRef(s.id),
    title: s.title,
    excerpt: s.lastPrompt,
    why: 'work already underway on my machine',
    meta: {
      session_id: s.id,
      cwd: s.cwd,
      branch: s.branch ?? null,
      // The floor, said as a floor. Only the tail of a transcript is read.
      turns_in_view: s.turns,
    },
  }])
}

/* ------------------------------ how it should run ------------------------- */

/**
 * The permission mode, and the one thing it cannot do.
 *
 * `claude.ai/new?q=` carries a prompt and nothing else — there is no parameter
 * for a permission mode and there is no way to add one. So this control does
 * not configure the conversation the link opens; it decides what the brief
 * *says*, and what the copyable command carries. Saying that plainly is
 * cheaper than a support conversation about why the setting "did not apply".
 */
function PermissionModeBlock({ mode, session }: { mode: PermissionMode; session: string | null }) {
  const [copied, setCopied] = useState(false)
  const command = session ? resumeCommand(session, mode) : null

  return (
    <section className="py-4">
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">How it should run</h3>
      <Segmented
        options={PERMISSION_MODES.map(m => ({ id: m.id, label: m.label }))}
        value={mode}
        onChange={setLaunchPermissionMode}
        ariaLabel="Permission mode"
      />
      <p className="text-sm text-fg-mute mt-2 leading-snug">
        The link cannot carry this — it opens a conversation with the brief in it and nothing else.
        The mode is written into the brief in words{command ? ', and into the command below.' : '.'}
      </p>
      {command && (
        <div className="mt-3 flex items-center gap-2">
          <code className="text-sm text-fg-dim font-mono truncate grow min-w-0">{command}</code>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try { await navigator.clipboard?.writeText(command); setCopied(true) }
              catch { setCopied(false) }
            }}
          >
            {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy resume command'}
          </Button>
        </div>
      )}
    </section>
  )
}

/**
 * The repository, as a list of rows.
 *
 * `<select>` was the only native popup in the product, and on a phone it covers
 * the sheet; on a laptop its menu painted straight over the object list. A
 * collapsed row that opens into rows behaves like everything else here.
 */
function RepoPicker({
  repos, cwd, setCwd,
}: { repos: LaunchState['repos']; cwd: string | null; setCwd: (v: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const current = repos.find(r => r.path === cwd)
  return (
    <section className="py-4">
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Repository</h3>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center h-11 border-b border-rule text-left
                   hover:text-fg transition-colors duration-100">
        <span className="text-sm text-fg-dim truncate grow min-w-0 font-mono">{current?.name ?? '—'}</span>
        <span className="text-sm text-fg-mute shrink-0 pl-3">{open ? 'Close' : 'Change'}</span>
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto">
          <button onClick={() => { setCwd(null); setOpen(false) }}
            className="w-full flex items-center h-11 border-b border-rule text-left text-sm
                       text-fg-mute hover:bg-ink-800 transition-colors duration-100">
            Not about one repository
          </button>
          {repos.map(r => (
            <button key={r.path} onClick={() => { setCwd(r.path); setOpen(false) }}
              className="w-full flex items-center h-11 border-b border-rule text-left
                         hover:bg-ink-800 transition-colors duration-100">
              <span className="text-sm font-mono truncate grow min-w-0">{r.name}</span>
              {r.dirty > 0 && <span className="text-sm text-fg-mute tnum shrink-0 pl-3">{r.dirty} dirty</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * The one sentence a skill row can afford.
 *
 * `description` is the frontmatter's own "use this when…" line and is the most
 * useful thing about a skill in a list; `whenToUse` is the fallback for the
 * catalogs that write it there instead. Cut at the first sentence, because the
 * rest of it is written for a router rather than for a person choosing.
 */
function blurbOf(s: { description?: string | null; whenToUse?: string | null } | undefined): string {
  const text = (s?.description ?? s?.whenToUse ?? '').trim()
  if (!text) return '—'
  const first = text.match(/^(.{20,}?\.)(\s|$)/)?.[1]
  return first ?? text
}

/**
 * Which skills the brief names.
 *
 * Named, never inlined — a skill body is tens of kilobytes and the brief has to
 * fit in a URL.
 *
 * **It used to show nothing until you typed.** `if (!term) return []` meant an
 * empty box rendered a heading, a placeholder reading `Search 28 skills`, and
 * zero skill names — so the answer to "which skills are there?" was "type one
 * and find out". The catalogs are 28 rows; a browsable list is what a list of
 * 28 things is. The search narrows it rather than summoning it.
 */
function SkillPicker({
  all, selected, onChange,
}: { all: LaunchState['skills']; selected: string[]; onChange: (next: string[]) => void }) {
  const [q, setQ] = useState('')

  const matches = useMemo(() => {
    const term = q.trim().toLowerCase()
    // The haystack is everything a person might half-remember: the slug, the
    // human title, the catalog letter, and the sentence saying when to use it.
    // Searching only `name` meant "customer" found nothing while three skills
    // said "customer issue" in their own descriptions.
    if (!term) return all.slice(0, 24)
    return all
      .filter(s => `${s.name} ${s.title ?? ''} ${s.whenToUse ?? ''} ${s.description ?? ''} ${s.catalog}`
        .toLowerCase().includes(term))
      .slice(0, 24)
  }, [all, q])

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])

  const named = (id: string) => all.find(s => s.id === id)


  return (
    <section className="py-4">
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Skills — {selected.length}</h3>

      {selected.map(id => (
        <div key={id} className="flex items-center gap-2 h-8 border-b border-rule last:border-0">
          <Sparkles size={14} className="text-fg-mute shrink-0" />
          <span className="text-sm text-fg-dim truncate grow min-w-0 font-mono">
            {id.split('/').pop()}
          </span>
          <span className="text-sm text-fg-mute truncate shrink-0 max-w-[55%]">
            {blurbOf(named(id))}
          </span>
          <Button size="sm" variant="ghost" title="Remove" ariaLabel="Remove" onClick={() => toggle(id)}>
            <X size={14} />
          </Button>
        </div>
      ))}

      <div className="mt-2 flex items-center gap-2 px-2 h-8 rounded-control border border-edge bg-ink-850">
        <Search size={14} className="text-fg-mute shrink-0" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={`Search ${all.length} skills`}
          className="flex-1 min-w-0 bg-transparent outline-none text-sm text-fg placeholder:text-fg-mute"
        />
      </div>

      {/* The same row the templates above use: an identity on the left with its
          check, and the sentence that tells you what it is filling the rest.
          The slug is the identity — 26 of the 28 catalog `title` values are the
          slug again — so what makes a list of 28 readable is the description
          beside it, not the name printed twice. */}
      <div className="max-h-64 overflow-y-auto">
        {matches.map(s => {
          const on = selected.includes(s.id)
          return (
            <button
              key={s.id}
              onClick={() => toggle(s.id)}
              aria-pressed={on}
              className="w-full flex items-center h-11 text-left border-b border-rule last:border-0
                         hover:bg-ink-800 transition-colors duration-100"
            >
              <span className="w-52 shrink-0 flex items-center gap-2 pr-4">
                <Check size={14} className={`shrink-0 ${on ? 'text-fg' : 'text-transparent'}`} />
                <span className={`text-sm font-mono truncate ${on ? 'text-fg' : 'text-fg-mute'}`}>
                  {s.name}
                </span>
              </span>
              <span className="text-sm text-fg-mute truncate grow min-w-0">{blurbOf(s)}</span>
            </button>
          )
        })}
      </div>
      {!matches.length && <p className="text-sm text-fg-mute h-11 flex items-center">—</p>}
    </section>
  )
}

/* ------------------------------- the brief -------------------------------- */

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
          /* `text-xs` on the one thing you have to read before sending it. A
             brief reviewed at 12px in a 760px box is not reviewed. */
          className={`${inputClass} font-mono text-sm leading-relaxed resize-y
                      h-[44vh] min-h-60 pr-10`}
        />
        <div className="absolute right-2 top-2">
          <Mic onText={insert} title="Dictate into the brief" />
        </div>
      </div>

      {/* One line, muted. It was two lines of amber prose about a formatting
          constraint. The brief itself still says it was trimmed, which is the
          part that matters, because the session is the one that needs to know. */}
      {link.trimmed && (
        <p className="mt-2 flex items-center gap-2 text-sm text-fg-mute">
          <Scissors size={14} className="shrink-0" />
          Trimmed to {handoff.maxChars.toLocaleString()} — the brief says so inside itself
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
          /* Through the same box every other control uses. This anchor and the
             detail pane's `Open` were the two hand-rolled `bg-accent` links in
             the product, so their height and radius drifted from everything
             else by construction. It keeps the accent because it is the commit
             on this surface — the only one. */
          className="relative inline-flex items-center justify-center gap-2 h-8 px-4
                     rounded-control bg-accent text-on-accent font-medium text-sm
                     hover:brightness-110 transition-colors duration-100"
        >
          <SquareTerminal size={14} /> Open in Claude <ArrowUpRight size={14} />
        </a>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            try { await navigator.clipboard?.writeText(brief); setCopied(true) }
            catch { setCopied(false) }
          }}
        >
          {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

    </div>
  )
}
