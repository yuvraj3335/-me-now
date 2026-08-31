/**
 * Write the brief — one screen, ending in a session that is actually running.
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
 * at a size you can read. There is one commit, and it is the last thing on the
 * page.
 *
 * **That commit starts a Claude Code process on this box.** It was an
 * `<a href="https://claude.ai/new?q=…">` — the Claude *chat* surface, which is a
 * different product: a new conversation every time, no repository, no tools,
 * nothing to resume, and a URL budget the brief had to be trimmed to fit. It is
 * now `POST /api/claude/terminals`, which starts or resumes a real session in
 * the chosen repository under the chosen `--permission-mode` with this brief as
 * its first message, and the sheet goes to `/terminal/<id>` — a real terminal,
 * on a laptop or a phone. Nothing is trimmed and there is no budget, so the
 * `N / 12,000` counter that used to sit under the field is gone with the thing
 * it counted. See HANDOFF_LAUNCH_API.md.
 *
 * **The session picker resumes.** It used to supply context and say so:
 * `claude.ai/new?q=` opened a new conversation, no URL reached an existing one,
 * so choosing a session put its directory and its last exchanges in the brief
 * and printed a `claude --resume` line to paste into a terminal he had to go and
 * find. That was honest about a hand-off nobody wants. A chosen session is now
 * `--resume <id>` in the directory it already ran in, with everything it already
 * knows, and no line anywhere on this sheet asks him to type a command.
 * DECISIONS.md #35 is the decision that has just been overtaken.
 *
 * The repository is asked first because it is what that list is drawn from. It
 * used to be asked second, under a session menu that offered all thirty
 * sessions on the machine whatever repository was picked — five directories'
 * work in one list, none of it marked as belonging anywhere in particular.
 *
 * **A Slack row is a thread parent, and the replies under it are the work.**
 * "we're seeing 500s on the sync" is the parent; the reply naming the account
 * and the hour is the answer. Every brief written off a Slack row used to carry
 * the question and none of the answers, so the replies Wake already holds are
 * listed here — author, words, when — and each is picked on its own. Not all of
 * them, not the channel, and never a direct message: the poll refuses those
 * before a card exists and the route refuses them again on the way out.
 *
 * **On a phone this is a page.** It was the same modal at every width, and at
 * 390px that modal was measured showing 693px of a 2,431px scroll — eleven
 * template rows, twenty-nine skills, a thread parent with its replies, the
 * attachments, two fields and the brief — under a 48px title bar, over a hundred
 * pixels of desk still visible and not reachable. A modal over a page is the
 * right shape for a question with three fields in it; this has never been that.
 * So below `sm` it takes the screen, with a back control and a chevron path
 * exactly like the card detail beside it. Same sections, same order, same
 * decisions, same one commit at the end: the room is what changed, not the flow.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUpRight, Check, ChevronLeft, ChevronRight, Copy, FileText, Link2, Loader2,
  Search, Sparkles, SquareTerminal, X,
} from 'lucide-react'
import {
  Button, Empty, Menu, Segmented, Sheet, inputClass, rowStateClass, type MenuItem,
} from './primitives'
import {
  PERMISSION_MODES, PHONE_COMPOSER, closeLaunch, composerIsAPage, launchApi,
  launchDraft, openLaunch, rememberLaunch, removeFromLaunch, resetLaunch,
  resolveSkillIds, setLaunchPermissionMode, setLaunchSession, useLaunchBasket,
  type LaunchState, type PackItem, type PermissionMode, type Session,
} from '../lib/launch'
import { useDetailKey, useRoute } from '../lib/route'
import { useOverlay } from '../lib/overlay'
import {
  messageWord, packItemFor, slackApi, slackLinkFor,
  type SlackThread, type SlackThreadItem,
} from '../lib/slackThreads'
import { openTerminalAndGo } from '../lib/terminal'
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

/**
 * `Open in Claude Code`, in full, because the missing two words were the whole
 * bug: this used to say `Open in Claude` over a control that opened claude.ai.
 * The product name is the honest title now that the product name is what it
 * opens. It is the sheet's title on a laptop and the last crumb on a phone.
 */
const COMPOSER_TITLE = 'Open in Claude Code'

/**
 * Which room the composer is drawn in — asked by width, because width is what
 * the answer is about.
 *
 * Not `pointer: coarse`, which is the right question for the terminal's key bar
 * and the wrong one here: a touchscreen laptop at 1440px has a coarse pointer
 * and acres of room, and giving it a full-viewport page would be answering a
 * question nobody asked. 640 is where the shell swaps its rail for a tab bar,
 * where `--nav-h` grows to 53px, and where every `sm:` below flips — so it is
 * where this flips too. Live rather than read once: a laptop window dragged
 * narrow gets the page, and dragged back gets the sheet.
 */
