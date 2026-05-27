# Modules→Repositories / Repository→GitRepo Rename — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Swap two domain entities across the entire codebase: `Module` → `Repository`, and existing `Repository` (+ its child models) → `GitRepo*`. Preserve all production data.

**Architecture:** Single Prisma migration with ordered `ALTER TABLE RENAME` / `ALTER TABLE RENAME COLUMN` statements (metadata-only, data-preserving). Code rename leans on TypeScript: after `prisma generate`, stale identifiers become compile errors. Webapp routes renamed in lockstep; old URLs 301-redirect to new ones for 30 days.

**Tech Stack:** Prisma + PostgreSQL (Neon prod), React Router 7 (webapp), Trigger.dev (workflows), Playwright (e2e), Fly.io (deploy).

**Branch:** `refactor/modules-to-repos` (already checked out). Commits must NOT include any Claude branding (no "Co-Authored-By: Claude…", no "Generated with Claude Code" footer).

**Reference:** See `docs/plans/2026-05-14-modules-to-repos-rename-design.md` for the naming map and rationale.

---

## Pre-flight

### Task 0: Verify environment

**Step 1:** Confirm branch and clean tree.

```bash
git status
git branch --show-current
```

Expected: `refactor/modules-to-repos`, clean working tree.

**Step 2:** Read `.dev-context` to confirm the local DB you'll migrate against.

```bash
cat .dev-context
```

**Step 3:** Capture a baseline grep so you can sanity-check progress later.

```bash
grep -rn "module_id\|model Module\|@@map(\"modules\")\|module:\|module\.\|Module\[" packages/database/schema.prisma | wc -l
grep -rln "Module\|module" apps/webapp/app --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" | wc -l
```

Record both numbers in a scratchpad — they'll go to ~0 (for the schema) and a small residual (for the webapp, since the word "module" appears in unrelated contexts like JS module imports).

---

## Phase 1: Database schema

### Task 1: Rename `Repository` family → `GitRepo` in Prisma schema

**Files:**
- Modify: `packages/database/schema.prisma`

**Step 1:** Open `packages/database/schema.prisma`. In the order listed below, rename each model definition and every reference to it. Per the naming map in the design doc:

- `model Repository` → `model GitRepo`; `@@map("repositories")` → `@@map("git_repos")`
- `model RepositoryAssignment` → `model GitRepoAssignment`; `@@map("repository_assignments")` → `@@map("git_repo_assignments")`
- `model RepositoryContributorLink` → `model GitRepoContributorLink`; `@@map("repository_contributor_links")` → `@@map("git_repo_contributor_links")`
- `model RepositoryAssignmentGrader` → `model GitRepoAssignmentGrader`; `@@map("repository_assignment_graders")` → `@@map("git_repo_assignment_graders")`
- `model RepoAnalyticsSnapshot` → `model GitRepoAnalyticsSnapshot`; `@@map("repo_analytics_snapshots")` → `@@map("git_repo_analytics_snapshots")`

For each, also rename:
- Field types referencing the model (e.g. `repository Repository` → `git_repo GitRepo`, `repositories Repository[]` → `git_repos GitRepo[]`)
- FK columns: `repository_id` → `git_repo_id`, `repository_assignment_id` → `git_repo_assignment_id`
- `@@index`, `@@unique` referencing those columns
- The `@relation` field names: `repository` → `git_repo`, `repositories` → `git_repos`, `repository_assignment` → `git_repo_assignment`, etc.

Leave `Module` alone for now.

**Step 2:** Format check.

```bash
npx prisma format --schema=packages/database/schema.prisma
```

**Step 3:** Validate.

```bash
npx prisma validate --schema=packages/database/schema.prisma
```

Expected: no errors.

**Step 4:** Commit.

```bash
git add packages/database/schema.prisma
git commit -m "rename Repository family to GitRepo in prisma schema"
```

---

### Task 2: Rename `Module` → `Repository` in Prisma schema

