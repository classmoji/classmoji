/**
 * Quiz rows on the student reads: my_grades (grades-mine), my_tokens (tokens)
 * and the student branch of list_quizzes (quizzes).
 *
 * Pinned here:
 *   - my_grades shows the RAW score of the attempt the grade counts (the
 *     strategy picks among late-penalised scores, so a late best attempt can
 *     lose to an on-time one), that attempt's late hours, and a counted 0 as
 *     such; the quiz key is absent where quizzes are hidden, and a failed
 *     visibility lookup fails the read.
 *   - my_tokens names a quiz extension by its assignment, and an orphaned one
 *     (assignment deleted) by the title its description was written with.
 *   - list_quizzes gives a student the assignment id, the price of an hour,
 *     the hours bought and the due date they give, and the counting attempt's
 *     late hours, with two reads for the whole list; it answers a student only
 *     where quizzes are visible (`entitlement.quizzesVisibleOrThrow`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  assertProTier: vi.fn(),
  getQuizzesForStudent: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  loadQuizGradeItems: vi.fn(),
  netQuizExtensionHours: vi.fn(),
  findForUserByQuizIds: vi.fn(),
  findForUser: vi.fn(),
  gradeSummaryForStudent: vi.fn(),
  getBalance: vi.fn(),
  findTransactions: vi.fn(),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

vi.mock('@classmoji/auth/server', () => ({
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { getQuizzesForStudent: (...a: unknown[]) => mocks.getQuizzesForStudent(...a) },
    entitlement: {
      quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
    },
    quizGradeItems: {
      loadQuizGradeItems: (...a: unknown[]) => mocks.loadQuizGradeItems(...a),
      netQuizExtensionHours: (...a: unknown[]) => mocks.netQuizExtensionHours(...a),
    },
    quizAttempt: { findForUserByQuizIds: (...a: unknown[]) => mocks.findForUserByQuizIds(...a) },
    gitRepoAssignment: { findForUser: (...a: unknown[]) => mocks.findForUser(...a) },
    helper: {
      gradeSummaryForStudent: (...a: unknown[]) => mocks.gradeSummaryForStudent(...a),
      // The real predicate (pure), so the gate under test is the shipped one.
      showsGradeSummary: (
        role: string | null | undefined,
        settings: Record<string, unknown> | null | undefined
      ) =>
        role === 'STUDENT' &&
        (settings?.final_grades_released === true || settings?.show_grades_to_students === true),
    },
    token: {
      getBalance: (...a: unknown[]) => mocks.getBalance(...a),
      findTransactions: (...a: unknown[]) => mocks.findTransactions(...a),
    },
  },
}));

// The real grade-line entry point, below the mocked barrel; its reads go to the
// prisma stub. Its quiz gate is a read too: answered here, so no quiz items load.
vi.mock('../../../../../packages/services/src/classmoji/entitlement.service.ts', () => ({
  quizzesVisibleOrThrow: async () => false,
}));

const { gradesMineResource, GRADES_MINE_DESCRIPTION } = await import('../repos.ts');
const { gradeSummaryForStudent: realGradeSummaryForStudent } =
  await import('../../../../../packages/services/src/classmoji/helper.service.ts');
const { tokensResource } = await import('../tokens.ts');
const { quizzesResource, QUIZZES_DESCRIPTION } = await import('../content.ts');
const { myGradesTool, myTokensTool, listQuizzesTool } = await import('../../tools/reads.ts');
const { prismaCallsFor, resetPrismaStub, setPrismaRows } =
  await import('../../__tests__/prismaSchemaStub.ts');
// The description the service writes, so the test reads back what it writes.
const { quizExtensionDescription } = await import('@classmoji/utils');

const VARS = { org: 'test-org', slug: 'winter-2025' };
const URI = new URL('classmoji://test-org/winter-2025/x');
const HOUR = 3_600_000;
const DUE = new Date('2026-10-02T18:00:00.000Z');
const at = (hours: number) => new Date(DUE.getTime() + hours * HOUR);

const QUIZ_A = '11111111-1111-4111-8111-111111111111';
const QUIZ_B = '22222222-2222-4222-8222-222222222222';

function studentCtx(settings: Record<string, unknown> = {}): ToolContext {
  return {
    viewer: { userId: 'stu-1', clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: 'class-1',
      role: 'STUDENT',
      status: 'ACTIVE',
      membership: { id: 'm-1', role: 'STUDENT', user_id: 'stu-1' },
      classroom: {
        slug: 'winter-2025',
        settings: { quizzes_enabled: true, ...settings },
        git_organization: { login: 'test-org' },
      },
    },
  } as unknown as ToolContext;
}

/**
 * Two attempts on one quiz: 90 % finished 5 h after the due date, 80 % an hour
 * before it. HIGHEST over raw scores picks the 90; with 4 points off per late
 * hour it is 70, so the on-time 80 is the one that counts.
 */
