import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Who a classroom's Free-plan slot belongs to, and who takes it over.
 *
 * The rules pinned here: a stale or missing plan owner falls back to the oldest
 * ACCEPTED owner; a pending invitation never keeps a classroom owned; a leaving
 * plan owner hands on to a Pro co-owner first, then one with a free slot, then
 * the oldest (who is simply over the limit); and reads never write.
 */

const getProStateMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock('../subscription.service.ts', () => ({
  getProStateForClassroomId: (...a: unknown[]) => getProStateMock(...a),
  isSubscriptionActive: (sub: { ends_at: Date | null } | null) =>
    !!sub && (sub.ends_at === null || sub.ends_at.getTime() > Date.now()),
}));
vi.mock('../audit.service.ts', () => ({
  create: (...a: unknown[]) => auditCreateMock(...a),
}));
vi.mock('@classmoji/database', () => ({ default: () => db }));

// The rule is tested switched on (a limit of 1); the shipped constant is
// unlimited, which planLimits.test.ts pins.
vi.mock('../planLimits.ts', () => ({ PLAN_ACTIVE_CLASSROOM_LIMITS: { FREE: 1, PRO: null } }));

interface Membership {
  id: string;
  classroom_id: string;
  user_id: string;
  role: string;
  has_accepted_invite: boolean;
}
interface Classroom {
  id: string;
  plan_owner_id: string | null;
  status: string;
  is_example: boolean;
}

let memberships: Membership[] = [];
let classrooms: Classroom[] = [];
let subscriptions: Record<string, { tier: string; ends_at: Date | null }> = {};

/** Just enough of Prisma's `where` for the queries the service makes. */
const membershipMatches = (where: Record<string, unknown>) => (m: Membership) =>
  (where.classroom_id === undefined || m.classroom_id === where.classroom_id) &&
  (where.user_id === undefined || m.user_id === where.user_id) &&
  (where.role === undefined || m.role === where.role) &&
  (where.has_accepted_invite === undefined ||
    m.has_accepted_invite === where.has_accepted_invite) &&
  (where.id === undefined || m.id !== (where.id as { not: string }).not);

const ownsAccepted = (c: Classroom, some: Record<string, unknown> | undefined) =>
  !some || memberships.some(m => m.classroom_id === c.id && membershipMatches(some)(m));

const classroomMatches = (where: Record<string, unknown>) => (c: Classroom) =>
  (where.id === undefined ||
    (typeof where.id === 'string'
      ? c.id === where.id
      : c.id !== (where.id as { not: string }).not)) &&
  (!('plan_owner_id' in where) || c.plan_owner_id === where.plan_owner_id) &&
  (where.status === undefined || c.status === where.status) &&
  (where.is_example === undefined || c.is_example === where.is_example) &&
  ownsAccepted(c, (where.memberships as { some?: Record<string, unknown> } | undefined)?.some);

const db = {
  classroomMembership: {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      memberships.filter(membershipMatches(where)).map(m => ({ user_id: m.user_id }))
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const m = memberships.find(membershipMatches(where));
      return m ? { id: m.id, has_accepted_invite: m.has_accepted_invite } : null;
    }),
    count: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        memberships.filter(membershipMatches(where)).length
    ),
  },
  classroom: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const c = classrooms.find(row => row.id === where.id);
      return c ? { plan_owner_id: c.plan_owner_id } : null;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      classrooms.filter(classroomMatches(where)).map(c => ({ id: c.id }))
    ),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { plan_owner_id: string | null };
      }) => {
        const c = classrooms.find(row => row.id === where.id)!;
        c.plan_owner_id = data.plan_owner_id;
        return c;
      }
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: { plan_owner_id: string };
      }) => {
        const hits = classrooms.filter(classroomMatches(where));
        for (const c of hits) c.plan_owner_id = data.plan_owner_id;
        return { count: hits.length };
      }
    ),
  },
  subscription: {
    findFirst: vi.fn(async ({ where }: { where: { user_id: string } }) => {
      const sub = subscriptions[where.user_id];
      return sub ? { ...sub, user_id: where.user_id } : null;
    }),
  },
};

