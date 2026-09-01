/**
 * The composer: a field, and the one control that sends it.
 *
 * What this replaced was one long scroll — repository, session, ten template
 * essays, twenty-eight skill blurbs, the attachments, the Slack replies, the
 * instruction, the permission mode — with a sticky commit bar hacked inside the
 * scroller. Measured on a 375px phone that was over two thousand pixels of
 * content above a field nobody could find, and the first thing it did on open
 * was raise the keyboard, because the skill search was a live `<input>` mounted
 * in the scroll path. A person at 7am with one thumb opened this to type a
 * sentence and was handed a settings screen.
 *
 * So the first paint is the field and Send, and nothing else. Everything that
 * used to be a section is a chip: the repository and the session are menus on
 * the chip itself, and the two browsable lists live behind `+ Context` and
 * `Shape` — a second room, entered on purpose. **Configuration is opt-in.** The
 * order the decision is made in has not changed; what changed is that only the
 * part he actually types is on screen when he arrives.
 *
 * **Packing is not a step any more.** There used to be a `Write the brief`
 * commit that produced a monospace draft, and then a second commit that sent it
 * — two presses for one intention, the first of which asked him to read 600
 * lines of Markdown he did not write. `Send` packs and sends. The packed brief
 * is still readable and still editable, behind `Details`, as a hatch for when he
 * wants to see exactly what leaves. It is prose there, not a terminal: it was
 * `font-mono` in a fixed `44vh` box, which is most of why this product read as a
 * console rather than as a composer.
 *
 * **Send goes to a session that is running right now.** `/state` returns only
 * active sessions — every id in that list is a process on this box — and the
 * picker narrows it again to the chosen repository. `A new conversation` is the
 * first row and it is a genuinely new session, never a resume line for an id
 * that has stopped. A session that dies while the composer is open is dropped
 * out of the brief rather than handed to `--resume`, which is the bug this pass
 * exists to kill: Claude Code opening on his phone to say the conversation was
 * archived.
 *
 * **The commit is `Sheet`'s footer, not a sticky box.** A `position: sticky`
 * strip is held inside the scroll container, can be pushed by its padding, and
 * vanishes the moment an ancestor grows an `overflow: hidden`. The footer slot
 * is a flex sibling of the scrollport that never scrolls — see the note on
 * `Sheet`. On the phone page the same arrangement is built here, and the whole
 * page rides up when the on-screen keyboard appears, because a footer under the
 * keyboard is a Send button that cannot be pressed.
 *
 * **Nothing on this surface takes focus.** Opening the composer must not raise
 * the keyboard; the one field that does take it is the skill search, and only
 * after the button that reveals it has been pressed, which is a tap that asked
 * for a keyboard.
 *
 * **A Slack row is a thread parent, and the replies under it are the work.**
 * "we're seeing 500s on the sync" is the parent; the reply naming the account
 * and the hour is the answer. Every brief written off a Slack row used to carry
 * the question and none of the answers, so the replies Wake already holds are
 * listed under `+ Context` — author, words, when — and each is picked on its
 * own. Not all of them, not the channel, and never a direct message: the poll
 * refuses those before a card exists and the route refuses them again on the
 * way out.
 *
 * **On a phone this is a page.** A modal over a page is the right shape for a
 * question with three fields in it; this has never been that. Below `sm` it
 * takes the screen, with a back control and a chevron path exactly like the card
 * detail beside it. Same decisions, same one commit at the end: the room is what
 * changed, not the flow.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUpRight, Check, ChevronLeft, ChevronRight, Copy, FileText, FolderGit2, Info, Link2,
  Loader2, Paperclip, Search, SendHorizontal, Sliders, Sparkles, SquareTerminal, X,
} from 'lucide-react'
import {
  Button, Chip, Empty, Menu, Segmented, Sheet, inputClass, rowStateClass, type MenuItem,
} from './primitives'
import {
  PERMISSION_MODES, PHONE_COMPOSER, SESSION_MODELS, claudeAppUrl, closeLaunch, composerIsAPage,
  launchApi, launchDraft, openLaunch, rememberLaunch, removeFromLaunch, resetLaunch,
  resolveSkillIds, setLaunchModel, setLaunchPermissionMode, setLaunchSession, skillReaches,
  useLaunchBasket,
  type LaunchState, type PackItem, type PermissionMode, type SessionModel, type Session,
} from '../lib/launch'
import { navigate, useDetailKey, useRoute } from '../lib/route'
import { useOverlay } from '../lib/overlay'
import {
  messageWord, packItemFor, slackApi, slackLinkFor,
  type SlackThread, type SlackThreadItem,
} from '../lib/slackThreads'
import { openTerminalAndGo, terminalRoute } from '../lib/terminal'
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
 * The two browsable lists — templates, skills — share one shape: an identity on
 * the left with its check, and, where there is room for it, the sentence that
 * says what the thing is. These three classes are that shape, in one place,
 * because the two lists drifted apart the moment they were written twice.
 *
 * **Below `sm` there is no sentence at all.** The blurb used to wrap onto a
 * second line on a phone, which turned ten templates into an essay and
 * twenty-eight skills into a wall — 2,431px of scroll over a 375px screen, all
 * of it above the field. A name at 44px is one line and a list of names is
 * scannable; what the blurb was for is now the ⓘ beside the row, pressed on the
 * one row he is unsure about rather than paid for on all thirty-eight.
 *
 * **The name column is sized by the longest name in it**, from `sm` up. It was a
 * number chosen once per list — `sm:w-40` for templates, `sm:w-52` for skills —
 * and both were wrong for their own data: measured at 1440×900, `Mapping —
 * unified vs proxy` wanted 162px against 122px of room, and twelve of the
 * twenty-four skill slugs on screen wanted up to 261px against 170px. A bigger
 * fixed number is the same bug with a later trigger, since both lists are data.
 *
 * So the rows share one grid and each row is a `subgrid` of it, which is the
 * only way separate row elements can agree on a column without one of them
 * measuring the others. The track is `fit-content(45%)`: as wide as the longest
 * name and no wider, and never past 45% of the row.
 */
const NAME_GRID = 'sm:grid sm:grid-cols-[fit-content(45%)_minmax(0,1fr)]'
const NAME_ROW = `flex items-center gap-1 border-b border-rule
                  sm:grid sm:grid-cols-subgrid sm:col-span-2 sm:gap-0`
/** `min-w-0` is what lets the cap bite: without it the cell refuses to shrink
    below its own content and the row overflows instead of truncating. */
const NAME_CELL = 'flex-1 min-w-0 flex items-center gap-2 min-h-11 text-left sm:pr-4'

/**
 * What this surface is called, which is now the verb rather than the product.
 *
 * It said `Open in Claude Code`, over a control that opened Claude Code — honest,
 * and still the wrong name for a composer. What happens here is that a message
 * goes to a conversation; "open" is what the Sessions page does. It is the
 * sheet's title on a laptop and the last crumb on a phone.
 */
