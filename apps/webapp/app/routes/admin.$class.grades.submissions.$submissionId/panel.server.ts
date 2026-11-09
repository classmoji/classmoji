import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import {
  gitUsername,
  submissionCutoffMs,
  submittedCommit,
  type SubmittedCommit,
} from '@classmoji/utils';

/**
 * Everything the gradebook's submission panel renders, for one submission in
 * one classroom, and nothing more: the payload is serialised to the page.
 * Null when the submission is not in `classroomId` (the id comes from the
 * URL, so it is matched against the classroom inside the query).
 */
export interface SubmissionPanelData {
  submission: {
    id: string;
    status: string;
    closed_at: Date | null;
    provider_issue_number: number | null;
    is_late: boolean;
    is_late_override: boolean;
    num_late_hours: number;
    extension_hours: number;
    repo_name: string;
    /** The grade API's recipient fields (it re-derives them; the picker sends them). */
    student_id: string | null;
    team_id: string | null;
    grades: {
      id: string;
      emoji: string;
      grader_id: string | null;
      grader: { id: string; name: string | null } | null;
    }[];
    graders: { id: string; name: string | null }[];
  };
  who:
    | {
        kind: 'student';
        id: string;
        name: string | null;
        login: string | null;
        avatar_url: string | null;
      }
    | {
        kind: 'team';
        id: string;
        name: string;
        members: { id: string; name: string | null; login: string | null }[];
      };
  assignment: {
    id: string;
    title: string;
    weight: number;
    is_extra_credit: boolean;
    submission_mode: string;
    student_deadline: Date | null;
    module_title: string | null;
    /** The assignment's first linked page in this classroom: its instructions. */
    instructions: { id: string; title: string } | null;
  };
  analytics: {
    total_commits: number;
    total_additions: number;
    total_deletions: number;
    last_commit_at: Date | null;
    /** `login` is null where the provider gave an email address in its place. */
    contributors: { login: string | null; user_id: string | null; commits: number }[];
  } | null;
  /** Push mode: the newest commit at or before the deadline plus extension hours. */
  submitted_commit: SubmittedCommit | null;
  autograding: {
    conclusion: string;
    passed_tests: number | null;
    total_tests: number | null;
    run_id: string | null;
    commit_sha: string;
  } | null;
  open_regrade: {
    id: string;
    student_comment: string | null;
    previous_grade: string[];
    created_at: Date;
  } | null;
}

/**
 * The snapshot's contributors, by login and commit count. A provider without a
 * username for an author fills the login with the author's email (Github) or
 * name-or-email (Gitlab): an address is never sent, only its commit count.
 */
const contributorsOf = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap(c =>
        c && typeof c === 'object' && typeof (c as { login?: unknown }).login === 'string'
          ? [
              {
                login: (c as { login: string }).login.includes('@')
                  ? null
                  : (c as { login: string }).login,
                user_id:
                  typeof (c as { user_id?: unknown }).user_id === 'string'
                    ? (c as { user_id: string }).user_id
                    : null,
                commits: Number((c as { commits?: unknown }).commits) || 0,
              },
            ]
          : []
      )
    : [];

