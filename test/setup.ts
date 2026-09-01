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
 * The suite pins its own Slack scope, rather than borrowing the shipped one.
 *
 * This was not deliberate before and it bit: narrowing `DESK_CHANNELS` to the
 * sixteen channels the operator named took `#truto` off the list, and thirty-
 * nine tests failed that have nothing to do with which channels he wants. They
 * failed because `test/fixtures/slack.ts` is a real capture from `#truto`, and
 * every thread, dedup, recency and activity test is built on it.
 *
 * Reshaping the capture was the obvious way out and is the wrong one — that file
 * says so at the top, and it is right: a fixture edited to suit a test stops
 * proving anything. So the fixture stays verbatim and the *scope* becomes the
 * suite's own business, which is what it should always have been. A test about
 * thread parsing must not change its answer because somebody edited a
 * configuration list.
 *
 * The ids are carried, not just the names, because `isAllowedSlackChannel`
 * matches on the id first and several tests here pin exactly that — a channel
 * whose name arrived unreadable, and a channel that was renamed.
 *
 * `slack-channels.test.ts` is the one file this must not speak for: it is the
 * specification of the shipped list, so it asserts against `DESK_CHANNELS`
 * directly rather than against whatever is configured.
 */
process.env.WAKE_SLACK_CHANNELS = [
  'truto:C04D9HKDWAV',
  'clonepartner:C09BRBLNXNH', 'sprinto:C050LJAMFSN', 'maximor-truto:C0A8B267EE9',
  'spendflo-truto:C05CJ0CUV35', '15five-truto:C0AHHQMF08L', 'komplai-truto:C0A437E7UAU',
  'evergrowth-truto:C0A25L2QEB0', 'thoropass-truto:C05P80HPYSK', 'open-truto:C08SS821JHG',
  'stax-truto:C09TKFVP6AY', 'naq-truto:C09REMSHL14', 'docsbot-truto:C093QFW4U3E',
  'truto-balkanid:C07PMS3UYKB', 'ex-superhawk-truto:C0AACN2HYM7', 'truto-zen:C07AVEG7ZHN',
  'framer-clonepartner:C06UP5J326B', 'crisp-chats:C07351C8Z8E',
].join(',')

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
