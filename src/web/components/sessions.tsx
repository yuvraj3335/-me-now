/**
 * The Claude Code sessions that are running on this box right now.
 *
 * **There is one list and being on it means active.** That is the whole shape
 * of this file, and it is the correction of the thing it used to be. Wake
 * listed *transcripts* — every `.jsonl` under `~/.claude/projects` inside a
 * window — with an `Active / Archived / All` control over the top of them. A
 * transcript outlives the process that wrote it by weeks, so the page showed a
 * hundred and thirty dead conversations with a handful of live ones scattered
 * through them; he tapped one at seven in the morning and Claude Code on his
 * phone told him the session was archived. It was right.
 *
 * Claude Code 2.1.251 writes no archive flag to disk. What it publishes is the
 * inverse — one file per running process — so "active" is a fact Claude Code
 * states rather than a filter Wake computes and he has to remember to leave
 * switched on. `GET /api/claude/sessions` answers with those and nothing else,
 * which is why the segmented control is gone rather than merely defaulted: a
 * control offering `All` is a control that can put the graveyard back on the
 * same surface as the work, and one wrong tap is all it ever took.
 *
 * `archived` still exists and now means exactly one thing: hide this from Wake.
 * It can only ever *remove* a row from this list, so it can no longer disagree
 * with Claude Code about what is alive. An archived session is simply absent,
 * which is why `archived` is `false` on every row that arrives here and why
 * there is no Archived chip to render.
 *
 * **A row goes to a page, not to a sheet.** The tile used to open a `PeekSheet`
 * — the same handful of facts the row already carried, at sheet length — beside
 * three icon buttons that were 110px of a 375px screen. Tapping a session now
 * navigates to `/sessions/<id>`, which is the conversation itself: see
 * `src/web/pages/Session.tsx`. What is left on the row is what tells one session
 * from another at arm's length, and nothing else.
 *
 * Two facts about the data still shape it. A session records the directory it
 * ran in and nothing about what contains that directory — so the grouping key is
 * the repository that `cwd` is *under*, out of the workspace registry, and never
 * the directory itself and never the flattened filename it is stored beside.
 * Where a session ran and which repository it is in are different questions, and
 * answering the second with the first is what listed `web`, `plans` and
 * `QA_EVIDENCE` as repositories.
 */

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { Button, Empty, Menu, Pager, Sheet, pageCount, pageSlice, rowStateClass, useRail } from './primitives'
import { useSwipe } from './swipe'
import { SWIPE_ACTION_W } from '../lib/swipe'
import { ago } from '../lib/time'
import { toast } from '../lib/toast'
import { navigate, setParam, useParams } from '../lib/route'
import { launchApi, type Session } from '../lib/launch'
import { repoForSession, sessionInRepo } from '../../shared/sessionRepo'
import { inSessionOrder } from '../../shared/sessionOrder'

/* ------------------------------ what is shown ----------------------------- */

/**
 * The rows this page will draw, in the order it draws them.
 *
 * One gate, stated once, so there is a single answer to "can an archived
 * session appear on the default view" and it is a function rather than a
 * condition buried in a `useMemo`. The server already refuses to return one —
 * this is the second lock, and it is here because the first one lives in a
 * process that gets deployed separately from this bundle. A browser holding a
 * list from before an archive landed must not paint a row the server would no
 * longer hand it.
 *
 * `inSessionOrder` is the product's one comparator for sessions: running first,
 * then most recently active. Every row here is running, so in practice it
 * settles to recency — but the rule is stated where the list is built rather
 * than assumed from the endpoint's current behaviour.
 */
export const listedSessions = (rows: readonly Session[]): Session[] =>
  inSessionOrder(rows.filter(s => !s.archived))

/* --------------------------- which repository ----------------------------- */

/** The one id that is not a place: every session on the machine. */
export const ALL_REPOS = 'all'

