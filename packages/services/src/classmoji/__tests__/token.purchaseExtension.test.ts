import { describe, it, expect, vi, beforeEach } from 'vitest';

// token.purchaseExtensionHours is the pricing + gate choreography
// extracted from the student.$class.assignments purchaseExtensionHours action
// (plan §5.2 gap 6). Price must derive from Assignment.tokens_per_hour, never
// from the caller (S9), and every gate from the popover is re-enforced. Hours
// sell at any time: there is no deadline gate and no cap but the balance.

const graFindUniqueMock = vi.fn();
const txFindManyMock = vi.fn();
const txFindFirstMock = vi.fn();
const txCreateMock = vi.fn();
const txUpdateManyMock = vi.fn();
const txFindUniqueOrThrowMock = vi.fn();
const teamMembershipFindFirstMock = vi.fn();

vi.mock('@classmoji/database', () => {
  const tokenTransaction = {
    findMany: (...args: unknown[]) => txFindManyMock(...args),
    findFirst: (...args: unknown[]) => txFindFirstMock(...args),
    create: (...args: unknown[]) => txCreateMock(...args),
    updateMany: (...args: unknown[]) => txUpdateManyMock(...args),
    findUniqueOrThrow: (...args: unknown[]) => txFindUniqueOrThrowMock(...args),
  };
  return {
    default: () => ({
      gitRepoAssignment: { findUnique: (...args: unknown[]) => graFindUniqueMock(...args) },
      teamMembership: {
        findFirst: (...args: unknown[]) => teamMembershipFindFirstMock(...args),
      },
      tokenTransaction,
      $transaction: (fn: (tx: { tokenTransaction: typeof tokenTransaction }) => unknown) =>
        fn({ tokenTransaction }),
    }),
  };
});

const { purchaseExtensionHours, cancelPurchase } = await import('../token.service.ts');

const HOUR_MS = 3_600_000;

