/**
 * "Open in Claude" on the client.
 *
 * The selection lives here rather than inside one sheet, because a hand-off can
 * be started from a card, a mail thread or the palette, and all of them add to
 * the same basket. `openLaunch()` is idempotent by ref so clicking it twice does
 * not pack the same thread twice.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { handoffFor, type HandoffConfig } from '../../shared/handoff'

/**
 * `task` is Wake's own object rather than somebody else's.
 *
 * It was the missing link in the chain the product exists to serve — row → task
 * → stickies → Open in Claude → Pulse. `openLaunch` had three callers (the
 * palette, a card, a mail thread) and Work had none, and a task could not be an
 * object in a brief even if a button had existed.
 */
export type SlotKind = 'card' | 'mail' | 'slack' | 'sentry' | 'notion' | 'github' | 'session' | 'note' | 'task'

export type PackItem = {
  kind: SlotKind
  ref: string
  title?: string | null
  url?: string | null
  excerpt?: string | null
  why?: string | null
  /** Facts worth stating as facts: a channel, a PR number, a session's cwd. */
  meta?: Record<string, string | number | boolean | null> | null
  /**
   * The desk row this object came off, when it came off one.
   *
   * Not a fact about the object, and not part of the brief: it is how the sheet
   * asks `/api/cards/<group>/slack` which conversation the row is, so the reply
   * picker can offer the replies Wake already holds. The card is the only thing
   * that knows its own group key and `cardContext` is the only place that sees
   * a whole card, so it rides in on the items rather than through a prop the
   * detail pane would have to be edited to pass.
   *
   * `createPack` strips it on the way out. A pack file says what a brief is
   * made of, not how the sheet found it.
   */
  group?: string | null
}

export type Template = {
  id: string
  label: string
  blurb: string
  slots: SlotKind[]
  skills: string[]
  defaultRepo: string | null
  instruction: string
  /**
   * What kind of thing this template is.
   *
   * Ten of them say what to find out. One — the Humanizer — says how the last
   * message reads, and is meant to be chosen *on top of* one of the others
   * rather than instead of it. The picker is the only surface where that
   * distinction can be shown, so it is the only reason this field exists.
   *
   * Optional because the ten that predate it do not carry it, and absent reads
   * as `investigation` everywhere. See HANDOFF_HUMANIZER.md.
   */
  kind?: 'investigation' | 'voice'
}

/**
 * Where a brief goes, how it is prefilled, and how much of one fits.
 *
 * The whole config, not a summary: the browser builds the link itself, using the
 * same arithmetic the server runs. Two implementations of "how much fits" would
 * drift, and the failure mode is the worst kind — the composer says it all fits
 * and the link quietly carries less.
 */
export type HandoffTarget = HandoffConfig

/**
 * The hatch: a new conversation in the Claude app, carrying this text.
 *
 * The composer's primary control sends into a Claude Code session running on
 * this box, which is the thing worth having. This is what is left when the box
 * is not reachable — a phone, away from the desk, with a thread worth pasting
 * somewhere that can read it. It is a **new conversation** every time: no URL
 * reaches an existing one, so this can never carry a session id, and the control
 * that renders it says so in as many words.
 *
 * The destination is the server's own hand-off config rather than a literal
 * written into a component, so a deployment that moves `WAKE_HANDOFF_URL` is
 * followed rather than contradicted — and the trim note comes along for free,
 * which is the difference between a session that knows it received half a thread
 * and one that answers the wrong question confidently.
 */
export const claudeAppUrl = (cfg: HandoffTarget, text: string): string =>
  handoffFor(text, cfg).url

/** What the server recorded when a brief was handed over. */
export type Handoff = {
  packId: string
  url: string
  cwd: string
  packPath: string | null
  sent: number
  total: number
  trimmed: boolean
}

export type Session = {
  id: string
  title: string
  /** Where it actually ran, out of the transcript. Never reconstructed. */
  cwd: string
  project: string
  lastPrompt: string | null
  /**
   * User turns in the tail the server read, not in the session. Every surface
   * that renders it says `turns in view`, because a transcript is megabytes and
   * only its tail is opened.
   */
  turns: number
  lastTs: number
  path: string
  pr: { url: string; repo: string; number: number } | null
  branch?: string | null
  version?: string | null
  entrypoint?: string | null
  permissionMode?: string | null
  /** Running on the box right now, from Claude Code's own per-process files. */
  live?: boolean
  /**
   * Put away, in Wake's own database.
   *
   * The one field on this type that is not a fact about the transcript. Claude
   * Code has no archive, so there is nothing on disk to read it from and
   * nothing on disk to write it to — see migration 13.
   */
  archived?: boolean
}

