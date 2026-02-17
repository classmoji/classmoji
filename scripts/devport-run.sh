#!/bin/bash
# scripts/devport-run.sh - Run a command with devport environment
# Usage: ./scripts/devport-run.sh <command>
#
# This wrapper sources devport-env.sh to set DATABASE_URL and other
# environment variables before running the specified command.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

# Source devport environment (sets DATABASE_URL, etc.)
source "$SCRIPT_DIR/devport-env.sh"

# Run the command passed as arguments
exec "$@"
