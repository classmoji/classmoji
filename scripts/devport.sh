#!/bin/bash
# scripts/devport.sh - Manage parallel development environments with git worktrees
#
# Usage:
#   ./scripts/devport.sh create <feature-name> [port-id]   # Create new worktree + DB
#   ./scripts/devport.sh list                              # List all devport worktrees
#   ./scripts/devport.sh delete <feature-name>             # Remove worktree + DB
#   ./scripts/devport.sh sync-settings <feature-name>      # Copy .claude/ from worktree to main
#   ./scripts/devport.sh env                               # Print current devport env vars
#   ./scripts/devport.sh run <command>                     # Run command with devport env

set -e

# Colors
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
CYAN='\033[1;36m'
CLEAR='\033[0m'

# Get directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PARENT_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
PROJECT_NAME="$(basename "$PROJECT_DIR")"

# PostgreSQL connection
PG_USER="classmoji"
PG_PASS="classmoji"
PG_MAIN_DB="classmoji"
PG_CONTAINER="classmoji-postgres"

# Helper: run psql command inside Docker container
run_psql() {
  docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" "$@"
}

# Helper: run pg_dump inside Docker container
run_pg_dump() {
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" "$@"
}

# Helper: check if port ID is in use
is_port_id_in_use() {
  local port_id=$1
  for dir in "$PARENT_DIR"/${PROJECT_NAME}-*/; do
    if [ -f "$dir/.devport" ]; then
      local existing_id=$(grep "DEVPORT_ID=" "$dir/.devport" | cut -d= -f2)
      if [ "$existing_id" = "$port_id" ]; then
        echo "$dir"
        return 0
      fi
    fi
  done
  return 1
}

# Helper: find next available port ID (1-9)
find_next_port_id() {
  for id in {1..9}; do
    if ! is_port_id_in_use "$id" > /dev/null; then
      echo "$id"
      return 0
    fi
  done
  return 1
}

# Helper: sanitize feature name for DB (replace - with _)
sanitize_db_name() {
  echo "$1" | tr '-' '_'
}

