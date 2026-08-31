/**
 * Every Claude Code session on this box, one repository at a time.
 *
 * The launch sheet has always had a picker over these, but only as a dropdown
 * inside a hand-off — there was no way to see what is on the machine, which of
 * them is still running, or to get rid of one. This is that list.
 *
 * Two facts about the data shape it. A session records the directory it ran in
 * and nothing about what contains that directory — so the grouping key is the
 * repository that `cwd` is *under*, out of the workspace registry, and never
 * the directory itself and never the flattened filename it is stored beside.
 * Where a session ran and which repository it is in are different questions,
 * and answering the second with the first is what listed `web`, `plans` and
 * `QA_EVIDENCE` as repositories. And `turns` is counted from the tail the
 * server read, not from the whole transcript, so it is a floor rather than a
 * total.
 *
 * That caveat used to ride every row as the words `turns in view`, which is a
 * phrase nobody has at seven in the morning and which cost the row 92px on the
 * one screen that has none to spare. The count is `12 turns` now — one word,
 * the same word in the list and in the sheet — and the caveat is stated once,
 * in the sheet, where there is room to say it in prose. `turns` and not
 * `prompts` or `messages`, tempting as either is: the server counts every
 * `type: "user"` record in the tail, and a tool result is one of those, so both
 * of the plainer words would name something smaller than what is being counted.
 *
 * Three decisions shape the page itself.
 *
 * **A repository is chosen before anything is listed.** Thirty sessions across
 * five repositories on one screen is a wall of text in which the four that are
 * yours today are indistinguishable from the twenty-six that are not. The
 * server has always been able to answer for one repository (`?repo=`) and was
 * never asked; it is asked now, and the answer for the whole machine is a
 * choice rather than the first paint.
 *
 * **Archive is Wake's own.** Claude Code has no such concept — a transcript on
 * disk is either there or it is not — so the state lives in Wake's database
 * (migration 13) and is joined onto the rows the server returns. It is
 * reversible from the Archived filter. Delete is the opposite of that in every
 * respect: it removes four paths under `~/.claude`, it cannot be undone, and it
 * is refused outright while the session is running.
 *
 * **A live session's delete is pressable and refused in words.** It used to be
 * a disabled trash icon, which meant `disabled:pointer-events-none`, which
 * meant the `title` explaining why could never be read on any device — thirteen
 * of thirty rows looked broken and the reason existed only in the source. The
 * button opens the dialog now and the dialog says, on screen, that the session
 * is running and has to be closed first.
 */

import { useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, ArrowUpRight, Loader2, Trash2 } from 'lucide-react'
import {
  Button, Empty, Menu, Pager, Segmented, Sheet, inputClass, pageCount, pageSlice, rowStateClass,
  useRail,
} from './primitives'
import { useSwipe } from './swipe'
import { SWIPE_ACTION_W } from '../lib/swipe'
import { ago } from '../lib/time'
import { toast } from '../lib/toast'
import { setParam, useParams } from '../lib/route'
import { PERMISSION_MODES, launchApi, openLaunch, type Session } from '../lib/launch'
import { repoForSession, sessionInRepo } from '../../shared/sessionRepo'

/** Typed exactly, or the button stays disabled. */
const CONFIRM_WORD = 'delete'

/* ------------------------------ what is shown ----------------------------- */

export type SessionView = 'active' | 'archived' | 'all'

const VIEWS: Array<{ id: SessionView; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'Archived' },
  { id: 'all', label: 'All' },
]

/**
 * Whether a session belongs in the view being shown.
 *
 * Three states and not four: a *deleted* session is not one of them. Delete is
 * an `rmSync` of four real paths, so the next filesystem scan cannot see it —
 * there is no faded row, no disabled control and no tombstone to filter out,
 * and there must never be one. What is on this list is what is on the disk.
 */
export const matchesView = (s: { archived?: boolean }, view: SessionView): boolean =>
  view === 'all' ? true : view === 'archived' ? !!s.archived : !s.archived

