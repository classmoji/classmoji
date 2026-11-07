/**
 * The activity log's one-line text for View as rows: the admin app's own
 * request row, the auth server's start and end rows, and the rows written
 * before the server recorded View as.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('~/utils/db.server', () => ({ prisma: {} }));

const { describeAdminAction } = await import('../metrics.server.ts');

describe('describeAdminAction: View as', () => {
  it('describes a row from before the server recorded View as as it always did', () => {
    expect(describeAdminAction('impersonate', { targetName: 'Ada', classroomName: 'CS 1' })).toBe(
      'viewed as Ada in CS 1'
    );
  });

  it('describes the request, the start and each way it ends', () => {
    expect(
      describeAdminAction('impersonate.request', { targetName: 'Ada', classroomName: 'CS 1' })
    ).toBe('asked to view as Ada in CS 1');
    expect(describeAdminAction('impersonate.start', { targetName: 'Ada' })).toBe(
      'started viewing as Ada'
    );
    expect(
      describeAdminAction('impersonate.end', {
        targetName: 'Ada',
        path: '/admin/stop-impersonating',
      })
    ).toBe('stopped viewing as Ada');
    expect(describeAdminAction('impersonate.end', { targetName: 'Ada', path: '/sign-out' })).toBe(
      'signed out while viewing as Ada'
    );
    expect(
      describeAdminAction('impersonate.end', { targetName: 'Ada', path: '/get-session' })
    ).toBe('stopped viewing as Ada (the session ended)');
  });

  it('falls back to "someone" without a name', () => {
    expect(describeAdminAction('impersonate.start', null)).toBe('started viewing as someone');
  });
});
