/**
 * HelperService.moveGraderSlot / resolveUngradedSlots / startStaffRemoval /
 * settleUngradedSlots — what happens to a departing grader's ungraded
 * submissions.
 *
 * Pinned:
 *   - each move adds the new grader BEFORE removing the old one, through the
 *     classroom-scoped helpers (so the provider sees the stored repo, issue and
 *     logins, and the new grader is re-checked against the pool), and sends no
 *     per-submission notification;
 *   - "still ungraded" is checked before the add AND before the remove;
 *   - a planned grader who left the pool falls back to unassign on reassign;
 *   - keep changes nothing, unassign removes, reassign follows the plan and
 *     falls back to unassign with no other grader;
 *   - one failing slot does not stop the rest, and is counted;
 *   - above the inline limit the moves go out as one background run per slot,
 *     and a chunk that fails to queue fails only itself and what follows;
 *   - each receiving grader gets ONE summary notification;
 *   - startStaffRemoval refuses (requireChoice) before anything is queued and
 *     moves nothing itself; settleUngradedSlots never throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  addIssueAssignees: vi.fn(),
  removeIssueAssignees: vi.fn(),
  addGraderToAssignment: vi.fn(),
  removeGraderFromAssignment: vi.fn(),
  findSubmission: vi.fn(),
  findEligibleGrader: vi.fn(),
  findUngradedSlotsForGrader: vi.fn(),
  planUngradedReassignment: vi.fn(),
  gradesFor: vi.fn(),
  classroomFindById: vi.fn(),
  previewRemoval: vi.fn(),
  removeStaff: vi.fn(),
  batchTrigger: vi.fn(),
  createNotifications: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { batchTrigger: (...a: unknown[]) => mocks.batchTrigger(...a) },
}));

vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    addIssueAssignees: (...a: unknown[]) => {
      mocks.calls.push(`gh-add:${(a[3] as string[])[0]}:${a[2]}`);
      return mocks.addIssueAssignees(...a);
    },
    removeIssueAssignees: (...a: unknown[]) => {
      mocks.calls.push(`gh-remove:${(a[3] as string[])[0]}:${a[2]}`);
      return mocks.removeIssueAssignees(...a);
    },
  }),
}));

vi.mock('../../classmoji/staff.service.ts', () => {
  class StaffServiceError extends Error {
    code: string;
    ungradedCount?: number;
    constructor(code: string, message: string, details: { ungradedCount?: number } = {}) {
      super(message);
      this.code = code;
      this.ungradedCount = details.ungradedCount;
    }
  }
  return { StaffServiceError };
});

vi.mock('../../classmoji/index.ts', () => ({
  default: {
    classroom: { findById: (...a: unknown[]) => mocks.classroomFindById(...a) },
    notification: {
      runSafely: (_label: string, fn: () => Promise<unknown>) => fn(),
      createNotifications: (...a: unknown[]) => mocks.createNotifications(...a),
    },
    staff: {
      previewRemoval: (...a: unknown[]) => mocks.previewRemoval(...a),
      removeStaff: (...a: unknown[]) => {
        mocks.calls.push('removeStaff');
        return mocks.removeStaff(...a);
      },
    },
    assignmentGrade: { findByAssignmentId: (...a: unknown[]) => mocks.gradesFor(...a) },
    gitRepoAssignment: {
      findByIdInClassroom: (...a: unknown[]) => mocks.findSubmission(...a),
    },
    gitRepoAssignmentGrader: {
      addGraderToAssignment: (...a: unknown[]) => {
        mocks.calls.push(`db-add:${a[1]}:${a[0]}`);
        return mocks.addGraderToAssignment(...a);
      },
      removeGraderFromAssignment: (...a: unknown[]) => {
        mocks.calls.push(`db-remove:${a[1]}:${a[0]}`);
        return mocks.removeGraderFromAssignment(...a);
      },
      findEligibleGrader: (...a: unknown[]) => mocks.findEligibleGrader(...a),
      findUngradedSlotsForGrader: (...a: unknown[]) => mocks.findUngradedSlotsForGrader(...a),
      planUngradedReassignment: (...a: unknown[]) => mocks.planUngradedReassignment(...a),
    },
  },
}));

const helper = await import('../index.ts');
const HelperService = helper.default;

const ORG = { id: 'org-1', login: 'acme', provider: 'GITHUB' };
const USERS: Record<string, { id: string; login: string }> = {
  'u-gone': { id: 'u-gone', login: 'ta-gone' },
  'u-ann': { id: 'u-ann', login: 'ta-ann' },
  'u-bob': { id: 'u-bob', login: 'ta-bob' },
};

/** Submissions s1..sN, issue number = N, departing grader u-gone on each. */
const submissions = new Map<string, { graderIds: string[] }>();
const seed = (count: number) => {
  submissions.clear();
  for (let i = 1; i <= count; i++) submissions.set(`s${i}`, { graderIds: ['u-gone'] });
};
const slotRows = () =>
  [...submissions.keys()].map(id => ({
    git_repo_assignment_id: id,
    grader_id: 'u-gone',
    git_repo_assignment: {
      id,
      assignment_id: 'a1',
      git_repo_id: `r-${id}`,
      graders: [{ grader_id: 'u-gone' }],
    },
  }));

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === 'function') m.mockReset();
  mocks.calls.length = 0;
  seed(3);

  mocks.classroomFindById.mockResolvedValue({ id: 'class-1', git_organization: ORG });
  mocks.gradesFor.mockResolvedValue([]);
  mocks.findSubmission.mockImplementation((id: string, classroomId: string) => {
    const sub = submissions.get(id);
    if (!sub || classroomId !== 'class-1') return Promise.resolve(null);
    return Promise.resolve({
      id,
      provider_issue_number: Number(id.slice(1)),
      git_repo: { name: `repo-${id}` },
      graders: sub.graderIds.map(g => ({ grader_id: g, grader: USERS[g] })),
    });
  });
  mocks.findEligibleGrader.mockImplementation((classroomId: string, userId: string) =>
    Promise.resolve(classroomId === 'class-1' && userId !== 'u-gone' ? USERS[userId] : null)
  );
  mocks.addGraderToAssignment.mockImplementation((subId: string, graderId: string) => {
    submissions.get(subId)!.graderIds.push(graderId);
  });
  mocks.removeGraderFromAssignment.mockImplementation((subId: string, graderId: string) => {
    const sub = submissions.get(subId)!;
    sub.graderIds = sub.graderIds.filter(g => g !== graderId);
  });
  mocks.findUngradedSlotsForGrader.mockImplementation(() => Promise.resolve(slotRows()));
  mocks.planUngradedReassignment.mockImplementation(({ slots }: { slots: unknown[] }) =>
    Promise.resolve({
      moves: slots.map((_s, i) => ({
        gitRepoAssignmentId: `s${i + 1}`,
        toGraderId: i % 2 === 0 ? 'u-ann' : 'u-bob',
        toLogin: i % 2 === 0 ? 'ta-ann' : 'ta-bob',
        reason: 'reassign',
      })),
      fallback: null,
    })
  );
  mocks.previewRemoval.mockResolvedValue({
    userId: 'u-gone',
    login: 'ta-gone',
    name: 'Gone Person',
    role: 'ASSISTANT',
    remainsGrader: false,
    ungradedCount: 3,
    heldUngradedCount: 3,
  });
  mocks.removeStaff.mockResolvedValue({
    userId: 'u-gone',
    login: 'ta-gone',
    role: 'ASSISTANT',
    runId: 'run-1',
  });
});