/** The address bar's word for the view, defaulted to the one he opens on. */
export const readView = (v: string | null): SessionView =>
  v === 'archived' || v === 'all' ? v : 'active'

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
 * not contain: the index the list is built from is capped and windowed, so a
 * bookmark to a quiet repository must not be silently redirected to a busy one.
 * A remembered choice has to still exist, because it is a memory rather than a
 * request. And the fallback is a repository, never `all` — one repository is
 * the question this page answers.
 */
export function chooseRepo(
  param: string | null, stored: string | null, repos: readonly RepoChoice[],
): string {
  if (param) return param
  if (stored && repos.some(r => r.id === stored)) return stored
  return repos[0]?.id ?? ALL_REPOS
}

/**
 * What a screen with no rows on it says.
 *
 * `Empty`'s default is a dash, which is right for a value that has nothing in
 * it and wrong for a whole page: `Archived` with nothing archived rendered one
 * `—` on an otherwise blank 1440x900 window, which is not an answer to any
 * question a person had. The old reasoning — that the control which set the
 * filter already names it — holds for the *filter* and not for the *state*:
 * knowing that Archived is pressed is not knowing whether this repository has
 * ever had anything archived in it, or whether it has any sessions at all.
 *
 * So three sentences, and each of them is a different fact:
 *   - the repository has no sessions in any view,
 *   - it has some and none of them are archived,
 *   - it has some and all of them are.
 * The machine having nothing on it at all is a fourth, and it keeps the window
 * the index was read over, because "in the last year" is the difference between
 * an empty machine and an old one.
 */
