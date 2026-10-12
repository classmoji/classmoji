@AGENTS.md

- During planning, to get a critique of your solution, run: 'codex exec "YOUR_QUESTION" --config model_reasoning_effort="high"'
- CRITICAL: When running database operations (migrations, seeds, queries, resets), USE the DATABASE_URL from .dev-context, not the default one. Example: `npm run db:deploy` (env vars loaded from .env automatically)

## Every new feature must
1. **Not leak data across users or classrooms.** Scope every read and write by ids the server derived (session user, the page/resource row's own classroom), never by ids the client sent. One user's state is returned only to that user; staff views are limited to their own classroom and its current members. Cover it with tests that try user A vs B and classroom X vs Y.
2. **Audit-log its actions.** Every action that changes data, and every read of other people's data (staff views of student activity), writes an audit row through `ClassmojiService.audit` with a `data.tool` naming the surface. A user reading their own state on a normal page load is not logged.
3. **Have MCP parity.** Whatever a role can do or see in the UI, the MCP offers the same role, with the same gates and redaction, in `apps/mcp`. Annotate every tool (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`); anything irreversible, or that creates a permanent record about the user (e.g. unlocking a locked section), is `destructiveHint: true` so clients ask for confirmation.

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