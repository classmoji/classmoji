/**
 * GitHub Classroom REST API client + normalizer.
 *
 * Pulls a teacher's classroom data live (instead of from an uploaded export ZIP)
 * and normalizes it into the exact `ImportClassroomInput` shape that
 * `githubClassroomImport.service.ts` already consumes — so the importer, its
 * metadata builder, and team-slug derivation are reused untouched.
 *
 * Auth: every call uses the logged-in user's GitHub App user access token. All
 * six Classroom endpoints are on GitHub's allowlist of "endpoints available for
 * GitHub App user access tokens", and each only returns classrooms where that
 * user is an administrator — which is exactly the scope we want.
 *
 * Two phases (the webapp fetches them separately):
 *   1. `listAdminClassrooms` — cheap: just the classrooms the user can import.
 *   2. `buildClassroomImportInput` — heavy: one classroom's assignments,
 *      submissions, and grades, normalized for the importer.
 */

import { GitHubProvider } from '../git/index.ts';
import type {
  ImportClassroom,
  ImportClassroomInput,
  ImportAssignment,
  ImportAcceptance,
  ImportStudent,
  ImportGradeRow,
} from './githubClassroomImport.service.ts';

// ── Raw API response shapes (the Classroom endpoints aren't in Octokit's types) ──

interface RawClassroomListItem {
  id: number;
  name: string;
  archived: boolean;
}

interface RawClassroomDetail {
  id: number;
  name: string;
  archived: boolean;
  organization?: { id: number; login: string } | null;
}

interface RawAssignmentListItem {
  id: number;
  title: string;
  slug?: string;
  type?: string;
  deadline?: string | null;
}

interface RawAssignmentDetail extends RawAssignmentListItem {
  starter_code_repository?: { full_name?: string } | null;
}

interface RawAcceptedAssignment {
  submitted?: boolean;
  passing?: boolean;
  commit_count?: number;
  grade?: string | null;
  students?: Array<{ id: number; login: string; name?: string | null; avatar_url?: string }>;
  // The Classroom API returns `full_name` (owner/repo); the short `name` the
  // importer wants is derived from it. `name` kept optional for fixtures/robustness.
  repository?: { id: number; full_name?: string; name?: string; html_url?: string } | null;
}

interface RawGradeRow {
  assignment_name?: string;
  github_username?: string;
  points_awarded?: string | number;
  points_available?: string | number;
  submission_timestamp?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const emptyToNull = (v: unknown): string | null => {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
};

const normalizeType = (t: unknown): 'individual' | 'group' =>
  String(t ?? 'individual').toLowerCase() === 'group' ? 'group' : 'individual';

// ── Phase 1: cheap classroom list ─────────────────────────────────────────────

export interface ListedClassroom {
  githubId: number;
  name: string;
  archived: boolean;
  /** null only if the classroom has no organization (can't be imported). */
  organization: { id: number; login: string } | null;
}

/**
 * List the classrooms the authenticated user administers, enriched with their
 * organization (needed for slug-collision checks and the import).
 *
 * "Cheap" relative to phase 2: the list is one paginated call, plus one detail
 * call per classroom for the org (batched). Assignments, submissions, and grades
 * — the heavy part — are deferred to `buildClassroomImportInput` in the job.
 */
export async function listAdminClassrooms(token: string): Promise<ListedClassroom[]> {
  const octokit = GitHubProvider.getUserOctokit(token);
  const rows = (await octokit.paginate('GET /classrooms', {
    per_page: 100,
  })) as RawClassroomListItem[];

  const result: ListedClassroom[] = [];
  // Fetch org details in small batches to stay clear of secondary rate limits.
  const BATCH = 8;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const details = await Promise.all(
      batch.map(c =>
        octokit
          .request('GET /classrooms/{classroom_id}', { classroom_id: c.id })
          .then(r => r.data as RawClassroomDetail)
          .catch(() => null)
      )
    );
    batch.forEach((c, j) => {
      const org = details[j]?.organization;
      result.push({
        githubId: c.id,
        name: c.name,
        archived: Boolean(c.archived),
        organization: org ? { id: org.id, login: org.login } : null,
      });
    });
  }
  return result;
}

// ── Phase 2: heavy per-classroom fetch + normalize ────────────────────────────