function nothingShown(view: SessionView, where: string, anyInRepo: boolean): string {
  if (!anyInRepo) return `No sessions ${where}.`
  if (view === 'archived') return `Nothing archived ${where}.`
  if (view === 'active') return `Every session ${where} is archived.`
  // `all` matches every row, so an empty list under it means an empty
  // repository, which the first line already answered.
  return `No sessions ${where}.`
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
const storedRepo = (): string | null => {
  try { return localStorage.getItem(REPO_KEY) } catch { return null }
}
const rememberRepo = (id: string) => {
  try { localStorage.setItem(REPO_KEY, id) } catch { /* see storedRepo */ }
}

/* ---------------------------------- page ---------------------------------- */

export function SessionsView({ onCount }: { onCount?: (n: number | null) => void }) {
  const p = useParams(['repo', 'show', 'page'])
  const view = readView(p.show ?? null)
  const page = Math.max(1, Number(p.page ?? '1') || 1)

  /**
   * Two answers, and they are not the same question.
   *
   * `index` is every session on the machine, read once. It exists to build the
   * repository picker — the names, the counts, and which one is newest — and it
   * is what the list is drawn from until the real answer arrives.
   *
   * `scoped` is the server's answer for one repository, from the filter that
   * has been in `claudecode/router.ts` all along and was never called with a
   * value. It is not merely `index` narrowed: `listAllSessions` stops as soon
   * as it has accepted `limit` rows, so an unfiltered read spends its cap on
   * whichever directories are busiest, while a scoped one spends the whole cap
   * on the repository being asked about. On a machine with more transcripts
   * than the cap, that is the difference between seeing a quiet repository's
   * history and being told it has none.
   */
  const [index, setIndex] = useState<Session[] | null>(null)
  const [scoped, setScoped] = useState<{ repo: string; rows: Session[] } | null>(null)
  /**
   * The repositories that exist on this machine, which is a different fact from
   * the directories sessions ran in.
   *
   * Only the registry can tell `truto-app` from `truto-app/packages/web`, and
   * without it this page made a repository of every directory it saw. It is the
   * same list the launch sheet's repository picker offers, so the two surfaces
   * cannot end up with different vocabularies for the word.
   *
   * A failure is not an error on this page: the rows are still true, they are
   * simply grouped by where each one ran rather than by what contains it.
   */
  const [known, setKnown] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [doomed, setDoomed] = useState<Session | null>(null)
  const [peek, setPeek] = useState<Session | null>(null)

  /**
   * What asks the server again, and it is a counter rather than the data.
   *
   * Keying the fetches on `index` itself looks equivalent and is not: archiving
   * a row replaces that array, which would re-issue the scoped request — and
   * that request can reach the server before the archive it was triggered by
   * does, so the answer would arrive carrying the old flag and overwrite the
   * row he just moved. Only a real reload — one delete, so far — bumps this.
   */
  const [reloads, setReloads] = useState(0)
  const reload = () => setReloads(n => n + 1)

  useEffect(() => {
    let alive = true
    launchApi.sessions({ all: true })
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
  const remembered = useMemo(storedRepo, [])
  const repo = chooseRepo(p.repo ?? null, remembered, repos)

  useEffect(() => {
    // Nothing to scope *to* when the answer is the whole machine. With a
    // repository already named in the URL this runs on the first render, beside
    // the index rather than after it.
    if (repo === ALL_REPOS) return
    let alive = true
    launchApi.sessions({ all: true, repo })
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
    // session for the second it takes the real answer to arrive, so the tiles
    // would settle in rather than simply appear.
    return all.filter(s => sessionInRepo(s, repo))
  }, [index, scoped, repo])

  const rows = useMemo(() => inRepo.filter(s => matchesView(s, view)), [inRepo, view])

  /**
   * How many sessions this page is standing over, reported to the header.
   *
   * Every other page in the product prints its count beside its title — Desk
   * 99, Mail 25, Work 2 — and this one did not, although the repository control
   * six pixels below it was printing `truto 38` the whole time. The number
   * belongs to the list, which lives here, and the title belongs to the page,
   * which lives in `pages/Sessions.tsx`; a callback is how those two meet.
   *
   * `null` until the index has arrived, because a header that prints `0` while
   * the first read is in flight is asserting a fact it has not measured — the
   * same rule Mail's `list.answered` and Work's `loaded` already keep.
   *
   * `rows.length` and not the repository's own total: this counts what is on
   * the page, so switching to Archived moves it. The menu's count is the other
   * question — every session in that repository, whatever view is on — and it
   * is answered where it is asked.
   */
  useEffect(() => {
    onCount?.(index ? rows.length : null)
    // `onCount` is a `useState` setter at the only call site, so its identity is
    // stable; listing it keeps that from being a silent requirement.
  }, [rows.length, index, onCount])

  /**
   * Move one row's archived flag in both answers at once.
   *
   * Archiving is one row in Wake's own database, and re-reading two lists of
   * transcript tails to learn a fact this browser already knows would cost half
   * a second and scroll the list under his thumb.
   */
  const patch = (id: string, archived: boolean) => {
    const apply = (list: Session[]) => list.map(s => (s.id === id ? { ...s, archived } : s))
    setIndex(l => (l ? apply(l) : l))
    setScoped(s => (s ? { ...s, rows: apply(s.rows) } : s))
  }

  const archive = async (s: Session, on: boolean) => {
    patch(s.id, on)
    try {
      await launchApi.archiveSession(s.id, on)
      // The undo names the one thing it undoes — this session, back to the
      // state it was in — and not "everything that could be keeping it out of
      // this list", which is how an undo destroys a decision it never touched.
      toast(on ? 'Archived.' : 'Unarchived.', { label: 'Undo', run: () => void archive(s, !on) })
    } catch (e) {
      patch(s.id, !on)
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
   * The row the sheet is showing, looked up again rather than held.
   *
   * `peek` is a snapshot taken when the tile was pressed. Archiving from inside
   * the sheet updates the list and would leave that snapshot claiming the old
   * answer — the same frozen-object bug the task sheet shipped, where notes
   * added to an open task did not appear until it was closed and reopened.
   */
  const current = useMemo(
    () => (peek ? inRepo.find(s => s.id === peek.id) ?? peek : null),
    [peek, inRepo],
  )

  /**
   * What the repository control offers.
   *
   * The counts are of the index — the same window and cap the server answered
   * the unfiltered question with — so they describe what this page can show you
   * rather than claiming to be a total of everything that has ever run here.
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
      ? (index?.length
        ? (
          <Empty>
            {nothingShown(
              view,
              repo === ALL_REPOS ? 'on this machine' : 'in this repository',
              inRepo.length > 0,
            )}
          </Empty>
        )
        : <Empty>Nothing on this machine in the last year.</Empty>)
      : groups.map(([id, list]) => (
        <section key={id} className="pt-1 pb-3">
          {/* The heading is the answer to "which repository is this row in",
              which is only a question when the list spans more than one. With
              one chosen, the control at the top of the page already says it. */}
          {repo === ALL_REPOS && (
            <h2 className="text-eyebrow uppercase text-fg-mute pb-2">
              {/* The repository's name, out of the same list the control above
                  offers — not the newest row's own directory, which for a
                  `truto-app` group whose newest session ran in
                  `packages/web` would head the group `web`. */}
              {repos.find(r => r.id === id)?.label || list[0]?.project || id}
            </h2>
          )}
          {/* Two columns from `md`, not from `sm`.

              At 640 the shell's 200px rail leaves 392px of content, so a
              two-column grid draws tiles 192px wide — half a phone — and every
              flexible thing inside one measured zero: the branch line rendered
              as literally nothing between 640 and 900. The grid is the thing
              that was wrong there, not the row inside it. */}
          <ul className="grid gap-2 md:grid-cols-2">
            {list.map(s => (
              <Tile
                key={s.id}
                session={s}
                selected={current?.id === s.id}
                onPeek={() => setPeek(s)}
                onArchive={() => void archive(s, !s.archived)}
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

        A second line of chrome pushes the first tile off the fold on a phone,
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
          <Segmented
            options={VIEWS}
            value={view}
            onChange={v => {
              setParam('show', v === 'active' ? null : v)
              setParam('page', null)
            }}
            ariaLabel="Which sessions"
          />
        </div>
      </div>

      {body}

      <Pager
        page={clamped}
        pages={pages}
        total={rows.length}
        onPage={n => setParam('page', n === 1 ? null : String(n))}
      />

      {/* Both sheets are mounted whatever the list is doing. A surface that
          appears and disappears from the tree takes its open sheet with it. */}
      <PeekSheet
        session={current}
        onClose={() => setPeek(null)}
        onArchive={() => { if (current) void archive(current, !current.archived) }}
        onDelete={() => { if (current) { setDoomed(current); setPeek(null) } }}
      />
      <DeleteSheet
        session={doomed}
        onClose={() => setDoomed(null)}
        onDone={() => { setDoomed(null); reload() }}
      />
    </div>
  )
}

/* ---------------------------------- tile ---------------------------------- */

/**
 * Hand this session to Claude, with everything the brief needs to resume it.
 *
 * One function rather than two call sites: the tile and the detail sheet offer
 * the same act, and a brief that packs different facts depending on which
 * button was pressed is two features wearing one name.
 */
const openInClaude = (s: Session) => openLaunch(
  [{
    kind: 'session',
    ref: `session:${s.id}`,
    title: s.title,
    excerpt: s.lastPrompt,
    why: 'work already underway on my machine',
    meta: {
      session_id: s.id,
      cwd: s.cwd,
      branch: s.branch ?? null,
      // `turns_in_view` and not `turns`, here and only here. The reader of this
      // key is a model rather than a person: the screen states the caveat once,
      // in the sheet, where a person can read it, and a brief has no sheet — so
      // the caveat rides the key name, which is the one place a model will see
      // it before treating the number as a total.
      turns_in_view: s.turns,
    },
  }],
  { templates: ['continue-session'], repoHint: s.cwd, session: s.id, title: s.title },
)

/**
 * One session, enclosed.
 *
 * It was three lines of unbounded text per session — title, last prompt, then
 * branch / turns / age — down a single column, thirty of them, with nothing
 * separating one session from the next but a hairline. The enclosure is what
 * makes a session a thing rather than a paragraph, and it is a 1px edge on the
 * page's own ground because that is what elevation is here.
 *
 * Two lines inside it, not three. The last prompt is a whole sentence of
 * somebody's half-finished thought and it belongs to the one session you are
 * considering, not to the twenty you are scanning past — it lives in the sheet
 * the tile opens. The branch stays, because "which of my four sessions in this
 * repository" is exactly what it answers.
 *
 * Only the branch gives up width, and it gives up the *front* of itself.
 *
 * Joined into one truncating string, a shared branch prefix ate the whole line
 * on a phone: six consecutive rows rendered `fix/sync-job-v4-paginati…` and
 * nothing else. Splitting the line so that only the branch truncates fixed the
 * other two facts and not that one — measured again on a 375px screen, the
 * branch held 42px against a 256px string, so
 * `fix/webhook-patch-cross-environment-idor` rendered `fix/…` and two different
 * sessions in one repository were `fix/syn…` and `fix/syn…`, each with its own
 * Delete.
 *
 * Two changes, because one was not enough. The count leaves the line until
 * `xl`, which is 110px of a 213px column handed back to the branch — measured
 * at 375, the branch goes from 55px to 176px against that same 256px string.
 * (The deployed build reported 42px; the difference is one word of the title
 * above it, and the conclusion is the same either way.) And what is left
 * truncates from the left: `direction: rtl` on an otherwise
 * left-aligned box moves the ellipsis to the start and keeps the *tail*, which
 * is the distinguishing half of a branch name, where the front is the half
 * every branch in a repository shares.
 *
 * The `<bdi dir="ltr">` is not decoration and it is not optional. An RTL box
 * resolves its content as an RTL paragraph, which leaves any *edge* character
 * with no strong direction of its own at the paragraph's level rather than the
 * text's — so `feat/foo-` renders `-feat/foo` and, much worse, a branch named
 * for its ticket renders `2034-fix-thing` as `fix-thing-2034`. Both were
 * reproduced in a browser before this shipped. An isolate with an explicit
 * direction makes the branch its own LTR paragraph inside the RTL box, which
 * fixes both while leaving the clip at the left where it was put; verified on
 * the same five strings. The text itself never moves: it reads forwards, it
 * copies forwards, and only which end survives the clip has changed.
 */
function Tile({
  session: s, selected, onPeek, onArchive, onDelete,
}: {
  session: Session
  selected: boolean
  onPeek: () => void
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
      // `overflow-hidden` is what makes the drawer stop at the tile's rounded
      // corner. The tile paints no ground of its own, so the one state class
      // owns the fill and there is no second background utility to outrank.
      className={`relative overflow-hidden rounded-panel border border-edge
                  ${rowStateClass({ selected })}`}
    >
      <div className="flex items-start gap-2 p-3">
        <button onClick={onPeek} className="min-w-0 grow text-left">
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="text-base text-fg truncate min-w-0" title={s.title}>{s.title}</span>
            {s.live && <span className="text-sm text-ok shrink-0">live</span>}
            {s.archived && <span className="text-sm text-fg-mute shrink-0">Archived</span>}
          </span>
          <span className="mt-0.5 flex items-baseline gap-2 min-w-0 text-sm text-fg-mute">
            {s.branch && (
              <>
                {/* `text-left` is not redundant beside `direction: rtl` — it is
                    what keeps a branch that fits flush with the title above it
                    instead of ragged against the far edge. */}
                <span className="truncate min-w-0 [direction:rtl] text-left" title={s.branch}>
                  <bdi dir="ltr">{s.branch}</bdi>
                </span>
                <span className="shrink-0" aria-hidden>—</span>
              </>
            )}
            {/* The count is the first thing off the line, and it stays off it
                until `xl`: it is a floor read off the tail of the transcript,
                where the branch is exact, and it is the wider of the two. */}
            <span className="hidden xl:inline shrink-0 tnum">{s.turns} turns</span>
            <span className="hidden xl:inline shrink-0" aria-hidden>—</span>
            <span className="shrink-0 tnum">{ago(s.lastTs)}</span>
          </span>
        </button>

        <span className="flex items-center gap-1 shrink-0">
          {/*
            The word costs 110px, and on a 375px phone that 110px comes out of
            the title. Measured: the title column got 133px against a 438px
            string, so four different sessions rendered as `As you can see the…`,
            `fix(mfa): make the login…`, `You're working a cross-…`. The tile is
            the thing being read; the action is one of three on it. So the label
            collapses to the mark every "this leaves Wake" control in the
            product already carries, and the name lives on `title` and
            `aria-label` — which is where a control with no room for a word
            keeps its name.

            It collapses at `xl` and not at `sm`, because the phone is not the
            narrow case. A tile in the two-column grid is narrower than a phone
            until about 1150, and the same 110px comes out of the same two lines
            there. Branch width against a 256px branch name, measured in a
            browser with the 200px rail in place, before this pass and after it:

              375 → 55, then 176      1024 → 14, then 217
              640 →  0, then 225      1280 → 142, then 186
              768 →  0, then  89      1440 → 222, then 256 (the whole name)
              900 →  0, then 155

            Three of those widths were rendering the branch at zero pixels.
          */}
          <Button
            size="sm"
            title="Open in Claude"
            ariaLabel="Open in Claude"
            onClick={() => openInClaude(s)}
          >
            <span className="hidden xl:inline">Open in Claude</span>
            <ArrowUpRight size={14} className="xl:hidden" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title={s.archived ? 'Unarchive' : 'Archive'}
            ariaLabel={s.archived ? 'Unarchive' : 'Archive'}
            onClick={onArchive}
          >
            {s.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </Button>
          {/*
            Never disabled, on any row.

            `disabled:pointer-events-none` is what made the old greyed trash
            unexplainable: a title attribute on a control that cannot be
            pointed at is a reason nobody can reach, and on a phone it is not
            even a reason, it is a broken-looking icon. The dialog says why
            instead, in words, and the server refuses at two further layers.

            Ghost, not `danger`. This button opens a dialog; the dialog's
            button is what destroys, and that one is `danger`. Thirty filled red
            squares down a list is a page shouting at you about something none
            of them has actually done yet.
          */}
          <Button size="sm" variant="ghost" title="Delete" ariaLabel="Delete" onClick={onDelete}>
            <Trash2 size={14} />
          </Button>
        </span>
      </div>

      <SessionDrawer
        dx={swipe.dx}
        width={swipe.width}
        archived={!!s.archived}
        onArchive={onArchive}
        onDelete={onDelete}
        onClose={swipe.close}
      />
    </li>
  )
}

/**
 * The two actions behind a tile, revealed by the same gesture the desk uses.
 *
 * `useSwipe` is the desk's own hook — one gesture implementation in the
 * product, with the axis rules, the trackpad path and the single-open-row store
 * that comes with it. The panel is drawn here rather than through `SwipeDrawer`
 * because that component's three actions are `Done`, `Status` and `Delete`, and
 * a session has neither of the first two: it is not work you finish and it has
 * no status. Two solid, labelled boxes, and nothing rendered at all while the
 * drawer is shut — not at `opacity: 0` and not at `width: 0` with live buttons
 * inside it, which on a touch screen is a control that is permanently invisible
 * and permanently tappable.
 */
function SessionDrawer({
  dx, width, archived, onArchive, onDelete, onClose,
}: {
  dx: number
  width: number
  archived: boolean
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
          {archived ? 'Unarchive' : 'Archive'}
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

/* --------------------------------- sheets --------------------------------- */

/**
 * One session, at the length a sentence needs.
 *
 * This is where the last prompt lives. It is the most useful thing a transcript
 * carries and the least suited to a list — a paragraph of his own half-finished
 * thought, repeated thirty times down a column, is what made this page a wall
 * of text. Here there is exactly one of them and room to read it.
 *
 * Nothing is fetched. Every fact on this sheet is already on the row the list
 * was drawn from, so opening it costs nothing and cannot fail.
 */
function PeekSheet({
  session: s, onClose, onArchive, onDelete,
}: {
  session: Session | null
  onClose: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  return (
    <Sheet
      open={!!s}
      onClose={onClose}
      title={s?.title}
      /*
        Three words, and the destructive one is not the exception.

        Delete was a bare trash glyph between two labelled buttons, so the only
        control on the surface whose name had to be guessed was the only one
        that cannot be undone. It carries the word now, and the mark with it.

        `ml-auto` puts it at the far edge rather than a thumb's width from
        Archive, and `flex-wrap` is what keeps three labelled `lg` buttons from
        running off a 343px phone: they take a second line instead of a clipped
        one.
      */
      footer={s && (
        <div className="flex flex-wrap items-center gap-2">
          {/* The commit, at the one size reserved for a commit. */}
          <Button size="lg" onClick={() => { onClose(); openInClaude(s) }}>
            Open in Claude
          </Button>
          <Button size="lg" variant="default" onClick={onArchive}>
            {s.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {s.archived ? 'Unarchive' : 'Archive'}
          </Button>
          <Button size="lg" variant="ghost" className="ml-auto" onClick={onDelete}>
            <Trash2 size={14} /> Delete
          </Button>
        </div>
      )}
    >
      {s && (
        <div>
          {s.lastPrompt && (
            <p className="text-base text-fg-dim leading-snug whitespace-pre-wrap">{s.lastPrompt}</p>
          )}

          <div className="mt-4">
            <Fact label="Repository" mono>{s.cwd}</Fact>
            {s.branch && <Fact label="Branch" mono>{s.branch}</Fact>}
            {/* The one place the count's caveat is spelled out, which is why
                this row is allowed to wrap and the rest are not. Every other
                surface says `12 turns` and means exactly this. */}
            <Fact label="Turns" wrap>
              {s.turns}
              <span className="text-fg-mute">
                {' '}— counted in the tail of the transcript Wake reads, not in the whole session
              </span>
            </Fact>
            <Fact label="Last active">{ago(s.lastTs)}</Fact>
            {s.live && <Fact label="Running">on this machine right now</Fact>}
            {s.archived && <Fact label="Archived">in Wake, not on disk</Fact>}
            {/* Only what the last recorded turn actually said. A session that
                never wrote one of these gets no row rather than a guess. */}
            {s.permissionMode && (
              <Fact label="Mode" mono={!modeWord(s.permissionMode)}>
                {modeWord(s.permissionMode) ?? s.permissionMode}
              </Fact>
            )}
            {s.version && <Fact label="Claude Code" mono>{s.version}</Fact>}
            {s.pr && (
              <Fact label="Pull request">
                <a href={s.pr.url} target="_blank" rel="noreferrer"
                  className="text-accent-ink hover:underline">
                  {s.pr.repo}#{s.pr.number}
                </a>
              </Fact>
            )}
          </div>
        </div>
      )}
    </Sheet>
  )
}

/**
 * The launch sheet's word for a permission mode, or nothing.
 *
 * `Mode  bypassPermissions` printed the raw `--permission-mode` enum at a
 * reader who, four clicks away in the brief sheet, is offered the same two
 * values as `Bypass permissions` and `Accept edits` in a segmented control.
 * One product, one word — so the words come from that control's own list
 * rather than from a second copy of it here.
 *
 * `plan` and `default` are the two Claude Code modes the brief never offers and
 * a transcript can still record, so they are named here and nowhere else.
 * Anything beyond those four is returned unrecognised, and the caller prints
 * the enum verbatim in monospace: inventing a title-cased phrase for a mode
 * this build has never heard of would be a guess wearing prose.
 */
const EXTRA_MODES: Record<string, string> = { plan: 'Plan', default: 'Ask before acting' }
const modeWord = (m: string): string | null =>
  PERMISSION_MODES.find(x => x.id === m)?.label ?? EXTRA_MODES[m] ?? null

/**
 * A labelled fact, on the row grid the rest of the product reads at.
 *
 * `wrap` is for the one fact on this sheet that is a sentence rather than a
 * value. Truncation is right for a path and a branch — they are long because
 * they are precise — and wrong for an explanation, which is worth nothing at
 * all if its second half is an ellipsis.
 */
function Fact({
  label, mono, wrap, children,
}: { label: string; mono?: boolean; wrap?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-2 border-b border-rule last:border-0">
      <span className="text-sm text-fg-mute w-28 shrink-0">{label}</span>
      <span className={`text-sm text-fg-dim min-w-0 ${wrap ? 'leading-snug' : 'truncate'}
                        ${mono ? 'font-mono' : ''}`}>
        {children}
      </span>
    </div>
  )
}

/**
 * The delete dialog, which names what goes.
 *
 * The token is minted by the server against this exact session id and spent by
 * the delete, so approving one session and deleting another is not reachable —
 * the same rule the mail composer works under. The paths come back from that
 * same call, so the list shown is the list the server will act on rather than
 * something the client reconstructed.
 *
 * A running session takes the other branch entirely. Nothing is minted, nothing
 * is typed, and the reason is a paragraph on screen instead of a `title` on a
 * disabled icon that no device could ever show. The server refuses this twice
 * more on its own — the confirm route answers 409 and `deleteSession` refuses
 * again — so what changed here is only who gets told.
 *
 * Both buttons live in the sheet's pinned footer. They used to be the last
 * thing in the scrolled body, which on a phone with the confirm field focused
 * and the keyboard up put the only two ways out of this dialog below the fold,
 * with nothing on screen to suggest scrolling.
 */
function DeleteSheet({
  session, onClose, onDone,
}: { session: Session | null; onClose: () => void; onDone: () => void }) {
  const [confirm, setConfirm] = useState('')
  const [ready, setReady] = useState<{ token: string; paths: string[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const blocked = !!session?.live

  useEffect(() => {
    setConfirm('')
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

  const run = async () => {
    if (!session || !ready) return
    setBusy(true)
    try {
      const r = await launchApi.deleteSession(session.id, ready.token)
      toast(`Deleted ${r.removed.length} file${r.removed.length === 1 ? '' : 's'}.`)
      onDone()
    } catch (e) {
      setErr((e as Error).message)
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
            disabled={busy || blocked || !ready || confirm.trim().toLowerCase() !== CONFIRM_WORD}
            onClick={run}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete
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
                undone, and one of them is the edit-undo history for real source files. To put a
                session away without destroying it, archive it instead.
              </p>

              <h3 className="text-eyebrow uppercase text-fg-mute mt-4 mb-2">What goes</h3>
              {ready
                ? ready.paths.map(p => (
                  <p key={p} className="text-sm text-fg-mute font-mono truncate py-1 border-b border-rule last:border-0">
                    {p}
                  </p>
                ))
                : <p className="text-sm text-fg-mute h-8 flex items-center">—</p>}

              <h3 className="text-eyebrow uppercase text-fg-mute mt-4 mb-2">
                Type {CONFIRM_WORD} to confirm
              </h3>
              <input
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                aria-label={`Type ${CONFIRM_WORD} to confirm`}
                className={inputClass}
              />
            </>
          )}

          {err && <p className="text-sm text-bad mt-3">{err}</p>}
        </div>
      )}
    </Sheet>
  )
}
