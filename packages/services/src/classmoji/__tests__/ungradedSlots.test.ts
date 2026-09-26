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
vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepoAssignmentGrader: {
      findMany: (...a: unknown[]) => graderFindMany(...a),
      count: (...a: unknown[]) => graderCount(...a),
      groupBy: (...a: unknown[]) => graderGroupBy(...a),
    },
    user: { findFirst: (...a: unknown[]) => userFindFirst(...a) },
  }),
}));

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
  beforeEach(() => {
    userFindFirst.mockResolvedValue({ id: 'u-gone', login: 'Gone', name: 'Gone Person' });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1' });
    graderCount.mockResolvedValue(9);
  });

  it('counts ungraded slots when no ASSISTANT/TEACHER role is left', async () => {
    hasRole.mockResolvedValue(false);
    const preview = await staff.previewRemoval({
      classroomId: 'class-1',
      login: 'gone',
      role: 'ASSISTANT',
    });
    expect(hasRole).toHaveBeenCalledWith('class-1', 'u-gone', ['TEACHER']);
    expect(preview).toMatchObject({
      userId: 'u-gone',
      login: 'Gone',
      remainsGrader: false,
      ungradedCount: 9,
    });
  });

  it('asks nothing when another grader role remains', async () => {
    hasRole.mockResolvedValue(true);
    const preview = await staff.previewRemoval({
      classroomId: 'class-1',
      login: 'gone',
      role: 'TEACHER',
    });
    expect(hasRole).toHaveBeenCalledWith('class-1', 'u-gone', ['ASSISTANT']);
    expect(preview).toMatchObject({ remainsGrader: true, ungradedCount: 0 });
    expect(graderCount).not.toHaveBeenCalled();
  });

  it('removing OWNER checks both grader roles — an owner-only person still gets counted', async () => {
    hasRole.mockResolvedValue(false);
    const preview = await staff.previewRemoval({
      classroomId: 'class-1',
      login: 'gone',
      role: 'OWNER',
    });
    expect(hasRole).toHaveBeenCalledWith('class-1', 'u-gone', ['ASSISTANT', 'TEACHER']);
    expect(preview.ungradedCount).toBe(9);
  });

  it('refuses someone who does not hold the role here', async () => {
    findByClassroomAndUser.mockResolvedValue(null);
    await expect(
      staff.previewRemoval({ classroomId: 'class-1', login: 'gone', role: 'ASSISTANT' })
    ).rejects.toMatchObject({ code: 'staff_not_found' });
  });
});