/**
 * The two real `--permission-mode` values a session is started under.
 *
 * They used to be values a brief could only *describe*: the hand-off was a
 * `claude.ai/new?q=` link, that URL carries a prompt and nothing else, and the
 * mode reached the session only as a sentence asking it to behave. It is now a
 * real flag on a real process — the pack row carries it and
 * `POST /api/claude/terminals` starts the session with it.
 *
 * `bypassPermissions` is the default position. A brief is written, read and
 * approved before it is sent; asking again at the terminal is asking the same
 * question twice.
 */
export type PermissionMode = 'bypassPermissions' | 'acceptEdits'
export const PERMISSION_MODES: ReadonlyArray<{ id: PermissionMode; label: string }> = [
  { id: 'bypassPermissions', label: 'Bypass permissions' },
  { id: 'acceptEdits', label: 'Accept edits' },
]
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions'

export type Pack = {
  id: string
  template: string
  templates?: string[]
  title: string
  cwd: string
  repo_name: string | null
  status: string
  created_at: number
  launched_at: number | null
  pack_path?: string | null
  first_message?: string
  items?: Array<PackItem & { id: string }>
  skills?: string[]
}

export type Skill = {
  id: string
  name: string
  catalog: string
  title: string | null
  description: string | null
  whenToUse: string | null
  mutating: boolean
}

/**
 * One skill, whichever way it was named.
 *
 * The catalog keys a skill `B/truto-cli-toolbelt`; every template names the
 * bare `truto-cli-toolbelt`. So a template's preselection matched no row, the
 * check never appeared, clicking the row *added* it a second time, and the
 * count read `SKILLS — 4` for three skills. The server's `getSkill` has had the
 * bare-name fallback all along — this is the same rule, on this side of the
 * wire, so both agree on what a skill is.
 */
export function resolveSkillId(all: ReadonlyArray<Skill>, value: string): string {
  const v = value.trim()
  if (!v) return v
  if (all.some(s => s.id === v)) return v
  const byName = all.filter(s => s.name === v)
  return byName.length === 1 && byName[0] ? byName[0].id : v
}

/** Resolve a list, then drop anything that would render as a duplicate line. */
export function resolveSkillIds(all: ReadonlyArray<Skill>, values: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const id = resolveSkillId(all, raw)
    if (!id) continue
    const bare = id.split('/').pop()!
    if (seen.has(bare)) continue
    seen.add(bare)
    out.push(id)
  }
  return out
}

