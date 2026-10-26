# Agent Guidelines

Classmoji is a classroom management platform for CS education. Instructors create classrooms with quizzes, slides, pages, modules, and assignments; students join to complete coursework and get AI-graded assessments.

## Project Structure & Module Organization

### Apps
- apps/webapp: React Router app (routes `apps/webapp/app/routes/**`, components, styles).
  - Feedback board (`/feedback`, `ClassmojiService.feedback`): platform-wide, no classroom; anyone reads, signed-in users post (category FEATURE/BUG/INTEGRATION), comment, vote and follow, and delete their own posts and comments; platform admins set status and delete anything. It writes NO audit rows, on the web or the MCP (decided for #739). The MCP has three tools, `feedback_read`, `feedback_write` and `feedback_delete` (own posts and comments only), each surface with its own rate limits from `FEEDBACK_RATE_LIMITS`.
- apps/ai-agent: **Git submodule** (private repo `classmoji/ai-agent`). WebSocket microservice for AI features (quiz, syllabus bot) (`apps/ai-agent/src/**`). Contains merged `llm` package at `apps/ai-agent/src/llm/`. Also holds the chat agents' Trigger.dev tasks (`src/trigger/`: the quiz's `quiz-attempt` and `explore-repo`, and Ask Moji's `ask-moji`), deployed by the `packages/tasks` Trigger project through `packages/tasks/src/private-agents/` (it re-exports `@classmoji/ai-agent/trigger`; `trigger.config.js` includes that directory only when `apps/ai-agent/src/trigger/index.ts` exists). Without the submodule those tasks are absent (quiz chat and Ask Moji on Trigger are unavailable; `QUIZ_TRIGGER_RUNTIME` and `ASK_MOJI_RUNTIME` default off) and a Trigger deploy refuses to build. Clone with `--recursive` to populate; OSS contributors can skip it.
- apps/hook-station: Webhook listener for GitHub/Stripe (`apps/hook-station/src/**`). GitHub events (`src/routes/github.ts`): `push` on student repos (REPO-mode submissions) and content repos (asset sync), `issues.closed` / `issues.reopened` / `issues.deleted` (ISSUE-mode submissions), `organization.member_added`, `installation.*`. See `apps/hook-station/README.md`.
  - Live-editing push rule: on a content-repo push for a classroom with `collab_enabled` (or leftover `collab_docs` rows), every changed `content.json`/`deck.json` NOT written by the checkpoint worker (Bot sender + `Classmoji-Collab:` trailer, or `collab_docs.pushed_commit` == push head unless forced) triggers `collab-external`, so collab merges the outside change instead of overwriting it at the next checkpoint (`src/collabExternal.ts`).
- apps/collab (`@classmoji/collab-server`): Hocuspocus 4.7 server for live co-editing of pages and decks in classrooms with `Classroom.collab_enabled`. Browsers connect over WebSocket (`COLLAB_WS_URL`, session cookie); webapp/pages/slides/MCP/Trigger tasks call its internal HTTP API (`${COLLAB_URL}/internal/*`, header `x-collab-secret: $COLLAB_INTERNAL_SECRET`, `src/internal.ts`). **Single instance only** (open rooms live in its memory; Fly app `classmoji-collab`, one machine, never scaled to zero). Edits reach git only through the `content-checkpoint` task. See `apps/collab/README.md`.
- apps/slides: Slide presentation app with Reveal.js editor (`apps/slides/app/**`).
- apps/site: Astro marketing/blog site (`apps/site/src/**`).
- apps/admin: Platform-admin app (`apps/admin/app/**`). Cross-classroom user search + account impersonation via better-auth's admin plugin. Access is gated on `PLATFORM_ADMIN_USER_IDS` (comma-separated `User.id`s) — empty means nobody, and the app 403s. Separate origin from the webapp; sessions are shared through the cookie, not passed.

### Packages
- packages/collab (`@classmoji/collab`): shared, isomorphic pieces of live editing — room names/epochs, deck Y.Doc ⇄ `Deck` conversion, lock helpers, internal-API types, `itemHash` (`/hash`, Node only). `@classmoji/collab/env` (server-only) resolves `COLLAB_URL`/`COLLAB_WS_URL`/`COLLAB_INTERNAL_SECRET` the same way for every service.
- packages/page-schema (`@classmoji/page-schema`): BlockNote block configs for every custom page block (no React/DOM), `SCHEMA_VERSION` (bump on any block config change; clients on another version are refused) and the server-side editor (`/server`) the collab server and checkpoint worker render with. `apps/pages` attaches its React renderers to these configs.
  - Page sections: a heading with `checkable: true` can be ticked done per reader (`page_section_checks`), and so can a `checkListItem` with `personal: true` (a student check list: same table, POST and MCP tool; `isCheckTarget` in `@classmoji/page-schema/sections`; no staff chip, counts only via `page_sections_status`); a `lockedSection` block (title prop, body = children) shows readers its title only until they unlock it (`page_section_unlocks`, permanent). Teaching staff and page editors always get the body. Every read path that hands page content to a non-staff reader must run `redactLockedSections` (`@classmoji/page-schema/sections`) first: today the pages loader, the class site (`renderPageForViewer`), the search extractor (title only, for everyone), MCP `content_get`/`page_section_*`, and the slides `/content/` route refuses page documents. A new read path that skips it serves locked bodies. Per-reader state is `ClassmojiService.pageSections`; who sees and may do what (reveal all, unlock, see others' activity, open a draft) is its `sectionViewer`, the one rule the pages loader, `/api/page-sections` and the MCP tools all read. Check/unlock follow the classroom entry rule, not the mutation rule (allowed while LOCKED; MCP tools set `readerState: true`).
- packages/ui-components: Shared React UI components, plus the shared design system in `packages/ui-components/styles/` (`theme.css` Tailwind `@theme`, `tokens.css` raw CSS vars, `fonts.css`, `components.css` for `.btn`/`.card`/`.chip`). The webapp, slides, and admin all import from here — do NOT fork these into an app. Note `html { font-size: 17px }` and the `@fontsource-variable/mona-sans` import are per-app and must be repeated.

Monorepo via npm workspaces + Turbo; Node 22+ required.

## Build, Test, and Development Commands

> **CRITICAL: ALWAYS CHECK `.dev-context` BEFORE ANY DATABASE OPERATIONS!**
> Contains the ACTUAL database name, port, and service URLs. Different branches use different databases. Wrong database = data loss.
> ```bash
> cat .dev-context  # Do this FIRST before any prisma migrate, db:seed, psql, etc.
> ```

- Install: `npm install`; Init: `npm run init`
- Start DB (Docker): `npm run db:start` (postgres only; works without the ai-agent submodule)
- Start ai-agent container (requires submodule): `npm run ai-agent:docker`
- **Prisma schema** lives in `packages/database/schema.prisma` (not the default location). Migrations are in `packages/database/migrations/`. **Never use `prisma db push`** — always create proper migrations. Workflow: edit schema → `npm run db:generate` (regenerate client) → create migration → `npm run db:deploy` (apply migrations).
- Query DB: `psql "$DATABASE_URL" -c "SELECT ..."`
- All apps (concurrent dev): `npm run dev` (check `.dev-context` for ports/database after starting)
- **Dev logs**: `/tmp/classmoji-dev.log` (or `/tmp/classmoji-dev-<feature>.log` for devports)
- Per-app dev/build/start/test scripts (`web:*`, `slides:*`, `hook:*`, `ai-agent:*`, `site:dev`, `trigger:dev`, `test`) are in the root `package.json`.

## Coding Style & Naming Conventions
- Formatting is enforced by `.prettierrc` and `eslint.config.js`.
- Routes: `apps/webapp/app/routes/<route>/route.jsx` with action/loader exports inline and optional co-located `.server.js` files.
- TailwindCSS for styling where applicable.
- **Dark mode**: The app supports light and dark modes via Tailwind's `dark:` variant (class strategy). `useDarkMode.js` toggles the `dark` class on `<html>` based on OS `prefers-color-scheme`. All UI work must include both modes — use `dark:` variants for Tailwind classes (e.g., `bg-white dark:bg-gray-900`) and `.dark` parent selectors for custom CSS.

## Commit & Pull Request Guidelines
- Commits: short, imperative (e.g., "updated dark mode", "fixing trigger cli"). Subject ≤72 chars; scope when helpful: `feat(webapp): add grade settings`.
- PRs: include context/description, linked issues (`Fixes #123`), screenshots for UI changes, and test steps.

## Code Organization

### Cross-Role Route Patterns
When working on features that span admin/assistant/student routes, avoid duplicating code:
- **Re-export** where possible: a role-prefix route re-exports from whichever route already serves that screen — the student one for student-facing views, the admin one for staff views (see `assistant.$class_.quizzes/route.tsx`, which re-exports the admin quiz management screens). Re-export `action` ONLY when the source route's own gate admits the role that prefix serves; omitting it means the mutation has no POST target under that prefix at all, which is usually what you want.
- **`/admin` is the OWNER namespace for navigation.** `admin.$class/route.tsx` carries a `requireClassroomAdmin` loader, so every screen under `/admin/:class/**` is owner-only to BROWSE, regardless of its own leaf gate. A screen a teacher or assistant should reach needs a route under `/teacher` or `/assistant`. That layout loader is not a mutation boundary and must never be read as one: React Router matches only the action route for a submission and revalidates loaders afterwards, so a POST to a leaf under `/admin` runs before the namespace loader refuses. Every action keeps its own gate — that is what actually decides who may write.
- **Shared components** go in `apps/webapp/app/components/features/`
- **Shared business logic** goes in `packages/services` or `packages/utils`
- Check existing role routes before creating new ones — the feature may already exist under a different role prefix.
- Coursework routes: `admin.$class.assignments_.$id` is the per-assignment grading page (one roster per assignment; loader/action gated by `requireClassroomTeachingTeam`, grader changes owner/teacher only), re-exported by `teacher.$class_.assignments_.$id` and `assistant.$class_.assignments_.$id`; `admin.$class.assignments_.$id.assign-graders` is its modal. `admin.$class.students_.$login` is the student report (letter override, staff note, owner-only school id), re-exported for teacher; it replaced the `admin.$class.students.$login` drawer and the `admin.$class.grades.$login` comment modal. `admin.$class.repos.update` is the "Update student repositories" modal. There is NO repository detail page: `admin.$class.repos_.$title` and its children are gone; submissions are reached from the module card or the assignment page.

### Service Isolation
Slides, pages, and ai-agent are moving toward self-contained services. When working on these, keep code consolidated within each service rather than adding cross-app dependencies. Prefer importing from shared packages (`@classmoji/services`, `@classmoji/utils`, `@classmoji/database`) over reaching into another app's internals.

### Standard Page Layout
List/index pages (admin/student route pages with a header + table or list) should follow this uniform pattern. Reference: `apps/webapp/app/routes/admin.$class.staff/route.tsx`.

```jsx
<div className="min-h-full relative">
  <Outlet /> {/* if the route nests modals/drawers */}

  {/* Header row: small inline title + actions on the right (search, buttons) */}
  <div className="flex items-center justify-between gap-3 mt-2 mb-4">
    <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Page Title</h1>
    <div className="flex gap-3">
      {/* SearchInput, ButtonNew, etc. */}
    </div>
  </div>

  {/* Floating card wrapping the table/list */}
  <div className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
    <Table ... />
  </div>
</div>
```

Conventions:
- **Title goes outside the card**, not inside.
- The title is a single-line `h1` at `text-base font-semibold text-gray-600 dark:text-gray-400`. Do not use the old `PageHeader` component (it injects an icon and a much larger heading). it's been removed from all routes and should not be reintroduced.
- The card uses `rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800` with `p-5 sm:p-6`. Add `min-h-[calc(100vh-10rem)]` so the card fills the viewport on near-empty states.
- **Empty states**: Use `<div className="text-center py-12 text-gray-500"><div className="font-medium">…</div><div className="text-sm">…</div></div>`. Functional/branding emojis (chat avatars, inline icons in info banners) are fine. only the big `text-4xl mb-2` decorative pattern is out.
- **CommonLayout content shell**: `apps/webapp/app/components/layout/navigation/CommonLayout.tsx` wraps non-listed routes in its own outer white card. To get the floating-card effect, the route's path segment must be in the bare-canvas list in CommonLayout (look for the `pathname.includes(...) || pathname.match(...)` chain). When adding a new top-level list page, add its segment to that list — otherwise you'll get a double card-on-card.

## Environments & Deployment
- Hosted on **Fly.io** with staging and production environments. Production database is on **Neon**.
- **NEVER use Neon MCP tools** unless explicitly asked to debug a production issue.
- Always work in **feature branches** — never commit to `main` or `staging` directly. The dev service won't start on main/staging branches.
- Secrets are managed in **Infisical**. When adding a new env var, also add it to:
  - `turbo.json` `globalEnv` array
  - `.env.example` (with placeholder and instructions)
  - Infisical workspace (e9a6487c-350e-41e7-8bba-2d95ca5934a6) prod environment
- **Live editing env**: `COLLAB_PORT` (devport: 7700 + id × 10, set by `scripts/devport-env.sh` with the URLs), `COLLAB_URL`, `COLLAB_WS_URL`, `COLLAB_INTERNAL_SECRET` (dev fallback secret outside production only), `COLLAB_ALLOWED_ORIGINS`, `COLLAB_CHECKPOINT_DELAY` / `_MAX_DELAY` (10s/30s dev, 1m/4m prod). What to add to Infisical and Fly before the first deploy: `apps/collab/README.md`.
- **Live-editing Trigger tasks**: `content-checkpoint` (debounced per classroom; renders every dirty `collab_docs` row and pushes ONE commit), `collab-external` (tells collab about an outside push), `collab-sweeper` (cron every 30 min — needs a paid Trigger.dev plan; free plans reject crons more frequent than hourly). The checkpoint git helper (`packages/tasks/src/helpers/gitCheckpoint.ts`) works in a blob-less shallow bare clone: never use the index or `read-tree` there (both fault in every blob), build trees with `ls-tree`/`mktree --missing`, and push with the promisor config detached — `--no-thin` alone is ignored over https.
- **Trigger.dev deployments** are automatic via GitHub Actions when anything the worker bundles changes: `packages/tasks/**`, `packages/database/**`, `packages/services/**`, `packages/utils/**`, `packages/content-signing/**`, `packages/collab/**`, `packages/page-schema/**` or `apps/ai-agent` (the `tasks` filter in `deploy-fly-*.yml`; a submodule pointer bump counts, since the quiz chat agent's tasks live there). The deploy job also fails if more than one `@trigger.dev/sdk` version is installed (`apps/ai-agent` pins the same version as `packages/tasks`). The Trigger deploy waits for the webapp deploy, whose `release_command` runs migrations, so a worker never runs against a database without its columns; a contract change in `utils` reaches the live worker in the same deploy. Deployments automatically sync all secrets via the `syncEnvVars` extension, from the Infisical environment matching the Trigger.dev one (`prod` → `prod`, `staging` → `sta`, `preview`/`dev` → `dev`; an unmapped environment syncs nothing). Manual deployment is no longer needed unless testing locally.
- **`TRIGGER_PUBLIC_API_URL`, never `TRIGGER_API_URL`, for anything GitHub Actions calls.** The generated autograding workflow reports to `publicTriggerApiBase()` (`packages/tasks/src/workflows/autograde.ts`; default `https://api.trigger.dev`, internal/localhost addresses refused). Inside a deployed worker `TRIGGER_API_URL` is the platform's internal address and is unreachable from a runner (issue #391). `AUTOGRADE_CALLBACK_SECRET` unset makes the Autograde task fail before committing anything.
- Local DB via `docker compose up -d`. Do not commit secrets or `.env`.
- **Sentry**: browser-only (webapp, pages, slides), one project `dali-lab/classmoji` (org/project), events tagged `app`. `SENTRY_DSN` lives in Infisical (`prod`/`sta`), synced to the Fly apps; environment from `FLY_APP_NAME`; unset = off. `SENTRY_AUTH_TOKEN` (GitHub Actions secret → Docker build secret) uploads source maps and deletes them from the build; unset = build unchanged. PII: user id only, no replay.
- `apps/ai-agent` is a git submodule (`git@github.com:classmoji/ai-agent.git`). Use `git clone --recursive` or `git submodule update --init` to populate. It may be empty for OSS contributors — that's expected. It also holds the chat agents' Trigger.dev tasks (`src/trigger/`, tasks `quiz-attempt`, `explore-repo`, `ask-moji`), built into the `packages/tasks` Trigger project via `packages/tasks/src/private-agents/`; with it empty those tasks are absent (quiz chat and Ask Moji on Trigger unavailable, `QUIZ_TRIGGER_RUNTIME` and `ASK_MOJI_RUNTIME` default off) and a Trigger deploy refuses to build.
- **Contributors without submodule access: do not commit `package-lock.json` changes.** Running `npm install` with the submodule empty strips ai-agent's deps (including the quiz agent's) from the lockfile, which breaks staging's `npm ci` after merge. If your PR legitimately needs to add/update deps, flag it in the PR description and a maintainer will regenerate the lockfile with the submodule populated before merging. A `pr-lockfile-check` CI job enforces this. Regenerate the lockfile with npm 10 (the `packageManager` version, e.g. `npx npm@10.9.0 install`): npm 11 adds `libc` fields the check rejects.
- **Gitlab is multi-instance.** gitlab.com is the default instance (env: `GITLAB_CLIENT_ID`/`SECRET`, `GITLAB_URL`); self-managed GitLabs are `GitLabInstance` rows requested at `/gitlab/setup` (own OAuth app, secret encrypted) and usable only once a platform admin approves them in apps/admin (never automatic: everyone at that school signs in through the requester's OAuth app) and signed in through the `gitlabInstances` better-auth plugin (`packages/auth/src/gitlabInstances.ts`). Never read GitLab host/client env directly: use `ClassmojiService.gitlabInstance` (`oauthClient`, `hostFor`, `webhookUrl`). GitLab ids from a self-managed instance are stored as `<instance id>:<id>` in every provider id column (`scopeGitlabId`/`parseGitlabId` in `@classmoji/utils`); `GitOrganization.base_url` is the host used for links and API calls. A GitLab classroom is a class subgroup (`Classroom.git_namespace`): the content project at its root (displayed "Content"), student and team projects in `projects/` (`repoNamespace`), team subgroups in `teams/` (`teamsNamespace`). Never build these paths by hand.
- **Git identity lives on `Account`, never on `User`.** `users` has no `login`/`provider`/`provider_id`; each git account (`provider_id` `github`/`gitlab`) carries its `username`, `email`, `image`. Load it with `GIT_IDENTITY` and read it with `gitUsername(user, provider)`/`withLogin`/`withLogins` (`@classmoji/utils`); look users up with `whereGitUsername(name, scope)` (`@classmoji/database`). GitLab usernames are unique per server (`Account.gitlab_instance_id`, `""` for gitlab.com and Github; key `provider_id + gitlab_instance_id + username`), so a lookup that belongs to a classroom passes its git organization as `scope`, never a bare `'GITLAB'`.
- **Every classroom is shown, Github and Gitlab together, whichever way the person signed in.** Inside a classroom its provider decides which username is theirs (the root loader sets `user.login` from `user.logins[provider]` and revalidates on classroom change; repo names are built from it); outside, Github first, else Gitlab. The displayed avatar (`users.image`) is the Github one, else Gitlab's.
- **Copy uses Github's vocabulary on both providers**: repository, issue, pull request (`gitTerms` in `@classmoji/utils`). Only names of real places in Gitlab's interface differ: the platform, the group/subgroup a class lives in, the "Changes" tab. Write "Github"/"Gitlab", not "GitHub"/"GitLab", in UI copy.
- `@classmoji/llm` does not exist. LLM code lives in `apps/ai-agent/src/llm/` (private submodule). Public-facing exports (`getAllModels`, `examplePrompts`) are in `@classmoji/services`.
- AI features on the ai-agent (quiz, and Ask Moji while `ASK_MOJI_RUNTIME` is not `trigger`) are gated by `isAIAgentConfigured()` in `~/utils/aiFeatures.server.js`. When `AI_AGENT_URL` or `AI_AGENT_SHARED_SECRET` env vars are missing, AI nav items hide, settings toggles disable, and API routes return 503. Always use this guard when adding new AI-dependent features that run on the ai-agent. Ask Moji on the Trigger runtime is gated by `ClassmojiService.askMojiSession.askMojiAvailable` instead (see Ask Moji below).

## Coursework model
- Module → Assignment → Repository | Quiz | Form. A module lists content (pages, slides) and assignments. An assignment has `type` REPO/QUIZ/FORM, a required `module_id`, exactly one of `repository_id`/`quiz_id`/`form_id`, and `weight` (the only grading weight), `is_extra_credit`, `release_at`, `student_deadline`, `grader_deadline`, `tokens_per_hour` (extension price; null = the classroom's `default_tokens_per_hour`, read through `effectiveTokensPerHour`). A repository has no module and no weight; several assignments may submit through one repository. Course grade = weighted mean of graded non-extra-credit assignments + extra credit (`packages/utils/src/grades.ts`); no drop-lowest.
- Submission modes (`Assignment.submission_mode`): `REPO` = the student's last push to the default branch before the deadline (+ purchased extension hours) is the submission, no issue is opened; `ISSUE` = closing the GitHub issue submits, reopening un-submits. Column default ISSUE; UI and MCP default REPO. The submission row is `GitRepoAssignment` (unique per git repo + assignment; `closed_at` is the submission time, frozen once graded). `recordPush` handles live pushes, `recordExistingPush` stamps repos that already had commits, `packages/database/scripts/backfillRepoSubmissions.ts --apply` backfills old rows.
- Grading happens on the assignment page (`admin.$class.assignments_.$id`) or in a gradebook cell. The gradebook (`admin.$class.grades`) is a read-first overview: one column per published assignment. Scales: emoji (mean of stacked emojis) or numeric `score-0`…`score-100` (`packages/utils/src/emojis.ts`; one score per grader, a new score replaces the caller's own). `HelperService.addGradeToGitRepoAssignment` refuses values outside the scale.
- Class invite link (`/join/:code`, `ClassmojiService.joinLink`): owner turns it on, copies or resets it on the Students page (`Classroom.join_code`, `join_link_enabled`). Anyone signed in with a verified email who opens it joins as a STUDENT (pending), then the shared git step (`~/utils/joinGitOrganization.server.ts`, also used by the picker's Accept) sends a Github student straight to `github.com/orgs/<org>/invitation`. Only ACTIVE, non-archived classrooms accept joins; every refusal reads "not active". The code is a credential: owners only, never in audit rows. Web only, on purpose: the MCP has NO invite-link tools (no reading, changing or joining by the link), so an agent never holds a working join credential or enrolls its user from a link it read. Do not add any.
- Student report (`admin.$class.students_.$login`): letter-grade override, private staff note, owner-only school id. Not the gradebook.
- Student grade line (dashboard + `my_grades`, one entry point `helper.gradeSummaryForStudent`): the letter override is staff-only until the owner releases final grades on the gradebook (`ClassroomSettings.final_grades_released`); then students see `finalStudentGrade`, exactly the gradebook's Letter column. Before that, with `show_grades_to_students` on, `estimateStudentGrade` (`packages/utils/src/grades.ts`): released repo grades plus quiz scores, as a letter (no percent), or the nearest emoji without a letter scale; never the override.
- Autograding: tests live on the repository; `dispatch_autograde_workflow` commits `.github/workflows/classroom.yml` to student repos; results are advisory (`autograding_results`), never grades. The GitHub App needs `workflows: write` and must subscribe to `push`, `issues`, `organization`.

## Authorization Patterns
**ALL routes MUST be protected** unless explicitly marked as public. Every new loader/action needs an auth check — no exceptions.

Auth helpers are in `~/utils/routeAuth.server.js` (re-exported from `@classmoji/auth/server`). Pick the right one:
- `requireClassroomAdmin()` — admin-only routes (most `admin.$class.*` routes)
- `requireClassroomTeachingTeam()` — staff routes including assistants
- `requireStudentAccess()` — student-only routes
- `assertClassroomAccess({...})` — custom role/ownership checks (API routes, self-access patterns with `resourceOwnerId`/`selfAccessRoles`/`requireOwnership`)

All return `{ userId, classroom, membership, ... }`. Denied attempts are auto-logged.

## LLM & Quiz Architecture
The quiz system has two runtimes, both in the `apps/ai-agent` submodule: the WebSocket server's Claude Agent SDK path (`apps/ai-agent/src/llm/`) and the Trigger.dev chat runtime (`apps/ai-agent/src/trigger/`, below). An attempt stays on the runtime stamped on it when it started.

### Chat runtime (Trigger.dev)
A quiz attempt runs on one of two runtimes, stamped on the attempt (`quiz_attempts.agent_runtime`) when it is created. `QUIZ_TRIGGER_RUNTIME` (`off` by default, `code_aware`, `all`; read only in `apps/webapp/app/utils/quizRuntime.server.ts`) picks it for new attempts. `trigger_chat` attempts run as the Trigger.dev chat task `quiz-attempt` (code in `apps/ai-agent/src/trigger/quiz/`); the webapp mints the session token at `api.quiz-chat.session` and acts on the stamp, never on the switch. `ai_agent` attempts keep the WebSocket flow below.

### Ask Moji
The course assistant has two runtimes too, picked by `ASK_MOJI_RUNTIME` (`ai_agent` by default, also when unset; `trigger`). Read it only through `askMojiRuntime()` / `isAskMojiTriggerRuntime()` (`@classmoji/utils/ask-moji`), never a local `=== 'trigger'`. With `ai_agent` it is the ai-agent's WebSocket/SSE path (`api.syllabus-bot.*`) and only the webapp shows it. With `trigger` it is the Trigger.dev chat agent `ask-moji` (code in `apps/ai-agent/src/trigger/askMoji/`), in the webapp and, through an iframe of the webapp's embed route (`ask-moji.$class.embed`), in the pages and slides apps.
- One gate everywhere: `ClassmojiService.askMojiSession.askMojiAvailable({ classroomId })`: the switch is `trigger`, Trigger is configured, there is an Anthropic key (the platform's or the classroom's), Pro, and `syllabus_bot_enabled`. Its reasons have a staff line each (`ASK_MOJI_AVAILABILITY_COPY`); members see one line. The webapp's `api.ask-moji.$class.*` routes run `assertAskMojiAccess` (`@classmoji/auth/server`), then `askMojiSession`, which starts and reuses conversations, mints session tokens and writes the audit rows. Conversations are per user, classroom and view, and scoped to the impersonation session that started them.
- The agent reads course data only through the MCP, with a per-turn token for the asking user: every call pinned to the conversation's classroom, `ask_moji_*` tools never offered, and the `X-Classmoji-Role-Ceiling` header (honoured for the Ask Moji client only, `ASK_MOJI_CLIENT_ID`) when the user views as a lower role. The MCP gates every tool for that user, and writes one VIEW row for every read of other people's data (a tool or resource's `auditRead`, for every client, with `data.client_id`); the agent writes no tool audit rows of its own.
- Owners and teachers (not assistants) get the insights page, `/admin/:class/ask-moji` and its `/teacher` re-export: weekly usage in the course time zone, "Asked from" and "Most cited" (a material shows only at `INSIGHT_MIN_ASKERS` distinct students), and the feedback review (👎 by default, 👍 filter) with a read-only exchange view per rating (`ClassmojiService.askMojiInsights`). 404 wherever `askMojiAvailable` is false. Each read is a VIEW row: `web:ask_moji.insights`, `web:ask_moji.feedback_review`, `web:ask_moji.exchange` (`resource_id` = the feedback id).
- Owners set classroom instructions for Ask Moji on AI settings (`syllabus_bot_instructions`, at most `INSTRUCTIONS_MAX_CHARS`). Owner-only to read and write: never in `SAFE_SETTINGS_FIELDS`, `get_classroom_info` or a config/class-to-class import. Every AI settings save is audited (`web:settings.ai`, field names only; for the instructions their length, never the text; `dedupe: false`, one row per save). The instructions field and its action exist only on the Trigger runtime. Ask Moji's model select uses the same allow-list as the quiz models.
- Webapp panel (`components/features/ask-moji/`): the root lazy-loads `AskMojiRoot` only where Ask Moji is available, and it lazy-loads the panel (AI SDK, Trigger transport) on the first open; nothing else imports the barrel. Opening the panel boots no Trigger run: the session starts on the first keystroke (`transport.preload`) or the first send. Thumbs show only on transcript rows the server marks `metadata.rateable`. Routes publish what is open with `useAskMojiViewing` (a stack: a drawer over its page, the page restored on close).

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

## Agent-Specific Instructions
- New LLM system prompts and model-facing tool text go in the `apps/ai-agent` submodule, not in this repo. Code here passes data (ids, settings) to it.
- Plan first, share a short step-by-step plan, and get approval before large changes.
- **Use TaskCreate to break plans into discrete, trackable tasks** with clear subjects and descriptions. Set dependencies with `addBlockedBy` so work proceeds in the right order. Mark each task `in_progress` when starting and `completed` when done — this provides live progress visibility.
- Keep PRs incremental; prefer small, verifiable diffs with clear scope.
- **Work in a devport worktree, start the dev stack, and test locally.** Create one with `npm run devport create <feature-name>` (own worktree, database, and port block; `.env` is copied in), run `npm run dev` inside it, then read `.dev-context` for the actual ports and database. Start the stack yourself whenever testing needs it — don't assume it is already running.
- **Test frontend changes** using Claude-in-Chrome browser tools. After making changes, open the affected page and verify both visual rendering and functionality.
- When working on the webapp, use the `react-router-framework-mode` skill if available for React Router conventions and patterns.
