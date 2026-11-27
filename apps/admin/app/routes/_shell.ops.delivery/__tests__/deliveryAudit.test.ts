import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The content-delivery switch writes its platform audit row FIRST and changes
 * the classroom only once that row is written: in apps/admin an action that
 * cannot be recorded does not happen (utils/audit.server.ts). Both places the
 * switch lives: the rollout screen (one classroom, or every one in the list)
 * and the classroom page.
 */

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  auditCreate: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
  order: [] as string[],
}));

vi.mock('~/utils/db.server', () => ({
  requirePlatformAdmin: (...a: unknown[]) => mocks.requirePlatformAdmin(...a),
  prisma: {
    platformAuditLog: {
      create: (...a: unknown[]) => {
        mocks.order.push('audit');
        return mocks.auditCreate(...a);
      },
    },
    classroom: {
      findUnique: (...a: unknown[]) => mocks.findUnique(...a),
      update: (...a: unknown[]) => {
        mocks.order.push('update');
        return mocks.update(...a);
      },
      updateMany: (...a: unknown[]) => {
        mocks.order.push('update');
        return mocks.updateMany(...a);
      },
      count: (...a: unknown[]) => mocks.count(...a),
    },
  },
}));

const { contentDeliveryAction } = await import('../route.server');
const { classroomAction } = await import('../../_shell.classrooms_.$slug/route.server');

const post = (url: string, fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { request: new Request(url, { method: 'POST', body }), params: { slug: 'cs52' } } as never;
};

const DELIVERY = 'http://admin.test/ops/delivery';

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === 'function') m.mockReset();
  mocks.order.length = 0;
  mocks.requirePlatformAdmin.mockResolvedValue({ user: { id: 'admin-1' } });
  mocks.findUnique.mockResolvedValue({ id: 'class-1', name: 'CS 52' });
  mocks.update.mockResolvedValue({ id: 'class-1' });
  mocks.updateMany.mockResolvedValue({ count: 3 });
  mocks.count.mockResolvedValue(3);
  mocks.auditCreate.mockResolvedValue({ id: 'row-1' });
});

describe('the rollout screen’s switch for one classroom', () => {
  it('writes the row, then changes the classroom', async () => {
    const result = await contentDeliveryAction(
      post(DELIVERY, { intent: 'toggle', classroomId: 'class-1', enabled: 'true' })
    );
    expect(result).toEqual({ ok: true, changed: 1 });
    expect(mocks.order).toEqual(['audit', 'update']);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'delivery.toggle',
        target_id: 'class-1',
        data: { enabled: true, classroomName: 'CS 52' },
      }),
    });
  });

  it('does not change the classroom when the row cannot be written', async () => {
    mocks.auditCreate.mockRejectedValue(new Error('database away'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await contentDeliveryAction(
      post(DELIVERY, { intent: 'toggle', classroomId: 'class-1', enabled: 'true' })
    );
    expect(result).toEqual({ error: 'Could not change that classroom. Try again.' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers a classroom that is gone without writing anything', async () => {
    mocks.findUnique.mockResolvedValue(null);
    const result = await contentDeliveryAction(
      post(DELIVERY, { intent: 'toggle', classroomId: 'gone', enabled: 'true' })
    );
    expect(result).toEqual({ error: 'That classroom no longer exists — the list is out of date.' });
    expect(mocks.order).toEqual([]);
  });
});

describe('the rollout screen’s switch for every classroom in the list', () => {
  it('writes the row with the count it is about to change, then changes them', async () => {
    const result = await contentDeliveryAction(post(DELIVERY, { intent: 'enable-all' }));
    expect(result).toEqual({ ok: true, changed: 3 });
    expect(mocks.order).toEqual(['audit', 'update']);
    expect(mocks.count.mock.calls[0][0]).toEqual({
      where: mocks.updateMany.mock.calls[0][0].where,
    });
    expect(mocks.auditCreate.mock.calls[0][0].data.data).toMatchObject({
      enabled: true,
      changed: 3,
    });
  });

  it('changes nothing when the row cannot be written', async () => {
    mocks.auditCreate.mockRejectedValue(new Error('database away'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await contentDeliveryAction(post(DELIVERY, { intent: 'disable-all' }));
    expect(result).toEqual({ error: 'Could not apply that change. Try again.' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe('the classroom page’s switch', () => {
  it('writes the row, then changes the classroom', async () => {
    const result = await classroomAction(
      post('http://admin.test/classrooms/cs52', { intent: 'delivery', enabled: 'false' })
    );
    expect(result).toEqual({ ok: true });
    expect(mocks.order).toEqual(['audit', 'update']);
  });

  it('does not change the classroom when the row cannot be written', async () => {
    mocks.auditCreate.mockRejectedValue(new Error('database away'));
    await expect(
      classroomAction(
        post('http://admin.test/classrooms/cs52', { intent: 'delivery', enabled: 'false' })
      )
    ).rejects.toThrow('database away');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
