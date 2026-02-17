#!/bin/bash
# scripts/devport-env.sh - Sources .devport and exports all port env vars
# This script is sourced by dev.sh to configure port assignments

# Skip entirely in non-development environments (production, staging, CI)
if [ -n "$NODE_ENV" ] && [ "$NODE_ENV" != "development" ]; then
  echo "⏭️  Devport: skipping (NODE_ENV=$NODE_ENV)"
  return 0 2>/dev/null || exit 0
fi

if [ -f ".devport" ]; then
  source .devport
  export DEVPORT_ID
  export DEVPORT_NAME

  # Calculate ports (hook uses 4001 base to leave 4000 for fanout)
  export WEBAPP_PORT=$((3000 + DEVPORT_ID * 10))
  export HOOK_PORT=$((4001 + DEVPORT_ID * 10))
  export QUIZ_AGENT_PORT=$((6000 + DEVPORT_ID * 10))
  export SLIDES_PORT=$((6500 + DEVPORT_ID * 10))
  export PAGES_PORT=$((7100 + DEVPORT_ID * 10))

  # Export service URLs (these override .env values if needed)
  export QUIZ_AGENT_URL="http://localhost:$QUIZ_AGENT_PORT"
  export AI_AGENT_URL="http://localhost:$QUIZ_AGENT_PORT"  # Alias for new name
  export WEBAPP_URL="http://localhost:$WEBAPP_PORT"
  export HOST_URL="http://localhost:$WEBAPP_PORT"
  export BETTER_AUTH_URL="http://localhost:$WEBAPP_PORT"  # Auth must match webapp origin
  export SLIDES_URL="http://localhost:$SLIDES_PORT"
  export PAGES_URL="http://localhost:$PAGES_PORT"

  # Override DATABASE_URL with feature-specific DB
  DB_NAME="classmoji_${DEVPORT_NAME//-/_}"
  export DATABASE_URL="postgresql://classmoji:classmoji@localhost:5433/$DB_NAME"

  echo "🔌 Devport $DEVPORT_ID ($DEVPORT_NAME) active"
  echo "   Webapp: $WEBAPP_PORT | Hook: $HOOK_PORT"
  echo "   Quiz: $QUIZ_AGENT_PORT | Slides: $SLIDES_PORT | Pages: $PAGES_PORT | DB: $DB_NAME"
else
  # Default ports for main repo (ID=0)
  export WEBAPP_PORT=3000
  export HOOK_PORT=4001  # 4000 reserved for fanout
  export QUIZ_AGENT_PORT=6000
  export SLIDES_PORT=6500
  export PAGES_PORT=7100

  # Service URLs use defaults from .env
  export QUIZ_AGENT_URL="http://localhost:6000"
  export AI_AGENT_URL="http://localhost:6000"  # Alias for new name
  export WEBAPP_URL="http://localhost:3000"
  export HOST_URL="http://localhost:3000"
  export SLIDES_URL="http://localhost:6500"
  export PAGES_URL="http://localhost:7100"
fi