const ATTEMPTS = [
  {
    id: 'late-90',
    quiz_id: 'quiz-a',
    started_at: at(4),
    completed_at: at(5),
    partial_credit_percentage: 90,
  },
  {
    id: 'ontime-80',
    quiz_id: 'quiz-a',
    started_at: at(-2),
    completed_at: at(-1),
    partial_credit_percentage: 80,
  },
];

beforeEach(() => {
  for (const m of Object.values(mocks)) if (vi.isMockFunction(m)) m.mockReset();
  resetPrismaStub();
  mocks.assertProTier.mockResolvedValue(undefined);
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.findForUser.mockResolvedValue([]);
  mocks.netQuizExtensionHours.mockResolvedValue(new Map());
  mocks.findForUserByQuizIds.mockResolvedValue([]);
});

// ─── my_grades ───────────────────────────────────────────────────────────────

describe('my_grades quiz rows', () => {
  type Payload = { count: number; grades: unknown[]; quiz_grades?: Array<Record<string, unknown>> };

  function arrangeTwoQuizzes() {
    mocks.loadQuizGradeItems.mockResolvedValue(
      new Map([
        [
          'stu-1',
          [
            {
              assignment_id: QUIZ_A,
              module_id: 'mod-1',
              weight: 10,
              is_extra_credit: false,
              grade: 80,
              raw_grade: 90,
              counts_as_zero: false,
              late_hours: 0,
            },
            {
              assignment_id: QUIZ_B,
              module_id: 'mod-1',
              weight: 5,
              is_extra_credit: false,
              grade: 0,
              raw_grade: 0,
              counts_as_zero: true,
              late_hours: 0,
            },
          ],
        ],
      ])
    );
    setPrismaRows({
      assignment: {
        findMany: [
          {
            id: QUIZ_A,
            title: 'Quiz A',
            quiz_id: 'quiz-a',
            student_deadline: DUE,
            module: { id: 'mod-1', title: 'Week 1' },
            quiz: { grading_strategy: 'HIGHEST' },
          },
          {
            id: QUIZ_B,
            title: 'Quiz B',
            quiz_id: 'quiz-b',
            student_deadline: at(-48),
            module: { id: 'mod-1', title: 'Week 1' },
            quiz: { grading_strategy: 'HIGHEST' },
          },
        ],
      },
    });
    mocks.findForUserByQuizIds.mockResolvedValue(ATTEMPTS);
  }

  it('shows the raw score and late hours of the attempt that counts, and a counted 0', async () => {
    arrangeTwoQuizzes();

    const payload = (await gradesMineResource.handler(
      VARS,
      studentCtx({ late_penalty_points_per_hour: 4 }),
      URI
    )) as Payload;

    expect(payload.quiz_grades).toEqual([
      {
        assignment_id: QUIZ_A,
        quiz_id: 'quiz-a',
        title: 'Quiz A',
        module: { id: 'mod-1', title: 'Week 1' },
        student_deadline: DUE,
        effective_deadline: DUE,
        percentage: 80,
        late_hours: 0,
        counts_as_zero: false,
        counting_attempt_id: 'ontime-80',
        completed_at: at(-1),
      },
      {
        assignment_id: QUIZ_B,
        quiz_id: 'quiz-b',
        title: 'Quiz B',
        module: { id: 'mod-1', title: 'Week 1' },
        student_deadline: at(-48),
        effective_deadline: at(-48),
        percentage: 0,
        late_hours: 0,
        counts_as_zero: true,
        counting_attempt_id: null,
        completed_at: null,
      },
    ]);
  });

  it('measures lateness from the due date plus the hours bought', async () => {
    arrangeTwoQuizzes();
    // 3 h bought: the 90 is 2 h late (82 after the penalty) and now counts.
    mocks.netQuizExtensionHours.mockResolvedValue(new Map([[QUIZ_A, 3]]));

    const payload = (await gradesMineResource.handler(
      VARS,
      studentCtx({ late_penalty_points_per_hour: 4 }),
      URI
    )) as Payload;

    expect(payload.quiz_grades?.[0]).toMatchObject({
      effective_deadline: at(3),
      percentage: 90,
      late_hours: 2,
      counting_attempt_id: 'late-90',
    });
  });

  it('asks the grade loader for the caller only, and scopes the title read to the classroom', async () => {
    arrangeTwoQuizzes();

    await gradesMineResource.handler(VARS, studentCtx(), URI);

    expect(mocks.quizzesVisibleOrThrow).toHaveBeenCalledWith('class-1');
    expect(mocks.loadQuizGradeItems).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: 'class-1', quizzesVisible: true, userIds: ['stu-1'] })
    );
    const [call] = prismaCallsFor('assignment', 'findMany');
    expect((call.args as { where: unknown }).where).toMatchObject({
      id: { in: [QUIZ_A, QUIZ_B] },
      type: 'QUIZ',
      module: { classroom_id: 'class-1' },
    });
    expect(mocks.findForUserByQuizIds).toHaveBeenCalledWith('stu-1', ['quiz-a', 'quiz-b']);
    expect(mocks.netQuizExtensionHours).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: 'stu-1',
      assignmentIds: [QUIZ_A, QUIZ_B],
    });
  });

  it('leaves no quiz key where the classroom hides quizzes', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);

    const payload = (await gradesMineResource.handler(VARS, studentCtx(), URI)) as Payload;

    expect(payload).toEqual({ count: 0, grades: [] });
    expect(mocks.loadQuizGradeItems).not.toHaveBeenCalled();
  });

  it('gives an empty list, and no further reads, when nothing is graded yet', async () => {
    mocks.loadQuizGradeItems.mockResolvedValue(new Map());

    const payload = (await gradesMineResource.handler(VARS, studentCtx(), URI)) as Payload;

    expect(payload.quiz_grades).toEqual([]);
    expect(prismaCallsFor('assignment')).toHaveLength(0);
    expect(mocks.findForUserByQuizIds).not.toHaveBeenCalled();
  });

  it('fails the read when the visibility lookup fails, instead of dropping the quizzes', async () => {
    mocks.quizzesVisibleOrThrow.mockRejectedValue(new Error('db down'));

    await expect(gradesMineResource.handler(VARS, studentCtx(), URI)).rejects.toThrow('db down');
  });

  it('carries one description on the tool and the resource, under the byte cut', () => {
    expect(myGradesTool.description).toBe(GRADES_MINE_DESCRIPTION);
    expect(gradesMineResource.description).toBe(GRADES_MINE_DESCRIPTION);
    expect(myGradesTool.title).toBe(gradesMineResource.title);
    expect(GRADES_MINE_DESCRIPTION).toContain('released');
    expect(GRADES_MINE_DESCRIPTION).toContain('quiz_grades');
    expect(Buffer.byteLength(GRADES_MINE_DESCRIPTION, 'utf8')).toBeLessThan(1500);
  });
});

