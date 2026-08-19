import { describe, it, expect, vi, beforeEach } from 'vitest';

const deleteMany = vi.fn();
const updateMany = vi.fn();
const findFirst = vi.fn();
const findUniqueOrThrow = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    repository: { deleteMany, updateMany, findFirst, findUniqueOrThrow },
  }),
}));

vi.mock('@classmoji/utils', () => ({ titleToIdentifier: (s: string) => s.toLowerCase() }));

vi.mock('../notification.service.ts', () => ({
  runSafely: vi.fn(),
  getStudentsInClassroom: vi.fn(async () => []),
  createNotifications: vi.fn(),
}));

const { deleteById, setPublished, update } = await import('../repository.service.ts');

/** Every prisma method the service could reach — asserted untouched by the guard. */
const allPrismaCalls = () => [deleteMany, updateMany, findFirst, findUniqueOrThrow];

/** Ids that survive `if (!id)` but widen a scoped `where` to the whole classroom. */
const unusableIds: [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['a StringFilter object', { not: '' }],
  ['an empty string', ''],
  ['a number', 7],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deleteById', () => {
  it.each(unusableIds)('rejects %s as an id before issuing any query', async (_label, id) => {
    await expect(deleteById(id as string, 'classroom-1')).rejects.toThrow('Invalid repository id');
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a classroom id before any query', async (_label, cid) => {
    await expect(deleteById('repo-1', cid as string)).rejects.toThrow('Invalid classroom id');
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it('scopes the delete to the authorized classroom', async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    await expect(deleteById('repo-1', 'classroom-1')).resolves.toEqual({ id: 'repo-1' });
    expect(deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'repo-1', classroom_id: 'classroom-1' },
    });
  });

  it('throws when the id did not belong to the classroom', async () => {
    deleteMany.mockResolvedValue({ count: 0 });
    await expect(deleteById('repo-1', 'other-classroom')).rejects.toThrow(
      'Repository not found in classroom'
    );
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('setPublished', () => {
  it.each(unusableIds)('rejects %s as an id before the pre-read', async (_label, id) => {
    await expect(setPublished(id as string, true, 'classroom-1')).rejects.toThrow(
      'Invalid repository id'
    );
    // The pre-read matters as much as the write: an unusable id would make it
    // return an arbitrary repository in the classroom.
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a classroom id before the pre-read', async (_label, cid) => {
    await expect(setPublished('repo-1', true, cid as string)).rejects.toThrow(
      'Invalid classroom id'
    );
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it('scopes the flip to the authorized classroom', async () => {
    findFirst.mockResolvedValue({ is_published: false });
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({
      id: 'repo-1',
      classroom_id: 'classroom-1',
      title: 'HW1',
    });

    await expect(setPublished('repo-1', true, 'classroom-1')).resolves.toMatchObject({
      id: 'repo-1',
    });
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'repo-1', classroom_id: 'classroom-1' },
      data: { is_published: true },
    });
  });

  it('throws without reading the row back when the repo was another classroom', async () => {
    findFirst.mockResolvedValue(null);
    updateMany.mockResolvedValue({ count: 0 });

    await expect(setPublished('repo-1', true, 'other-classroom')).rejects.toThrow(
      'Repository not found in classroom'
    );
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('update', () => {
  it.each(unusableIds)('rejects %s as an id before issuing any query', async (_label, id) => {
    await expect(update(id as string, { weight: 50 }, 'classroom-1')).rejects.toThrow(
      'Invalid repository id'
    );
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a classroom id before any query', async (_label, cid) => {
    await expect(update('repo-1', { weight: 50 }, cid as string)).rejects.toThrow(
      'Invalid classroom id'
    );
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it('scopes the write to the authorized classroom and returns the row', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findFirst.mockResolvedValue({ id: 'repo-1', weight: 50, assignments: [], tag: null });

    await expect(update('repo-1', { weight: 50 }, 'classroom-1')).resolves.toMatchObject({
      id: 'repo-1',
      weight: 50,
    });
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'repo-1', classroom_id: 'classroom-1' },
      data: { weight: 50 },
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'repo-1', classroom_id: 'classroom-1' } })
    );
  });

  it('throws when the repository lives in another classroom', async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(update('repo-1', { weight: 50 }, 'other-classroom')).rejects.toThrow(
      'Repository not found in classroom'
    );
    expect(findFirst).not.toHaveBeenCalled();
  });
});
