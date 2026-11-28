/**
 * The real audit sink's mapping onto the audit service: who was viewing as
 * the user ("View as") reaches the row's data and the non-member refusal,
 * and a row written outside View as has no such key.
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AuditResourceType } from '@classmoji/services/audit-resource-types';
import { COLLAB_AUDIT_RESOURCE } from '@classmoji/collab';

import { createServiceAuditSink, type AuditEntry } from '../src/audit.ts';

const entry = {
  userId: 'teacher-1',
  classroomId: 'class-1',
  role: 'TEACHER',
  action: 'COLLAB_JOIN' as const,
  resourceType: 'PAGES' as const,
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

describe('the collab rows’ resource type', () => {
  it('is the audit vocabulary, the doc kind’s for every collab row', () => {
    expectTypeOf<AuditEntry['resourceType']>().toEqualTypeOf<AuditResourceType>();
    expectTypeOf<
      Parameters<Parameters<typeof createServiceAuditSink>[0]>[0]['resource_type']
    >().toEqualTypeOf<AuditResourceType>();
    // The names the MCP page and deck tools write.
    expect(COLLAB_AUDIT_RESOURCE).toEqual({ page: 'PAGES', deck: 'SLIDES' });
  });
});
