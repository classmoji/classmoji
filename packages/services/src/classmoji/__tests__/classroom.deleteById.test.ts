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

vi.mock('../../media/index.ts', () => ({
  purgeClassroomMedia: (...a: unknown[]) => purgeClassroomMedia(...a),
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({ classroom: { delete: (...a: unknown[]) => classroomDelete(...a) } }),
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
    return { id: CLASSROOM_ID };
  });
});

describe('classroom deleteById', () => {
  it('purges the media prefix before the row cascade', async () => {
    await deleteById(CLASSROOM_ID);
    expect(purgeClassroomMedia).toHaveBeenCalledWith(CLASSROOM_ID);
    expect(order).toEqual(['purge', 'delete']);
  });

  it('keeps the classroom when the purge fails, so the delete can be retried', async () => {
    purgeClassroomMedia.mockRejectedValue(new Error('r2 is down'));
    await expect(deleteById(CLASSROOM_ID)).rejects.toThrow('r2 is down');
    expect(classroomDelete).not.toHaveBeenCalled();
  });
});