export const loadSubmissionPanel = async ({
  classroomId,
  provider,
  submissionId,
}: {
  classroomId: string;
  /** The classroom's git provider: a member's login is their username there. */
  provider: string | null | undefined;
  submissionId: string;
}): Promise<SubmissionPanelData | null> => {
  const row = await getPrisma().gitRepoAssignment.findFirst({
    where: { id: submissionId, git_repo: { classroom_id: classroomId } },
    include: {
      assignment: { include: { module: { select: { title: true } } } },
      // Extension hours and lateness (the computed fields read these).
      token_transactions: true,
      grades: {
        select: {
          id: true,
          emoji: true,
          grader_id: true,
          grader: { select: { id: true, name: true } },
        },
        orderBy: { created_at: 'asc' },
      },
      graders: { select: { grader: { select: { id: true, name: true } } } },
      git_repo: {
        select: {
          id: true,
          name: true,
          student_id: true,
          team_id: true,
          // Commits dated before the repo existed are the template's.
          created_at: true,
          student: { select: { id: true, name: true, image: true, ...GIT_IDENTITY } },
          team: {
            select: {
              id: true,
              name: true,
              memberships: {
                select: { user: { select: { id: true, name: true, ...GIT_IDENTITY } } },
              },
            },
          },
        },
      },
      analytics_snapshot: {
        select: {
          total_commits: true,
          total_additions: true,
          total_deletions: true,
          last_commit_at: true,
          commits: true,
          contributors: true,
        },
      },
    },
  });
  if (!row) return null;
  // Computed at read time by the client's extension (packages/database), the
  // same values the gradebook's cells read; the base client type omits them.
  const lateness = row as typeof row & {
    is_late?: boolean;
    num_late_hours?: number;
    extension_hours?: number;
  };

  const { assignment, git_repo: repo, analytics_snapshot: snapshot } = row;
  const isPush = assignment.submission_mode === 'REPO';
  // The moment the work is read at: the submission time, else the deadline
  // plus extension hours. The commit and the autograding run both honour it.
  const cutoff = {
    closed_at: row.closed_at,
    student_deadline: assignment.student_deadline,
    token_transactions: row.token_transactions,
  };
  const submitted = isPush
    ? submittedCommit(snapshot?.commits, { ...cutoff, repo_created_at: repo.created_at })
    : null;
  const cutoffMs = submissionCutoffMs(cutoff);

  const [instructionPages, autograding, openRegrade] = await Promise.all([
    // Page links are not checked against the classroom when they are written,
    // so only this classroom's pages count.
    ClassmojiService.page.findFirstLinkedByAssignmentIds([assignment.id], { classroomId }),
    ClassmojiService.autogradingResult.findForSubmission(repo.id, {
      sha: submitted?.sha ?? null,
      cutoff: cutoffMs === null ? null : new Date(cutoffMs),
    }),
    ClassmojiService.regradeRequest.findOpenByAssignmentId(row.id),
  ]);
  const instructions = instructionPages[assignment.id] ?? null;

  const who: SubmissionPanelData['who'] = repo.team
    ? {
        kind: 'team',
        id: repo.team.id,
        name: repo.team.name,
        members: repo.team.memberships.map(({ user }) => ({
          id: user.id,
          name: user.name,
          login: gitUsername(user, provider),
        })),
      }
    : {
        kind: 'student',
        id: repo.student?.id ?? '',
        name: repo.student?.name ?? null,
        login: repo.student ? gitUsername(repo.student, provider) : null,
        avatar_url: repo.student?.image ?? null,
      };

  return {
    submission: {
      id: row.id,
      status: row.status,
      closed_at: row.closed_at,
      provider_issue_number: row.provider_issue_number,
      is_late: Boolean(lateness.is_late),
      is_late_override: row.is_late_override,
      num_late_hours: Number(lateness.num_late_hours) || 0,
      extension_hours: Number(lateness.extension_hours) || 0,
      repo_name: repo.name,
      student_id: repo.student_id,
      team_id: repo.team_id,
      grades: row.grades,
      graders: row.graders.map(g => g.grader),
    },
    who,
    assignment: {
      id: assignment.id,
      title: assignment.title,
      weight: assignment.weight,
      is_extra_credit: assignment.is_extra_credit,
      submission_mode: assignment.submission_mode,
      student_deadline: assignment.student_deadline,
      module_title: assignment.module?.title ?? null,
      instructions,
    },
    analytics: snapshot
      ? {
          total_commits: snapshot.total_commits,
          total_additions: snapshot.total_additions,
          total_deletions: snapshot.total_deletions,
          last_commit_at: snapshot.last_commit_at,
          contributors: contributorsOf(snapshot.contributors),
        }
      : null,
    submitted_commit: submitted,
    autograding: autograding
      ? {
          conclusion: autograding.conclusion,
          passed_tests: autograding.passed_tests,
          total_tests: autograding.total_tests,
          run_id: autograding.run_id,
          commit_sha: autograding.commit_sha,
        }
      : null,
    open_regrade: openRegrade
      ? {
          id: openRegrade.id,
          student_comment: openRegrade.student_comment,
          previous_grade: openRegrade.previous_grade,
          created_at: openRegrade.created_at,
        }
      : null,
  };
};
