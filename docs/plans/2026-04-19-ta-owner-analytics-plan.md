# TA & Owner Analytics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build class-wide dashboards for owners, a personal cockpit for TAs, and GitHub-powered per-submission deep-dives (commit history, contributor splits, fairness flags) for multi-contributor projects.

**Architecture:** Pages read from Postgres only. GitHub data is fetched by a Trigger.dev workflow into a `repo_analytics_snapshot` JSON blob table, refreshed on a 6h schedule and on-demand. Unmatched GitHub logins resolve through a new `repository_contributor_link` table so `User.login` stays authoritative.

**Tech Stack:** React Router 7 (webapp), Recharts (already installed), Prisma + Postgres, Trigger.dev (packages/tasks), Octokit (existing `GitHubProvider`), Vitest + Playwright.

**Design reference:** `docs/plans/2026-04-19-ta-owner-analytics-design.md`

---

## Conventions

- **Always check `.dev-context`** before running any `prisma` / `psql` / `db:*` commands. The correct `DATABASE_URL` is loaded from `.env` automatically by the `db:*` scripts.
- **Migrations**: create with `npx prisma migrate dev --schema packages/database/schema.prisma --name <name>`. Never use `db push`.
- **Dev server is already running** — don't start it. Dev logs at `/tmp/classmoji-dev.log`.
- **Auth**: every new loader/action must use a helper from `~/utils/routeAuth.server.ts`. No bare routes.
- **Dark mode is mandatory**: use Tailwind `dark:` variants on every new UI surface.
- **Frequent commits**: one commit per task. Use conventional-commit style (`feat(webapp): …`, `feat(services): …`).
- Ship Phase N in its own PR when possible.

---

## Phase 1 — GitHub Analytics Foundation

### Task 1: Prisma schema — `RepoAnalyticsSnapshot` + `RepositoryContributorLink`

**Files:**
- Modify: `packages/database/schema.prisma`
- Create: `packages/database/migrations/<timestamp>_repo_analytics/migration.sql` (auto-generated)

**Step 1: Add the models**

In `packages/database/schema.prisma`, add after `RepositoryAssignment`:

```prisma
model RepoAnalyticsSnapshot {
  id                       String   @id @default(uuid())
  repository_assignment_id String   @unique
  repository_assignment    RepositoryAssignment @relation(fields: [repository_assignment_id], references: [id], onDelete: Cascade)
  fetched_at               DateTime
  default_branch           String?
  total_commits            Int      @default(0)
  total_additions          Int      @default(0)
  total_deletions          Int      @default(0)
  first_commit_at          DateTime?
  last_commit_at           DateTime?
  commits                  Json
  contributors             Json
  languages                Json
  pr_summary               Json
  stale                    Boolean  @default(false)
  error                    String?

  @@index([fetched_at])
  @@map("repo_analytics_snapshots")
}

model RepositoryContributorLink {
  id            String   @id @default(uuid())
  repository_id String
  repository    Repository @relation(fields: [repository_id], references: [id], onDelete: Cascade)
  github_login  String
  user_id       String?
  user          User?    @relation(fields: [user_id], references: [id], onDelete: SetNull)
  created_at    DateTime @default(now())

  @@unique([repository_id, github_login])
  @@index([user_id])
  @@map("repository_contributor_links")
}
```

Also add the inverse relations:
- On `RepositoryAssignment`: `analytics_snapshot RepoAnalyticsSnapshot?`
- On `Repository`: `contributor_links RepositoryContributorLink[]`
- On `User`: `contributor_links RepositoryContributorLink[]`

**Step 2: Generate migration**

```bash
cat .dev-context   # verify DB
npx prisma migrate dev --schema packages/database/schema.prisma --name repo_analytics
```

Expected: migration file created + applied, `prisma generate` runs.

**Step 3: Verify**

```bash
psql "$DATABASE_URL" -c "\d repo_analytics_snapshots" \
  && psql "$DATABASE_URL" -c "\d repository_contributor_links"
```

Expected: both tables exist with the columns above.

**Step 4: Commit**

```bash
git add packages/database/schema.prisma packages/database/migrations/
git commit -m "feat(database): add repo_analytics_snapshots + repository_contributor_links"
```

---

### Task 2: Type the snapshot JSON payloads

**Files:**
- Create: `packages/services/src/classmoji/repoAnalytics.types.ts`

