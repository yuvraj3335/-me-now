import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { Analytics, CardPriority, CardStatus, SourceStatus, State, SourceName } from './types'
import { pipesFor } from './bucket'

/** What `POST /connections/:source/start` answers with, success or not. */
export type ConnectStart = {
  status?: number
  url?: string
  error?: string
  detail?: string
  redirectUri?: string
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`)
  return r.json() as Promise<T>
}

const post = <T,>(p: string, body?: unknown) =>
  req<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const patch = <T,>(p: string, body: unknown) => req<T>(p, { method: 'PATCH', body: JSON.stringify(body) })
const del = <T,>(p: string) => req<T>(p, { method: 'DELETE' })

/* ------------------------------- the store ------------------------------- */

type Store = {
  state: State | null
  error: string | null
  loading: boolean
  /**
   * A pipe-1 poll is in flight, wherever it was started from.
   *
   * Read by the Sync control, which is why it is here rather than in that
   * control's own `useState`: the command palette runs the same poll, and a
   * button that sat still through a sync somebody had just ordered was a button
   * denying what the page was doing.
   */
  syncing: boolean
}

let store: Store = { state: null, error: null, loading: true, syncing: false }
const listeners = new Set<() => void>()

function set(patchObj: Partial<Store>) {
  store = { ...store, ...patchObj }
  listeners.forEach(l => l())
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l))
const snapshot = () => store

export function useStore() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

let inflight: Promise<void> | null = null

/** Reload server state. Concurrent calls share one request. */
export function reload(): Promise<void> {
  inflight ??= req<State>('/state')
    .then(state => set({ state, error: null, loading: false }))
    .catch(e => set({ error: (e as Error).message, loading: false }))
    .finally(() => { inflight = null })
  return inflight
}

/**
 * Fetch — pipe 2. Runs pipe 1 first, then asks every connector this machine can
 * reach the two standing questions and lands what comes back on the same desk.
 *
 * The only argument it takes is which source to confine it to, chosen from a
 * closed list the server checks again. There is no way to ask it a *question* —
 * that is the property that keeps it a collector rather than a chat box.
 *
 * Started, then polled. A collection through the box's own `claude` takes 40–60
 * seconds, and an HTTP request held open that long dies: measured, the socket
 * closed at exactly 60s while the run finished and landed its rows, so the page
 * said `Fetch failed` about a Fetch that had worked. This also means locking the
 * phone mid-run still shows the result.
 *
 * Deliberately not routed through `syncing`: Fetch blocks nothing, and a global
 * spinner would make it look like it does.
 */
type FetchStatus = { running: boolean; report: import('./types').FetchReport | null }

export async function fetchNow(only?: SourceName): Promise<import('./types').FetchReport> {
  const before = (await req<FetchStatus>('/fetch').catch(() => null))?.report?.at ?? 0
  await post('/fetch', only ? { only } : undefined)
  // Two minutes is past the server's own per-connector wall clock, so a run
  // that is still going at the end of it is a run that has stopped answering.
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2_000))
    const s = await req<FetchStatus>('/fetch').catch(() => null)
    if (s && !s.running && s.report && s.report.at !== before) return s.report
  }
  throw new Error('the collection did not finish')
}

/**
 * What one poll did, per source — the server's `IngestReport`, as it arrives.
 *
 * `count` is rows the source returned, and it is not the same question as "did
 * it work": a source with no credential returns nothing and has not failed,
 * while a source that was rate-limited half way through returns real rows and
 * has lost the right to say what is missing. `connected` and `authoritative`
 * are those two facts, and anything rendering this report has to read all three
 * or it will say "synced, 0 rows" about an account that does not exist.
 */
export type SyncReport = {
  at: number
  sources: Array<{
    source: SourceName
    ok: boolean
    connected: boolean
    authoritative: boolean
    count: number
    ms: number
    error?: string
  }>
  /** Live groups on the desk after the poll, and how many were not there before. */
  groups: number
  newGroups: number
}

export type SyncResult =
  | { ok: true; report: SyncReport }
  | { ok: false; error: string }

/**
 * Two reports of one press, as one report.
 *
 * Keyed by source, last answer winning, because `ingest()` refuses to run two
 * polls at once and hands a second caller the first one's promise — so a press
 * that lands while the three-minute timer is mid-poll can be answered with a
 * report naming every source, twice over. `groups` is the desk as it stands
 * after the last of them; `newGroups` adds up, because each poll counted the
 * groups that were not there when *it* ran.
 */
function mergeSync(a: SyncReport | null, b: SyncReport): SyncReport {
  if (!a) return b
  const sources = new Map(a.sources.map(s => [s.source, s]))
  for (const s of b.sources) sources.set(s.source, s)
  return {
    at: Math.max(a.at, b.at),
    sources: [...sources.values()],
    groups: b.groups,
    newGroups: a.newGroups + b.newGroups,
  }
}

/**
 * Sync — pipe 1, on demand. Poll the sources Wake already holds a credential
 * for, then reload the desk. With `only`, poll what feeds that tab and leave
 * the rest exactly as they are.
 *
 * `only` is a tab, not a pipe, and `pipesFor` is the difference: the Sentry tab
 * is fed by the Sentry poller *and* by the Slack one reading `#sentry-alerts`,
 * so syncing it asks both and a press that named Sentry stops refreshing
 * everything except what is on the screen. One at a time — fired together, the
 * second would be handed the first's promise and never run.
 *
 * It answers rather than throws, and the two callers are why. The palette runs
 * it as `void refresh()`, where a rejection is an unhandled one; the Sync
 * control has to print what actually happened — how many rows landed, how many
 * of those were new, which source went quiet — and a thrown `Error` can carry
 * none of that. So the failure is a value too, and the caller that wants to say
 * something about it can.
 */
export async function refresh(only?: SourceName): Promise<SyncResult> {
  set({ syncing: true })
  try {
    let report: SyncReport | null = null
    for (const pipe of only ? pipesFor(only) : [undefined]) {
      report = mergeSync(report, await post<SyncReport>('/refresh', pipe ? { only: pipe } : undefined))
    }
    await reload()
    // The loop runs at least once, so there is a report by here or a throw.
    return { ok: true, report: report! }
  } catch (e) {
    const error = (e as Error).message
    set({ error })
    return { ok: false, error }
  } finally {
    set({ syncing: false })
  }
}

/**
 * Apply a change locally before the server confirms it, so a tap feels
 * instant on a phone. On failure the reload below restores the truth.
 */
export function optimistic(mutate: (s: State) => State) {
  if (store.state) set({ state: mutate(structuredClone(store.state)) })
}

export const actions = {
  ack: (g: string) => post(`/cards/${encodeURIComponent(g)}/ack`),
  snooze: (g: string, until: number) => post(`/cards/${encodeURIComponent(g)}/snooze`, { until }),
  move: (g: string, pile: string | null) => post(`/cards/${encodeURIComponent(g)}/pile`, { pile }),
  /**
   * Where the work stands. Undoable, under the label `status`.
   *
   * The three below it are the same act with older names and older undo
   * labels: `notMine` sets `wont_do`, `doneCard` sets `done`, and `ack`
   * promotes a card nobody had started. They keep their URLs so the toast and
   * undo wiring around them keeps working unchanged.
   */
  setStatus: (g: string, status: CardStatus) =>
    post<void>(`/cards/${encodeURIComponent(g)}/status`, { status }),
  /** 0 urgent · 1 high · 2 normal · 3 low. Not undoable. */
  setPriority: (g: string, priority: CardPriority) =>
    post<void>(`/cards/${encodeURIComponent(g)}/priority`, { priority }),
  /** A timestamp, or null to clear it. A date in the past is accepted. */
  setDue: (g: string, at: number | null) =>
    post<void>(`/cards/${encodeURIComponent(g)}/due`, { at }),
  notMine: (g: string) => post(`/cards/${encodeURIComponent(g)}/not-mine`),
  doneCard: (g: string) => post(`/cards/${encodeURIComponent(g)}/done`),
  pin: (g: string, pinned: boolean) => post(`/cards/${encodeURIComponent(g)}/pin`, { pinned }),
  /**
   * With no `undo`, everything keeping this card off a list is cleared. With
   * one, only that — so undoing a Done leaves a snooze or a manual pile alone.
   */
  restore: (g: string, undo?: 'done' | 'snoozed' | 'not_mine' | 'moved' | 'status') =>
    post(`/cards/${encodeURIComponent(g)}/restore`, undo ? { undo } : {}),
  doneCards: () => req<{ cards: import('./types').Card[] }>('/cards/done'),
  thread: (g: string) => req<{ thread: any }>(`/cards/${encodeURIComponent(g)}/thread`),
  /** A Claude session's last exchanges — read on open, no new ingest. */
  session: (g: string) =>
    req<{ session: { id: string; cwd: string | null; text: string } }>(
      `/cards/${encodeURIComponent(g)}/session`,
    ),
  /** The Gmail thread this card is about, sanitized on the way in. */
  cardMail: (g: string) => req<{ thread: any; messages: any[] }>(`/cards/${encodeURIComponent(g)}/mail`),

  createTask: (b: Record<string, unknown>) => post('/tasks', b),
  updateTask: (id: string, b: Record<string, unknown>) => patch(`/tasks/${id}`, b),
  deleteTask: (id: string) => del(`/tasks/${id}`),

  createNote: (b: Record<string, unknown>) => post('/notes', b),
  updateNote: (id: string, b: Record<string, unknown>) => patch(`/notes/${id}`, b),
  deleteNote: (id: string) => del(`/notes/${id}`),

  createGoal: (b: Record<string, unknown>) => post('/goals', b),
  updateGoal: (id: string, b: Record<string, unknown>) => patch(`/goals/${id}`, b),
  deleteGoal: (id: string) => del(`/goals/${id}`),

  setReminder: (b: Record<string, unknown>) => post('/reminders', b),
  readNotification: (id: string) => post(`/notifications/${id}/read`),
  clearReminder: (id: string) => del(`/reminders/${id}`),

  sources: () => req<SourceStatus[]>('/sources'),
  connections: () => req<{ sources: SourceStatus[]; redirectUri: string }>('/connections'),
  /**
   * Unlike every other call here, this one reads the body on a failure status.
   * "This source needs an app of your own" arrives as a 428 whose body carries
   * the explanation and the redirect URL to paste — throwing that away and
   * surfacing the status code is how a helpful backend becomes a dead button.
   */
  connectStart: async (s: string): Promise<ConnectStart> => {
    const r = await fetch(`/api/connections/${s}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const body = (await r.json().catch(() => ({}))) as ConnectStart
    return { ...body, status: r.status }
  },
  setClient: (s: string, b: { client_id: string; client_secret?: string }) => post(`/connections/${s}/client`, b),
  disconnect: (s: string) => post(`/connections/${s}/disconnect`),

  analytics: (days = 30) =>
    req<Analytics>(`/analytics?days=${days}&tzOffsetMinutes=${new Date().getTimezoneOffset()}`),

  pushKey: () => req<{ key: string }>('/push/key'),
  pushSubscribe: (subscription: unknown, label?: string) => post('/push/subscribe', { subscription, label }),
  pushUnsubscribe: (endpoint: string) => post('/push/unsubscribe', { endpoint }),
  // `sent` is whether a device was actually woken — not whether a row was
  // written. `reason` is present whenever it was not, and is a sentence rather
  // than a code, because it goes straight onto the screen.
  pushTest: () =>
    post<{ sent: boolean; devices: number; delivered: number; reason: string | null }>('/push/test'),
  pushStatus: () =>
    req<{ devices: Array<{ endpoint: string; ua: string | null; label: string | null; created_at: number; last_ok_at: number | null }> }>(
      '/push/status',
    ),
}

/* ------------------------------ one session ------------------------------- */

/**
 * One turn of a Claude Code conversation, as the server parses it off the
 * transcript.
 *
 * Deliberately not a line of a terminal. Three record types in a transcript are
 * not conversation and never arrive here — a subagent's sidechain, a
 * `tool_result` filed as a user record, and an assistant turn that was only a
 * tool call — because drawing any of them inline is what makes a session page
 * read like a log instead of a chat. `tools` is what survives of the third: the
 * names the assistant reached for, which the page renders as one collapsed chip
 * rather than as a wall.
 */
export type SessionTurn = {
  role: 'user' | 'assistant'
  text: string
  ts: number
  tools: string[]
}

/**
 * A session as the page that renders it needs to know it.
 *
 * `active` is the field the composer is gated on, and it is the whole reason
 * this shape differs from a list row. It means a process on this box is holding
 * the transcript open right now — so a message can be delivered — rather than
 * "there is a file with this name", which is a claim any finished conversation
 * satisfies just as well and which is what used to get handed to `--resume`.
 */
export type OpenSession = import('./launch').Session & {
  active: boolean
  /** When the process came up, or the transcript's own last write if it is not up. */
  startedAt: number
}

/**
 * A session that exists but has not said anything yet.
 *
 * Claude Code writes no transcript until it has answered something, and it will
 * not answer while a dialog is up — the one-time "is this a project you trust?"
 * being the one that actually happens. Measured: pressing Send started a real
 * tmux session in an unseen repository and left the page saying *no such
 * session on this machine* under a subtitle that said `live`.
 *
 * So "started, waiting" is a state the page is told about rather than one it
 * has to infer from a 404. `trusted: false` is the answerable case and names
 * the terminal where the prompt is sitting.
 */
export type SessionStarting = {
  trusted: boolean
  started: boolean
  /** The terminal route where the dialog is waiting, e.g. `/terminal/<id>`. */
  route: string
}

/**
 * The conversation half of the Claude Code API.
 *
 * It lives here rather than beside `launchApi` because these four calls are the
 * session *page* — reading a conversation, following it, starting one, adding a
 * turn — while that file is the brief composer's client. One is about a thing
 * on this box, the other is about a document being assembled to send to it.
 */
export const sessionApi = {
  /** Everything the page opens with: the row, the turns, the paths, the excerpt. */
  get: (id: string) =>
    req<{
      session: OpenSession; turns: SessionTurn[]; excerpt: string; paths: string[]
      starting?: SessionStarting
    }>(
      `/claude/sessions/${encodeURIComponent(id)}`,
    ),
  /**
   * The tail of the conversation, for polling.
   *
   * `after` is the timestamp of the last turn the page holds, not an index: the
   * server reads a bounded tail of a file that is being appended to, so an
   * index into that tail means something different on every read while a
   * timestamp does not. A phone backgrounds its tab and kills any stream that
   * was open, which is why this is asked rather than pushed.
   */
  since: (id: string, after: number) =>
    req<{ turns: SessionTurn[]; active: boolean; starting?: SessionStarting }>(
      `/claude/sessions/${encodeURIComponent(id)}/turns?after=${after}`,
    ),
  /**
   * Start a real session on this box — new uuid, running under tmux.
   *
   * It cannot hand back an archived id because it does not take one, which is
   * the fix for the bug this whole surface exists to correct. The session is
   * active by Claude Code's own reckoning the instant it exists.
   */
  create: (b: { repo: string; text?: string; permissionMode?: string; model?: string }) =>
    post<{ ok: true; id: string; session: { sessionId: string; cwd: string; repo: string | null } }>(
      '/claude/sessions/new', b,
    ),
  /**
   * One more turn in a conversation already underway.
   *
   * The refusals come back as the server's own sentences and are rendered
   * verbatim. "That session is not running any more" and "that session is open
   * in a terminal Wake did not start" are two different true things, and
   * collapsing them into one client-side apology is how a person stops being
   * able to tell which of them just happened.
   */
  send: (id: string, text: string) =>
    post<{ ok: true }>(`/claude/sessions/${encodeURIComponent(id)}/send`, { text }),
}

/** Poll while the tab is visible; stop entirely when it is not. */
export function useLiveState(intervalMs = 60_000) {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const start = useCallback(() => {
    if (timer.current) return
    timer.current = setInterval(() => { if (!document.hidden) void reload() }, intervalMs)
  }, [intervalMs])

  useEffect(() => {
    void reload()
    start()
    const onVisible = () => { if (!document.hidden) void reload() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [start])

  return useStore()
}
