@AGENTS.md

- During planning, to get a critique of your solution, run: 'codex exec "YOUR_QUESTION" --config model_reasoning_effort="high"'
- CRITICAL: When running database operations (migrations, seeds, queries, resets), USE the DATABASE_URL from .dev-context, not the default one. Example: `npm run db:deploy` (env vars loaded from .env automatically)

## Environment Variables
- Local development uses `.env` file (copy from `.env.example`)
- All scripts automatically load `.env` file
- Contributors use local defaults from `.env.example`
- Devport worktrees automatically copy `.env` from main repo

### Trigger.dev Secret Syncing
- Deploy-time sync from Infisical is described in AGENTS.md (Environments & Deployment); configured in `packages/tasks/trigger.config.js`.
- Requires `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` in deployment environment
- Local `trigger:dev` continues to use `.env` file (no Infisical needed)
- To update secrets in Trigger.dev: modify in Infisical → redeploy workflows