**Step 1: Write the types**

```ts
export type CommitRecord = {
  sha: string;
  author_login: string | null;
  author_email: string | null;
  author_user_id: string | null;
  ts: string; // ISO
  message: string;
  additions: number;
  deletions: number;
  parents: string[];
};

export type ContributorRecord = {
  login: string;
  user_id: string | null;
  commits: number;
  additions: number;
  deletions: number;
};

export type LanguagesMap = Record<string, number>;

export type PRSummary = { open: number; merged: number; closed: number };

export type SnapshotPayload = {
  commits: CommitRecord[];
  contributors: ContributorRecord[];
  languages: LanguagesMap;
  pr_summary: PRSummary;
};
```

**Step 2: Export from package index**

Add to `packages/services/src/index.ts`:

```ts
export * from './classmoji/repoAnalytics.types.ts';
```

**Step 3: Typecheck**

```bash
npm run typecheck -w @classmoji/services
```

Expected: clean.

**Step 4: Commit**

```bash
git commit -am "feat(services): add RepoAnalyticsSnapshot payload types"
```

---

### Task 3: `GitHubProvider.listCommits`

**Files:**
- Modify: `packages/services/src/git/GitProvider.ts`
- Modify: `packages/services/src/git/GitHubProvider.ts`
- Modify: `packages/services/src/git/GitLabProvider.ts` (stub)
- Test: `packages/services/src/git/__tests__/GitHubProvider.listCommits.test.ts`

**Step 1: Write the failing test** (Vitest with nock or a mocked Octokit)

```ts
import { describe, it, expect, vi } from 'vitest';
import { GitHubProvider } from '../GitHubProvider.ts';

describe('GitHubProvider.listCommits', () => {
  it('returns commits with additions/deletions by paginating until since', async () => {
    const provider = new GitHubProvider('1');
    // @ts-expect-error — injecting a fake octokit
    provider._octokit = {
      paginate: { iterator: vi.fn() },
      rest: {
        repos: {
          listCommits: vi.fn().mockResolvedValue({
            data: [{
              sha: 'a', commit: {
                author: { date: '2026-01-01T00:00:00Z' },
                message: 'init',
              }, parents: [], author: { login: 'ada' },
              stats: { additions: 5, deletions: 1 },
            }],
          }),
          getCommit: vi.fn().mockResolvedValue({
            data: { stats: { additions: 5, deletions: 1 } },
          }),
        },
      },
    };
    const out = await provider.listCommits('org', 'repo', {});
    expect(out[0].sha).toBe('a');
    expect(out[0].additions).toBe(5);
    expect(out[0].author_login).toBe('ada');
  });
});
```

**Step 2: Run — expect FAIL** (`listCommits is not a function`):

```bash
npx vitest run packages/services/src/git/__tests__/GitHubProvider.listCommits.test.ts
```

**Step 3: Add abstract to `GitProvider`**

```ts
async listCommits(_org: string, _repo: string, _opts?: { since?: string; branch?: string }): Promise<import('../classmoji/repoAnalytics.types.ts').CommitRecord[]> {
  throw new Error('listCommits() must be implemented by subclass');
}
```

**Step 4: Implement in `GitHubProvider`**

```ts
async listCommits(org, repo, opts = {}) {
  const octokit = await this.#getOctokit();
  const commits: CommitRecord[] = [];
  for await (const { data } of octokit.paginate.iterator(
    octokit.rest.repos.listCommits,
    { owner: org, repo, sha: opts.branch, since: opts.since, per_page: 100 },
  )) {
    for (const c of data) {
      // listCommits omits stats; fetch once per commit for additions/deletions
      const { data: full } = await octokit.rest.repos.getCommit({ owner: org, repo, ref: c.sha });
      commits.push({
        sha: c.sha,
        author_login: c.author?.login ?? null,
        author_email: c.commit.author?.email ?? null,
        author_user_id: null,
        ts: c.commit.author?.date ?? new Date().toISOString(),
        message: c.commit.message ?? '',
        additions: full.stats?.additions ?? 0,
        deletions: full.stats?.deletions ?? 0,
        parents: (c.parents ?? []).map(p => p.sha),
      });
    }
  }
  return commits;
}
```

**Step 5: Stub GitLab**

`GitLabProvider.listCommits` throws `NotImplemented`.

