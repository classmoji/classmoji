# TA & Owner Analytics — Design

Date: 2026-04-19
Status: Approved (brainstorm)
Branch: redesign

## Goal

Give owners (admins) a class-wide health dashboard, give TAs a personal cockpit and a rich per-submission deep-dive, and use GitHub data to surface commit history, contributor splits, and fairness signals on multi-person projects.

## Non-goals

- No webhook-driven real-time GitHub cache (deferred; scheduled + on-demand refresh is enough).
- No changes to `apps/ai-agent` or the quiz pipeline.
- No migration of existing `SubmissionChart` / `Leaderboard` visual style — reuse as-is.

## Build order

Strict phase sequence. Later phases depend on earlier ones.

1. GitHub analytics foundation (provider methods, snapshot table, refresh workflow).
2. Per-submission deep-dive UI (uses Phase 1 data).
3. Multi-contributor views and unmatched-contributor resolution.
4. Owner class-wide dashboard rebuild.
5. TA personal cockpit upgrade.

## Architecture

Read path: routes load aggregates from new service helpers in `packages/services`. GitHub-derived data is read from a Postgres snapshot table — never fetched synchronously on page load.

Write path: a Trigger.dev workflow refreshes snapshots on a schedule and on-demand via `POST /api/repos/:id/refresh`, which enqueues the same workflow.

Unmatched contributors (GitHub logins with no `User.login` match) are stored on the snapshot and resolved through a new link table, so we never mutate `User.login`.

No changes to `apps/ai-agent`. `hook-station` is not used in this design.

## Phase 1 — GitHub analytics foundation

### GitHubProvider additions

In `packages/services/src/git/GitHubProvider.ts`:

- `listCommits(org, repo, { since?, until?, branch? })` — paginated, returns `{sha, author_login, author_email, ts, message, additions, deletions, parents}`.
- `getContributorStats(org, repo)` — uses `/repos/{org}/{repo}/stats/contributors`; handles 202 by returning `{ pending: true }`.
- `getLanguages(org, repo)` — `/repos/{org}/{repo}/languages`.
- `listPulls(org, repo, { state: 'all' })` — summary: open / merged / closed counts, plus reviewer stats.

`GitProvider` base gets abstract signatures; `GitLabProvider` throws `NotImplemented` (parity with existing pattern).

### Prisma model

```prisma
model RepoAnalyticsSnapshot {
  id                        String   @id @default(uuid())
  repository_assignment_id  String   @unique
  repository_assignment     RepositoryAssignment @relation(fields: [repository_assignment_id], references: [id], onDelete: Cascade)
  fetched_at                DateTime
  default_branch            String?
  total_commits             Int      @default(0)
  total_additions           Int      @default(0)
  total_deletions           Int      @default(0)
  first_commit_at           DateTime?
  last_commit_at            DateTime?
  commits                   Json     // [{sha, author_login, author_user_id?, ts, additions, deletions, message, parents}]
  contributors              Json     // [{login, user_id?, commits, additions, deletions}]
  languages                 Json     // { "TypeScript": 12345, ... }
  pr_summary                Json     // { open, merged, closed }
  stale                     Boolean  @default(false)
  error                     String?
  @@index([fetched_at])
  @@map("repo_analytics_snapshots")
}

model RepositoryContributorLink {
  id             String  @id @default(uuid())
  repository_id  String
  repository     Repository @relation(fields: [repository_id], references: [id], onDelete: Cascade)
  github_login   String
  user_id        String?
  user           User?  @relation(fields: [user_id], references: [id], onDelete: SetNull)
  created_at     DateTime @default(now())
  @@unique([repository_id, github_login])
  @@map("repository_contributor_links")
}
```

JSON-blob over normalized-rows because all reads are "load the whole snapshot for one submission." If we later need cross-repo queries ("top language in class"), we derive materialized aggregates into dashboard-scoped tables instead of normalizing commits.

### Refresh strategy

- Trigger.dev cron per active classroom, every 6h (`classroom.analytics_refresh_interval_hours`, default 6, admin-tunable in settings — small follow-up).
- On-demand: `POST /api/repos/:id/refresh` enqueues the workflow, returns `{ job_id }`. UI polls or uses existing SSE.
- Snapshot write is upsert by `repository_assignment_id`.
- GitHub 202 on contributor stats → set `stale=true`, re-enqueue in 60s.
- Rate-limit guard: stop page fetches at remaining < 10% and set `error`.

