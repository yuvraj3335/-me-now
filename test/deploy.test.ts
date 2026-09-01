/**
 * The contract between the running process and the thing that redeploys it.
 *
 * `wake-deploy.sh` used to ask "has origin moved relative to my checkout?" and
 * treat the answer as "does this box need redeploying?". Those are different
 * questions and they agree only while every commit arrives from somewhere else.
 * Commit *in* the deploy checkout and push, and `HEAD` equals `origin/main` on
 * the first comparison — so the script exited before it built anything, `dist/`
 * stayed stale, the unit kept its old process, and the timer reported success
 * every sixty seconds while doing nothing.
 *
 * The fix moved the question to "is the process that is running the commit that
 * is checked out", which needs the process to say what it booted on. That answer
 * travels over `/healthz` as `commit`, and a shell script parses it with a
 * regex. Both halves of that are easy to break silently from this side — rename
 * the field, widen the type, start returning a short sha — and the failure would
 * be the original bug returning wearing a different coat: a deploy check that
 * quietly always says "nothing to do".
 *
 * So the shape is pinned here rather than trusted. These tests are about the
 * *contract*, not about which commit this happens to be.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { BOOT_COMMIT, bootCommitShort } from '../src/server/version'

const script = readFileSync(new URL('../deploy/wake-deploy.sh', import.meta.url).pathname, 'utf8')

describe('the commit a process booted on', () => {
  test('is a full sha or an honest null, and never anything else', () => {
    // `null` is a real answer — a checkout without git, a tarball, a container.
    // What must not happen is a short sha, an empty string or a "unknown"
    // sentinel, because the script matches 40 hex characters and would read any
    // of those as "cannot tell" while looking like it had been told.
    if (BOOT_COMMIT !== null) {
      expect(BOOT_COMMIT).toMatch(/^[0-9a-f]{40}$/)
    }
    expect(typeof bootCommitShort()).toBe('string')
    expect(bootCommitShort().length).toBeLessThanOrEqual(8)
  })

  test('the script can parse what the server would send', () => {
    // The exact regex out of the script, run against the exact JSON the route
    // emits. Two files, one format, and this is the only place they meet.
    const extract = (body: string): string | null =>
      /"commit":"([0-9a-f]{40})"/.exec(body)?.[1] ?? null

    const sha = 'a'.repeat(40)
    expect(extract(`{"ok":true,"commit":"${sha}","cards":105,"uptime":515}`)).toBe(sha)
    // The null case has to read as "cannot tell", which the script turns into
    // "deploy" — erring towards a redundant build rather than a missed one.
    expect(extract('{"ok":true,"commit":null,"cards":105,"uptime":515}')).toBeNull()
    expect(extract('{"ok":true,"cards":105}')).toBeNull()
  })
})

describe('what the deploy script triggers on', () => {
  /**
   * The regression, stated as the thing that must not come back.
   *
   * A bare `if [ "$local_sha" = "$remote_sha" ]; then exit 0` is the bug: it is
   * the comparison that cannot see a commit made in the deploy checkout. The
   * early exit has to test the running process too.
   */
  test('the early exit is not origin-versus-checkout alone', () => {
    // Every line that compares the checkout to origin has to compare the
    // running process too. Asserting on the line rather than on a multi-line
    // regex, because a regex loose enough to span the `exit 0` is also loose
    // enough to match the fixed version — which is how the first draft of this
    // test passed while pointing at the bug.
    const comparisons = script.split('\n')
      .filter(l => l.includes('"$local_sha" = "$remote_sha"') && l.trim().startsWith('if'))
    expect(comparisons.length, 'the trigger comparison moved or vanished').toBe(1)
    expect(comparisons[0], 'the origin-only early exit is back')
      .toContain('"$local_sha" = "$running_sha"')
  })

  test('it asks the running process what it is, before deciding anything', () => {
    expect(script).toContain('/healthz')
    expect(script).toMatch(/running_sha=\$\(curl/)
    // And the fetch happens after, so an unreachable server cannot be mistaken
    // for a checkout that has not moved.
    // The command, not the word: `git fetch` also appears in the header prose,
    // and matching that would compare a comment to a command.
    const fetchAt = script.search(/^git fetch /m)
    expect(fetchAt).toBeGreaterThan(0)
    expect(script.indexOf('running_sha=$(curl')).toBeLessThan(fetchAt)
  })

  test('a failure is recorded, on every path that can fail', () => {
    // The build-failure path is the one that used to poison the trigger
    // permanently: verification had passed, the ERR trap was cleared, and
    // `exit 1` left HEAD on the new commit with an old dist and an old process.
    expect(script).toContain('mark_failed')
    // Once in the rollback, once after a failed build, once when the unit never
    // comes back. Fewer than three means a path that fails silently.
    expect(script.match(/\bmark_failed\b/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })

  test('the restart is confirmed rather than announced', () => {
    // "restarted on <sha>" was a claim about a command that had been issued.
    // The unit can fail to come back, and the old line said it had deployed.
    expect(script).toContain('live on')
    expect(script).toMatch(/never answered/)
  })
})