// ─── my_grades final_grade / estimated_grade ─────────────────────────────────

describe('my_grades final_grade and estimated_grade', () => {
  type Payload = {
    count: number;
    grades: unknown[];
    estimated_grade?: unknown;
    final_grade?: unknown;
  };

  const ON = { show_grades_to_students: true, late_penalty_points_per_hour: 2 };
  const RELEASED = { final_grades_released: true, late_penalty_points_per_hour: 2 };
  const ESTIMATE = { kind: 'letter', letter: 'B+', count: 3 };
  // One released graded row and one unreleased one: both go to the grade line,
  // which applies its own filters; only the released one is listed.
  const ROWS = [
    {
      id: 'gra-released',
      status: 'CLOSED',
      assignment: { id: 'a-1', title: 'Lab 1', grades_released: true, weight: 10 },
      grades: [{ id: 'g-1', emoji: 'score-90', grader: null }],
      graders: [],
    },
    {
      id: 'gra-unreleased',
      status: 'CLOSED',
      assignment: { id: 'a-2', title: 'Lab 2', grades_released: false, weight: 10 },
      grades: [{ id: 'g-2', emoji: 'score-50', grader: null }],
      graders: [],
    },
  ];

  function ctxWith(
    settings: Record<string, unknown>,
    { role = 'STUDENT', letterGrade = null }: { role?: string; letterGrade?: string | null } = {}
  ): ToolContext {
    const ctx = studentCtx(settings) as unknown as {
      classroom: { role: string; membership: Record<string, unknown> };
    };
    ctx.classroom.role = role;
    ctx.classroom.membership = { ...ctx.classroom.membership, role, letter_grade: letterGrade };
    return ctx as unknown as ToolContext;
  }

  const read = async (ctx: ToolContext) =>
    (await gradesMineResource.handler(VARS, ctx, URI)) as Payload;

  beforeEach(() => {
    mocks.loadQuizGradeItems.mockResolvedValue(new Map());
    mocks.findForUser.mockResolvedValue(ROWS);
    mocks.gradeSummaryForStudent.mockResolvedValue(ESTIMATE);
  });

  it('leaves both keys out, and computes nothing, where both settings are off', async () => {
    for (const settings of [{}, { show_grades_to_students: false, final_grades_released: false }]) {
      const payload = await read(ctxWith(settings));

      expect(payload).not.toHaveProperty('estimated_grade');
      expect(payload).not.toHaveProperty('final_grade');
      expect(payload.count).toBe(1);
    }
    expect(mocks.gradeSummaryForStudent).not.toHaveBeenCalled();
  });

  it('gives a caller who is not a STUDENT neither, even with both on', async () => {
    const payload = await read(ctxWith({ ...ON, ...RELEASED }, { role: 'TEACHER' }));

    expect(payload).not.toHaveProperty('estimated_grade');
    expect(payload).not.toHaveProperty('final_grade');
    expect(mocks.gradeSummaryForStudent).not.toHaveBeenCalled();
  });

  it("passes the dashboard's estimate through for a student, from the same inputs", async () => {
    const payload = await read(ctxWith(ON, { letterGrade: 'A-' }));

    expect(payload.estimated_grade).toEqual(ESTIMATE);
    expect(payload).not.toHaveProperty('final_grade');
    expect(mocks.gradeSummaryForStudent).toHaveBeenCalledTimes(1);
    expect(mocks.gradeSummaryForStudent).toHaveBeenCalledWith({
      role: 'STUDENT',
      classroomId: 'class-1',
      userId: 'stu-1',
      // The submissions read itself, released or not: the filters are the entry point's.
      submissions: ROWS,
      letterOverride: 'A-',
      settings: { quizzes_enabled: true, ...ON },
    });
    // The read is the one the listing uses, scoped to this classroom and caller.
    expect(mocks.findForUser).toHaveBeenCalledTimes(1);
    expect(mocks.findForUser).toHaveBeenCalledWith({
      git_repo: {
        classroom_id: 'class-1',
        OR: [{ student_id: 'stu-1' }, { team: { memberships: { some: { user_id: 'stu-1' } } } }],
      },
    });
    // Unreleased grades still never appear in the listing.
    expect(payload.count).toBe(1);
    expect(JSON.stringify(payload.grades)).not.toContain('score-50');
  });

  it('never sends the letter override before release (real entry point, reads stubbed)', async () => {
    mocks.gradeSummaryForStudent.mockImplementation(realGradeSummaryForStudent);
    setPrismaRows({
      emojiMapping: {
        findMany: [
          { emoji: 'score-90', grade: 90 },
          { emoji: 'score-50', grade: 50 },
        ],
      },
      letterGradeMapping: {
        findMany: [
          { letter_grade: 'A', min_grade: 90 },
          { letter_grade: 'B', min_grade: 80 },
        ],
      },
    });

    const payload = await read(
      ctxWith({ ...ON, final_grades_released: false }, { letterGrade: 'B+' })
    );

    // The estimate over the released row alone, computed, not the override.
    expect(payload.estimated_grade).toEqual({ kind: 'letter', letter: 'A', count: 1 });
    expect(prismaCallsFor('emojiMapping', 'findMany')).toHaveLength(1);
    expect(payload).not.toHaveProperty('final_grade');
    expect(JSON.stringify(payload)).not.toContain('B+');
  });

  it('returns final_grade {letter}, and no estimate, once final grades are released', async () => {
    mocks.gradeSummaryForStudent.mockResolvedValue({ kind: 'final', letter: 'A-' });

    for (const settings of [RELEASED, { ...RELEASED, ...ON }]) {
      const payload = await read(ctxWith(settings, { letterGrade: 'A-' }));

      expect(payload.final_grade).toEqual({ letter: 'A-' });
      expect(payload).not.toHaveProperty('estimated_grade');
    }
  });

  it('released with no final grade: the estimate where it is on, else nothing', async () => {
    mocks.gradeSummaryForStudent.mockResolvedValue(ESTIMATE);
    const withEstimate = await read(ctxWith({ ...RELEASED, ...ON }));
    expect(withEstimate.estimated_grade).toEqual(ESTIMATE);
    expect(withEstimate).not.toHaveProperty('final_grade');

    mocks.gradeSummaryForStudent.mockResolvedValue(null);
    const without = await read(ctxWith(RELEASED));
    expect(without).not.toHaveProperty('final_grade');
    expect(without).not.toHaveProperty('estimated_grade');
  });

  it('reports a null estimate when there is nothing to estimate', async () => {
    mocks.gradeSummaryForStudent.mockResolvedValue(null);

    const payload = await read(ctxWith(ON));

    expect(payload).toHaveProperty('estimated_grade', null);
  });

  it('still returns the grades, with a null estimate, when the read fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.gradeSummaryForStudent.mockRejectedValue(new Error('mappings read failed'));

    const payload = await read(ctxWith(ON));

    expect(payload.count).toBe(1);
    expect(payload).toHaveProperty('estimated_grade', null);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('carries the final grade through the my_grades tool', async () => {
    mocks.gradeSummaryForStudent.mockResolvedValue({ kind: 'final', letter: 'B' });
    const result = await myGradesTool.handler(
      { classroom: 'test-org/winter-2025' },
      ctxWith(RELEASED)
    );
    const payload = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0].text
    ) as Payload;

    expect(payload.final_grade).toEqual({ letter: 'B' });
    expect(payload.count).toBe(1);
  });

  it('describes both keys, without percentages or the override kind, under 1,500 bytes', () => {
    for (const description of [gradesMineResource.description, myGradesTool.description]) {
      expect(Buffer.byteLength(description, 'utf8')).toBeLessThan(1500);
      expect(description).toContain('final_grade');
      expect(description).toContain('estimated_grade');
      expect(description).not.toContain('percent,');
      expect(description).not.toContain('override');
    }
  });
});

