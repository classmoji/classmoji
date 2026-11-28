/**
 * The content-delivery switch's action reports the failures it swallows (a
 * database fault on toggle or bulk update) beside its log line, and never the
 * expected one (the classroom is gone, P2025). The answers are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionFunctionArgs } from 'react-router';
import { setErrorReporter, type ReportContext } from '@classmoji/utils/error-report';

const db = vi.hoisted(() => ({
  update: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('~/utils/db.server', () => ({
  prisma: {
    classroom: {
      update: db.update,
      updateMany: db.updateMany,
      findUnique: vi.fn(async () => ({ id: 'c1', name: 'Class' })),
      count: vi.fn(async () => 1),
    },
    // The switch and its platform row are written together.
    $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
  },
  requirePlatformAdmin: vi.fn(async () => ({ user: { id: 'admin-1' } })),
}));
vi.mock('~/utils/audit.server', () => ({ platformAudit: vi.fn(async () => {}) }));

const { contentDeliveryAction } = await import('../route.server.ts');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const request = new Request('https://admin.example.com/ops/delivery', { method: 'POST', body });
  return contentDeliveryAction({ request } as ActionFunctionArgs);
};

let reported: Array<{ error: unknown; context: ReportContext }>;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reported = [];
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  setErrorReporter({
    capture: (error, context) => reported.push({ error, context }),
    flush: async () => true,
  });
  db.update.mockReset();
  db.updateMany.mockReset();
});
afterEach(() => {
  setErrorReporter(null);
  logged.mockRestore();
});

describe('contentDeliveryAction', () => {
  it('reports a failed toggle and answers as before', async () => {
    const error = new Error('connection reset');
    db.update.mockRejectedValue(error);
    expect(await post({ intent: 'toggle', classroomId: 'c1', enabled: 'true' })).toEqual({
      error: 'Could not change that classroom. Try again.',
    });
    expect(logged).toHaveBeenCalled();
    expect(reported).toEqual([
      { error, context: { surface: 'admin.delivery.toggle', tags: { enabled: true } } },
    ]);
  });

  it('does not report a classroom that is gone (P2025)', async () => {
    db.update.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    expect(await post({ intent: 'toggle', classroomId: 'c1', enabled: 'false' })).toEqual({
      error: 'That classroom no longer exists — the list is out of date.',
    });
    expect(reported).toEqual([]);
  });

  it('reports a failed bulk update and answers as before', async () => {
    const error = new Error('timeout');
    db.updateMany.mockRejectedValue(error);
    expect(await post({ intent: 'disable-all' })).toEqual({
      error: 'Could not apply that change. Try again.',
    });
    expect(reported).toEqual([
      { error, context: { surface: 'admin.delivery.bulk', tags: { enabled: false } } },
    ]);
  });
});
