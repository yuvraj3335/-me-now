/**
 * Which repository a Claude Code session belongs to.
 *
 * One module because there is one answer. This question is asked in three
 * places — the server's `?repo=` filter, the Sessions page's repository list,
 * and the brief's session picker — and for a while each of them answered it
 * differently. The picker and the page then showed different sets for the same
 * repository, which is the failure this file exists to make impossible: a rule
 * that lives in two implementations is a rule that will be true in one of them.
 *
 * It imports nothing, so the server and the browser bundle can both have it.
 */

/**
 * Claude Code's own name for a directory: every character that is not
 * alphanumeric becomes a dash, so `/Users/me/work/truto` is filed under
 * `-Users-me-work-truto`.
 *
 * A transcript that never wrote down where it ran has only the directory it is
 * *filed* under, and the server hands that name back as the session's `cwd` —
 * so a flattened name is a real value on this wire. On this machine it is three
 * of the two hundred.
 */
export const filedAs = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')

/**
 * Where a session ran, in the two spellings every surface carries: the working
 * directory the transcript recorded, and the short name it is listed under.
 */
export type SessionPlace = { cwd: string; project: string }

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Whether a session ran in this repository, or anywhere under it.
 *
 * **Exact-or-under**, and the trailing separator is the whole of what keeps it
 * honest. Two spellings of this test are wrong in the same direction and both
 * have shipped: `includes` answered `?repo=truto` with `truto-app`,
 * `truto-skills` and `truto-monitoring`; a bare `startsWith` does the same
 * thing to paths, because `/w/truto` is a prefix of `/w/truto-app`. A `/` after
 * the repository is what says "inside it" rather than "spelled like it".
 *
 * And under, not merely equal to: a session that ran in `truto-app/packages/web`
 * or in a worktree kept inside a checkout is a session in that repository. That
 * is what a person means by "truto-app's sessions", and matching only the exact
 * directory is what made `web`, `plans` and `QA_EVIDENCE` appear in a list of
 * repositories. They are not repositories.
 *
 * Three further cases, each because a real value on this wire needs it:
 *
 * - **The filed name**, matched exactly and never as a prefix. `-…-work-truto`
 *   is unambiguously this repository, but `-…-work-truto-app` is a sibling and
 *   `-…-work-truto-cli` is a directory inside it wearing the same shape — the
 *   encoding threw away the separator that told them apart, so the only honest
 *   thing to do with a dash there is nothing.
 * - **A bare name** (`truto`, `QUIET`), which is what a hand-typed `?repo=`
 *   usually is. Only when the wanted name is bare: `/elsewhere/truto` is not
 *   `~/work/truto` however alike the two read.
 * - **Case**, folded. The server has always compared lowercased, this runs
 *   against a case-insensitive filesystem, and `?repo=QUIET` is pinned by a
 *   test — so the browser has to agree rather than quietly answer a narrower
 *   question than the server did.
 *
 * `repo` is assumed to name something. "No repository chosen" is the caller's
 * question, not this one's, and every caller already has to answer it to know
 * whether to filter at all.
 */
export function sessionInRepo(s: SessionPlace, repo: string): boolean {
  if (eq(s.cwd, repo)) return true
  if (s.cwd.toLowerCase().startsWith(`${repo.toLowerCase()}/`)) return true
  if (eq(s.cwd, filedAs(repo))) return true
  return !repo.includes('/') && eq(s.project, repo)
}

/**
 * The repository a session is attributed to, out of the ones that exist.
 *
 * Longest match wins, so a checkout kept inside another checkout is credited to
 * itself rather than to whatever contains it. `null` means the session ran
 * somewhere that is not one of these — `/private/tmp/wake-ws/scratch` is a real
 * example — and a caller that has to name a place anyway should fall back to
 * where it actually ran rather than inventing a repository for it.
 */
export function repoForSession(s: SessionPlace, repos: readonly string[]): string | null {
  let best: string | null = null
  for (const r of repos) {
    if (!sessionInRepo(s, r)) continue
    if (!best || r.length > best.length) best = r
  }
  return best
}
