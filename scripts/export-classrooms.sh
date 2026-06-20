#!/usr/bin/env bash
#
# export-classrooms.sh
#
# Export GitHub Classroom data locally using the GitHub CLI.
# Produces JSON files for classrooms, assignments, and accepted assignments,
# plus CSV grade reports for each assignment.
#
# Prerequisites:
#   1. GitHub CLI (gh) — https://cli.github.com/
#   2. GitHub Classroom CLI extension — gh extension install github/gh-classroom
#   3. jq — https://jqlang.github.io/jq/
#   4. Authenticated with `gh auth login`
#
# Usage:
#   chmod +x export-classrooms.sh
#   ./export-classrooms.sh                # export all classrooms
#   ./export-classrooms.sh -c 12345       # export a single classroom by ID
#   ./export-classrooms.sh -o ./my-export # custom output directory

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
OUTPUT_DIR="classroom-export-$(date +%Y%m%d-%H%M%S)"
CLASSROOM_ID=""
PER_PAGE=100

# ── Parse arguments ──────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Export GitHub Classroom data (classrooms, assignments, accepted assignments,
and grades) to a local directory.

Options:
  -c, --classroom-id ID   Export only the classroom with this ID
  -o, --output DIR        Output directory (default: classroom-export-<timestamp>)
  -h, --help              Show this help message

Prerequisites:
  - gh (GitHub CLI)            https://cli.github.com/
  - gh-classroom extension     gh extension install github/gh-classroom
  - jq                         https://jqlang.github.io/jq/

Examples:
  $(basename "$0")                     # export all classrooms
  $(basename "$0") -c 12345            # export one classroom
  $(basename "$0") -o ./my-export      # custom output directory
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--classroom-id) CLASSROOM_ID="$2"; shift 2 ;;
    -o|--output)       OUTPUT_DIR="$2";   shift 2 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

# ── Preflight checks ─────────────────────────────────────────────────────────
check_dependency() {
  if ! command -v "$1" &>/dev/null; then
    echo "Error: '$1' is required but not installed." >&2
    echo "       $2" >&2
    exit 1
  fi
}

check_dependency gh   "Install from https://cli.github.com/"
check_dependency jq   "Install from https://jqlang.github.io/jq/"

if ! gh auth status &>/dev/null; then
  echo "Error: Not authenticated with GitHub CLI. Run 'gh auth login' first." >&2
  exit 1
fi

if ! gh classroom --help &>/dev/null; then
  echo "Error: gh-classroom extension is not installed." >&2
  echo "       Run: gh extension install github/gh-classroom" >&2
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

# Paginate a gh api endpoint and merge all JSON array pages into one array.
paginate_api() {
  local endpoint="$1"
  local page=1
  local all="[]"

  while true; do
    local sep="?"
    [[ "$endpoint" == *"?"* ]] && sep="&"

    local url
    url="${endpoint}${sep}page=${page}&per_page=${PER_PAGE}"
    local response
    response="$(gh api "$url" 2>/dev/null)" || break

    # Stop when an empty array is returned
    local count
    count="$(echo "$response" | jq 'length')"
    if [[ "$count" -eq 0 ]]; then
      break
    fi

    all="$(echo "$all" "$response" | jq -s '.[0] + .[1]')"
    page=$((page + 1))
  done

  echo "$all"
}

# ── Fetch classrooms ─────────────────────────────────────────────────────────
echo "==> Fetching classrooms …"
if [[ -n "$CLASSROOM_ID" ]]; then
  # Wrap single classroom in an array for uniform processing
  CLASSROOMS="$(gh api "classrooms/${CLASSROOM_ID}" | jq '[.]')"
else
  CLASSROOMS="$(paginate_api "classrooms")"
fi

CLASSROOM_COUNT="$(echo "$CLASSROOMS" | jq 'length')"

if [[ "$CLASSROOM_COUNT" -eq 0 ]]; then
  echo "No classrooms found."
  exit 0
fi

echo "    Found ${CLASSROOM_COUNT} classroom(s)."

# ── Create output directory ──────────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"
echo "$CLASSROOMS" | jq '.' > "${OUTPUT_DIR}/classrooms.json"
echo "    Saved classrooms.json"

# ── Iterate classrooms ───────────────────────────────────────────────────────
echo "$CLASSROOMS" | jq -c '.[]' | while IFS= read -r classroom; do
  cr_id="$(echo "$classroom" | jq -r '.id')"
  cr_name="$(echo "$classroom" | jq -r '.name')"
  cr_dir="${OUTPUT_DIR}/classroom-${cr_id}"
  mkdir -p "$cr_dir"

  echo ""
  echo "==> Classroom: ${cr_name} (ID: ${cr_id})"

  # Save classroom detail
  gh api "classrooms/${cr_id}" | jq '.' > "${cr_dir}/classroom.json"
  echo "    Saved classroom.json"

  # ── Fetch assignments ────────────────────────────────────────────────────
  echo "    Fetching assignments …"
  ASSIGNMENTS="$(paginate_api "classrooms/${cr_id}/assignments")"
  ASSIGNMENT_COUNT="$(echo "$ASSIGNMENTS" | jq 'length')"
  echo "$ASSIGNMENTS" | jq '.' > "${cr_dir}/assignments.json"
  echo "    Saved assignments.json (${ASSIGNMENT_COUNT} assignment(s))"

  if [[ "$ASSIGNMENT_COUNT" -eq 0 ]]; then
    continue
  fi

  # ── Iterate assignments ──────────────────────────────────────────────────
  echo "$ASSIGNMENTS" | jq -c '.[]' | while IFS= read -r assignment; do
    a_id="$(echo "$assignment" | jq -r '.id')"
    a_title="$(echo "$assignment" | jq -r '.title')"
    a_dir="${cr_dir}/assignment-${a_id}"
    mkdir -p "$a_dir"

    echo ""
    echo "    ── Assignment: ${a_title} (ID: ${a_id})"

    # Save assignment detail
    gh api "assignments/${a_id}" | jq '.' > "${a_dir}/assignment.json"
    echo "       Saved assignment.json"

    # Accepted assignments
    echo "       Fetching accepted assignments …"
    ACCEPTED="$(paginate_api "assignments/${a_id}/accepted_assignments")"
    ACCEPTED_COUNT="$(echo "$ACCEPTED" | jq 'length')"
    echo "$ACCEPTED" | jq '.' > "${a_dir}/accepted-assignments.json"
    echo "       Saved accepted-assignments.json (${ACCEPTED_COUNT} submission(s))"

    # Grades (CSV)
    echo "       Fetching grades …"
    GRADES_FILE="${a_dir}/grades.csv"
    if gh classroom assignment-grades -a "$a_id" -f "$GRADES_FILE" 2>/dev/null; then
      echo "       Saved grades.csv"
    else
      echo "       No grades available for this assignment."
    fi
  done
done

echo ""
echo "✅ Export complete → ${OUTPUT_DIR}/"