describe('moveGraderSlot', () => {
  it('adds the new grader before removing the old one, with stored names', async () => {
    const result = await HelperService.moveGraderSlot({
      classroomId: 'class-1',
      gitRepoAssignmentId: 's2',
      fromGraderId: 'u-gone',
      toGraderId: 'u-ann',
    });
    expect(result).toEqual({ status: 'moved', toLogin: 'ta-ann' });
    expect(mocks.calls).toEqual([
      'gh-add:ta-ann:2',
      'db-add:u-ann:s2',
      'gh-remove:ta-gone:2',
      'db-remove:u-gone:s2',
    ]);
    // No per-submission notification: the caller sends one summary.
    expect(mocks.addGraderToAssignment).toHaveBeenCalledWith('s2', 'u-ann', { notify: false });
    // The classroom's own installation, looked up from the classroom id.
    expect(mocks.classroomFindById).toHaveBeenCalledWith('class-1');
  });

  it('leaves a slot that was graded since the plan alone', async () => {
    mocks.gradesFor.mockResolvedValue([{ id: 'g1' }]);
    const result = await HelperService.moveGraderSlot({
      classroomId: 'class-1',
      gitRepoAssignmentId: 's1',
      fromGraderId: 'u-gone',
      toGraderId: 'u-ann',
    });
    expect(result).toEqual({ status: 'graded_since' });
    expect(mocks.calls).toEqual([]);
  });

  it('keeps a grade that lands between the add and the remove on the record', async () => {
    // Ungraded before the add, graded by the time the old grader would go.
    mocks.gradesFor.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'g1' }]);
    const result = await HelperService.moveGraderSlot({
      classroomId: 'class-1',
      gitRepoAssignmentId: 's1',
      fromGraderId: 'u-gone',
      toGraderId: 'u-ann',
    });
    expect(result).toEqual({ status: 'graded_since' });
    expect(mocks.calls.some(c => c.startsWith('gh-remove') || c.startsWith('db-remove'))).toBe(
      false
    );
    expect(submissions.get('s1')!.graderIds).toContain('u-gone');
  });

  it('without the fallback, keeps the old grader when the new one is no longer eligible', async () => {
    mocks.findEligibleGrader.mockResolvedValue(null);
    const result = await HelperService.moveGraderSlot({
      classroomId: 'class-1',
      gitRepoAssignmentId: 's1',
      fromGraderId: 'u-gone',
      toGraderId: 'u-ann',
    });
    expect(result).toEqual({ status: 'grader_not_eligible' });
    expect(submissions.get('s1')!.graderIds).toEqual(['u-gone']);
  });

  it('with the fallback (reassign), unassigns when the planned grader left the pool', async () => {
    mocks.findEligibleGrader.mockResolvedValue(null);
    const result = await HelperService.moveGraderSlot({
      classroomId: 'class-1',
      gitRepoAssignmentId: 's1',
      fromGraderId: 'u-gone',
      toGraderId: 'u-ann',
      fallbackToUnassign: true,
    });
    expect(result).toEqual({ status: 'unassigned', reason: 'grader_not_eligible' });
    expect(submissions.get('s1')!.graderIds).toEqual([]);
  });

  it('is safe to repeat (a background retry)', async () => {
    const payload = {
      classroomId: 'class-1',
      gitRepoAssignmentId: 's1',
      fromGraderId: 'u-gone',
      toGraderId: 'u-ann',
    };
    await HelperService.moveGraderSlot(payload);
    const again = await HelperService.moveGraderSlot(payload);
    expect(again).toEqual({ status: 'already_removed' });
    expect(submissions.get('s1')!.graderIds).toEqual(['u-ann']);
  });

  it('refuses a submission outside the classroom', async () => {
    mocks.classroomFindById.mockResolvedValue({ id: 'class-2', git_organization: ORG });
    const scoped = await HelperService.moveGraderSlot({
      classroomId: 'class-2',
      gitRepoAssignmentId: 's1',
      fromGraderId: 'u-gone',
      toGraderId: 'u-ann',
    });
    expect(scoped.status).toBe('submission_not_found');
    expect(submissions.get('s1')!.graderIds).toEqual(['u-gone']);
  });
});

