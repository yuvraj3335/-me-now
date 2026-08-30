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

```bash
cd ~/work/wake && git pull && bun install && bun run build && systemctl --user restart wake
```

## Checking on it

```bash
systemctl --user status wake
journalctl --user -u wake -f          # one line per request, plus each poll summary
curl -s localhost:8585/healthz        # card count and uptime
```

A healthy boot looks like:

```
agent: 43 repos, 28 skills indexed, key via settings (…a1b2)
claude code: 2.1.233 (Claude Code)
ingest: 22 groups (+0 new) · slack=14 github=4 gmail=0 sentry=0 claude=18
```

`key MISSING` on the first line means the Agent cannot run — add one in
Settings → Agent. A `claude code:` line that names a reason instead of a version
means "Open in Claude Code" is unavailable, and the launch sheet will say the
same thing rather than failing at the click.

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

Back up before every deploy that carries a migration:

```bash
sqlite3 ~/.local/share/wake/wake.sqlite ".backup '/tmp/wake-backup-$(date +%F).sqlite'"
```

## Migrations

Schema changes are numbered and recorded in `schema_migrations`, applied at boot
inside a transaction each. There is nothing to run by hand — start the new
version and check the log. A failed migration leaves the row unwritten, so the
next boot retries it rather than skipping a half-applied change.

## Notes

- The port (8585) is loopback-only. Nothing reaches Wake except through Caddy →
  the tunnel → Cloudflare Access, so the OTP login is the only door.
- Wake polls outward and exposes no inbound callback, so there is no webhook
  surface to secure.
- `expose --list` shows your live previews; `expose --remove wake` frees the slot.
