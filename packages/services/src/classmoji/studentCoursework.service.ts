/**
 * A student's coursework, one row per assignment they can see: the student
 * Assignments page and the dashboard's Up next card.
 *
 * Rows come from the classroom's published Assignment rows, filtered by the one
 * student-visibility rule (`openToStudents` in @classmoji/utils), plus one
 * batched join per type for this student's own state:
 *
 *   - REPO: their submission row (GitRepoAssignment). A repo assignment shows
 *     only once that row exists, and carries every field the page has always
 *     shown for it (repo link, commit count, issue link, Individual/Group,
 *     grades, graders, late hours, and the submission id regrades and token
 *     extensions are keyed on).
 *   - QUIZ: their attempts, scored by the shared counting-attempt selector.
 *     Status, first match wins: Completed > In progress > Closed > Not started.
 *   - FORM: their SUBMITTED response. Status: Submitted > Closed > Not
 *     submitted, where Closed is a CLOSED form or one past its close date (the
 *     fill page treats both as closed). A PUBLIC form records no student
 *     identity, so its row carries no per-student status (only Closed once
 *     it closes) and is untracked: listed, but never counted or Up next.
 *
 * A done row (submitted, completed, or closed) sits under Completed and is
 * never Up next, so a closed row never reads as overdue.
 */

import getPrisma from '@classmoji/database';
import { isClosed, openToStudents, quizStanding, titleToIdentifier } from '@classmoji/utils';
import { pagesUrl } from '../emails/escape.ts';
import * as formResponseService from './formResponse.service.ts';
import * as helperService from './helper.service.ts';
import * as quizAttemptService from './quizAttempt.service.ts';

export type CourseworkType = 'REPO' | 'QUIZ' | 'FORM';

/**
 * Where a row stands for this student. REPO rows use NOT_SUBMITTED/SUBMITTED;
 * QUIZ rows NOT_STARTED/IN_PROGRESS/COMPLETED/CLOSED; FORM rows
 * NOT_SUBMITTED/SUBMITTED/CLOSED.
 */
export type CourseworkStatus =
  | 'NOT_SUBMITTED'
  | 'SUBMITTED'
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CLOSED';

/** What a row's button does, where it has one. */
export type CourseworkAction =
  | { kind: 'START_QUIZ'; quizId: string }
  | { kind: 'RESUME_QUIZ'; quizId: string; attemptId: string }
  | { kind: 'OPEN'; href: string }
  | { kind: 'FILL_OUT'; href: string };

/** Everything the student's repo assignment row has always shown. */
export interface RepoRowFields {
  /** The GitRepoAssignment id: what regrade requests and token extensions key on. */
  gitRepoAssignmentId: string;
  /** The student's (or their team's) own repository, or the name it will have. */
  repositoryTitle: string;
  repoUrl: string | null;
  /** Commits in the student's repo, from the last analytics refresh. */
  commitCount: number | null;
  issueUrl: string | null;
  /** INDIVIDUAL | GROUP */
  moduleType: string | null;
  gradesReleased: boolean;
  grades: { id: string; emoji: string }[];
  graders: { id: string; name: string | null }[];
  gradersSummary: string;
  numLateHours: number;
  isLateOverride: boolean;
  tokensPerHour: number;
  /** When it was submitted (the issue closed, or the counted push). */
  closedAt: string | null;
}

export interface StudentCourseworkRow {
  assignmentId: string;
  type: CourseworkType;
  /** A quiz's own name; otherwise the assignment title. */
  title: string;
  module: { id: string; title: string };
  isExtraCredit: boolean;
  /** ISO. A quiz without a due on its assignment falls back to its own; a form to its close date. */
  deadline: string | null;
  /** Null for a PUBLIC form that is still open: no per-student state exists. */
  status: CourseworkStatus | null;
  /**
   * False for a PUBLIC form: it records no student, so it has no per-student
   * state. Such a row is listed (under All only), never counted toward
   * progress, never Up next.
   */
  tracked: boolean;
  /** Nothing left to do: under Completed, never Up next. */
  done: boolean;
  /** QUIZ: the counting attempt's percentage (0-100). */
  score: number | null;
  /** QUIZ: when the counting attempt completed. */
  scoredAt: string | null;
  /** QUIZ: attempts used, and the cap (0 = unlimited). */
  attemptsUsed: number | null;
  maxAttempts: number | null;
  /** Where the row goes. */
  href: string | null;
  /** Whether `href` leaves the app (GitHub, the pages app). */
  external: boolean;
  action: CourseworkAction | null;
  repo?: RepoRowFields;
}

