/**
 * The checkpoint's audit row: one COLLAB_CHECKPOINT row per pushed doc, as the
 * doc's editor, naming its surface (`task:content_checkpoint`).
 */
import { describe, expect, it, vi } from 'vitest';

const findFirst = vi.fn(async () => ({ role: 'TEACHER' }));

vi.mock('@classmoji/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@classmoji/database')>()),
  default: () => ({ classroomMembership: { findFirst } }),
}));

const { ClassmojiService } = await import('@classmoji/services');
const { realCheckpointDeps } = await import('../contentCheckpoint.ts');

describe('the checkpoint audit row', () => {
  it('names the task as its tool', async () => {
    const record = vi.fn(async () => ({ written: true }));
    Object.assign(ClassmojiService, { audit: { ...ClassmojiService.audit, record } });

    await realCheckpointDeps().audit({
      classroomId: 'class-1',
      userId: 'teacher-1',
      kind: 'page',
      docId: 'page-1',
      commit: 'abc123',
      version: 7,
      runId: 'run_1',
    });

    expect(record).toHaveBeenCalledWith({
      classroom_id: 'class-1',
      user_id: 'teacher-1',
      role: 'TEACHER',
      action: 'COLLAB_CHECKPOINT',
      resource_type: 'PAGES',
      resource_id: 'page-1',
      data: { tool: 'task:content_checkpoint', commit: 'abc123', version: 7, runId: 'run_1' },
    });
  });
});