// ─── my_tokens ───────────────────────────────────────────────────────────────

describe('my_tokens assignment naming', () => {
  it('names quiz rows by their assignment, orphaned ones by their snapshot, repo rows as before', async () => {
    mocks.getBalance.mockResolvedValue(7);
    mocks.findTransactions.mockResolvedValue([
      {
        id: 't-quiz',
        type: 'PURCHASE',
        amount: -4,
        hours_purchased: 2,
        balance_after: 7,
        description: 'Old title · +2 h',
        is_cancelled: false,
        created_at: at(0),
        assignment_id: QUIZ_A,
        assignment: { id: QUIZ_A, title: 'Quiz A', type: 'QUIZ' },
        git_repo_assignment: null,
      },
      {
        id: 't-orphan',
        type: 'REFUND',
        amount: 4,
        hours_purchased: -2,
        balance_after: 11,
        description: quizExtensionDescription('Deleted quiz', -2),
        is_cancelled: false,
        created_at: at(1),
        assignment_id: null,
        assignment: null,
        git_repo_assignment: null,
      },
      {
        id: 't-repo',
        type: 'PURCHASE',
        amount: -2,
        hours_purchased: 1,
        balance_after: 9,
        description: 'Purchase of 1 hour(s).',
        is_cancelled: false,
        created_at: at(2),
        assignment_id: null,
        assignment: null,
        git_repo_assignment: { id: 'gra-1', assignment: { id: 'repo-asg', title: 'Lab 1' } },
      },
      {
        id: 't-grant',
        type: 'GAIN',
        amount: 5,
        hours_purchased: null,
        balance_after: 14,
        description: 'Helping in lab',
        is_cancelled: false,
        created_at: at(3),
        assignment_id: null,
        assignment: null,
        git_repo_assignment: null,
      },
    ]);

    const payload = (await tokensResource.handler(VARS, studentCtx(), URI)) as {
      balance: number;
      transactions: Array<Record<string, unknown>>;
    };

    expect(
      payload.transactions.map(t => [t.id, t.assignment_id, t.assignment_title, t.description])
    ).toEqual([
      ['t-quiz', QUIZ_A, 'Quiz A', 'Old title · +2 h'],
      ['t-orphan', null, 'Deleted quiz', 'Deleted quiz · −2 h'],
      ['t-repo', 'repo-asg', 'Lab 1', 'Purchase of 1 hour(s).'],
      ['t-grant', null, null, 'Helping in lab'],
    ]);
    expect(mocks.findTransactions).toHaveBeenCalledWith({
      classroom_id: 'class-1',
      student_id: 'stu-1',
    });
  });

  it('keeps the tool and the resource describing the same thing', () => {
    expect(myTokensTool.description).toBe(tokensResource.description);
    expect(tokensResource.description).toContain('assignment_id');
  });
});

