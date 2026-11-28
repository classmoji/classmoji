/**
 * `move_grader_slot` — one ungraded slot moved off a departing grader.
 *
 * The project-wide default is a single attempt, so a task that relies on
 * retrying a transient GitHub failure has to say so itself. This pins that it
 * does, with backoff, and that the run hands its payload (ids only) straight
 * to the classroom-scoped HelperService.moveGraderSlot, with the actor the
 * payload names (read field by field) or none.
 */
import { describe, expect, it, vi } from 'vitest';

const moveGraderSlot = vi.fn();

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  schedules: { task: (config: unknown) => config },
  tasks: { trigger: vi.fn(), batchTrigger: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {},
  HelperService: { moveGraderSlot: (...a: unknown[]) => moveGraderSlot(...a) },
  getGitProvider: vi.fn(),
}));

vi.mock('@classmoji/utils', () => ({
  titleToIdentifier: (t: string) => t,
  gitTerms: () => ({}),
  repoNamespace: () => null,
  scopeGitlabId: (_i: unknown, id: unknown) => String(id),
  GITLAB_PROJECTS_SUBGROUP: 'projects',
}));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../gitRepo.ts', () => ({ createRepositoriesTask: { triggerAndWait: vi.fn() } }));

const { moveGraderSlotTask } = (await import('../gitRepoAssignment.ts')) as unknown as {
  moveGraderSlotTask: {
    id: string;
    retry?: { maxAttempts?: number; factor?: number; minTimeoutInMs?: number };
    run: (payload: unknown) => Promise<unknown>;
  };
};

describe('move_grader_slot', () => {
  it('retries (the default is one attempt) with exponential backoff', () => {
    expect(moveGraderSlotTask.id).toBe('move_grader_slot');
    expect(moveGraderSlotTask.retry?.maxAttempts).toBeGreaterThanOrEqual(3);
    expect(moveGraderSlotTask.retry?.factor).toBeGreaterThan(1);
    expect(moveGraderSlotTask.retry?.minTimeoutInMs).toBeGreaterThan(0);
  });

  it('passes the ids-only payload to the classroom-scoped helper', async () => {
    moveGraderSlot.mockResolvedValue({ status: 'moved', toLogin: 'ta-bob' });
    const payload = {
      classroomId: 'class-1',
      gitRepoAssignmentId: 's1',
      fromGraderId: 'u-gone',
      toGraderId: 'u-bob',
      fallbackToUnassign: true,
    };
    await expect(moveGraderSlotTask.run(payload)).resolves.toEqual({
      status: 'moved',
      toLogin: 'ta-bob',
    });
    // A run queued without an actor (before it existed) records no grader rows.
    expect(moveGraderSlot).toHaveBeenCalledWith({ ...payload, actor: null });
  });

  it('records the moves for the person the payload names, field by field', async () => {
    moveGraderSlot.mockResolvedValue({ status: 'moved', toLogin: 'ta-bob' });
    const actor = {
      userId: 'owner-1',
      role: 'OWNER',
      tool: 'web:staff.remove',
      impersonatedBy: 'admin-1',
    };
    const payload = {
      classroomId: 'class-1',
      gitRepoAssignmentId: 's1',
      fromGraderId: 'u-gone',
      toGraderId: 'u-bob',
      fallbackToUnassign: true,
    };
    await moveGraderSlotTask.run({ ...payload, actor: { ...actor, extra: 'dropped' } });
    expect(moveGraderSlot).toHaveBeenCalledWith({ ...payload, actor });

    // Not a valid actor: nothing recorded, the move still runs.
    moveGraderSlot.mockClear();
    await moveGraderSlotTask.run({ ...payload, actor: { ...actor, role: 'NOBODY' } });
    expect(moveGraderSlot).toHaveBeenCalledWith({ ...payload, actor: null });
  });

  it('lets a provider error throw so the retry policy runs', async () => {
    moveGraderSlot.mockRejectedValue(new Error('GitHub 502'));
    await expect(moveGraderSlotTask.run({})).rejects.toThrow('GitHub 502');
  });
});
