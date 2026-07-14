import { describe, it, expect, vi, beforeEach } from 'vitest';

// token.purchaseExtensionHours is the pricing + deadline-gate choreography
// extracted from the student.$class.assignments purchaseExtensionHours action
// (plan §5.2 gap 6). Price must derive from Assignment.tokens_per_hour, never
// from the caller (S9), and every gate from the popover is re-enforced.

const graFindUniqueMock = vi.fn();
const txFindManyMock = vi.fn();
const txFindFirstMock = vi.fn();
const txCreateMock = vi.fn();

vi.mock('@classmoji/database', () => {
  const tokenTransaction = {
    findMany: (...args: unknown[]) => txFindManyMock(...args),
    findFirst: (...args: unknown[]) => txFindFirstMock(...args),
    create: (...args: unknown[]) => txCreateMock(...args),
  };
  return {
    default: () => ({
      gitRepoAssignment: { findUnique: (...args: unknown[]) => graFindUniqueMock(...args) },
      tokenTransaction,
      $transaction: (fn: (tx: { tokenTransaction: typeof tokenTransaction }) => unknown) =>
        fn({ tokenTransaction }),
    }),
  };
});

const { purchaseExtensionHours } = await import('../token.service.ts');

const HOUR_MS = 3_600_000;

const baseRepoAssignment = () => ({
  id: 'gra-1',
  status: 'OPEN',
  is_late_override: false,
  git_repo: { classroom_id: 'class-1', student_id: 'student-1' },
  assignment: {
    tokens_per_hour: 3,
    // Deadline 5h1m ago → 6 hours past deadline (ceil)
    student_deadline: new Date(Date.now() - 5 * HOUR_MS - 60_000),
  },
});

describe('token.purchaseExtensionHours', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    graFindUniqueMock.mockResolvedValue(baseRepoAssignment());
    txFindManyMock.mockResolvedValue([]);
    txFindFirstMock.mockResolvedValue({ balance_after: 100 });
    txCreateMock.mockImplementation((args: { data: Record<string, unknown> }) => ({
      id: 'tx-1',
      ...args.data,
    }));
  });

  const purchase = (hours = 2) =>
    purchaseExtensionHours({
      classroomId: 'class-1',
      studentId: 'student-1',
      gitRepoAssignmentId: 'gra-1',
      hours,
    });

  it('derives the price from tokens_per_hour (never the caller) and records the purchase', async () => {
    const tx = await purchase(2);

    expect(txCreateMock).toHaveBeenCalledTimes(1);
    const created = txCreateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(created.data.amount).toBe(-6); // 3 tokens/hour * 2 hours, negative spend
    expect(created.data.hours_purchased).toBe(2);
    expect(created.data.type).toBe('PURCHASE');
    expect(created.data.git_repo_assignment_id).toBe('gra-1');
    expect(created.data.balance_after).toBe(94);
    expect(tx.id).toBe('tx-1');
  });

  it('rejects non-integer or non-positive hours', async () => {
    await expect(purchase(0)).rejects.toThrow('Invalid hours');
    await expect(purchase(1.5)).rejects.toThrow('Invalid hours');
  });

  it('rejects submissions outside the classroom (identical to missing)', async () => {
    const foreign = baseRepoAssignment();
    foreign.git_repo.classroom_id = 'other-class';
    graFindUniqueMock.mockResolvedValue(foreign);
    await expect(purchase()).rejects.toThrow('Repository assignment not found.');

    graFindUniqueMock.mockResolvedValue(null);
    await expect(purchase()).rejects.toThrow('Repository assignment not found.');
  });

  it('rejects when a late override is in effect', async () => {
    graFindUniqueMock.mockResolvedValue({ ...baseRepoAssignment(), is_late_override: true });
    await expect(purchase()).rejects.toThrow('a late override is in effect');
  });

  it('rejects when tokens_per_hour is not configured', async () => {
    const gra = baseRepoAssignment();
    gra.assignment.tokens_per_hour = 0;
    graFindUniqueMock.mockResolvedValue(gra);
    await expect(purchase()).rejects.toThrow('Token cost not configured');
  });

  it('rejects when the deadline has not passed', async () => {
    const gra = baseRepoAssignment();
    gra.assignment.student_deadline = new Date(Date.now() + HOUR_MS);
    graFindUniqueMock.mockResolvedValue(gra);
    await expect(purchase()).rejects.toThrow('has not passed yet');
  });

  it('caps hours at hours-past-deadline minus already-purchased hours', async () => {
    // 6 hours past deadline, 5 already purchased → 1 purchasable
    txFindManyMock.mockResolvedValue([{ hours_purchased: 5 }]);
    await expect(purchase(2)).rejects.toThrow(
      'You can purchase at most 1 more late hour(s) for this assignment.'
    );
  });

  it('rejects when no purchasable hours remain (CLOSED submissions accrue none)', async () => {
    graFindUniqueMock.mockResolvedValue({ ...baseRepoAssignment(), status: 'CLOSED' });
    await expect(purchase(1)).rejects.toThrow('No purchasable late hours remain');
  });

  it('propagates the insufficient-balance rejection from updateExtension', async () => {
    txFindFirstMock.mockResolvedValue({ balance_after: 2 });
    await expect(purchase(2)).rejects.toThrow('Insufficient token balance');
    expect(txCreateMock).not.toHaveBeenCalled();
  });
});
