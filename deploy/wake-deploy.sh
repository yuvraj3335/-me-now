#!/usr/bin/env bash
#
# Pull main, verify it, restart Wake — but only if all three hold.
#
# The box is behind Cloudflare Access and accepts no inbound connections, so
# deployment is pull-based rather than pushed from CI. A timer runs this every
# minute; the usual tick is one `git fetch`, one `curl` and no more.
#
# The order matters. Fetch, then check out, then verify, then restart. A build
# that fails leaves the previous dist/ in place and the service untouched, so a
# bad push costs a red log line rather than a dark screen on someone's phone.
#
# ── The question this script asks, and the one it used to ask ───────────────
#
# It used to compare `HEAD` to `origin/main` and exit when they matched. That is
# "has origin moved relative to my checkout", and it is not the same question as
# "does this box need redeploying" — the two agree only while every commit
# arrives from somewhere else.
#
# They stopped agreeing the first time somebody committed *in the deploy
# checkout* and pushed. `HEAD` equals `origin/main` on the very first
# comparison, so the script exited before it fetched a thing, let alone built
# one: `dist/` stayed stale, the unit kept running its old process, and this
# timer reported success every sixty seconds while doing nothing at all. Which
# is worse than failing, because there is nothing to notice.
#
# The same hole swallowed a second case that the rollback below was written to
# prevent and did not. Verification passes, the ERR trap is cleared, and then
# the *build* fails — `exit 1` leaves `HEAD` on the new commit with an old
# `dist/` and an old process, and from that moment `HEAD` equals `origin/main`
# forever, so the next tick and every tick after it exits 0 in silence.
#
# So the trigger is now the honest question: **is the process that is running
# the commit that is checked out?** Only the server can answer half of it, so it
# says which commit it booted on — `/healthz` carries `commit`, see
# `src/server/version.ts` — and this compares that to `HEAD`. Origin still
# decides *what to check out*; it no longer decides whether to deploy.
#
# What that buys beyond the bug: a hand `systemctl restart` after an edit, a
# unit that crash-looped back up on an older image, and a `bun src/server/
# index.ts` left running in a terminal are all now states this timer notices and
# corrects, and none of them were before.
set -euo pipefail

REPO="${WAKE_REPO_DIR:-$HOME/work/wake}"
BRANCH="${WAKE_DEPLOY_BRANCH:-main}"
BUN="${WAKE_BUN:-$HOME/.bun/bin/bun}"
HEALTH="${WAKE_HEALTH_URL:-http://127.0.0.1:8585/healthz}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/wake"

cd "$REPO"

# What the running process says it booted on.
#
# An unreachable server, a `commit` this build does not carry, and a `null` all
# come back as the empty string, and every one of them means "cannot tell" —
# which is read as "deploy". A redundant build is the cheap error here and a
# missed one is the expensive error, so the uncertainty resolves that way on
# purpose. It is also correct on its own terms: a server that is down needs a
# restart, and restarting it is what this script does.
running_sha=$(curl -fsS --max-time 5 "$HEALTH" 2>/dev/null \
  | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p' || true)
# For log lines. `${var:0:8}` is a substring and cannot also carry a default, so
# the two are separated rather than spelled as one clever expansion that a shell
# rejects at runtime and `bash -n` does not catch.
running_short="${running_sha:0:8}"
[ -n "$running_short" ] || running_short="unreachable"

git fetch --quiet origin "$BRANCH"

local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse "origin/$BRANCH")

# Nothing to check out and nothing to correct: the common tick, and it stays
# silent. Both halves have to hold — the checkout is on origin *and* the process
# is on the checkout — which is the whole of the fix.
if [ "$local_sha" = "$remote_sha" ] && [ "$local_sha" = "$running_sha" ]; then
  exit 0
fi

# A commit that has already failed here, not retried into the ground.
#
# The old script rolled back on failure so the next tick would see the move
# again and report again. That rollback is wrong now — when `HEAD` was already
# at origin there is nowhere to roll back *to* — so the loop is bounded here
# instead. A transient failure (a network blip during `bun install`, a full
# disk) clears within the window and is retried; a genuinely broken commit costs
# six verification runs an hour rather than sixty, and says so once.
mkdir -p "$STATE"
failed_file="$STATE/deploy-failed"
retry_after=${WAKE_DEPLOY_RETRY_SEC:-600}
if [ -f "$failed_file" ]; then
  read -r failed_sha failed_at < "$failed_file" || true
  if [ "${failed_sha:-}" = "$remote_sha" ] \
     && [ $(( $(date +%s) - ${failed_at:-0} )) -lt "$retry_after" ]; then
    exit 0
  fi
