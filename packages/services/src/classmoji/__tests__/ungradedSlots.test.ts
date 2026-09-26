/**
 * The departing-grader queries on gitRepoAssignmentGrader.service and
 * staff.previewRemoval.
 *
 *   - "Ungraded" is a submission with NO grade at all (any grader), and every
 *     query is scoped to the classroom through git_repo.classroom_id — another
 *     classroom's rows never count. (The live DB check exercises the same
 *     where-clauses against Postgres; here they are pinned.)
 *   - The reassignment pool is ASSISTANT/TEACHER with is_grader, minus the
 *     departing grader and anyone without a login.
 *   - previewRemoval only counts when no ASSISTANT/TEACHER role is left, so a
 *     person who stays OWNER but stops being a TA is still offered the choice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const graderFindMany = vi.fn();
const graderCount = vi.fn();
const graderGroupBy = vi.fn();
const userFindFirst = vi.fn();

/** Memberships in the fake classroom, queried by classroomMembership.count. */
interface Row {
  classroom_id: string;
  user_id: string;
  role: string;
  is_grader: boolean;
}
let memberships: Row[] = [];
const membershipCount = ({ where }: { where: Record<string, unknown> }) =>
  Promise.resolve(
    memberships.filter(row => {
      if (where.classroom_id !== undefined && row.classroom_id !== where.classroom_id) return false;
      if (where.user_id !== undefined && row.user_id !== where.user_id) return false;
      if (where.is_grader !== undefined && row.is_grader !== where.is_grader) return false;
      const role = where.role as string | { in: string[] } | undefined;
      if (typeof role === 'string' && row.role !== role) return false;
      if (role && typeof role === 'object' && !role.in.includes(row.role)) return false;
      return true;
    }).length
  );

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepoAssignmentGrader: {
      findMany: (...a: unknown[]) => graderFindMany(...a),
      count: (...a: unknown[]) => graderCount(...a),
      groupBy: (...a: unknown[]) => graderGroupBy(...a),
    },
    user: { findFirst: (...a: unknown[]) => userFindFirst(...a) },
    classroomMembership: {
      count: (args: { where: Record<string, unknown> }) => membershipCount(args),
    },
    auditLog: { findFirst: (...a: unknown[]) => auditFindFirst(...a) },
  }),
}));

const auditFindFirst = vi.fn();

vi.mock('../classroom.service.ts', () => ({ findById: vi.fn() }));

const findUsersByRoles = vi.fn();
const findByClassroomAndUser = vi.fn();
const hasRole = vi.fn();
vi.mock('../classroomMembership.service.ts', () => ({
  findUsersByRoles: (...a: unknown[]) => findUsersByRoles(...a),
  findByClassroomAndUser: (...a: unknown[]) => findByClassroomAndUser(...a),
  hasRole: (...a: unknown[]) => hasRole(...a),
}));

vi.mock('../gitRepoAssignment.service.ts', () => ({ findByAssignmentId: vi.fn() }));
vi.mock('../notification.service.ts', () => ({ runSafely: vi.fn(), createNotifications: vi.fn() }));
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: vi.fn(), batchTrigger: vi.fn() } }));
vi.mock('../../git/index.ts', () => ({ getGitProvider: vi.fn(), ensureClassroomTeam: vi.fn() }));

const graders = await import('../gitRepoAssignmentGrader.service.ts');
const staff = await import('../staff.service.ts');

const UNGRADED_IN_CLASS_1 = {
  grader_id: 'u-gone',
  git_repo_assignment: { git_repo: { classroom_id: 'class-1' }, grades: { none: {} } },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findUngradedSlotsForGrader / countUngradedSlotsForGrader', () => {
  it('asks for this grader, in this classroom, on submissions with no grade', async () => {
    graderFindMany.mockResolvedValue([]);
    await graders.findUngradedSlotsForGrader('class-1', 'u-gone');
    expect(graderFindMany.mock.calls[0][0].where).toEqual(UNGRADED_IN_CLASS_1);

    graderCount.mockResolvedValue(3);
    expect(await graders.countUngradedSlotsForGrader('class-1', 'u-gone')).toBe(3);
    expect(graderCount.mock.calls[0][0].where).toEqual(UNGRADED_IN_CLASS_1);
  });

  it('refuses empty ids without querying', async () => {
    expect(await graders.findUngradedSlotsForGrader('', 'u-gone')).toEqual([]);
    expect(await graders.countUngradedSlotsForGrader('class-1', '')).toBe(0);
    expect(graderFindMany).not.toHaveBeenCalled();
    expect(graderCount).not.toHaveBeenCalled();
  });
});

