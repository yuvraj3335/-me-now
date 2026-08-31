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
 * So: one scroll, in the order the decision is actually made — which
 * repository, which session in it, which templates, which skills, what is
 * attached, what you want, and how it should run. The brief is the next beat,
 * at a size you can read. The only commit is the link.
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
 *
 * The repository is asked first because it is what that list is drawn from. It
 * used to be asked second, under a session menu that offered all thirty
 * sessions on the machine whatever repository was picked — five directories'
 * work in one list, none of it marked as belonging anywhere in particular.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight, Check, Copy, FileText, Loader2, Scissors, Search, Sparkles, SquareTerminal, X,
} from 'lucide-react'
import {
  Button, Empty, Menu, Segmented, Sheet, inputClass, rowStateClass, type MenuItem,
} from './primitives'
import {
  PERMISSION_MODES, closeLaunch, launchApi, openLaunch, removeFromLaunch,
  resetLaunch, resolveSkillIds, resumeCommand, setLaunchPermissionMode, setLaunchSession,
  useLaunchBasket, type LaunchState, type PackItem, type PermissionMode, type Session,
} from '../lib/launch'
import { handoffFor } from '../../shared/handoff'
import { repoForSession, sessionInRepo } from '../../shared/sessionRepo'
import { ago } from '../lib/time'
import { Mic } from './voice'

const KIND_LABEL: Record<string, string> = {
  card: 'Card', mail: 'Mail', slack: 'Slack', sentry: 'Sentry',
  notion: 'Notion', github: 'GitHub', session: 'Session', note: 'Note',
  // A task attached from Work rendered the raw string `task` in this column —
  // the one kind the map forgot, and the newest one.
  task: 'Task',
}

const sessionRef = (id: string) => `session:${id}`

/**
 * The two browsable lists on this sheet — templates, skills — share one shape:
 * an identity on the left with its check, and the sentence that says what the
 * thing is filling the rest. These three classes are that shape, in one place,
 * because the two lists drifted apart the moment they were written twice.
 *
 * **The name column is sized by the longest name in it.** It was a number
 * chosen once per list — `sm:w-40` for templates, `sm:w-52` for skills — and
 * both were wrong for their own data: measured at 1440×900, `Mapping — unified
 * vs proxy` wanted 162px against 122px of room, and twelve of the twenty-four
 * skill slugs on screen wanted up to 261px against 170px. Both lists ellipsised
 * names while the description beside them was nowhere near the edge of a 760px
 * dialog. A bigger fixed number is the same bug with a later trigger, since
 * both lists are data: `templates.ts` owns one and the machine's skill catalog
 * owns the other, and the next long name added breaks it again silently.
 *
 * So the rows share one grid and each row is a `subgrid` of it, which is the
 * only way separate row elements can agree on a column without one of them
 * measuring the others. The track is `fit-content(45%)`: as wide as the longest
 * name and no wider, and never past 45% of the row — the cap is what stops one
 * runaway slug from eating the description, and past it the `truncate` on the
 * label still catches the overflow. Measured: 200px for templates, 299px for
 * skills, nothing clipped in either, row height unchanged at 44px.
 *
 * From `sm` up only. Below it the row is a stack — name over description — for
 * the reason written on the templates section: two columns need about 340px and
 * a phone has 343 for both.
 */
const NAME_GRID = 'sm:grid sm:grid-cols-[fit-content(45%)_minmax(0,1fr)]'
const NAME_ROW = `w-full flex flex-col items-start gap-1 py-2
                  sm:grid sm:grid-cols-subgrid sm:col-span-2
                  sm:items-center sm:gap-0 sm:py-0 sm:min-h-11`
/** `min-w-0` is what lets the cap bite: without it the cell refuses to shrink
    below its own content and the row overflows instead of truncating. */
