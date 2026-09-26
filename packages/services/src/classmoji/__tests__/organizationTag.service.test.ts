import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const findUnique = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({ tag: { create, findUnique } }),
}));

const { findOrCreate } = await import('../organizationTag.service.ts');

const uniqueViolation = () =>
  Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findOrCreate', () => {
  it('inserts the tag in the given classroom and reports created:true', async () => {
    create.mockResolvedValue({ id: 'tag-1', name: 'pairs', classroom_id: 'class-1' });

    await expect(findOrCreate('class-1', 'pairs')).resolves.toEqual({
      tag: { id: 'tag-1', name: 'pairs', classroom_id: 'class-1' },
      created: true,
    });
    expect(create).toHaveBeenCalledExactlyOnceWith({
      data: { classroom_id: 'class-1', name: 'pairs' },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns the existing tag with created:false on a unique violation', async () => {
    create.mockRejectedValue(uniqueViolation());
    findUnique.mockResolvedValue({ id: 'tag-0', name: 'pairs', classroom_id: 'class-1' });

    await expect(findOrCreate('class-1', 'pairs')).resolves.toEqual({
      tag: { id: 'tag-0', name: 'pairs', classroom_id: 'class-1' },
      created: false,
    });
    // Looked up by the exact (classroom, name) key — case-sensitive.
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { classroom_id_name: { classroom_id: 'class-1', name: 'pairs' } },
    });
  });

  it('rethrows a unique violation it cannot resolve to an existing row', async () => {
    const error = uniqueViolation();
    create.mockRejectedValue(error);
    findUnique.mockResolvedValue(null);

    await expect(findOrCreate('class-1', 'pairs')).rejects.toBe(error);
  });

  it('rethrows any other error without a lookup', async () => {
    const error = new Error('connection lost');
    create.mockRejectedValue(error);

    await expect(findOrCreate('class-1', 'pairs')).rejects.toBe(error);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
