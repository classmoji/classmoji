import { describe, it, expect, vi, beforeEach } from 'vitest';

// token.purchaseQuizExtensionHours: extension hours on a QUIZ assignment.
// Price and every gate are decided in the service from the database: the
// assignment is a quiz students can see in the payer's classroom, the payer is
// a STUDENT there, it has a due date, and the price per hour is above 0.
// cancelPurchase refunds it once, keeping the assignment link and a readable
// title.

const assignmentFindUniqueMock = vi.fn();
const membershipFindFirstMock = vi.fn();
const settingsFindUniqueMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const txFindFirstMock = vi.fn();
const txCreateMock = vi.fn();
const txUpdateManyMock = vi.fn();
const txFindUniqueOrThrowMock = vi.fn();
const txFindUniqueMock = vi.fn();
const executeRawMock = vi.fn();

vi.mock('@classmoji/database', () => {
  const tokenTransaction = {
    findFirst: (...args: unknown[]) => txFindFirstMock(...args),
    create: (...args: unknown[]) => txCreateMock(...args),
    updateMany: (...args: unknown[]) => txUpdateManyMock(...args),
    findUniqueOrThrow: (...args: unknown[]) => txFindUniqueOrThrowMock(...args),
    findUnique: (...args: unknown[]) => txFindUniqueMock(...args),
  };
  const $executeRaw = (...args: unknown[]) => executeRawMock(...args);
  return {
    default: () => ({
      assignment: { findUnique: (...args: unknown[]) => assignmentFindUniqueMock(...args) },
      classroomMembership: {
        findFirst: (...args: unknown[]) => membershipFindFirstMock(...args),
      },
      classroomSettings: {
        findUnique: (...args: unknown[]) => settingsFindUniqueMock(...args),
      },
      tokenTransaction,
      $transaction: (
        fn: (tx: { tokenTransaction: typeof tokenTransaction; $executeRaw: unknown }) => unknown
      ) => fn({ tokenTransaction, $executeRaw }),
    }),
  };
});
vi.mock('../entitlement.service.ts', () => ({
  quizzesVisibleOrThrow: (...args: unknown[]) => quizzesVisibleMock(...args),
}));

const {
  purchaseQuizExtensionHours,
  cancelPurchase,
  quizExtensionDescription,
  titleFromQuizExtensionDescription,
} = await import('../token.service.ts');

const NOW = new Date('2026-10-03T12:00:00Z');
const HOUR_MS = 3_600_000;
const LONG_AGO = new Date('2026-01-01T00:00:00Z');

const quizAssignment = (over: Record<string, unknown> = {}) => ({
  id: 'asg-quiz',
  type: 'QUIZ',
  title: 'Recursion quiz',
  is_published: true,
  release_at: null as Date | null,
  student_deadline: new Date(NOW.getTime() + 24 * HOUR_MS) as Date | null,
  tokens_per_hour: null as number | null,
  module: { classroom_id: 'class-1' },
  ...over,
});

const purchase = (hours = 2, over: { classroomId?: string; studentId?: string } = {}) =>
  purchaseQuizExtensionHours({
    classroomId: over.classroomId ?? 'class-1',
    studentId: over.studentId ?? 'student-1',
    assignmentId: 'asg-quiz',
    hours,
    now: NOW,
  });

const created = () => txCreateMock.mock.calls[0][0] as { data: Record<string, unknown> };