**Step 6: Run — expect PASS**

```bash
npx vitest run packages/services/src/git/__tests__/GitHubProvider.listCommits.test.ts
```

**Step 7: Commit**

```bash
git commit -am "feat(services): GitHubProvider.listCommits"
```

---

### Task 4: `GitHubProvider.getContributorStats`

**Files:**
- Modify: `packages/services/src/git/GitHubProvider.ts`
- Test: `packages/services/src/git/__tests__/GitHubProvider.getContributorStats.test.ts`

**Step 1: Write tests (2 cases)**

```ts
it('returns { pending: true } when GitHub responds 202', async () => { /* mock status 202 */ });
it('maps contributor stats into ContributorRecord[]', async () => { /* mock 200 w/ author+total */ });
```

**Step 2: Implement**

```ts
async getContributorStats(org, repo): Promise<{ pending: true } | ContributorRecord[]> {
  const octokit = await this.#getOctokit();
  const res = await octokit.request('GET /repos/{owner}/{repo}/stats/contributors',
    { owner: org, repo });
  if (res.status === 202) return { pending: true };
  return (res.data ?? []).map(row => ({
    login: row.author?.login ?? 'unknown',
    user_id: null,
    commits: row.total,
    additions: row.weeks.reduce((s, w) => s + w.a, 0),
    deletions: row.weeks.reduce((s, w) => s + w.d, 0),
  }));
}
```

**Step 3: Run → PASS. Commit.**

```bash
npx vitest run packages/services/src/git/__tests__/GitHubProvider.getContributorStats.test.ts
git commit -am "feat(services): GitHubProvider.getContributorStats with 202 handling"
```

---

### Task 5: `GitHubProvider.getLanguages` + `listPulls`

**Files:** same as Task 4.

**Test + impl pattern identical.** Keep `listPulls` summary-only:

```ts
async listPulls(org, repo): Promise<PRSummary> {
  const octokit = await this.#getOctokit();
  const { data } = await octokit.rest.pulls.list({ owner: org, repo, state: 'all', per_page: 100 });
  return data.reduce<PRSummary>((acc, pr) => {
    if (pr.state === 'open') acc.open += 1;
    else if (pr.merged_at) acc.merged += 1;
    else acc.closed += 1;
    return acc;
  }, { open: 0, merged: 0, closed: 0 });
}
```

Commit: `feat(services): GitHubProvider.getLanguages + listPulls`.

---

### Task 6: `RepoAnalytics` service — snapshot build + author linking

**Files:**
- Create: `packages/services/src/classmoji/repoAnalytics.service.ts`
- Test: `packages/services/src/classmoji/__tests__/repoAnalytics.service.test.ts`

**Step 1: Write tests for the pure linker**

```ts
describe('linkAuthorsToUsers', () => {
  it('maps author_login to user_id via User.login', async () => {
    const commits = [{ sha: 'a', author_login: 'ada', /* … */ }];
    const out = linkAuthorsToUsers(commits, new Map([['ada', 'user-1']]));
    expect(out[0].author_user_id).toBe('user-1');
  });
  it('leaves unknown logins null', () => { /* … */ });
});
```

**Step 2: Implement**

```ts
export function linkAuthorsToUsers(commits: CommitRecord[], loginToUserId: Map<string, string>): CommitRecord[] {
  return commits.map(c => ({
    ...c,
    author_user_id: c.author_login ? (loginToUserId.get(c.author_login) ?? null) : null,
  }));
}

export async function buildSnapshot(repositoryAssignmentId: string, provider: GitProvider): Promise<SnapshotPayload> { /* … */ }

export async function upsertSnapshot(prisma, repositoryAssignmentId, payload, opts): Promise<void> { /* … */ }
```

**Step 3: Run tests → PASS. Commit.**

`feat(services): repoAnalytics service (build + upsert + author link)`

---

### Task 7: Trigger.dev workflow — refresh snapshot

**Files:**
- Create: `packages/tasks/src/workflows/repoAnalytics.ts`
- Modify: `packages/tasks/src/workflows/index.ts` (export)

**Step 1: Implement**

