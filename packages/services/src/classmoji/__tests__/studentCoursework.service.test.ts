/**
 * studentCoursework.listForStudent — one row per assignment a student can see,
 * every type, with their own state; and upNext, the dashboard's slice of it.
 *
 * The visibility rule and the counting-attempt selector run for real
 * (@classmoji/utils is not mocked); the reads behind them are faked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listForClassroom: vi.fn(),
  findAllAssignmentsForStudent: vi.fn(),
  findForUserByQuizIds: vi.fn(),
  findSubmittedForUserByFormIds: vi.fn(),
  quizFindMany: vi.fn(),
  formFindMany: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    // The published-assignment listing (listPublishedAssignments).
    assignment: { findMany: (...a: unknown[]) => mocks.listForClassroom(...a) },
    quiz: { findMany: (...a: unknown[]) => mocks.quizFindMany(...a) },
    form: { findMany: (...a: unknown[]) => mocks.formFindMany(...a) },
  }),
}));
vi.mock('../helper.service.ts', () => ({
  findAllAssignmentsForStudent: (...a: unknown[]) => mocks.findAllAssignmentsForStudent(...a),
}));
vi.mock('../quizAttempt.service.ts', () => ({
  findForUserByQuizIds: (...a: unknown[]) => mocks.findForUserByQuizIds(...a),
}));
vi.mock('../formResponse.service.ts', () => ({
  findSubmittedForUserByFormIds: (...a: unknown[]) => mocks.findSubmittedForUserByFormIds(...a),
}));
vi.mock('../../emails/escape.ts', () => ({ pagesUrl: () => 'https://pages.test' }));

const { listForStudent, upNext } = await import('../studentCoursework.service.ts');

const NOW = new Date('2026-10-01T12:00:00Z');
const HOUR = 3_600_000;
const at = (offsetHours: number) => new Date(NOW.getTime() + offsetHours * HOUR);

const MODULE = { id: 'mod-1', title: 'Week 1', slug: 'week-1', position: 0 };

/** An Assignment row as `assignment.listForClassroom` returns it. */
const assignment = (
  id: string,
  type: 'REPO' | 'QUIZ' | 'FORM',
  over: Record<string, unknown> = {}
) => ({
  id,
  type,
  title: `Assignment ${id}`,
  module_id: MODULE.id,
  module: MODULE,
  is_published: true,
  is_extra_credit: false,
  release_at: null,
  student_deadline: at(24),
  closes_at: null as Date | null,
  repository_id: type === 'REPO' ? `repo-${id}` : null,
  repository: type === 'REPO' ? { id: `repo-${id}`, is_published: true } : null,
  quiz_id: type === 'QUIZ' ? `quiz-${id}` : null,
  form_id: type === 'FORM' ? `form-${id}` : null,
  form: type === 'FORM' ? { id: `form-${id}`, status: 'OPEN' } : null,
  ...over,
});

