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
process.env.WAKE_SKILLS_REPO = join(root, 'catalogs', 'c')

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