// ─── list_quizzes (student) ─────────────────────────────────────────────────

describe('list_quizzes for a student: extension fields', () => {
  type Row = Record<string, unknown> & { my_attempts: Record<string, unknown> | null };

  function arrangeList() {
    mocks.getQuizzesForStudent.mockResolvedValue([
      {
        id: 'quiz-a',
        name: 'Quiz A',
        status: 'PUBLISHED',
        weight: 0,
        question_count: 3,
        grading_strategy: 'HIGHEST',
        assignment: {
          id: QUIZ_A,
          is_published: true,
          release_at: null,
          student_deadline: DUE,
          closes_at: null,
          weight: 10,
          module: { id: 'mod-1', title: 'Week 1' },
        },
        attempts: ATTEMPTS,
        // The service's own summary picks by raw score.
        attemptsSummary: {
          count: 2,
          canCreateNew: false,
          currentScore: 90,
          countingAttemptId: 'late-90',
        },
      },
      {
        id: 'quiz-b',
        name: 'Quiz B',
        status: 'PUBLISHED',
        weight: 0,
        question_count: 3,
        grading_strategy: 'HIGHEST',
        assignment: {
          id: QUIZ_B,
          is_published: true,
          release_at: null,
          student_deadline: null,
          closes_at: null,
          weight: 5,
          module: { id: 'mod-1', title: 'Week 1' },
        },
        attempts: [],
        attemptsSummary: {
          count: 0,
          canCreateNew: true,
          currentScore: null,
          countingAttemptId: null,
        },
      },
      {
        id: 'quiz-legacy',
        name: 'No module',
        status: 'PUBLISHED',
        weight: 0,
        question_count: 3,
        due_date: at(24),
        assignment: null,
        attemptsSummary: { count: 0, canCreateNew: true, currentScore: null },
      },
    ]);
    setPrismaRows({
      assignment: {
        findMany: [
          { id: QUIZ_A, tokens_per_hour: null },
          { id: QUIZ_B, tokens_per_hour: 0 },
        ],
      },
    });
  }

  const settings = { default_tokens_per_hour: 2, late_penalty_points_per_hour: 4 };

  it('gives each quiz its assignment id, price, hours bought and effective due date', async () => {
    arrangeList();
    mocks.netQuizExtensionHours.mockResolvedValue(new Map([[QUIZ_A, 3]]));

    const { quizzes } = (await quizzesResource.handler(VARS, studentCtx(settings), URI)) as {
      quizzes: Row[];
    };

    expect(
      quizzes.map(q => [
        q.id,
        q.assignment_id,
        q.effective_tokens_per_hour,
        q.extension_hours,
        q.effective_due_date,
      ])
    ).toEqual([
      ['quiz-a', QUIZ_A, 2, 3, at(3)],
      ['quiz-b', QUIZ_B, 0, 0, null],
      ['quiz-legacy', null, 0, 0, at(24)],
    ]);
    // Two reads for the whole list, both scoped to the classroom and caller.
    expect(prismaCallsFor('assignment', 'findMany')).toHaveLength(1);
    expect(
      (prismaCallsFor('assignment', 'findMany')[0].args as { where: unknown }).where
    ).toMatchObject({
      id: { in: [QUIZ_A, QUIZ_B] },
      module: { classroom_id: 'class-1' },
    });
    expect(mocks.netQuizExtensionHours).toHaveBeenCalledTimes(1);
    expect(mocks.netQuizExtensionHours).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: 'stu-1',
      assignmentIds: [QUIZ_A, QUIZ_B],
    });
  });

  it('names the attempt the grade counts, at its raw score, with its late hours', async () => {
    arrangeList();

    const { quizzes } = (await quizzesResource.handler(VARS, studentCtx(settings), URI)) as {
      quizzes: Row[];
    };

    // Penalised, the late 90 is a 70: the on-time 80 counts, shown as 80.
    expect(quizzes[0].my_attempts).toEqual({
      count: 2,
      canCreateNew: false,
      currentScore: 80,
      countingAttemptId: 'ontime-80',
      lateHours: 0,
    });
    // No assignment: the service's summary passes through untouched.
    expect(quizzes[2].my_attempts).toEqual({ count: 0, canCreateNew: true, currentScore: null });
  });

  it('lets bought hours change which attempt counts', async () => {
    arrangeList();
    mocks.netQuizExtensionHours.mockResolvedValue(new Map([[QUIZ_A, 3]]));

    const { quizzes } = (await quizzesResource.handler(VARS, studentCtx(settings), URI)) as {
      quizzes: Row[];
    };

    expect(quizzes[0].my_attempts).toMatchObject({
      currentScore: 90,
      countingAttemptId: 'late-90',
      lateHours: 2,
    });
  });

  it('gates the list on the predicate the totals use', async () => {
    arrangeList();

    await quizzesResource.handler(VARS, studentCtx(settings), URI);
    expect(mocks.quizzesVisibleOrThrow).toHaveBeenCalledWith('class-1');

    // Hidden (e.g. no AI agent configured): refused before anything is read.
    mocks.getQuizzesForStudent.mockClear();
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);
    await expect(quizzesResource.handler(VARS, studentCtx(settings), URI)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(mocks.getQuizzesForStudent).not.toHaveBeenCalled();

    // A failed lookup fails the read rather than answering an empty list.
    mocks.quizzesVisibleOrThrow.mockRejectedValue(new Error('db down'));
    await expect(quizzesResource.handler(VARS, studentCtx(settings), URI)).rejects.toThrow(
      'db down'
    );
    expect(mocks.getQuizzesForStudent).not.toHaveBeenCalled();
  });

  it('makes no extension reads when no quiz has an assignment', async () => {
    mocks.getQuizzesForStudent.mockResolvedValue([
      { id: 'q', name: 'Q', status: 'PUBLISHED', weight: 0, question_count: 1, assignment: null },
    ]);

    await quizzesResource.handler(VARS, studentCtx(settings), URI);

    expect(prismaCallsFor('assignment')).toHaveLength(0);
    expect(mocks.netQuizExtensionHours).not.toHaveBeenCalled();
  });

  it('carries one description on the tool and the resource, under the byte cut', () => {
    expect(listQuizzesTool.description).toBe(QUIZZES_DESCRIPTION);
    expect(quizzesResource.description).toBe(QUIZZES_DESCRIPTION);
    expect(Buffer.byteLength(QUIZZES_DESCRIPTION, 'utf8')).toBeLessThan(1500);
  });
});