```ts
import { task } from '@trigger.dev/sdk/v3';
import { ClassmojiService } from '@classmoji/services';

export const refreshRepoAnalytics = task({
  id: 'refresh-repo-analytics',
  retry: { maxAttempts: 3 },
  run: async ({ repositoryAssignmentId }: { repositoryAssignmentId: string }) => {
    const result = await ClassmojiService.repoAnalytics.refreshOne(repositoryAssignmentId);
    if (result.stale) {
      // Contributor stats pending — reschedule self in 60s
      await refreshRepoAnalytics.trigger({ repositoryAssignmentId }, { delay: '60s' });
    }
    return result;
  },
});

export const refreshAllActive = task({
  id: 'refresh-repo-analytics-all',
  run: async () => {
    const ids = await ClassmojiService.repoAnalytics.listActiveAssignmentIds();
    for (const id of ids) await refreshRepoAnalytics.trigger({ repositoryAssignmentId: id });
  },
});
```

**Step 2: Register 6h cron** in `packages/tasks/trigger.config.js`:

```js
schedules: [{ task: 'refresh-repo-analytics-all', cron: '0 */6 * * *' }]
```

**Step 3: Smoke with `npm run trigger:dev`** (run one ad-hoc invoke in the dashboard).

Expected: snapshot row exists for the test repo; `psql "$DATABASE_URL" -c "SELECT total_commits FROM repo_analytics_snapshots LIMIT 5;"` returns rows.

**Step 4: Commit** — `feat(tasks): refresh-repo-analytics workflow + 6h cron`.

---

### Task 8: API route — on-demand refresh

**Files:**
- Create: `apps/webapp/app/routes/api.repos.$id.refresh/route.ts`

**Step 1: Write Playwright smoke test** `apps/webapp/tests/owner/repo-refresh.spec.ts` — POSTs as admin, expects 200 with `{ enqueued: true }`.

**Step 2: Implement**

```ts
import { assertClassroomAccess } from '~/utils/routeAuth.server';
import { tasks } from '@trigger.dev/sdk/v3';
import type { Route } from './+types/route';

export const action = async ({ params, request }: Route.ActionArgs) => {
  await assertClassroomAccess(request, {
    resourceType: 'REPOSITORY_ASSIGNMENT',
    resourceId: params.id!,
    selfAccessRoles: ['admin', 'assistant'],
    action: 'refresh_repo_analytics',
  });
  const handle = await tasks.trigger('refresh-repo-analytics', { repositoryAssignmentId: params.id });
  return { enqueued: true, job_id: handle.id };
};
```

**Step 3: Run Playwright — PASS. Commit.**

`feat(webapp): POST /api/repos/:id/refresh`

---

## Phase 2 — Per-Submission Deep-Dive

### Task 9: Pure analytics helpers (late-commit, mega-commit, commit quality, bus factor)

**Files:**
- Create: `packages/services/src/classmoji/repoAnalytics.flags.ts`
- Test: `packages/services/src/classmoji/__tests__/repoAnalytics.flags.test.ts`

Tests first — minimum five:
1. `lateCommitRatio(commits, deadline)` — returns 0 when no commits after deadline.
2. `isMegaCommit(commit, total)` — true when >40%.
3. `commitMessageQuality(message)` — 0–1 score; penalize "update", "fix", <10 chars.
4. `busFactor(contributors)` — returns `{ login, share }` of max; `null` if only one contributor.
5. `dumpAndRun(commits, deadline)` — true when first commit < 24h before deadline.

Implement as pure functions. Commit: `feat(services): repoAnalytics flags/heuristics`.

---

### Task 10: `GitHubStatsPanel` component (summary row + timeline)

**Files:**
- Create: `apps/webapp/app/components/features/analytics/GitHubStatsPanel.tsx`
- Create: `apps/webapp/app/components/features/analytics/CommitTimeline.tsx`
- Test: `apps/webapp/tests/grading/github-stats-panel.spec.ts`

**Step 1: Playwright test** renders a stubbed route fixture with a snapshot and verifies: summary numbers, timeline SVG visible, deadline reference line present.

**Step 2: Implement summary row** — flex card with Ant Statistic or your existing `StatsCard`. Tailwind with `dark:` variants. No avatars.

**Step 3: Implement `CommitTimeline`** — Recharts `AreaChart` with `ReferenceLine x={deadline}`. Bucket by day client-side from `commits[].ts`.

**Step 4: Run Playwright — PASS. Commit.**

`feat(webapp): GitHubStatsPanel + commit timeline`

---

### Task 11: Anomaly badges + mount on submission routes

