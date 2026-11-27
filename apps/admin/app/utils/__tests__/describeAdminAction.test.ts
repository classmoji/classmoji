/**
 * The activity log's one-line text for View as rows: the admin app's own
 * request row, the auth server's start and end rows, and the rows written
 * before the server recorded View as.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('~/utils/db.server', () => ({ prisma: {} }));

const { adminReason, describeAdminAction, systemActorName } = await import('../metrics.server.ts');

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

  it('says who ended it when it was not the admin', () => {
    expect(
      describeAdminAction('impersonate.end', {
        targetName: 'Ada',
        path: '/revoke-sessions',
        endedBy: 'user',
      })
    ).toBe('was viewing as Ada until Ada ended the session');
    expect(
      describeAdminAction('impersonate.end', {
        targetName: 'Ada',
        path: '/email-otp/reset-password',
        endedBy: 'user',
      })
    ).toBe('was viewing as Ada until Ada ended the session');
    expect(
      describeAdminAction('impersonate.end', {
        targetName: 'Ada',
        path: '/get-session',
        endedBy: 'system',
      })
    ).toBe('was viewing as Ada until the session expired');
    // An expired row removed by a stop is the expiry, not the stop.
    expect(
      describeAdminAction('impersonate.end', {
        targetName: 'Ada',
        path: '/admin/stop-impersonating',
        endedBy: 'system',
      })
    ).toBe('was viewing as Ada until the session expired');
  });

  it('describes an end by the admin by its path', () => {
    expect(
      describeAdminAction('impersonate.end', {
        targetName: 'Ada',
        path: '/admin/stop-impersonating',
        endedBy: 'admin',
      })
    ).toBe('stopped viewing as Ada');
    expect(
      describeAdminAction('impersonate.end', {
        targetName: 'Ada',
        path: '/sign-out',
        endedBy: 'admin',
      })
    ).toBe('signed out while viewing as Ada');
    expect(
      describeAdminAction('impersonate.end', {
        targetName: 'Ada',
        path: '/other',
        endedBy: 'admin',
      })
    ).toBe('stopped viewing as Ada');
    expect(
      describeAdminAction('impersonate.end', { targetName: 'Ada', path: '/other', endedBy: null })
    ).toBe('stopped viewing as Ada (the session ended)');
  });

  it('falls back to "someone" without a name', () => {
    expect(describeAdminAction('impersonate.start', null)).toBe('started viewing as someone');
  });
});

describe('describeAdminAction: classroom deletions', () => {
  const deleted = {
    slug: 'cs-1-26f',
    name: 'CS 1',
    git_organization: 'school-org',
    provider: 'GITHUB',
    counts: { audit_rows: 120, members: 30, assignments: 8 },
  };

  it("names an owner's delete by the classroom's slug", () => {
    expect(describeAdminAction('classroom.delete', deleted)).toBe('deleted classroom cs-1-26f');
  });

  it('says when the delete undid a create that did not finish', () => {
    expect(describeAdminAction('classroom.delete', { ...deleted, reason: 'create_rollback' })).toBe(
      'removed classroom cs-1-26f when creating it did not finish'
    );
  });

  it('falls back to the name, then to "a classroom"', () => {
    expect(describeAdminAction('classroom.delete', { name: 'CS 1' })).toBe(
      'deleted classroom CS 1'
    );
    expect(describeAdminAction('classroom.delete', null)).toBe('deleted a classroom');
  });

  it('counts the sandboxes a sweep removed', () => {
    expect(
      describeAdminAction('classroom.delete_sandboxes', { classrooms: 3, audit_rows: 41 })
    ).toBe('removed 3 sandbox classrooms');
    expect(
      describeAdminAction('classroom.delete_sandboxes', { classrooms: 1, audit_rows: 0 })
    ).toBe('removed 1 sandbox classroom');
  });

  it('names the schedule as the actor of a sweep, and no one else', () => {
    expect(systemActorName('classroom.delete_sandboxes')).toBe('Daily cleanup');
    expect(systemActorName('classroom.delete')).toBeNull();
    expect(systemActorName('impersonate.start')).toBeNull();
  });

  it("does not show a delete's reason code as a typed reason", () => {
    expect(adminReason('classroom.delete', { ...deleted, reason: 'create_rollback' })).toBeNull();
    expect(adminReason('impersonate.request', { reason: 'support ticket' })).toBe('support ticket');
    expect(adminReason('impersonate.request', {})).toBeNull();
  });
});