/** A quiz row as the service selects it: its content, not its schedule. */
const quiz = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Quiz name ${id}`,
  max_attempts: 2,
  grading_strategy: 'HIGHEST',
  ...over,
});

const attempt = (
  id: string,
  quizId: string,
  startedHoursAgo: number,
  completed: boolean,
  pct: number | null
) => ({
  id,
  quiz_id: quizId,
  started_at: at(-startedHoursAgo),
  completed_at: completed ? at(-startedHoursAgo + 1) : null,
  partial_credit_percentage: pct,
});

const form = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  slug: `slug-${id}`,
  access: 'CLASSROOM',
  status: 'OPEN',
  closes_at: null as Date | null,
  ...over,
});

/** A GitRepoAssignment as `helper.findAllAssignmentsForStudent` returns it. */
const submission = (id: string, assignmentId: string, over: Record<string, unknown> = {}) => ({
  id,
  assignment_id: assignmentId,
  status: 'OPEN',
  closed_at: null,
  provider_issue_number: 7,
  is_late_override: false,
  token_transactions: [],
  analytics_snapshot: { total_commits: 12 },
  graders: [{ grader: { id: 'g-1', name: 'Grace' } }],
  grades: [],
  assignment: {
    student_deadline: at(24),
    grades_released: false,
    submission_mode: 'ISSUE',
    tokens_per_hour: 3,
  },
  git_repo: {
    name: `lab-${id}-ada`,
    repository: { slug: 'lab', title: 'Lab', type: 'INDIVIDUAL' },
    classroom: { git_organization: { login: 'org-from-row' } },
  },
  ...over,
});

const list = (quizzesVisible = true) =>
  listForStudent({
    classroomId: 'class-1',
    classroomSlug: 'cs52',
    userId: 'stu-1',
    quizzesVisible,
    gitOrgLogin: 'cs52-org',
    now: NOW,
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.listForClassroom.mockResolvedValue([]);
  mocks.findAllAssignmentsForStudent.mockResolvedValue([]);
  mocks.findForUserByQuizIds.mockResolvedValue([]);
  mocks.findSubmittedForUserByFormIds.mockResolvedValue([]);
  mocks.quizFindMany.mockResolvedValue([]);
  mocks.formFindMany.mockResolvedValue([]);
});

describe('listForStudent — which assignments appear', () => {
  it("reads the classroom's published assignments, with only the fields the rows read", async () => {
    await list();

    const [query] = mocks.listForClassroom.mock.calls[0];
    expect(query.where).toEqual({ module: { classroom_id: 'class-1' }, is_published: true });
    expect(Object.keys(query.select).sort()).toEqual(
      [
        'id',
        'type',
        'title',
        'is_published',
        'is_extra_credit',
        'release_at',
        'student_deadline',
        'closes_at',
        'quiz_id',
        'form_id',
        'module',
        'repository',
        'form',
      ].sort()
    );
  });

  it('uses the listing a caller already read', async () => {
    const rows = await listForStudent({
      classroomId: 'class-1',
      classroomSlug: 'cs52',
      userId: 'stu-1',
      quizzesVisible: true,
      assignments: [assignment('f-1', 'FORM')] as never,
      now: NOW,
    });

    expect(mocks.listForClassroom).not.toHaveBeenCalled();
    expect(mocks.formFindMany).toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it('applies the student-visibility rule', async () => {
    mocks.listForClassroom.mockResolvedValue([
      assignment('q-ok', 'QUIZ'),
      assignment('q-draft', 'QUIZ', { is_published: false }),
      assignment('q-later', 'QUIZ', { release_at: at(48) }),
      assignment('f-draft', 'FORM', { form: { id: 'form-f-draft', status: 'DRAFT' } }),
      assignment('r-hidden', 'REPO', { repository: { id: 'repo-x', is_published: false } }),
    ]);
    mocks.quizFindMany.mockResolvedValue([quiz('quiz-q-ok')]);
    mocks.findAllAssignmentsForStudent.mockResolvedValue([submission('ra-x', 'r-hidden')]);

    const rows = await list();

    expect(rows.map(r => r.assignmentId)).toEqual(['q-ok']);
    // Only the visible quiz is looked up.
    expect(mocks.findForUserByQuizIds).toHaveBeenCalledWith('stu-1', ['quiz-q-ok']);
  });

  it('shows no quiz row where quizzes are hidden', async () => {
    mocks.listForClassroom.mockResolvedValue([
      assignment('q-1', 'QUIZ'),
      assignment('f-1', 'FORM'),
    ]);
    mocks.formFindMany.mockResolvedValue([form('form-f-1')]);

    const rows = await list(false);

    expect(rows.map(r => r.type)).toEqual(['FORM']);
    expect(mocks.quizFindMany).not.toHaveBeenCalled();
  });

  it('shows a repo assignment only once the student has a submission row', async () => {
    mocks.listForClassroom.mockResolvedValue([
      assignment('r-1', 'REPO'),
      assignment('r-2', 'REPO'),
    ]);
    mocks.findAllAssignmentsForStudent.mockResolvedValue([submission('ra-1', 'r-1')]);

    const rows = await list();

    expect(rows.map(r => r.assignmentId)).toEqual(['r-1']);
  });

  it('uses the submission rows a caller already read, without reading them again', async () => {
    mocks.listForClassroom.mockResolvedValue([assignment('r-1', 'REPO')]);

    const rows = await listForStudent({
      classroomId: 'class-1',
      classroomSlug: 'cs52',
      userId: 'stu-1',
      quizzesVisible: true,
      gitOrgLogin: 'cs52-org',
      repoSubmissions: [submission('ra-given', 'r-1')] as never,
      now: NOW,
    });

    expect(mocks.findAllAssignmentsForStudent).not.toHaveBeenCalled();
    expect(rows[0].repo!.gitRepoAssignmentId).toBe('ra-given');
  });

  it('keeps the quiz and form rows when the repo lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listForClassroom.mockResolvedValue([
      assignment('r-1', 'REPO'),
      assignment('f-1', 'FORM'),
    ]);
    mocks.findAllAssignmentsForStudent.mockRejectedValue(new Error('git_repo relation missing'));
    mocks.formFindMany.mockResolvedValue([form('form-f-1')]);

    const rows = await list();

    expect(rows.map(r => r.assignmentId)).toEqual(['f-1']);
  });

  it('keeps the repo and form rows when a quiz read fails, and says which read failed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listForClassroom.mockResolvedValue([
      assignment('r-1', 'REPO'),
      assignment('q-1', 'QUIZ'),
      assignment('f-1', 'FORM'),
    ]);
    mocks.findAllAssignmentsForStudent.mockResolvedValue([submission('ra-1', 'r-1')]);
    mocks.findForUserByQuizIds.mockRejectedValue(new Error('timeout'));
    mocks.formFindMany.mockResolvedValue([form('form-f-1')]);

    const rows = await list();

    expect(rows.map(r => r.assignmentId).sort()).toEqual(['f-1', 'r-1']);
    expect(logged).toHaveBeenCalledWith(
      '[studentCoursework] quiz lookup failed',
      { classroomId: 'class-1', userId: 'stu-1' },
      expect.any(Error)
    );
  });

  it('keeps the repo and quiz rows when a form read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listForClassroom.mockResolvedValue([
      assignment('r-1', 'REPO'),
      assignment('q-1', 'QUIZ'),
      assignment('f-1', 'FORM'),
    ]);
    mocks.findAllAssignmentsForStudent.mockResolvedValue([submission('ra-1', 'r-1')]);
    mocks.quizFindMany.mockResolvedValue([quiz('quiz-q-1')]);
    mocks.formFindMany.mockRejectedValue(new Error('timeout'));

    const rows = await list();

    expect(rows.map(r => r.assignmentId).sort()).toEqual(['q-1', 'r-1']);
  });
});

describe('listForStudent — REPO rows keep every field the page showed', () => {
  it('carries the repo link, commits, issue, type, graders, late hours and submission id', async () => {
    mocks.listForClassroom.mockResolvedValue([
      assignment('r-1', 'REPO', { title: 'Lab 1', is_extra_credit: true }),
    ]);
    mocks.findAllAssignmentsForStudent.mockResolvedValue([
      submission('ra-1', 'r-1', {
        assignment: {
          student_deadline: at(-6),
          grades_released: false,
          submission_mode: 'ISSUE',
          tokens_per_hour: 3,
        },
        // Two hours bought: six hours late becomes four.
        token_transactions: [
          { type: 'PURCHASE', hours_purchased: 2 },
          { type: 'GAIN', hours_purchased: null },
        ],
      }),
    ]);

    const [row] = await list();

    expect(row).toMatchObject({
      type: 'REPO',
      title: 'Lab 1',
      module: { id: 'mod-1', title: 'Week 1' },
      isExtraCredit: true,
      status: 'NOT_SUBMITTED',
      done: false,
      href: 'https://github.com/cs52-org/lab-ra-1-ada/issues/7',
      external: true,
      action: { kind: 'OPEN', href: 'https://github.com/cs52-org/lab-ra-1-ada/issues/7' },
    });
    expect(row.repo).toEqual({
      gitRepoAssignmentId: 'ra-1',
      repositoryTitle: 'lab-ra-1-ada',
      repoUrl: 'https://github.com/cs52-org/lab-ra-1-ada',
      commitCount: 12,
      issueUrl: 'https://github.com/cs52-org/lab-ra-1-ada/issues/7',
      moduleType: 'INDIVIDUAL',
      gradesReleased: false,
      grades: [],
      graders: [{ id: 'g-1', name: 'Grace' }],
      gradersSummary: 'Grace',
      numLateHours: 4,
      isLateOverride: false,
      tokensPerHour: 3,
      closedAt: null,
    });
  });

  it('marks a closed submission submitted, with its released grades', async () => {
    mocks.listForClassroom.mockResolvedValue([assignment('r-1', 'REPO')]);
    mocks.findAllAssignmentsForStudent.mockResolvedValue([
      submission('ra-1', 'r-1', {
        status: 'CLOSED',
        closed_at: at(-2),
        grades: [{ id: 'gr-1', emoji: 'heart' }],
        assignment: {
          student_deadline: at(-1),
          grades_released: true,
          submission_mode: 'ISSUE',
          tokens_per_hour: 0,
        },
      }),
    ]);

    const [row] = await list();

    expect(row).toMatchObject({ status: 'SUBMITTED', done: true });
    expect(row.repo).toMatchObject({
      gradesReleased: true,
      grades: [{ id: 'gr-1', emoji: 'heart' }],
      numLateHours: 0,
      closedAt: at(-2).toISOString(),
    });
  });

  it('sends no grades until they are released', async () => {
    mocks.listForClassroom.mockResolvedValue([assignment('r-1', 'REPO')]);
    mocks.findAllAssignmentsForStudent.mockResolvedValue([
      submission('ra-1', 'r-1', {
        status: 'CLOSED',
        grades: [{ id: 'gr-1', emoji: 'heart' }],
        assignment: {
          student_deadline: at(-1),
          grades_released: false,
          submission_mode: 'ISSUE',
          tokens_per_hour: 0,
        },
      }),
    ]);

    const [row] = await list();

    expect(row.repo).toMatchObject({ gradesReleased: false, grades: [] });
    expect(JSON.stringify(row)).not.toContain('heart');
  });

  it("links a push-mode repo to the repository, late by the push's time", async () => {
    mocks.listForClassroom.mockResolvedValue([assignment('r-1', 'REPO')]);
    mocks.findAllAssignmentsForStudent.mockResolvedValue([
      submission('ra-1', 'r-1', {
        status: 'CLOSED',
        provider_issue_number: null,
        // Pushed 2h1m after the deadline: 3 late hours (rounded up).
        closed_at: new Date(at(-6).getTime() + 2 * HOUR + 60_000),
        assignment: {
          student_deadline: at(-6),
          grades_released: false,
          submission_mode: 'REPO',
          tokens_per_hour: 2,
        },
      }),
    ]);

    const [row] = await list();

    expect(row.repo).toMatchObject({ issueUrl: null, numLateHours: 3 });
    expect(row.href).toBe('https://github.com/cs52-org/lab-ra-1-ada');
  });

  it("keeps the student's own submission over their team's", async () => {
    mocks.listForClassroom.mockResolvedValue([assignment('r-1', 'REPO')]);
    mocks.findAllAssignmentsForStudent.mockResolvedValue([
      submission('ra-own', 'r-1'),
      submission('ra-team', 'r-1', { status: 'CLOSED' }),
    ]);

    const rows = await list();

    expect(rows).toHaveLength(1);
    expect(rows[0].repo!.gitRepoAssignmentId).toBe('ra-own');
  });
});

describe('listForStudent — QUIZ rows', () => {
  const quizRow = async (
    attempts: ReturnType<typeof attempt>[],
    quizOver: Record<string, unknown> = {},
    assignmentOver: Record<string, unknown> = {}
  ) => {
    mocks.listForClassroom.mockResolvedValue([assignment('a-q', 'QUIZ', assignmentOver)]);
    mocks.quizFindMany.mockResolvedValue([quiz('quiz-a-q', quizOver)]);
    mocks.findForUserByQuizIds.mockResolvedValue(attempts);
    return (await list())[0];
  };

  it("is titled with the quiz's own name and linked to the quiz list", async () => {
    const row = await quizRow([]);

    expect(row).toMatchObject({
      type: 'QUIZ',
      title: 'Quiz name quiz-a-q',
      href: '/student/cs52/quizzes?quiz=quiz-a-q',
      external: false,
    });
  });

  it('is Not started, with Start, before any attempt', async () => {
    const row = await quizRow([]);

    expect(row).toMatchObject({
      status: 'NOT_STARTED',
      done: false,
      attemptsUsed: 0,
      maxAttempts: 2,
      action: { kind: 'START_QUIZ', quizId: 'quiz-a-q' },
    });
  });

  it('is In progress, with Resume, while an attempt runs', async () => {
    const row = await quizRow([attempt('run', 'quiz-a-q', 1, false, null)]);

    expect(row).toMatchObject({
      status: 'IN_PROGRESS',
      done: false,
      action: { kind: 'RESUME_QUIZ', quizId: 'quiz-a-q', attemptId: 'run' },
    });
  });

  it('is Completed with the counting score, a running retake beside it', async () => {
    const row = await quizRow(
      [attempt('retake', 'quiz-a-q', 1, false, null), attempt('done', 'quiz-a-q', 30, true, 88)],
      { grading_strategy: 'MOST_RECENT' }
    );

    expect(row).toMatchObject({
      status: 'COMPLETED',
      done: true,
      score: 88,
      scoredAt: at(-29).toISOString(),
      attemptsUsed: 2,
      action: null,
    });
  });

  it('keeps a 0 as the score', async () => {
    const row = await quizRow([attempt('zero', 'quiz-a-q', 5, true, 0)]);

    expect(row).toMatchObject({ status: 'COMPLETED', score: 0 });
  });

  it('is Closed, done and never overdue, once its close date has passed and it was never taken', async () => {
    const row = await quizRow([], {}, { student_deadline: at(-48), closes_at: at(-1) });

    expect(row).toMatchObject({ status: 'CLOSED', done: true, action: null });
  });

  it("reads the close date off the assignment, whatever the quiz's own status says", async () => {
    // The quiz's status is a mirror written at save time; a close date that
    // passed since never rewrote it.
    const closed = await quizRow([], { status: 'PUBLISHED' }, { closes_at: at(-1) });
    expect(closed).toMatchObject({ status: 'CLOSED', action: null });

    const open = await quizRow([], { status: 'CLOSED' }, { closes_at: at(1) });
    expect(open).toMatchObject({ status: 'NOT_STARTED', action: { kind: 'START_QUIZ' } });
  });

  it('is Completed, not Closed, for a closed quiz the student finished', async () => {
    const row = await quizRow([attempt('done', 'quiz-a-q', 30, true, 70)], {}, { closes_at: at(-1) });

    expect(row).toMatchObject({ status: 'COMPLETED', score: 70 });
  });

  it('can still be resumed when it closed during an attempt', async () => {
    const row = await quizRow(
      [attempt('run', 'quiz-a-q', 1, false, null)],
      {},
      { closes_at: at(-0.5) }
    );

    expect(row).toMatchObject({ status: 'IN_PROGRESS', action: { kind: 'RESUME_QUIZ' } });
  });

  it('reports unlimited attempts as a cap of 0', async () => {
    const row = await quizRow([attempt('done', 'quiz-a-q', 30, true, 50)], { max_attempts: 0 });

    expect(row).toMatchObject({ attemptsUsed: 1, maxAttempts: 0 });
  });

  it("takes the assignment's due date, and none when the assignment has none", async () => {
    expect((await quizRow([], {}, { student_deadline: at(5) })).deadline).toBe(at(5).toISOString());
    // The quiz's own due date is a mirror of the assignment's; it is not read.
    expect((await quizRow([], { due_date: at(72) }, { student_deadline: null })).deadline).toBe(
      null
    );
  });
});

describe('listForStudent — FORM rows', () => {
  const formRow = async (
    formOver: Record<string, unknown> = {},
    submitted = false,
    assignmentOver: Record<string, unknown> = {}
  ) => {
    mocks.listForClassroom.mockResolvedValue([assignment('a-f', 'FORM', assignmentOver)]);
    mocks.formFindMany.mockResolvedValue([form('form-a-f', formOver)]);
    mocks.findSubmittedForUserByFormIds.mockResolvedValue(
      submitted ? [{ form_id: 'form-a-f', submitted_at: at(-1) }] : []
    );
    return (await list())[0];
  };

  it('is Not submitted, with Fill out, and links to the fill page', async () => {
    const row = await formRow();

    expect(row).toMatchObject({
      type: 'FORM',
      status: 'NOT_SUBMITTED',
      done: false,
      href: 'https://pages.test/cs52/forms/slug-form-a-f',
      external: true,
      action: { kind: 'FILL_OUT', href: 'https://pages.test/cs52/forms/slug-form-a-f' },
    });
  });

  it('is Submitted once a response is submitted', async () => {
    const row = await formRow({}, true);

    expect(row).toMatchObject({ status: 'SUBMITTED', done: true, action: null });
    expect(mocks.findSubmittedForUserByFormIds).toHaveBeenCalledWith('stu-1', ['form-a-f']);
  });

  it('is Closed, with no Fill out, when the form is CLOSED', async () => {
    const row = await formRow({ status: 'CLOSED' });

    expect(row).toMatchObject({ status: 'CLOSED', done: true, action: null });
  });

  it('is Closed, with no Fill out, when the form is still OPEN past its close date', async () => {
    const row = await formRow({ status: 'OPEN', closes_at: at(-1) });

    expect(row).toMatchObject({ status: 'CLOSED', done: true, action: null });
  });

  it('stays Submitted after it closes', async () => {
    const row = await formRow({ status: 'CLOSED' }, true);

    expect(row).toMatchObject({ status: 'SUBMITTED', done: true });
  });

  it('shows a PUBLIC form untracked, with no per-student status until it closes', async () => {
    // A public response records no student, so a "submitted" row there could
    // only be a guess; this one is ignored.
    expect(await formRow({ access: 'PUBLIC' }, true)).toMatchObject({
      status: null,
      tracked: false,
      done: false,
      action: null,
    });
    // Closed still reads Closed, and is still untracked: never counted.
    expect(await formRow({ access: 'PUBLIC', status: 'CLOSED' })).toMatchObject({
      status: 'CLOSED',
      tracked: false,
    });
  });

  it('tracks a CLASSROOM form, and every quiz and repo row', async () => {
    expect((await formRow()).tracked).toBe(true);
  });

  it("takes the assignment's due date, falling back to the form's close date", async () => {
    const closes = at(30);
    expect((await formRow({ closes_at: closes }, false, { student_deadline: null })).deadline).toBe(
      closes.toISOString()
    );
  });
});

describe('listForStudent — order', () => {
  it('lists current rows soonest due first, then done rows latest due first', async () => {
    mocks.listForClassroom.mockResolvedValue([
      assignment('cur-late', 'FORM', { student_deadline: at(48) }),
      assignment('cur-soon', 'FORM', { student_deadline: at(2) }),
      assignment('cur-none', 'FORM', { student_deadline: null }),
      assignment('done-old', 'FORM', { student_deadline: at(-72) }),
      assignment('done-new', 'FORM', { student_deadline: at(-2) }),
    ]);
    mocks.formFindMany.mockResolvedValue([
      form('form-cur-late'),
      form('form-cur-soon'),
      form('form-cur-none'),
      form('form-done-old', { status: 'CLOSED' }),
      form('form-done-new', { status: 'CLOSED' }),
    ]);

    const rows = await list();

    expect(rows.map(r => r.assignmentId)).toEqual([
      'cur-soon',
      'cur-late',
      'cur-none',
      'done-new',
      'done-old',
    ]);
  });
});

describe('upNext', () => {
  it('takes what is still owed, overdue first then by due, at most five, never a done or public row', async () => {
    mocks.listForClassroom.mockResolvedValue([
      assignment('overdue', 'QUIZ', { student_deadline: at(-5) }),
      assignment('soon', 'FORM', { student_deadline: at(3) }),
      assignment('later', 'FORM', { student_deadline: at(30) }),
      assignment('public', 'FORM', { student_deadline: at(1) }),
      assignment('closed', 'FORM', { student_deadline: at(2) }),
      assignment('done', 'QUIZ', { student_deadline: at(4) }),
      assignment('r-open', 'REPO', { student_deadline: at(5) }),
      assignment('undated', 'FORM', { student_deadline: null }),
      assignment('far', 'FORM', { student_deadline: at(300) }),
    ]);
    mocks.quizFindMany.mockResolvedValue([quiz('quiz-overdue'), quiz('quiz-done')]);
    mocks.findForUserByQuizIds.mockResolvedValue([attempt('d', 'quiz-done', 10, true, 90)]);
    mocks.formFindMany.mockResolvedValue([
      form('form-soon'),
      form('form-later'),
      form('form-public', { access: 'PUBLIC' }),
      form('form-closed', { status: 'CLOSED' }),
      form('form-undated'),
      form('form-far'),
    ]);
    mocks.findAllAssignmentsForStudent.mockResolvedValue([submission('ra-1', 'r-open')]);

    const rows = upNext(await list());

    expect(rows.map(r => r.assignmentId)).toEqual(['overdue', 'soon', 'r-open', 'later', 'far']);
    expect(
      upNext(await list(), 10)
        .map(r => r.assignmentId)
        .at(-1)
    ).toBe('undated');
  });
});