const COMPOSER_TITLE = 'Send to Claude Code'

/**
 * The hatch, said in full wherever a screen reader or a hover asks.
 *
 * The visible label is four words; this is the sentence behind it, and it is
 * written out because the honest version of this control is a warning. It opens
 * a NEW conversation in the Claude app — a different product from Claude Code,
 * with no repository, no tools and nothing to resume — and it never carries a
 * session id, because there is no URL anywhere that reaches an existing
 * conversation. It is here for the case the box is not: a phone, away from the
 * desk, with a thread worth pasting somewhere that can read it.
 */
const APP_HATCH =
  'Open a new conversation in the Claude app. It has no repository and cannot reach a session on this box.'

/** The three rooms behind the chips. `null` is the field, which is the default. */
type Panel = 'context' | 'shape' | 'run'

const PANEL_TITLE: Record<Panel, string> = {
  context: 'Context',
  shape: 'Shape',
  run: 'The brief, and how it runs',
}

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

/**
 * How much of the screen the on-screen keyboard is covering, in pixels.
 *
 * A `position: fixed` box is placed against the *layout* viewport, which iOS
 * does not shrink when the keyboard comes up — so a footer pinned above
 * `--nav-h` sits behind the keyboard exactly when it is needed, on the one
 * surface whose first act is to put a caret in a field. `visualViewport` is the
 * only thing that reports the real area, and it reports it as a resize rather
 * than as a media query.
 *
 * Anything under 80px is read as nothing. Browser chrome sliding in and out
 * moves this by a few dozen pixels on every scroll, and a footer that shuffles
 * with the URL bar is worse than one that ignores it; a keyboard is hundreds of
 * pixels and cannot be confused with either.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const read = () => {
      const covered = window.innerHeight - (vv.height + vv.offsetTop)
      setInset(covered > 80 ? Math.round(covered) : 0)
    }
    read()
    vv.addEventListener('resize', read)
    vv.addEventListener('scroll', read)
    return () => {
      vv.removeEventListener('resize', read)
      vv.removeEventListener('scroll', read)
    }
  }, [])
  return inset
}

/**
 * The composer, mounted only while it is open.
 *
 * It used to stay mounted and render an empty panel on the way out, which is
 * what let the sheet keep its slide-away. Two things are worth more than that
 * animation: the state can live in one component that owns both the scrolled
 * body and the footer — which is what moving the commit into `Sheet`'s `footer`
 * slot requires — and the half-written draft is seeded during the first render
 * rather than in an effect, so a resumed brief never paints an empty field.
 *
 * `key` is the subject, so opening a different brief while one is up rebuilds
 * the composer instead of leaving the previous brief's panel open over it.
 */
export function LaunchSheet() {
  const basket = useLaunchBasket()
  const page = useComposerIsAPage()

  if (!basket.open) return null
  return (
    <LaunchComposer
      key={basket.subject}
      items={basket.items}
      preferred={basket.templates}
      repoHint={basket.repoHint}
      suggestedTitle={basket.title}
      session={basket.session}
      permissionMode={basket.permissionMode}
      model={basket.model}
      page={page}
    />
  )
}

/**
 * The composer as a place, at the size a phone actually has.
 *
 * This is `DetailPage` in `pages/Home.tsx`, deliberately — the same portal, the
 * same `pad-top`, the same stop at `--nav-h`, the same reason for each. A fixed
 * box at `top: 0` starts under the notch, and the phone tab bar is not this
 * page's to cover: `styles.css` states that as a rule and the card sheet that
 * broke it made all six destinations unreachable while a card was open.
 *
 * The one departure is the keyboard. `--nav-h` is where the page stops when
 * nothing is covering it; when something is, the page stops at the top of the
 * keyboard instead, which is the only way the footer stays pressable while he is
 * typing into the field directly above it.
 *
 * `z-[52]`, and the two pixels are load-bearing. The ladder is 50 for a sheet
 * and for the card detail page, 55 for a `Menu` — which is what the repository
 * and session chips on this very surface open as — and 60 for the palette. This
 * has to cover the card detail, because the card detail is what it is usually
 * opened from and is still standing behind it, and it has to stay under its own
 * menus. Two equal z-indexes would leave that to DOM insertion order, which is
 * true today and is not a thing to depend on.
 *
 * `useOverlay(true)` is the same non-decoration it is on the detail page: the
 * desk binds `j`, `k`, `e` and `s` to the document, two of those are destructive
 * and unconfirmed, and a surface that does not count itself leaves them live
 * underneath it.
 */
function LaunchPage({ footer, children }: { footer: React.ReactNode; children: React.ReactNode }) {
  useOverlay(true)
  const kb = useKeyboardInset()

  return createPortal(
    <div
      style={{ bottom: kb > 0 ? `${kb}px` : 'var(--nav-h)' }}
      className="fixed inset-x-0 top-0 z-[52] pad-top flex flex-col glass"
    >
      <LaunchPath onBack={closeLaunch} />
      {/* The vertical pad is on the content and not on the scroller, which is
          the rule `Sheet` already states: a scroller's own padding is outside
          the scrollport and cannot be cancelled by anything inside it. */}
      <div className="grow min-h-0 overflow-y-auto overscroll-contain pad-x">
        <div className="py-4">{children}</div>
      </div>
      {/* A flex sibling of the scroller, never a `sticky` box inside it. See the
          note on `Sheet`'s own footer for the three ways sticky loses. Absent
          rather than empty while `/state` is still being read: a 49px bar with
          nothing in it is a control the eye goes to and finds nothing at. */}
      {footer && (
        <div className="shrink-0 pad-x py-3 border-t border-rule glass-bar">{footer}</div>
      )}
    </div>,
    document.body,
  )
}

/**
 * Where the composer sits, and the way out of it, in one line.
 *
 * `‹ Card › Send to Claude Code`. The shape is `DetailPath`'s and the reasons
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

/* -------------------------------- the state ------------------------------- */

