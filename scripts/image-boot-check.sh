#!/bin/bash
# scripts/image-boot-check.sh - start each server app from the files its
# production image holds, and check it answers.
#
# Each runtime image copies the root node_modules, packages/ and the app's own
# output (apps/<app>/Dockerfile). An app that imports a package npm left only
# in apps/<app>/node_modules builds, and passes every test, and then cannot
# start in its image. This script lays out each image's files in a scratch
# directory (copy-on-write clones where the file system has them), starts the
# app the way the image's CMD does, and checks its first HTTP answer.
#
# Usage: scripts/image-boot-check.sh [--skip-build] [app ...]
#   apps: webapp pages slides admin mcp hook-station collab (default: all)
#   --skip-build   use the existing apps/<app>/build output
# Environment:
#   IMAGE_CHECK_PORT  first port to use (default 19100; one per app, in order)
#   IMAGE_CHECK_WAIT  seconds to wait for each app's answer (default 180)
#   IMAGE_CHECK_DIR   scratch directory (default: a new temporary one); the
#                     staged image files are removed at the end, the logs kept
#   IMAGE_CHECK_ROOT  the checkout to check (default: the one holding this
#                     script)
#   The app's environment comes from .env (as in development) plus
#   NODE_ENV=production and its own URLs on the ports above; DATABASE_URL
#   from the caller wins over .env's.
#
# Exit status: 0 when every app answered, 1 otherwise. Logs stay in
# $IMAGE_CHECK_DIR/logs.

set -u

ROOT="${IMAGE_CHECK_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT" || exit 1

SKIP_BUILD=0
APPS=()
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    webapp | pages | slides | admin | mcp | hook-station | collab) APPS+=("$arg") ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done
[ ${#APPS[@]} -eq 0 ] && APPS=(webapp pages slides admin mcp hook-station collab)

PORT_BASE="${IMAGE_CHECK_PORT:-19100}"
WAIT="${IMAGE_CHECK_WAIT:-180}"
CALLER_DATABASE_URL="${DATABASE_URL:-}"
if [ -z "${IMAGE_CHECK_DIR:-}" ]; then
  IMAGE_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/image-boot-check.XXXXXX")"
fi
STAGE="$IMAGE_CHECK_DIR/app"
LOGS="$IMAGE_CHECK_DIR/logs"
mkdir -p "$LOGS"

APP_PID=""
cleanup() {
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null
    wait "$APP_PID" 2>/dev/null
  fi
  rm -rf "$STAGE"
}
trap cleanup EXIT

# A copy-on-write clone where the file system supports it (APFS, btrfs, XFS).
clone() {
  if cp -Rc "$1" "$2" 2>/dev/null; then return 0; fi
  rm -rf "$2"
  cp -R --reflink=auto "$1" "$2" 2>/dev/null || cp -R "$1" "$2"
}

build_script() {
  case "$1" in
    webapp) echo web:build ;;
    pages | slides | admin) echo "$1:build" ;;
  esac
}

# --- 1. builds -------------------------------------------------------------
if [ "$SKIP_BUILD" -eq 0 ]; then
  for app in "${APPS[@]}"; do
    script="$(build_script "$app")"
    [ -z "$script" ] && continue
    echo "build $app ($script)"
    if ! npm run "$script" >"$LOGS/build-$app.log" 2>&1; then
      echo "FAIL $app: build failed (see $LOGS/build-$app.log)"
      exit 1
    fi
  done
fi

# --- 2. what every image holds: root node_modules, packages/, root files ---
echo "stage $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"
clone node_modules "$STAGE/node_modules"
clone packages "$STAGE/packages"
rm -rf "$STAGE/packages/tasks/.trigger"
cp package.json package-lock.json turbo.json "$STAGE/"
mkdir -p "$STAGE/apps"

# --- 3. per app: its files, its command, its answer --------------------------
set -a
# shellcheck disable=SC1091
[ -f .env ] && . ./.env
set +a
[ -n "$CALLER_DATABASE_URL" ] && export DATABASE_URL="$CALLER_DATABASE_URL"
export NODE_ENV=production
export HOST=127.0.0.1

