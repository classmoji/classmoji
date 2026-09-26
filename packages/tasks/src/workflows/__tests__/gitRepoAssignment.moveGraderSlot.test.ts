/**
 * `move_grader_slot` — one ungraded slot moved off a departing grader.
 *
 * The project-wide default is a single attempt, so a task that relies on
 * retrying a transient GitHub failure has to say so itself. This pins that it
 * does, with backoff, and that the run hands its payload (ids only) straight
 * to the classroom-scoped HelperService.moveGraderSlot.
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

vi.mock('@classmoji/utils', () => ({ titleToIdentifier: (t: string) => t }));
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
    expect(moveGraderSlot).toHaveBeenCalledWith(payload);
  });

  it('lets a provider error throw so the retry policy runs', async () => {
    moveGraderSlot.mockRejectedValue(new Error('GitHub 502'));
    await expect(moveGraderSlotTask.run({})).rejects.toThrow('GitHub 502');
  });
});
