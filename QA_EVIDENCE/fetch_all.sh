#!/bin/bash
set -e
BASE="https://yuvraj-wake.truto.dev"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

declare -a ENDPOINTS=(
  "/healthz|healthz2.json"
  "/manifest.webmanifest|manifest.json"
  "/api/state|api_state.json"
  "/api/sources|api_sources.json"
  "/api/analytics|api_analytics_default.json"
  "/api/analytics?days=7|api_analytics_7.json"
  "/api/analytics?days=30|api_analytics_30.json"
  "/api/analytics?days=90|api_analytics_90.json"
  "/api/connections|api_connections.json"
  "/api/mail/state|api_mail_state.json"
  "/api/mail/state?refresh=1|api_mail_state_refresh.json"
  "/api/mail/threads?box=inbox|api_mail_threads_inbox.json"
  "/api/mail/threads?box=unread|api_mail_threads_unread.json"
  "/api/mail/threads?box=starred|api_mail_threads_starred.json"
  "/api/mail/threads?box=sent|api_mail_threads_sent.json"
  "/api/mail/threads?box=drafts|api_mail_threads_drafts.json"
  "/api/mail/threads?box=all|api_mail_threads_all.json"
  "/api/mail/labels?account=yuvraj@redroot.one|api_mail_labels_yuvraj.json"
  "/api/mail/labels?account=engineering@redroot.one|api_mail_labels_eng.json"
  "/api/claude/state|api_claude_state.json"
  "/api/claude/sessions|api_claude_sessions.json"
  "/api/claude/packs|api_claude_packs.json"
  "/api/settings|api_settings.json"
  "/api/settings/truto|api_settings_truto.json"
  "/api/settings/audit?limit=80|api_settings_audit.json"
  "/api/voice|api_voice.json"
  "/api/push/key|api_push_key.json"
  "/api/push/status|api_push_status.json"
  "/api/agent|api_agent.json"
  "/api/agent/state|api_agent_state.json"
  "/api/agent/anything|api_agent_anything.json"
)

for entry in "${ENDPOINTS[@]}"; do
  path="${entry%%|*}"
  fname="${entry##*|}"
  status=$(curl -s -o "$fname" -w "%{http_code}" "$BASE$path")
  echo "$status  $path  -> $fname"
done
