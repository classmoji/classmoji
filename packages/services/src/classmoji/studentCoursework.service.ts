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
 *   - QUIZ: their attempts, scored by the shared selector over late-penalised
 *     scores (`countingQuizScore`): the row shows the raw percentage of the
 *     attempt that counts, and its late hours. Status, first match wins:
 *     Completed > In progress > Closed > Not started.
 *
 * REPO and QUIZ rows carry the same late and extension fields: hours late
 * after the hours bought, the price of an hour, the hours bought, and where
 * Extend buys them (the submission for a repo, the assignment for a quiz).
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
import {
  countingQuizScore,
  effectiveDeadline,
  gitContextFor,
  gitWeb,
  effectiveTokensPerHour,
  isClosed,
  lateHours,
  openToStudents,
  quizStanding,
  quizAttemptGrade,
  titleToIdentifier,
  type GitWebContext,
} from '@classmoji/utils';
import { pagesUrl } from '../emails/escape.ts';
import * as formResponseService from './formResponse.service.ts';
import * as helperService from './helper.service.ts';
import * as quizAttemptService from './quizAttempt.service.ts';
import { netQuizExtensionHours } from './quizGradeItems.service.ts';
import { findScaleByClassroomId } from './emojiMapping.service.ts';

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

/** What Extend buys hours on: a repo submission, or a quiz assignment. */
export type ExtensionTarget =
  | { kind: 'REPO'; gitRepoAssignmentId: string }
  | { kind: 'QUIZ'; assignmentId: string };

/** Everything the student's repo assignment row has always shown. */
export interface RepoRowFields {
  /** The GitRepoAssignment id: what regrade requests key on. */
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
  /** How the work is submitted: a push (REPO) or closing the issue (ISSUE). */
  submissionMode: 'REPO' | 'ISSUE' | null;
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
  /**
   * QUIZ: the effective, unpenalised percentage (0-100) of the attempt that
   * counts for the grade (a staff adjustment when there is one; picked over
   * late-penalised scores); its late hours are `numLateHours`. Internal: the
   * UI shows `scoreEmoji`.
   */
  score: number | null;
  /**
   * QUIZ: that score as the classroom's emoji (the adjustment emoji itself
   * when adjusted; a `score-N` badge on the numeric scale). Null when
   * unscored or the classroom has no scale.
   */
  scoreEmoji?: string | null;
  /** QUIZ: the AI's original score as the classroom's emoji, shown beside an adjusted one. */
  originalScoreEmoji?: string | null;
  /** QUIZ: the counting attempt's score was adjusted by staff. */
  adjusted?: boolean;
  /** QUIZ: when the counting attempt completed. */
  scoredAt: string | null;
  /**
   * REPO and QUIZ: whole hours late after the hours bought. A repo still open
   * is late up to now; a quiz is late by its counting attempt. 0 otherwise.
   */
  numLateHours: number;
  /** REPO: a late override waives lateness (and Extend). */
  isLateOverride: boolean;
  /** The price of one extension hour (the assignment's, else the classroom's); 0 = none sold. */
  tokensPerHour: number;
  /**
   * Extension hours the student has bought and not cancelled (never below
   * 0). The deadline shown stays the assignment's own; these hours say how
   * far past it the student is still on time.
   */
  extensionHours: number;
  /** When the work was submitted: the repo's submission, the quiz's counting attempt. */
  submittedAt: string | null;
  /**
   * QUIZ: past the due date plus the hours bought with no completed attempt
   * and none in progress. Shown as missing, not as hours late. A running
   * attempt shows only In progress (the grade still counts 0 until an
   * attempt completes).
   */
  missing: boolean;
  /**
   * The hours Extend starts at: what clears the lateness. REPO: its late
   * hours. QUIZ past the due date plus the hours bought with no completed
   * attempt (missing, or an attempt still running): the hours from there to
   * now, rounded up; otherwise the late hours of the attempt that counts.
   */
  suggestedExtensionHours: number;
  /** Where Extend buys hours, or null where it is not offered. */
  extend: ExtensionTarget | null;
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
   * The classroom's full git context (provider, Gitlab subgroup and host), so
   * repo and issue links resolve on Gitlab too. Github links when absent.
   */
  git?: GitWebContext | null;
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

/** The late and extension fields every REPO and QUIZ row carries. */
type LateFields = Pick<
  StudentCourseworkRow,
  'numLateHours' | 'isLateOverride' | 'tokensPerHour' | 'extensionHours' | 'submittedAt'
>;

const NO_LATE_FIELDS: LateFields &
  Pick<StudentCourseworkRow, 'missing' | 'extend' | 'suggestedExtensionHours'> = {
  numLateHours: 0,
  isLateOverride: false,
  tokensPerHour: 0,
  extensionHours: 0,
  submittedAt: null,
  missing: false,
  suggestedExtensionHours: 0,
  extend: null,
};

const HOUR_MS = 3_600_000;

const repoFields = (
  ra: RepoSubmission,
  gitOrgLogin: string | null,
  git: GitWebContext | null,
  now: Date,
  classroomTokensPerHour: number
): { repo: RepoRowFields; late: LateFields } => {
  const login = gitOrgLogin ?? ra.git_repo?.classroom?.git_organization?.login ?? null;
  const web = gitWeb(
    git ??
      (!gitOrgLogin && ra.git_repo?.classroom?.git_organization
        ? gitContextFor(ra.git_repo.classroom)
        : { provider: 'GITHUB', login })
  );
  // The student's own copy of the repository: with the student Repositories
  // screen gone, this row is where they reach it.
  const repoUrl = login && ra.git_repo?.name ? web.repo(ra.git_repo.name) : null;
  const issueUrl =
    repoUrl && ra.provider_issue_number
      ? web.issue(ra.git_repo!.name, ra.provider_issue_number)
      : null;
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

  const repo: RepoRowFields = {
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
    submissionMode: ra.assignment?.submission_mode ?? null,
    closedAt: iso(ra.closed_at),
  };
  const late: LateFields = {
    numLateHours,
    isLateOverride: Boolean(ra.is_late_override),
    // The assignment's own price, else the classroom's default.
    tokensPerHour: effectiveTokensPerHour(ra.assignment?.tokens_per_hour, classroomTokensPerHour),
    extensionHours,
    submittedAt: submittedAtMs !== null ? iso(ra.closed_at) : null,
  };
  return { repo, late };
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
      // Its extension price; empty = the classroom's.
      tokens_per_hour: true,
      quiz_id: true,
      form_id: true,
      module: { select: { id: true, title: true } },
      repository: { select: { is_published: true } },
      form: { select: { status: true } },
    },
  });