fi
mark_failed() { echo "$remote_sha $(date +%s)" > "$failed_file"; }

# Different is not the same as behind, and the difference matters.
#
# This used to deploy on any mismatch. But a mismatch is also what "someone
# committed on the box and has not pushed yet" looks like — and in that state
# `merge --ff-only` says "Already up to date" and succeeds, so the script sailed
# straight past it and went on to verify, build and restart. Every sixty seconds,
# for as long as the commit sat unpushed.
#
# It is also how the rollback further down came to fire on a tree nobody was
# deploying: the merge was a no-op, the typecheck then ran against uncommitted
# work in progress, failed, and the trap reset --hard'd that work away. The dirty
# guard below is the direct fix for the damage; this is the fix for the script
# having been there at all.
#
# So: only move when there is somewhere forward to move to. `--is-ancestor`
# answers exactly that — HEAD is contained in origin, so a fast-forward is real.
if ! git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
  # Ahead is a normal state while working and resolves itself on the next push,
  # so it is not a failure. Diverged is not normal, and nothing here can fix it.
  if git merge-base --is-ancestor "origin/$BRANCH" HEAD; then
    # It now says what the *consequence* is, which is the sentence that was
    # missing while this was silently the reason nothing shipped. "Nothing to
    # deploy" was true of the checkout and said nothing about the box, and the
    # box is what somebody is refreshing on their phone.
    echo "wake-deploy: ${local_sha:0:8} is ahead of origin/$BRANCH - not deploying unpushed work; the box is serving $running_short"
    exit 0
  fi
  echo "wake-deploy: ${local_sha:0:8} and origin/$BRANCH have diverged - refusing to deploy" >&2
  exit 1
fi

# Why this tick is doing anything, in the terms the trigger actually used.
if [ "$local_sha" != "$remote_sha" ]; then
  echo "wake-deploy: ${local_sha:0:8} -> ${remote_sha:0:8}"
else
  echo "wake-deploy: checkout is ${local_sha:0:8}; the running process is $running_short - redeploying"
fi

# Refuse a dirty tree, and refuse it BEFORE anything else happens.
#
# Two reasons, and the order matters for the second one.
#
# The rollback further down is `git reset --hard`, which cannot tell the commit
# it is undoing from work nobody has committed yet. Measured, painfully: an
# agent working in this checkout committed locally without pushing, so local and
# remote differed; the ff-merge failed; the ERR trap fired; and `reset --hard`
# threw away every uncommitted edit in the tree. `--ff-only` exists precisely so
# that "someone edited on the box" stops a deploy rather than losing the edit,
# and the trap was quietly undoing that promise.
#
# And it sits above the backup rather than below it because this state persists:
# the timer runs every minute, so a box someone is working on would take a full
# `sqlite3 .backup` copy sixty times an hour and rotate the real pre-deploy
# backups out of a fourteen-deep directory within a quarter of an hour. The
# retention policy would be defeated by exactly the condition this guard exists
# to handle.
#
# Captured into a variable rather than tested inline: a command substitution
# that fails inside `[ ... ]` does not trip `set -e`, it just yields an empty
# string — so `git status` erroring (an index.lock held by a concurrent agent,
# say) would read as a clean tree and let the merge through. This way the exit
# status is checked and an unreadable tree is refused rather than assumed clean.
#
# Untracked files are deliberately not counted: agent litter in the working
# directory is the normal state of this box and is not work to protect.
if ! dirty=$(git status --porcelain --untracked-files=no 2>&1); then
  echo "wake-deploy: refusing to deploy - cannot read the tree in $REPO" >&2
  echo "$dirty" >&2
  exit 1
fi
if [ -n "$dirty" ]; then
  echo "wake-deploy: refusing to deploy - uncommitted changes in $REPO" >&2
  echo "$dirty" >&2
  exit 1
fi

# The database is the only thing here that cannot be rebuilt from git.
db="$HOME/.local/share/wake/wake.sqlite"
if [ -f "$db" ]; then
  mkdir -p "$HOME/.local/share/wake/backups"
  sqlite3 "$db" ".backup '$HOME/.local/share/wake/backups/pre-$(date +%F-%H%M%S).sqlite'"
  # Keep a fortnight of them; a personal tool does not need a retention policy
  # any more elaborate than this, and an unbounded backup directory is its own
  # kind of outage.
  ls -1t "$HOME/.local/share/wake/backups"/pre-*.sqlite 2>/dev/null | tail -n +15 | xargs -r rm --
fi