/**
 * A session's repository, as an identity rather than as a name.
 *
 * A path and not the basename: two directories can share a basename, and
 * grouping by it would silently merge `~/work/truto` with `~/elsewhere/truto`
 * into one heading.
 *
 * `known` is the repositories that exist on this machine — the workspace
 * registry, the same list the launch sheet's repository picker offers — and it
 * is what turns *where a session ran* into *which repository it is in*. Without
 * it the answer was the recorded directory itself, which made a repository out
 * of every place work happens to have happened: `truto-app/packages/web` became
 * a repository called `web`, `truto/.cursor/plans` one called `plans`, and
 * `wake/QA_EVIDENCE` one called `QA_EVIDENCE`. None of those is a repository,
 * and a picker that offers them is a picker that has invented four.
 *
 * With no registry read yet — the first paint, or a failed fetch — this is the
 * old answer, which is a true statement about where the session ran and only an
 * over-precise one about what contains it.
 *
 * A session that never recorded a `cwd` falls back to the flattened directory
 * name it is filed under, which is what the server does too; `sessionInRepo`
 * knows that spelling, so those rows fold into their repository like any other.
 */
export const repoIdOf = (
  s: { cwd: string; project: string }, known: readonly string[] = [],
): string => repoForSession(s, known) ?? (s.cwd || s.project)

export type RepoChoice = { id: string; label: string; count: number }

/**
 * The repositories that actually have sessions, most recently touched first.
 *
 * Counted from the rows and named from the registry, because each answers what
 * the other cannot. The registry knows about repositories with no sessions in
 * them, and a picker that offers you empty repositories while hiding the
 * session you are looking for is worse than no picker. The rows know about the
 * places work happens anyway — `/private/tmp/wake-ws/scratch` is a live example
 * — and those keep their own entry rather than being filed under a repository
 * they are not in.
 *
 * Insertion order is the server's order, which is newest first, so the first
 * entry is the repository the most recent session ran in. That is what the
 * page falls back to when nothing has been chosen.
 */
export function repoList(rows: readonly Session[], known: readonly string[] = []): RepoChoice[] {
  const by = new Map<string, RepoChoice>()
  for (const s of rows) {
    const id = repoIdOf(s, known)
    const seen = by.get(id)
    if (seen) { seen.count++; continue }
    // The repository's own name when the registry placed it, and the session's
    // own when nothing did — otherwise a `truto-app` group whose newest session
    // ran in `packages/web` would be headed `web`.
    by.set(id, { id, label: id === s.cwd ? s.project || s.cwd : id.split('/').pop() || id, count: 1 })
  }
  return [...by.values()]
}

/**
 * Which repository to show, given what the address bar, the last visit and the
 * machine each have to say.
 *
 * The URL wins outright, including when it names a repository this list does
 * not contain: the index the list is built from is capped, so a bookmark to a
 * quiet repository must not be silently redirected to a busy one. A remembered
 * choice has to still exist, because it is a memory rather than a request. And
 * the fallback is a repository, never `all` — one repository is the question
 * this page answers, and "pick a repository" is not a first paint.
 */
export function chooseRepo(
  param: string | null, stored: string | null, repos: readonly RepoChoice[],
): string {
  if (param) return param
  if (stored && repos.some(r => r.id === stored)) return stored
  return repos[0]?.id ?? ALL_REPOS
}

/**
 * The repository survives a reload through the URL and a *visit* through here.
 *
 * Same reasoning as the launch sheet's permission mode: which repository he
 * works in is a standing fact about him, not a fact about this page view, and
 * re-choosing it every morning is the kind of small tax that makes a control
 * feel like paperwork. Any storage failure — private mode, storage off — leaves
 * the newest repository as the answer, which is not an error.
 */
const REPO_KEY = 'wake.sessions.repo'
/**
 * Exported because the new-session composer needs the same answer.
 *
 * `/sessions/new` opening on a repository he has not worked in this month is
 * the same "pick a repository" void the list refuses to show, arriving one
 * screen later — and two memories of one preference would be two answers.
 */
export const rememberedRepo = (): string | null => {
  try { return localStorage.getItem(REPO_KEY) } catch { return null }
}
const rememberRepo = (id: string) => {
  try { localStorage.setItem(REPO_KEY, id) } catch { /* see storedRepo */ }
}

