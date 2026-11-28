/**
 * The checkpoint's audit row: one COLLAB_CHECKPOINT row per pushed doc, as the
 * first of its editors (credit order) who still holds a role in the classroom,
 * by their highest role in any invite state (the role collab admits an editor
 * by and records on its join rows), naming its surface
 * (`task:content_checkpoint`) and the checkpoint's other editors. When none of
 * them holds a role, no row is written and one `audit_miss` line is left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();

vi.mock('@classmoji/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@classmoji/database')>()),
  default: () => ({ classroomMembership: { findMany } }),
}));

const { ClassmojiService } = await import('@classmoji/services');
const { realCheckpointDeps } = await import('../contentCheckpoint.ts');

const entry = {
  classroomId: 'class-1',
  editors: ['teacher-1', 'student-2', 'teacher-3'],
  kind: 'page',
  docId: 'page-1',
  commit: 'abc123',
  version: 7,
  runId: 'run_1',
};

/** Membership rows per user id; a user not listed holds none. */
function memberships(
  byUser: Record<string, Array<{ role: string; has_accepted_invite: boolean }>>
) {
  findMany.mockImplementation(
    async ({ where }: { where: { user_id: string } }) => byUser[where.user_id] ?? []
  );
}

let record: ReturnType<typeof vi.fn>;
let consoleError: { mock: { calls: unknown[][] }; mockRestore(): void };

beforeEach(() => {
  findMany.mockReset();
  record = vi.fn(async () => ({ written: true }));
  Object.assign(ClassmojiService, { audit: { ...ClassmojiService.audit, record } });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

const auditMisses = () => consoleError.mock.calls.filter(call => call[0] === 'audit_miss');

describe('the checkpoint audit row', () => {
  it('names the task as its tool and lists the other editors', async () => {
    memberships({ 'teacher-1': [{ role: 'TEACHER', has_accepted_invite: true }] });

    await realCheckpointDeps().audit(entry);

    expect(findMany).toHaveBeenCalledTimes(1);
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

  it('records the highest role in any invite state, whatever order the memberships come in', async () => {
    memberships({
      'teacher-1': [
        { role: 'STUDENT', has_accepted_invite: true },
        { role: 'OWNER', has_accepted_invite: false },
        { role: 'TEACHER', has_accepted_invite: true },
      ],
    });

    await realCheckpointDeps().audit({ ...entry, kind: 'deck', editors: ['teacher-1'] });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'OWNER',
        resource_type: 'SLIDES',
        data: expect.objectContaining({ editors: [] }),
      })
    );
  });

  it('records an accepted student with a pending teacher invite as TEACHER, as collab does', async () => {
    memberships({
      'teacher-1': [
        { role: 'STUDENT', has_accepted_invite: true },
        { role: 'TEACHER', has_accepted_invite: false },
      ],
    });

    await realCheckpointDeps().audit(entry);

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ role: 'TEACHER' }));
  });

  it('writes the row as the first editor who still holds a role', async () => {
    memberships({
      'current-teacher': [{ role: 'TEACHER', has_accepted_invite: true }],
      'later-teacher': [{ role: 'TEACHER', has_accepted_invite: true }],
    });

    await realCheckpointDeps().audit({
      ...entry,
      editors: ['removed-teacher', 'current-teacher', 'later-teacher'],
    });

    // One read per editor up to the first match, none after it.
    expect(findMany.mock.calls.map(([args]) => args.where.user_id)).toEqual([
      'removed-teacher',
      'current-teacher',
    ]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'current-teacher',
        role: 'TEACHER',
        data: expect.objectContaining({ editors: ['removed-teacher', 'later-teacher'] }),
      })
    );
    expect(auditMisses()).toHaveLength(0);
  });

  it('writes no row, and leaves one audit_miss, when no editor holds a role', async () => {
    memberships({});

    await realCheckpointDeps().audit({ ...entry, editors: ['removed-teacher', 'removed-student'] });

    expect(record).not.toHaveBeenCalled();
    expect(auditMisses()).toHaveLength(1);
    const [, line] = auditMisses()[0];
    expect(JSON.parse(line as string)).toEqual({
      reason: 'no editor holds a role in the classroom',
      row: {
        classroom_id: 'class-1',
        action: 'COLLAB_CHECKPOINT',
        resource_type: 'PAGES',
        resource_id: 'page-1',
        data: {
          tool: 'task:content_checkpoint',
          commit: 'abc123',
          version: 7,
          runId: 'run_1',
          editors: ['removed-teacher', 'removed-student'],
        },
      },
    });
  });
});
