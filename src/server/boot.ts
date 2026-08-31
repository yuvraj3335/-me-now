/**
 * What happens once, at startup.
 *
 * Two indexes get rebuilt — the workspace registry and the skill catalogs —
 * because both are derived entirely from what is on disk, and a stale one is
 * how a hand-off names a repository that has since moved.
 *
 * Nothing is *recovered*, and that is still true now that Wake starts sessions.
 * A Claude Code session lives in a detached tmux on a socket of Wake's own, so
 * it outlives this process rather than depending on it: a restart reattaches by
 * asking tmux what is running, and there is no state here that could disagree
 * with the answer. See `claudecode/terminal.ts`.
 */

import { reindexSkills } from './skills/catalog'
import { rescan } from './registry/scan'
import { available, listTerminals } from './claudecode/terminal'

export function boot() {
  const ready = available()
  return {
    repos: rescan().scanned,
    skills: reindexSkills().indexed,
    /**
     * One line about whether "Open in Claude" can actually open anything.
     *
     * It used to print the hand-off URL, which was `https://claude.ai/new` on
     * every boot forever — a constant, reported as news. What is worth a line
     * in `journalctl` is the thing that varies between machines and breaks
     * silently: whether tmux, python3 and the claude binary are all here, and
     * how many sessions survived the restart.
     */
    terminal: ready.ok
      ? `sessions ready · ${listTerminals().length} running`
      : `sessions unavailable — ${ready.missing}`,
  }
}