export type LaunchState = {
  handoff: HandoffTarget
  skills: Skill[]
  templates: Template[]
  repos: Array<{ name: string; path: string; role: string; branch: string | null; dirty: number }>
  sessions: Session[]
  packs: Pack[]
  defaultPermissionMode: PermissionMode
  /**
   * Whether this box can start a session at all.
   *
   * On `/state` so the sheet can be off *with a reason* — `tmux` missing,
   * `python3` missing, no `claude` binary — instead of offering a commit that
   * answers 503 after the brief has been written and read. `missing` is the
   * server's own sentence naming what is absent.
   *
   * Optional because a Wake that has not deployed the terminal routes yet still
   * serves a `/state` without it, and a sheet that crashes on a missing key is
   * a worse failure than one that assumes the box is fine and reports the 503.
   */
  terminal?: {
    available: { ok: boolean; tmux: boolean; python: boolean; claude: boolean; missing: string | null }
    running: Array<{ id: string; sessionId: string; cwd: string; repo: string | null }>
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/claude${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((body as any).error ?? `${r.status}`)
  return body as T
}

export const launchApi = {
  state: () => req<LaunchState>('/state'),
  createPack: (b: {
    templates: string[]
    title?: string
    cwd?: string | null
    instruction?: string
    items: PackItem[]
    skills?: string[]
    sessionId?: string | null
    permissionMode?: PermissionMode
  }) => req<Pack>('/packs', {
    method: 'POST',
    // `group` is the sheet's own routing key and never the brief's business —
    // see `PackItem.group`. Dropped here rather than at every call site, so
    // there is one place that decides what a pack item is on the wire.
    body: JSON.stringify({ ...b, items: b.items.map(({ group, ...item }) => item) }),
  }),
  /**
   * One more turn in a conversation already underway.
   *
   * The route refuses, in a sentence, a session that has stopped and a session
   * running in a terminal Wake did not start. That refusal is the point: the id
   * used to be handed to `--resume`, and Claude Code was left to be the one that
   * announced the conversation was archived — on a phone, after the tap.
   */
  send: (id: string, text: string) =>
    req<{ ok: true }>(`/sessions/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  sessions: (opts: { all?: boolean; repo?: string; window?: number; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.all) q.set('all', '1')
    if (opts.repo) q.set('repo', opts.repo)
    if (opts.window) q.set('window', String(opts.window))
    if (opts.limit) q.set('limit', String(opts.limit))
    const s = q.toString()
    return req<{ sessions: Session[] }>(`/sessions${s ? `?${s}` : ''}`)
  },
  /**
   * Put a session away, or take it back out.
   *
   * No confirmation step, unlike the delete below: this writes one row in
   * Wake's own database, touches nothing under `~/.claude`, and the way back is
   * the same call with `false`.
   */
  archiveSession: (id: string, archived: boolean) =>
    req<{ ok: true; archived: boolean }>(
      `/sessions/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) },
    ),
  /**
   * Step one of a delete: what would go, and a token bound to this id.
   * Two calls, because the dialog has to be able to name the four paths.
   */
  confirmDeleteSession: (id: string) =>
    req<{ token: string; expiresAt: number; paths: string[]; title: string }>(
      `/sessions/${id}/delete/confirm`, { method: 'POST', body: '{}' },
    ),
  deleteSession: (id: string, token: string) =>
    req<{ ok: true; removed: string[]; kept: string[] }>(
      `/sessions/${id}?token=${encodeURIComponent(token)}`, { method: 'DELETE' },
    ),
  /**
   * Record what was actually handed over. `brief` is the edited text, which
   * becomes the stored copy and the file on disk — a record of the draft Wake
   * happened to render first is not an audit trail.
   */
  open: (id: string, brief?: string) =>
    req<Handoff>(`/packs/${id}/open`, { method: 'POST', body: JSON.stringify({ brief }) }),
  pack: (id: string) => req<Pack>(`/packs/${id}`),
  packs: () => req<{ packs: Pack[] }>('/packs'),
  packFileUrl: (id: string) => `/api/claude/packs/${id}/file`,
}

/* ----------------------------- the open basket ---------------------------- */

type Basket = {
  open: boolean
  items: PackItem[]
  /** Every template the opener suggested. Multi-select, all the way down. */
  templates: string[]
  /** The repository the card knew about, so the brief does not default to ~/work. */
  repoHint: string | null
  title: string | null
  /**
   * The Claude Code session this brief goes to, or null for a new one.
   *
   * It used to be context and not continuity: the hand-off was a link to a chat
   * surface, no URL reaches an existing conversation, and choosing a session
   * bought its directory, its branch and a `claude --resume` line to paste
   * somewhere else. The brief now goes to a Claude Code process on this box, so
   * naming a session here is the session that is resumed — `--resume <id>`, in
   * the directory it already ran in, with everything it already knows.
   */
  session: string | null
  permissionMode: PermissionMode
  /**
   * What this composer was opened *about* — see `subjectOf`.
   *
   * It exists so that leaving the composer and coming back to the same card can
   * be told apart from leaving it and opening a different one. The first is one
   * piece of work interrupted; the second is a new brief, and only the second
   * may inherit nothing.
   */
  subject: string
  /**
   * The half-written brief, which survives leaving the room.
   *
   * On a laptop the composer is a modal and the way out of it is a deliberate
   * Escape or X. On a phone it is a page, and the way out of a page is Back —
   * a navigation, pressed to go and look at something, not a decision to throw
   * the brief away. So nothing about the brief is destroyed by leaving; it is
   * destroyed by committing it, or by opening a different one.
   */
  draft: Draft
}

/**
 * Everything the composer holds that is not already a field of the basket.
 *
 * `templates`, `session` and `permissionMode` are basket fields because the
 * *opener* supplies them; these four are what he then does inside the composer,
 * and they used to live in `useState` inside a component that unmounts the
 * moment the surface closes. `null` means "nothing has been decided here yet",
 * which is a different answer from an empty list — a template list he has
 * emptied on purpose must not fall back to the opener's suggestion.
 */