describe('countUngradedSlotsByGrader', () => {
  it('groups ungraded rows of this classroom by grader', async () => {
    graderGroupBy.mockResolvedValue([
      { grader_id: 'u-ann', _count: { _all: 4 } },
      { grader_id: 'u-bob', _count: { _all: 1 } },
    ]);
    expect(await graders.countUngradedSlotsByGrader('class-1')).toEqual({ 'u-ann': 4, 'u-bob': 1 });
    expect(graderGroupBy.mock.calls[0][0].where).toEqual({
      git_repo_assignment: { git_repo: { classroom_id: 'class-1' }, grades: { none: {} } },
    });
  });
});

describe('planUngradedReassignment', () => {
  it('draws from the grader pool minus the departing grader and login-less users', async () => {
    findUsersByRoles.mockResolvedValue([
      { id: 'u-gone', login: 'gone' },
      { id: 'u-ann', login: 'ann' },
      { id: 'u-nologin', login: null },
      { id: 'u-bob', login: 'bob' },
    ]);
    graderFindMany.mockResolvedValue([
      { grader_id: 'u-ann', git_repo_assignment: { assignment_id: 'a1', git_repo_id: 'r9' } },
    ]);

    const plan = await graders.planUngradedReassignment({
      classroomId: 'class-1',
      fromGraderId: 'u-gone',
      slots: [
        {
          git_repo_assignment_id: 's1',
          grader_id: 'u-gone',
          git_repo_assignment: {
            id: 's1',
            assignment_id: 'a1',
            git_repo_id: 'r1',
            graders: [{ grader_id: 'u-gone' }],
          },
        },
      ],
    });

    expect(findUsersByRoles).toHaveBeenCalledWith('class-1', ['ASSISTANT', 'TEACHER'], {
      is_grader: true,
    });
    // Loads are read for the candidates only, in this classroom only.
    expect(graderFindMany.mock.calls[0][0].where).toEqual({
      grader_id: { in: ['u-ann', 'u-bob'] },
      git_repo_assignment: { git_repo: { classroom_id: 'class-1' } },
    });
    // ann already has one on a1, so bob takes it.
    expect(plan.moves).toEqual([
      { gitRepoAssignmentId: 's1', toGraderId: 'u-bob', toLogin: 'bob', reason: 'reassign' },
    ]);
  });

  it('falls back when nobody else is in the pool', async () => {
    findUsersByRoles.mockResolvedValue([{ id: 'u-gone', login: 'gone' }]);
    const plan = await graders.planUngradedReassignment({
      classroomId: 'class-1',
      fromGraderId: 'u-gone',
      slots: [],
    });
    expect(plan.fallback).toBe('no_eligible_graders');
    expect(graderFindMany).not.toHaveBeenCalled();
  });
});

describe('staff.previewRemoval', () => {
  const row = (role: string, is_grader = true, user_id = 'u-gone'): Row => ({
    classroom_id: 'class-1',
    user_id,
    role,
    is_grader,
  });
  /** What the removal run does when it finishes: delete that one row. */
  const completeRemoval = (role: string) => {
    memberships = memberships.filter(r => !(r.user_id === 'u-gone' && r.role === role));
  };
  const preview = (role: 'ASSISTANT' | 'TEACHER' | 'OWNER') =>
    staff.previewRemoval({ classroomId: 'class-1', login: 'gone', role });

  beforeEach(() => {
    memberships = [row('OWNER', false, 'u-owner')];
    userFindFirst.mockResolvedValue({ id: 'u-gone', login: 'Gone', name: 'Gone Person' });
    findByClassroomAndUser.mockImplementation((c: string, u: string, role: string) =>
      Promise.resolve(
        memberships.find(r => r.classroom_id === c && r.user_id === u && r.role === role) ?? null
      )
    );
    graderCount.mockResolvedValue(9);
  });

  it('counts ungraded slots when no ASSISTANT/TEACHER role is left', async () => {
    memberships.push(row('ASSISTANT'));
    expect(await preview('ASSISTANT')).toMatchObject({
      userId: 'u-gone',
      login: 'Gone',
      name: 'Gone Person',
      remainsGrader: false,
      ungradedCount: 9,
      heldUngradedCount: 9,
    });
  });

  it('asks nothing when a grader-flagged role remains — but reports what they hold', async () => {
    memberships.push(row('TEACHER'), row('ASSISTANT'));
    expect(await preview('TEACHER')).toMatchObject({
      remainsGrader: true,
      ungradedCount: 0,
      heldUngradedCount: 9,
    });
  });

  it('a remaining role WITHOUT is_grader does not count as still grading', async () => {
    memberships.push(row('TEACHER'), row('ASSISTANT', false));
    expect(await preview('TEACHER')).toMatchObject({ remainsGrader: false, ungradedCount: 9 });
  });

  it('staying OWNER is not staying a grader', async () => {
    memberships.push(row('OWNER', false), row('ASSISTANT'));
    expect(await preview('ASSISTANT')).toMatchObject({ remainsGrader: false, ungradedCount: 9 });
  });

  it('refuses the last owner before anything about slots is asked', async () => {
    memberships = [row('OWNER', false)];
    await expect(preview('OWNER')).rejects.toMatchObject({ code: 'last_owner' });
    expect(graderCount).not.toHaveBeenCalled();
  });

  it('refuses someone who does not hold the role here', async () => {
    await expect(preview('ASSISTANT')).rejects.toMatchObject({ code: 'staff_not_found' });
  });

  it('TEACHER then ASSISTANT: once the first removal has finished, the second is asked', async () => {
    memberships.push(row('TEACHER'), row('ASSISTANT'));

    // First call: the ASSISTANT row keeps them grading, so nothing is at stake
    // — but they hold slots, which is what makes the callers wait for the run.
    const first = await preview('TEACHER');
    expect(first).toMatchObject({ ungradedCount: 0, heldUngradedCount: 9 });

    // Had the caller not waited, the TEACHER row would still be there and the
    // second removal would wrongly look like it leaves them a grader.
    expect(await preview('ASSISTANT')).toMatchObject({ remainsGrader: true, ungradedCount: 0 });

    // The caller waited: the run finished and deleted the TEACHER row.
    completeRemoval('TEACHER');
    expect(await preview('ASSISTANT')).toMatchObject({ remainsGrader: false, ungradedCount: 9 });
  });
});

