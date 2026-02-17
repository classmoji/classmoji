#!/bin/bash
# scripts/init.sh - Initialize Classmoji development environment

# Colors
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
CYAN='\033[1;36m'
CLEAR='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

current_branch=$(git branch --show-current)
if [[ "$current_branch" =~ ^(main|staging)$ ]]; then
  echo -e "${YELLOW}You cannot run this script on the main or staging branch.${CLEAR}"
  exit 1
fi

echo -e "${CYAN}========================================${CLEAR}"
echo -e "${CYAN}  Classmoji Development Setup${CLEAR}"
echo -e "${CYAN}========================================${CLEAR}"
echo ""

# Step 1: Environment file setup
echo -e "${GREEN}[1/5] Environment Setup${CLEAR}"
if [ ! -f ".env" ]; then
  echo "📄 Creating .env from .env.example..."
  cp .env.example .env
  echo -e "${GREEN}✅ Created .env file${CLEAR}"
  echo ""
  echo -e "${YELLOW}⚠️  IMPORTANT: Review .env and set required values:${CLEAR}"
  echo "   - BETTER_AUTH_SECRET (generate with: openssl rand -base64 32)"
  echo "   - COOKIE_SECRET (generate with: openssl rand -hex 32)"
  echo "   - GitHub App credentials (optional, for GitHub integration)"
  echo ""
else
  echo -e "${GREEN}✅ .env file already exists${CLEAR}"
fi

# Step 2: Verify .env file
echo -e "${GREEN}[2/5] Environment Configuration${CLEAR}"
if [ -f ".env" ]; then
  echo -e "${GREEN}✅ .env file exists${CLEAR}"
  echo -e "${CYAN}ℹ️  Using local .env file for development${CLEAR}"
else
  echo -e "${RED}❌ .env file not found!${CLEAR}"
  echo "   Please create .env from .env.example first."
  exit 1
fi
echo ""

# Step 3: Webhook tunnel setup
echo -e "${GREEN}[3/5] Webhook Tunnel Setup${CLEAR}"
if ! command -v smee &> /dev/null; then
  npm install --global smee-client
  echo -e "${GREEN}✅ Smee CLI installed${CLEAR}"
else
  echo -e "${GREEN}✅ Smee CLI already installed${CLEAR}"
fi
echo ""

# Step 4: Database setup
echo -e "${GREEN}[4/5] Database Setup${CLEAR}"
echo "Starting PostgreSQL with Docker..."
docker compose down -v
docker compose up -d
echo -e "${GREEN}✅ Database started${CLEAR}"
echo ""

# Step 5: Database migration and seed
echo -e "${GREEN}[5/5] Database Migration & Seed${CLEAR}"
npm run db:generate
npm run db:deploy
npm run db:seed
echo -e "${GREEN}✅ Database initialized${CLEAR}"
echo ""

echo -e "${GREEN}========================================${CLEAR}"
echo -e "${GREEN}  🎉 Setup Complete!${CLEAR}"
echo -e "${GREEN}========================================${CLEAR}"
echo ""
echo "Next steps:"
echo "  1. Review your .env file and set required values"
echo "  2. Run: npm run dev"
echo ""