export type Draft = {
  templates: string[] | null
  cwd: string | null
  skills: string[] | null
  instruction: string
  /** The written brief and the pack it belongs to, once `Write the brief` ran. */
  brief: { packId: string; text: string } | null
}

const NO_DRAFT = (): Draft =>
  ({ templates: null, cwd: null, skills: null, instruction: '', brief: null })

/**
 * The signature of the brief a composer was opened for.
 *
 * The objects it was handed, the templates suggested with them, and the
 * repository hint that came along — in a stable order, so the same card opened
 * twice produces the same string and two different cards cannot. It is
 * deliberately not the card's title or its own key: the composer is opened from
 * a card, a mail thread, a task and the palette, and what all four have in
 * common is the object list.
 */
function subjectOf(items: PackItem[], templates: string[], repoHint: string | null): string {
  return JSON.stringify([
    items.map(i => `${i.kind}:${i.ref}`).sort(),
    [...templates].sort(),
    repoHint ?? '',
  ])
}

/**
 * The mode is remembered across sheets; nothing else in the basket is.
 *
 * It is a preference about how he works rather than a fact about this brief,
 * and re-picking it on every hand-off is the kind of small tax that makes a
 * control feel like paperwork.
 */
const MODE_KEY = 'wake.launch.permissionMode'
const storedMode = (): PermissionMode => {
  try {
    const v = localStorage.getItem(MODE_KEY)
    return PERMISSION_MODES.some(m => m.id === v) ? (v as PermissionMode) : DEFAULT_PERMISSION_MODE
  } catch {
    // Private mode, a blocked origin, a browser with storage off. The default
    // is the right answer in all three, and none of them is an error.
    return DEFAULT_PERMISSION_MODE
  }
}

let basket: Basket = {
  open: false, items: [], templates: [], repoHint: null, title: null,
  session: null, permissionMode: storedMode(), subject: '', draft: NO_DRAFT(),
}
const listeners = new Set<() => void>()
const set = (p: Partial<Basket>) => {
  basket = { ...basket, ...p }
  listeners.forEach(l => l())
}

/**
 * Write into the draft without waking anything up.
 *
 * Every keystroke in the instruction field and every keystroke in the brief
 * lands here. Nothing renders *from* the draft — it is read once, when the
 * composer mounts, to seed the fields — so notifying the store on each one would
 * re-render the whole surface for a value nobody is watching. The object is
 * mutated in place, which `set`'s own spread carries by reference, so a later
 * `set` cannot silently drop what was typed a moment ago.
 */
export const rememberLaunch = (p: Partial<Draft>) => { Object.assign(basket.draft, p) }

/** The draft as it stands. Read at mount; see `rememberLaunch`. */
export const launchDraft = (): Readonly<Draft> => basket.draft

/**
 * The basket as it stands, without a component.
 *
 * `useSyncExternalStore` wants a snapshot function, and this is it — named,
 * rather than two closures written out at the call site, so there is one answer
 * to "what is in the basket" and React and everything else read the same one.
 * The store is otherwise private, and a mutation that could only be observed
 * through a rendered component would be a mutation nothing but a browser can
 * check.
 */
export const launchBasket = (): Readonly<Basket> => basket

export function useLaunchBasket() {
  return useSyncExternalStore(
    useCallback((l: () => void) => (listeners.add(l), () => listeners.delete(l)), []),
    launchBasket,
    launchBasket,
  )
}

/**
 * Add objects and open the composer. Duplicate refs collapse rather than stack.
 *
 * **A fresh open of a different brief starts clean, and that check belongs
 * here.** It used to be enforced at the other end: every dismissal emptied the
 * basket, because "open one card's brief, press Escape, open a different card"
 * showed the second card the first one's four objects. But the bug in that
 * sentence is the *third* clause, not the second — what leaked was one brief's
 * objects into another brief, and the moment that becomes visible is the open.
 * Deciding it here is what makes it safe for leaving to preserve everything:
 * come back to the same card and the composer is where you left it; go to a
 * different one and it is empty, which is the property the old rule was
 * protecting all along.
 *
 * While it is already open this stays purely additive — the Slack reply picker
 * and the session picker both attach through it, and neither is a new brief.
 */
