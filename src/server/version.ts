/**
 * Which commit this process is running.
 *
 * It exists because nothing could answer that question, and the deploy script
 * was guessing at it from the wrong side. `wake-deploy.sh` asked "has origin
 * moved relative to my checkout?" and treated the answer as "does the box need
 * redeploying?" — two different questions that happen to agree only when every
 * commit arrives from somewhere else. Commit *in* the deploy checkout and push,
 * and `HEAD` equals `origin/main` on the very first comparison, so the script
 * exited before it built anything. `dist/` stayed stale, the unit kept its old
 * process, and the timer reported success every sixty seconds while doing
 * nothing. That is the shape of outage this whole product exists to refuse: a
 * cheerful zero.
 *
 * The honest question is "is the thing that is running the thing that is
 * checked out", and only one party can answer half of it. So the server says
 * which commit it booted on and the script compares that to `HEAD`. It catches
 * every way the two can drift, not just the one the old comparison modelled: a
 * commit made on the box, a hand `systemctl restart` after an edit, a unit that
 * crash-looped back up on an older image, a `bun src/server/index.ts` somebody
 * left running in a terminal.
 *
 * **Read once, at import, and never again.** Bun read this process's source out
 * of the checkout at boot, so `HEAD` at that instant is what this process *is*.
 * Re-reading later would report what the checkout has since become, which is the
 * other half of the question and belongs to the caller — and it would turn a
 * genuine mismatch into a match, which is the failure being fixed.
 */

import { spawnSync } from 'node:child_process'

/** The checkout this file was loaded from — `src/server/version.ts` is two down. */
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

function readHead(): string | null {
  try {
    // `git` by name rather than by absolute path: this is diagnostic, and a box
    // without git on PATH gets `null`, which the deploy script reads as "cannot
    // tell" and therefore as "deploy". Erring towards a redundant deploy is the
    // right direction for a check whose whole job is catching a missed one.
    const r = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', timeout: 5_000,
    })
    if (r.status !== 0) return null
    const sha = (r.stdout ?? '').trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

/**
 * The commit this process booted on, or `null` when it cannot be established.
 *
 * `null` is a real answer and not an error: a checkout without git, a tarball
 * deploy, a test run. Every reader has to treat it as "unknown" rather than as
 * "unchanged", because the only safe reading of "I do not know what I am
 * running" is that it might be the wrong thing.
 */
export const BOOT_COMMIT: string | null = readHead()

/** The first eight, for a log line. `—` rather than `null` for a human reader. */
export const bootCommitShort = (): string => BOOT_COMMIT?.slice(0, 8) ?? '—'