const planOwner = await import('../planOwner.service.ts');
type Db = Parameters<typeof planOwner.pickSuccessor>[0];
const tx = db as unknown as Db;

let seq = 0;
const owner = (classroomId: string, userId: string, accepted = true): Membership => ({
  id: `m-${++seq}`,
  classroom_id: classroomId,
  user_id: userId,
  role: 'OWNER',
  has_accepted_invite: accepted,
});
const room = (id: string, planOwnerId: string | null, status = 'ACTIVE'): Classroom => ({
  id,
  plan_owner_id: planOwnerId,
  status,
  is_example: false,
});
const PRO = { tier: 'PRO', ends_at: null };

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  memberships = [];
  classrooms = [];
  subscriptions = {};
  getProStateMock.mockResolvedValue({ isPro: false });
});

describe('effectivePlanOwnerId', () => {
  it('is the stored plan owner while they are an accepted owner', async () => {
    classrooms = [room('c1', 'bob')];
    memberships = [owner('c1', 'alice'), owner('c1', 'bob')];

    await expect(planOwner.effectivePlanOwnerId('c1', tx)).resolves.toBe('bob');
  });

  it('falls back to the oldest accepted owner when the stored one is gone, without writing', async () => {
    classrooms = [room('c1', 'deleted-user')];
    memberships = [owner('c1', 'pending', false), owner('c1', 'alice'), owner('c1', 'bob')];

    await expect(planOwner.effectivePlanOwnerId('c1', tx)).resolves.toBe('alice');
    expect(db.classroom.update).not.toHaveBeenCalled();
    expect(db.classroom.updateMany).not.toHaveBeenCalled();
  });

  it('is nobody when only pending owners remain', async () => {
    classrooms = [room('c1', null)];
    memberships = [owner('c1', 'pending', false)];

    await expect(planOwner.effectivePlanOwnerId('c1', tx)).resolves.toBeNull();
  });
});

describe('assertOwnerRemains', () => {
  it('refuses removing the only ACCEPTED owner, even with a pending owner invited', async () => {
    memberships = [owner('c1', 'alice'), owner('c1', 'pending', false)];

    await expect(planOwner.assertOwnerRemains(tx, 'c1', 'alice')).rejects.toThrow(
      planOwner.LAST_OWNER_ERROR
    );
  });

  it('allows it when another accepted owner remains', async () => {
    memberships = [owner('c1', 'alice'), owner('c1', 'bob')];

    await expect(planOwner.assertOwnerRemains(tx, 'c1', 'alice')).resolves.toBeUndefined();
  });

  it('allows withdrawing a pending owner invitation', async () => {
    memberships = [owner('c1', 'alice'), owner('c1', 'pending', false)];

    await expect(planOwner.assertOwnerRemains(tx, 'c1', 'pending')).resolves.toBeUndefined();
  });

  it('does not look at other classrooms', async () => {
    memberships = [owner('c1', 'alice'), owner('c2', 'bob')];

    await expect(planOwner.assertOwnerRemains(tx, 'c1', 'alice')).rejects.toThrow();
  });
});

describe('pickSuccessor', () => {
  it('prefers a co-owner with an active Pro', async () => {
    classrooms = [room('c1', 'alice')];
    memberships = [owner('c1', 'alice'), owner('c1', 'bob'), owner('c1', 'carol')];
    subscriptions = { carol: PRO };

    await expect(planOwner.pickSuccessor(tx, 'c1', 'alice')).resolves.toBe('carol');
  });

  it('then the oldest co-owner with a free slot', async () => {
    // Bob already plan-owns another active Free classroom; Carol does not.
    classrooms = [room('c1', 'alice'), room('c2', 'bob')];
    memberships = [
      owner('c1', 'alice'),
      owner('c1', 'bob'),
      owner('c1', 'carol'),
      owner('c2', 'bob'),
    ];

    await expect(planOwner.pickSuccessor(tx, 'c1', 'alice')).resolves.toBe('carol');
  });

  it('then the oldest, who is simply over the limit', async () => {
    classrooms = [room('c1', 'alice'), room('c2', 'bob')];
    memberships = [owner('c1', 'alice'), owner('c1', 'bob'), owner('c2', 'bob')];

    await expect(planOwner.pickSuccessor(tx, 'c1', 'alice')).resolves.toBe('bob');
  });

  it('never picks a pending owner', async () => {
    classrooms = [room('c1', 'alice')];
    memberships = [owner('c1', 'alice'), owner('c1', 'pending', false)];
    subscriptions = { pending: PRO };

    await expect(planOwner.pickSuccessor(tx, 'c1', 'alice')).resolves.toBeNull();
  });
});

