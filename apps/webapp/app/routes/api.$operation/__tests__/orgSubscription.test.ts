/**
 * `/api/get-org-subscription`: the classroom tier the webapp store holds, which
 * `useSubscription` turns into the Pro-only nav items (Quizzes, Forms). It must
 * give the same answer as the Pro gates on the routes those items link to, so
 * it runs the real `getProStateForClassroomId` here, against a fake of the one
 * query it makes: an active PRO from any ACCEPTED owner is PRO, anything else
 * is FREE.
 *
 * The OWNER-only gate (the RW-04 IDOR fix) is pinned too: this change reads
 * the tier differently, not for more people.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  role: 'OWNER' | 'TEACHER' | 'STUDENT';
  has_accepted_invite: boolean;
  created_at: Date;
  subscription: { id: string; tier: 'FREE' | 'PRO'; ends_at: Date | null } | null;
};

const CLASSROOM_ID = 'classroom-1';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  memberships: [] as Row[],
}));

// A fake of the query getProStateForClassroomId makes: it applies the
// memberships `where` and `orderBy` it is sent, so an unaccepted invitation is
// left out the way the database would leave it out.
const classroomFindUnique = vi.fn(
  async ({
    where,
    select,
  }: {
    where: { id: string };
    select: { memberships: { where: Partial<Row>; orderBy: { created_at: 'asc' } } };
  }) => {
    if (where.id !== CLASSROOM_ID) return null;
    const filter = Object.entries(select.memberships.where) as [keyof Row, unknown][];
    const rows = mocks.memberships
      .filter(row => filter.every(([key, value]) => row[key] === value))
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    return {
      memberships: rows.map(row => ({
        user: { subscriptions: row.subscription ? [row.subscription] : [] },
      })),
    };
  }
);

vi.mock('@classmoji/database', () => ({
  default: () => ({ classroom: { findUnique: classroomFindUnique } }),
}));

vi.mock('@classmoji/services', async () => ({
  ClassmojiService: {
    subscription:
      await import('../../../../../../packages/services/src/classmoji/subscription.service.ts'),
  },
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: async () => ({ userId: 'owner-1' }),
}));
vi.mock('@trigger.dev/sdk', () => ({ tasks: {} }));
vi.mock('~/utils/helpers', () => ({
  checkAuth: (handler: unknown) => handler,
  waitForRunCompletion: vi.fn(),
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
}));

const { loader } = await import('../route');

const get = (query: string) =>
  (loader as unknown as (args: unknown) => Promise<unknown>)({
    params: { operation: 'get-org-subscription' },
    request: new Request(`http://localhost/api/get-org-subscription${query}`),
  });

const HOUR = 60 * 60 * 1000;
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60 * 1000);
const owner = (
  minutes: number,
  subscription: Row['subscription'],
  has_accepted_invite = true
): Row => ({ role: 'OWNER', has_accepted_invite, created_at: at(minutes), subscription });

const FREE = { tier: 'FREE', id: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships = [];
  mocks.assertClassroomAccess.mockResolvedValue({ classroom: { id: CLASSROOM_ID } });
});

describe('get-org-subscription', () => {
  it('returns FREE for a lapsed PRO owner', async () => {
    mocks.memberships = [
      owner(0, { id: 'sub-a', tier: 'PRO', ends_at: new Date(Date.now() - HOUR) }),
    ];
    expect(await get('?orgLogin=cs52')).toEqual(FREE);
  });

  it('returns PRO when a second accepted owner holds an active PRO', async () => {
    mocks.memberships = [
      owner(0, { id: 'sub-a', tier: 'FREE', ends_at: null }),
      owner(1, { id: 'sub-b', tier: 'PRO', ends_at: null }),
    ];
    expect(await get('?orgLogin=cs52')).toMatchObject({ id: 'sub-b', tier: 'PRO' });
  });

  it('returns FREE when the only PRO is an owner invitation not yet accepted', async () => {
    mocks.memberships = [
      owner(0, { id: 'sub-a', tier: 'FREE', ends_at: null }),
      owner(1, { id: 'sub-b', tier: 'PRO', ends_at: null }, false),
    ];
    expect(await get('?orgLogin=cs52')).toEqual(FREE);
  });

  it("ignores a non-owner's PRO", async () => {
    mocks.memberships = [
      owner(0, { id: 'sub-a', tier: 'FREE', ends_at: null }),
      {
        role: 'TEACHER',
        has_accepted_invite: true,
        created_at: at(1),
        subscription: { id: 'sub-t', tier: 'PRO', ends_at: null },
      },
    ];
    expect(await get('?orgLogin=cs52')).toEqual(FREE);
  });

  it('reads the classroom the access check resolved, by id', async () => {
    mocks.memberships = [owner(0, { id: 'sub-a', tier: 'PRO', ends_at: null })];
    await get('?orgLogin=cs52');

    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ classroomSlug: 'cs52', allowedRoles: ['OWNER'] })
    );
    expect(classroomFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CLASSROOM_ID } })
    );
  });

  it('reads nothing when the access check refuses', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));
    await expect(get('?orgLogin=cs52')).rejects.toMatchObject({ status: 403 });
    expect(classroomFindUnique).not.toHaveBeenCalled();
  });

  it('refuses a request without orgLogin', async () => {
    const result = (await get('')) as { data: { error: string }; init: { status: number } };
    expect(result.init.status).toBe(400);
    expect(mocks.assertClassroomAccess).not.toHaveBeenCalled();
  });
});