describe('resolveUngradedSlots', () => {
  const resolve = (choice: 'reassign' | 'unassign' | 'keep') =>
    HelperService.resolveUngradedSlots({ classroomId: 'class-1', graderId: 'u-gone', choice });

  it('keep changes nothing', async () => {
    const outcome = await resolve('keep');
    expect(outcome).toMatchObject({ choice: 'keep', total: 3, kept: 3, unassigned: 0 });
    expect(mocks.calls).toEqual([]);
    expect(mocks.planUngradedReassignment).not.toHaveBeenCalled();
  });

  it('unassign removes the departing grader from every ungraded slot', async () => {
    const outcome = await resolve('unassign');
    expect(outcome).toMatchObject({ choice: 'unassign', total: 3, unassigned: 3, failed: 0 });
    expect([...submissions.values()].map(s => s.graderIds)).toEqual([[], [], []]);
    expect(mocks.calls.filter(c => c.startsWith('gh-add'))).toEqual([]);
  });

  it('reassign follows the plan and reports it per grader', async () => {
    const outcome = await resolve('reassign');
    expect(mocks.planUngradedReassignment).toHaveBeenCalledWith({
      classroomId: 'class-1',
      fromGraderId: 'u-gone',
      slots: expect.any(Array),
    });
    expect(outcome).toMatchObject({ choice: 'reassign', total: 3, failed: 0, queued: false });
    expect(outcome.reassigned).toEqual([
      { graderId: 'u-ann', login: 'ta-ann', count: 2 },
      { graderId: 'u-bob', login: 'ta-bob', count: 1 },
    ]);
    expect([...submissions.values()].map(s => s.graderIds)).toEqual([
      ['u-ann'],
      ['u-bob'],
      ['u-ann'],
    ]);
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });

  it('sends ONE summary notification per receiving grader', async () => {
    await HelperService.resolveUngradedSlots({
      classroomId: 'class-1',
      graderId: 'u-gone',
      choice: 'reassign',
      departingName: 'Gone Person',
    });
    expect(mocks.createNotifications).toHaveBeenCalledTimes(2);
    expect(mocks.createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'TA_GRADING_ASSIGNED',
        classroomId: 'class-1',
        recipientUserIds: ['u-ann'],
        resourceType: 'git_repo_assignment',
        title: 'New grading: 2 submissions from Gone Person',
      })
    );
    expect(mocks.createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserIds: ['u-bob'],
        title: 'New grading: 1 submission from Gone Person',
      })
    );
  });

  it('unassign notifies nobody', async () => {
    await resolve('unassign');
    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });

  it('reassign: a planned grader who left the pool is unassigned, with the reason', async () => {
    mocks.findEligibleGrader.mockImplementation((_c: string, userId: string) =>
      Promise.resolve(userId === 'u-ann' ? USERS['u-ann'] : null)
    );
    const outcome = await resolve('reassign');
    // s2 was planned for u-bob, who is no longer eligible.
    expect(outcome).toMatchObject({ unassigned: 1, unassignedIneligible: 1, failed: 0 });
    expect(outcome.reassigned).toEqual([{ graderId: 'u-ann', login: 'ta-ann', count: 2 }]);
    expect(submissions.get('s2')!.graderIds).toEqual([]);
  });

  it('falls back to unassign when the plan finds no other grader, and says so', async () => {
    mocks.planUngradedReassignment.mockResolvedValue({
      moves: ['s1', 's2', 's3'].map(id => ({
        gitRepoAssignmentId: id,
        toGraderId: null,
        toLogin: null,
        reason: 'no_eligible_graders',
      })),
      fallback: 'no_eligible_graders',
    });
    const outcome = await resolve('reassign');
    expect(outcome).toMatchObject({
      fallback: 'no_eligible_graders',
      unassigned: 3,
      reassigned: [],
    });
    expect([...submissions.values()].every(s => s.graderIds.length === 0)).toBe(true);
  });

  it('keeps going when one slot fails, and counts it', async () => {
    mocks.addIssueAssignees.mockImplementation((_o: string, repo: string) =>
      repo === 'repo-s2' ? Promise.reject(new Error('GitHub 502')) : Promise.resolve()
    );
    const outcome = await resolve('reassign');
    expect(outcome.failed).toBe(1);
    expect(outcome.reassigned.reduce((n, r) => n + r.count, 0)).toBe(2);
    // The failed slot still has its old grader — never left empty.
    expect(submissions.get('s2')!.graderIds).toEqual(['u-gone']);
  });

  it('above the inline limit, queues one run per slot and reports the plan', async () => {
    seed(helper.UNGRADED_INLINE_LIMIT + 1);
    const outcome = await resolve('reassign');
    expect(outcome.queued).toBe(true);
    expect(mocks.calls).toEqual([]);
    expect(mocks.batchTrigger).toHaveBeenCalledTimes(1);
    const [taskId, items] = mocks.batchTrigger.mock.calls[0];
    expect(taskId).toBe('move_grader_slot');
    expect(items).toHaveLength(helper.UNGRADED_INLINE_LIMIT + 1);
    // Ids only: the run re-reads everything from the classroom.
    expect(items[0]).toEqual({
      payload: {
        classroomId: 'class-1',
        gitRepoAssignmentId: 's1',
        fromGraderId: 'u-gone',
        toGraderId: 'u-ann',
        fallbackToUnassign: true,
      },
    });
    expect(outcome.reassigned.reduce((n, r) => n + r.count, 0)).toBe(
      helper.UNGRADED_INLINE_LIMIT + 1
    );
    // One summary per grader, saying the moves are still going.
    expect(mocks.createNotifications).toHaveBeenCalledTimes(2);
    expect(mocks.createNotifications.mock.calls[0][0].title).toContain('(being assigned now)');
  });

  it('a chunk that fails to queue fails only itself and what follows', async () => {
    seed(1001); // three chunks of at most 500
    mocks.batchTrigger
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('trigger down'))
      .mockResolvedValue({});
    const outcome = await resolve('reassign');
    expect(mocks.batchTrigger).toHaveBeenCalledTimes(2);
    expect(outcome.queued).toBe(true);
    expect(outcome.reassigned.reduce((n, r) => n + r.count, 0)).toBe(500);
    expect(outcome.failed).toBe(501);
  });

  it('when the first chunk fails, nothing is reported queued and nobody is notified', async () => {
    seed(helper.UNGRADED_INLINE_LIMIT + 1);
    mocks.batchTrigger.mockRejectedValue(new Error('trigger down'));
    const outcome = await resolve('reassign');
    expect(outcome).toMatchObject({ queued: false, failed: helper.UNGRADED_INLINE_LIMIT + 1 });
    expect(outcome.reassigned).toEqual([]);
    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });
});