export function openLaunch(
  items: PackItem[],
  opts: {
    template?: string; templates?: string[]; repoHint?: string | null
    title?: string | null; session?: string | null
  } = {},
) {
  /*
   * The subject is built from what this call *asks for*, never from what is
   * left in the basket.
   *
   * `templates` below falls back to `basket.templates`, which is right for an
   * attach from inside an open composer and is a leak in the one place the
   * subject is decided: a fresh open with no template of its own would compute
   * its signature from the *previous* brief's templates, and then write them
   * back over the clear that had just removed them. Two calls that ask for the
   * same thing have to produce the same string whatever the basket happens to
   * hold, which is exactly what makes "the same card resumes" true.
   */
  const asked = opts.templates ?? (opts.template ? [opts.template] : [])
  const subject = subjectOf(items, asked, opts.repoHint ?? null)
  if (!basket.open && subject !== basket.subject) clearLaunch()

  const seen = new Set(basket.items.map(i => `${i.kind}:${i.ref}`))
  const merged = [...basket.items, ...items.filter(i => !seen.has(`${i.kind}:${i.ref}`))]
  set({
    open: true,
    items: merged,
    // Read after the clear, deliberately: a fresh open of a different brief has
    // nothing to fall back to, which is the point.
    templates: opts.templates ?? (opts.template ? [opts.template] : basket.templates),
    repoHint: opts.repoHint ?? basket.repoHint,
    title: opts.title ?? basket.title,
    session: opts.session ?? basket.session,
    // Only a fresh open names the subject. An attach from inside the composer
    // adds an object to the brief he is already writing; it does not make it a
    // different brief.
    ...(basket.open ? {} : { subject }),
  })
  markLaunchHistory()
}

/** Which session the brief is about. `null` is `A new conversation`. */
export const setLaunchSession = (id: string | null) => set({ session: id })

export function setLaunchPermissionMode(mode: PermissionMode) {
  set({ permissionMode: mode })
  try { localStorage.setItem(MODE_KEY, mode) } catch { /* see storedMode */ }
}
export const removeFromLaunch = (ref: string) => set({ items: basket.items.filter(i => i.ref !== ref) })

/**
 * Leaving the composer, which is not the same as throwing the brief away.
 *
 * This used to be `resetLaunch` outright: every dismissal emptied the basket,
 * because the alternative at the time was a `{ open: false }` that let one
 * card's objects turn up under the next card's heading. That fix worked and it
 * was aimed one step too late — see `openLaunch`, which now refuses the leak at
 * the point it would become visible.
 *
 * What it cost is the thing a phone cannot afford. On a phone the composer is a
 * page and the way out of a page is Back; on either device the reason to leave
 * mid-brief is almost always to go and *read* something — the thread on the card
 * underneath, the repository he half-remembers. Emptying on the way out means
 * that trip costs him everything he had typed, with no warning and no undo, on
 * the one surface in the product whose content is written by hand.
 *
 * So leaving keeps all of it: the objects, the templates, the repository, the
 * skills, the instruction and the brief itself. Coming back to the same card
 * resumes; opening a different one starts clean; committing clears. There is no
 * "are you sure" anywhere in that, because nothing is being destroyed.
 */
export const closeLaunch = () => {
  set({ open: false })
  unmarkLaunchHistory()
}

/**
 * Empty it. A brief handed over should not leave its objects in the basket.
 *
 * This is the commit path — the session has started and the page has moved to
 * the terminal — so it takes the draft with it. Leaving is `closeLaunch`.
 */
export const resetLaunch = () => {
  clearLaunch()
  unmarkLaunchHistory()
}

/**
 * The basket with one hand-off's worth of state taken out of it.
 *
 * `permissionMode` deliberately survives — it is a standing preference, not
 * something this brief chose. Everything else that belongs to one brief goes,
 * including the draft and the subject that says which brief it was.
 */
const clearLaunch = () =>
  set({
    open: false, items: [], templates: [], repoHint: null, title: null,
    session: null, subject: '', draft: NO_DRAFT(),
  })

/* ------------------------ the phone's own Back button --------------------- */

/**
 * The width below which the composer is a page rather than a modal.
 *
 * The same 640 the rest of the product calls a phone: it is where the shell
 * swaps its left rail for a bottom tab bar, where `--nav-h` grows to 53px, and
 * where every `sm:` in the composer's own layout flips. One number, stated in
 * four places that all have to agree, so it is written here as the query the
 * stylesheet already runs.
 */
