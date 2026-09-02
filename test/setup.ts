/**
 * Test bootstrap. Runs before any test module is imported.
 *
 * It only sets environment variables: importing anything here would pull `db`
 * into the graph at the exact moment we are trying to redirect it.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// realpath, not the raw temp path: on macOS /var is a symlink to /private/var,
// and git reports a worktree's canonical directory through the real path — so
// without this the registry's "does this upstream exist?" check compares two
// spellings of the same directory and says no.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'wake-test-')))

process.env.WAKE_DATA_DIR = join(root, 'data')
process.env.WAKE_VOICE_DIR = join(root, 'voice')
process.env.WAKE_PACK_DIR = join(root, 'packs')
// A workspace root with nothing in it: the registry scan must find zero repos
// rather than the developer's actual checkouts, or a launch test would pass on
// one machine and fail on another.
process.env.WAKE_WORKSPACE_ROOT = join(root, 'workspace')
process.env.WAKE_CLAUDE_HOME = join(root, 'claude')
process.env.WAKE_EMAILS = 'me@example.com,team@example.com'

/**
 * Skill catalogs point at a fixture, not at ~/work.
 *
 * The index used to read whatever the machine happened to have cloned, so the
 * suite passed on a laptop with three sibling repos and failed on CI, which has
 * none. What is worth testing is the indexer — frontmatter, the manifest
 * override, catalog separation, reference confinement — and a fixture tests that
 * identically everywhere. routing.test.ts writes into these.
 */
process.env.WAKE_SKILLS_TRUTO = join(root, 'catalogs', 'a')
process.env.WAKE_SKILLS_CURSOR = join(root, 'catalogs', 'b')
// Catalog C is a *project* catalog and its shape carries meaning: a skill at
// `<repo>/.claude/skills/<name>` is loadable by a session running in that repo
// and by no other, which is what `skillReaches` answers. A flat fixture
// directory would have made every catalog-C skill unreachable and the reach
// tests meaningless.
process.env.WAKE_SKILLS_REPO = join(root, 'workspace', 'truto', '.claude', 'skills')

/**
 * Point both subprocess binaries at paths that do not exist.
 *
 * The suite must never run the real `truto` or start a real Claude Code
 * session, and pointing at nothing is stronger than remembering not to: a test
 * that accidentally reaches the CLI now fails loudly instead of mutating
 * someone's platform data.
 */
process.env.WAKE_TRUTO_BIN = join(root, 'no-such-truto')
process.env.WAKE_CLAUDE_BIN = join(root, 'no-such-claude')

/**
 * A tmux socket of the suite's own, and a directory to keep its files in.
 *
 * `WAKE_TMUX_SOCKET` defaults to `wake`, which is the socket the operator's
 * real sessions are on. Nothing in the suite has ever written to it — `available()`
 * refuses to spawn anything, because `WAKE_CLAUDE_BIN` above points at a file
 * that does not exist — but `listTerminals()` was reading it, so a test's answer
 * could depend on what he happened to have running at the time. It should not,
 * and a test that wants to create a tmux session to reattach to needs somewhere
 * safe to do it.
 */
process.env.WAKE_TMUX_SOCKET = 'wake-test'
process.env.WAKE_TERMINAL_SIZE_DIR = join(root, 'terminals')

/**
 * The suite's Slack scope now comes from the seeded `slack_channels` table
 * (`db.ts` migration 15) rather than a `WAKE_SLACK_CHANNELS` allowlist, which
 * no longer exists — and neither does the allowlist behaviour it fed. A
 * channel `slack_channels` has never heard of now defaults to *reachable*
 * (`slackScope.scopeFor` answers `mode: 'mentions'`), which is the property
 * that used to bite here: narrowing the old array to the channels the
 * operator actually named took `#truto` off it, and thirty-nine tests failed
 * that had nothing to do with which channels he wants — they failed because
 * `test/fixtures/slack.ts` is a real capture from `#truto`, and every thread,
 * dedup, recency and activity test is built on it. Reshaping the capture was
 * the wrong fix then and still would be; the fixture stays verbatim.
 *
 * Nothing needs overriding for that fixture's sake any more: the migration
 * seeds `#truto` at `mentions` and `#crisp-chats` at `all` unconditionally,
 * for this suite's database exactly as for a fresh production one, and those
 * are the two channels the fixture was captured from. What is pinned below is
 * a guard rather than a configuration.
 *
 * The import is dynamic, and deliberately the last thing in this file: it
 * pulls in `db` (through `slackScope`), which reads every `WAKE_*` env var
 * above at *its own* import time — so this has to run after all of them are
 * set, never before, or `db`'s idea of `WAKE_TRUTO_BIN` and the rest would be
 * whatever they defaulted to at the moment something first imported it.
 */
{
  const { scopeFor } = await import('../src/server/slackScope')
  const truto = scopeFor('C04D9HKDWAV', 'truto')
  if (truto.mode === 'off') {
    throw new Error(
      "test scope: #truto (C04D9HKDWAV) must stay reachable — test/fixtures/slack.ts was captured from it",
    )
  }
}