describe('startStaffRemoval', () => {
  it('refuses without a choice when asked to, before anything is queued', async () => {
    await expect(
      HelperService.startStaffRemoval({
        classroomId: 'class-1',
        login: 'ta-gone',
        role: 'ASSISTANT',
        requireChoice: true,
      })
    ).rejects.toMatchObject({ code: 'ungraded_choice_required', ungradedCount: 3 });
    expect(mocks.removeStaff).not.toHaveBeenCalled();
    expect(mocks.calls).toEqual([]);
  });

  it('a refusal from the preview (last owner, not found) comes before the question', async () => {
    mocks.previewRemoval.mockRejectedValue(
      Object.assign(new Error('last owner'), { code: 'last_owner' })
    );
    await expect(
      HelperService.startStaffRemoval({
        classroomId: 'class-1',
        login: 'ta-gone',
        role: 'OWNER',
        requireChoice: true,
      })
    ).rejects.toMatchObject({ code: 'last_owner' });
    expect(mocks.removeStaff).not.toHaveBeenCalled();
  });

  it('queues the removal and moves NOTHING itself', async () => {
    const started = await HelperService.startStaffRemoval({
      classroomId: 'class-1',
      login: 'ta-gone',
      role: 'ASSISTANT',
      ungradedSubmissions: 'reassign',
      requireChoice: true,
    });
    expect(mocks.calls).toEqual(['removeStaff']);
    expect(mocks.findUngradedSlotsForGrader).not.toHaveBeenCalled();
    expect(started).toMatchObject({
      runId: 'run-1',
      userId: 'u-gone',
      name: 'Gone Person',
      ungradedCount: 3,
      heldUngradedCount: 3,
      choice: 'reassign',
    });
  });

  it('without requireChoice, a missing choice becomes keep', async () => {
    const started = await HelperService.startStaffRemoval({
      classroomId: 'class-1',
      login: 'ta-gone',
      role: 'ASSISTANT',
    });
    expect(started.choice).toBe('keep');
  });

  it('no choice at all when nothing is at stake', async () => {
    mocks.previewRemoval.mockResolvedValue({
      userId: 'u-gone',
      login: 'ta-gone',
      name: null,
      role: 'TEACHER',
      remainsGrader: true,
      ungradedCount: 0,
      heldUngradedCount: 3,
    });
    const started = await HelperService.startStaffRemoval({
      classroomId: 'class-1',
      login: 'ta-gone',
      role: 'TEACHER',
      ungradedSubmissions: 'reassign',
      requireChoice: true,
    });
    expect(started).toMatchObject({ choice: null, ungradedCount: 0, heldUngradedCount: 3 });
  });
});

describe('settleUngradedSlots', () => {
  it('carries out the choice', async () => {
    const outcome = await HelperService.settleUngradedSlots({
      classroomId: 'class-1',
      graderId: 'u-gone',
      choice: 'unassign',
      departingName: 'Gone Person',
      expectedCount: 3,
    });
    expect(outcome).toMatchObject({ choice: 'unassign', unassigned: 3 });
  });

  it('never throws: a failure counts every expected slot as failed', async () => {
    mocks.findUngradedSlotsForGrader.mockRejectedValue(new Error('db down'));
    const outcome = await HelperService.settleUngradedSlots({
      classroomId: 'class-1',
      graderId: 'u-gone',
      choice: 'unassign',
      departingName: 'Gone Person',
      expectedCount: 3,
    });
    expect(outcome).toMatchObject({ choice: 'unassign', failed: 3 });
  });
});
