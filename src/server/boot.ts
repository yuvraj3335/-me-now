/**
 * What happens once, at startup.
 *
 * Two indexes get rebuilt — the workspace registry and the skill catalogs —
 * because both are derived entirely from what is on disk, and a stale one is
 * how a hand-off names a repository that has since moved.
 *
 * There is nothing to recover any more. Wake starts no processes of its own, so
 * a restart cannot leave a half-finished one behind.
 */

import { reindexSkills } from './skills/catalog'
import { rescan } from './registry/scan'
import { handoffTarget } from './claudecode/handoff'

export function boot() {
  return {
    repos: rescan().scanned,
    skills: reindexSkills().indexed,
    handoff: handoffTarget(),
  }
}
