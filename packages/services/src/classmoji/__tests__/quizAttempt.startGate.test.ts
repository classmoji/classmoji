/**
 * When `quizAttempt.createNew` starts an attempt.
 *
 * A student starts only a quiz that is open to them now. With an assignment,
 * the assignment decides, read in this order: it is published
 * (`quiz_not_published`), its Opens date has passed (`quiz_not_open`) and its
 * close date has not (`quiz_closed`); the quiz's own status is not read. A
 * quiz with no assignment (in no module) keeps its own rule: PUBLISHED starts,
 * DRAFT and CLOSED do not (`quiz_not_published`).
 *
 * The teaching team (OWNER, TEACHER, ASSISTANT) starts preview attempts on any
 * quiz, open or not.
 *
 * A student's own attempts are checked first: an unfinished attempt is
 * offered for resuming, and a used-up attempt count is reported as such,
 * before the quiz's schedule is looked at.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quizFindUnique: vi.fn(),
  attemptFindMany: vi.fn(),
  attemptCount: vi.fn(),
  attemptCreate: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    quiz: { findUnique: (...a: unknown[]) => mocks.quizFindUnique(...a) },
    quizAttempt: {
      findMany: (...a: unknown[]) => mocks.attemptFindMany(...a),
      count: (...a: unknown[]) => mocks.attemptCount(...a),
      create: (...a: unknown[]) => mocks.attemptCreate(...a),
    },
  }),
  GIT_IDENTITY: {},
}));

const { createNew } = await import('../quizAttempt.service.ts');

const DAY = 24 * 60 * 60 * 1000;
const past = () => new Date(Date.now() - DAY);
const future = () => new Date(Date.now() + DAY);

type AssignmentState = {
  is_published: boolean;
  release_at: Date | null;
  closes_at: Date | null;
};

const OPEN: AssignmentState = { is_published: true, release_at: null, closes_at: null };

/** The quiz row createNew reads. */
const quiz = ({
  status = 'PUBLISHED',
  assignment = OPEN,
  max_attempts = 0,
}: {
  status?: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
  assignment?: AssignmentState | null;
  max_attempts?: number;
} = {}) => ({
  id: 'quiz-1',
  classroom_id: 'class-1',
  max_attempts,
  name: 'Week 3 Quiz',
  status,
  assignment,
});

const member = (role: string) => ({ classroom_id: 'class-1', role, user_id: 'user-1' });

const start = (role = 'STUDENT') => createNew('quiz-1', 'user-1', member(role));

/** The three ways a quiz with an assignment is not open to a student. */
const NOT_OPEN: Array<[string, () => AssignmentState]> = [
  ['quiz_not_published', () => ({ ...OPEN, is_published: false })],
  ['quiz_not_open', () => ({ ...OPEN, release_at: future() })],
  ['quiz_closed', () => ({ ...OPEN, closes_at: past() })],
];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.attemptFindMany.mockResolvedValue([]);
  mocks.attemptCount.mockResolvedValue(0);
  mocks.attemptCreate.mockResolvedValue({ id: 'attempt-1' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('createNew — a student and a quiz with an assignment', () => {
  it.each(NOT_OPEN)('refuses with %s and starts nothing', async (reason, assignment) => {
    mocks.quizFindUnique.mockResolvedValue(quiz({ assignment: assignment() }));

    await expect(start()).resolves.toMatchObject({ success: false, reason });
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
  });

  it('reports the first reason in order: unpublished, then not open, then closed', async () => {
    mocks.quizFindUnique.mockResolvedValue(
      quiz({ assignment: { is_published: false, release_at: future(), closes_at: past() } })
    );
    await expect(start()).resolves.toMatchObject({ reason: 'quiz_not_published' });

    mocks.quizFindUnique.mockResolvedValue(
      quiz({ assignment: { is_published: true, release_at: future(), closes_at: past() } })
    );
    await expect(start()).resolves.toMatchObject({ reason: 'quiz_not_open' });
  });

  it('starts an attempt on a quiz that is published, open and not closed', async () => {
    mocks.quizFindUnique.mockResolvedValue(
      quiz({ assignment: { is_published: true, release_at: past(), closes_at: future() } })
    );

    await expect(start()).resolves.toMatchObject({
      success: true,
      attemptId: 'attempt-1',
      attemptCount: 1,
    });
    expect(mocks.attemptCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({ quiz_id: 'quiz-1', user_id: 'user-1' }),
    });
  });

  it('starts an attempt where the assignment has no Opens or close date', async () => {
    mocks.quizFindUnique.mockResolvedValue(quiz({ assignment: OPEN }));

    await expect(start()).resolves.toMatchObject({ success: true });
  });

  it("goes by the assignment, not the quiz's own status", async () => {
    // The assignment is open; the quiz's own column says DRAFT.
    mocks.quizFindUnique.mockResolvedValue(quiz({ status: 'DRAFT', assignment: OPEN }));
    await expect(start()).resolves.toMatchObject({ success: true });

    // The assignment is unpublished; the quiz's own column says PUBLISHED.
    mocks.quizFindUnique.mockResolvedValue(
      quiz({ status: 'PUBLISHED', assignment: { ...OPEN, is_published: false } })
    );
    await expect(start()).resolves.toMatchObject({ reason: 'quiz_not_published' });
  });

  it('reads the assignment with the quiz', async () => {
    mocks.quizFindUnique.mockResolvedValue(quiz());

    await start();

    expect(mocks.quizFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'quiz-1' },
        select: expect.objectContaining({
          assignment: { select: { is_published: true, release_at: true, closes_at: true } },
        }),
      })
    );
  });
});