export const PHONE_COMPOSER = '(max-width: 639.98px)'
export const composerIsAPage = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_COMPOSER).matches

/**
 * A history entry the OS Back button can land on, and nothing else.
 *
 * A page whose Back button does not work is not a page. The composer has an
 * on-screen back control — that is the one a reader presses — but on a phone the
 * gesture that means "out of here" is an edge swipe, and without this it would
 * pop the *card detail underneath* while the composer stayed up: the surface he
 * is looking at would not change and the one behind it would silently close.
 *
 * The entry carries no URL of its own. `pushState` is given `location.href`
 * unchanged, so nothing about the address bar moves, `route.ts` sees no change
 * and notifies nobody, and the composer stays what it is — a surface, not a
 * destination. A real route would be better and would belong in `route.ts`; this
 * is the version that does not reach into a file this change does not own.
 *
 * Only on a phone. On a laptop the composer is a modal with an X and an Escape,
 * and a modal that also eats the browser's Back button is a modal that has
 * started making navigation decisions.
 *
 * The marker is checked before every unwind rather than remembered in a
 * variable, so the two ways this can go wrong are both safe: something else
 * pushed on top of us (a commit navigating to `/terminal/<id>`) and the stale
 * entry is simply left in the stack, or the push never happened and there is
 * nothing to pop.
 */
let watchingBack = false

function onLaunchPop() {
  // Our entry has just been popped. Suspend, keeping everything — Back is a way
  // out of the room, not a decision about the brief. See `closeLaunch`.
  if (basket.open && !window.history.state?.wakeLaunch) set({ open: false })
}

function markLaunchHistory() {
  if (!composerIsAPage()) return
  if (window.history.state?.wakeLaunch) return
  window.history.pushState({ wakeLaunch: true }, '', window.location.href)
  if (!watchingBack) {
    window.addEventListener('popstate', onLaunchPop)
    watchingBack = true
  }
}

function unmarkLaunchHistory() {
  if (typeof window === 'undefined') return
  if (window.history.state?.wakeLaunch) window.history.back()
}

/**
 * A task, as objects a brief can carry.
 *
 * The task itself, then one `note` slot per sticky — a slot every template has
 * listed since the first release and nothing has ever filled. Stickies are the
 * operator's own words about this task, they are short by construction, and they
 * are the highest-signal thing in any brief.
 *
 * The provenance comes from the task's frozen `origin_*` columns rather than
 * from the card it was made from: the card is swept when its source stops
 * returning it, and the whole point of freezing was that the brief still knows
 * why the task exists after the pull request merges.
 */
export function taskContext(task: {
  id: string; title: string; detail?: string | null
  notes?: Array<{ id: string; body: string }>
  origin_source?: string | null; origin_title?: string | null; origin_why?: string | null
  origin_url?: string | null; origin_excerpt?: string | null; origin_meta?: string | null
  due_at?: number | null
}, goal?: { title: string } | null): PackItem[] {
  const meta: Record<string, string | number | boolean | null> = {}
  if (goal?.title) meta.goal = goal.title
  if (task.due_at) meta.due = new Date(task.due_at).toISOString()
  if (task.origin_source) meta.came_from = task.origin_source
  if (task.origin_why) meta.why_it_exists = task.origin_why

  const items: PackItem[] = [{
    kind: 'task',
    ref: `task:${task.id}`,
    title: task.title,
    url: task.origin_url?.startsWith('http') ? task.origin_url : null,
    excerpt: task.detail?.trim() || task.origin_excerpt || null,
    why: task.origin_why ?? 'on your own list',
    meta,
  }]

  for (const n of task.notes ?? []) {
    items.push({
      kind: 'note',
      ref: `note:${n.id}`,
      title: 'Note',
      excerpt: n.body,
      why: 'your own note on this task',
      meta: {},
    })
  }
  return items
}

/**
 * Which repository a task concerns, if its frozen provenance knows.
 * `origin_meta` is the card's `meta` as stored JSON.
 */
export function taskRepoHint(originMeta: string | null | undefined): string | null {
  if (!originMeta) return null
  try {
    const m = JSON.parse(originMeta) as Record<string, unknown>
    if (typeof m.cwd === 'string') return m.cwd
    if (typeof m.repo === 'string') return m.repo.split('/').pop() ?? null
  } catch { /* a task with unreadable provenance simply has no hint */ }
  return null
}