export type CourseworkAssignment = Awaited<ReturnType<typeof listPublishedAssignments>>[number];

/**
 * Whether the classroom has any assignment the student Assignments page would
 * list (same filter as listPublishedAssignments). The nav hides the entry when
 * it has none, so a class run on repositories alone shows no empty tab.
 */
export const hasPublishedAssignments = async (classroomId: string) =>
  (await getPrisma().assignment.count({
    where: { module: { classroom_id: classroomId }, is_published: true },
  })) > 0;

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
  git = null,
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
  const [repoSubmissions, quizJoin, formJoin, settings] = await Promise.all([
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
          // What an adjusted attempt's emoji is worth, and the emoji shown.
          findScaleByClassroomId(classroomId),
          // The hours this student bought on each quiz (net of refunds).
          netQuizExtensionHours({
            classroomId,
            studentId: userId,
            assignmentIds: assignments.flatMap(a => (a.type === 'QUIZ' ? [a.id] : [])),
          }),
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
    // The classroom's extension price, for rows whose assignment sets none,
    // and its late penalty, which decides a quiz's counting attempt. A failed
    // read prices them at 0 (no Extend) rather than hiding the rows.
    hasRepos || quizIds.length
      ? (async () =>
          getPrisma().classroomSettings.findUnique({
            where: { classroom_id: classroomId },
            select: { default_tokens_per_hour: true, late_penalty_points_per_hour: true },
          }))().catch(degraded('classroom settings', context, null))
      : null,
  ]);
  const classroomTokensPerHour = settings?.default_tokens_per_hour ?? 0;
  const latePenaltyPerHour = settings?.late_penalty_points_per_hour ?? 0;
  const [quizzes, attempts, emojiScale, quizHours] = quizJoin ?? [
    [],
    [],
    {} as Record<string, number>,
    new Map<string, number>(),
  ];
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
      const { repo, late } = repoFields(ra, gitOrgLogin, git, now, classroomTokensPerHour);
      const href = repo.issueUrl ?? repo.repoUrl;
      const submitted = ra.status === 'CLOSED';
      // Hours can be bought at any time, before the deadline or after it,
      // submitted or not. Nothing to buy: no deadline, no price, a late
      // override, or work submitted on time that cannot change any more
      // (graded, or submitted by closing the issue; a push-mode row
      // submitted on time can still take a later push inside the hours).
      const settledOnTime =
        submitted &&
        late.numLateHours === 0 &&
        (repo.gradesReleased || repo.submissionMode !== 'REPO');
      const extendable =
        a.student_deadline !== null &&
        late.tokensPerHour > 0 &&
        !late.isLateOverride &&
        !settledOnTime;
      rows.push({
        ...base,
        ...late,
        missing: false,
        suggestedExtensionHours: late.numLateHours,
        extend: extendable ? { kind: 'REPO', gitRepoAssignmentId: ra.id } : null,
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
      const own = attempts.filter(attempt => attempt.quiz_id === quiz.id);
      const standing = quizStanding(own, quiz.grading_strategy, emojiScale);
      // Hours bought move this student's due date for every attempt.
      const extensionHours = Math.max(0, quizHours.get(a.id) ?? 0);
      const counting = countingQuizScore(own, quiz.grading_strategy, {
        studentDeadline: a.student_deadline,
        extensionHours,
        latePenaltyPerHour,
        emojiScale,
      });
      const countingGrade = counting.counting
        ? quizAttemptGrade(counting.counting, emojiScale)
        : null;
      const due = effectiveDeadline(a.student_deadline, extensionHours);
      // Past the (extended) due date with no completed attempt. Missing only
      // when none is running either: a running attempt reads In progress.
      const overdue = !standing.completed && due !== null && now.getTime() > due.getTime();
      const missing = overdue && !standing.inProgress;
      const tokensPerHour = effectiveTokensPerHour(a.tokens_per_hour, classroomTokensPerHour);
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
      const someAttemptLate = own.some(
        attempt =>
          attempt.completed_at != null &&
          lateHours(attempt.completed_at, a.student_deadline, extensionHours) > 0
      );
      // Offered where there is a due date and a price, and the hours can
      // still change something: a new attempt can start, one is running, or
      // a completed attempt is late. Not on a closed quiz the student never
      // took, nor on one completed on time with no attempt left to start.
      const extendable =
        a.student_deadline !== null &&
        tokensPerHour > 0 &&
        !(closed && !standing.completed && !standing.inProgress) &&
        (canStart || standing.inProgress !== null || someAttemptLate);
      rows.push({
        ...base,
        numLateHours: counting.late_hours,
        isLateOverride: false,
        tokensPerHour,
        extensionHours,
        submittedAt: iso(counting.counting?.completed_at),
        missing,
        suggestedExtensionHours:
          overdue && due !== null
            ? Math.ceil((now.getTime() - due.getTime()) / HOUR_MS)
            : counting.late_hours,
        extend: extendable ? { kind: 'QUIZ', assignmentId: a.id } : null,
        type: 'QUIZ',
        title: quiz.name,
        deadline: iso(a.student_deadline),
        status,
        done: status === 'COMPLETED' || status === 'CLOSED',
        score: counting.raw_percentage,
        scoreEmoji: countingGrade?.effective.emoji ?? null,
        originalScoreEmoji: countingGrade?.original.emoji ?? null,
        adjusted: countingGrade?.adjusted ?? false,
        scoredAt: iso(counting.counting?.completed_at),
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
        ...NO_LATE_FIELDS,
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

/** A page or slide deck linked to an assignment, as a row lists it. */
export interface LinkedMaterial {
  kind: 'PAGE' | 'SLIDE';
  id: string;
  title: string;
}

/**
 * The pages and slide decks linked to each of these assignments, keyed by
 * assignment id: pages first, then decks, each in their hand-arranged order
 * (the order the Modules page lists them in under an assignment). An
 * assignment with none has no entry.
 *
 * Published ones only, for every viewer. This is the dashboard's read, and the
 * dashboard is what the student sees: staff previewing it get the student's
 * view, unlike the Modules page, which shows staff the drafts too.
 *
 * The assignment ids are the caller's own, read for this classroom, but the
 * page or deck must belong to it as well: a link never surfaces another
 * classroom's material, whatever row it hangs off.
 */
export const linkedMaterials = async (
  classroomId: string,
  assignmentIds: string[]
): Promise<Map<string, LinkedMaterial[]>> => {
  const byAssignment = new Map<string, LinkedMaterial[]>();
  if (assignmentIds.length === 0) return byAssignment;

  const order = [{ order: 'asc' as const }, { created_at: 'asc' as const }];
  const [pageLinks, slideLinks] = await Promise.all([
    getPrisma().pageLink.findMany({
      where: {
        assignment_id: { in: assignmentIds },
        page: { is_draft: false, classroom_id: classroomId },
      },
      select: { assignment_id: true, page: { select: { id: true, title: true } } },
      orderBy: order,
    }),
    getPrisma().slideLink.findMany({
      where: {
        assignment_id: { in: assignmentIds },
        slide: { is_draft: false, classroom_id: classroomId },
      },
      select: { assignment_id: true, slide: { select: { id: true, title: true } } },
      orderBy: order,
    }),
  ]);

  const add = (assignmentId: string | null, material: LinkedMaterial) => {
    if (!assignmentId) return;
    const list = byAssignment.get(assignmentId);
    // The link tables' unique key treats a NULL repository as distinct, so the
    // same page can be linked to an assignment twice; it is listed once.
    if (list?.some(m => m.kind === material.kind && m.id === material.id)) return;
    if (list) list.push(material);
    else byAssignment.set(assignmentId, [material]);
  };
  for (const link of pageLinks) {
    add(link.assignment_id, { kind: 'PAGE', id: link.page.id, title: link.page.title });
  }
  for (const link of slideLinks) {
    add(link.assignment_id, { kind: 'SLIDE', id: link.slide.id, title: link.slide.title });
  }
  return byAssignment;
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
