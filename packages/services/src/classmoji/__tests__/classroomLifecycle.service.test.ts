import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Free plan's one-active-class rule at every lifecycle change.
 *
 * Pinned here: only a change TO ACTIVE is gated (ACTIVE to ACTIVE never is); a
 * Pro classroom never counts; a refusal writes nothing and names the plan
 * owner's classes only to the plan owner; the row lock comes before the
 * plan-owner lock, which comes before the count; and the archive-and-continue
 * swap archives first, then activates, in one transaction.
 */

const mocks = vi.hoisted(() => ({
  effectivePlanOwnerId: vi.fn(),
  listActiveFreeClassrooms: vi.fn(),
  userIsPro: vi.fn(),
  auditPlanOwnerChange: vi.fn(),
  getProState: vi.fn(),
  auditCreate: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  classroomUpdate: vi.fn(),
  membershipFindFirst: vi.fn(),
}));

vi.mock('../planOwner.service.ts', () => ({
  effectivePlanOwnerId: (...a: unknown[]) => mocks.effectivePlanOwnerId(...a),
  listActiveFreeClassrooms: (...a: unknown[]) => mocks.listActiveFreeClassrooms(...a),
  userIsPro: (...a: unknown[]) => mocks.userIsPro(...a),
  auditPlanOwnerChange: (...a: unknown[]) => mocks.auditPlanOwnerChange(...a),
}));
vi.mock('../subscription.service.ts', () => ({
  getProStateForClassroomId: (...a: unknown[]) => mocks.getProState(...a),
}));
vi.mock('../audit.service.ts', () => ({
  create: (...a: unknown[]) => mocks.auditCreate(...a),
}));

const tx = {
  $queryRaw: (...a: unknown[]) => mocks.queryRaw(...a),
  $executeRaw: (...a: unknown[]) => mocks.executeRaw(...a),
  classroom: { update: (...a: unknown[]) => mocks.classroomUpdate(...a) },
  classroomMembership: { findFirst: (...a: unknown[]) => mocks.membershipFindFirst(...a) },
};
vi.mock('@classmoji/database', () => ({
  default: () => ({ ...tx, $transaction: (fn: (t: unknown) => unknown) => fn(tx) }),
}));

const lifecycle = await import('../classroomLifecycle.service.ts');

type Row = { id: string; status: string; is_archived: boolean; plan_owner_id: string | null };
const rows = (...list: Row[]) => mocks.queryRaw.mockResolvedValue(list);
const row = (id: string, status: string, planOwner: string | null = 'alice'): Row => ({
  id,
  status,
  is_archived: status === 'LOCKED',
  plan_owner_id: planOwner,
});
const CS10 = { id: 'cs10', name: 'CS 10', slug: 'cs-10' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effectivePlanOwnerId.mockResolvedValue('alice');
  mocks.listActiveFreeClassrooms.mockResolvedValue([]);
  mocks.userIsPro.mockResolvedValue(false);
  mocks.getProState.mockResolvedValue({ isPro: false });
  mocks.classroomUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    status: data.status,
    is_archived: data.is_archived,
  }));
  mocks.membershipFindFirst.mockResolvedValue({ id: 'm-owner' });
});

const activate = (actorUserId = 'alice') =>
  lifecycle.setLifecycle({
    classroomId: 'cs52',
    status: 'ACTIVE',
    isArchived: false,
    actorUserId,
    tool: 'web:classroom.status',
  });

describe('setLifecycle', () => {
  it('reactivates when the plan owner has a free slot, and audits it as the actor', async () => {
    rows(row('cs52', 'LOCKED'));

    await expect(activate()).resolves.toEqual({ status: 'ACTIVE', is_archived: false });

    expect(mocks.listActiveFreeClassrooms).toHaveBeenCalledWith('alice', {
      excludeClassroomId: 'cs52',
      db: tx,
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'alice',
        classroom_id: 'cs52',
        resource_type: 'CLASSROOM',
        action: 'UPDATE',
        data: {
          tool: 'web:classroom.status',
          from: { status: 'LOCKED', is_archived: true },
          to: { status: 'ACTIVE', is_archived: false },
        },
      }),
      { dedupe: false }
    );
  });

  it('refuses a reactivation past the limit, names the classes to the plan owner, writes nothing', async () => {
    rows(row('cs52', 'LOCKED'));
    mocks.listActiveFreeClassrooms.mockResolvedValue([CS10]);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});

    const error = await activate().catch(e => e);

    expect(lifecycle.isActiveClassroomLimitError(error)).toBe(true);
    expect(error.activeClassrooms).toEqual([CS10]);
    expect(mocks.classroomUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('plan_limit.active_course_refused'));
    log.mockRestore();
  });

  it("never shows a co-owner the plan owner's classes", async () => {
    rows(row('cs52', 'LOCKED'));
    mocks.listActiveFreeClassrooms.mockResolvedValue([CS10]);
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const error = await activate('bob').catch(e => e);

    expect(error.activeClassrooms).toBeNull();
    expect(error.message).toContain('plan owner');
    expect(error.message).not.toContain('CS 10');
  });

  it('lets ACTIVE stay ACTIVE without counting', async () => {
    rows(row('cs52', 'ACTIVE'));

    await activate();

    expect(mocks.listActiveFreeClassrooms).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it('never gates a classroom that is Pro through any owner', async () => {
    rows(row('cs52', 'LOCKED'));
    mocks.getProState.mockResolvedValue({ isPro: true });
    mocks.listActiveFreeClassrooms.mockResolvedValue([CS10]);

    await expect(activate()).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(mocks.listActiveFreeClassrooms).not.toHaveBeenCalled();
  });

  it('does not gate archiving or locking', async () => {
    rows(row('cs52', 'ACTIVE'));
    mocks.listActiveFreeClassrooms.mockResolvedValue([CS10, CS10]);

    await lifecycle.archive({ classroomId: 'cs52', actorUserId: 'alice', tool: 't' });

    expect(mocks.classroomUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'LOCKED', is_archived: true } })
    );
    expect(mocks.listActiveFreeClassrooms).not.toHaveBeenCalled();
  });

  it('refuses to activate a class with no accepted owner', async () => {
    rows(row('cs52', 'LOCKED', null));
    mocks.effectivePlanOwnerId.mockResolvedValue(null);

    await expect(activate()).rejects.toMatchObject({ code: lifecycle.NO_PLAN_OWNER });
  });

  it('repairs a stale plan owner on the way, and audits the repair', async () => {
    rows(row('cs52', 'LOCKED', 'deleted-user'));

    await activate();

    expect(mocks.classroomUpdate).toHaveBeenCalledWith({
      where: { id: 'cs52' },
      data: { plan_owner_id: 'alice' },
    });
    expect(mocks.auditPlanOwnerChange).toHaveBeenCalledWith(
      { classroomId: 'cs52', from: 'deleted-user', to: 'alice' },
      expect.objectContaining({ actorUserId: 'alice' })
    );
  });

  it('locks the row, then the plan owner, then counts', async () => {
    rows(row('cs52', 'LOCKED'));

    await activate();

    const [lockSql] = mocks.queryRaw.mock.calls[0] as [string[]];
    expect(lockSql.join('?')).toContain('FOR UPDATE');
    const [advisorySql, key] = mocks.executeRaw.mock.calls[0] as [string[], string];
    expect(advisorySql.join('?')).toContain('pg_advisory_xact_lock');
    expect(key).toBe('plan-owner:alice');
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.executeRaw.mock.invocationCallOrder[0]
    );
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.listActiveFreeClassrooms.mock.invocationCallOrder[0]
    );
  });
});