function LaunchComposer({
  items, preferred, repoHint, suggestedTitle, session, permissionMode, model, page,
}: {
  items: PackItem[]
  preferred: string[]
  repoHint: string | null
  suggestedTitle: string | null
  session: string | null
  permissionMode: PermissionMode
  model: SessionModel
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
   * object here would give `seed` a different meaning on every render.
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
  const [panel, setPanel] = useState<Panel | null>(null)

  useEffect(() => {
    launchApi.state().then(setMeta).catch(e => setErr((e as Error).message))
  }, [])

  /* Every decision on this surface, written back where it survives an unmount. */
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
   * into the list above and the count on the chip changes with it.
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

  /**
   * A packed brief is only true of the decisions it was packed from.
   *
   * The hatch writes a real pack — a row, a file on disk, a working directory —
   * and `send` reuses it rather than packing a second time, so that what he read
   * is what leaves. That is right until something underneath it moves: open the
   * hatch, read the brief, go back, change the repository, and Send would start
   * a session in the *old* repository, because the pack carries the cwd and the
   * pack is what gets opened. Nothing on screen would say so.
   *
   * So any change to what the pack is made of drops it, and the hatch offers to
   * write it again. It costs an edited brief when he then changes his mind about
   * the shape, which is the honest half of the trade: a brief that no longer
   * describes the decisions under it is worse than one he has to re-read.
   *
   * `shape` is null until `/state` lands, because `effectiveSkills` falls back to
   * the templates' union and that union is empty until the templates are known —
   * comparing against it would drop a resumed brief on the first paint.
   */
  const shape = meta ? JSON.stringify([
    templates, cwd, effectiveSkills, instruction, session, permissionMode,
    items.map(i => i.ref),
  ]) : null
  const packedFrom = useRef<string | null>(null)

  useEffect(() => {
    if (shape === null) return
    if (packedFrom.current === null || packedFrom.current === shape) {
      packedFrom.current = shape
      return
    }
    packedFrom.current = shape
    setDraft(null)
  }, [shape])

  /*
   * Which desk row this brief came off, kept once it is known.
   *
   * It rides in on the objects (`PackItem.group`), because the detail pane is
   * the only thing that sees a whole card and it hands over items and nothing
   * else. Sticky rather than recomputed: removing the card object from the
   * attachments should not also take away the list of replies he was in the
   * middle of picking from.
   */
  const [group, setGroup] = useState<string | null>(null)
  useEffect(() => {
    const g = items.find(i => i.group)?.group
    if (g && g !== group) setGroup(g)
  }, [items])

  /**
   * The room, whatever is in it.
   *
   * Every return below goes through this, including the two that happen before
   * `/state` has answered. They used to return a bare paragraph and a bare
   * spacer, which on a phone meant the composer's loading state was a stray line
   * of text rendered inside the page it was supposed to be covering — the
   * surface only existed once the fetch landed.
   */
  const shell = (children: React.ReactNode, footer: React.ReactNode = null) =>
    page
      ? <LaunchPage footer={footer}>{children}</LaunchPage>
      : <Sheet open onClose={closeLaunch} title={COMPOSER_TITLE} footer={footer} wide>{children}</Sheet>

  if (err && !meta) return shell(<p className="text-sm text-bad leading-snug">{err}</p>)
  // Nothing while the machine is read. It takes one round trip and a sentence
  // saying so is chrome that teaches.
  if (!meta) return shell(null)

  /**
   * Write the pack, which is what "packing happens on Send" means.
   *
   * It returns the brief rather than only setting state, because `send` needs
   * the text in the same tick and a `useState` setter does not hand it back.
   * A brief already written — he opened the hatch and read it, maybe edited it —
   * is reused rather than repacked, so what he approved is what goes.
   */
  const pack = async () => {
    const p = await launchApi.createPack({
      templates,
      title: suggestedTitle ?? undefined,
      cwd,
      instruction: instruction.trim() || undefined,
      items,
      skills: effectiveSkills,
      sessionId: session,
      permissionMode,
    })
    const next = { packId: p.id, brief: p.first_message ?? '' }
    setDraft(next)
    return next
  }

  /**
   * The one commit, and the two shapes it takes.
   *
   * **A session that is running gets a message.** `POST /sessions/:id/send`
   * pastes one more turn into the conversation and refuses, in a sentence, a
   * session that has stopped or that Wake did not start. That refusal is the
   * whole point: the id used to go to `--resume` and Claude Code was left to be
   * the one that said the session was archived, on his phone, after the tap.
   *
   * **A new conversation gets a session.** `openTerminalAndGo` is the call that
   * also *records* the hand-off — it writes the approved text back to the pack
   * row and to the pack file before starting anything — which is the artifact
   * this product promises to keep, and the reason the new-conversation half does
   * not go through the plainer session route.
   *
   * A refusal is never swallowed: the composer stays open with the brief still
   * in it, so the next press can be a different decision rather than a retype.
   */
  const send = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      const { packId, brief } = draft ?? await pack()
      if (session) {
        await launchApi.send(session, brief)
        navigate(terminalRoute(session))
      } else {
        await openTerminalAndGo({ packId, brief, model })
      }
      resetLaunch()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const setBrief = (text: string) =>
    setDraft(d => (d ? { ...d, brief: text } : d))

  /* Off with a reason, rather than a commit that answers 503 after the brief has
     been written and read. `missing` is the server's own sentence naming which
     of tmux, python3 or the claude binary is not on this box. */
  const blocked = meta.terminal && !meta.terminal.available.ok
    ? meta.terminal.available.missing ?? 'this machine cannot start a Claude Code session'
    : null

  const provenance = `${items.length} object${items.length === 1 ? '' : 's'} · ${
    cwd ? (meta.repos.find(r => r.path === cwd)?.name ?? 'no repository') : 'no repository'
  } · ${effectiveSkills.length} skill${effectiveSkills.length === 1 ? '' : 's'}`

  const body = panel === null ? (
    <>
      {/*
        The field, first and alone.

        No heading over it. A section eyebrow reading `WHAT DO YOU NEED?` above a
        field whose placeholder says the same thing is one line of the fold spent
        saying a thing twice, and the fold is the product on this screen.
      */}
      <GrowingField
        value={instruction}
        onChange={setInstruction}
        placeholder="What do you need? Leave it empty and the templates below speak for you."
      />

      {/*
        Everything that used to be a section, as chips.

        Wrapping rather than scrolling: a rail that scrolls hides the last chip
        behind an edge with nothing saying why, and five chips at 375px are two
        short rows. The repository and the session are menus on the chip itself
        because they are one choice each; the other three open a room.
      */}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <RepoChip repos={meta.repos} cwd={cwd} setCwd={setCwd} />
        <SessionChip
          sessions={meta.sessions} repos={meta.repos} repo={cwd}
          value={session} setCwd={setCwd}
        />
        <Chip onClick={() => setPanel('context')} mark={<Paperclip size={13} aria-hidden />}
          title="What this brief quotes" ariaLabel="Context">
          + Context{items.length ? ` · ${items.length}` : ''}
        </Chip>
        <Chip onClick={() => setPanel('shape')} mark={<Sliders size={13} aria-hidden />}
          title="Templates and skills" ariaLabel="Shape">
          Shape{templates.length + effectiveSkills.length
            ? ` · ${templates.length + effectiveSkills.length}` : ''}
        </Chip>
        {/* The overflow, with a name instead of a glyph — the same call
            `pages/Session.tsx` makes, in the same words, for the same reason.
            An ellipsis is banned in this codebase outright and rightly: an
            anonymous lozenge on a phone is something you tap to find out what it
            does. `Details` and not `More`, which is the same anonymity spelled
            in letters. */}
        <Chip onClick={() => setPanel('run')} title={PANEL_TITLE.run} ariaLabel={PANEL_TITLE.run}>
          Details
        </Chip>
      </div>
    </>
  ) : (
    <>
      <PanelPath title={PANEL_TITLE[panel]} onBack={() => setPanel(null)} />

      {panel === 'context' && (
        <>
          <section className="py-4">
            <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Attachments</h3>
            {/* A line that names the state, not a dash. A dash is what a cell
                prints when a value is missing; a section with nothing in it is
                not a missing value, it is a brief that is going to be carried
                entirely by the templates and what he typed. */}
            {items.length === 0 && (
              <Empty>Nothing attached — this brief carries the templates and your own instruction.</Empty>
            )}
            {items.map(i => (
              <div key={`${i.kind}:${i.ref}`}
                className="flex items-center h-11 border-b border-rule last:border-0">
                {/* 96px for a word never longer than `Session` — 55px at this
                    size — is 40px a phone does not have. The title beside it is
                    the only thing that tells two Slack replies apart. */}
                <span className="text-sm text-fg-mute w-16 sm:w-24 shrink-0">
                  {KIND_LABEL[i.kind] ?? i.kind}
                </span>
                <span className="text-sm text-fg-dim truncate grow min-w-0" title={i.ref}>
                  {i.title ?? i.ref}
                </span>
                {/* The character count that used to end this row is gone. It was
                    there because the brief travelled in a URL with a budget and
                    one long quote could spend it; the brief is handed to a
                    process now. A number measuring nothing, in the column a
                    phone needed for the title. */}
                <span className="shrink-0 pl-2">
                  <Button size="sm" variant="ghost" title="Remove" ariaLabel="Remove"
                    onClick={() => removeFromLaunch(i.ref)}>
                    <X size={14} />
                  </Button>
                </span>
              </div>
            ))}
          </section>

          {/* Directly under the attachments, because that is what it adds to:
              the replies picked here become rows in the list above, with their
              own refs and their own links, and can be taken off from either. */}
          <SlackPicker group={group} attached={items} />
        </>
      )}

      {panel === 'shape' && (
        <>
          <TemplatePicker
            all={meta.templates} chosen={templates}
            onToggle={id => {
              setTemplates(t => (t.includes(id) ? t.filter(x => x !== id) : [...t, id]))
              // A template's skills are a starting point, not an answer: dropping
              // the manual override lets the new selection's union show through.
              setSkills(null)
            }}
          />
          <SkillPicker all={meta.skills} selected={effectiveSkills} onChange={setSkills} cwd={cwd} />
        </>
      )}

      {panel === 'run' && (
        <RunPanel
          mode={permissionMode} model={model} session={session} page={page}
          draft={draft} setBrief={setBrief} onWrite={pack} provenance={provenance}
        />
      )}
    </>
  )

  const footer = (
    <>
      <div className="flex items-center gap-2">
        {/*
          A real anchor, and it has to stay one.

          `https://claude.ai/…` is a universal link on iOS: a genuine link
          navigation hands it to the Claude app, and `window.open` after an await
          lands in Safari instead. The URL is built from the server's own
          hand-off config rather than written here, so a deployment that points
          `WAKE_HANDOFF_URL` somewhere else is followed rather than contradicted.

          It carries the packed brief when there is one and what he has typed
          when there is not, and it never carries a session id — there is no URL
          that reaches an existing conversation, which is exactly why this is the
          hatch and not the commit.
        */}
        <a
          href={claudeAppUrl(meta.handoff, draft?.brief ?? instruction)}
          target="_blank"
          rel="noreferrer"
          title={APP_HATCH}
          aria-label={APP_HATCH}
          /* No glyph beside it, and that is arithmetic rather than taste. This
             label and `Send to session` are 316px of a 343px row at 375px; an
             external-link mark and its gap is another 22 and the label starts
             truncating — and the word this control cannot afford to lose is the
             last one. `truncate` stays as the insurance, so a wider font
             degrades the secondary rather than breaking the row. */
          className="inline-flex items-center min-w-0 h-11 -ml-2 px-2 rounded-control
                     text-sm font-medium text-fg-mute hover:text-fg-dim hover:bg-raise
                     transition-colors duration-100"
        >
          <span className="truncate">New chat in the Claude app</span>
        </a>

        {/* The one commit on this surface, and the only amber on it. */}
        <Button size="lg" variant="primary" className="ml-auto shrink-0"
          onClick={send} disabled={busy || !!blocked}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <SendHorizontal size={14} />}
          {busy
            ? (session ? 'Sending' : 'Starting')
            : (session ? 'Send to session' : 'Start a session')}
        </Button>
      </div>

      {/* Two different sentences, and neither is a status code. `blocked` is what
          this machine is missing and is known before the press; `err` is what the
          server refused and arrives after it. Both are printed as they came,
          because both were written for a person. */}
      {blocked && <p className="text-sm text-bad mt-2 leading-snug">{blocked}</p>}
      {err && <p className="text-sm text-bad mt-2 leading-snug">{err}</p>}
    </>
  )

  return shell(body, footer)
}