describe('createNew — a student and a quiz with no assignment', () => {
  it('starts a PUBLISHED quiz', async () => {
    mocks.quizFindUnique.mockResolvedValue(quiz({ status: 'PUBLISHED', assignment: null }));

    await expect(start()).resolves.toMatchObject({ success: true, attemptId: 'attempt-1' });
  });

  it.each(['DRAFT', 'CLOSED'] as const)(
    'refuses a %s quiz with quiz_not_published',
    async status => {
      mocks.quizFindUnique.mockResolvedValue(quiz({ status, assignment: null }));

      await expect(start()).resolves.toMatchObject({
        success: false,
        reason: 'quiz_not_published',
      });
      expect(mocks.attemptCreate).not.toHaveBeenCalled();
    }
  );
});

describe("createNew — a student's own attempts come first", () => {
  it('offers an unfinished attempt for resuming, whatever the quiz schedule says', async () => {
    mocks.attemptFindMany.mockResolvedValue([{ id: 'attempt-0', started_at: past() }]);
    for (const [, assignment] of NOT_OPEN) {
      mocks.quizFindUnique.mockResolvedValue(quiz({ assignment: assignment() }));

      await expect(start()).resolves.toMatchObject({
        success: false,
        reason: 'incomplete_attempt_exists',
        existingAttemptId: 'attempt-0',
        canResume: true,
      });
    }
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
  });

  it('reports a used-up attempt count before the quiz schedule', async () => {
    mocks.attemptCount.mockResolvedValue(2);
    mocks.quizFindUnique.mockResolvedValue(
      quiz({ max_attempts: 2, assignment: { ...OPEN, closes_at: past() } })
    );

    await expect(start()).resolves.toMatchObject({
      success: false,
      reason: 'max_attempts_reached',
      maxAttempts: 2,
    });
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
  });

  it('starts another attempt within the count on an open quiz', async () => {
    mocks.attemptCount.mockResolvedValue(1);
    mocks.quizFindUnique.mockResolvedValue(quiz({ max_attempts: 2 }));

    await expect(start()).resolves.toMatchObject({ success: true, attemptCount: 2 });
  });
});

describe('createNew — the teaching team', () => {
  const blocked: Array<[string, ReturnType<typeof quiz>]> = [
    ...NOT_OPEN.map(([reason, assignment]): [string, ReturnType<typeof quiz>] => [
      reason,
      quiz({ assignment: assignment() }),
    ]),
    ['a DRAFT quiz in no module', quiz({ status: 'DRAFT', assignment: null })],
    ['a CLOSED quiz in no module', quiz({ status: 'CLOSED', assignment: null })],
  ];

  describe.each(['OWNER', 'TEACHER', 'ASSISTANT'])('%s', role => {
    it.each(blocked)('starts a preview attempt where a student gets %s', async (_label, row) => {
      mocks.quizFindUnique.mockResolvedValue(row);
      // An unfinished preview and a used-up count do not stop staff either.
      mocks.attemptCount.mockResolvedValue(5);

      await expect(start(role)).resolves.toMatchObject({ success: true, attemptId: 'attempt-1' });
      expect(mocks.attemptFindMany).not.toHaveBeenCalled();
      expect(mocks.attemptCreate).toHaveBeenCalledOnce();
    });
  });
});

describe('createNew — membership', () => {
  it("refuses a membership of another classroom before reading the quiz's attempts", async () => {
    mocks.quizFindUnique.mockResolvedValue(quiz());

    await expect(
      createNew('quiz-1', 'user-1', { classroom_id: 'class-2', role: 'STUDENT' })
    ).rejects.toThrow('Membership does not match quiz classroom');
    expect(mocks.attemptFindMany).not.toHaveBeenCalled();
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
  });
});