# Command: create
cmd_create() {
  local feature_name=$1
  local port_id=$2

  if [ -z "$feature_name" ]; then
    echo -e "${RED}Usage: $0 create <feature-name> [port-id]${CLEAR}"
    echo -e "  feature-name: Name of the feature (e.g., auth-refactor)"
    echo -e "  port-id: Optional number 1-9 for port offset (auto-assigned if not provided)"
    exit 1
  fi

  # Auto-assign port ID if not provided
  if [ -z "$port_id" ]; then
    port_id=$(find_next_port_id)
    if [ -z "$port_id" ]; then
      echo -e "${RED}Error: No available port IDs (1-9 are all in use)${CLEAR}"
      exit 1
    fi
    echo -e "${CYAN}Auto-assigned port ID: $port_id${CLEAR}"
  else
    # Validate manually provided port ID
    if ! [[ "$port_id" =~ ^[1-9]$ ]]; then
      echo -e "${RED}Error: port-id must be a number between 1 and 9${CLEAR}"
      exit 1
    fi

    # Check if port ID is already in use
    local existing_dir=$(is_port_id_in_use "$port_id")
    if [ -n "$existing_dir" ]; then
      echo -e "${RED}Error: Port ID $port_id is already in use by: $existing_dir${CLEAR}"
      exit 1
    fi
  fi

  # Calculate paths and names
  local worktree_dir="$PARENT_DIR/${PROJECT_NAME}-${feature_name}"
  local db_name="${PG_MAIN_DB}_$(sanitize_db_name "$feature_name")"
  local branch_name="$feature_name"

  # Check if worktree already exists
  if [ -d "$worktree_dir" ]; then
    echo -e "${RED}Error: Directory already exists: $worktree_dir${CLEAR}"
    exit 1
  fi

  echo -e "${CYAN}Creating devport environment for: $feature_name (ID: $port_id)${CLEAR}"
  echo ""

  # Step 1: Create git worktree
  echo -e "${GREEN}[1/7] Creating git worktree...${CLEAR}"
  cd "$PROJECT_DIR"
  git worktree add "$worktree_dir" -b "$branch_name" 2>/dev/null || \
    git worktree add "$worktree_dir" "$branch_name"
  echo -e "  ✅ Created: $worktree_dir"

  # Step 2: Copy .env file
  echo -e "${GREEN}[2/8] Copying .env file...${CLEAR}"
  if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo -e "${RED}Error: No .env file found in main repo${CLEAR}"
    echo -e "Run 'npm run init' first to create .env"
    exit 1
  fi
  cp "$PROJECT_DIR/.env" "$worktree_dir/.env"
  echo -e "  ✅ Copied .env from main repo"
  echo ""

  # Step 3: Copy Claude settings (Claude Code can't follow symlinks)
  echo -e "${GREEN}[3/8] Copying Claude settings...${CLEAR}"
  if [ -d "$PROJECT_DIR/.claude" ]; then
    cp -R "$PROJECT_DIR/.claude" "$worktree_dir/.claude"
    echo -e "  ✅ Copied .claude/ from main repo"
  else
    echo -e "  ${YELLOW}⚠️  No .claude directory in main repo, skipping${CLEAR}"
  fi

  # Step 4: Create database
  echo -e "${GREEN}[4/8] Creating database...${CLEAR}"
  if run_psql -d postgres -lqt | cut -d \| -f 1 | grep -qw "$db_name"; then
    echo -e "${YELLOW}  ⚠️  Database $db_name already exists, dropping...${CLEAR}"
    run_psql -d postgres -c "DROP DATABASE \"$db_name\";"
  fi
  run_psql -d postgres -c "CREATE DATABASE \"$db_name\";"
  echo -e "  ✅ Created database: $db_name"

  # Step 5: Copy data from main database
  echo -e "${GREEN}[5/8] Copying data from main database...${CLEAR}"
  run_pg_dump "$PG_MAIN_DB" | run_psql -d "$db_name" -q
  echo -e "  ✅ Copied data from $PG_MAIN_DB"

  # Step 6: Write .devport file
  echo -e "${GREEN}[6/8] Writing .devport file...${CLEAR}"
  cat > "$worktree_dir/.devport" << EOF
# Devport configuration - do not edit manually
DEVPORT_ID=$port_id
DEVPORT_NAME=$feature_name
EOF
  echo -e "  ✅ Created .devport file"

  # Step 7: Run npm install
  echo -e "${GREEN}[7/8] Installing dependencies (this may take a minute)...${CLEAR}"
  cd "$worktree_dir"
  npm install --silent
  echo -e "  ✅ Dependencies installed"

  # Step 8: Generate Prisma client
  echo -e "${GREEN}[8/8] Generating Prisma client...${CLEAR}"
  npm run db:generate --silent
  echo -e "  ✅ Prisma client generated"

  # Calculate and display port assignments
  local webapp_port=$((3000 + port_id * 10))
  local api_port=$((5000 + port_id * 10))
  local hook_port=$((4001 + port_id * 10))
  local quiz_port=$((6000 + port_id * 10))
  local slides_port=$((6500 + port_id * 10))

  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════════════════${CLEAR}"
  echo -e "${GREEN}✅ Devport environment created successfully!${CLEAR}"
  echo -e "${GREEN}═══════════════════════════════════════════════════════════${CLEAR}"
  echo ""
  echo -e "${CYAN}Worktree:${CLEAR}  $worktree_dir"
  echo -e "${CYAN}Branch:${CLEAR}    $branch_name"
  echo -e "${CYAN}Database:${CLEAR}  $db_name"
  echo ""
  echo -e "${CYAN}Port assignments:${CLEAR}"
  echo -e "  Webapp:     http://localhost:$webapp_port"
  echo -e "  API:        http://localhost:$api_port"
  echo -e "  Hook:       http://localhost:$hook_port"
  echo -e "  Quiz Agent: http://localhost:$quiz_port"
  echo -e "  Slides:     http://localhost:$slides_port"
  echo ""
  echo -e "${YELLOW}To start developing:${CLEAR}"
  echo -e "  cd $worktree_dir"
  echo -e "  npm run dev"
  echo ""
}