const baseRepoAssignment = () => ({
  id: 'gra-1',
  status: 'OPEN',
  is_late_override: false,
  git_repo: {
    classroom_id: 'class-1',
    student_id: 'student-1' as string | null,
    team_id: null as string | null,
  },
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

  it("rejects a classmate's submission, identical to missing", async () => {
    const theirs = baseRepoAssignment();
    theirs.git_repo.student_id = 'student-2';
    graFindUniqueMock.mockResolvedValue(theirs);

    await expect(purchase()).rejects.toThrow('Repository assignment not found.');
    expect(txCreateMock).not.toHaveBeenCalled();
  });

  it("sells hours on a team's submission to a member of that team only", async () => {
    const team = baseRepoAssignment();
    team.git_repo.student_id = null;
    team.git_repo.team_id = 'team-1';
    graFindUniqueMock.mockResolvedValue(team);

    teamMembershipFindFirstMock.mockResolvedValue(null);
    await expect(purchase()).rejects.toThrow('Repository assignment not found.');

    teamMembershipFindFirstMock.mockResolvedValue({ id: 'tm-1' });
    await expect(purchase()).resolves.toBeTruthy();
    expect(teamMembershipFindFirstMock).toHaveBeenLastCalledWith({
      where: { team_id: 'team-1', user_id: 'student-1' },
      select: { id: true },
    });
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

  it('sells hours before the deadline: they push the deadline out', async () => {
    const gra = baseRepoAssignment();
    gra.assignment.student_deadline = new Date(Date.now() + HOUR_MS);
    graFindUniqueMock.mockResolvedValue(gra);

    await expect(purchase(4)).resolves.toBeTruthy();
    const created = txCreateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(created.data.hours_purchased).toBe(4);
    expect(created.data.amount).toBe(-12);
  });

  it('has no cap but the balance: more hours than the work is late', async () => {
    // 6 hours past the deadline; 20 hours (60 tokens of the 100) still sells.
    await expect(purchase(20)).resolves.toBeTruthy();
    // 34 hours would cost 102.
    await expect(purchase(34)).rejects.toThrow('Insufficient token balance');
  });

  it('sells hours on a submitted (CLOSED) issue-mode row', async () => {
    graFindUniqueMock.mockResolvedValue({
      ...baseRepoAssignment(),
      status: 'CLOSED',
      closed_at: new Date(),
    });
    await expect(purchase(1)).resolves.toBeTruthy();
  });

  it('rejects an assignment with no deadline: there is nothing to extend', async () => {
    const gra = baseRepoAssignment();
    (gra.assignment as { student_deadline: Date | null }).student_deadline = null;
    graFindUniqueMock.mockResolvedValue(gra);
    await expect(purchase(1)).rejects.toThrow('this assignment has no deadline');
    expect(txCreateMock).not.toHaveBeenCalled();
  });

  it('propagates the insufficient-balance rejection from updateExtension', async () => {
    txFindFirstMock.mockResolvedValue({ balance_after: 2 });
    await expect(purchase(2)).rejects.toThrow('Insufficient token balance');
    expect(txCreateMock).not.toHaveBeenCalled();
  });
});

describe('token.purchaseExtensionHours in REPO mode (a push is the submission)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txFindManyMock.mockResolvedValue([]);
    txFindFirstMock.mockResolvedValue({ balance_after: 100 });
    txCreateMock.mockImplementation((args: { data: Record<string, unknown> }) => ({
      id: 'tx-1',
      ...args.data,
    }));
  });

  const purchase = (hours = 1) =>
    purchaseExtensionHours({
      classroomId: 'class-1',
      studentId: 'student-1',
      gitRepoAssignmentId: 'gra-1',
      hours,
    });

  it('lets a student who pushed late buy hours afterwards', async () => {
    const base = baseRepoAssignment();
    graFindUniqueMock.mockResolvedValue({
      ...base,
      // Submitted (pushed) 2h1m after the deadline.
      status: 'CLOSED',
      closed_at: new Date(base.assignment.student_deadline.getTime() + 2 * HOUR_MS + 60_000),
      assignment: { ...base.assignment, submission_mode: 'REPO' },
    });

    await expect(purchase(3)).resolves.toBeTruthy();
  });

  it('lets a student who pushed on time buy hours to keep working', async () => {
    const base = baseRepoAssignment();
    graFindUniqueMock.mockResolvedValue({
      ...base,
      status: 'CLOSED',
      closed_at: new Date(base.assignment.student_deadline.getTime() - HOUR_MS),
      assignment: { ...base.assignment, submission_mode: 'REPO' },
    });

    await expect(purchase(2)).resolves.toBeTruthy();
  });

  it('sells hours before anything is pushed, ahead of the deadline', async () => {
    const base = baseRepoAssignment();
    graFindUniqueMock.mockResolvedValue({
      ...base,
      status: 'OPEN',
      closed_at: null,
      assignment: {
        ...base.assignment,
        submission_mode: 'REPO',
        student_deadline: new Date(Date.now() + 24 * HOUR_MS),
      },
    });

    await expect(purchase(6)).resolves.toBeTruthy();
  });
});

describe('token.cancelPurchase', () => {
  const PURCHASE = {
    id: 'tx-9',
    classroom_id: 'class-1',
    student_id: 'student-1',
    git_repo_assignment_id: 'gra-1',
    amount: -6,
    hours_purchased: 2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    txUpdateManyMock.mockResolvedValue({ count: 1 });
    txFindUniqueOrThrowMock.mockResolvedValue(PURCHASE);
    txFindFirstMock.mockResolvedValue({ balance_after: 10 });
    txCreateMock.mockImplementation((args: { data: Record<string, unknown> }) => ({
      id: 'tx-refund',
      ...args.data,
    }));
  });

  it('flips only a standing purchase, then refunds its tokens and takes its hours back', async () => {
    await cancelPurchase('tx-9');

    expect(txUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'tx-9', type: 'PURCHASE', is_cancelled: false },
      data: { is_cancelled: true },
    });
    const created = txCreateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(created.data).toMatchObject({
      type: 'REFUND',
      amount: 6,
      hours_purchased: -2,
      balance_after: 16,
      classroom_id: 'class-1',
      student_id: 'student-1',
      git_repo_assignment_id: 'gra-1',
    });
  });

  it('refunds nothing a second time, or for a transaction that is not a purchase', async () => {
    // Already cancelled, a GAIN, a REFUND: the conditional flip matches no row.
    txUpdateManyMock.mockResolvedValue({ count: 0 });

    await expect(cancelPurchase('tx-9')).rejects.toThrow('not already cancelled');
    expect(txCreateMock).not.toHaveBeenCalled();
  });
});
