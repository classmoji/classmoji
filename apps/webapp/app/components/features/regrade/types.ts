/**
 * A regrade/resubmit request row as the requests pages receive it
 * (`~/utils/regradeRequestRows.server`). Exactly one of `git_repo_assignment`
 * (a repo request) and `quiz` (a quiz request) is set.
 */
export interface RegradeGrade {
  id: string;
  emoji: string;
  grader?: { name: string | null } | null;
}

export interface RegradeRepoSubmission {
  id: string;
  assignment: { title: string; [key: string]: unknown };
  git_repo: { name: string; [key: string]: unknown } | null;
  grades: RegradeGrade[];
  provider_issue_number?: number | null;
  [key: string]: unknown;
}

/** A quiz request's attempt, emoji only (no number reaches the page). */
export interface RegradeQuizAttempt {
  attemptId: string;
  attemptNumber: number;
  quizId: string;
  quizName: string;
  assignmentTitle: string | null;
  originalEmoji: string | null;
  effectiveEmoji: string | null;
  adjusted: boolean;
  adjustedByName: string | null;
  adjustedAt: string | Date | null;
  /** Staff rows, open requests: the attempt's whole hours late. */
  lateHours?: number;
  /** Staff rows, open requests: the current grade after the late penalty. */
  countedEmoji?: string | null;
}

export interface RegradeRequestRowData {
  id: string;
  status: 'IN_REVIEW' | 'APPROVED' | 'DENIED' | string;
  student_id: string;
  student: {
    name: string | null;
    login: string | null;
    image?: string | null;
    _count: { regrade_requests: number };
  };
  git_repo_assignment: RegradeRepoSubmission | null;
  quiz: RegradeQuizAttempt | null;
  previous_grade: string[];
  student_comment: string | null;
  grader_comment: string | null;
  /** Who resolved it (name only); null while open and on rows resolved before it was recorded. */
  resolved_by_name?: string | null;
  resolved_at?: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** A quiz request as its row names it: "<quiz name> · Attempt N". */
export const quizRequestLabel = (quiz: RegradeQuizAttempt) =>
  `${quiz.quizName} · Attempt ${quiz.attemptNumber}`;
