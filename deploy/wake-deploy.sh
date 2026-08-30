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

"$BUN" install --frozen-lockfile
"$BUN" run typecheck
"$BUN" test
"$BUN" run build

systemctl --user restart wake
echo "wake-deploy: restarted on ${remote_sha:0:8}"
