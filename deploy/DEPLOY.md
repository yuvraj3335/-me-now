# Deploying Wake to the DevBox

Wake runs as a **user** systemd unit bound to loopback, and is published through
`expose`, which is the same pattern `truto-monitoring` already uses on this box:
a proxied CNAME onto the `ovh-devbox` Cloudflare tunnel, a Caddy site on the
box, and the hostname attached to your Cloudflare Access app (OTP login).

Everything that matters lives in git. The box holds exactly two things that do
not: `.env` and the SQLite database.

## First install

```bash
ssh yuvraj-devbox
git clone git@github.com:yuvraj3335/-me-now.git ~/work/wake
cd ~/work/wake
bun install
bun run build
cp .env.example .env      # then edit WAKE_PUBLIC_URL to the real hostname
```

Install and start the unit:

```bash
mkdir -p ~/.config/systemd/user
cp ~/work/wake/deploy/wake.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wake
```

Publish it (one preview slot; the cap is 5 per engineer):

```bash
expose wake 8585
```

That prints the URL. Put the same URL in `.env` as `WAKE_PUBLIC_URL` and restart,
because it is what the OAuth redirect and push deep links are built from:

```bash
systemctl --user restart wake
```

## Updating

Nothing, normally. A timer on the box checks `origin/main` every minute and
redeploys when it moves — backing the database up, fast-forwarding, and running
typecheck, tests and the build *before* it restarts anything. A failing build
leaves the running version alone.

Install it once:

```bash
cp ~/work/wake/deploy/wake-deploy.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wake-deploy.timer
```

Watch it:

```bash
systemctl --user list-timers wake-deploy.timer
journalctl --user -u wake-deploy -f
```

It is quiet by design: a run where `origin/main` has not moved logs nothing at
all. To deploy by hand, or to see why one failed:

```bash
~/work/wake/deploy/wake-deploy.sh
```

The same three checks also run on GitHub Actions for every push and pull request
(`.github/workflows/ci.yml`), so a red build there is a deploy that does not
happen here.

## Checking on it

```bash
systemctl --user status wake
journalctl --user -u wake -f          # one line per request, plus each poll summary
curl -s localhost:8585/healthz        # card count and uptime
```

A healthy boot looks like:

```
workspace: 43 repos, 28 skills indexed
hand-off: https://claude.ai/new
ingest: 22 groups (+0 new) · slack=14 github=4 gmail=0 sentry=0 claude=18
```

There is no key to check and no binary to find: "Open in Claude" is a link, so
the only thing that can be wrong with it is `WAKE_HANDOFF_URL`.

A source reporting `=err` names its error on the same line, and Settings shows
the same thing in plain words.

## Keeping it alive across reboots

A user unit only runs while the user has a session unless lingering is enabled:

```bash
loginctl enable-linger yuvraj
```

Without this, Wake stops when your last SSH session ends — which is exactly when
you would want it still polling.

## The things that are not in git

- **`.env`** — copy from `.env.example`. Every value has a working default except
  the Agent's API key, and only `WAKE_PUBLIC_URL` genuinely needs setting.
- **`~/.local/share/wake/wake.sqlite`** — tasks, goals, notes, reminders,
  acknowledgements, agent conversations, launch packs, the mail cache and the
  whole activity log the Pulse page is built from.
- **`~/.local/share/wake/voice/`** — the audio for every voice note. The database
  indexes these; it does not contain them.
- **`~/.local/share/wake/packs/`** — the briefs handed to Claude Code sessions.
  Regenerable in principle, but they are the record of what was handed over.

The deploy timer backs the database up before every update it applies, keeping
the last fortnight in `~/.local/share/wake/backups/`. To take one by hand:

```bash
sqlite3 ~/.local/share/wake/wake.sqlite ".backup '/tmp/wake-backup-$(date +%F).sqlite'"
```

## Migrations

Schema changes are numbered and recorded in `schema_migrations`, applied at boot
inside a transaction each. There is nothing to run by hand — start the new
version and check the log. A failed migration leaves the row unwritten, so the
next boot retries it rather than skipping a half-applied change.

## Skills a brief names

Wake indexes skill catalogs to *offer* them (`SKILL_PATHS` in `src/server/env.ts`),
but the session that receives the brief resolves them against **Claude Code's own**
registry, `~/.claude/skills/`. Those are two different lists, and a name in the
first but not the second produces `Error: Unknown skill: <name>` in red, in the
first seconds of the session — which is how `humanizer-voice` was found.

The convention on this box is a symlink per skill into a source of truth:

```bash
ls -l ~/.claude/skills/          # truto-cli -> ../../.agents/skills/truto-cli
ln -sfn ~/work/Cursor-skills/.cursor/skills/humanizer-voice \
        ~/.claude/skills/humanizer-voice
```

This lives outside the repository, so a fresh box needs it doing again. Nothing
breaks without it — the Humanizer template carries its whole voice inline and
does not depend on the skill loading — but the session says so loudly.

## Notes

- The port (8585) is loopback-only. Nothing reaches Wake except through Caddy →
  the tunnel → Cloudflare Access, so the OTP login is the only door.
- Wake polls outward and exposes no inbound callback, so there is no webhook
  surface to secure.
- `expose --list` shows your live previews; `expose --remove wake` frees the slot.