# Command: list
cmd_list() {
  echo -e "${CYAN}Devport environments:${CLEAR}"
  echo ""

  # Check main repo
  if [ -f "$PROJECT_DIR/.devport" ]; then
    source "$PROJECT_DIR/.devport"
    echo -e "  ${GREEN}●${CLEAR} $PROJECT_DIR (ID: $DEVPORT_ID, $DEVPORT_NAME)"
  else
    echo -e "  ${GREEN}●${CLEAR} $PROJECT_DIR (main, ID: 0)"
  fi

  # Check worktrees
  local found=false
  for dir in "$PARENT_DIR"/${PROJECT_NAME}-*/; do
    if [ -d "$dir" ] && [ -f "$dir/.devport" ]; then
      found=true
      source "$dir/.devport"
      local db_name="${PG_MAIN_DB}_$(sanitize_db_name "$DEVPORT_NAME")"
      echo -e "  ${CYAN}●${CLEAR} $dir (ID: $DEVPORT_ID, DB: $db_name)"
    fi
  done

  if [ "$found" = false ]; then
    echo -e "  ${YELLOW}No devport worktrees found${CLEAR}"
  fi

  echo ""
}

# Command: delete
cmd_delete() {
  local feature_name=$1

  if [ -z "$feature_name" ]; then
    echo -e "${RED}Usage: $0 delete <feature-name>${CLEAR}"
    exit 1
  fi

  local worktree_dir="$PARENT_DIR/${PROJECT_NAME}-${feature_name}"
  local db_name="${PG_MAIN_DB}_$(sanitize_db_name "$feature_name")"
  local branch_name="$feature_name"
  local branch_exists=false

  if [ ! -d "$worktree_dir" ]; then
    echo -e "${RED}Error: Worktree not found: $worktree_dir${CLEAR}"
    exit 1
  fi

  # Check if branch exists
  if git show-ref --verify --quiet "refs/heads/$branch_name"; then
    branch_exists=true
  fi

  echo -e "${YELLOW}This will delete:${CLEAR}"
  echo -e "  Worktree: $worktree_dir"
  echo -e "  Database: $db_name"
  echo ""
  read -p "Are you sure? (y/N) " -n 1 -r
  echo ""

  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi

  # Remove worktree
  echo -e "${GREEN}Removing git worktree...${CLEAR}"
  cd "$PROJECT_DIR"
  git worktree remove "$worktree_dir" --force 2>/dev/null || rm -rf "$worktree_dir"

  # Drop database
  echo -e "${GREEN}Dropping database...${CLEAR}"
  if run_psql -d postgres -lqt | cut -d \| -f 1 | grep -qw "$db_name"; then
    run_psql -d postgres -c "DROP DATABASE \"$db_name\";"
    echo -e "  ✅ Dropped database: $db_name"
  else
    echo -e "  ${YELLOW}Database $db_name not found (already deleted?)${CLEAR}"
  fi

  # Offer to delete the local branch
  if [ "$branch_exists" = true ]; then
    echo ""
    echo -e "${YELLOW}Local branch '$branch_name' still exists.${CLEAR}"
    read -p "Delete it too? (y/N) " -n 1 -r delete_branch
    echo ""
    if [[ $delete_branch =~ ^[Yy]$ ]]; then
      git branch -D "$branch_name"
      echo -e "  ✅ Deleted branch: $branch_name"
    else
      echo -e "  ${CYAN}Keeping branch: $branch_name${CLEAR}"
    fi
  fi

  echo ""
  echo -e "${GREEN}✅ Devport environment deleted${CLEAR}"
}

