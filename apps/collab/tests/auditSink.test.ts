/**
 * The real audit sink's mapping onto the audit service: who was viewing as
 * the user ("View as") reaches the row's data and the non-member refusal,
 * and a row written outside View as has no such key.
 */
import { describe, expect, it, vi } from 'vitest';

import { createServiceAuditSink } from '../src/audit.ts';

const entry = {
  userId: 'teacher-1',
  classroomId: 'class-1',
  role: 'TEACHER',
  action: 'COLLAB_JOIN' as const,
  resourceType: 'PAGES',
  resourceId: 'page-1',
  data: { tool: 'collab' },
};

describe('createServiceAuditSink', () => {
  it('writes impersonated_by into the row data under View as', async () => {
    const write = vi.fn().mockResolvedValue({});
    const sink = createServiceAuditSink(write, vi.fn());
    await sink.record({ ...entry, impersonatedBy: 'admin-1' });
    expect(write).toHaveBeenCalledWith({
      user_id: 'teacher-1',
      classroom_id: 'class-1',
      role: 'TEACHER',
      action: 'COLLAB_JOIN',
      resource_type: 'PAGES',
      resource_id: 'page-1',
      data: { tool: 'collab', impersonated_by: 'admin-1' },
    });
  });

  it('writes the data alone on the user’s own session', async () => {
    const write = vi.fn().mockResolvedValue({});
    const sink = createServiceAuditSink(write, vi.fn());
    await sink.record(entry);
    await sink.record({ ...entry, impersonatedBy: null });
    for (const [row] of write.mock.calls) expect(row.data).toEqual({ tool: 'collab' });
  });

  it('hands a non-member refusal the admin only under View as', async () => {
    const refuse = vi.fn().mockResolvedValue(undefined);
    const sink = createServiceAuditSink(vi.fn(), refuse);
    await sink.recordNonMemberRefusal({ userId: 'u-1', classroomId: 'class-1' });
    await sink.recordNonMemberRefusal({
      userId: 'u-1',
      classroomId: 'class-1',
      impersonatedBy: 'admin-1',
    });
    expect(refuse.mock.calls).toEqual([
      [{ userId: 'u-1', classroomId: 'class-1' }],
      [{ userId: 'u-1', classroomId: 'class-1', impersonatedBy: 'admin-1' }],
    ]);
  });
});
