/**
 * Reordering a module's assignments takes the module row lock a move into or
 * out of that module takes (#567), before reading the assignments it checks.
 * Without it a move could land between the read and the writes and leave two
 * assignments on one stored position.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@classmoji/database', () => ({ default: () => ({}), GIT_IDENTITY: {} }));

const { reorderInModuleTx } = await import('../assignment.service.ts');

const queryRaw = vi.fn(async (..._args: unknown[]) => []);
const moduleFindFirst = vi.fn();
const assignmentFindMany = vi.fn();
const assignmentUpdate = vi.fn();
const tx = {
  $queryRaw: queryRaw,
  module: { findFirst: moduleFindFirst },
  assignment: { findMany: assignmentFindMany, update: assignmentUpdate },
};
const reorder = (ids: string[]) => reorderInModuleTx(tx as never, 'mod-1', ids, 'class-1');

beforeEach(() => {
  vi.clearAllMocks();
  moduleFindFirst.mockResolvedValue({ id: 'mod-1' });
  assignmentFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
});

describe('reorderInModuleTx', () => {
  it('locks the module row before reading the assignments it checks', async () => {
    await reorder(['b', 'a']);

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0][1]).toBe('mod-1');
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      assignmentFindMany.mock.invocationCallOrder[0]
    );
  });

  it('writes each position as its index, scoped to the module', async () => {
    await reorder(['b', 'a']);

    expect(assignmentUpdate.mock.calls.map(call => call[0])).toEqual([
      { where: { id: 'b', module_id: 'mod-1' }, data: { position: 0 } },
      { where: { id: 'a', module_id: 'mod-1' }, data: { position: 1 } },
    ]);
  });

  it('refuses a module from another classroom before locking anything', async () => {
    moduleFindFirst.mockResolvedValue(null);

    await expect(reorder(['a', 'b'])).rejects.toThrow('Module not found in classroom');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('refuses an ordering that is not exactly the module assignments, writing nothing', async () => {
    await expect(reorder(['a'])).rejects.toThrow(
      'Ordered assignment ids must match the module assignments'
    );
    expect(assignmentUpdate).not.toHaveBeenCalled();
  });
});