/**
 * The way back out of a room, shaped like the path bar above it.
 *
 * A panel with no visible exit is a modal inside a modal, and on a phone the
 * only other way out is the OS back gesture — which closes the whole composer,
 * because that is the single history entry this surface pushes.
 */
function PanelPath({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 py-1 border-b border-rule">
      <Button variant="default" size="sm" onClick={onBack}
        ariaLabel="Back to the brief" title="Back to the brief" className="shrink-0">
        <ChevronLeft size={14} aria-hidden /> Brief
      </Button>
      <span className="truncate text-sm text-fg-dim">{title}</span>
    </div>
  )
}

/* ------------------------------ the templates ----------------------------- */

/**
 * Which template, or templates — and the one that is not a template like the
 * others.
 *
 * Names only on a phone, name beside description on a laptop. The blurb used to
 * take the whole width below `sm` and wrap, which was the right answer to a
 * worse question: with the list on first paint, ten wrapped blurbs were the
 * screen. Behind `Shape` it is a list you came to read, so it is a list of names
 * at 44px with the sentence one press away.
 *
 * **The voice rows are under their own heading.** Ten of these say what to find
 * out; the Humanizer says how the last message reads, and it is meant to be
 * chosen on top of one of the others rather than instead of one. As eleven
 * identical rows in one list that is unreadable — the list's own shape says
 * "pick one of eleven jobs", and the first thing anybody would assume is that
 * choosing `Humanizer` un-chooses `Customer incident`.
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
  const [info, setInfo] = useState<string | null>(null)
  const work = all.filter(t => t.kind !== 'voice')
  const voice = all.filter(t => t.kind === 'voice')

  const row = (t: LaunchState['templates'][number]) => (
    <PickRow
      key={t.id}
      label={t.label}
      blurb={t.blurb}
      on={chosen.includes(t.id)}
      onToggle={() => onToggle(t.id)}
      open={info === t.id}
      onInfo={() => setInfo(v => (v === t.id ? null : t.id))}
    />
  )

  return (
    <section className="py-4">
      {/* A label, not a readout. `Templates — 1` put a number where the name
          goes, and the number was already on screen: every chosen row has a
          check on it, and the chip that opened this room carries the count. */}
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Templates</h3>
      <div className={NAME_GRID}>{work.map(row)}</div>

      {voice.length > 0 && (
        <>
          {/* The heading carries the whole of the distinction, so it says it
              rather than naming a category and leaving him to guess. */}
          <h3 className="text-eyebrow uppercase text-fg-mute mb-2 mt-4">Voice, worn over the above</h3>
          <div className={NAME_GRID}>{voice.map(row)}</div>
        </>
      )}
    </section>
  )
}