describe('token.purchaseQuizExtensionHours', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignmentFindUniqueMock.mockResolvedValue(quizAssignment());
    membershipFindFirstMock.mockResolvedValue({ id: 'm-1' });
    settingsFindUniqueMock.mockResolvedValue({ default_tokens_per_hour: 2 });
    quizzesVisibleMock.mockResolvedValue(true);
    txFindFirstMock.mockResolvedValue({ balance_after: 100, created_at: LONG_AGO });
    txCreateMock.mockImplementation((args: { data: Record<string, unknown> }) => ({
      id: 'tx-1',
      ...args.data,
    }));
  });

  it("charges the classroom's price when the quiz sets none, linked to the assignment", async () => {
    await purchase(3);

    expect(created().data).toMatchObject({
      classroom_id: 'class-1',
      student_id: 'student-1',
      assignment_id: 'asg-quiz',
      git_repo_assignment_id: null,
      amount: -6,
      hours_purchased: 3,
      type: 'PURCHASE',
      balance_after: 94,
      description: 'Recursion quiz · +3 h',
    });
  });

  it("charges the quiz's own price over the classroom's", async () => {
    assignmentFindUniqueMock.mockResolvedValue(quizAssignment({ tokens_per_hour: 5 }));
    await purchase(2);
    expect(created().data.amount).toBe(-10);
  });

  it("refuses at a price of 0: the quiz's own 0, or no price anywhere", async () => {
    assignmentFindUniqueMock.mockResolvedValue(quizAssignment({ tokens_per_hour: 0 }));
    await expect(purchase()).rejects.toThrow('Token cost not configured');

    assignmentFindUniqueMock.mockResolvedValue(quizAssignment());
    settingsFindUniqueMock.mockResolvedValue({ default_tokens_per_hour: 0 });
    await expect(purchase()).rejects.toThrow('Token cost not configured');
    expect(txCreateMock).not.toHaveBeenCalled();
  });

  it('sells hours before the due date and after it (a late completion)', async () => {
    await expect(purchase(1)).resolves.toBeTruthy();

    assignmentFindUniqueMock.mockResolvedValue(
      quizAssignment({ student_deadline: new Date(NOW.getTime() - 5 * HOUR_MS) })
    );
    await expect(purchase(5)).resolves.toBeTruthy();
  });

  it('ignores the close date: hours sell after the quiz closes', async () => {
    assignmentFindUniqueMock.mockResolvedValue(
      quizAssignment({ closes_at: new Date(NOW.getTime() - HOUR_MS) })
    );
    await expect(purchase(1)).resolves.toBeTruthy();
  });

  it('refuses a quiz with no due date', async () => {
    assignmentFindUniqueMock.mockResolvedValue(quizAssignment({ student_deadline: null }));
    await expect(purchase()).rejects.toThrow('this assignment has no deadline');
    expect(txCreateMock).not.toHaveBeenCalled();
  });

  it('refuses a payer who is not a STUDENT of the classroom', async () => {
    membershipFindFirstMock.mockResolvedValue(null);
    await expect(purchase(1, { studentId: 'ta-1' })).rejects.toThrow('only students');
    expect(membershipFindFirstMock).toHaveBeenCalledWith({
      where: { classroom_id: 'class-1', user_id: 'ta-1', role: 'STUDENT' },
      select: { id: true },
    });
    expect(txCreateMock).not.toHaveBeenCalled();
  });

  it("reads another classroom's quiz, a missing one and a repo assignment as not found", async () => {
    await expect(purchase(1, { classroomId: 'class-2' })).rejects.toThrow(
      'Quiz assignment not found.'
    );

    assignmentFindUniqueMock.mockResolvedValue(null);
    await expect(purchase()).rejects.toThrow('Quiz assignment not found.');

    assignmentFindUniqueMock.mockResolvedValue(quizAssignment({ type: 'REPO' }));
    await expect(purchase()).rejects.toThrow('Quiz assignment not found.');
    expect(txCreateMock).not.toHaveBeenCalled();
  });

  it('reads a quiz students cannot see as not found: quizzes hidden, unpublished, not open yet', async () => {
    quizzesVisibleMock.mockResolvedValue(false);
    await expect(purchase()).rejects.toThrow('Quiz assignment not found.');
    expect(quizzesVisibleMock).toHaveBeenCalledWith('class-1');

    quizzesVisibleMock.mockResolvedValue(true);
    assignmentFindUniqueMock.mockResolvedValue(quizAssignment({ is_published: false }));
    await expect(purchase()).rejects.toThrow('Quiz assignment not found.');

    assignmentFindUniqueMock.mockResolvedValue(
      quizAssignment({ release_at: new Date(NOW.getTime() + HOUR_MS) })
    );
    await expect(purchase()).rejects.toThrow('Quiz assignment not found.');
    expect(txCreateMock).not.toHaveBeenCalled();
  });

  it('lets a failed quiz-visibility lookup throw rather than refuse quietly', async () => {
    quizzesVisibleMock.mockRejectedValue(new Error('db down'));
    await expect(purchase()).rejects.toThrow('db down');
  });

  it('rejects non-integer or non-positive hours', async () => {
    await expect(purchase(0)).rejects.toThrow('Invalid hours');
    await expect(purchase(1.5)).rejects.toThrow('Invalid hours');
  });

  it("checks the balance under the student's ledger lock", async () => {
    txFindFirstMock.mockResolvedValue({ balance_after: 3, created_at: LONG_AGO });
    await expect(purchase(2)).rejects.toThrow('Insufficient token balance');
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      txFindFirstMock.mock.invocationCallOrder[0]
    );
  });
});

describe('quiz extension descriptions', () => {
  it('writes the title and the hours, and reads the title back', () => {
    expect(quizExtensionDescription('Quiz · part 2', 3)).toBe('Quiz · part 2 · +3 h');
    expect(quizExtensionDescription('Quiz', -3)).toBe('Quiz · −3 h');
    expect(titleFromQuizExtensionDescription('Quiz · part 2 · +3 h')).toBe('Quiz · part 2');
    expect(titleFromQuizExtensionDescription('Quiz · −3 h')).toBe('Quiz');
    expect(titleFromQuizExtensionDescription('Purchase of 3 hour(s).')).toBeNull();
    expect(titleFromQuizExtensionDescription(null)).toBeNull();
  });
});

describe('token.cancelPurchase on a quiz purchase', () => {
  const PURCHASE = {
    id: 'tx-9',
    classroom_id: 'class-1',
    student_id: 'student-1',
    git_repo_assignment_id: null,
    assignment_id: 'asg-quiz' as string | null,
    assignment: { title: 'Recursion quiz (renamed)' } as { title: string } | null,
    amount: -6,
    hours_purchased: 3,
    description: 'Recursion quiz · +3 h',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    txFindUniqueMock.mockResolvedValue({ classroom_id: 'class-1', student_id: 'student-1' });
    txUpdateManyMock.mockResolvedValue({ count: 1 });
    txFindUniqueOrThrowMock.mockResolvedValue(PURCHASE);
    txFindFirstMock.mockResolvedValue({ balance_after: 10, created_at: LONG_AGO });
    txCreateMock.mockImplementation((args: { data: Record<string, unknown> }) => ({
      id: 'tx-refund',
      ...args.data,
    }));
  });

  it('keeps the assignment link and names the live title with the hours taken back', async () => {
    await cancelPurchase('tx-9');

    expect(created().data).toMatchObject({
      type: 'REFUND',
      amount: 6,
      hours_purchased: -3,
      balance_after: 16,
      assignment_id: 'asg-quiz',
      git_repo_assignment_id: null,
      description: 'Recursion quiz (renamed) · −3 h',
    });
  });

  it("falls back to the purchase's own title once the assignment is gone", async () => {
    txFindUniqueOrThrowMock.mockResolvedValue({
      ...PURCHASE,
      assignment_id: null,
      assignment: null,
    });
    await cancelPurchase('tx-9');

    expect(created().data).toMatchObject({
      assignment_id: null,
      description: 'Recursion quiz · −3 h',
    });
  });
});