**Files:**
- Modify: `packages/database/schema.prisma`

**Step 1:** Now rename `Module` → `Repository`:

- `model Module` → `model Repository`; `@@map("modules")` → `@@map("repositories")`
- All `module_id` columns → `repository_id`
- All `module Module` field declarations → `repository Repository`
- All `modules Module[]` → `repositories Repository[]`
- `@@index([module_id])` → `@@index([repository_id])`
- `@@unique([..., module_id, ...])` → `@@unique([..., repository_id, ...])`

Also rename the user-settings notification columns:

- `email_module_published` → `email_repository_published`
- `email_module_unpublished` → `email_repository_unpublished`

Update the section header comment near line 360 from `MODULE & ASSIGNMENT` → `REPOSITORY & ASSIGNMENT`.

**Step 2:** Format and validate.

```bash
npx prisma format --schema=packages/database/schema.prisma
npx prisma validate --schema=packages/database/schema.prisma
```

Expected: no errors.

**Step 3:** Commit.

```bash
git add packages/database/schema.prisma
git commit -m "rename Module to Repository in prisma schema"
```

---

### Task 3: Create the rename migration

**Files:**
- Create: `packages/database/migrations/<timestamp>_rename_modules_to_repositories/migration.sql`

**Step 1:** Use Prisma to scaffold an empty migration (we'll write the SQL by hand because Prisma's diff won't infer renames).

```bash
npm run db:migrate -- --create-only --name rename_modules_to_repositories
```

This creates a new directory under `packages/database/migrations/`. Note the path Prisma prints.

**Step 2:** Open the generated `migration.sql` and replace its body with the SQL below. **Order matters** — old `Repository` family is renamed first to free the `repositories` name, then `modules` takes it.

```sql
BEGIN;

-- 1. Rename Repository family → GitRepo (frees the `repositories` table name)

-- repository_assignment_graders → git_repo_assignment_graders
ALTER TABLE "repository_assignment_graders" RENAME TO "git_repo_assignment_graders";
ALTER TABLE "git_repo_assignment_graders" RENAME COLUMN "repository_assignment_id" TO "git_repo_assignment_id";
ALTER INDEX "repository_assignment_graders_repository_assignment_id_grader_id_key" RENAME TO "git_repo_assignment_graders_git_repo_assignment_id_grader_id_key";
-- (verify and rename any other indexes on this table found in psql \d)

-- repo_analytics_snapshots → git_repo_analytics_snapshots
ALTER TABLE "repo_analytics_snapshots" RENAME TO "git_repo_analytics_snapshots";
ALTER TABLE "git_repo_analytics_snapshots" RENAME COLUMN "repository_assignment_id" TO "git_repo_assignment_id";

-- repository_contributor_links → git_repo_contributor_links
ALTER TABLE "repository_contributor_links" RENAME TO "git_repo_contributor_links";
ALTER TABLE "git_repo_contributor_links" RENAME COLUMN "repository_id" TO "git_repo_id";

-- repository_assignments → git_repo_assignments
ALTER TABLE "repository_assignments" RENAME TO "git_repo_assignments";
ALTER TABLE "git_repo_assignments" RENAME COLUMN "repository_id" TO "git_repo_id";

-- Any tables holding a `repository_assignment_id` FK pointing at the old name need that column renamed too:
ALTER TABLE "assignment_grades" RENAME COLUMN "repository_assignment_id" TO "git_repo_assignment_id";
ALTER TABLE "regrade_requests" RENAME COLUMN "repository_assignment_id" TO "git_repo_assignment_id";
ALTER TABLE "token_transactions" RENAME COLUMN "repository_assignment_id" TO "git_repo_assignment_id";

-- repositories → git_repos (the parent table)
ALTER TABLE "repositories" RENAME TO "git_repos";

-- 2. Rename Module → Repository (takes the freed `repositories` name)

-- modules → repositories
ALTER TABLE "modules" RENAME TO "repositories";

-- All child tables: module_id → repository_id
ALTER TABLE "assignments" RENAME COLUMN "module_id" TO "repository_id";
ALTER TABLE "git_repos" RENAME COLUMN "module_id" TO "repository_id";  -- the FK formerly named module_id on the old Repository, now GitRepo
ALTER TABLE "quizzes" RENAME COLUMN "module_id" TO "repository_id";
ALTER TABLE "page_links" RENAME COLUMN "module_id" TO "repository_id";
ALTER TABLE "slide_links" RENAME COLUMN "module_id" TO "repository_id";

-- 3. User notification preferences
ALTER TABLE "user_notification_preferences" RENAME COLUMN "email_module_published" TO "email_repository_published";
ALTER TABLE "user_notification_preferences" RENAME COLUMN "email_module_unpublished" TO "email_repository_unpublished";

-- 4. Rename indexes that Prisma names after table/column
-- Prisma names indexes as: <table>_<col>_idx and <table>_<cols>_key. After table rename, indexes keep their old
-- internal names. Rename them so future Prisma migrations don't get confused. List every index from `\d` on the
-- old tables and rename them. Examples:
ALTER INDEX "modules_classroom_id_idx" RENAME TO "repositories_classroom_id_idx";
ALTER INDEX "modules_classroom_id_title_key" RENAME TO "repositories_classroom_id_title_key";
-- … (repeat for every renamed table — see Task 3b for how to enumerate)

COMMIT;
```

**Step 3 (Task 3b):** Enumerate all indexes that need renaming. Run against the local DB:

```bash
psql "$DATABASE_URL" -c "\d modules" -c "\d repositories" -c "\d repository_assignments" -c "\d repository_contributor_links" -c "\d repository_assignment_graders" -c "\d repo_analytics_snapshots"
```

For every index/constraint name that starts with `modules_`, `repositories_`, `repository_*`, or `repo_analytics_*`, add an `ALTER INDEX ... RENAME TO ...` (or `ALTER TABLE ... RENAME CONSTRAINT ...` for unique constraints) line to the migration. Paste these into the migration before the `COMMIT;`.

**Step 4:** Write the reverse migration as a sibling file `migration.down.sql` (not executed by Prisma but kept for emergencies). It is the same statements in reverse order: rename `repositories` back to `modules`, then `git_repos` back to `repositories`, etc.

**Step 5:** Apply migration locally.

```bash
npm run db:deploy
```

Expected: migration applies cleanly; no errors.

**Step 6:** Verify tables exist with new names.

```bash
psql "$DATABASE_URL" -c "\dt" | grep -E "repositories|git_repos|modules"
```

Expected: `repositories` and `git_repos` and `git_repo_assignments` etc. present. `modules` and old `repositories` *as the old entity* gone.

**Step 7:** Regenerate Prisma client.

```bash
npm run db:generate
```

Expected: success.

**Step 8:** Commit.

```bash
git add packages/database/migrations/*rename_modules_to_repositories*
git commit -m "add migration: swap modules→repositories, repositories→git_repos"
```

---

### Task 4: Update seed file

**Files:**
- Modify: `packages/database/seed.{ts,js}` (find the actual path)

**Step 1:** Find and open the seed file.

```bash
ls packages/database/ | grep -i seed
```

**Step 2:** Rename every `module*` identifier to `repository*` and every `repository*` identifier (that referred to the old git repo) to `git_repo*`. Be especially careful: `prisma.module.*` calls now become `prisma.repository.*`, and previous `prisma.repository.*` calls become `prisma.gitRepo.*`.

**Step 3:** Re-seed locally to verify.

```bash
npm run db:reset && npm run db:seed
```

Expected: seed succeeds.

**Step 4:** Commit.

```bash
git add packages/database/
git commit -m "update seed for repository/git_repo rename"
```

---

## Phase 2: Shared packages

### Task 5: Rename in `packages/services`

**Files:**
- Modify: every file in `packages/services/**` that references `module*`, `Module`, `Repository` (old meaning), `RepositoryAssignment`, `RepositoryContributorLink`, `RepositoryAssignmentGrader`, `RepoAnalyticsSnapshot`.

**Step 1:** Inventory.

```bash
grep -rln "Module\|module_id\|RepositoryAssignment\|RepositoryContributorLink\|RepositoryAssignmentGrader\|RepoAnalyticsSnapshot" packages/services/
```

**Step 2:** For each file, apply renames per the naming map. Function name patterns: `getModule*` → `getRepository*`, `listModule*` → `listRepository*`, etc. Variables: `module` → `repository`, `repository` (old) → `gitRepo`. Type imports: `Module` → `Repository`, `Repository` → `GitRepo` (from `@prisma/client` re-exports).

**Step 3:** Typecheck.

```bash
npx tsc -p packages/services --noEmit
```

Fix any remaining errors. Loop until clean.

**Step 4:** Run package tests if present.

```bash
npm run test --workspace=@classmoji/services 2>/dev/null || echo "no tests"
```

**Step 5:** Commit.

```bash
git add packages/services/
git commit -m "rename module→repository and repository→gitRepo in services"
```

---

### Task 6: Rename in `packages/utils`, `packages/auth`, `packages/content`

**Step 1:** Inventory across all three.

```bash
grep -rln "Module\|module_id\|Repository" packages/utils/ packages/auth/ packages/content/
```

**Step 2:** Apply renames per the naming map.

**Step 3:** Typecheck each package.

```bash
npx tsc -p packages/utils --noEmit
npx tsc -p packages/auth --noEmit
npx tsc -p packages/content --noEmit
```

**Step 4:** Commit.

```bash
git add packages/utils/ packages/auth/ packages/content/
git commit -m "rename module→repository and repository→gitRepo in shared packages"
```

---

### Task 7: Rename in `packages/tasks` (Trigger.dev)

**Files:**
- Modify: `packages/tasks/src/workflows/**`

**Step 1:** Inventory.

```bash
grep -rln "Module\|module_id\|Repository" packages/tasks/src/
```

**Step 2:** For any Trigger.dev job whose `id` / slug contains `module` or `repository` (old), decide:
- If the job is idempotent and queued runs can be dropped: rename the slug.
- If queued runs must survive: keep the slug as-is for now (only rename the internal handler symbols), and rename the slug in a follow-up PR after queues drain.

Default: rename slugs and document in PR description that the queue must be drained before deploy.

**Step 3:** Typecheck.

```bash
npx tsc -p packages/tasks --noEmit
```

**Step 4:** Commit.

```bash
git add packages/tasks/
git commit -m "rename module→repository and repository→gitRepo in tasks"
```

---

## Phase 3: Webapp — backend (loaders/actions/server code)

### Task 8: Rename loaders, actions, and `.server` files

**Files:**
- Modify: every `apps/webapp/app/**/*.server.{ts,js}` and route `route.{tsx,jsx,ts,js}` that uses `module*`/`Module`/`Repository` (old).

**Step 1:** Inventory.

```bash
grep -rln "Module\|module_id\|prisma\.module\|prisma\.repository" apps/webapp/app/
```

**Step 2:** Rename identifiers. Key transformations:
- `prisma.module.*` → `prisma.repository.*`
- `prisma.repository.*` → `prisma.gitRepo.*`
- `prisma.repositoryAssignment.*` → `prisma.gitRepoAssignment.*`
- Type imports: `Module` → `Repository`, `Repository` → `GitRepo`
- Variable names: `module` → `repository`; old `repository` → `gitRepo`
- FK accessors in queries: `module_id` → `repository_id`, `repository_id` → `git_repo_id`
- Relation accessors in includes: `.module` → `.repository`, `.repository` (old) → `.gitRepo`, `.repositories` (old) → `.gitRepos`

**Step 3:** Typecheck webapp.

```bash
npx tsc -p apps/webapp --noEmit
```

Fix errors. Loop until clean.

**Step 4:** Commit.

```bash
git add apps/webapp/app/
git commit -m "rename module→repository and repository→gitRepo in webapp server code"
```

---

## Phase 4: Webapp — routes

### Task 9: Rename route directories

**Files:**
- Move directories under `apps/webapp/app/routes/`:
  - `admin.$class.modules` → `admin.$class.repos`
  - `admin.$class.modules_.$title` → `admin.$class.repos_.$title`
  - `admin.$class.modules_.$title.assign-graders` → `admin.$class.repos_.$title.assign-graders`
  - `admin.$class.modules_.$title.update` → `admin.$class.repos_.$title.update`
  - `admin.$class.modules.form` → `admin.$class.repos.form`
  - `assistant.$class_.modules` → `assistant.$class_.repos`
  - `student.$class.modules` → `student.$class.repos`
  - `student.$class.modules_.$module.team` → `student.$class.repos_.$repo.team`

**Step 1:** Use `git mv` so history is preserved.

```bash
cd apps/webapp/app/routes
git mv admin.\$class.modules admin.\$class.repos
git mv admin.\$class.modules_.\$title admin.\$class.repos_.\$title
git mv admin.\$class.modules_.\$title.assign-graders admin.\$class.repos_.\$title.assign-graders
git mv admin.\$class.modules_.\$title.update admin.\$class.repos_.\$title.update
git mv admin.\$class.modules.form admin.\$class.repos.form
git mv assistant.\$class_.modules assistant.\$class_.repos
git mv student.\$class.modules student.\$class.repos
git mv student.\$class.modules_.\$module.team student.\$class.repos_.\$repo.team
cd -
```

**Step 2:** Inside `student.$class.repos_.$repo.team`, the route param changed from `$module` to `$repo`. Open the route files and update `params.module` → `params.repo`.

**Step 3:** Search for any `to="/admin/.../modules` or template-literal URLs and update them.

```bash
grep -rn "/modules\b\|/modules/" apps/webapp/app/
```

For each match, replace `/modules` → `/repos` (preserve query strings and trailing path segments).

**Step 4:** Typecheck.

```bash
npx tsc -p apps/webapp --noEmit
```

**Step 5:** Commit.

```bash
git add apps/webapp/app/
git commit -m "rename modules routes to repos and update internal links"
```

---

### Task 10: Update `CommonLayout` bare-canvas list

**Files:**
- Modify: `apps/webapp/app/components/layout/navigation/CommonLayout.tsx`

**Step 1:** Open the file. Find the bare-canvas pathname list (a chain of `pathname.includes(...) || pathname.match(...)`).

**Step 2:** Replace `'modules'` with `'repos'`. (The old `modules` segment is gone; the 30-day redirect handles legacy URLs but never enters this layout's check because redirects fire earlier.)

**Step 3:** Run webapp dev (already running per AGENTS.md) and visually confirm the new `/admin/<class>/repos` page renders with the floating-card layout (no double card).

**Step 4:** Commit.

```bash
git add apps/webapp/app/components/layout/navigation/CommonLayout.tsx
git commit -m "add repos to CommonLayout bare-canvas list"
```

---

### Task 11: Add 301 redirects for legacy URLs

**Files:**
- Create: `apps/webapp/app/routes/admin.$class.modules.$.tsx` (catch-all redirect)
- Create: `apps/webapp/app/routes/assistant.$class_.modules.$.tsx`
- Create: `apps/webapp/app/routes/student.$class.modules.$.tsx`

**Step 1:** Each file exports a `loader` that 301-redirects to the corresponding `/repos` path, preserving the splat and query string.

```tsx
import { redirect } from 'react-router';
import type { Route } from './+types/admin.$class.modules.$';

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const splat = params['*'] ?? '';
  const target = `/admin/${params.class}/repos${splat ? `/${splat}` : ''}${url.search}`;
  return redirect(target, { status: 301 });
}
```

Adjust the path prefix per file (`/admin`, `/assistant`, `/student`).

**Step 2:** Manually verify.

```bash
curl -sI "http://localhost:3000/admin/<some-classroom>/modules" | head -3
```

Expected: `HTTP/1.1 301` with `Location: /admin/<some-classroom>/repos`.

**Step 3:** Commit.

```bash
git add apps/webapp/app/routes/admin.\$class.modules.\$.tsx \
        apps/webapp/app/routes/assistant.\$class_.modules.\$.tsx \
        apps/webapp/app/routes/student.\$class.modules.\$.tsx
git commit -m "add 301 redirects from /modules to /repos"
```

Note: create a follow-up issue titled "Remove /modules→/repos redirect shim" to be closed in 30 days.

---

## Phase 5: Webapp — UI copy and components

### Task 12: Update UI strings ("Module" → "Repository")

**Files:**
- Modify: `apps/webapp/app/components/**`, `apps/webapp/app/routes/**` (any user-visible text)

**Step 1:** Inventory.

```bash
grep -rn "Module\b\|Modules\b\|module\b\|modules\b" apps/webapp/app/ \
  --include="*.tsx" --include="*.jsx" \
  | grep -v "import\|from '\|require(" \
  > /tmp/module-text-hits.txt
wc -l /tmp/module-text-hits.txt
```

**Step 2:** Walk through the hits, distinguishing **user-visible strings** (JSX text, labels, placeholders, `title=`, `aria-label=`, toast messages) from **identifiers** (variable names already handled in earlier tasks). Apply:

- `Module` → `Repository`
- `Modules` → `Repositories`
- Lowercase `module` (as a word, not as part of `import` / ESM) → `repository`
- `modules` → `repositories`

**Step 3:** Visually verify the major pages in the running dev server: admin repos list, repo detail, student repos list, student repo team page.

**Step 4:** Commit.

```bash
git add apps/webapp/app/
git commit -m "update UI copy from Module to Repository"
```

---

### Task 13: Update Playwright e2e specs

**Files:**
- Modify: `apps/webapp/tests/**/*.spec.{ts,js}`

**Step 1:** Inventory.

```bash
grep -rln "module\|Module\|/modules" apps/webapp/tests/
```

**Step 2:** Update URL assertions (`/modules` → `/repos`), text selectors (`getByText('Module')` → `getByText('Repository')`), and any test data setup that uses `prisma.module.*`.

**Step 3:** Run the affected specs.

```bash
npm run web:test -- --grep "repo\|repository"
```

Fix failures. Loop until clean.

**Step 4:** Commit.

```bash
git add apps/webapp/tests/
git commit -m "update e2e specs for repository rename"
```

---

## Phase 6: Other apps

### Task 14: Rename in `apps/slides`, `apps/site`, `apps/hook-station`, `apps/pages`

**Step 1:** Inventory.

```bash
grep -rln "Module\|module_id\|prisma\.module\|prisma\.repository\.\|RepositoryAssignment" \
  apps/slides/ apps/site/ apps/hook-station/ apps/pages/
```

**Step 2:** Apply renames per the naming map in each app. Most should be small.

**Step 3:** Typecheck each.

```bash
npx tsc -p apps/slides --noEmit
npx tsc -p apps/hook-station --noEmit
npx tsc -p apps/pages --noEmit
# apps/site is Astro — run `npm run -w site build`
```

**Step 4:** Commit per app.

```bash
git add apps/slides/ && git commit -m "rename module→repository in slides"
git add apps/site/ && git commit -m "rename module→repository in site"
git add apps/hook-station/ && git commit -m "rename module→repository in hook-station"
git add apps/pages/ && git commit -m "rename module→repository in pages"
```

(Skip any with no changes.)

---

### Task 15: AI agent submodule

**Step 1:** Inventory inside the submodule.

```bash
grep -rln "Module\|module_id\|RepositoryAssignment\|prisma\.module" apps/ai-agent/src/ 2>/dev/null || echo "submodule empty — skip"
```

**Step 2:** If non-empty and the submodule has references, open a **parallel PR** in the `classmoji/ai-agent` repo with the same renames. Do NOT pin the submodule until that PR merges.

**Step 3:** Once that PR merges, bump the submodule pointer in this repo and commit.

```bash
cd apps/ai-agent && git pull origin main && cd -
git add apps/ai-agent
git commit -m "bump ai-agent submodule for repository rename"
```

---

## Phase 7: Email templates

### Task 16: Rename email subject lines, body copy, and template variables

**Files:**
- Modify: wherever email templates live (likely `packages/services/emails/**` or `apps/webapp/app/emails/**`)

**Step 1:** Find them.

```bash
grep -rln "module" packages/services/ apps/webapp/ --include="*.tsx" --include="*.ts" --include="*.html" | xargs grep -l "subject\|template\|html" 2>/dev/null
```

**Step 2:** Update subject lines, body copy, and any template variable names (`{{module.title}}` → `{{repository.title}}`).

**Step 3:** Render a sample of each affected email locally (via the email preview route, if any) to confirm.

**Step 4:** Commit.

```bash
git add .
git commit -m "update email templates for repository rename"
```

---

## Phase 8: Verification

### Task 17: Full typecheck and build

**Step 1:** Whole-repo typecheck.

```bash
npm run typecheck 2>&1 | tee /tmp/typecheck.log
```

Expected: clean.

**Step 2:** Whole-repo build.

```bash
npm run build 2>&1 | tee /tmp/build.log
```

Expected: clean.

---

### Task 18: Full e2e suite

**Step 1:** Run webapp e2e.

```bash
npm run web:test
```

Expected: all pass.

**Step 2:** Run slides e2e.

```bash
npm run slides:test
```

Expected: all pass.

---

### Task 19: Manual smoke test on local

**Checklist (run in dev browser):**
- [ ] Admin: create a repository, attach a page, attach a slide, attach an assignment, publish.
- [ ] Student: see the published repository in their list.
- [ ] Student: open the repository team page.
- [ ] Receive the publish notification email (or check the preview).
- [ ] Visit a legacy `/modules` URL and confirm 301 → `/repos`.
- [ ] Notification preferences page shows the new `email_repository_published` / `email_repository_unpublished` toggles correctly.

---

### Task 20: Pre-deploy DB safety

**Step 1:** Take a Neon snapshot of prod (via Neon dashboard). Note the snapshot ID in the PR description.

**Step 2:** Confirm the reverse migration file (`migration.down.sql`) exists and is correct — dry-run it mentally against the migration's forward statements.

**Step 3:** Verify staging applies the migration cleanly before merging to `main`.

---

### Task 21: Open the PR

**Step 1:** Push the branch.

```bash
git push -u origin refactor/modules-to-repos
```

**Step 2:** Open PR against `main` (or `dev`, per team convention). PR description must include:

- Summary of the swap (`Module` → `Repository`, old `Repository` → `GitRepo`).
- Link to design doc: `docs/plans/2026-05-14-modules-to-repos-rename-design.md`.
- Deployment checklist: drain Trigger.dev queue, take Neon snapshot, merge during low-traffic window.
- Followup ticket reference for removing the redirect shim in 30 days.
- **Do NOT include any Claude branding** — no "Generated with Claude Code", no "Co-Authored-By: Claude" trailer.

```bash
gh pr create --base main --title "rename Module→Repository and Repository→GitRepo" --body-file /tmp/pr-body.md
```

---

## Post-merge follow-ups

- After 30 days, delete the three `apps/webapp/app/routes/*.modules.$.tsx` redirect files and the `CommonLayout` legacy entry. Single follow-up PR.
- Verify Trigger.dev queue has no `module*`-keyed jobs lingering.
- Close the design doc by adding a "Status: shipped on YYYY-MM-DD" line.