export interface ListForStudentInput {
  classroomId: string;
  classroomSlug: string;
  userId: string;
  /** The classroom's quiz answer, as the caller's other quiz surfaces read it. */
  quizzesVisible: boolean;
  /** The classroom's git organization, for repo links. */
  gitOrgLogin?: string | null;
  /**
   * The student's submission rows, for a caller that has already read them
   * with `helper.findAllAssignmentsForStudent` (the dashboard does, for its
   * team card), so they are not read twice. Read here when absent.
   */
  repoSubmissions?: RepoSubmission[];
  /**
   * The classroom's published assignments (`listPublishedAssignments`), for a
   * caller that started that read earlier alongside its own. Read here when
   * absent.
   */
  assignments?: CourseworkAssignment[];
  now?: Date;
}

export type RepoSubmission = Awaited<
  ReturnType<typeof helperService.findAllAssignmentsForStudent>
>[number];

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;

const repoFields = (ra: RepoSubmission, gitOrgLogin: string | null, now: Date): RepoRowFields => {
  const login = gitOrgLogin ?? ra.git_repo?.classroom?.git_organization?.login ?? null;
  // The student's own copy of the repository: with the student Repositories
  // screen gone, this row is where they reach it.
  const repoUrl =
    login && ra.git_repo?.name ? `https://github.com/${login}/${ra.git_repo.name}` : null;
  const issueUrl =
    repoUrl && ra.provider_issue_number ? `${repoUrl}/issues/${ra.provider_issue_number}` : null;
  const graders = (ra.graders ?? []).map(g => ({ id: g.grader.id, name: g.grader.name ?? null }));

  // Late hours: how many hours past the deadline the student still is, after
  // the extension hours they bought with tokens. Work not yet submitted is late
  // up to now, rounded up: that many hours bring the deadline past this
  // moment. Submitted work is late by its submission's time (the push in REPO
  // mode, the issue's close in ISSUE mode) in whole hours, which is what the
  // late penalty counts (`num_late_hours`) and what hours bought afterwards
  // pay down. Every row's hours are summed, as that field does: a cancelled
  // purchase leaves a REFUND with negative hours.
  const extensionHours = Math.max(
    0,
    (ra.token_transactions ?? []).reduce((sum, t) => sum + (t.hours_purchased ?? 0), 0)
  );
  const deadlineMs = ra.assignment?.student_deadline
    ? new Date(ra.assignment.student_deadline).getTime()
    : null;
  const isRepoMode = ra.assignment?.submission_mode === 'REPO';
  const closedAtMs = ra.closed_at ? new Date(ra.closed_at).getTime() : null;
  // A push is the submission in REPO mode; in ISSUE mode an open issue is not
  // submitted, whatever an earlier close left behind.
  const submittedAtMs = isRepoMode || ra.status !== 'OPEN' ? closedAtMs : null;
  const stillOpen = isRepoMode ? closedAtMs === null : ra.status === 'OPEN';
  const hoursPastDeadline =
    deadlineMs === null
      ? 0
      : submittedAtMs !== null
        ? Math.max(0, Math.floor((submittedAtMs - deadlineMs) / 3_600_000))
        : stillOpen
          ? Math.max(0, Math.ceil((now.getTime() - deadlineMs) / 3_600_000))
          : 0;
  const numLateHours = Math.max(0, hoursPastDeadline - extensionHours);

  return {
    gitRepoAssignmentId: ra.id,
    // Named the way GitHub does: the student's own repo when it exists,
    // otherwise the repository's slug, the prefix theirs will be cut under.
    repositoryTitle:
      ra.git_repo?.name ??
      ra.git_repo?.repository?.slug ??
      (ra.git_repo?.repository?.title ? titleToIdentifier(ra.git_repo.repository.title) : ''),
    repoUrl,
    commitCount: ra.analytics_snapshot?.total_commits ?? null,
    issueUrl,
    moduleType: ra.git_repo?.repository?.type ?? null,
    gradesReleased: Boolean(ra.assignment?.grades_released && (ra.grades?.length ?? 0) > 0),
    // A student sees grades once they are released, so only then are they sent.
    grades: ra.assignment?.grades_released
      ? (ra.grades ?? []).map(g => ({ id: g.id, emoji: g.emoji }))
      : [],
    graders,
    gradersSummary: graders
      .map(g => g.name)
      .filter(Boolean)
      .join(', '),
    numLateHours,
    isLateOverride: Boolean(ra.is_late_override),
    tokensPerHour: ra.assignment?.tokens_per_hour ?? 0,
    closedAt: iso(ra.closed_at),
  };
};

