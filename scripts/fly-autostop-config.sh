#!/usr/bin/env bash
#
# Generate a scale-to-zero variant of an app's production fly.toml for the
# staging / dev environments.
#
# Staging and dev deploy the *production* fly.toml with `--app <name>-staging`
# (see .github/workflows/deploy-fly-staging.yml), so they inherited
# `auto_stop_machines = off` + `min_machines_running = 1` and idled 24/7 at full
# production cost. Rather than fork the configs — and let them drift — this
# rewrites just the three autoscale keys at deploy time so those environments
# stop when nobody is using them and auto-start on the next request.
#
# Usage: scripts/fly-autostop-config.sh <path/to/fly.toml> [stop|suspend]
#   stop     — machine is fully stopped; cold start is a full boot (default)
#   suspend  — memory snapshot is kept; wakes faster, for heavier/long-lived
#              services (ai-agent). Fly falls back to stop if it can't suspend.
#
# Prints the generated config's path; deploy it with `flyctl deploy --config <path>`.

set -euo pipefail

SRC="${1:?usage: fly-autostop-config.sh <path/to/fly.toml> [stop|suspend]}"
MODE="${2:-stop}"

case "$MODE" in
  stop|suspend) ;;
  *) echo "fly-autostop-config.sh: mode must be 'stop' or 'suspend', got '$MODE'" >&2; exit 1 ;;
esac

[ -f "$SRC" ] || { echo "fly-autostop-config.sh: no such config: $SRC" >&2; exit 1; }

# Keep the generated file beside the original so anything flyctl resolves
# relative to the config's directory still resolves the same way.
OUT="${SRC%.toml}.autostop.generated.toml"

sed -E \
  -e "s|^([[:space:]]*)auto_stop_machines[[:space:]]*=.*|\1auto_stop_machines = '${MODE}'|" \
  -e "s|^([[:space:]]*)auto_start_machines[[:space:]]*=.*|\1auto_start_machines = true|" \
  -e "s|^([[:space:]]*)min_machines_running[[:space:]]*=.*|\1min_machines_running = 0|" \
  "$SRC" > "$OUT"

# Fail loudly instead of silently shipping an always-on config: if the source
# ever stops declaring one of these keys, the substitution above is a no-op.
for expected in \
  "auto_stop_machines = '${MODE}'" \
  "auto_start_machines = true" \
  "min_machines_running = 0"
do
  if ! grep -qF -- "$expected" "$OUT"; then
    echo "fly-autostop-config.sh: $SRC produced no \"$expected\" — refusing to deploy an always-on config." >&2
    exit 1
  fi
done

echo "$OUT"