describe('staff.countStrandedSlots', () => {
  beforeEach(() => {
    memberships = [];
    graderCount.mockResolvedValue(4);
  });

  it('0 while a grader-flagged ASSISTANT/TEACHER role remains', async () => {
    memberships = [
      { classroom_id: 'class-1', user_id: 'u-gone', role: 'TEACHER', is_grader: true },
    ];
    expect(await staff.countStrandedSlots('class-1', 'u-gone')).toBe(0);
  });

  it('every ungraded slot once none does', async () => {
    memberships = [
      { classroom_id: 'class-1', user_id: 'u-gone', role: 'ASSISTANT', is_grader: false },
    ];
    expect(await staff.countStrandedSlots('class-1', 'u-gone')).toBe(4);
  });
});

describe('staff.previewLeftoverSlots', () => {
  const leftover = () =>
    staff.previewLeftoverSlots({ classroomId: 'class-1', login: 'gone', role: 'ASSISTANT' });

  beforeEach(() => {
    memberships = [];
    userFindFirst.mockResolvedValue({ id: 'u-gone', login: 'Gone', name: 'Gone Person' });
    findByClassroomAndUser.mockImplementation((c: string, u: string, role: string) =>
      Promise.resolve(
        memberships.find(r => r.classroom_id === c && r.user_id === u && r.role === role) ?? null
      )
    );
    auditFindFirst.mockResolvedValue({ id: 'audit-1' });
    graderCount.mockResolvedValue(4);
  });

  it('settles only for an open removal of that role: role gone, marker row, slots left', async () => {
    expect(await leftover()).toEqual({
      userId: 'u-gone',
      login: 'Gone',
      name: 'Gone Person',
      ungradedCount: 4,
    });

    const where = auditFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      classroom_id: 'class-1',
      resource_type: 'STAFF',
      resource_id: 'u-gone',
      action: 'DELETE',
    });
    // Within the last 24h.
    const since = (where.timestamp.gte as Date).getTime();
    expect(Date.now() - since).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(Date.now() - since).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    // This tool, this role, and one of the follow-up markers.
    expect(where.AND).toEqual([
      { data: { path: ['tool'], equals: 'staff_remove' } },
      { data: { path: ['role'], equals: 'ASSISTANT' } },
      {
        OR: [
          { data: { path: ['removal'], equals: 'pending' } },
          { data: { path: ['needs_decision'], equals: true } },
          { data: { path: ['settle_deferred'], equals: true } },
        ],
      },
    ]);
  });

  it('not-found while the person still holds the role', async () => {
    memberships = [
      { classroom_id: 'class-1', user_id: 'u-gone', role: 'ASSISTANT', is_grader: false },
    ];
    await expect(leftover()).rejects.toMatchObject({ code: 'staff_not_found' });
    expect(auditFindFirst).not.toHaveBeenCalled();
  });

  it('not-found without an open removal row for that role', async () => {
    auditFindFirst.mockResolvedValue(null);
    await expect(leftover()).rejects.toMatchObject({ code: 'staff_not_found' });
  });

  it('not-found for someone still grading through another role, or with nothing left', async () => {
    memberships = [
      { classroom_id: 'class-1', user_id: 'u-gone', role: 'TEACHER', is_grader: true },
    ];
    await expect(leftover()).rejects.toMatchObject({ code: 'staff_not_found' });

    memberships = [];
    graderCount.mockResolvedValue(0);
    await expect(leftover()).rejects.toMatchObject({ code: 'staff_not_found' });
  });
});