/** Current rows first, soonest due first; then done rows, latest due first. Undated rows last. */
const compareRows = (a: StudentCourseworkRow, b: StudentCourseworkRow) => {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.deadline !== b.deadline) {
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    const diff = new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
    return a.done ? -diff : diff;
  }
  return a.title.localeCompare(b.title);
};

/**
 * A classroom's published assignments, with the fields the coursework rows and
 * the visibility rule read and no more (no linked pages or decks, no
 * submission counts).
 */
export const listPublishedAssignments = (classroomId: string) =>
  getPrisma().assignment.findMany({
    where: { module: { classroom_id: classroomId }, is_published: true },
    select: {
      id: true,
      type: true,
      title: true,
      is_published: true,
      is_extra_credit: true,
      release_at: true,
      student_deadline: true,
      // A quiz takes no new attempt from its close date on.
      closes_at: true,
      quiz_id: true,
      form_id: true,
      module: { select: { id: true, title: true } },
      repository: { select: { is_published: true } },
      form: { select: { status: true } },
    },
  });

export type CourseworkAssignment = Awaited<ReturnType<typeof listPublishedAssignments>>[number];

/**
 * A join that failed: logged with what it was for, and read as empty, so the
 * rows of the other types still show.
 */
const degraded =
  <T>(what: string, context: { classroomId: string; userId: string }, empty: T) =>
  (error: unknown): T => {
    console.error(`[studentCoursework] ${what} lookup failed`, context, error);
    return empty;
  };

