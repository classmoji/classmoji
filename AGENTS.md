# Agent Guidelines

Classmoji is a classroom management platform for CS education — instructors create classrooms with quizzes, slides, pages, modules, and assignments; students join to complete coursework and get AI-graded assessments.

## Project Structure & Module Organization

### Apps
- apps/webapp: React Router app (routes `apps/webapp/app/routes/**`, components, styles).
- apps/ai-agent: **Git submodule** (private repo `classmoji/ai-agent`). WebSocket microservice for AI features (quiz, syllabus bot, prompt assistant) (`apps/ai-agent/src/**`). Contains merged `llm` package at `apps/ai-agent/src/llm/`. Clone with `--recursive` to populate; OSS contributors can skip it.
- apps/hook-station: Webhook listener for GitHub/Stripe (`apps/hook-station/src/**`).
- apps/slides: Slide presentation app with Reveal.js editor (`apps/slides/app/**`).
- apps/site: Astro marketing/blog site (`apps/site/src/**`).

### Packages
- packages/database: Prisma schema, migrations, seed.
- ~~packages/llm~~: Merged into `apps/ai-agent/src/llm/` (no longer a separate package).
- packages/services: Shared business logic.
- packages/utils: Shared helpers.
- packages/tasks: Trigger.dev workflows (`packages/tasks/src/workflows/**`).
- packages/auth: Authentication utilities.
- packages/content: Content management utilities.
- packages/ui-components: Shared React UI components.
- packages/eslint-config: Shared ESLint configuration.

Monorepo via npm workspaces + Turbo; Node 22+ required.

## Build, Test, and Development Commands

> **CRITICAL: ALWAYS CHECK `.dev-context` BEFORE ANY DATABASE OPERATIONS!**
> Contains the ACTUAL database name, port, and service URLs. Different branches use different databases. Wrong database = data loss.
> ```bash
> cat .dev-context  # Do this FIRST before any prisma migrate, db:seed, psql, etc.
> ```

- Install: `npm install`; Init: `npm run init`
- Start DB (Docker): `npm run db:start`
- **Prisma schema** lives in `packages/database/schema.prisma` (not the default location). Migrations are in `packages/database/migrations/`. **Never use `prisma db push`** — always create proper migrations. Workflow: edit schema → `npm run db:generate` (regenerate client) → create migration → `npm run db:deploy` (apply migrations).
- Query DB: `psql "$DATABASE_URL" -c "SELECT ..."`
- All apps (concurrent dev): `npm run dev` (check `.dev-context` for ports/database after starting)
- **Dev logs**: `/tmp/classmoji-dev.log` (or `/tmp/classmoji-dev-<feature>.log` for devports)
- Web: `npm run web:dev` | build: `npm run web:build` | serve: `npm run web:start`
- AI Agent: `npm run ai-agent:dev` | `npm run ai-agent:start`
- Hooks: `npm run hook:dev` | `npm run hook:start` | tunnels: `npm run hook:github`, `npm run hook:stripe`
- Slides: `npm run slides:dev` | build: `npm run slides:build` | serve: `npm run slides:start`
- Site: `npm run site:dev`
- Trigger.dev: `npm run trigger:dev`
- Tests: `npm run test` (all) | `npm run web:test` | `npm run web:test:ui` | `npm run slides:test` | `npm run slides:test:ui` | `npm run test:ai-agent` | `npm run test:ai-agent:integration`

## Coding Style & Naming Conventions
- JavaScript/TypeScript ES Modules; 2-space indentation; semicolons; single quotes.
- React components: PascalCase filenames (e.g., `GradesTable.jsx`); hooks/utilities camelCase.
- Routes: `apps/webapp/app/routes/<route>/route.jsx` with action/loader exports inline and optional co-located `.server.js` files.
- TailwindCSS for styling where applicable.
- **Dark mode**: The app supports light and dark modes via Tailwind's `dark:` variant (class strategy). `useDarkMode.js` toggles the `dark` class on `<html>` based on OS `prefers-color-scheme`. All UI work must include both modes — use `dark:` variants for Tailwind classes (e.g., `bg-white dark:bg-gray-900`) and `.dark` parent selectors for custom CSS.

## Testing Guidelines
- Playwright for e2e/UI in `apps/webapp` and `apps/slides`.
- Specs: `apps/webapp/tests/**/*.spec.{ts,js}`, `apps/slides/tests/**/*.spec.ts`
- Run locally with `npm run web:test` or `npm run slides:test`; prefer covering core flows.

## Commit & Pull Request Guidelines
- Commits: short, imperative (e.g., "updated dark mode", "fixing trigger cli"). Subject ≤72 chars; scope when helpful: `feat(webapp): add grade settings`.
- PRs: include context/description, linked issues (`Fixes #123`), screenshots for UI changes, and test steps.

## Code Organization

### Cross-Role Route Patterns
When working on features that span admin/assistant/student routes, avoid duplicating code:
- **Re-export** where possible: assistant routes should re-export from student routes (see `assistant.$class_.quizzes/route.jsx` for the pattern)
- **Shared components** go in `apps/webapp/app/components/features/`
- **Shared business logic** goes in `packages/services` or `packages/utils`
- Check existing role routes before creating new ones — the feature may already exist under a different role prefix.

### Service Isolation
Slides, pages, and ai-agent are moving toward self-contained services. When working on these, keep code consolidated within each service rather than adding cross-app dependencies. Prefer importing from shared packages (`@classmoji/services`, `@classmoji/utils`, `@classmoji/database`) over reaching into another app's internals.

