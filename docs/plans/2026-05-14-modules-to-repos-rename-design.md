# Rename `Module` → `Repo`

## Goal

Rename the `Module` domain entity to `Repo` end-to-end: database schema, backend code, frontend routes/components, URLs, UI copy, and email notifications. Preserve all production data. Maintain backwards compatibility for existing URLs via 301 redirects for ~30 days.

## Scope

Full rename. No partial / code-only variant.

## 1. Database (`packages/database`)

Single Prisma migration using metadata-only Postgres operations.

- `model Module` → `model Repo`; `@@map("modules")` → `@@map("repos")`.
- All `module_id` FK columns → `repo_id`, with `@map("repo_id")` where the Prisma field name differs from the column.
- Relation fields renamed: `module` → `repo`, `modules` → `repos`.
- Affected tables (from schema grep): `modules`, plus child/related tables holding `module_id` (module items, `Page`, `Slide`, `Assignment`, join/scope rows with `@@unique([page_id, module_id, assignment_id])` etc.).
- User/settings notification flag columns: `email_module_published` → `email_repo_published`, `email_module_unpublished` → `email_repo_unpublished`.
- Indexes (`@@index([module_id])`) and unique constraints follow the renamed columns automatically when written as `@@index([repo_id])`.
- Pre-deploy: take Neon snapshot. Prepare rollback migration that reverses the renames.

Postgres `ALTER TABLE ... RENAME` and `ALTER TABLE ... RENAME COLUMN` are metadata-only — no row rewrite, no ID changes, near-instant even on large tables.

## 2. Shared packages

- `packages/services`: rename functions (`getModule*` → `getRepo*`, etc.), types, exported identifiers, and any string keys.
- `packages/utils`, `packages/auth`, `packages/content`: grep + rename references.
- `packages/tasks` (Trigger.dev): rename workflows/jobs keyed on `module*`. Any in-flight queued jobs referencing the old name will fail post-deploy — drain the queue before cutover, or register a temporary alias handler.

## 3. Webapp (`apps/webapp`)

Routes (rename directories and route params):

- `admin.$class.modules` → `admin.$class.repos`
- `admin.$class.modules_.$title` → `admin.$class.repos_.$title`
- `admin.$class.modules_.$title.assign-graders` → `…repos_.$title.assign-graders`
- `admin.$class.modules_.$title.update` → `…repos_.$title.update`
- `admin.$class.modules.form` → `admin.$class.repos.form`
- `assistant.$class_.modules` → `assistant.$class_.repos`
- `student.$class.modules` → `student.$class.repos`
- `student.$class.modules_.$module.team` → `student.$class.repos_.$repo.team` (note `$module` param → `$repo`)

Other webapp updates:

- Nav items, page titles, breadcrumbs, empty states, button labels, toasts: "Module" → "Repo", "Modules" → "Repos".
- `CommonLayout.tsx` bare-canvas list: add `repos` (and remove `modules` after redirect window).
- Playwright specs in `apps/webapp/tests/**`: update selectors and URL assertions.

## 4. URL redirects

Add 301 redirects:

- `/admin/:class/modules*` → `/admin/:class/repos*`
- `/assistant/:class/modules*` → `/assistant/:class/repos*`
- `/student/:class/modules*` → `/student/:class/repos*`

Implement via a thin redirect route or a top-level `loader` in each role section. Keep for 30 days, then remove in a follow-up PR.

## 5. Other apps

- `apps/slides`, `apps/site`, `apps/hook-station`, `apps/pages`: grep + rename remaining references. Most are webapp-local; expect minimal churn.
- `apps/ai-agent` (private submodule): parallel PR if it references the Prisma client or any `module*` identifiers.

## 6. Email templates

- Subject lines and body copy: "Module" → "Repo".
- Template variable names tied to `module*` → `repo*`.
- Notification preference UI labels updated accordingly (driven by the renamed columns from §1).

## 7. Deploy sequence

1. Merge code PR to `dev` → verify on staging (staging DB migration runs via `db:deploy`).
2. Take prod Neon snapshot.
3. Merge to `main` → Fly rolling deploy runs Prisma migration in lockstep with new code.
4. Monitor logs and Sentry for `modules`-related errors for 24h.
5. After ~30 days, remove the redirect shim in a follow-up PR.

## Testing

- Update existing Playwright e2e specs to new URLs and labels.
- Manual smoke on staging: create repo, attach page/slide/assignment, publish, student view, receive notification email.
- Verify `/modules*` URLs 301 to `/repos*`.

## Rollback

- Code: revert PR.
- DB: pre-prepared reverse migration (`RENAME repos TO modules`, column renames) and/or Neon snapshot restore.