function useComposerIsAPage(): boolean {
  const [page, setPage] = useState(composerIsAPage)
  useEffect(() => {
    const mq = window.matchMedia(PHONE_COMPOSER)
    const on = () => setPage(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return page
}

export function LaunchSheet() {
  const basket = useLaunchBasket()
  const page = useComposerIsAPage()

  const body = basket.open && (
    <LaunchBody
      items={basket.items}
      preferred={basket.templates}
      repoHint={basket.repoHint}
      suggestedTitle={basket.title}
      session={basket.session}
      permissionMode={basket.permissionMode}
      page={page}
    />
  )

  if (page) return basket.open ? <LaunchPage>{body}</LaunchPage> : null

  return (
    <Sheet open={basket.open} onClose={closeLaunch} title={COMPOSER_TITLE} wide>
      {body}
    </Sheet>
  )
}

/**
 * The composer as a place, at the size a phone actually has.
 *
 * This is `DetailPage` in `pages/Home.tsx`, deliberately — the same portal, the
 * same `pad-top`, the same stop at `--nav-h`, the same reason for each. A fixed
 * box at `top: 0` starts under the notch, and the phone tab bar is not this
 * page's to cover: `styles.css` states that as a rule and the card sheet that
 * broke it made all six destinations unreachable while a card was open. Between
 * those two edges is the whole surface the shell gives anything, which is what a
 * page means here.
 *
 * `z-[52]`, and the two pixels are load-bearing. The ladder is 50 for a sheet
 * and for the card detail page, 55 for a `Menu` — which is what the repository
 * and session pickers on this very surface open as — and 60 for the palette.
 * This has to cover the card detail, because the card detail is what it is
 * usually opened from and is still standing behind it, and it has to stay under
 * its own menus. Two equal z-indexes would leave that to DOM insertion order,
 * which is true today and is not a thing to depend on.
 *
 * `useOverlay(true)` is the same non-decoration it is on the detail page: the
 * desk binds `j`, `k`, `e` and `s` to the document, two of those are destructive
 * and unconfirmed, and a surface that does not count itself leaves them live
 * underneath it.
 */
function LaunchPage({ children }: { children: React.ReactNode }) {
  useOverlay(true)

  return createPortal(
    <div
      style={{ bottom: 'var(--nav-h)' }}
      className="fixed inset-x-0 top-0 z-[52] pad-top flex flex-col bg-ink-900"
    >
      <LaunchPath onBack={closeLaunch} />
      {children}
    </div>,
    document.body,
  )
}

/**
 * Where the composer sits, and the way out of it, in one line.
 *
 * `‹ Card › Open in Claude Code`. The shape is `DetailPath`'s and the reasons
 * are its reasons: the first segment is the control, the rest is the sentence it
 * completes, and a bare chevron with no word beside it is a guess about what it
 * will close.
 *
 * The word on the control is *what is underneath*, not a fixed `Desk`. This
 * surface is opened from a card, a mail thread, a task on Work, a session and
 * the palette, and it does not navigate — it is a portal over whatever was
 * already there, which is still there, unscrolled and unchanged. So Back names
 * the thing it will uncover: a card whose detail is open, otherwise the
 * destination the reader is standing on.
 */
const BACK_TO: Record<string, [label: string, aria: string]> = {
  '/': ['Desk', 'Back to the desk'],
  '/mail': ['Mail', 'Back to Mail'],
  '/work': ['Work', 'Back to Work'],
  '/sessions': ['Sessions', 'Back to Sessions'],
  '/pulse': ['Pulse', 'Back to Pulse'],
  '/settings': ['Settings', 'Back to Settings'],
}

function LaunchPath({ onBack }: { onBack: () => void }) {
  const { path } = useRoute()
  // A key means a card's detail is the surface underneath. The bare `#card/`
  // sentinel is `''` and means he closed it on purpose, which is the desk.
  const card = useDetailKey()
  const [label, aria] = card
    ? ['Card', 'Back to the card'] as const
    : BACK_TO[path] ?? ['Wake', 'Back to Wake']

  return (
    <nav aria-label="Breadcrumb"
      className="shrink-0 flex items-center gap-1 pad-x py-1 border-b border-rule">
      <Button variant="default" size="sm" onClick={onBack}
        ariaLabel={aria} title={aria}
        className="shrink-0">
        <ChevronLeft size={14} aria-hidden /> {label}
      </Button>
      <ChevronRight size={12} aria-hidden className="shrink-0 text-fg-mute" />
      <span className="truncate text-sm text-fg-dim">{COMPOSER_TITLE}</span>
    </nav>
  )
}

function LaunchBody({
  items, preferred, repoHint, suggestedTitle, session, permissionMode, page,
}: {
  items: PackItem[]
  preferred: string[]
  repoHint: string | null
  suggestedTitle: string | null
  session: string | null
  permissionMode: PermissionMode
  /** Drawn as a full-viewport page rather than as a modal. See `LaunchSheet`. */
  page: boolean
}) {
  /*
   * The half-written brief, read once.
   *
   * Everything below used to start empty on every mount, and this component
   * unmounts the moment the surface closes — so leaving the composer to go and
   * read the thread underneath it cost him every word he had typed. `launch.ts`
   * holds the draft across that trip now and `openLaunch` empties it when the
   * next brief is a different one, so this is a resume rather than a leak. Read
   * during the first render rather than in an effect: seeding state from an
   * effect means one paint with an empty field, which on a resumed brief looks
   * exactly like the loss this exists to prevent.
   *
   * Copied, not referenced. `rememberLaunch` mutates the stored draft in place —
   * that is what makes it free to call on every keystroke — so holding the live
   * object here would give `seed` a different meaning on every render, and every
   * read of it below would silently become "as it is now" rather than "as it was
   * when this opened". Only the initialisers read it today; a copy is what keeps
   * that from mattering.
   */
  const seed = useRef({ ...launchDraft() }).current

  const [meta, setMeta] = useState<LaunchState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [templates, setTemplates] = useState<string[]>(
    seed.templates ?? (preferred.length ? preferred : ['blank']))
  const [cwd, setCwd] = useState<string | null>(seed.cwd)
  const [skills, setSkills] = useState<string[] | null>(seed.skills)
  const [instruction, setInstruction] = useState(seed.instruction)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<{ packId: string; brief: string } | null>(
    seed.brief ? { packId: seed.brief.packId, brief: seed.brief.text } : null)

  useEffect(() => {
    launchApi.state().then(setMeta).catch(e => setErr((e as Error).message))
  }, [])

  /* Every decision on this surface, written back where it survives an unmount.
     The brief's own text is remembered by `Review`, which is the only thing
     that holds it while it is being edited. */
  useEffect(() => {
    rememberLaunch({ templates, cwd, skills, instruction })
  }, [templates, cwd, skills, instruction])
  useEffect(() => {
    rememberLaunch({ brief: draft ? { packId: draft.packId, text: draft.brief } : null })
  }, [draft])

  const chosen = useMemo(
    () => (meta?.templates ?? []).filter(t => templates.includes(t.id)),
    [meta, templates],
  )

  /**
   * Where the work is. The card's own hint wins over the templates' default —
   * a Claude Code session card knows the directory it ran in, and throwing that
   * away is why every brief used to say `cwd /home/yuvraj/work`.
   *
   * It does not run on a resumed brief. This effect re-derives the repository
   * from the hint whenever the template list changes, which is the right answer
   * the first time and the wrong one afterwards: a repository he chose by hand,
   * left the composer and came back to would be quietly moved back to the card's
   * guess. A brief that arrives with a repository already in it has had that
   * question answered.
   */
  const resumed = useRef(seed.cwd !== null).current

  useEffect(() => {
    if (!meta || resumed) return
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

  /*
   * Which desk row this brief came off, kept once it is known.
   *
   * It rides in on the objects (`PackItem.group`), because the detail pane is
   * the only thing that sees a whole card and it hands over items and nothing
   * else. Sticky rather than recomputed: removing the card object from the
   * attachments below should not also take away the list of replies he was in
   * the middle of picking from.
   */
  const [group, setGroup] = useState<string | null>(null)
  useEffect(() => {
    const g = items.find(i => i.group)?.group
    if (g && g !== group) setGroup(g)
  }, [items])

  /* On a page these two answers have to fill the column they are in, or the
     path bar sits over a viewport-tall stripe of nothing. */
  const alone = page ? 'grow min-h-0 pad-x' : ''
  if (err && !meta) return <p className={`text-sm text-bad py-6 ${alone}`}>{err}</p>
  // Nothing while the machine is read. It takes one round trip and a sentence
  // saying so is chrome that teaches.
  if (!meta) return page ? <div className="grow min-h-0" /> : null

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

  const body = (
    <>
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
        group={group}
      />

      {draft ? (
        <Review
          packId={draft.packId} initial={draft.brief} session={session}
          page={page}
          // Off with a reason, rather than a commit that answers 503 after the
          // brief has been written and read. `missing` is the server's own
          // sentence naming which of tmux, python3 or the claude binary is not
          // on this box.
          blocked={meta.terminal && !meta.terminal.available.ok
            ? meta.terminal.available.missing ?? 'this machine cannot start a Claude Code session'
            : null}
          provenance={`${items.length} object${items.length === 1 ? '' : 's'} · ${
            cwd ? (meta.repos.find(r => r.path === cwd)?.name ?? 'no repository') : 'no repository'
          } · ${effectiveSkills.length} skill${effectiveSkills.length === 1 ? '' : 's'}`} />
      ) : (
        /* `-mb-4` for the same reason as `-mx-4`: the bar breaks out of the
           padding on every edge it touches, so it comes to rest on its
           scroller's own bottom edge rather than 16px above it with list rows
           sliding through the strip underneath. `Sheet` owns the other half of
           this on a laptop — its bottom pad is inside the scrolled content
           precisely so a sticky box can reach past it — and the page below
           carries the same arrangement for the same reason.

           The ground is the surface's own, which differs between the two: a
           sheet is `ink-850` and a page is `ink-900`, and a strip painted the
           wrong one is a 64px band of the other product.

           `-mb-4` only while there is nothing after it. A refusal from
           `createPack` prints below this strip, and a negative bottom margin
           with something following it does not free 16px, it pulls that
           something 16px up underneath the bar. */
        <div className={`sticky bottom-0 -mx-4 mt-4 px-4 py-3 border-t border-rule
                         flex items-center ${err ? '' : '-mb-4'}
                         ${page ? 'bg-ink-900' : 'bg-ink-850'}`}>
          {/* The one commit on this surface, and the only amber on it. */}
          <Button size="lg" variant="primary" className="ml-auto" onClick={write} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
            {busy ? 'Writing' : 'Write the brief'}
          </Button>
        </div>
      )}

      {err && <p className="text-sm text-bad mt-3">{err}</p>}
    </>
  )

  /*
   * One scroll, in reading order: which session this is about, where the work
   * is, which templates and skills, what is attached, what you need and how it
   * should run — and then the brief itself, which is the last beat and the only
   * commit.
   *
   * On a laptop that scroll belongs to `Sheet`, which owns the scroller and the
   * padding around it; here the content is handed over bare. On a phone this
   * component *is* the page below the path bar, so it owns both: `grow min-h-0`
   * takes whatever the path bar left, `overflow-y-auto` puts the one scroll
   * inside it, and the horizontal pad is `.pad-x` — the page pad, applied once
   * by the class that owns it — rather than the sheet's own `px-4`.
   *
   * The vertical pad is on the content and not on the scroller, which is the
   * rule `Sheet` already states and the reason a `sticky bottom-0` strip can
   * cancel it with `-mb-4` and come to rest on the real bottom edge.
   */
  if (page) {
    return (
      <div className="grow min-h-0 overflow-y-auto overscroll-contain pad-x">
        <div className="py-4">{body}</div>
      </div>
    )
  }

  return <div>{body}</div>
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
  instruction, setInstruction, session, permissionMode, group,
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
  /** The desk row, when this brief came off one. Null from the palette or Work. */
  group: string | null
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

      <TemplatePicker all={meta.templates} chosen={templates} onToggle={onToggleTemplate} />

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
            {/* 96px for a word that is never longer than `Session` — 55px at
                this size — is 40px a phone does not have. The title beside it
                is the only thing that tells two Slack replies apart and it had
                180px of a 358px row to do it in, minus the count and the cross.
                The laptop keeps the wider column, where a fact grid reads
                better for having one; below `sm` the column is the width of
                its own longest word. */}
            <span className="text-sm text-fg-mute w-16 sm:w-24 shrink-0">{KIND_LABEL[i.kind] ?? i.kind}</span>
            <span className="text-sm text-fg-dim truncate grow min-w-0" title={i.ref}>
              {i.title ?? i.ref}
            </span>
            {/* How much of this object the brief actually quotes, before Write
                rather than after. It used to be here because the link had a
                budget and one long quote could spend it; the link is gone and
                the number is not — `PER_ITEM_QUOTE_CHARS` still cuts any single
                attachment at 2,000 characters, so this is the column that says
                which quote is about to be cut. The unit is up in the eyebrow. */}
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

      {/* Directly under the attachments, because that is what it adds to: the
          replies picked here become rows in the list above, with their own refs
          and their own links, and can be taken off from either place. */}
      <SlackPicker group={group} attached={items} />

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

/* ------------------------------ the templates ----------------------------- */

/**
 * Which template, or templates — and the one that is not a template like the
 * others.
 *
 * Name beside description on a laptop, name over description on a phone. Two
 * columns need about 340px to work and a 375px screen leaves 343 for both, so
 * the split gave the name 122 and the description 181 against 338 — every
 * blurb cut mid-sentence (`A customer report, taken to …`, `One stack trace to
 * the line th…`) and half the names cut with them. The blurb is the entire
 * reason this list is browsable rather than a dropdown of slugs, so below `sm`
 * it takes the whole width and wraps. The row stops being a fixed 44px there,
 * because a row that wraps is not one line tall.
 *
 * **The voice rows are under their own heading.** Ten of these say what to find
 * out; the Humanizer says how the last message reads, and it is meant to be
 * chosen on top of one of the others rather than instead of one. As eleven
 * identical rows in one list that is unreadable — the list's own shape says
 * "pick one of eleven jobs", and the first thing anybody would assume is that
 * choosing `Humanizer` un-chooses `Customer incident`. A heading is the one
 * treatment that fixes it without adding a second: the rows keep exactly the
 * check, the ground and the blurb they have everywhere else, and what changes
 * is the sentence the group is filed under.
 *
 * `kind` is optional on the wire and absent means `investigation`, so a `/state`
 * that does not send it yet renders precisely the flat list this replaced —
 * `voice` is empty, the heading is not printed, and the Humanizer falls to the
 * bottom of the main list on its own, which is where `TEMPLATES` already puts
 * it. Degraded, not broken, and never an empty heading over nothing.
 */
function TemplatePicker({
  all, chosen, onToggle,
}: {
  all: LaunchState['templates']
  chosen: string[]
  onToggle: (id: string) => void
}) {
  const work = all.filter(t => t.kind !== 'voice')
  const voice = all.filter(t => t.kind === 'voice')

  const row = (t: LaunchState['templates'][number]) => {
    const on = chosen.includes(t.id)
    return (
      <button
        key={t.id}
        onClick={() => onToggle(t.id)}
        aria-pressed={on}
        /* This list stays inline rather than becoming a menu: it is a
           multi-select, and its blurbs are the whole reason it is browsable —
           a popup that closes on the first pick can be neither. What it borrows
           from the rest of the product is the row treatment, so a chosen row is
           a lit ground here exactly as it is on the desk, instead of a check and
           nothing else. */
        className={`${NAME_ROW} text-left border-b border-rule last:border-0
                   ${rowStateClass({ selected: on })}`}
      >
        {/* A check, not a filled amber box. One selected template used to be one
            accent mark, so choosing three spent the budget. */}
        <span className={NAME_CELL}>
          <Check size={14} className={`shrink-0 ${on ? 'text-fg' : 'text-transparent'}`} />
          <span className={`text-sm truncate ${on ? 'text-fg' : 'text-fg-mute'}`}>{t.label}</span>
        </span>
        {/* Two lines, not one clipped one. The blurb is the whole of what tells
            `Sentry issue` from `Sync job failure`, and at 760px of dialog a
            one-line clamp ellipsised half of them — the picker then reads by
            title, which is the one thing 26 of these titles cannot be told apart
            by. Two 18px lines still sit inside the 44px row, so the grid does
            not move. */}
        <span className="text-sm text-fg-mute sm:line-clamp-2 grow min-w-0">{t.blurb}</span>
      </button>
    )
  }

  return (
    <section className="py-4">
      {/* A label, not a readout. `Templates — 1` put a number where the name
          goes, and the number was already on screen: every chosen row has a
          check on it. */}
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Templates</h3>
      <div className={NAME_GRID}>{work.map(row)}</div>

      {voice.length > 0 && (
        <>
          {/* The heading carries the whole of the distinction, so it says it
              rather than naming a category and leaving him to guess. `mt-4` is
              the same air the section headings above get. */}
          <h3 className="text-eyebrow uppercase text-fg-mute mb-2 mt-4">Voice, worn over the above</h3>
          <div className={NAME_GRID}>{voice.map(row)}</div>
        </>
      )}
    </section>
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
 * Which session this brief goes to.
 *
 * The sessions were already being fetched on every sheet open and thrown away.
 * Picking one does three things: it fills the working directory from the
 * directory that session actually ran in, it attaches the session as an object
 * so its last exchanges are named in the brief, and — the part that used to be
 * impossible — it makes the commit `--resume <id>` rather than a new session.
 * The sentence under the heading used to explain that this was context and not
 * continuity, because a link to a chat surface could not be anything else. It
 * now says what happens, which is shorter.
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
        /*
         * What used to be here was a sentence and a `claude --resume …` line
         * with a Copy button on it: a UI whose final act was printing a command
         * for him to paste into a terminal he had to go and find. That is the
         * defined failure of this work, so the line is gone and the control that
         * carried it opens the session instead.
         *
         * It sits beside the sentence rather than beside the permission mode,
         * where the copyable command used to live, because it is about *this
         * session* — the one named in the menu directly above it — and not about
         * how the next one should run.
         */
        <div className="mt-2 flex flex-col sm:flex-row sm:items-start gap-2">
          <p className="text-sm text-fg-mute leading-snug grow min-w-0">
            The brief goes to this session — resumed where it stopped, with everything it already
            knows. Its directory fills in the repository above, and its last exchanges are attached
            below so the brief can name them.
          </p>
          <ResumeButton sessionId={current.id} />
        </div>
      )}
    </section>
  )
}

/**
 * Open the session now, without a brief.
 *
 * The other half of the same door: sometimes what he wants is not to write
 * anything, it is to be back inside the session he was in. `openTerminalAndGo`
 * reattaches when it is already running and `--resume`s when it is not, so this
 * is one control for both, and either way it ends on `/terminal/<id>` with a
 * cursor in it rather than on a command he has to carry somewhere.
 *
 * A refusal — the box has no tmux, the session is not on this machine — comes
 * back as the server's own sentence and is printed under the control. It is not
 * swallowed and it is not a status code.
 */
function ResumeButton({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const go = async () => {
    setBusy(true)
    setErr(null)
    try {
      await openTerminalAndGo({ sessionId })
      resetLaunch()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shrink-0">
      <Button size="sm" variant="secondary" onClick={go} disabled={busy}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <SquareTerminal size={14} />}
        {busy ? 'Opening' : 'Open the session'}
      </Button>
      {err && <p className="text-sm text-bad mt-2 leading-snug">{err}</p>}
    </div>
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

/* --------------------------------- Slack ---------------------------------- */

/**
 * The messages under a Slack row, one at a time.
 *
 * A desk Slack row *is* the thread parent — that is what `buildThreadCard`
 * makes a card out of — and the parent is the question. "we're seeing 500s on
 * the sync" is the parent; the reply four down naming the account, the region
 * and the hour is the answer, and it was in no brief this sheet has ever
 * written. So the replies Wake already stored are listed here and picked
 * individually.
 *
 * Four rules, and each of them is a thing the obvious version gets wrong:
 *
 *   1. **One, several, or none.** Not a switch that carries "the thread", and
 *      never "the channel". Half of a busy thread is other people arranging a
 *      call, and a brief that quotes it has spent its attention on that.
 *   2. **A row with no replies renders nothing at all.** No empty state, no
 *      `0 replies`, no placeholder — the parent is already an attachment above,
 *      so an empty section here would be a heading over a fact already shown.
 *   3. **The count is `reply_total`.** Slack's own header number. Only the
 *      newest twenty are stored, so `replies.length` would report a
 *      forty-message thread as a twenty-message one and nothing on screen would
 *      say which number was being read.
 *   4. **An alert row has no parent** (`parent: null`, everything in `replies`),
 *      because its members are separate top-level messages that Wake grouped —
 *      not answers to anything. It gets no parent chrome and its messages are
 *      called messages.
 *
 * Direct messages cannot appear. The poll refuses them before a card exists and
 * this route re-applies the same predicate on the way out; there is nothing to
 * filter here and, more to the point, nothing on this surface should suggest one
 * could be chosen.
 *
 * The selection is the basket, not local state. A picked reply is an attachment
 * exactly like every other object — it appears in the list above, it is counted
 * in the provenance line, and it can be taken off from either place. That is
 * also what makes "the unselected ones are not in the pack" true by
 * construction rather than by a filter somebody has to remember to write.
 */
function SlackPicker({ group, attached }: { group: string | null; attached: PackItem[] }) {
  const [threads, setThreads] = useState<SlackThread[]>([])
  const [pasteErr, setPasteErr] = useState<string | null>(null)

  /*
   * One read, and it is a read of what is already on disk.
   *
   * `/cards/:group/slack` serves stored cards, so this cannot 502 while he is
   * writing and does not wait on Slack being reachable. A failure here is
   * silent on purpose: it means this row's conversation is not offered, which
   * is the state the sheet was in yesterday, and a red line about a widening
   * that did not happen is noise on a surface whose job is elsewhere.
   */
  useEffect(() => {
    if (!group) { setThreads([]); return }
    let live = true
    slackApi.forCard(group)
      .then(r => { if (live) setThreads(r.threads) })
      .catch(() => {})
    return () => { live = false }
  }, [group])

  const has = (ref: string) => attached.some(i => i.ref === ref)
  const toggle = (entry: SlackThreadItem) =>
    has(entry.ref) ? removeFromLaunch(entry.ref) : openLaunch([packItemFor(entry)])

  /* Rule 2, stated once: a thread with nothing said under it is not rendered.
     The heading and the paste field below stay — that pair is a control for
     attaching something Wake never listed, which is a different thing from an
     empty state and is at its most useful on exactly the rows that have no
     conversation on them. */
  const withReplies = threads.filter(t => t.replies.length > 0)

  return (
    <section className="py-4">
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Slack</h3>

      {withReplies.map(t => (
        <div key={`${t.channel_id}:${t.thread_ts}`} className="mb-3 last:mb-0">
          {/* The channel and the size of the conversation, on one line. The
              number is Slack's, and when it is bigger than what Wake holds the
              line says both — "40 replies · the newest 20 are here" is a fact
              he can act on; a bare 20 is a number that quietly disagrees with
              the one in Slack. */}
          <p className="text-sm text-fg-mute mb-1">
            {t.channel ?? 'Slack'} · {messageWord(t, t.reply_total)}
            {t.reply_total > t.replies.length && ` · the newest ${t.replies.length} are here`}
            {t.partial && ' · Wake’s last read of this thread did not finish'}
          </p>

          {/* The parent, when there is one. It is normally already attached —
              its ref is the card's own ref — so this row is usually a statement
              rather than an offer, and the check says which. An alert row has
              no parent and gets no row: nothing there answers anything. */}
          {t.parent && <SlackRow entry={t.parent} on={has(t.parent.ref)} onToggle={toggle} parent />}

          {t.replies.map(r => (
            <SlackRow key={r.ref} entry={r} on={has(r.ref)} onToggle={toggle} />
          ))}
        </div>
      ))}

      {/* Always here, and it is the only part of this section that is. The desk
          lists what the poll found; he can always see one more thing than the
          poll asked about, and on a row with no Slack on it at all this is the
          whole of what the section is for. */}
      <div className={withReplies.length ? 'mt-3' : ''}>
        <SlackPasteField
          onAttached={entry => { openLaunch([packItemFor(entry)]); setPasteErr(null) }}
          onRefused={setPasteErr}
        />
        {pasteErr && <p className="text-sm text-bad mt-2 leading-snug">{pasteErr}</p>}
      </div>
    </section>
  )
}

/**
 * One message, as a row you can press.
 *
 * The whole row toggles, and the link out of it is a separate control rather
 * than the row itself — pressing a message to read it in Slack and pressing it
 * to put it in a brief are two different intentions, and one target cannot be
 * both.
 *
 * That link is `app ?? href` — the `slack://` form when the ids exist to build
 * one, the https permalink when they do not. It is the rule `appLinks.ts`
 * already states: the app form is where a person actually wants to land on a
 * laptop or a phone, and the durable https one is what gets stored in the pack
 * and shared. Both travel: the pack item's `url` is the permalink and its
 * `open_in_app` is the app link, so nothing has to choose for the session later.
 *
 * On a phone the row stacks — author and time on the first line, words on the
 * second — for the same reason the template rows do: two columns need about
 * 340px and there are 343 to spend.
 */
function SlackRow({
  entry, on, onToggle, parent,
}: {
  entry: SlackThreadItem
  on: boolean
  onToggle: (e: SlackThreadItem) => void
  parent?: boolean
}) {
  return (
    <div className={`flex items-start gap-2 border-b border-rule last:border-0 ${rowStateClass({ selected: on })}`}>
      <button
        onClick={() => onToggle(entry)}
        aria-pressed={on}
        className="flex-1 min-w-0 text-left py-2 sm:py-0 sm:min-h-11
                   flex flex-col sm:flex-row sm:items-center gap-x-3"
      >
        {/* Who, and what kind of message this is. On a phone this is the first
            of two lines and the age rides along at its right end; on a laptop
            it is a 160px column and the age goes to the far right, where a
            column of ages can be compared down. Rendered twice rather than
            positioned twice — the same trick the skill rows use for a blurb
            that only exists above `sm`. */}
        <span className="flex items-center gap-2 w-full sm:w-40 sm:shrink-0 min-w-0">
          <Check size={14} className={`shrink-0 ${on ? 'text-fg' : 'text-transparent'}`} />
          <span className={`text-sm truncate ${on ? 'text-fg' : 'text-fg-mute'}`}>
            {entry.who ?? 'Slack message'}
          </span>
          {/* `Thread` is what Slack calls the message the others hang off, and
              an alert row has none so it never prints. `You` is worth saying
              because his own message being in this list is deliberate: picking
              what you said yourself is legitimate context, and the alternative
              — hiding it — looks exactly like a bug. */}
          {parent && <span className="text-sm text-fg-mute shrink-0">Thread</span>}
          {entry.mine && <span className="text-sm text-fg-mute shrink-0">You</span>}
          {entry.at !== null && (
            <span className="sm:hidden ml-auto pl-2 text-sm text-fg-mute tnum shrink-0">
              {ago(entry.at)}
            </span>
          )}
        </span>
        {/* Two lines on a phone, one on a laptop. This is the whole of what
            tells one reply from another, and a 45-character clip of a 280
            character message is not enough to pick with — the same argument
            the template blurbs won on the section above. */}
        <span className="text-sm text-fg-dim grow min-w-0 line-clamp-2 sm:line-clamp-1 pl-[22px] sm:pl-0">
          {entry.excerpt || 'No words in this message'}
        </span>
        {entry.at !== null && (
          <span className="hidden sm:block text-sm text-fg-mute tnum shrink-0">{ago(entry.at)}</span>
        )}
      </button>
      <a
        href={slackLinkFor(entry)}
        target="_blank"
        rel="noreferrer"
        title="Open this message in Slack"
        aria-label="Open this message in Slack"
        /* 44 by 44 outright rather than a small box wearing `.hit`. That class
           draws its collar *outside* the control, and in a list every row's
           collar overlaps its neighbours' — the last one painted takes the tap,
           which on a picker means opening Slack when he meant to tick the row
           below. A control in a list has no reason to fake its height. */
        className="shrink-0 self-center inline-flex items-center justify-center h-11 w-11
                   rounded-control text-fg-mute hover:text-fg-dim hover:bg-ink-800
                   transition-colors duration-100"
      >
        <ArrowUpRight size={14} />
      </a>
    </div>
  )
}

/**
 * A Slack link he pastes.
 *
 * The desk lists what the poll found, and he can always see one more thing than
 * the poll asked about: a message in a channel Wake does not read, a link a
 * colleague sent him. `POST /api/slack/link` answers with the same item a listed
 * reply is — and, when the message happens to be one Wake *has* stored, with the
 * real author and the real words rather than an empty shell the brief would
 * quote as silence.
 *
 * A refusal is a sentence written for a person — a direct message, a link that
 * names a channel rather than a message, something that is not Slack at all —
 * so it is shown as it arrived. There is nothing for the browser to add to it
 * and nothing to translate.
 *
 * Enter submits, because a paste is followed by a return key and a field whose
 * only companion is a button beside it should not need the mouse.
 */
function SlackPasteField({
  onAttached, onRefused,
}: {
  onAttached: (entry: SlackThreadItem) => void
  onRefused: (reason: string) => void
}) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const attach = async () => {
    const v = url.trim()
    if (!v || busy) return
    setBusy(true)
    try {
      const { item } = await slackApi.link(v)
      onAttached(item)
      setUrl('')
    } catch (e) {
      onRefused((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {/* The same box the skill search uses, and `.hit-native` for the same
          reason: the input paints 32px and takes a 44px tap, because at its own
          line height it was an 18px band inside a control you could see. */}
      <div className="flex items-center gap-2 px-2 h-8 rounded-control border border-edge bg-ink-850
                      grow min-w-0">
        <Link2 size={14} className="text-fg-mute shrink-0" />
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void attach() }}
          placeholder="Paste a Slack message link"
          aria-label="Paste a Slack message link"
          className="hit-native [--hit-ink:32px] h-full flex-1 min-w-0 bg-transparent outline-none
                     text-sm text-fg placeholder:text-fg-mute"
        />
      </div>
      <Button size="md" variant="default" onClick={() => void attach()} disabled={busy || !url.trim()}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : 'Attach'}
      </Button>
    </div>
  )
}

/* ------------------------------ how it should run ------------------------- */

/**
 * The permission mode — which is now a flag rather than a wish.
 *
 * This block used to open by saying what it could not do. `claude.ai/new?q=`
 * carries a prompt and nothing else: there is no parameter for a permission mode
 * and no way to add one, so the control decided what the brief *said* about how
 * it should run, and what the `claude --resume … --permission-mode …` line
 * underneath it carried for him to paste. Both halves of that are gone. The
 * session is started by Wake, on this box, and this is the flag it is started
 * with, so the sentence is one clause and there is nothing to copy.
 *
 * `session` is still a prop because the mode reads differently for a resume: a
 * session that is already running keeps the mode it was started with, and a
 * control that silently claims otherwise is the same class of lie this block
 * just stopped telling.
 */
function PermissionModeBlock({ mode, session }: { mode: PermissionMode; session: string | null }) {
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
        {session
          ? 'The session starts under this the first time Wake starts it. One that is already running keeps the mode it has.'
          : 'The session is started with this as its --permission-mode, and the brief says so in words as well.'}
      </p>
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
 * The brief, editable, and the one control that commits it.
 *
 * Everything here answers one question before you press it: *is this what I want
 * to send?* So the text is the largest thing on screen, and the session gets
 * whatever the field currently says — not the draft Wake happened to render
 * first, which is why this step exists at all.
 *
 * **Pressing it starts a process.** `openTerminalAndGo({ packId, brief })` posts
 * to `/api/claude/terminals`, which marks the pack opened, writes the edited
 * text back to the pack file, starts or resumes the session with the brief as
 * its first message, and hands back the route to watch it on. Then the sheet
 * goes there. `launchApi.open()` is deliberately *not* also called: it does the
 * same recording, and calling both would start two sessions.
 *
 * **There is no counter under the field any more.** There used to be `N / 12,000`
 * and a `Trimmed to 12,000` line, and both were true of a `claude.ai/new?q=` URL,
 * which has a length a browser will refuse. A brief handed to a process on this
 * box is passed whole. Leaving a budget on screen would have been a number
 * measuring nothing, on the one surface whose entire job is to be read before it
 * is trusted.
 *
 * A refusal — no tmux on the box, a repository that is not in the registry, a
 * session id that is not on this machine — comes back as the server's own
 * sentence and is printed under the control. It is never swallowed: the sheet
 * stays open, with the brief still in it, so the next press can be a different
 * decision rather than a retype.
 */
function Review({
  packId, initial, session, blocked, provenance, page,
}: {
  packId: string
  initial: string
  /** The session being resumed, if one was chosen. It changes the verb. */
  session: string | null
  /** Why this box cannot start a session at all, in the server's words. */
  blocked: string | null
  provenance: string
  /** Drawn on the phone's page rather than in the sheet. See `LaunchSheet`. */
  page: boolean
}) {
  const [brief, setBrief] = useState(initial)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)

  /* The edited text, not the draft Wake rendered — the same distinction the
     commit itself makes. Leaving the composer with a brief half-rewritten and
     coming back to the version the server first wrote would be the loss this
     surface exists to prevent, one step further along than the instruction
     field. See `rememberLaunch`. */
  useEffect(() => { rememberLaunch({ brief: { packId, text: brief } }) }, [packId, brief])

  const open = async () => {
    setBusy(true)
    setErr(null)
    try {
      await openTerminalAndGo({ packId, brief })
      resetLaunch()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

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
      {/* What this brief is made of. The character count that used to end this
          line is gone with the URL that needed it. */}
      <p className="text-sm text-fg-mute mb-2 tnum">{provenance}</p>

      <div className="relative">
        <textarea
          ref={ref}
          value={brief}
          onChange={e => setBrief(e.target.value)}
          spellCheck={false}
          /*
            `text-xs` on the one thing you have to read before sending it. A
            brief reviewed at 12px in a 760px box is not reviewed.

            And on a phone, one reviewed through 44vh of a sheet is not reviewed
            either. That number was measured against a `760px` dialog on a
            laptop; at 390px it was 371px of window inside a scroller that also
            held eleven template rows above it, which is the "read it through a
            slot" this whole change is about. On the page it is the screen less
            the four things that are not the brief — the safe-area top, the path
            bar, this provenance line and the commit strip, about 200px between
            them — so the brief gets ~590px of an 844px phone and the reader
            scrolls the text rather than the surface it is in.
          */
          className={`${inputClass} font-mono text-sm leading-relaxed resize-y min-h-60 pr-10
                      ${page ? 'h-[calc(100dvh-var(--nav-h)-200px)]' : 'h-[44vh]'}`}
        />
        <div className="absolute right-2 top-2">
          <Mic onText={insert} title="Dictate into the brief" />
        </div>
      </div>

      {/*
        The commit, pinned on a phone and inline on a laptop.

        In the sheet this row sits where it falls, directly under the field,
        because the sheet is 760px of laptop and the whole of it is on screen.
        On the page the field above is deliberately a screen tall, so an inline
        row would put the one control that commits below the fold of a surface
        whose scroll he has just been sent to the top of — the same failure the
        `Write the brief` strip above already answers, and it is answered the
        same way rather than a second way.
      */}
      <div className={`flex items-center gap-2
                       ${page
                         ? `sticky bottom-0 -mx-4 mt-4 px-4 py-3 bg-ink-900 border-t border-rule
                            ${blocked || err ? '' : '-mb-4'}`
                         : 'mt-4'}`}>
        {/*
          A button, and it is now correct that it is one.

          It was an `<a href="https://claude.ai/new?q=…" target="_blank">`, and
          that was the right shape for what it did: on a phone that URL is a
          universal link, and only a genuine link navigation hands it to the
          Claude app — `window.open` after an await lands in the browser
          instead. But the destination was the chat surface, which is the bug
          this whole change removes. There is no URL to give a link now: the
          commit is a POST that starts a process and a navigation to the page
          that shows it, and both of those are things a button does.

          `lg` and the only amber on the surface, because this is the one press
          that commits.
        */}
        <Button size="lg" variant="primary" onClick={open} disabled={busy || !!blocked}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <SquareTerminal size={14} />}
          {busy
            ? (session ? 'Resuming' : 'Starting')
            : (session ? 'Resume the session' : 'Start the session')}
        </Button>
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

      {/* Two different sentences, and neither is a status code. `blocked` is
          what this machine is missing and is known before the press; `err` is
          what the server refused and arrives after it. Both are printed as they
          came, because both were written for a person. */}
      {blocked && <p className="text-sm text-bad mt-3 leading-snug">{blocked}</p>}
      {err && <p className="text-sm text-bad mt-3 leading-snug">{err}</p>}
    </div>
  )
}
