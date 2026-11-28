/**
 * The checkpoint's audit row: one COLLAB_CHECKPOINT row per pushed doc, as the
 * doc's editor in their highest ACCEPTED role in the classroom (their highest
 * role in any invite state when none is accepted: collab lets an owner or
 * teacher edit before accepting), naming its surface (`task:content_checkpoint`)
 * and the checkpoint's other editors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();

vi.mock('@classmoji/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@classmoji/database')>()),
  default: () => ({ classroomMembership: { findMany } }),
}));

const { ClassmojiService } = await import('@classmoji/services');
const { realCheckpointDeps } = await import('../contentCheckpoint.ts');

const entry = {
  classroomId: 'class-1',
  userId: 'teacher-1',
  editors: ['student-2', 'teacher-3'],
  kind: 'page',
  docId: 'page-1',
  commit: 'abc123',
  version: 7,
  runId: 'run_1',
};

let record: ReturnType<typeof vi.fn>;

beforeEach(() => {
  findMany.mockReset();
  record = vi.fn(async () => ({ written: true }));
  Object.assign(ClassmojiService, { audit: { ...ClassmojiService.audit, record } });
});

describe('the checkpoint audit row', () => {
  it('names the task as its tool and lists the other editors', async () => {
    findMany.mockResolvedValue([{ role: 'TEACHER', has_accepted_invite: true }]);

    await realCheckpointDeps().audit(entry);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'teacher-1', classroom_id: 'class-1' } })
    );
    expect(record).toHaveBeenCalledWith({
      classroom_id: 'class-1',
      user_id: 'teacher-1',
      role: 'TEACHER',
      action: 'COLLAB_CHECKPOINT',
      resource_type: 'PAGES',
      resource_id: 'page-1',
      data: {
        tool: 'task:content_checkpoint',
        commit: 'abc123',
        version: 7,
        runId: 'run_1',
        editors: ['student-2', 'teacher-3'],
      },
    });
  });

  it('records the highest ACCEPTED role, whatever order the memberships come in', async () => {
    findMany.mockResolvedValue([
      { role: 'STUDENT', has_accepted_invite: true },
      { role: 'OWNER', has_accepted_invite: false },
      { role: 'TEACHER', has_accepted_invite: true },
    ]);

    await realCheckpointDeps().audit({ ...entry, kind: 'deck', editors: [] });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'TEACHER',
        resource_type: 'SLIDES',
        data: expect.objectContaining({ editors: [] }),
      })
    );
  });

  it('records a pending teacher, who may edit before accepting, by that role', async () => {
    findMany.mockResolvedValue([
      { role: 'STUDENT', has_accepted_invite: false },
      { role: 'TEACHER', has_accepted_invite: false },
    ]);

    await realCheckpointDeps().audit(entry);

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ role: 'TEACHER' }));
  });

  it('writes nothing for an editor who holds no role in the classroom', async () => {
    findMany.mockResolvedValue([]);

    await realCheckpointDeps().audit(entry);

    expect(record).not.toHaveBeenCalled();
  });
});