describe('swapActive', () => {
  const swap = () =>
    lifecycle.swapActive({
      activateClassroomId: 'new',
      archiveClassroomId: 'old',
      actorUserId: 'alice',
      tool: 'web:classroom.create_archive_and_continue',
    });

  it('archives the old class before counting for the new one', async () => {
    rows(row('new', 'LOCKED'), row('old', 'ACTIVE'));

    await swap();

    const updates = mocks.classroomUpdate.mock.calls.map(([args]) => args);
    expect(updates[0]).toEqual({
      where: { id: 'old' },
      data: { status: 'LOCKED', is_archived: true },
    });
    expect(updates.at(-1)).toEqual({
      where: { id: 'new' },
      data: { status: 'ACTIVE', is_archived: false },
    });
    expect(mocks.classroomUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.listActiveFreeClassrooms.mock.invocationCallOrder[0]
    );
  });

  it('locks both rows in one statement, in id order', async () => {
    rows(row('new', 'LOCKED'), row('old', 'ACTIVE'));

    await swap();

    const [, ids] = mocks.queryRaw.mock.calls[0] as [string[], string[]];
    expect(ids).toEqual(['new', 'old']);
  });

  it('refuses to archive a class the actor does not own', async () => {
    rows(row('new', 'LOCKED'), row('old', 'ACTIVE'));
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(swap()).rejects.toThrow('You can only archive a class you own.');
    expect(mocks.classroomUpdate).not.toHaveBeenCalled();
  });

  it('does not activate when the slot is still taken', async () => {
    rows(row('new', 'LOCKED'), row('old', 'ACTIVE'));
    mocks.listActiveFreeClassrooms.mockResolvedValue([CS10]);
    vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(swap()).rejects.toMatchObject({ code: lifecycle.ACTIVE_CLASSROOM_LIMIT });
    expect(mocks.classroomUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'new' } })
    );
  });
});

describe('creating a classroom', () => {
  it("takes the creator's plan-owner lock and refuses past the limit", async () => {
    mocks.listActiveFreeClassrooms.mockResolvedValue([CS10]);
    vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(lifecycle.assertCanCreateActive(tx as never, 'alice')).rejects.toMatchObject({
      code: lifecycle.ACTIVE_CLASSROOM_LIMIT,
      activeClassrooms: [CS10],
    });
    expect(mocks.executeRaw.mock.calls[0][1]).toBe('plan-owner:alice');
  });

  it('never refuses a Pro creator', async () => {
    mocks.userIsPro.mockResolvedValue(true);
    mocks.listActiveFreeClassrooms.mockResolvedValue([CS10, CS10]);

    await expect(lifecycle.assertCanCreateActive(tx as never, 'alice')).resolves.toBeUndefined();
  });

  it('answers the import with a boolean instead of throwing', async () => {
    mocks.listActiveFreeClassrooms.mockResolvedValue([CS10]);
    vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(lifecycle.canCreateActive(tx as never, 'alice')).resolves.toBe(false);
  });
});

describe('allowanceFor', () => {
  it('is unlimited for a Pro user', async () => {
    mocks.userIsPro.mockResolvedValue(true);
    await expect(lifecycle.allowanceFor('alice')).resolves.toEqual({
      limit: null,
      active: [],
      canCreate: true,
    });
  });

  it('lists the classes holding a Free user’s slot', async () => {
    mocks.listActiveFreeClassrooms.mockResolvedValue([CS10]);
    await expect(lifecycle.allowanceFor('alice')).resolves.toEqual({
      limit: 1,
      active: [CS10],
      canCreate: false,
    });
  });
});