i=0
for app in webapp pages slides admin mcp hook-station collab; do
  export "PORT_$(echo "$app" | tr 'a-z-' 'A-Z_')=$((PORT_BASE + i))"
  i=$((i + 1))
done
export WEBAPP_URL="http://127.0.0.1:$PORT_WEBAPP"
export PAGES_URL="http://127.0.0.1:$PORT_PAGES"
export SLIDES_URL="http://127.0.0.1:$PORT_SLIDES"
export ADMIN_URL="http://127.0.0.1:$PORT_ADMIN"
export MCP_PUBLIC_URL="http://127.0.0.1:$PORT_MCP"
export COLLAB_URL="http://127.0.0.1:$PORT_COLLAB"
export COLLAB_WS_URL="ws://127.0.0.1:$PORT_COLLAB"
export COLLAB_INTERNAL_SECRET="${COLLAB_INTERNAL_SECRET:-image-boot-check-secret}"
# Required to be set in production; nothing is sent to Trigger.dev at start.
export TRIGGER_SECRET_KEY="${TRIGGER_SECRET_KEY:-tr_dev_image_boot_check}"

FAILED=()
for app in "${APPS[@]}"; do
  var="PORT_$(echo "$app" | tr 'a-z-' 'A-Z_')"
  port="${!var}"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "FAIL $app: port $port is already in use"
    FAILED+=("$app")
    continue
  fi

  # The files the image copies for this app (its Dockerfile's runtime stage).
  workdir="$STAGE"
  health=/health
  case "$app" in
    webapp)
      clone apps/webapp/build "$STAGE/build"
      cmd=(./node_modules/.bin/react-router-serve build/server/index.js)
      ;;
    pages | admin)
      mkdir -p "$STAGE/apps/$app"
      clone "apps/$app/build" "$STAGE/apps/$app/build"
      clone "apps/$app/server" "$STAGE/apps/$app/server"
      cp "apps/$app/server.ts" "apps/$app/package.json" "$STAGE/apps/$app/"
      workdir="$STAGE/apps/$app"
      cmd=(node --experimental-strip-types server.ts)
      ;;
    slides)
      mkdir -p "$STAGE/apps/slides"
      clone apps/slides/build "$STAGE/apps/slides/build"
      cp apps/slides/server.ts apps/slides/package.json "$STAGE/apps/slides/"
      workdir="$STAGE/apps/slides"
      cmd=(node --experimental-strip-types server.ts)
      ;;
    mcp | hook-station | collab)
      clone "apps/$app" "$STAGE/apps/$app"
      rm -rf "$STAGE/apps/$app/build"
      cmd=(node --experimental-strip-types "apps/$app/src/index.ts")
      [ "$app" = hook-station ] && health=/
      ;;
  esac

  log="$LOGS/$app.log"
  echo "start $app on :$port"
  (
    cd "$workdir" || exit 1
    PORT="$port" MCP_PORT="$port" COLLAB_PORT="$port" \
      NODE_OPTIONS="$([ "$app" = mcp ] && echo --max-old-space-size=384)" \
      exec "${cmd[@]}"
  ) >"$log" 2>&1 &
  APP_PID=$!

  status=""
  for _ in $(seq 1 "$WAIT"); do
    if ! kill -0 "$APP_PID" 2>/dev/null; then break; fi
    status="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$port$health" || true)"
    [ -n "$status" ] && [ "$status" != "000" ] && break
    sleep 1
  done

  if [ -n "$status" ] && [ "$status" != "000" ] && [ "$status" -lt 500 ]; then
    echo "PASS $app: GET $health -> $status"
  else
    echo "FAIL $app: no answer below 500 from GET $health (got '${status:-none}'); last lines of $log:"
    tail -n 15 "$log" | sed 's/^/    /'
    FAILED+=("$app")
  fi

  if kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null
    wait "$APP_PID" 2>/dev/null
  fi
  APP_PID=""

  # Leave the stage as the next image starts from: shared files only.
  rm -rf "$STAGE/build" "$STAGE/apps"/*
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "image boot check: FAILED (${FAILED[*]})"
  exit 1
fi
echo "image boot check: all ${#APPS[@]} started"
