/**
 * "Open in Claude" on the client.
 *
 * The selection lives here rather than inside one sheet, because a hand-off can
 * be started from a card, a mail thread or the palette, and all of them add to
 * the same basket. `openLaunch()` is idempotent by ref so clicking it twice does
 * not pack the same thread twice.
 */

import { useCallback, useSyncExternalStore } from 'react'

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
 * The whole config, not a summary: the browser builds the link itself as you
 * edit the brief, using the same `handoffFor` the server does.
 */
export type HandoffTarget = import('../../shared/handoff').HandoffConfig

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
  session: null, permissionMode: storedMode(),
}
const listeners = new Set<() => void>()
const set = (p: Partial<Basket>) => {
  basket = { ...basket, ...p }
  listeners.forEach(l => l())
}

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

/** Add objects and open the sheet. Duplicate refs collapse rather than stack. */
export function openLaunch(
  items: PackItem[],
  opts: {
    template?: string; templates?: string[]; repoHint?: string | null
    title?: string | null; session?: string | null
  } = {},
) {
  const seen = new Set(basket.items.map(i => `${i.kind}:${i.ref}`))
  const merged = [...basket.items, ...items.filter(i => !seen.has(`${i.kind}:${i.ref}`))]
  const templates = opts.templates ?? (opts.template ? [opts.template] : basket.templates)
  set({
    open: true,
    items: merged,
    templates,
    repoHint: opts.repoHint ?? basket.repoHint,
    title: opts.title ?? basket.title,
    session: opts.session ?? basket.session,
  })
}

/** Which session the brief is about. `null` is `A new conversation`. */
export const setLaunchSession = (id: string | null) => set({ session: id })

export function setLaunchPermissionMode(mode: PermissionMode) {
  set({ permissionMode: mode })
  try { localStorage.setItem(MODE_KEY, mode) } catch { /* see storedMode */ }
}
export const removeFromLaunch = (ref: string) => set({ items: basket.items.filter(i => i.ref !== ref) })

/**
 * Every dismissal empties the basket.
 *
 * `closeLaunch` used to set `{ open: false }` and nothing else, while
 * `resetLaunch` — the one that actually clears it — was called from exactly one
 * place: the final anchor's onClick. So the basket emptied only on the success
 * path. Open one card's brief, press Escape, open a different card, and the
 * sheet read `CONTEXT — 4 OBJECTS`, three of them from the card he walked away
 * from — and `repoHint` was sticky too, so an abandoned card's repository could
 * silently become the next brief's working directory.
 */
export const closeLaunch = () => resetLaunch()

/** Empty it. A brief handed over should not leave its objects in the basket. */
export const resetLaunch = () =>
  // `permissionMode` deliberately survives — it is a standing preference, not
  // something this brief chose. Everything that belongs to one hand-off goes.
  set({ open: false, items: [], templates: [], repoHint: null, title: null, session: null })

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
