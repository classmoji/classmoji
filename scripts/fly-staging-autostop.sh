#!/usr/bin/env bash
#
# Flip the ALREADY-RUNNING staging machines to scale-to-zero.
#
# The deploy workflows now generate a scale-to-zero config (see
# scripts/fly-autostop-config.sh), but that only takes effect on the next
# deploy. This applies the same autostart/autostop/min_machines_running settings
# to the machines running right now, reusing each machine's current image — no
# rebuild, and no release_command (so the webapp's `prisma migrate deploy` does
# not re-run against the staging DB).
#
# Each machine restarts briefly as it is updated.
#
# Usage: scripts/fly-staging-autostop.sh [--dry-run]

set -euo pipefail

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

# app:mode — ai-agent suspends (memory snapshot) so its WebSocket/LLM workload
# wakes fast; everything else does a full stop.
APPS=(
  "classmoji-webapp-staging:stop"
  "classmoji-ai-agent-staging:suspend"
  "classmoji-hook-station-staging:stop"
  "classmoji-mcp-staging:stop"
  "classmoji-pages-staging:stop"
  "classmoji-slides-staging:stop"
)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for entry in "${APPS[@]}"; do
  app="${entry%%:*}"
  mode="${entry##*:}"

  if ! flyctl status --app "$app" >/dev/null 2>&1; then
    echo "-- $app: not provisioned, skipping"
    continue
  fi

  flyctl machines list --app "$app" --json 2>/dev/null \
    | python3 -c 'import json,sys; print("\n".join(m["id"] for m in json.load(sys.stdin)))' \
    | while read -r id; do
      [ -n "$id" ] || continue
      cfg="$WORK/$app-$id.json"
      flyctl machine status "$id" --app "$app" --display-config 2>/dev/null > "$cfg"

      python3 - "$cfg" "$mode" <<'PY'
import json, sys
path, mode = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
services = cfg.get("services") or []
if not services:
    sys.exit(f"{path}: machine declares no services; nothing to autostop")
for svc in services:
    svc["autostop"] = mode
    svc["autostart"] = True
    svc["min_machines_running"] = 0
json.dump(cfg, open(path, "w"), indent=2)
PY

      if [ "$DRY_RUN" = true ]; then
        echo "-- $app / $id -> autostop=$mode, min_machines_running=0 (dry run)"
      else
        echo "== $app / $id -> autostop=$mode, min_machines_running=0"
        flyctl machine update "$id" --app "$app" --file "$cfg" --yes
      fi
    done
done

echo
echo "Done. Verify with: flyctl machines list --app classmoji-webapp-staging"
