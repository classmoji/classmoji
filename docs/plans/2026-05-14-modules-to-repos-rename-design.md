# Rename `Module` → `Repository`, `Repository` → `GitRepo`

## Goal

Swap two domain entities end-to-end:

- `Module` → `Repository` (the course-level definition; today's `modules` table)
- `Repository` → `GitRepo` (the per-student/team git repo; today's `repositories` table)

…and rename the related `Repository*` child models (`RepositoryAssignment` → `GitRepoAssignment`, etc.). Cover DB schema, backend code, frontend routes/components, URLs, UI copy, and email notifications. Preserve all production data. 301-redirect old URLs for ~30 days.

URL slug: `/repos` (shorter than `/repositories`). UI copy: "Repository" / "Repositories".

## Naming map

| Today                          | After                       |
| ------------------------------ | --------------------------- |
| `model Module`                 | `model Repository`          |
| table `modules`                | table `repositories`        |
| column `module_id`             | column `repository_id`      |
| `model Repository`             | `model GitRepo`             |
| table `repositories`           | table `git_repos`           |
| column `repository_id`         | column `git_repo_id`        |
| `model RepositoryAssignment`   | `model GitRepoAssignment`   |
| table `repository_assignments` | table `git_repo_assignments`|
| column `repository_assignment_id` | column `git_repo_assignment_id` |
| `model RepositoryContributorLink` | `model GitRepoContributorLink` |
| table `repository_contributor_links` | table `git_repo_contributor_links` |
| `model RepositoryAssignmentGrader` | `model GitRepoAssignmentGrader` |
| table `repository_assignment_graders` | table `git_repo_assignment_graders` |
| `model RepoAnalyticsSnapshot`  | `model GitRepoAnalyticsSnapshot` |
| table `repo_analytics_snapshots` | table `git_repo_analytics_snapshots` |
| URL `/modules*`                | URL `/repos*`               |
| route param `$module`          | route param `$repo`         |
| `email_module_published`       | `email_repository_published` |
| `email_module_unpublished`     | `email_repository_unpublished` |

## Migration ordering (critical)

The string `repositories` changes owners. The migration SQL must execute in this exact order, all inside a single transaction:

1. Rename old `Repository*` tables to their `git_repo*` names AND rename their `repository_id` FK columns to `git_repo_id` (and indexes/uniques).
2. Rename `modules` → `repositories`, `module_id` → `repository_id`.
3. Rename notification columns on the user/settings table.

Postgres `ALTER TABLE RENAME` and `ALTER TABLE RENAME COLUMN` are metadata-only, so this is near-instant and data-preserving.

## Sections (same as before)

1. **Database** — single Prisma migration following the ordering above. Pre-deploy: Neon snapshot + reverse migration prepared.
2. **Shared packages** — `packages/services`, `packages/utils`, `packages/auth`, `packages/content`, `packages/tasks` (Trigger.dev — drain queue or alias old job names).
3. **Webapp routes** — rename 8 route directories from `modules*` to `repos*`; `$module` param → `$repo`. Update `CommonLayout.tsx` bare-canvas list. Update Playwright specs.
4. **UI copy** — all "Module"/"Modules" → "Repository"/"Repositories".
5. **301 redirects** — `/admin|assistant|student/:class/modules*` → `…/repos*`. Keep ~30 days.
6. **Other apps** — `apps/slides`, `apps/site`, `apps/hook-station`, `apps/pages`, `apps/ai-agent` (submodule, parallel PR if needed).
7. **Email templates** — subject lines, body copy, variable names.
8. **Deploy** — dev → staging verify → Neon snapshot → main → monitor 24h → remove redirects after 30 days.

## Risk callouts

- The `Repository` → `GitRepo` rename is the more dangerous half because more code touches it (GitHub sync, grading, analytics, RepositoryAssignment workflows). Lean on TypeScript: after schema rename, `npm run db:generate` will turn every stale reference into a compile error, which is the primary safety net.
- Trigger.dev workflows may reference `Repository` types via `@classmoji/database`. Redeploy `packages/tasks` in the same window.
- The `repo_analytics_snapshots` table name doesn't actually contain the word `repository` — it already says `repo`. We're renaming it to `git_repo_analytics_snapshots` for consistency with the rest of the `GitRepo*` family.

## Rollback

- Code: revert PR.
- DB: pre-written reverse migration that does the swap in reverse, and/or Neon snapshot restore.