## Environments & Deployment
- Hosted on **Fly.io** with staging and production environments. Production database is on **Neon**.
- **NEVER use Neon MCP tools** unless explicitly asked to debug a production issue.
- Always work in **feature branches** — never commit to `main` or `staging` directly. The dev service won't start on main/staging branches.
- Secrets are managed in **Infisical**. When adding a new env var, also add it to:
  - `turbo.json` `globalEnv` array
  - `.env.example` (with placeholder and instructions)
  - Infisical workspace (e9a6487c-350e-41e7-8bba-2d95ca5934a6) prod environment
- **Trigger.dev deployments** are automatic via GitHub Actions when `packages/tasks/**` changes. Deployments automatically sync all secrets from Infisical `prod` environment via the `syncEnvVars` extension. Manual deployment is no longer needed unless testing locally.
- Local DB via `docker compose up -d`. Do not commit secrets or `.env`.
- `apps/ai-agent` is a git submodule (`git@github.com:classmoji/ai-agent.git`). Use `git clone --recursive` or `git submodule update --init` to populate. It may be empty for OSS contributors — that's expected.
- `@classmoji/llm` does not exist. LLM code lives in `apps/ai-agent/src/llm/` (private submodule). Public-facing exports (`getAllModels`, `examplePrompts`) are in `@classmoji/services`.
- AI features (quiz, syllabus bot, prompt assistant) are gated by `isAIAgentConfigured()` in `~/utils/aiFeatures.server.js`. When `AI_AGENT_URL` or `AI_AGENT_SHARED_SECRET` env vars are missing, AI nav items hide, settings toggles disable, and API routes return 503. Always use this guard when adding new AI-dependent features.

## Authorization Patterns
**ALL routes MUST be protected** unless explicitly marked as public. Every new loader/action needs an auth check — no exceptions.

Auth helpers are in `~/utils/routeAuth.server.js` (re-exported from `@classmoji/auth/server`). Pick the right one:
- `requireClassroomAdmin()` — admin-only routes (most `admin.$class.*` routes)
- `requireClassroomTeachingTeam()` — staff routes including assistants
- `requireStudentAccess()` — student-only routes
- `assertClassroomAccess({...})` — custom role/ownership checks (API routes, self-access patterns with `resourceOwnerId`/`selfAccessRoles`/`requireOwnership`)

All return `{ userId, classroom, membership, ... }`. Denied attempts are auto-logged.

## Architecture Overview
```
[Webapp (React Router)] ---> [packages/services] ---> [packages/database] ---> [PostgreSQL]
[Slides (React Router)] -/        |
                             [packages/utils]
                             [packages/auth]
                             [packages/content]
[AI Agent] <--- WebSocket --- [Webapp]
[Hook Station] <--- Webhooks (GitHub, Stripe)
[Site (Astro)] (standalone marketing site)
[packages/tasks] <--- Trigger.dev workflows
```
Turbo coordinates tasks across workspaces; npm workspaces handle local linking. Secrets loaded from `.env` file; DB runs via Docker locally.

## LLM & Quiz Architecture
The quiz system uses Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) for both standard and code-aware modes, centralized in `apps/ai-agent/src/llm/` (private submodule).

### Standard Quiz Mode
- Uses Agent SDK with quiz evaluation tools
- Flow: `apps/webapp/app/routes/api.quiz/route.js` → WebSocket → `apps/ai-agent` → `src/llm/` (QuizService) → Agent SDK

### Code-Aware Quiz Mode
- Uses Agent SDK with repository access + secure file tools
- Flow: webapp → WebSocket → `apps/ai-agent` → `src/llm/` → Agent SDK
- Real-time exploration steps streamed via SSE

### Quiz Evaluation
- Uses `submit_quiz_evaluation` tool with Zod schema validation (`tool()` helper from Agent SDK)
- Schema: `apps/ai-agent/src/llm/schemas/quizEvaluation.js` (single source of truth)
- Validation errors return `isError: true`, allowing Claude to self-correct

### Key Files
- **Entry point**: `import { QuizService } from '../llm/index.js'` (internal to ai-agent)
- **Agent SDK Provider**: `apps/ai-agent/src/llm/providers/agent-sdk/index.js`
- **Quiz Schema**: `apps/ai-agent/src/llm/schemas/quizEvaluation.js`
- **AI Agent WebSocket**: `apps/ai-agent/src/websocket/handlers.js`
- **Quiz Routes**: `apps/webapp/app/routes/student.$class.quizzes/`

### Quiz Focus & Time Tracking
Tracks student engagement via `total_duration_ms`, `unfocused_duration_ms`, and `modal_closed_at`:
- **Focus Hook**: `useQuizFocusMetrics.js` — tracks unfocused time via `visibilitychange` and `blur/focus`
- **Modal Close Logic**: `QuizAttemptInterface.jsx` uses `hasUserClosedModalRef` to distinguish explicit closes from React re-renders
- **Calculation**: `pct_focused = (total_duration_ms - unfocused_duration_ms) / total_duration_ms`

## Agent-Specific Instructions
- Plan first, share a short step-by-step plan, and get approval before large changes.
- **Use TaskCreate to break plans into discrete, trackable tasks** with clear subjects and descriptions. Set dependencies with `addBlockedBy` so work proceeds in the right order. Mark each task `in_progress` when starting and `completed` when done — this provides live progress visibility.
- Keep PRs incremental; prefer small, verifiable diffs with clear scope.
- Don't run `npm run dev` to test, it will already be running.
- **Test frontend changes** using Claude-in-Chrome browser tools. After making changes, open the affected page and verify both visual rendering and functionality.
- When working on the webapp, use the `react-router-framework-mode` skill if available for React Router conventions and patterns.