export const listForStudent = async ({
  classroomId,
  classroomSlug,
  userId,
  quizzesVisible,
  gitOrgLogin = null,
  repoSubmissions: givenSubmissions,
  assignments: givenAssignments,
  now = new Date(),
}: ListForStudentInput): Promise<StudentCourseworkRow[]> => {
  const assignments = (givenAssignments ?? (await listPublishedAssignments(classroomId))).filter(
    a => openToStudents(a, now, { quizzesVisible })
  );

  const quizIds = assignments.flatMap(a => (a.type === 'QUIZ' && a.quiz_id ? [a.quiz_id] : []));
  const formIds = assignments.flatMap(a => (a.type === 'FORM' && a.form_id ? [a.form_id] : []));
  const hasRepos = assignments.some(a => a.type === 'REPO');
  const context = { classroomId, userId };

  // One read per type for this student. A type whose read fails shows no rows
  // (its statuses would be guesses); the other types still show.
  const [repoSubmissions, quizJoin, formJoin] = await Promise.all([
    givenSubmissions ??
      (hasRepos
        ? helperService
            .findAllAssignmentsForStudent(userId, classroomSlug)
            .catch(degraded('repo submissions', context, [] as RepoSubmission[]))
        : ([] as RepoSubmission[])),
    quizIds.length
      ? Promise.all([
          getPrisma().quiz.findMany({
            where: { id: { in: quizIds } },
            // The quiz's own content only: its due date, publish state and
            // close date are its assignment's.
            select: {
              id: true,
              name: true,
              max_attempts: true,
              grading_strategy: true,
            },
          }),
          quizAttemptService.findForUserByQuizIds(userId, quizIds),
        ]).catch(degraded('quiz', context, null))
      : null,
    formIds.length
      ? Promise.all([
          getPrisma().form.findMany({
            where: { id: { in: formIds } },
            select: { id: true, slug: true, access: true, status: true, closes_at: true },
          }),
          formResponseService.findSubmittedForUserByFormIds(userId, formIds),
        ]).catch(degraded('form', context, null))
      : null,
  ]);
  const [quizzes, attempts] = quizJoin ?? [[], []];
  const [forms, submittedResponses] = formJoin ?? [[], []];

  // First submission row per assignment wins: the student's own before their
  // team's, the order findAllAssignmentsForStudent returns them in.
  const submissionByAssignment = new Map<string, RepoSubmission>();
  for (const ra of repoSubmissions) {
    if (ra.assignment_id && !submissionByAssignment.has(ra.assignment_id)) {
      submissionByAssignment.set(ra.assignment_id, ra);
    }
  }
  const quizById = new Map(quizzes.map(q => [q.id, q]));
  const formById = new Map(forms.map(f => [f.id, f]));
  const submittedFormIds = new Set(submittedResponses.map(r => r.form_id));
  const pagesBase = pagesUrl();

  const rows: StudentCourseworkRow[] = [];
  for (const a of assignments) {
    const base = {
      assignmentId: a.id,
      module: { id: a.module.id, title: a.module.title },
      isExtraCredit: a.is_extra_credit,
      tracked: true,
      score: null,
      scoredAt: null,
      attemptsUsed: null,
      maxAttempts: null,
    };

    if (a.type === 'REPO') {
      const ra = submissionByAssignment.get(a.id);
      // No submission row yet: no student repo to open, so no row (as before).
      if (!ra) continue;
      const repo = repoFields(ra, gitOrgLogin, now);
      const href = repo.issueUrl ?? repo.repoUrl;
      const submitted = ra.status === 'CLOSED';
      rows.push({
        ...base,
        type: 'REPO',
        title: a.title,
        deadline: iso(a.student_deadline),
        status: submitted ? 'SUBMITTED' : 'NOT_SUBMITTED',
        done: submitted,
        href,
        external: true,
        action: href ? { kind: 'OPEN', href } : null,
        repo,
      });
    } else if (a.type === 'QUIZ' && a.quiz_id) {
      const quiz = quizById.get(a.quiz_id);
      if (!quiz) continue;
      const standing = quizStanding(
        attempts.filter(attempt => attempt.quiz_id === quiz.id),
        quiz.grading_strategy
      );
      // The row is open to this student (published, past Opens), so what is
      // left to ask is whether the close date has passed: from then on no new
      // attempt starts.
      const closed = isClosed(a.closes_at, now);
      const status: CourseworkStatus = standing.completed
        ? 'COMPLETED'
        : standing.inProgress
          ? 'IN_PROGRESS'
          : closed
            ? 'CLOSED'
            : 'NOT_STARTED';
      const canStart =
        !closed && (quiz.max_attempts === 0 || standing.attemptsUsed < quiz.max_attempts);
      rows.push({
        ...base,
        type: 'QUIZ',
        title: quiz.name,
        deadline: iso(a.student_deadline),
        status,
        done: status === 'COMPLETED' || status === 'CLOSED',
        score: standing.score,
        scoredAt: iso(standing.counting?.completed_at),
        attemptsUsed: standing.attemptsUsed,
        maxAttempts: quiz.max_attempts,
        href: `/student/${classroomSlug}/quizzes?quiz=${encodeURIComponent(quiz.id)}`,
        external: false,
        action:
          status === 'IN_PROGRESS' && standing.inProgress
            ? { kind: 'RESUME_QUIZ', quizId: quiz.id, attemptId: standing.inProgress.id }
            : status === 'NOT_STARTED' && canStart
              ? { kind: 'START_QUIZ', quizId: quiz.id }
              : null,
      });
    } else if (a.type === 'FORM' && a.form_id) {
      const form = formById.get(a.form_id);
      if (!form) continue;
      // A form can stay OPEN past its close date; the fill page treats that as
      // closed, so this does too.
      const closed =
        form.status === 'CLOSED' ||
        (form.closes_at !== null && form.closes_at.getTime() <= now.getTime());
      const href = `${pagesBase}/${classroomSlug}/forms/${form.slug}`;
      const isPublic = form.access === 'PUBLIC';
      const status: CourseworkStatus | null =
        !isPublic && submittedFormIds.has(form.id)
          ? 'SUBMITTED'
          : closed
            ? 'CLOSED'
            : isPublic
              ? null
              : 'NOT_SUBMITTED';
      rows.push({
        ...base,
        type: 'FORM',
        title: a.title,
        deadline: iso(a.student_deadline ?? form.closes_at),
        status,
        tracked: !isPublic,
        done: status === 'SUBMITTED' || status === 'CLOSED',
        href,
        external: true,
        action: status === 'NOT_SUBMITTED' ? { kind: 'FILL_OUT', href } : null,
      });
    }
  }

  return rows.sort(compareRows);
};

/**
 * The dashboard's Up next: what the student still owes, soonest due first
 * (overdue first, then by due date), never a done row nor an untracked one
 * (a PUBLIC form).
 */
export const upNext = (rows: StudentCourseworkRow[], limit = 5): StudentCourseworkRow[] =>
  rows
    .filter(row => row.tracked && !row.done && row.action !== null)
    .sort((a, b) => {
      if (a.deadline === b.deadline) return a.title.localeCompare(b.title);
      if (a.deadline === null) return 1;
      if (b.deadline === null) return -1;
      return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
    })
    .slice(0, limit);
