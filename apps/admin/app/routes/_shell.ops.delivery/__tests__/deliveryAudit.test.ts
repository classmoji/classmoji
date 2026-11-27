import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The content-delivery switch saves the classroom change and its platform
 * audit row in ONE transaction (Prisma's array form): both are saved or
 * neither is, so in apps/admin an action that cannot be recorded does not
 * happen (utils/audit.server.ts). Both places the switch lives: the rollout
 * screen (one classroom, or every one in the list) and the classroom page.
 *
 * The query builders return tagged descriptors here, so a test can see which
 * queries went into the batch; `$transaction` stands in for the database.
 */

type Query = { query: string; args: unknown };

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  findUnique: vi.fn(),
  count: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('~/utils/db.server', () => ({
  requirePlatformAdmin: (...a: unknown[]) => mocks.requirePlatformAdmin(...a),
  prisma: {
    $transaction: (...a: unknown[]) => mocks.transaction(...a),
    platformAuditLog: {
      create: (args: unknown): Query => ({ query: 'audit', args }),
    },
    classroom: {
      findUnique: (...a: unknown[]) => mocks.findUnique(...a),
      update: (args: unknown): Query => ({ query: 'update', args }),
      updateMany: (args: unknown): Query => ({ query: 'updateMany', args }),
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
const CLASSROOM = 'http://admin.test/classrooms/cs52';

/** The one batch the action handed to `$transaction`. */
const batch = (): Query[] => {
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
  const [queries] = mocks.transaction.mock.calls[0];
  expect(Array.isArray(queries)).toBe(true);
  return queries as Query[];
};

const auditRow = (queries: Query[]) =>
  (queries.find(q => q.query === 'audit')?.args as { data: Record<string, unknown> } | undefined)
    ?.data;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requirePlatformAdmin.mockResolvedValue({ user: { id: 'admin-1' } });
  mocks.findUnique.mockResolvedValue({ id: 'class-1', name: 'CS 52' });
  mocks.count.mockResolvedValue(3);
  mocks.transaction.mockImplementation(async (queries: Query[]) =>
    queries.map(q =>
      q.query === 'updateMany'
        ? { count: 2 }
        : q.query === 'update'
          ? { id: 'class-1' }
          : { id: 'row-1' }
    )
  );
});

describe('the rollout screen’s switch for one classroom', () => {
  it('saves the change and its row in one transaction', async () => {
    const result = await contentDeliveryAction(
      post(DELIVERY, { intent: 'toggle', classroomId: 'class-1', enabled: 'true' })
    );
    expect(result).toEqual({ ok: true, changed: 1 });
    const queries = batch();
    expect(queries.map(q => q.query)).toEqual(['update', 'audit']);
    expect(queries[0].args).toMatchObject({
      where: { id: 'class-1' },
      data: { content_delivery_enabled: true },
    });
    expect(auditRow(queries)).toEqual({
      actor_id: 'admin-1',
      action: 'delivery.toggle',
      target_type: 'classroom',
      target_id: 'class-1',
      classroom_id: 'class-1',
      data: { enabled: true, classroomName: 'CS 52' },
    });
  });

  it('reports nothing changed when the transaction fails', async () => {
    mocks.transaction.mockRejectedValue(new Error('database away'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await contentDeliveryAction(
      post(DELIVERY, { intent: 'toggle', classroomId: 'class-1', enabled: 'true' })
    );
    expect(result).toEqual({ error: 'Could not change that classroom. Try again.' });
  });

  it('answers a classroom deleted before the switch', async () => {
    mocks.transaction.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const result = await contentDeliveryAction(
      post(DELIVERY, { intent: 'toggle', classroomId: 'class-1', enabled: 'true' })
    );
    expect(result).toEqual({ error: 'That classroom no longer exists — the list is out of date.' });
  });

  it('answers a classroom that is gone without writing anything', async () => {
    mocks.findUnique.mockResolvedValue(null);
    const result = await contentDeliveryAction(
      post(DELIVERY, { intent: 'toggle', classroomId: 'gone', enabled: 'true' })
    );
    expect(result).toEqual({ error: 'That classroom no longer exists — the list is out of date.' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('the rollout screen’s switch for every classroom in the list', () => {
  it('saves the change and its row in one transaction', async () => {
    const result = await contentDeliveryAction(post(DELIVERY, { intent: 'enable-all' }));
    // The admin is told what the update changed; the row keeps the count
    // taken just before the switch.
    expect(result).toEqual({ ok: true, changed: 2 });
    const queries = batch();
    expect(queries.map(q => q.query)).toEqual(['updateMany', 'audit']);
    const updateArgs = queries[0].args as { where: unknown; data: unknown };
    expect(updateArgs.data).toEqual({ content_delivery_enabled: true });
    expect(mocks.count.mock.calls[0][0]).toEqual({ where: updateArgs.where });
    expect(mocks.count.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transaction.mock.invocationCallOrder[0]
    );
    expect(auditRow(queries)).toEqual({
      actor_id: 'admin-1',
      action: 'delivery.bulk',
      target_type: 'classrooms',
      target_id: null,
      classroom_id: null,
      data: { enabled: true, changed: 3, filter: { q: '', state: '', scope: 'active' } },
    });
  });

  it('reports nothing changed when the transaction fails', async () => {
    mocks.transaction.mockRejectedValue(new Error('database away'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await contentDeliveryAction(post(DELIVERY, { intent: 'disable-all' }));
    expect(result).toEqual({ error: 'Could not apply that change. Try again.' });
  });
});

describe('the classroom page’s switch', () => {
  it('saves the change and its row in one transaction', async () => {
    const result = await classroomAction(post(CLASSROOM, { intent: 'delivery', enabled: 'false' }));
    expect(result).toEqual({ ok: true });
    const queries = batch();
    expect(queries.map(q => q.query)).toEqual(['update', 'audit']);
    expect(queries[0].args).toMatchObject({
      where: { id: 'class-1' },
      data: { content_delivery_enabled: false },
    });
    expect(auditRow(queries)).toEqual({
      actor_id: 'admin-1',
      action: 'delivery.toggle',
      target_type: 'classroom',
      target_id: 'class-1',
      classroom_id: 'class-1',
      data: { enabled: false, classroomName: 'CS 52' },
    });
  });

  it('answers the admin, not a 500, when the transaction fails', async () => {
    mocks.transaction.mockRejectedValue(new Error('database away'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await classroomAction(post(CLASSROOM, { intent: 'delivery', enabled: 'false' }));
    expect(result).toEqual({ error: 'Could not change that classroom. Try again.' });
  });

  it('answers a classroom deleted before the switch', async () => {
    mocks.transaction.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const result = await classroomAction(post(CLASSROOM, { intent: 'delivery', enabled: 'false' }));
    expect(result).toEqual({ error: 'That classroom no longer exists.' });
  });

  it('answers a classroom that is gone without writing anything', async () => {
    mocks.findUnique.mockResolvedValue(null);
    const result = await classroomAction(post(CLASSROOM, { intent: 'delivery', enabled: 'false' }));
    expect(result).toEqual({ error: 'That classroom no longer exists.' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
