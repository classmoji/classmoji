#!/bin/bash

# Check if running on protected branches and prompt for confirmation

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

if [ "$BRANCH" = "staging" ] || [ "$BRANCH" = "main" ]; then
  echo ""
  echo -e "⚠️  You are on the \033[1;33m$BRANCH\033[0m branch!"
  echo ""
  read -p "Are you sure you want to run dev? (y/N) " -n 1 -r
  echo ""

  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

exit 0