# Fast-forward only. A diverged local checkout means someone edited on the box,
# and silently discarding that is worse than refusing to deploy. The tree is
# already known clean by here — see the guard above.
git merge --ff-only "origin/$BRANCH"

# And back out of it if the commit does not survive verification.
#
# Without this the checkout stayed on the bad commit: `set -e` killed the script
# at the failing typecheck, so `dist/` and the running unit were still the old
# build — but HEAD was the new one, which made `local_sha` equal `remote_sha` on
# every later tick, so the timer exited 0 in silence and never reported again.
# The box then sat on unverified code until something restarted the unit, at
# which point it booted a commit that had never passed a check. Rolling back
# means the next tick sees the move again, tries again, and logs again.
# Back out of the merge if the commit does not survive verification — and only
# if there *was* a merge.
#
# The old trap reset --hard to `local_sha` unconditionally, on the assumption
# that a deploy always moves HEAD. It does not any more: the common case now is
# a commit made in this checkout and pushed, where HEAD was already at origin
# and the merge is a no-op. Resetting there is at best pointless and at worst a
# reset of the working tree for no reason. So the rollback is conditional on
# having moved, and the failure marker is what stops the retry loop in the case
# where there is nowhere to go back to.
rollback() {
  echo "wake-deploy: ${remote_sha:0:8} failed verification" >&2
  mark_failed
  if [ "$local_sha" != "$remote_sha" ]; then
    echo "wake-deploy: rolling back to ${local_sha:0:8}" >&2
    git reset --hard "$local_sha" >/dev/null 2>&1 || true
  fi
}
trap rollback ERR

"$BUN" install --frozen-lockfile
"$BUN" run typecheck
"$BUN" test

# The paragraph at the top of this file promises that a failed build leaves the
# previous dist/ in place. It did not: `vite.config.ts` sets `emptyOutDir`, so
# `vite build` clears dist/ before it writes anything, and a build that dies
# after that point — a rollup resolution error tsc cannot see, a full disk, an
# OOM — leaves an empty directory and a service serving nothing. Typecheck and
# the suite catch most of it first, which is why this has never been the failure
# that woke anyone; it is still the one case where a bad push costs the dark
# screen on someone's phone that this script exists to prevent.
#
# So the promise is kept by keeping a copy. On success the copy is dropped; on
# failure it goes back and the service is never restarted, so the box carries on
# serving the build it already had.
# Verification passed, so the commit stays whatever happens next; from here the
# dist/ copy below is what a failure is answered with.
trap - ERR

if [ -d dist ]; then
  rm -rf dist.prev
  cp -a dist dist.prev
fi

if ! "$BUN" run build; then
  echo "wake-deploy: build failed on ${remote_sha:0:8} — restoring the previous dist/" >&2
  if [ -d dist.prev ]; then
    rm -rf dist
    mv dist.prev dist
  fi
  # Marked, which it never was. This is the branch that used to poison the
  # trigger permanently: verification had passed, the ERR trap was cleared, and
  # `exit 1` left HEAD on the new commit with an old dist/ and an old process —
  # after which `local_sha` equalled `remote_sha` on every later tick and the
  # timer exited 0 in silence forever. The new trigger notices it on the next
  # tick regardless; the marker is what keeps it from rebuilding every minute.
  mark_failed
  exit 1
fi

rm -rf dist.prev

systemctl --user restart wake

# Confirmed, not announced.
#
# "restarted on <sha>" was a claim about a command that had been *issued*, which
# is the same class of statement as the one this whole script was rewritten to
# stop making. The unit can fail to come back — a bad .env, a port still held, a
# crash on boot — and the old line said it had deployed anyway. So it waits for
# the process to say which commit it booted on, and reports what it actually
# finds.
deployed=""
for _ in $(seq 1 30); do
  deployed=$(curl -fsS --max-time 2 "$HEALTH" 2>/dev/null \
    | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p' || true)
  [ -n "$deployed" ] && break
  sleep 1
done

if [ "$deployed" = "$remote_sha" ]; then
  rm -f "$failed_file"
  echo "wake-deploy: live on ${remote_sha:0:8}"
elif [ -n "$deployed" ]; then
  # It came back on something else, which means the checkout moved under it or
  # something restarted it in between. Worth a line rather than silence; the
  # next tick will correct it.
  echo "wake-deploy: restarted, but the box reports ${deployed:0:8} and the checkout is ${remote_sha:0:8}" >&2
  exit 1
else
  echo "wake-deploy: restarted on ${remote_sha:0:8} but it never answered $HEALTH — check: systemctl --user status wake" >&2
  mark_failed
  exit 1
fi
