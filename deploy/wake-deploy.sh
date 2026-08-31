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
# and silently discarding that is worse than refusing to deploy.
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
