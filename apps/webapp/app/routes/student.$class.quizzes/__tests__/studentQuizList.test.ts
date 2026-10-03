/**
 * The student quiz list's payload.
 *
 * `quiz.getQuizzesForStudent` used to spread each of the student's attempt rows
 * into its result, so every attempt carried the agent config, the session
 * token, the grading columns and the codebase path alongside what the attempts
 * table shows. The list stays mounted under the attempt drawer and revalidates
 * with it, so that went out on every poll. The service now selects the attempt
 * columns it reads, and the loader narrows each attempt, and the per-quiz
 * summary, to the fields the list reads (~/utils/quizPayloads). The fake below
 * still returns whole rows, so the loader's own narrowing is what is pinned.
 *
 * The REAL service map runs here, against a fake of the one query it makes,
 * so the test feeds the loader exactly the shape the service hands it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  quizFindMany: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  netQuizExtensionHours: vi.fn(),
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({ quiz: { findMany: (...a: unknown[]) => mocks.quizFindMany(...a) } }),
}));
// Pulled in by quiz.service; nothing here sends a notification.
vi.mock('../../../../../../packages/services/src/classmoji/notification.service.ts', () => ({}));

vi.mock('@classmoji/services', async () => {
  const quiz = await import('../../../../../../packages/services/src/classmoji/quiz.service.ts');
  return {
    ClassmojiService: {
      quiz,
      user: { findById: async () => ({ id: 'stu-ada', login: 'ada' }) },
      quizGradeItems: {
        netQuizExtensionHours: (...a: unknown[]) => mocks.netQuizExtensionHours(...a),
      },
    },
    QuizAccessError: quiz.QuizAccessError,
  };
});

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
}));

// The loader is under test; the view layer only needs to import.
vi.mock('~/components', () => ({ Countdown: () => null }));
vi.mock('~/utils/quizUtils', () => ({ formatDuration: () => '' }));
vi.mock('antd', () => ({
  Table: () => null,
  Badge: () => null,
  Typography: { Text: () => null },
  Button: () => null,
  Modal: Object.assign(() => null, { confirm: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  Tag: () => null,
  Tooltip: () => null,
  Space: () => null,
  Select: () => null,
  Spin: () => null,
}));
vi.mock('@ant-design/icons', () => ({
  CheckCircleOutlined: () => null,
  PlayCircleOutlined: () => null,
  TrophyOutlined: () => null,
}));
vi.mock('react-router', () => ({
  Outlet: () => null,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/student/cs52-26f/quizzes' }),
}));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';

const SENTINEL = {
  systemPrompt: 'SENTINEL-SYSTEM-PROMPT',
  rubricPrompt: 'SENTINEL-RUBRIC-PROMPT',
  sessionToken: 'SENTINEL-SESSION-TOKEN',
  codebasePath: 'SENTINEL-CODEBASE-PATH',
  feedback: 'SENTINEL-FEEDBACK',
  questionResults: 'SENTINEL-QUESTION-RESULTS',
  conversation: 'SENTINEL-CONVERSATION',
};

const attemptRow = (id: string, over: Record<string, unknown>) => ({
  id,
  quiz_id: 'quiz-1',
  user_id: 'stu-ada',
  conversation_id: `${SENTINEL.conversation}-${id}`,
  started_at: new Date('2026-03-01T10:00:00Z'),
  completed_at: null,
  score: null,
  feedback: SENTINEL.feedback,
  attempt_number: 1,
  questions_asked: 3,
  session_token: `${SENTINEL.sessionToken}-${id}`,
  last_activity: new Date('2026-03-01T10:30:00Z'),
  total_duration_ms: null,
  unfocused_duration_ms: null,
  modal_closed_at: null,
  question_results_json: { note: SENTINEL.questionResults },
  partial_credit_percentage: null,
  first_attempt_percentage: null,
  session_status: 'active',
  codebase_path: SENTINEL.codebasePath,
  // The shape the agent config takes when a quiz session stores its prompts.
  agent_config: { systemPrompt: SENTINEL.systemPrompt, rubricPrompt: SENTINEL.rubricPrompt },
  created_at: new Date('2026-03-01T10:00:00Z'),
  updated_at: new Date('2026-03-01T10:30:00Z'),
  ...over,
});

// Newest first, the order the service queries them in.
const IN_PROGRESS = attemptRow('attempt-2', { started_at: new Date('2026-03-02T10:00:00Z') });
const COMPLETED = attemptRow('attempt-1', {
  completed_at: new Date('2026-03-01T10:20:00Z'),
  partial_credit_percentage: 85,
  total_duration_ms: 1000,
  unfocused_duration_ms: 100,
});

const QUIZ_ROW = {
  id: 'quiz-1',
  classroom_id: 'class-1',
  repository_id: null,
  repository: null,
  name: 'Recursion',
  system_prompt: SENTINEL.systemPrompt,
  rubric_prompt: SENTINEL.rubricPrompt,
  due_date: null,
  status: 'PUBLISHED',
  weight: 10,
  question_count: 5,
  difficulty_level: 'Beginner',
  subject: 'CS',
  include_code_context: false,
  grading_strategy: 'HIGHEST',
  max_attempts: 3,
  attempts: [IN_PROGRESS, COMPLETED],
};

const load = () =>
  route.loader({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/student/${CLASS_SLUG}/quizzes`),
  } as never);

beforeEach(() => {
  mocks.assertClassroomAccess.mockReset();
  mocks.quizFindMany.mockReset();
  mocks.quizzesVisibleOrThrow.mockReset();
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'stu-ada',
    classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' },
    membership: { role: 'STUDENT', classroom_id: 'class-1', user_id: 'stu-ada' },
  });
  mocks.quizFindMany.mockResolvedValue([QUIZ_ROW]);
  mocks.netQuizExtensionHours.mockReset();
  mocks.netQuizExtensionHours.mockResolvedValue(new Map());
});

describe('student quiz list payload', () => {
  it('gives each attempt exactly the fields the attempts table and tabs read', async () => {
    const payload = await load();
    const attempts = payload.quizzes[0].attempts;

    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(Object.keys(attempt).sort()).toEqual(
        [
          'attemptNumber',
          'completed_at',
          'focusMetrics',
          'id',
          'isCounting',
          'lateHours',
          'partialCreditScore',
          'status',
        ].sort()
      );
      for (const field of [
        'agent_config',
        'session_token',
        'question_results_json',
        'codebase_path',
        'feedback',
        'conversation_id',
      ]) {
        expect(field in attempt).toBe(false);
      }
    }
  });

  it('carries no prompt, session token or codebase path anywhere', async () => {
    const serialized = JSON.stringify(await load());

    for (const sentinel of Object.values(SENTINEL)) expect(serialized).not.toContain(sentinel);
  });

  it('still gives the list what it renders', async () => {
    const [quiz] = (await load()).quizzes;

    expect(quiz.attempts).toEqual([
      {
        id: 'attempt-2',
        attemptNumber: 2,
        status: 'in_progress',
        completed_at: null,
        partialCreditScore: null,
        focusMetrics: null,
        isCounting: false,
        lateHours: 0,
      },
      {
        id: 'attempt-1',
        attemptNumber: 1,
        status: 'completed',
        completed_at: COMPLETED.completed_at,
        partialCreditScore: 85,
        focusMetrics: { totalMs: 1000, focusedMs: 900, percentage: 90 },
        isCounting: true,
        lateHours: 0,
      },
    ]);
    expect(quiz.attemptStatus).toBe('in_progress');
    expect(quiz.score).toBe(85);
  });

  it('gives the summary the fields the list reads, maxAttempts included', async () => {
    const [quiz] = (await load()).quizzes;

    expect(quiz.attemptsSummary).toEqual({
      count: 2,
      canCreateNew: true,
      currentScore: 85,
      currentLateHours: 0,
      maxAttempts: 3,
    });
  });

  it('sends the quiz itself without its prompts', async () => {
    const [quiz] = (await load()).quizzes;

    expect('system_prompt' in quiz).toBe(false);
    expect('rubric_prompt' in quiz).toBe(false);
    expect('systemPrompt' in quiz).toBe(false);
    expect('rubricPrompt' in quiz).toBe(false);
  });
});

describe('student quiz list — due date, closed quizzes, zero scores', () => {
  it('asks for closed quizzes too', async () => {
    await load();

    // A quiz in no module is listed by its own status, closed ones included;
    // one with an assignment by the assignment (and kept once it closes).
    const [, legacy] = mocks.quizFindMany.mock.calls[0][0].where.OR;
    expect(legacy.status).toEqual({ in: ['PUBLISHED', 'CLOSED'] });
  });

  it("shows the assignment's due date where the quiz has an assignment", async () => {
    const assignmentDue = new Date('2026-10-02T18:00:00Z');
    mocks.quizFindMany.mockResolvedValue([
      {
        ...QUIZ_ROW,
        due_date: new Date('2026-09-30T18:00:00Z'),
        assignment: {
          id: 'asg-1',
          is_published: true,
          release_at: null,
          student_deadline: assignmentDue,
          closes_at: null,
          weight: 10,
        },
      },
    ]);

    const [quiz] = (await load()).quizzes;

    expect(quiz.dueDate).toEqual(assignmentDue);
  });

  it("falls back to the quiz's own due date when it has no assignment", async () => {
    const quizDue = new Date('2026-09-30T18:00:00Z');
    mocks.quizFindMany.mockResolvedValue([{ ...QUIZ_ROW, due_date: quizDue, assignment: null }]);

    const [quiz] = (await load()).quizzes;

    expect(quiz.dueDate).toEqual(quizDue);
  });

  it('keeps a closed quiz, with its score, and offers no new attempt', async () => {
    mocks.quizFindMany.mockResolvedValue([
      { ...QUIZ_ROW, status: 'CLOSED', attempts: [COMPLETED] },
    ]);

    const [quiz] = (await load()).quizzes;

    expect(quiz.closed).toBe(true);
    expect(quiz.score).toBe(85);
    expect(quiz.attemptsSummary.canCreateNew).toBe(false);
  });

  it("reads a quiz with an assignment as closed once the assignment's close date passes", async () => {
    // The quiz's own status was written PUBLISHED when it was saved; the close
    // date passed afterwards and nothing rewrote it.
    mocks.quizFindMany.mockResolvedValue([
      {
        ...QUIZ_ROW,
        status: 'PUBLISHED',
        attempts: [],
        assignment: {
          is_published: true,
          release_at: null,
          student_deadline: null,
          closes_at: new Date(Date.now() - 60_000),
          weight: 10,
        },
      },
    ]);

    const [quiz] = (await load()).quizzes;

    expect(quiz.closed).toBe(true);
    expect(quiz.attemptsSummary.canCreateNew).toBe(false);
  });

  it("takes the weight from the quiz's assignment, so a weight-0 one reads as practice", async () => {
    mocks.quizFindMany.mockResolvedValue([
      {
        ...QUIZ_ROW,
        weight: 10,
        assignment: {
          is_published: true,
          release_at: null,
          student_deadline: null,
          closes_at: null,
          weight: 0,
        },
      },
    ]);

    const [quiz] = (await load()).quizzes;

    expect(quiz.weight).toBe(0);
    expect(quiz.closed).toBe(false);
  });

  it('reports a 0 as a score, not as no score', async () => {
    mocks.quizFindMany.mockResolvedValue([
      { ...QUIZ_ROW, attempts: [{ ...COMPLETED, partial_credit_percentage: 0 }] },
    ]);

    const [quiz] = (await load()).quizzes;

    expect(quiz.score).toBe(0);
    expect(quiz.attemptsSummary.currentScore).toBe(0);
  });
});

describe('student quiz list — late attempts and hours bought', () => {
  const DUE = new Date('2026-03-01T10:00:00Z');
  const HOUR = 3_600_000;
  const done = (id: string, lateBy: number, pct: number, startedAt = lateBy) =>
    attemptRow(id, {
      started_at: new Date(DUE.getTime() + startedAt * HOUR - HOUR),
      completed_at: new Date(DUE.getTime() + lateBy * HOUR + 10 * 60_000),
      partial_credit_percentage: pct,
    });
  const withPenalty = (points: number) =>
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'stu-ada',
      classroom: {
        id: 'class-1',
        slug: CLASS_SLUG,
        status: 'ACTIVE',
        settings: { late_penalty_points_per_hour: points },
      },
      membership: { role: 'STUDENT', classroom_id: 'class-1', user_id: 'stu-ada' },
    });
  const withAssignment = (attempts: unknown[]) => ({
    ...QUIZ_ROW,
    attempts,
    assignment: {
      id: 'asg-1',
      is_published: true,
      release_at: null,
      student_deadline: DUE,
      closes_at: null,
      weight: 10,
    },
  });

  it('marks each attempt late, and shows the raw score of the attempt that counts after the penalty', async () => {
    withPenalty(5);
    // The late 90 counts 65 after 5 h at 5 points; the on-time 70 counts.
    mocks.quizFindMany.mockResolvedValue([
      withAssignment([done('late', 5, 90, 5), done('early', -2, 70, -2)]),
    ]);

    const [quiz] = (await load()).quizzes;

    expect(quiz.attempts.map(a => [a.id, a.lateHours, a.isCounting])).toEqual([
      ['late', 5, false],
      ['early', 0, true],
    ]);
    expect(quiz.attemptsSummary).toMatchObject({ currentScore: 70, currentLateHours: 0 });
    expect(quiz.score).toBe(70);
  });

  it('shows the late hours beside the score when the late attempt still counts', async () => {
    withPenalty(1);
    mocks.quizFindMany.mockResolvedValue([
      withAssignment([done('late', 3, 82, 3), done('early', -2, 70, -2)]),
    ]);

    const [quiz] = (await load()).quizzes;

    expect(quiz.attemptsSummary).toMatchObject({ currentScore: 82, currentLateHours: 3 });
  });

  it('adds the hours bought to the due date and to every attempt', async () => {
    mocks.netQuizExtensionHours.mockResolvedValue(new Map([['asg-1', 4]]));
    mocks.quizFindMany.mockResolvedValue([withAssignment([done('late', 5, 90)])]);

    const [quiz] = (await load()).quizzes;

    expect(mocks.netQuizExtensionHours).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: 'stu-ada',
      assignmentIds: ['asg-1'],
    });
    expect(quiz.dueDate).toEqual(new Date(DUE.getTime() + 4 * HOUR));
    expect(quiz.extensionHours).toBe(4);
    expect(quiz.attempts[0].lateHours).toBe(1);
  });

  it("never marks a staff member's preview attempts late, and reads no purchases for them", async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'ta-1',
      classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' },
      membership: { role: 'ASSISTANT', classroom_id: 'class-1', user_id: 'ta-1' },
    });
    mocks.quizFindMany.mockResolvedValue([withAssignment([done('late', 5, 90)])]);

    const [quiz] = (await load()).quizzes;

    expect(quiz.attempts[0].lateHours).toBe(0);
    expect(quiz.attemptsSummary.currentLateHours).toBe(0);
    expect(quiz.dueDate).toEqual(DUE);
    expect(mocks.netQuizExtensionHours).not.toHaveBeenCalled();
  });
});

describe('student quiz list without quizzes', () => {
  it('answers 404 before reading anything when the classroom has no quizzes', async () => {
    // Not Pro, or switched off: the URL names nothing, and says nothing about
    // upgrading or about quizzes being disabled.
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);

    const thrown = (await load().catch(e => e)) as Response;

    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(404);
    expect(await thrown.text()).toBe('Not Found');
    expect(mocks.quizzesVisibleOrThrow).toHaveBeenCalledWith('class-1');
    expect(mocks.quizFindMany).not.toHaveBeenCalled();
  });

  it('lets a failed visibility lookup surface as an error, not a 404', async () => {
    const failure = new Error("Can't reach database server");
    mocks.quizzesVisibleOrThrow.mockRejectedValue(failure);

    await expect(load()).rejects.toBe(failure);
    expect(mocks.quizFindMany).not.toHaveBeenCalled();
  });

  it('asks only after the access gate has admitted the viewer', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    const thrown = (await load().catch(e => e)) as Response;

    expect(thrown.status).toBe(403);
    expect(mocks.quizzesVisibleOrThrow).not.toHaveBeenCalled();
  });
});