# Command: sync-settings - Copy .claude from worktree back to main
cmd_sync_settings() {
  local feature_name=$1

  if [ -z "$feature_name" ]; then
    echo -e "${RED}Usage: $0 sync-settings <feature-name>${CLEAR}"
    echo -e "  Copies .claude/ from the worktree back to main repo"
    exit 1
  fi

  local worktree_dir="$PARENT_DIR/${PROJECT_NAME}-${feature_name}"

  if [ ! -d "$worktree_dir" ]; then
    echo -e "${RED}Error: Worktree not found: $worktree_dir${CLEAR}"
    exit 1
  fi

  if [ ! -d "$worktree_dir/.claude" ]; then
    echo -e "${YELLOW}No .claude directory in worktree, nothing to sync${CLEAR}"
    exit 0
  fi

  echo -e "${CYAN}Syncing .claude settings from $feature_name to main...${CLEAR}"
  rm -rf "$PROJECT_DIR/.claude"
  cp -R "$worktree_dir/.claude" "$PROJECT_DIR/.claude"
  echo -e "${GREEN}✅ Synced .claude/ from $feature_name to main repo${CLEAR}"
}

# Command: env
cmd_env() {
  source "$SCRIPT_DIR/devport-env.sh"
  echo ""
  echo -e "${CYAN}Environment variables:${CLEAR}"
  echo "  WEBAPP_PORT=$WEBAPP_PORT"
  echo "  API_PORT=$API_PORT"
  echo "  HOOK_PORT=$HOOK_PORT"
  echo "  QUIZ_AGENT_PORT=$QUIZ_AGENT_PORT"
  echo "  SLIDES_PORT=$SLIDES_PORT"
  echo "  WEBAPP_URL=$WEBAPP_URL"
  echo "  QUIZ_AGENT_URL=$QUIZ_AGENT_URL"
  echo "  SLIDES_URL=$SLIDES_URL"
  if [ -f ".devport" ]; then
    source .devport
    echo "  DATABASE_URL=postgresql://classmoji:classmoji@localhost:5433/classmoji_$(sanitize_db_name "$DEVPORT_NAME")"
  else
    echo "  DATABASE_URL=postgresql://classmoji:classmoji@localhost:5433/classmoji"
  fi
  echo ""
}

# Command: run - Execute a command with devport environment
cmd_run() {
  if [ $# -eq 0 ]; then
    echo -e "${RED}Usage: $0 run <command>${CLEAR}"
    echo -e "  Runs the command with devport environment variables set"
    exit 1
  fi

  # Source devport environment (sets DATABASE_URL, ports, etc.)
  source "$SCRIPT_DIR/devport-env.sh"

  # Execute the command
  exec "$@"
}

# Main
case "${1:-}" in
  create)
    cmd_create "$2" "$3"
    ;;
  list)
    cmd_list
    ;;
  delete)
    cmd_delete "$2"
    ;;
  env)
    cmd_env
    ;;
  run)
    shift  # Remove 'run' from arguments
    cmd_run "$@"
    ;;
  sync-settings)
    cmd_sync_settings "$2"
    ;;
  *)
    echo -e "${CYAN}Devport - Parallel Development Environment Manager${CLEAR}"
    echo ""
    echo "Usage:"
    echo "  $0 create <feature-name> [port-id]   Create new worktree + DB"
    echo "  $0 list                              List all devport worktrees"
    echo "  $0 delete <feature-name>             Remove worktree + DB"
    echo "  $0 sync-settings <feature-name>      Copy .claude/ from worktree to main"
    echo "  $0 env                               Print current devport env vars"
    echo "  $0 run <command>                     Run command with devport env"
    echo ""
    echo "Examples:"
    echo "  $0 create auth-refactor       # Auto-assigns next available port ID"
    echo "  $0 create dark-mode 3         # Use specific port ID"
    echo "  $0 list"
    echo "  $0 delete auth-refactor"
    echo "  $0 sync-settings my-feature   # Bring .claude changes back to main"
    echo "  $0 run npm run db:seed        # Run db:seed with devport DATABASE_URL"
    ;;
esac