**Files:**
- Create: `apps/webapp/app/components/features/analytics/Anomalies.tsx`
- Modify: admin submission route (`apps/webapp/app/routes/admin.$class.modules_.$title/route.tsx`) — mount `<GitHubStatsPanel>` when snapshot present.
- Modify: TA grading route (`apps/webapp/app/components/features/grading/...` — consult the `GradingScreen` loader for wiring).

**Step 1**: Loader reads snapshot:

```ts
const snapshot = await prisma.repoAnalyticsSnapshot.findUnique({
  where: { repository_assignment_id: repoAssignmentId },
});
```

**Step 2**: `<Anomalies>` receives snapshot + deadline, renders chip row using Task 9 helpers.

**Step 3**: "Refresh" button posts to `/api/repos/:id/refresh` (Task 8); shows toast + `revalidator.revalidate()`.

**Step 4**: Playwright spec covers stale snapshot → refresh click → revalidate.

Commit: `feat(webapp): anomaly chips + refresh action on submission view`.

---

### Task 12: Grading queue chips

**Files:**
- Modify: `apps/webapp/app/components/features/grading/**` queue card component.
- Modify: its loader to include lightweight snapshot summary (select: total_commits, last_commit_at, any flags).

Render compact chips — reuse Task 9 helpers from server-computed summary. No charts here.

Playwright: queue spec asserts chip presence when snapshot flags are set.

Commit: `feat(webapp): grading queue anomaly chips`.

---

## Phase 3 — Multi-Contributor Views

### Task 13: Contributor aggregation helpers

**Files:**
- Modify: `packages/services/src/classmoji/repoAnalytics.flags.ts` (add `aggregateByContributor`, `commitsPerDayByContributor`).
- Test: append cases to flags test file.

Pure, unit-tested. Commit: `feat(services): per-contributor aggregates`.

---

### Task 14: `ContributorBreakdown` component

**Files:**
- Create: `apps/webapp/app/components/features/analytics/ContributorBreakdown.tsx`
- Test: `apps/webapp/tests/grading/contributor-breakdown.spec.ts`

Two pies (`PieChart` with `<Pie dataKey="value">`) side-by-side for commit% and lines%. Below, a `BarChart` stacked by contributor across days. Use a shared color map keyed by `author_login`.

Unmatched-contributor list at the bottom with "Link to student" button (opens a modal with a student search; wired in Task 15).

Mount inside `GitHubStatsPanel` behind `contributors.length > 1`.

Commit: `feat(webapp): ContributorBreakdown with pies + stacked timeline`.

---

### Task 15: Link unmatched contributor → student

**Files:**
- Create: `apps/webapp/app/routes/api.repos.$id.contributor-link/route.ts`
- Modify: `ContributorBreakdown.tsx` modal.
- Create: service helper `ClassmojiService.repoAnalytics.linkContributor(repoId, login, userId)`.

**Action** upserts `RepositoryContributorLink`. Validates user is a member of the same classroom. Auth: admin-or-assistant-assigned-to-repo.

Playwright: link a student, verify pie updates on next load.

Commit: `feat(webapp): link unmatched contributor to student`.

---

### Task 16: Teams "Contributions" tab

**Files:**
- Modify: `apps/webapp/app/routes/admin.$class.teams.$slug.edit/route.tsx` (add tab) OR create a dedicated route if teams use a layout route.
- New service helper: `repoAnalytics.aggregateForTeam(teamId)`.

Aggregate across all team repos: one combined pie, per-member totals table, team-wide timeline. Reuses Task 14 components.

Commit: `feat(webapp): team contributions tab`.

---

## Phase 4 — Owner Dashboard Rebuild

### Task 17: `dashboard.service` — cohort + assignment aggregates

**Files:**
- Create: `packages/services/src/classmoji/dashboard.service.ts`
- Test: `packages/services/src/classmoji/__tests__/dashboard.service.test.ts`

Implement:
- `cohortOverview(classroomId)` → `{ active, inactive, medianGrade, atRiskCount }`. Active = quiz attempt or commit in 14d.
- `assignmentHealth(classroomId)` → per-assignment `{ submissionRate, medianGrade, medianTTG, regradeRate }`.
- `taOps(classroomId)` → per-TA throughput, avgTTG, overturnRate.
- `quizAnalytics(classroomId)` → hardest questions, avgFocusPct.
- `deadlinePressure(classroomId)` → next 7 days.