### Auth

- `/api/repos/:id/refresh` uses `assertClassroomAccess` with `selfAccessRoles: ['admin','assistant']`. Assistants scoped to repos they are assigned to grade.

## Phase 2 — Per-submission deep-dive

New `GitHubStatsPanel` component, mounted on admin and TA submission routes.

- **Summary row**: total commits, additions, deletions, files touched, contributors, first/last commit.
- **Commit timeline**: Recharts `AreaChart`, day bucket, vertical red reference line at `student_deadline`. Commits after deadline tinted.
- **Anomaly badges** (`<Anomalies>`): late-commit ratio, mega-commit (single commit > 40% of total additions), force-push (commit missing from parent chain vs. the prior snapshot), "dump-and-run" (first commit < 24h before deadline).
- **Commit-message quality**: derived in service as a pure function over `commits` JSON — signal-only, never stored.
- **Language breakdown**: compact bar.
- **PR panel**: open / merged / closed counts + last PR status.
- **Deep-links**: latest commit, compare vs. last graded SHA (persisted on `AssignmentGrade` as a follow-up; skip if not present).

Grading queue cards get a compact chip row reusing the same anomaly flags.

## Phase 3 — Multi-contributor views

`ContributorBreakdown` component:

- Two pies (Recharts `PieChart`): commits %, additions+deletions %.
- Stacked `BarChart` over day, stack = contributor — exposes "one person sprinted at the end" patterns.
- Unmatched contributors shown as rows with a "link to student" action → writes `RepositoryContributorLink`.
- Flags: bus-factor (`max_contributor_commit_share > 0.7`), zero-commit team member, heavy co-author-only contributions.

Teams route gets a "Contributions" tab that aggregates across all team repos.

## Phase 4 — Owner dashboard rebuild

Replace `admin.$class.dashboard/route.tsx`. Mount already-existing `SubmissionChart` and `Leaderboard`. Grid:

- Row 1: 4 stat cards — active students (quiz/commit in 14d), median grade, grading SLA (% graded within N days), at-risk count.
- Row 2: submissions-over-time (reuse `SubmissionChart`) + assignment heatmap (assignment × week, cell = submission count).
- Row 3: TA ops table (throughput 7d, avg time-to-grade, overturn rate, grade distribution vs. class mean) + at-risk students list.
- Row 4: quiz analytics (hardest questions, avg focus % using existing `unfocused_duration_ms`) + next-7-days deadline pressure.

All aggregations live in new `packages/services/src/classmoji/dashboard.service.ts`, mostly raw SQL via `$queryRaw` for speed. No GitHub calls in Phase 4 — everything derives from existing tables + snapshots when present.

## Phase 5 — TA cockpit upgrade

Upgrade `assistant.$class_.dashboard/route.tsx`:

- "My day" queue with better layout and deadline/age sort.
- Personal throughput sparkline (7d) + streak counter.
- SLA badges on items > 3 days unopened.
- Own-vs-class grade distribution histogram.
- Existing `StatsCard` / `StatsGradingProgress` / `TAGradingLeaderboard` are retained.

## Testing

- Playwright: extend `apps/webapp/tests/owner/dashboard.spec.ts`; add TA dashboard spec; add submission panel spec with a stubbed snapshot fixture.
- Vitest unit: commit-quality heuristic, bus-factor calc, commit-day bucketer, late-commit classifier. All pure functions.
- Tests never call GitHub — provider is injected and stubbed.

## Open follow-ups (deferred)

- Webhook-driven cache invalidation via `hook-station` (push/PR events).
- Cross-repo language leaderboards / materialized aggregates.
- Persisting `last_graded_sha` on `AssignmentGrade` to power "changes since last grade" diffs.
- Per-classroom tunable refresh cadence UI in settings.

## Load-bearing decisions

- **6h refresh cadence** (tunable) — trades freshness for cost/rate-limits.
- **Single JSON snapshot table** over normalized commit/contributor tables — optimized for the dominant read pattern.
- **`RepositoryContributorLink` table** for unmatched-contributor resolution — keeps `User.login` authoritative.
