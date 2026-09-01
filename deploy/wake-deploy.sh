#!/usr/bin/env bash
#
# Pull main, verify it, restart Wake — but only if all three hold.
#
# The box is behind Cloudflare Access and accepts no inbound connections, so
# deployment is pull-based rather than pushed from CI. A timer runs this every
# minute; it does nothing at all unless origin/main has actually moved, which
# makes the common case one `git fetch` and no more.
#
# The order matters. Fetch, then check out, then verify, then restart. A build
# that fails leaves the previous dist/ in place and the service untouched, so a
# bad push costs a red log line rather than a dark screen on someone's phone.
set -euo pipefail

REPO="${WAKE_REPO_DIR:-$HOME/work/wake}"
BRANCH="${WAKE_DEPLOY_BRANCH:-main}"
BUN="${WAKE_BUN:-$HOME/.bun/bin/bun}"

cd "$REPO"

git fetch --quiet origin "$BRANCH"

local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse "origin/$BRANCH")

if [ "$local_sha" = "$remote_sha" ]; then
  exit 0
fi

echo "wake-deploy: ${local_sha:0:8} -> ${remote_sha:0:8}"

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
trap 'echo "wake-deploy: ${remote_sha:0:8} failed verification — rolling back to ${local_sha:0:8}" >&2; git reset --hard "$local_sha" >/dev/null 2>&1 || true' ERR

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
  echo "wake-deploy: build failed on ${remote_sha:0:8} — restoring the previous dist/"
  if [ -d dist.prev ]; then
    rm -rf dist
    mv dist.prev dist
  fi
  exit 1
fi

rm -rf dist.prev

systemctl --user restart wake
echo "wake-deploy: restarted on ${remote_sha:0:8}"