/**
 * Fetch and normalize one classroom into the importer's `ImportClassroomInput`.
 *
 * @param onProgress optional callback (e.g. to push Trigger.dev run metadata)
 *   called as each assignment finishes: (done, total).
 * @throws if the classroom has no organization (can't be imported without it).
 */
export async function buildClassroomImportInput(
  token: string,
  classroomId: number,
  slug: string,
  onProgress?: (done: number, total: number) => void | Promise<void>
): Promise<ImportClassroomInput> {
  const octokit = GitHubProvider.getUserOctokit(token);

  const { data: detail } = (await octokit.request('GET /classrooms/{classroom_id}', {
    classroom_id: classroomId,
  })) as { data: RawClassroomDetail };

  const org = detail.organization;
  if (!org) {
    throw new Error(
      `Classroom "${detail.name}" has no organization information and can't be imported.`
    );
  }

  const assignmentRefs = (await octokit.paginate('GET /classrooms/{classroom_id}/assignments', {
    classroom_id: classroomId,
    per_page: 100,
  })) as RawAssignmentListItem[];

  const assignments: ImportAssignment[] = [];
  const grades: ImportGradeRow[] = [];
  const total = assignmentRefs.length;
  let done = 0;

  for (const ref of assignmentRefs) {
    // The detail call carries `starter_code_repository`, which the list omits.
    // Submissions and grades are independent, so fetch all three concurrently.
    const [detailRes, accepted, gradeRows] = await Promise.all([
      octokit
        .request('GET /assignments/{assignment_id}', { assignment_id: ref.id })
        .then(r => r.data as RawAssignmentDetail)
        .catch(() => ref as RawAssignmentDetail),
      octokit.paginate('GET /assignments/{assignment_id}/accepted_assignments', {
        assignment_id: ref.id,
        per_page: 100,
      }) as Promise<RawAcceptedAssignment[]>,
      (
        octokit.request('GET /assignments/{assignment_id}/grades', {
          assignment_id: ref.id,
        }) as Promise<{ data: RawGradeRow[] }>
      )
        .then(r => r.data)
        .catch(() => [] as RawGradeRow[]),
    ]);

    const type = normalizeType(detailRes.type ?? ref.type);
    const title = detailRes.title ?? ref.title;

    const acceptances: ImportAcceptance[] = (Array.isArray(accepted) ? accepted : []).map(acc => {
      const students: ImportStudent[] = (acc.students ?? []).map(s => ({
        providerId: String(s.id),
        login: s.login,
        name: emptyToNull(s.name),
        avatarUrl: emptyToNull(s.avatar_url),
      }));
      const repoName = acc.repository
        ? (acc.repository.full_name?.split('/').pop() ?? acc.repository.name ?? '')
        : '';
      return {
        type,
        students,
        repo: acc.repository
          ? {
              providerId: String(acc.repository.id),
              name: repoName,
              htmlUrl: emptyToNull(acc.repository.html_url),
            }
          : null,
        commitCount: typeof acc.commit_count === 'number' ? acc.commit_count : null,
        submitted: Boolean(acc.submitted),
        passing: Boolean(acc.passing),
        grade: emptyToNull(acc.grade ?? null),
      };
    });

    assignments.push({
      githubId: ref.id,
      title,
      slug: detailRes.slug ?? ref.slug ?? '',
      type,
      deadline: emptyToNull(detailRes.deadline ?? ref.deadline ?? null),
      starterRepoFullName: detailRes.starter_code_repository?.full_name ?? '',
      acceptances,
    });

    // Grades are aggregated at the classroom level (the importer indexes them by
    // `${login}::${assignmentTitle}`). Keep only rows with a real username.
    for (const row of Array.isArray(gradeRows) ? gradeRows : []) {
      const username = (row.github_username ?? '').trim();
      if (!username) continue;
      grades.push({
        assignmentTitle: (row.assignment_name ?? title ?? '').trim(),
        githubUsername: username,
        pointsAwarded: emptyToNull(row.points_awarded) ?? '0',
        pointsAvailable: emptyToNull(row.points_available) ?? '0',
        submissionTimestamp: emptyToNull(row.submission_timestamp),
      });
    }

    done += 1;
    if (onProgress) await onProgress(done, total);
  }

  const classroom: ImportClassroom = {
    githubId: detail.id,
    name: detail.name,
    archived: Boolean(detail.archived),
    organization: { id: org.id, login: org.login },
    assignments,
    grades,
  };

  return { classroom, slug };
}
