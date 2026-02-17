@AGENTS.md

- During planning, to get a critique of your solution, run: 'codex exec "YOUR_QUESTION" --config model_reasoning_effort="high"'
- always double check .dev-context for database info
- CRITICAL: When running database operations (migrations, seeds, queries, resets), USE the DATABASE_URL from .dev-context, not the default one. Example: `npm run db:deploy` (env vars loaded from .env automatically)

## Environment Variables
- Local development uses `.env` file (copy from `.env.example`)
- All scripts automatically load `.env` file
- Contributors use local defaults from `.env.example`
- Devport worktrees automatically copy `.env` from main repo

### Trigger.dev Secret Syncing
- Trigger.dev deployments automatically sync secrets from Infisical
- Configured in `packages/tasks/trigger.config.js` via `syncEnvVars` extension
- Currently uses `prod` environment for all Trigger.dev deployments
- Requires `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` in deployment environment
- Local `trigger:dev` continues to use `.env` file (no Infisical needed)
- To update secrets in Trigger.dev: modify in Infisical → redeploy workflows