/** Where a session lives in this app. One place builds it. */
export const sessionRoute = (id: string) => `/sessions/${id}`

/* ---------------------------------- page ---------------------------------- */

export function SessionsView({ onCount }: { onCount?: (n: number | null) => void }) {
  const p = useParams(['repo', 'page'])
  const page = Math.max(1, Number(p.page ?? '1') || 1)

  /**
   * Two answers, and they are not the same question.
   *
   * `index` is every running session on the machine, read once. It exists to
   * build the repository picker — the names, the counts, and which one is
   * newest — and it is what the list is drawn from until the real answer
   * arrives.
   *
   * `scoped` is the server's answer for one repository. It is not merely
   * `index` narrowed: the scan stops as soon as it has accepted `limit` rows,
   * so an unfiltered read spends its cap on whichever directories are busiest
   * while a scoped one spends the whole cap on the repository being asked
   * about.
   */
  const [index, setIndex] = useState<Session[] | null>(null)
  const [scoped, setScoped] = useState<{ repo: string; rows: Session[] } | null>(null)
  /**
   * The repositories that exist on this machine, which is a different fact from
   * the directories sessions ran in.
   *
   * Only the registry can tell `truto-app` from `truto-app/packages/web`, and
   * without it this page made a repository of every directory it saw. A failure
   * is not an error here: the rows are still true, they are simply grouped by
   * where each one ran rather than by what contains it.
   */
  const [known, setKnown] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [doomed, setDoomed] = useState<Session | null>(null)

  /**
   * What asks the server again, and it is a counter rather than the data.
   *
   * Keying the fetches on `index` itself looks equivalent and is not: archiving
   * a row replaces that array, which would re-issue the scoped request — and
   * that request can reach the server before the archive it was triggered by
   * does, so the answer would arrive carrying the row he just put away. Only a
   * real reload — an archive settling, a delete — bumps this.
   */
  const [reloads, setReloads] = useState(0)
  const reload = () => setReloads(n => n + 1)

  useEffect(() => {
    let alive = true
    launchApi.sessions()
      .then(d => { if (alive) { setIndex(d.sessions); setErr(null) } })
      .catch(e => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [reloads])

  useEffect(() => {
    let alive = true
    launchApi.state()
      .then(d => { if (alive) setKnown(d.repos.map(r => r.path)) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const repos = useMemo(() => repoList(index ?? [], known), [index, known])
  // Read once. A pick writes the URL as well as the store, and the URL wins, so
  // a stale read here can never outrank what he just chose.
  const remembered = useMemo(rememberedRepo, [])
  const repo = chooseRepo(p.repo ?? null, remembered, repos)

  useEffect(() => {
    // Nothing to scope *to* when the answer is the whole machine. With a
    // repository already named in the URL this runs on the first render, beside
    // the index rather than after it.
    if (repo === ALL_REPOS) return
    let alive = true
    launchApi.sessions({ repo })
      .then(d => { if (alive) { setScoped({ repo, rows: d.sessions }); setErr(null) } })
      .catch(e => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [repo, reloads])

  /**
   * The scoped answer when it is for this repository, and the index until then.
   *
   * Which is what keeps the list from blinking empty on every repository
   * change: the rows are already known, they are simply not yet authoritative.
   */
  const inRepo = useMemo(() => {
    const all = index ?? []
    if (repo === ALL_REPOS) return all
    if (scoped?.repo === repo) return scoped.rows
    // `sessionInRepo` and not `repoIdOf(s) === repo`, because this list has to
    // be the same list the scoped answer replaces it with — and the server's
    // filter is exact-or-under. Identity here would drop every subdirectory
    // session for the second it takes the real answer to arrive.
    return all.filter(s => sessionInRepo(s, repo))
  }, [index, scoped, repo])

  const rows = useMemo(() => listedSessions(inRepo), [inRepo])

  /**
   * How many sessions this page is standing over, reported to the header.
   *
   * `null` until the index has arrived, because a header that prints `0` while
   * the first read is in flight is asserting a fact it has not measured — the
   * same rule Mail's `list.answered` and Work's `loaded` already keep.
   */
  useEffect(() => {
    onCount?.(index ? rows.length : null)
    // `onCount` is a `useState` setter at the only call site, so its identity is
    // stable; listing it keeps that from being a silent requirement.
  }, [rows.length, index, onCount])

  /**
   * Take one row off both answers at once.
   *
   * Archiving is one row in Wake's own database and the list it leaves is this
   * one, so the row goes now rather than after a round trip that would re-read
   * two lists of transcript tails to learn a fact this browser already knows.
   * The undo puts it back the same way.
   */
  const drop = (id: string, gone: boolean) => {
    const apply = (list: Session[]) => list.map(s => (s.id === id ? { ...s, archived: gone } : s))
    setIndex(l => (l ? apply(l) : l))
    setScoped(s => (s ? { ...s, rows: apply(s.rows) } : s))
  }

  const archive = async (s: Session, on: boolean) => {
    drop(s.id, on)
    try {
      await launchApi.archiveSession(s.id, on)
      // The undo names the one thing it undoes — this session, back where it
      // was — and not "everything that could be keeping it off this list".
      toast(on ? 'Hidden from Wake.' : 'Back on the list.', {
        label: 'Undo', run: () => void archive(s, !on),
      })
    } catch (e) {
      drop(s.id, !on)
      toast((e as Error).message)
    }
  }

  /**
   * Paged after grouping, not before.
   *
   * A page boundary that falls inside a repository would print the same header
   * twice with a page turn between the halves, so the flat, already-sorted list
   * is sliced first and the headers are drawn from whatever landed on the page.
   *
   * The size is `primitives`' one number rather than a local constant: `Pager`
   * renders the range it stands over, so a list that sliced by 25 under a pager
   * that counts by 50 would print a range describing rows that are not there.
   */
  const pages = pageCount(rows.length)
  const clamped = Math.min(page, pages)
  const shown = pageSlice(rows, clamped)

  const groups = useMemo(() => {
    const by = new Map<string, Session[]>()
    for (const s of shown) {
      const key = repoIdOf(s, known)
      const list = by.get(key)
      list ? list.push(s) : by.set(key, [s])
    }
    return [...by.entries()]
  }, [shown, known])

  /**
   * What the repository control offers.
   *
   * `All repositories` appears only when there is more than one, since with one
   * it is the same list under a second name. And a repository named in the URL
   * that the index does not list is added: it is the one being shown, so the
   * control has to be able to say its name rather than reading `—` over a full
   * list of its sessions.
   */
  const choices = useMemo(() => {
    const list = [
      ...(repos.length > 1
        ? [{ id: ALL_REPOS, label: 'All repositories', meta: String(index?.length ?? 0) }]
        : []),
      ...repos.map(r => ({ id: r.id, label: r.label, meta: String(r.count) })),
    ]
    if (repo !== ALL_REPOS && !list.some(i => i.id === repo)) {
      list.push({ id: repo, label: repo.split('/').pop() || repo, meta: '' })
    }
    return list
  }, [repos, repo, index])

  const rail = useRail<HTMLDivElement>()

  // Nothing is interactive yet and there is nothing to preserve, so this is the
  // one branch on the page that swaps the whole tree.
  if (!index && !err) return null

  const body = err
    ? <p className="text-sm text-bad pt-4">{err}</p>
    : !rows.length
      ? (
        <Empty>
          {repo === ALL_REPOS
            ? 'Claude Code is not running anything on this machine.'
            : 'Nothing running in this repository.'}
        </Empty>
      )
      : groups.map(([id, list]) => (
        <section key={id} className="pt-1 pb-3">
          {/* The heading answers "which repository is this row in", which is
              only a question when the list spans more than one. With one
              chosen, the control at the top of the page already says it. */}
          {repo === ALL_REPOS && (
            <h2 className="text-eyebrow uppercase text-fg-mute pb-2">
              {repos.find(r => r.id === id)?.label || list[0]?.project || id}
            </h2>
          )}
          <ul className="grid gap-2 md:grid-cols-2">
            {list.map(s => (
              <Row
                key={s.id}
                session={s}
                onOpen={() => navigate(sessionRoute(s.id))}
                onArchive={() => void archive(s, true)}
                onDelete={() => setDoomed(s)}
              />
            ))}
          </ul>
        </section>
      ))

  return (
    <div>
      {/*
        Two controls, and they may not wrap.

        A second line of chrome pushes the first row off the fold on a phone,
        which is the screen this page is read on. So the row scrolls instead —
        and the vertical padding is load-bearing rather than decorative: a
        scroll container clips at its padding box, and `.hit` hangs a 44px touch
        target 6px outside a 32px control. Without the 6px here, every control
        in this row would be clipped back to the box it paints.
      */}
      <div className="rail" data-spill={rail.spill || undefined}>
        <div ref={rail.ref}
          className="flex items-center gap-2 py-1.5 overflow-x-auto no-scrollbar">
          <Menu
            items={choices}
            value={repo}
            onPick={id => {
              // `All repositories` is a thing he asks for and never a thing he
              // is given: it goes in the URL, so a reload holds it, and stays
              // out of the store, so tomorrow morning still opens on a
              // repository.
              if (id !== ALL_REPOS) rememberRepo(id)
              setParam('repo', id)
              setParam('page', null)
            }}
            ariaLabel="Repository"
            placeholder="No repositories"
          />
          {/* The page's one creation, in the page's one amber, the same shape
              Work's `+ Task` already is. It navigates rather than committing:
              what starts a process is Send, on the page it goes to. */}
          <Button
            variant="primary"
            title="Start a new session"
            ariaLabel="Start a new session"
            onClick={() => navigate('/sessions/new')}
          >
            <Plus size={14} />
            <span className="hidden sm:inline">New</span>
          </Button>
        </div>
      </div>

      {body}

      <Pager
        page={clamped}
        pages={pages}
        total={rows.length}
        onPage={n => setParam('page', n === 1 ? null : String(n))}
      />

      {/* Mounted whatever the list is doing. A surface that appears and
          disappears from the tree takes its open sheet with it. */}
      <DeleteSheet
        session={doomed}
        onClose={() => setDoomed(null)}
        onDone={() => { setDoomed(null); reload() }}
      />
    </div>
  )
}

/* ---------------------------------- row ----------------------------------- */

/**
 * One session, at the width of a thumb.
 *
 * Four facts and no controls: a live dot, the title, the last thing said, and
 * how long ago. Everything else that used to ride this row has gone somewhere
 * it can be read. The branch and the turn count went to the session page's own
 * header, where there is room for them; `Open`, `Open in Claude`, `Archive` and
 * `Delete` were 110px of a 375px screen — measured, the title column got 133px
 * against a 438px string, so four different sessions rendered as `As you can
 * see the…`, `fix(mfa): make the login…` and `You're working a cross-…`. Two of
 * those four controls are behind the swipe now and the other two are on the
 * page the row opens.
 *
 * The dot is `--color-status-live`, which is sky and deliberately not amber:
 * amber in this product means "something is waiting for you", and a session
 * running quietly in the background is not that. Every row on this list is
 * live, so the dot is not a discriminator between rows — it is the standing
 * statement that what you are looking at is a process rather than a file, which
 * is the exact thing the old page got wrong.
 */
function Row({
  session: s, onOpen, onArchive, onDelete,
}: {
  session: Session
  onOpen: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const swipe = useSwipe(`session:${s.id}`, 2)

  return (
    <li
      ref={swipe.bind.ref}
      onPointerDown={swipe.bind.onPointerDown}
      onPointerMove={swipe.bind.onPointerMove}
      onPointerUp={swipe.bind.onPointerUp}
      onPointerCancel={swipe.bind.onPointerCancel}
      onClickCapture={swipe.bind.onClickCapture}
      data-swipe={swipe.bind['data-swipe']}
      style={swipe.bind.style}
      // `overflow-hidden` is what makes the drawer stop at the row's rounded
      // corner. The row paints no ground of its own, so the one state class
      // owns the fill and there is no second background utility to outrank.
      className={`relative overflow-hidden rounded-panel border border-edge ${rowStateClass()}`}
    >
      <button onClick={onOpen} className="w-full min-w-0 flex items-start gap-3 p-3 text-left">
        {/* Baseline-aligned by hand rather than by `items-baseline`, because a
            2px circle has no baseline of its own and a flex box gives it the
            top of its line box instead — which parked the dot two pixels above
            the cap height of the title beside it. */}
        <span className="mt-1.5 w-2 h-2 rounded-full shrink-0 bg-status-live" aria-hidden />
        <span className="min-w-0 grow">
          <span className="block text-base text-fg truncate" title={s.title}>{s.title}</span>
          {/* The last thing said, clipped to one line. It is a whole sentence
              of somebody's half-finished thought, and one line of it is what
              tells this session from the other three in the same repository —
              which is the only job this row has. */}
          {s.lastPrompt && (
            <span className="block mt-0.5 text-sm text-fg-mute truncate">{s.lastPrompt}</span>
          )}
        </span>
        <span className="shrink-0 text-sm text-fg-mute tnum">{ago(s.lastTs)}</span>
      </button>

      <SessionDrawer
        dx={swipe.dx}
        width={swipe.width}
        onArchive={onArchive}
        onDelete={onDelete}
        onClose={swipe.close}
      />
    </li>
  )
}

/**
 * The two actions behind a row, revealed by the same gesture the desk uses.
 *
 * `useSwipe` is the desk's own hook — one gesture implementation in the
 * product, with the axis rules, the trackpad path and the single-open-row store
 * that comes with it. The panel is drawn here rather than through `SwipeDrawer`
 * because that component's three actions are `Done`, `Status` and `Delete`, and
 * a session has neither of the first two: it is not work you finish and it has
 * no status.
 *
 * `Hide` and not `Archive`, because that is all the word can honestly mean now.
 * Claude Code has no archive, the row is a running process, and what this
 * writes is one row in Wake's database saying "keep this off my list". Calling
 * that Archive invited the reading that it did something to the session.
 *
 * Nothing is rendered at all while the drawer is shut — not at `opacity: 0` and
 * not at `width: 0` with live buttons inside it, which on a touch screen is a
 * control that is permanently invisible and permanently tappable.
 */
function SessionDrawer({
  dx, width, onArchive, onDelete, onClose,
}: {
  dx: number
  width: number
  onArchive: () => void
  onDelete: () => void
  onClose: () => void
}) {
  if (dx === 0) return null

  const shown = Math.min(width, Math.max(0, -dx))
  const act = (run: () => void) => () => { run(); onClose() }

  return (
    <div
      data-swipe-action
      className="absolute inset-y-0 right-0 z-10 overflow-hidden"
      style={{ width: shown }}
    >
      <div className="absolute inset-y-0 right-0 flex items-stretch" style={{ width }}>
        <button
          data-swipe-action
          onClick={act(onArchive)}
          style={{ width: SWIPE_ACTION_W }}
          className="shrink-0 flex items-center justify-center text-sm font-medium
                     bg-ink-700 text-fg transition-[filter] duration-100 hover:brightness-110"
        >
          Hide
        </button>
        <button
          data-swipe-action
          onClick={act(onDelete)}
          style={{ width: SWIPE_ACTION_W }}
          className="shrink-0 flex items-center justify-center text-sm font-medium
                     bg-bad text-on-bad transition-[filter] duration-100 hover:brightness-110"
        >
          Delete
        </button>
      </div>
    </div>
  )
}

/* -------------------------------- deleting -------------------------------- */

/** How long an armed delete stays armed before it forgets it was asked. */
const ARMED_MS = 4_000

/**
 * The delete dialog, which names what goes and asks twice.
 *
 * **Nothing is typed here any more.** It used to require the word `delete` in a
 * text field, which is the confirmation pattern for a web console you visit on
 * a laptop once a quarter. This is a phone, at seven in the morning, one
 * thumb: typing six characters to remove a session means raising a keyboard
 * that covers the dialog explaining what is about to be removed. The keyboard
 * was the cost and it bought nothing — a person who can type `delete` is not a
 * person who has read the four paths, and the paths are the actual protection.
 *
 * Two taps instead, and the second one is a different button rather than the
 * same one: `Delete permanently` arms, `Tap again to delete` fires, and it
 * disarms itself after four seconds so a sheet left open in a pocket cannot be
 * completed by an accident later. That is the property the typing was standing
 * in for — deliberateness — expressed as a gesture a thumb can make.
 *
 * The server's confirmation token is untouched. It is minted against this exact
 * session id and spent by the delete, so approving one session and deleting
 * another is not reachable, and the paths shown are the paths the server will
 * act on rather than something the client reconstructed.
 *
 * A running session takes the other branch entirely. Nothing is minted, nothing
 * is armed, and the reason is a paragraph on screen instead of a `title` on a
 * disabled icon that no device could ever show. The server refuses this twice
 * more on its own, so what changed here is only who gets told.
 *
 * Both buttons live in the sheet's pinned footer, which is a flex sibling of
 * the scrollport rather than the last thing in it: the two ways out of this
 * dialog may not be below the fold.
 */
export function DeleteSheet({
  session, onClose, onDone,
}: { session: Session | null; onClose: () => void; onDone: () => void }) {
  const [armed, setArmed] = useState(false)
  const [ready, setReady] = useState<{ token: string; paths: string[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const blocked = !!session?.live

  useEffect(() => {
    setArmed(false)
    setReady(null)
    setErr(null)
    // No token for a session that cannot be deleted. The confirm route would
    // answer 409, and a red error line is the wrong way to state a rule the
    // dialog is already explaining in prose.
    if (!session || session.live) return
    let live = true
    launchApi.confirmDeleteSession(session.id)
      .then(d => { if (live) setReady({ token: d.token, paths: d.paths }) })
      .catch(e => { if (live) setErr((e as Error).message) })
    return () => { live = false }
  }, [session?.id, session?.live])

  // Armed is a state with a deadline. Without one, a dialog opened and left
  // alone is a destructive button sitting one stray tap away for as long as the
  // phone is unlocked.
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), ARMED_MS)
    return () => clearTimeout(t)
  }, [armed])

  const run = async () => {
    if (!session || !ready) return
    setBusy(true)
    try {
      const r = await launchApi.deleteSession(session.id, ready.token)
      toast(`Deleted ${r.removed.length} file${r.removed.length === 1 ? '' : 's'}.`)
      onDone()
    } catch (e) {
      setErr((e as Error).message)
      setArmed(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={!!session}
      onClose={onClose}
      title="Delete this session"
      footer={session && (
        <div className="flex items-center gap-2">
          <Button
            variant="danger"
            size="lg"
            disabled={busy || blocked || !ready}
            onClick={() => (armed ? void run() : setArmed(true))}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            {armed ? 'Tap again to delete' : 'Delete permanently'}
          </Button>
          <Button variant="ghost" size="lg" onClick={onClose}>Cancel</Button>
        </div>
      )}
    >
      {session && (
        <div>
          <p className="text-base text-fg-dim">{session.title}</p>

          {blocked ? (
            <p className="text-sm text-fg-mute mt-2 leading-snug">
              This session is running on this machine right now, so it cannot be deleted. Close it
              in Claude Code first. Removing a live transcript would not stop the process — it
              would keep writing to a file that no longer has a name, and the conversation would
              be lost rather than deleted.
            </p>
          ) : (
            <>
              <p className="text-sm text-fg-mute mt-2 leading-snug">
                This removes files under your Claude Code home, not inside Wake. It cannot be
                undone, and one of them is the edit-undo history for real source files. To take a
                session off this list without destroying it, swipe the row and hide it instead.
              </p>

              <h3 className="text-eyebrow uppercase text-fg-mute mt-4 mb-2">What goes</h3>
              {ready
                ? ready.paths.map(p => (
                  <p key={p} className="text-sm text-fg-mute font-mono truncate py-1 border-b border-rule last:border-0">
                    {p}
                  </p>
                ))
                : <p className="text-sm text-fg-mute h-8 flex items-center">—</p>}
            </>
          )}

          {err && <p className="text-sm text-bad mt-3">{err}</p>}
        </div>
      )}
    </Sheet>
  )
}