Prefer `$queryRawUnsafe` with parameterized args for the heavy aggregates; simpler ones can use Prisma.

Each function tested against a seeded fixture. Commit per function is fine.

---

### Task 18: Owner dashboard UI

**Files:**
- Modify: `apps/webapp/app/routes/admin.$class.dashboard/route.tsx`
- Modify/reuse: `admin.$class.dashboard/SubmissionChart.tsx` and `Leaderboard.tsx` (already present, currently unmounted).
- Create: `apps/webapp/app/components/features/dashboard/AssignmentHeatmap.tsx`, `TAOpsTable.tsx`, `AtRiskStudents.tsx`, `QuizAnalytics.tsx`, `DeadlinePressure.tsx`.

**Layout**:
- Row 1 — four `StatsCard`s.
- Row 2 — `SubmissionChart` (existing) | `AssignmentHeatmap` (new Recharts `ScatterChart` with colored dots, or a hand-rolled Tailwind grid).
- Row 3 — `TAOpsTable` | `AtRiskStudents`.
- Row 4 — `QuizAnalytics` | `DeadlinePressure`.

All sections Suspense-wrapped with `<Await>`; loader returns `Promise.all(...)`.

Extend `apps/webapp/tests/owner/dashboard.spec.ts` with selectors for each section.

Commit: `feat(webapp): owner dashboard v2 (cohort, heatmap, TA ops, quiz, deadlines)`.

---

## Phase 5 — TA Personal Cockpit

### Task 19: `taDashboard.service` — personal aggregates

**Files:**
- Create: `packages/services/src/classmoji/taDashboard.service.ts`
- Test: colocated.

Implement:
- `personalThroughput(userId, classroomId)` → 7-day sparkline.
- `gradingStreak(userId, classroomId)` → consecutive days with ≥1 grade.
- `overdueQueue(userId, classroomId)` → queue items > 3 days unopened.
- `personalGradeDistribution(userId, classroomId)` → histogram.

Commit per.

---

### Task 20: TA dashboard UI upgrade

**Files:**
- Modify: `apps/webapp/app/routes/assistant.$class_.dashboard/route.tsx`
- Create: `apps/webapp/app/components/features/dashboard/MyDayQueue.tsx`, `ThroughputSparkline.tsx`, `StreakBadge.tsx`, `OwnVsClassHistogram.tsx`.

Keep existing `StatsCard` / `StatsGradingProgress` / `TAGradingLeaderboard`. Add "My day" as the top panel; sparkline + streak above the leaderboard.

Add `apps/webapp/tests/assistant/dashboard.spec.ts` — smoke + assert throughput sparkline renders.

Commit: `feat(webapp): TA cockpit (my day, throughput, streak, own-vs-class)`.

---

## Finishing

### Task 21: Documentation + backfill

**Files:**
- Modify: `AGENTS.md` — new "Analytics" section linking to the design doc, explaining the snapshot / link tables and the refresh workflow.
- Add: one-off backfill script `packages/database/scripts/backfillRepoAnalytics.ts` that enqueues `refresh-repo-analytics-all` for every active classroom (or runs inline for local dev).

Commit: `docs(agents): analytics section + backfill script`.

### Task 22: Full verification

**Step 1**: `npm run typecheck` — clean.
**Step 2**: `npm run test` — clean.
**Step 3**: `npm run web:test -- --grep "dashboard|github-stats|contributor"` — green.
**Step 4**: Open the app (dev already running), walk:
  - Owner dashboard renders all four rows.
  - Open a single submission → `GitHubStatsPanel` shows commits, timeline, deadline line.
  - Multi-contributor submission → two pies + stacked timeline.
  - Unlinked login → "Link to student" modal works, pie updates.
  - Refresh button → toast → data refetched.
  - TA dashboard shows My Day / streak / sparkline.
  - All views pass in both light and dark mode.

**Step 5**: PR or merge per `superpowers:finishing-a-development-branch`.

---

## Deferred (not in this plan)

- Webhook-driven cache invalidation via `hook-station`.
- Cross-repo language leaderboards / classroom-wide materialized aggregates.
- Persisting `last_graded_sha` on `AssignmentGrade` for "changes since last grade" diffs.
- Per-classroom tunable refresh cadence UI.