describe('countActiveFreeClassrooms', () => {
  it('counts only active, non-example, non-Pro classrooms they plan-own and still own', async () => {
    classrooms = [
      room('active', 'bob'),
      room('locked', 'bob', 'LOCKED'),
      room('unpublished', 'bob', 'UNPUBLISHED'),
      { ...room('example', 'bob'), is_example: true },
      room('pro-by-co-owner', 'bob'),
      room('left-it', 'bob'),
      room('someone-elses', 'alice'),
    ];
    memberships = ['active', 'locked', 'unpublished', 'example', 'pro-by-co-owner', 'someone-elses']
      .map(id => owner(id, 'bob'))
      .concat(owner('someone-elses', 'alice'));
    getProStateMock.mockImplementation(async (id: string) => ({ isPro: id === 'pro-by-co-owner' }));

    await expect(planOwner.countActiveFreeClassrooms('bob', { db: tx })).resolves.toBe(1);
  });
});

describe('handOffPlanOwnership', () => {
  it('moves the classroom to the successor when the plan owner leaves', async () => {
    classrooms = [room('c1', 'alice')];
    memberships = [owner('c1', 'alice'), owner('c1', 'bob')];

    await expect(planOwner.handOffPlanOwnership(tx, 'c1', 'alice')).resolves.toEqual({
      classroomId: 'c1',
      from: 'alice',
      to: 'bob',
    });
    expect(classrooms[0].plan_owner_id).toBe('bob');
  });

  it('changes nothing when a co-owner who is not the plan owner leaves', async () => {
    classrooms = [room('c1', 'alice')];
    memberships = [owner('c1', 'alice'), owner('c1', 'bob')];

    await expect(planOwner.handOffPlanOwnership(tx, 'c1', 'bob')).resolves.toBeNull();
    expect(db.classroom.update).not.toHaveBeenCalled();
  });
});

describe('claimVacantPlanOwnership', () => {
  it('fills only classrooms of theirs with no plan owner', async () => {
    classrooms = [room('vacant', null), room('taken', 'alice'), room('not-theirs', null)];
    memberships = [owner('vacant', 'bob'), owner('taken', 'bob'), owner('not-theirs', 'carol')];

    await expect(planOwner.claimVacantPlanOwnership('bob', tx)).resolves.toEqual([
      { classroomId: 'vacant', from: null, to: 'bob' },
    ]);
    expect(classrooms.map(c => c.plan_owner_id)).toEqual(['bob', 'alice', null]);
  });
});

describe('auditPlanOwnerChange', () => {
  const change = { classroomId: 'c1', from: 'alice', to: 'bob' };

  it('writes an audit row as the actor, every time', async () => {
    await planOwner.auditPlanOwnerChange(change, { actorUserId: 'alice', reason: 'owner_left' });

    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'alice',
        classroom_id: 'c1',
        action: 'UPDATE',
        resource_type: 'CLASSROOM',
        data: { tool: 'plan_owner.change', reason: 'owner_left', from: 'alice', to: 'bob' },
      }),
      { dedupe: false }
    );
  });

  it('writes no row without an actor', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await planOwner.auditPlanOwnerChange(change, { reason: 'owner_left' });

    expect(auditCreateMock).not.toHaveBeenCalled();
    info.mockRestore();
  });
});
