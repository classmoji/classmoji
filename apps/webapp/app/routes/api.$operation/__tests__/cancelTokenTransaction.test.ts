/**
 * `/api/operation?action=cancelTokenTransaction`: cancelling a purchase of
 * extension hours (the owner, or the student who bought it).
 *
 * Held here: the transaction is re-read from the database and the gate is on
 * ITS classroom, with the stored student as the resource owner; only a
 * standing purchase is cancelled; the token service is handed the actor the
 * gate resolved (user, role, the admin viewing as them, `web:tokens.cancel`),
 * which records the cancel once the refund commits; the route writes no audit
 * row of its own and answers as it did.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findTransactions: vi.fn(),
  cancelPurchase: vi.fn(),
  assertClassroomAccess: vi.fn(),
  requestImpersonator: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    audit: { record: (...a: unknown[]) => mocks.auditRecord(...a) },
    token: {
      findTransactions: (...a: unknown[]) => mocks.findTransactions(...a),
      cancelPurchase: (...a: unknown[]) => mocks.cancelPurchase(...a),
    },
  },
}));
vi.mock('@classmoji/auth/server', async () => {
  const predicates = await vi.importActual<typeof import('@classmoji/auth/predicates')>(
    '@classmoji/auth/predicates'
  );
  return {
    ...predicates,
    getAuthSession: async () => ({ userId: 'stu-1', session: { session: {} } }),
  };
});
vi.mock('@classmoji/auth/request-impersonator', () => ({
  requestImpersonator: (...a: unknown[]) => mocks.requestImpersonator(...a),
}));
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: vi.fn() } }));
vi.mock('~/utils/helpers', () => ({
  checkAuth: (handler: unknown) => handler,
  waitForRunCompletion: vi.fn(),
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
}));

const { action } = await import('../route');

const post = (body: unknown) =>
  (action as unknown as (args: unknown) => Promise<unknown>)({
    request: new Request('http://localhost/api/operation/?action=cancelTokenTransaction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });

/** A react-router `data()` response's body and status, or a plain object as is. */
const unwrap = (result: unknown) => {
  const r = result as { data?: unknown; init?: { status?: number } | null; type?: string };
  return r && r.type === 'DataWithResponseInit'
    ? { body: r.data as Record<string, unknown>, status: r.init?.status ?? 200 }
    : { body: result as Record<string, unknown>, status: 200 };
};

const PURCHASE = {
  id: 'tx-buy',
  classroom_id: 'class-1',
  student_id: 'stu-1',
  type: 'PURCHASE',
  is_cancelled: false,
  amount: -6,
};

const gateAs = (userId: string, role: string) =>
  mocks.assertClassroomAccess.mockResolvedValue({
    userId,
    classroom: { id: 'class-1', status: 'ACTIVE' },
    membership: { role },
    isResourceOwner: userId === PURCHASE.student_id,
    accessGrantedVia: userId === PURCHASE.student_id ? 'ownership' : 'role',
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findTransactions.mockResolvedValue([PURCHASE]);
  mocks.cancelPurchase.mockResolvedValue({
    refund: { id: 'tx-refund' },
    audit: { written: 1, missed: 0 },
  });
  mocks.requestImpersonator.mockResolvedValue(null);
  gateAs('stu-1', 'STUDENT');
});

describe('cancelTokenTransaction', () => {
  it("gates on the stored transaction's classroom and student, never the body", async () => {
    await post({ transaction: { id: 'tx-buy', amount: -999, classroom_id: 'class-2' } });

    expect(mocks.findTransactions).toHaveBeenCalledWith({ id: 'tx-buy' });
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomId: 'class-1',
        allowedRoles: ['OWNER'],
        resourceOwnerId: 'stu-1',
        selfAccessRoles: ['STUDENT'],
      })
    );
  });

  it('the student cancels their own: the service is told who, the answer is unchanged', async () => {
    const result = await post({ transaction: { id: 'tx-buy' } });

    expect(mocks.cancelPurchase).toHaveBeenCalledTimes(1);
    expect(mocks.cancelPurchase).toHaveBeenCalledWith('tx-buy', {
      actor: { userId: 'stu-1', role: 'STUDENT', tool: 'web:tokens.cancel', impersonatedBy: null },
    });
    expect(result).toEqual({
      action: 'CANCEL_TOKEN_TRANSACTION',
      success: 'Your transaction has been cancelled',
    });
    expect(mocks.auditRecord).not.toHaveBeenCalled();
  });

  it('the owner cancels, under View as: the owner and the admin', async () => {
    gateAs('owner-1', 'OWNER');
    mocks.requestImpersonator.mockResolvedValue('admin-1');

    const result = await post({ transaction: { id: 'tx-buy' } });

    expect(mocks.cancelPurchase).toHaveBeenCalledWith('tx-buy', {
      actor: {
        userId: 'owner-1',
        role: 'OWNER',
        tool: 'web:tokens.cancel',
        impersonatedBy: 'admin-1',
      },
    });
    expect(result).toEqual({
      action: 'CANCEL_TOKEN_TRANSACTION',
      success: 'Transaction cancelled',
    });
    expect(mocks.auditRecord).not.toHaveBeenCalled();
  });

  it('answers the same when the service could not write its row', async () => {
    mocks.cancelPurchase.mockResolvedValue({
      refund: { id: 'tx-refund' },
      audit: { written: 0, missed: 1 },
    });
    await expect(post({ transaction: { id: 'tx-buy' } })).resolves.toEqual({
      action: 'CANCEL_TOKEN_TRANSACTION',
      success: 'Your transaction has been cancelled',
    });
  });

  it('refuses a transaction that is not a standing purchase, before the service', async () => {
    for (const stored of [
      { ...PURCHASE, type: 'GAIN' },
      { ...PURCHASE, type: 'REFUND' },
      { ...PURCHASE, is_cancelled: true },
    ]) {
      mocks.findTransactions.mockResolvedValue([stored]);
      const { body, status } = unwrap(await post({ transaction: { id: 'tx-buy' } }));
      expect(status).toBe(400);
      expect(body.error).toBe('This transaction cannot be cancelled.');
    }
    expect(mocks.cancelPurchase).not.toHaveBeenCalled();
  });

  it('answers a refused cancel (already cancelled meanwhile) as before', async () => {
    mocks.cancelPurchase.mockRejectedValue(
      new Error('Only a purchase that is not already cancelled can be cancelled.')
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { body, status } = unwrap(await post({ transaction: { id: 'tx-buy' } }));
    expect(status).toBe(400);
    expect(body.error).toBe('This transaction cannot be cancelled.');
  });

  it('answers an unknown transaction with 404, before any gate', async () => {
    mocks.findTransactions.mockResolvedValue([]);
    const { status } = unwrap(await post({ transaction: { id: 'tx-none' } }));
    expect(status).toBe(404);
    expect(mocks.assertClassroomAccess).not.toHaveBeenCalled();
    expect(mocks.cancelPurchase).not.toHaveBeenCalled();
  });
});