const NAME_CELL = 'w-full sm:w-auto min-w-0 shrink-0 flex items-center gap-2 sm:pr-4'

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
        /* `-mb-4` for the same reason as `-mx-4`: the bar breaks out of the
           padding on every edge it touches, so it comes to rest on the panel's
           own bottom edge rather than 16px above it with list rows sliding
           through the strip underneath. `Sheet` owns the other half of this —
           its bottom pad is inside the scrolled content precisely so a sticky
           box can reach past it. */
        <div className="sticky bottom-0 -mx-4 -mb-4 mt-4 px-4 py-3 bg-ink-850 border-t border-rule
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
      {/* Where the work is, before which conversation about it — the wider
          choice first, and the one the list under it is drawn from. */}
      <RepoPicker repos={meta.repos} cwd={cwd} setCwd={setCwd} />

      <SessionPicker
        sessions={meta.sessions} repos={meta.repos} repo={cwd}
        value={session} attached={items} setCwd={setCwd}
      />

      {/*
        Name beside description on a laptop, name over description on a phone.

        Two columns need about 340px to work and a 375px screen leaves 343 for
        both, so the split gave the name 122 and the description 181 against
        338 — every template's blurb cut mid-sentence (`A customer report, taken
        to …`, `One stack trace to the line th…`) and half the names cut with
        them. The blurb is the entire reason this list is browsable rather than
        a dropdown of slugs, so below `sm` it takes the whole width and wraps.
        The row stops being a fixed 44px there, because a row that wraps is not
        one line tall.
      */}
      <section className="py-4">
        {/* A label, not a readout. `Templates — 1` put a number where the name
            goes, and the number was already on screen: every chosen row has a
            check on it. */}
        <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Templates</h3>
        <div className={NAME_GRID}>
          {meta.templates.map(t => {
            const on = templates.includes(t.id)
            return (
              <button
                key={t.id}
                onClick={() => onToggleTemplate(t.id)}
                aria-pressed={on}
                /* This list stays inline rather than becoming a menu: it is a
                   multi-select, and its blurbs are the whole reason it is
                   browsable — a popup that closes on the first pick can be
                   neither. What it borrows from the rest of the product is the
                   row treatment, so a chosen row is a lit ground here exactly as
                   it is on the desk, instead of a check and nothing else. */
                className={`${NAME_ROW} text-left border-b border-rule last:border-0
                           ${rowStateClass({ selected: on })}`}
              >
                {/* A check, not a filled amber box. One selected template used to
                    be one accent mark, so choosing three spent the budget. */}
                <span className={NAME_CELL}>
                  <Check size={14} className={`shrink-0 ${on ? 'text-fg' : 'text-transparent'}`} />
                  <span className={`text-sm truncate ${on ? 'text-fg' : 'text-fg-mute'}`}>{t.label}</span>
                </span>
                {/* Two lines, not one clipped one. The blurb is the whole of what
                    tells `Sentry issue` from `Sync job failure`, and at 760px of
                    dialog a one-line clamp ellipsised half of them — the picker
                    then reads by title, which is the one thing 26 of these titles
                    cannot be told apart by. Two 18px lines still sit inside the
                    44px row, so the grid does not move. */}
                <span className="text-sm text-fg-mute sm:line-clamp-2 grow min-w-0">{t.blurb}</span>
              </button>
            )
          })}
        </div>
      </section>

      <SkillPicker all={meta.skills} selected={skills} onChange={setSkills} />

      <section className="py-4">
        {/*
          The unit once, over the column — not glued to every number.

          The cell read `36c`: a bare `c` with no header, no tooltip and nothing
          else on the sheet to expand it, which is a unit only the person who
          wrote it can read. What the eye wants to do with that column is
          compare down it, so the word moves up into an eyebrow beside the
          section's own and the cells stay numeric.

          The 38px is the remove control's own footprint — a `sm` Button's 30px
          plus the 8px it is padded by — so the eyebrow's right edge lands on
          the numbers' right edge instead of over the crosses.
        */}
        <div className="flex items-baseline mb-2">
          <h3 className="text-eyebrow uppercase text-fg-mute">Attachments</h3>
          {items.length > 0 && (
            <span className="ml-auto pr-[38px] text-eyebrow uppercase text-fg-mute">Characters</span>
          )}
        </div>
        {/* A line that names the state, not a dash. A dash is what a cell prints
            when a value is missing; a section with nothing in it is not a
            missing value, it is a brief that is going to be carried entirely by
            what is above and below this. */}
        {items.length === 0 && (
          <Empty>Nothing attached — this brief carries the templates above and your own instruction.</Empty>
        )}
        {items.map(i => (
          <div key={`${i.kind}:${i.ref}`} className="flex items-center h-11 border-b border-rule last:border-0">
            <span className="text-sm text-fg-mute w-24 shrink-0">{KIND_LABEL[i.kind] ?? i.kind}</span>
            <span className="text-sm text-fg-dim truncate grow min-w-0" title={i.ref}>
              {i.title ?? i.ref}
            </span>
            {/* What this attachment costs the link, before Write rather than
                after: the budget is the URL, and one long quote can spend it.
                The unit is the column's, up in the eyebrow. */}
            <span className="text-sm text-fg-mute tnum shrink-0 pl-3">
              {Math.min(i.excerpt?.length ?? 0, 2000).toLocaleString()}
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
 * The row that means "no session", as an id.
 *
 * `null` cannot carry a check, and "a new conversation" is a row like any
 * other. A session id is a UUID, so a leading colon cannot collide with one.
 */
const NEW_SESSION = ':new'

/**
 * The rows the session menu offers, in the order it prints them.
 *
 * Exported because the filter is the whole of what this control does, and it is
 * the part that cannot be seen to be right by looking at it.
 *
 * Two things keep a row out, and they are the same two everywhere else in the
 * product. It ran in another repository — `sessionInRepo`, the server's own
 * filter, so this menu and the Sessions page cannot disagree about what
 * "truto's sessions" means. Or he has archived it: putting a session away is
 * saying he is done with it, and a thing you are done with is not the default
 * context for new work. Thirteen of the thirty on this machine could be
 * archived, and offering them is what archiving exists to stop.
 *
 * `chosen` outranks both. A brief that is already about a session must be able
 * to name it — dropping the row would leave the trigger printing a dash over a
 * brief that says otherwise — so the session this brief carries survives the
 * repository filter *and* the archive filter, and its `title` is the fallback
 * for a session so old that this window has never seen it. Which is also the
 * way back to an archived one: open it from the Sessions page's Archived view
 * and it arrives here as the chosen row, named and pickable. Put away is not
 * out of reach; it is only out of the way.
 */
export function sessionChoices(
  sessions: readonly Session[],
  repo: string | null,
  chosen: { id: string; title: string | null } | null,
  known: readonly string[] = [],
): MenuItem[] {
  const seen = new Set<string>()
  const rows = sessions
    .filter(s => {
      // The two reads overlap by construction: `/state` sends the machine's
      // newest thirty and the repository read sends that repository's own.
      if (seen.has(s.id)) return false
      if (s.id !== chosen?.id) {
        if (repo && !sessionInRepo(s, repo)) return false
        if (s.archived) return false
      }
      seen.add(s.id)
      return true
    })
    .sort((a, b) => b.lastTs - a.lastTs)

  /*
   * Grouped by the repository each session is in — `known`, the repositories
   * this machine actually has, and the recorded directory only when none of
   * them contains it.
   *
   * The directory alone was the heading until the filter learned to match
   * under a repository, and then it broke the list it was meant to organise:
   * with `wake` chosen the menu printed three headings — `wake`,
   * `reverent-hertz-369f69`, `QA_EVIDENCE` — for one repository, and since
   * grouping reorders, the newest row of the second group sat below the oldest
   * of the first. A menu already scoped to one repository has one heading.
   *
   * `Menu` prints a heading whenever the group changes rather than nesting, so
   * rows sharing one have to arrive together — the sorted list alone would
   * print `truto` above every third row. Insertion order into the map is the
   * order of each group's newest session, which is the order to read them in.
   */
  const byRepo = new Map<string, { label: string; list: Session[] }>()
  for (const s of rows) {
    const home = repoForSession(s, known)
    const id = home ?? (s.project || s.cwd)
    const at = byRepo.get(id)
    if (at) { at.list.push(s); continue }
    byRepo.set(id, { label: home ? home.split('/').pop() || home : id, list: [s] })
  }

  const items: MenuItem[] = [{ id: NEW_SESSION, label: 'A new conversation' }]
  for (const { label: dir, list } of byRepo.values()) {
    for (const s of list) {
      items.push({
        id: s.id,
        label: s.title,
        group: dir,
        // One fact beside the name, which is what a menu row has room for.
        // Among sessions in one repository the title is often the same commit
        // message twice, so what tells them apart is when each last ran — and
        // `live` outranks an age, because a session running right now is the
        // one whose transcript is still moving.
        meta: s.live ? 'live' : ago(s.lastTs),
      })
    }
  }
  if (chosen && !seen.has(chosen.id)) {
    items.push({ id: chosen.id, label: chosen.title || 'The session this brief is about' })
  }
  return items
}

/**
 * Which session this brief is about — and the honest word for what that means.
 *
 * The sessions were already being fetched on every sheet open and thrown away.
 * Picking one does three things: it fills the working directory from the
 * directory that session actually ran in, it attaches the session as an object
 * so its last exchanges travel, and it puts the `claude --resume` line into the
 * brief. It does not resume anything, and the sentence under the heading says
 * so rather than leaving him to find out.
 *
 * It is a `Menu` now, for the reason every picker here is: the open list had no
 * ground, no edge and no z-index, it shoved the templates and the commit button
 * down the sheet as it opened, and it never marked which row was already
 * chosen. And it is given the repository, which it previously was not — so the
 * choice above it could not narrow this one even in principle.
 */
function SessionPicker({
  sessions, repos, repo, value, attached, setCwd,
}: {
  sessions: Session[]
  repos: LaunchState['repos']
  /** The chosen repository's path, or null for "not about one repository". */
  repo: string | null
  value: string | null
  /** The basket, which is where a session chosen elsewhere left its title. */
  attached: PackItem[]
  setCwd: (v: string | null) => void
}) {
  const [inRepo, setInRepo] = useState<Session[]>([])

  /*
   * A repository's sessions are asked for, not filtered out of what is to hand.
   *
   * `/state` sends the newest thirty sessions on the machine over thirty days,
   * whatever directory they ran in — so a repository he last touched three
   * weeks ago has none of its own in that thirty, and a filter alone would
   * answer "nothing here" for a repository full of work. Scoping the read is
   * what pays for asking the repository first: the list stops being the
   * machine's last thirty and becomes this repository's own.
   *
   * Thirty rows, and a year of days behind them. The count is what bounds the
   * menu — thirty because that is what the unscoped read already returns, one
   * page size said once, and because a menu you scroll for a minute is a page.
   * The year is not a second bound, it is what stops the first one being
   * useless: a busy repository fills thirty rows in a fortnight and a quiet one
   * needs months to fill any, so counting days would answer for neither. What
   * this asks for is a repository's newest thirty, however far back it reaches.
   */
  useEffect(() => {
    if (!repo) { setInRepo([]); return }
    let live = true
    launchApi.sessions({ repo, window: 365, limit: 30 })
      .then(r => { if (live) setInRepo(r.sessions) })
      // A widening that fails is not an error on this sheet: what `/state`
      // already sent is still a true list, only a shorter one.
      .catch(() => {})
    return () => { live = false }
  }, [repo])

  const known = useMemo(() => [...sessions, ...inRepo], [sessions, inRepo])
  const current = known.find(s => s.id === value) ?? null
  const chosen = value
    ? { id: value, title: current?.title ?? attached.find(i => i.ref === sessionRef(value))?.title ?? null }
    : null
  const repoPaths = useMemo(() => repos.map(r => r.path), [repos])
  const items = useMemo(
    () => sessionChoices(known, repo, chosen, repoPaths),
    [known, repo, chosen?.id, chosen?.title, repoPaths],
  )

  const pick = (s: Session | null) => {
    // The previous session's object goes with the previous session. Leaving it
    // attached would quote a transcript the brief no longer claims to be about.
    if (value) removeFromLaunch(sessionRef(value))
    if (!s) return setLaunchSession(null)

    setLaunchSession(s.id)
    // A session that ran somewhere else moves the repository to where it ran,
    // rather than sitting in a list that has just stopped describing it. A
    // session from a subdirectory or a worktree moves it to the repository that
    // contains it — the innermost one, so a checkout kept inside another
    // checkout is credited to itself.
    const home = repoForSession(s, repoPaths)
    if (home) setCwd(home)
    attachSession(s)
  }

  return (
    <section className="py-4">
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Session</h3>
      <Menu
        items={items}
        value={value ?? NEW_SESSION}
        onPick={id => pick(id === NEW_SESSION ? null : known.find(s => s.id === id) ?? null)}
        ariaLabel="Session"
        full
      />

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
 * A repository is chosen by a row like any other, so "none" needs an id.
 *
 * Every repository is an absolute path, so a leading colon cannot collide with
 * one — and `null` cannot be a menu value, because the row that says "not about
 * one repository" has to be able to carry the check.
 */
const NO_REPO = ':none'

/**
 * The repository — the first question, and now a real menu.
 *
 * It has been three controls. A native `<select>`, whose popup painted over the
 * object list and, on a phone, over the sheet. Then a collapsed row that opened
 * into more rows in document flow: no ground, no edge, no elevation, nothing
 * marking the row already chosen, and everything below it — templates, skills,
 * the one button that commits — pushed down the screen at the moment of
 * choosing. Now the shared `Menu`, which overlays rather than displaces and
 * says which one is current.
 */
function RepoPicker({
  repos, cwd, setCwd,
}: { repos: LaunchState['repos']; cwd: string | null; setCwd: (v: string | null) => void }) {
  const items = useMemo<MenuItem[]>(() => [
    { id: NO_REPO, label: 'Not about one repository' },
    ...repos.map(r => ({
      id: r.path,
      label: r.name,
      // Uncommitted work, because that is the fact that decides whether this is
      // the checkout he means — and a `<select>` could not have carried it.
      ...(r.dirty > 0 ? { meta: `${r.dirty} dirty` } : {}),
    })),
  ], [repos])

  return (
    <section className="py-4">
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Repository</h3>
      <Menu
        items={items}
        value={cwd ?? NO_REPO}
        onPick={id => setCwd(id === NO_REPO ? null : id)}
        ariaLabel="Repository"
        full
        mono
      />
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
 * How many skill rows the section paints before it offers the rest.
 *
 * Six 44px rows is 264px on a laptop — within a pixel or two of what the
 * porthole it replaces was painting — so the desktop list keeps its size and
 * only stops being a scroller.
 */
const PEEK = 6

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
 *
 * **And then it showed them through a porthole.** The list was
 * `max-h-64 overflow-y-auto` — measured on a phone, 256px of window over
 * 2555px of content, which is two and a half rows at a time, inside a sheet
 * body that was itself 665px over 1727px, under a ten-row template list.
 * A scroll inside a scroll inside a sheet, on the surface whose entire job is
 * "read this and tap once".
 *
 * It is not a `Menu`, and the two menus above it are the argument rather than
 * the counter-argument: both are single-choice, both close on the pick, and
 * neither carries a field. `Menu` rows are `menuitemradio` and its `onClick`
 * closes the panel — a multi-select that shuts after every choice is worse than
 * anything it would replace, and there is nowhere in it to put the search this
 * list is built around. Reaching for it would mean changing the shared
 * primitive that the repository and session pickers depend on, to make it
 * something neither of them wants.
 *
 * So the porthole goes instead of the list. A scroll inside a scroll is fixed
 * by removing the inner one, not by moving it into a popup that has its own.
 * The section shows `PEEK` rows and says how many more there are; pressing that
 * prints the rest inline, exactly as the template list above already prints all
 * of its ten. One scroller on the surface, and the commit strip is sticky, so
 * an expanded list cannot push the one button that commits out of reach.
 */
function SkillPicker({
  all, selected, onChange,
}: { all: LaunchState['skills']; selected: string[]; onChange: (next: string[]) => void }) {
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState(false)

  const matches = useMemo(() => {
    const term = q.trim().toLowerCase()
    // The haystack is everything a person might half-remember: the slug, the
    // human title, the catalog letter, and the sentence saying when to use it.
    // Searching only `name` meant "customer" found nothing while three skills
    // said "customer issue" in their own descriptions.
    if (!term) return all
    return all
      .filter(s => `${s.name} ${s.title ?? ''} ${s.whenToUse ?? ''} ${s.description ?? ''} ${s.catalog}`
        .toLowerCase().includes(term))
  }, [all, q])

  // The cap used to be a flat 24 rows behind a 256px window, so it was invisible
  // twice over: you could not see the rows it kept and you could not see that it
  // had kept any. Six is a browse window rather than a peephole — the same 264px
  // the porthole painted on a laptop — and what it hides is now on screen as a
  // count you can press.
  const shown = expanded ? matches : matches.slice(0, PEEK)

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])

  const named = (id: string) => all.find(s => s.id === id)


  return (
    <section className="py-4">
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Skills</h3>

      {selected.map(id => (
        <div key={id} className="flex items-center gap-2 h-8 border-b border-rule last:border-0">
          <Sparkles size={14} className="text-fg-mute shrink-0" />
          <span className="text-sm text-fg-dim truncate grow min-w-0 font-mono">
            {id.split('/').pop()}
          </span>
          {/* Gone below `sm`, rather than squeezed into 45% of a 343px row.
              This blurb's job is choosing, and on a row for something already
              chosen it is the second thing competing for a width that only
              holds one — so the phone keeps the identity and drops the pitch. */}
          <span className="hidden sm:block text-sm text-fg-mute truncate shrink-0 max-w-[55%]">
            {blurbOf(named(id))}
          </span>
          <Button size="sm" variant="ghost" title="Remove" ariaLabel="Remove" onClick={() => toggle(id)}>
            <X size={14} />
          </Button>
        </div>
      ))}

      {/* The field is 32px of box and, on a phone, was 18px of target: the input
          sat at its own line height inside the box and only that 18px band took
          a tap, so a thumb aimed at the middle of a control it could see missed
          it by 3px. `.hit-native` is the answer the product already has for a
          control that generates no `::after` — it grows the input itself to 44
          and hands the height straight back as a negative margin, so the box
          keeps painting 32. `h-full` is what makes the painted 32 the target on
          a mouse as well, instead of the same 18px band. */}
      <div className="mt-2 flex items-center gap-2 px-2 h-8 rounded-control border border-edge bg-ink-850">
        <Search size={14} className="text-fg-mute shrink-0" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={`Search ${all.length} skills`}
          // The placeholder is the only name this field has, and it is gone the
          // moment there is a character in it.
          aria-label="Search skills"
          className="hit-native [--hit-ink:32px] h-full flex-1 min-w-0 bg-transparent outline-none
                     text-sm text-fg placeholder:text-fg-mute"
        />
      </div>

      {/* The same row the templates above use, and it stacks on a phone for the
          same reason: an identity on the left with its check, and the sentence
          that tells you what it is filling the rest. The slug is the identity —
          26 of the 28 catalog `title` values are the slug again — so what makes
          a list of 28 readable is the description beside it, not the name
          printed twice, and a description cut at 181px is not one. */}
      <div className={NAME_GRID}>
        {shown.map(s => {
          const on = selected.includes(s.id)
          return (
            <button
              key={s.id}
              onClick={() => toggle(s.id)}
              aria-pressed={on}
              /* Inline, like the templates and for the same two reasons: it is
                 a multi-select, and it is searched. A menu closes on the first
                 pick and has nowhere to put the field. What it does take from
                 the menu is the answer to "which of these have I already
                 chosen?" — the row's own lit ground, not a check alone. */
              className={`${NAME_ROW} text-left border-b border-rule last:border-0
                         ${rowStateClass({ selected: on })}`}
            >
              <span className={NAME_CELL}>
                <Check size={14} className={`shrink-0 ${on ? 'text-fg' : 'text-transparent'}`} />
                <span className={`text-sm font-mono truncate ${on ? 'text-fg' : 'text-fg-mute'}`}>
                  {s.name}
                </span>
              </span>
              <span className="text-sm text-fg-mute sm:line-clamp-2 grow min-w-0">{blurbOf(s)}</span>
            </button>
          )
        })}
      </div>

      {/* The rest of the list, as a count rather than as a scrollbar. It says
          the number because the number is the fact being withheld, and it is
          the one place on this sheet a count belongs — the section heading is a
          label, not a readout.

          Bordered rather than ghost, because `Pager` is what this is: the
          control that reveals the rest of a list. A lone muted label under a
          list of muted rows reads as the list's caption. */}
      {matches.length > PEEK && (
        <div className="mt-2">
          <Button size="sm" variant="default" onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Show fewer' : `Show all ${matches.length}`}
          </Button>
        </div>
      )}

      {/* Two different nothings, and they are not the same sentence: a search
          that matched none of the catalog, and a machine with no catalog on it
          at all. Neither is a dash. */}
      {!matches.length && (
        <Empty>
          {q.trim()
            ? `No skill here matches ${q.trim()}.`
            : 'No skills on this machine.'}
        </Empty>
      )}
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