/**
 * One row of a browsable list: a name you press, and a sentence you can ask for.
 *
 * The ⓘ is the whole of what makes a names-only list usable, and it is a real
 * 44px control rather than a long-press: a long-press is invisible, has no
 * keyboard equivalent, and on a list that also scrolls it fights the gesture
 * that scrolls it. Above `sm` there is room for the sentence beside the name, so
 * the button is not rendered at all — a disclosure for something already
 * disclosed is a control that does nothing.
 */
function PickRow({
  label, blurb, on, mono, dim, onToggle, open, onInfo,
}: {
  label: string
  blurb: string
  on: boolean
  /** Slugs and paths: the texture is what tells them apart. */
  mono?: boolean
  /**
   * The row is offerable but not usable here, and the blurb says why.
   *
   * Not `disabled`: Wake's index is not the last word on what a session can
   * load — a plugin skill, or one symlinked in since the last reindex, is a
   * name he may know better than this list does. So it is still pressable and
   * the brief is what refuses to issue an order it cannot see a way to carry
   * out. What the row owes him is that the cost of the choice is visible
   * *before* he spends it, rather than in a footnote afterwards.
   */
  dim?: boolean
  onToggle: () => void
  open: boolean
  onInfo: () => void
}) {
  return (
    <>
      {/* Chosen is a lit ground, exactly as it is on the desk, rather than a
          check and nothing else. One selected template used to be one accent
          mark, so choosing three spent the budget. */}
      <div className={`${NAME_ROW} ${rowStateClass({ selected: on })}`}>
        <button onClick={onToggle} aria-pressed={on} className={NAME_CELL}>
          <Check size={14} className={`shrink-0 ${on ? 'text-fg' : 'text-transparent'}`} />
          <span className={`text-sm truncate ${mono ? 'font-mono ' : ''}${
            on ? 'text-fg' : dim ? 'text-fg-mute/60' : 'text-fg-mute'}`}>
            {label}
          </span>
        </button>
        <span className={`hidden sm:block text-sm sm:line-clamp-2 grow min-w-0 ${dim ? 'text-fg-mute/70 italic' : 'text-fg-mute'}`}>{blurb}</span>
        {/* 44 by 44 outright rather than a small box wearing `.hit`. That class
            draws its collar *outside* the control, and in a list every row's
            collar overlaps its neighbours' — the last one painted takes the tap,
            which here means reading one row's blurb when he meant to tick the
            row below. */}
        <button
          type="button"
          onClick={onInfo}
          aria-expanded={open}
          aria-label={`What ${label} is for`}
          title={`What ${label} is for`}
          className="sm:hidden shrink-0 inline-flex items-center justify-center h-11 w-11
                     rounded-control text-fg-mute hover:text-fg-dim hover:bg-raise
                     transition-colors duration-100"
        >
          <Info size={14} />
        </button>
      </div>
      {open && (
        <p className="sm:hidden text-sm text-fg-mute leading-snug pl-[22px] pb-2">{blurb}</p>
      )}
    </>
  )
}

/**
 * The instruction field, at the size of the thing being written.
 *
 * It was `rows={4}` — a four-line box for the one paragraph on this sheet that
 * nobody else can write for him. So it grows with its content from a floor of
 * 8rem, the way a composer does, and stops at a height that still leaves the
 * commit visible; past that it scrolls.
 *
 * The height is set from `scrollHeight`, which needs the box collapsed first —
 * otherwise a deletion never shrinks it, because `scrollHeight` never drops
 * below the height already applied.
 *
 * It does not take focus. This is the first thing on the surface and focusing it
 * on mount is how opening the composer raises the keyboard, which puts the field
 * behind it on the phone this is written for.
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
        aria-label="What you need"
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
 * The row that means "a genuinely new session", as an id.
 *
 * `null` cannot carry a check, and "a new conversation" is a row like any other.
 * A session id is a UUID, so a leading colon cannot collide with one.
 */
const NEW_SESSION = ':new'

/**
 * The rows the session menu offers, in the order it prints them.
 *
 * Exported because the filter is the whole of what this control does, and it is
 * the part that cannot be seen to be right by looking at it.
 *
 * **Every row is a session that is running right now.** `/state` and
 * `/sessions` both read Claude Code's own per-process files, so being in this
 * list is the same fact as being alive; there is no window, no `all`, and no
 * archive of transcripts to page through. That is what removed the escape hatch
 * this function used to have — a `chosen` session was allowed past the filters
 * so the trigger could name the session a brief was already about, and under an
 * active-only list that hatch is precisely a way to print a dead id as a live
 * choice. A brief whose session has stopped drops the session instead; see
 * `SessionChip`.
 *
 * Two things still keep a row out. It ran in another repository —
 * `sessionInRepo`, the server's own filter, so this menu and the Sessions page
 * cannot disagree about what "truto's sessions" means. Or he has archived it:
 * putting a session away is saying he is done with it, and a thing you are done
 * with is not the default context for new work.
 */
