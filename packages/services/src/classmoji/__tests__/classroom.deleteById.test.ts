/**
 * Deleting a classroom removes its stored media first.
 *
 * The `media_objects` rows cascade away with the classroom, and after that
 * nothing names the R2 objects. So the purge must run BEFORE the row delete,
 * and a purge that fails must stop the delete — otherwise the files are left
 * in the bucket with no record of them anywhere.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const purgeClassroomMedia = vi.fn();
const classroomDelete = vi.fn();
const platformAuditCreate = vi.fn();

vi.mock('../../media/index.ts', () => ({
  purgeClassroomMedia: (...a: unknown[]) => purgeClassroomMedia(...a),
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: {
      delete: (...a: unknown[]) => classroomDelete(...a),
      findUnique: async () => {
        order.push('count');
        return {
          slug: 'cs-1',
          name: 'CS 1',
          git_organization: { login: 'school-org', provider: 'GITHUB' },
          _count: { audit_logs: 4, memberships: 3 },
        };
      },
    },
    assignment: { count: async () => 2 },
    platformAuditLog: {
      create: (...a: unknown[]) => {
        order.push('record');
        return platformAuditCreate(...a);
      },
    },
  }),
}));
vi.mock('../../git/index.ts', () => ({ GitHubProvider: class {} }));

const { deleteById } = await import('../classroom.service.ts');

const CLASSROOM_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  order.length = 0;
  purgeClassroomMedia.mockReset();
  classroomDelete.mockReset();
  purgeClassroomMedia.mockImplementation(async () => {
    order.push('purge');
    return { deleted: 2 };
  });
  classroomDelete.mockImplementation(async () => {
    order.push('delete');
    return { id: CLASSROOM_ID, slug: 'cs-1', name: 'CS 1' };
  });
  platformAuditCreate.mockReset();
  platformAuditCreate.mockResolvedValue({});
});

const BY = { actorId: 'owner-1' };

describe('classroom deleteById', () => {
  it('purges the media prefix before the row cascade', async () => {
    await deleteById(CLASSROOM_ID, BY);
    expect(purgeClassroomMedia).toHaveBeenCalledWith(CLASSROOM_ID);
    expect(order).toEqual(['purge', 'count', 'delete', 'record']);
  });

  it('records the deletion once, after it, with counts taken before it', async () => {
    await deleteById(CLASSROOM_ID, BY);
    expect(platformAuditCreate).toHaveBeenCalledTimes(1);
    expect(platformAuditCreate).toHaveBeenCalledWith({
      data: {
        actor_id: 'owner-1',
        action: 'classroom.delete',
        target_type: 'classroom',
        target_id: CLASSROOM_ID,
        classroom_id: CLASSROOM_ID,
        data: {
          slug: 'cs-1',
          name: 'CS 1',
          git_organization: 'school-org',
          provider: 'GITHUB',
          counts: { audit_rows: 4, members: 3, assignments: 2 },
        },
      },
    });
  });

  it('keeps the classroom when the purge fails, so the delete can be retried', async () => {
    purgeClassroomMedia.mockRejectedValue(new Error('r2 is down'));
    await expect(deleteById(CLASSROOM_ID, BY)).rejects.toThrow('r2 is down');
    expect(classroomDelete).not.toHaveBeenCalled();
    expect(platformAuditCreate).not.toHaveBeenCalled();
  });

  it('records nothing when the delete itself fails', async () => {
    classroomDelete.mockRejectedValue(new Error('database down'));
    await expect(deleteById(CLASSROOM_ID, BY)).rejects.toThrow('database down');
    expect(platformAuditCreate).not.toHaveBeenCalled();
  });
});