export function sessionChoices(
  sessions: readonly Session[],
  repo: string | null,
  known: readonly string[] = [],
): MenuItem[] {
  const seen = new Set<string>()
  const rows = sessions
    .filter(s => {
      // The two reads overlap by construction: `/state` sends the machine's
      // active sessions and the repository read sends that repository's own.
      if (seen.has(s.id)) return false
      if (repo && !sessionInRepo(s, repo)) return false
      if (s.archived) return false
      seen.add(s.id)
      return true
    })
    .sort((a, b) => b.lastTs - a.lastTs)

  /*
   * Grouped by the repository each session is in — `known`, the repositories
   * this machine actually has, and the recorded directory only when none of
   * them contains it.
   *
   * The directory alone was the heading until the filter learned to match under
   * a repository, and then it broke the list it was meant to organise: with
   * `wake` chosen the menu printed three headings — `wake`,
   * `reverent-hertz-369f69`, `QA_EVIDENCE` — for one repository, and since
   * grouping reorders, the newest row of the second group sat below the oldest
   * of the first. A menu already scoped to one repository has one heading.
   *
   * `Menu` prints a heading whenever the group changes rather than nesting, so
   * rows sharing one have to arrive together — the sorted list alone would print
   * `truto` above every third row. Insertion order into the map is the order of
   * each group's newest session, which is the order to read them in.
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
        // One fact beside the name, which is what a menu row has room for. Among
        // sessions in one repository the title is often the same commit message
        // twice, so what tells them apart is when each last said anything.
        meta: ago(s.lastTs),
      })
    }
  }
  return items
}

/**
 * Which conversation this brief goes to.
 *
 * Picking one does three things: it fills the working directory from the
 * directory that session actually ran in, it attaches the session as an object
 * so its last exchanges are named in the brief, and it makes the commit one more
 * turn in that conversation rather than a new one.
 *
 * A chip rather than a section with a paragraph under it. The paragraph used to
 * explain that a chosen session was resumed and a new one was not, which is a
 * sentence about mechanics on a surface whose first job is a field — the two
 * labels on the commit button say the same thing at the moment it matters.
 */
function SessionChip({
  sessions, repos, repo, value, setCwd,
}: {
  sessions: Session[]
  repos: LaunchState['repos']
  /** The chosen repository's path, or null for "not about one repository". */
  repo: string | null
  value: string | null
  setCwd: (v: string | null) => void
}) {
  const [inRepo, setInRepo] = useState<Session[]>([])

  /*
   * A repository's sessions are asked for, not filtered out of what is to hand.
   *
   * `/state` sends what is running on the machine; the scoped read sends what is
   * running in this repository. They overlap almost entirely now that both are
   * active-only, and the scoped read is still worth making: it is the one that
   * stays correct when the machine is busier than one page of sessions.
   */
  useEffect(() => {
    if (!repo) { setInRepo([]); return }
    let live = true
    launchApi.sessions({ repo })
      .then(r => { if (live) setInRepo(r.sessions) })
      // A widening that fails is not an error on this surface: what `/state`
      // already sent is still a true list, only a shorter one.
      .catch(() => {})
    return () => { live = false }
  }, [repo])

  const known = useMemo(() => [...sessions, ...inRepo], [sessions, inRepo])
  const repoPaths = useMemo(() => repos.map(r => r.path), [repos])
  const items = useMemo(() => sessionChoices(known, repo, repoPaths), [known, repo, repoPaths])
  const current = known.find(s => s.id === value) ?? null

  /*
   * A session the brief names but the machine is no longer running is dropped.
   *
   * This is the failure the whole pass is about, caught at the last place it can
   * still be caught silently. The list is active-only, so an id that is not in
   * it is a conversation that has ended — and every use of that id downstream
   * *starts* something: the pack names it, and the commit would hand it to a
   * resume. Dropping it turns the next press into a new conversation, which is
   * the true option, instead of Claude Code opening on his phone to say the
   * session was archived.
   *
   * A live session in another repository moves the repository rather than being
   * dropped; a repository he changed by hand drops the session, because that is
   * what changing it meant.
   */
  useEffect(() => {
    if (!value) return
    const live = known.find(s => s.id === value)
    if (live && repo && !sessionInRepo(live, repo)) {
      const home = repoForSession(live, repoPaths)
      if (home && home !== repo) return setCwd(home)
    }
    if (!items.some(i => i.id === value)) {
      // The session's own object goes with the session. Leaving it attached
      // would quote a transcript the brief no longer claims to be about.
      removeFromLaunch(sessionRef(value))
      setLaunchSession(null)
    }
  }, [items, value, repo])

  const pick = (s: Session | null) => {
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
    <Menu
      items={items}
      value={value ?? NEW_SESSION}
      onPick={id => pick(id === NEW_SESSION ? null : known.find(s => s.id === id) ?? null)}
      ariaLabel="Session"
      trigger={({ open, toggle }) => (
        <Chip active={open} onClick={toggle} flexible
          mark={<SquareTerminal size={13} aria-hidden />}
          title="Which conversation this goes to" ariaLabel="Session">
          <span className="truncate">{current ? current.title : 'A new conversation'}</span>
        </Chip>
      )}
    />
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

/* ------------------------------ the repository ---------------------------- */

/**
 * A repository is chosen by a row like any other, so "none" needs an id.
 *
 * Every repository is an absolute path, so a leading colon cannot collide with
 * one — and `null` cannot be a menu value, because the row that says "not about
 * one repository" has to be able to carry the check.
 */
const NO_REPO = ':none'

/**
 * The repository, as a chip that opens a real menu.
 *
 * It has been four controls. A native `<select>`, whose popup painted over the
 * object list. Then a collapsed row that opened into more rows in document flow,
 * shoving the commit down the screen at the moment of choosing. Then a full-width
 * `Menu` under a section heading, which was correct and cost a heading, a row and
 * 60px of the fold to answer a question most briefs answer for themselves. Now
 * the same `Menu` on a chip: it overlays rather than displaces, it says which one
 * is current, and when nobody needs it, it is one word wide.
 */
function RepoChip({
  repos, cwd, setCwd,
}: { repos: LaunchState['repos']; cwd: string | null; setCwd: (v: string | null) => void }) {
  const items = useMemo<MenuItem[]>(() => [
    { id: NO_REPO, label: 'Not about one repository' },
    ...repos.map(r => ({
      id: r.path,
      label: r.name,
      // Uncommitted work, because that is the fact that decides whether this is
      // the checkout he means — and a `<select>` could not have carried it.
      // `uncommitted`, because that is now what the number counts — tracked
      // changes only. `dirty` was the git word for a count that also included
      // untracked agent litter, and it read as "37 things going on here" beside
      // a repository with nothing uncommitted in it. See `registry/scan.ts`.
      ...(r.dirty > 0 ? { meta: `${r.dirty} uncommitted` } : {}),
    })),
  ], [repos])

  const here = repos.find(r => r.path === cwd)

  return (
    <Menu
      items={items}
      value={cwd ?? NO_REPO}
      onPick={id => setCwd(id === NO_REPO ? null : id)}
      ariaLabel="Repository"
      trigger={({ open, toggle }) => (
        <Chip active={open} onClick={toggle} flexible
          mark={<FolderGit2 size={13} aria-hidden />}
          title="Which repository this is about" ariaLabel="Repository">
          <span className="truncate">{here ? here.name : 'Repository'}</span>
        </Chip>
      )}
    />
  )
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
 * on the Context chip, and it can be taken off from either place. That is also
 * what makes "the unselected ones are not in the pack" true by construction
 * rather than by a filter somebody has to remember to write.
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
 * second — because two columns need about 340px and there are 343 to spend.
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
            column of ages can be compared down. */}
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
            character message is not enough to pick with. */}
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
                   rounded-control text-fg-mute hover:text-fg-dim hover:bg-raise
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
      {/* `.hit-native` because the input paints 32px and must take a 44px tap:
          at its own line height it was an 18px band inside a control you could
          see. This field is behind `+ Context` now, so it is no longer in the
          path a fresh open scrolls through and cannot summon the keyboard on
          arrival. */}
      <div className="flex items-center gap-2 px-2 h-8 rounded-control border border-edge glass-raise
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

/* --------------------------------- skills --------------------------------- */

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
 * Six 44px rows is 264px — within a pixel or two of what the porthole it
 * replaced was painting — so the list keeps its size and only stops being a
 * scroller.
 */
const PEEK = 6

/**
 * Which skills the brief names.
 *
 * Named, never inlined — a skill body is tens of kilobytes and the session has
 * the same catalogs Wake indexes.
 *
 * **The search is a button until it is asked for.** It was a live `<input>`,
 * always mounted, sitting in the scroll path of the first thing this surface
 * painted — so on a phone, opening the composer could raise the keyboard before
 * he had decided anything, and the field it covered was the field he came for.
 * A button costs one tap and only ever costs it to somebody who wants to type.
 * It still searches everything a person might half-remember: the slug, the human
 * title, the catalog letter, the description and the sentence saying when to use
 * it — searching only `name` meant "customer" found nothing while three skills
 * said "customer issue" in their own descriptions.
 *
 * **The names are the list on a phone.** Twenty-eight rows each carrying a
 * wrapped sentence is a wall, and it was the second wall on a surface that
 * already had one. The sentence is behind the ⓘ on the row, which is where it is
 * wanted: on the one row he cannot place.
 *
 * It is not a `Menu`, and the repository and session chips are the argument
 * rather than the counter-argument: both are single-choice, both close on the
 * pick, and neither carries a field. `Menu` rows are `menuitemradio` and its
 * `onClick` closes the panel — a multi-select that shuts after every choice is
 * worse than anything it would replace.
 */
function SkillPicker({
  all, selected, onChange, cwd,
}: {
  all: LaunchState['skills']
  selected: string[]
  onChange: (next: string[]) => void
  /** The repository the session will run in, which is what decides reach. */
  cwd: string | null
}) {
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [info, setInfo] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)

  /*
   * The keyboard the tap asked for.
   *
   * This is not autofocus, which is the thing this surface refuses: nothing
   * takes focus when the composer opens. Pressing a control whose entire purpose
   * is to type into a box and then having to press the box as well is a second
   * tap for nothing.
   */
  useEffect(() => { if (searching) field.current?.focus() }, [searching])

  /**
   * Reachable first, then the rest — not hidden, and not offered as equals.
   *
   * Of the 32 skills indexed on this machine, 14 are loadable by no Claude Code
   * session at all: they live only under an old `Cursor-skills` tree that
   * neither `~/.claude/skills` nor any repository points at. Nine more are
   * project skills of one repository. All 32 were in this list as identical
   * rows, so choosing one of the 14 cost a decision and bought nothing, and the
   * only place that was ever said was a footnote in the finished brief.
   *
   * They are sorted down rather than removed. Wake's index is not the last word
   * — a plugin skill, or one symlinked in after the last reindex, is a name he
   * may legitimately know better than this list does — so what is here is the
   * ordering and the label, and `buildPack` is what refuses to issue the order.
   */
  const reachable = useMemo(() => {
    const ok = new Map<string, boolean>()
    for (const s of all) ok.set(s.id, skillReaches(s, cwd))
    return ok
  }, [all, cwd])

  const matches = useMemo(() => {
    const term = q.trim().toLowerCase()
    const list = term
      ? all.filter(s => `${s.name} ${s.title ?? ''} ${s.whenToUse ?? ''} ${s.description ?? ''} ${s.catalog}`
        .toLowerCase().includes(term))
      : all
    return [...list].sort((a, b) => Number(reachable.get(b.id)) - Number(reachable.get(a.id)))
  }, [all, q, reachable])

  /** Why a row cannot be loaded here, in the words the brief would use. */
  const outOfReach = (s: LaunchState['skills'][number]): string | null => {
    if (reachable.get(s.id) !== false) return null
    return s.reach === 'project' && s.root
      ? `Only loadable inside ${s.root.split('/').pop()}`
      : 'No Claude Code session on this machine can load this'
  }

  // The cap used to be a flat 24 rows behind a 256px window, so it was invisible
  // twice over: you could not see the rows it kept and you could not see that it
  // had kept any. Six is a browse window rather than a peephole, and what it
  // hides is on screen as a count you can press.
  const shown = expanded ? matches : matches.slice(0, PEEK)

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])

  const named = (id: string) => all.find(s => s.id === id)

  return (
    <section className="py-4">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-eyebrow uppercase text-fg-mute">Skills</h3>
        {/* The control that reveals the field, and the field itself, in the same
            slot — so revealing it moves nothing below. */}
        <span className="ml-auto">
          {searching ? (
            <span className="flex items-center gap-2 px-2 h-8 rounded-control border border-edge glass-raise">
              <Search size={14} className="text-fg-mute shrink-0" aria-hidden />
              <input
                ref={field}
                value={q}
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setQ(''); setSearching(false) } }}
                placeholder={`Search ${all.length}`}
                aria-label="Search skills"
                className="hit-native [--hit-ink:32px] h-full w-36 sm:w-56 min-w-0 bg-transparent
                           outline-none text-sm text-fg placeholder:text-fg-mute"
              />
              <button
                type="button"
                onClick={() => { setQ(''); setSearching(false) }}
                aria-label="Stop searching skills"
                title="Stop searching"
                className="shrink-0 text-fg-mute hover:text-fg-dim transition-colors duration-100"
              >
                <X size={14} />
              </button>
            </span>
          ) : (
            <Button size="md" variant="default" onClick={() => setSearching(true)}
              title="Search skills" ariaLabel="Search skills">
              <Search size={14} /> Search
            </Button>
          )}
        </span>
      </div>

      {selected.map(id => (
        <div key={id} className="flex items-center gap-2 h-8 border-b border-rule last:border-0">
          <Sparkles size={14} className="text-fg-mute shrink-0" />
          <span className="text-sm text-fg-dim truncate grow min-w-0 font-mono">
            {id.split('/').pop()}
          </span>
          {/* Gone below `sm`, rather than squeezed into 45% of a 343px row. This
              blurb's job is choosing, and on a row for something already chosen
              it is the second thing competing for a width that only holds one. */}
          <span className={`hidden sm:block text-sm truncate shrink-0 max-w-[55%] ${
            named(id) && outOfReach(named(id)!) ? 'text-bad' : 'text-fg-mute'}`}>
            {(named(id) && outOfReach(named(id)!)) ?? blurbOf(named(id))}
          </span>
          <Button size="sm" variant="ghost" title="Remove" ariaLabel="Remove" onClick={() => toggle(id)}>
            <X size={14} />
          </Button>
        </div>
      ))}

      <div className={NAME_GRID}>
        {shown.map(s => (
          <PickRow
            key={s.id}
            label={s.name}
            mono
            // The refusal replaces the blurb rather than sitting beside it: on a
            // 343px row there is one slot, and "you cannot use this here" beats
            // a description of what it would have done.
            blurb={outOfReach(s) ?? blurbOf(s)}
            dim={!!outOfReach(s)}
            on={selected.includes(s.id)}
            onToggle={() => toggle(s.id)}
            open={info === s.id}
            onInfo={() => setInfo(v => (v === s.id ? null : s.id))}
          />
        ))}
      </div>

      {/* The rest of the list, as a count rather than as a scrollbar. It says the
          number because the number is the fact being withheld, and it is the one
          place here a count belongs — the section heading is a label, not a
          readout. Bordered rather than ghost, because a lone muted label under a
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

/* --------------------------- the brief, as a hatch ------------------------- */

/**
 * How it should run, the brief itself, and the way into the session with no
 * brief at all — the three things that are true of a hand-off and that nobody
 * needs to see to make one.
 *
 * All three used to be on the first screen. The permission mode came with a
 * paragraph explaining what a `--permission-mode` flag is; the brief came with a
 * commit button of its own called `Write the brief`, which had to be pressed
 * before the real commit was reachable. Both are decisions this surface can make
 * for him — bypass, and pack on Send — and a decision the product can make is
 * not a step the product should ask for.
 */
function RunPanel({
  mode, model, session, page, draft, setBrief, onWrite, provenance,
}: {
  mode: PermissionMode
  model: SessionModel
  /** The session being resumed, if one was chosen. It changes what the mode means. */
  session: string | null
  page: boolean
  draft: { packId: string; brief: string } | null
  setBrief: (text: string) => void
  onWrite: () => Promise<{ packId: string; brief: string }>
  provenance: string
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const write = async () => {
    setBusy(true)
    setErr(null)
    try { await onWrite() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <>
      <section className="py-4">
        <h3 className="text-eyebrow uppercase text-fg-mute mb-2">How it runs</h3>
        <Segmented
          options={PERMISSION_MODES.map(m => ({ id: m.id, label: m.label }))}
          value={mode}
          onChange={setLaunchPermissionMode}
          ariaLabel="Permission mode"
        />
        {/* One clause, and only the one that is not obvious from the control: a
            conversation already running keeps whatever it was started with, and
            a control that silently claimed otherwise would be lying. */}
        {session && (
          <p className="text-sm text-fg-mute mt-2 leading-snug">
            A session that is already running keeps the mode it started with.
          </p>
        )}
      </section>

      {/*
        Which model, on the same surface and in the same shape as the mode.

        `--model` was never passed at all, so every session Wake started ran on
        whatever Claude Code picked and there was no way to say otherwise from
        here — which on a phone means no way at all.

        Aliases rather than full names: `claude --help` documents `'fable'`,
        `'opus'`, `'sonnet'` as "an alias for the latest model", and a pinned
        `claude-opus-4-5` in a picker he keeps for a year is a version that gets
        retired from under him. `Default` passes no flag, which leaves the
        choice where it already was.

        Hidden while resuming, for the same reason the sentence above exists: a
        running process was started with a model and cannot be moved to another
        one, so offering the control would be offering something that does
        nothing.

        Five segments fit, and that was measured rather than assumed: the group
        is **316px** at `text-sm`, against the 327 a 375px phone leaves inside
        `pad-x`, and the document's `scrollWidth` still equals its `clientWidth`
        — which is the rule this product actually holds itself to. Eleven pixels
        is not much margin, so the number is written down here: a sixth alias, or
        a longer word than `Default`, is the point at which this has to become a
        `Menu` like the one on the `/sessions/new` composer.
      */}
      {!session && (
        <section className="py-4">
          <h3 className="text-eyebrow uppercase text-fg-mute mb-2">Model</h3>
          <Segmented
            options={SESSION_MODELS.map(m => ({ id: m.id, label: m.label }))}
            value={model}
            onChange={setLaunchModel}
            ariaLabel="Model"
          />
        </section>
      )}

      <section className="py-4">
        <h3 className="text-eyebrow uppercase text-fg-mute mb-2">The packed brief</h3>
        <p className="text-sm text-fg-mute mb-2 tnum">{provenance}</p>

        {draft
          ? <Review brief={draft.brief} setBrief={setBrief} page={page} />
          : (
            <>
              <p className="text-sm text-fg-mute mb-2 leading-snug">
                Send packs this itself. Read it first if you want to see exactly what leaves.
              </p>
              <Button size="md" variant="default" onClick={write} disabled={busy}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                {busy ? 'Packing' : 'Show the packed brief'}
              </Button>
            </>
          )}
        {err && <p className="text-sm text-bad mt-2 leading-snug">{err}</p>}
      </section>

      {session && <OpenSession sessionId={session} />}
    </>
  )
}

/**
 * The brief, editable, in the shape of the thing it is.
 *
 * It was `font-mono` in a fixed `44vh` box, and that pair is most of why this
 * product read as a terminal: a brief is prose with a few paths in it, and
 * setting the whole of it in a monospace slot says the reader is expected to
 * parse rather than to read. It is body text now, in a box that starts tall
 * enough to hold a paragraph and can be dragged taller.
 *
 * Whatever is in this field at the moment he sends is what goes — that is the
 * whole reason the step exists, and why the state this writes is the state the
 * commit reads. There is no counter under it: there used to be `N / 12,000`, and
 * that was true of a URL a browser will refuse past a length. A brief handed to
 * a process on this box is passed whole, so a budget on screen would be a number
 * measuring nothing on the one surface whose job is to be read before it is
 * trusted.
 */
function Review({
  brief, setBrief, page,
}: {
  brief: string
  setBrief: (text: string) => void
  /** Drawn on the phone's page rather than in the sheet. See `LaunchSheet`. */
  page: boolean
}) {
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  /** Dictation lands where the cursor is, not always at the end. */
  const insert = (text: string) => {
    const el = ref.current
    if (!el) return setBrief(brief ? `${brief} ${text}` : text)
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
    <div>
      <div className="relative">
        <textarea
          ref={ref}
          value={brief}
          onChange={e => setBrief(e.target.value)}
          spellCheck={false}
          aria-label="The packed brief"
          className={`${inputClass} leading-relaxed resize-y pr-10
                      ${page ? 'min-h-72 h-[46dvh]' : 'min-h-72 h-[40dvh]'}`}
        />
        <div className="absolute right-2 top-2">
          <Mic onText={insert} title="Dictate into the brief" />
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2">
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

/**
 * Into the session with nothing to say.
 *
 * The other half of the same door: sometimes what he wants is not to write
 * anything, it is to be back inside the conversation he was in.
 * `openTerminalAndGo` reattaches when Wake is already holding it and resumes
 * when it is not, so this is one control for both, and either way it ends on the
 * session with a cursor in it.
 *
 * A refusal — the box has no tmux, the session is not on this machine — comes
 * back as the server's own sentence and is printed under the control. It is not
 * swallowed and it is not a status code.
 */
function OpenSession({ sessionId }: { sessionId: string }) {
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
    <section className="py-4">
      <h3 className="text-eyebrow uppercase text-fg-mute mb-2">This session</h3>
      <Button size="md" variant="secondary" onClick={go} disabled={busy}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <SquareTerminal size={14} />}
        {busy ? 'Opening' : 'Open it without sending anything'}
      </Button>
      {err && <p className="text-sm text-bad mt-2 leading-snug">{err}</p>}
    </section>
  )
}
