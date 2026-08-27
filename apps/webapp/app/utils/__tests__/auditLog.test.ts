/**
 * Unit tests for the webapp's audit helpers.
 *
 * Two things are pinned here.
 *
 * 1. WHO an action is attributed to. `addAuditLog` used to resolve the actor
 *    with `findByClassroomAndUser(classroomId, userId)` — the service's
 *    unordered `findFirst`. ClassroomMembership is unique on
 *    (classroom_id, user_id, role), so one person routinely holds several roles
 *    in the same classroom, and that lookup hands back an arbitrary one of
 *    them. An owner's action recorded against their STUDENT row is worse than
 *    no attribution at all, so the helper now resolves the caller's HIGHEST
 *    role through the same resolver the gates use.
 *
 * 2. That an audit write can never turn a COMMITTED mutation into a failed
 *    request. Every route helper here awaits its write so failures are
 *    observable, which only works if the failure is contained.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  resolveHighestMembership: vi.fn(),
  findBySlug: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => mocks.getAuthSession(...a),
  resolveHighestMembership: (...a: unknown[]) => mocks.resolveHighestMembership(...a),
  // Re-exported by helpers.ts for backward compatibility; unused here.
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  requireStudentAccess: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: {
      findBySlug: (...a: unknown[]) => mocks.findBySlug(...a),
    },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    subscription: { getProStateForClassroomId: vi.fn() },
  },
}));

vi.mock('@trigger.dev/sdk', () => ({ runs: { retrieve: vi.fn(), subscribeToRun: vi.fn() } }));

const { addAuditLog, addClassroomAuditLog } = await import('../helpers.ts');

const CLASSROOM = { id: 'class-1', slug: 'cs52-26f' };

const request = () => new Request('http://localhost/admin/cs52-26f/pages');

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthSession.mockResolvedValue({ userId: 'user-1', userLogin: 'prof' });
  mocks.findBySlug.mockResolvedValue(CLASSROOM);
  mocks.auditCreate.mockResolvedValue({ id: 'audit-1' });
});

describe('addAuditLog — actor attribution', () => {
  it('records the caller HIGHEST role for a multi-role user', async () => {
    // The user holds OWNER and STUDENT in this classroom. The row must say
    // OWNER; the old unordered lookup could have said STUDENT.
    mocks.resolveHighestMembership.mockResolvedValue({ id: 'm-owner', role: 'OWNER' });

    await addAuditLog({
      request: request(),
      params: { class: 'cs52-26f' },
      action: 'VIEW',
      resourceType: 'QUIZ_DETAILS',
      resourceId: 'quiz-1',
    });

    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        classroom_id: 'class-1',
        user_id: 'user-1',
        role: 'OWNER',
        resource_type: 'QUIZ_DETAILS',
        resource_id: 'quiz-1',
        action: 'VIEW',
      })
    );
  });

  it('asks the resolver for every role rather than a subset', async () => {
    // `null` roles = consider all four. Passing a subset here would reintroduce
    // the same class of bug from the other end.
    mocks.resolveHighestMembership.mockResolvedValue({ role: 'TEACHER' });

    await addAuditLog({
      request: request(),
      params: { class: 'cs52-26f' },
      action: 'VIEW',
      resourceType: 'PAGES',
    });

    expect(mocks.resolveHighestMembership).toHaveBeenCalledExactlyOnceWith(
      'class-1',
      'user-1',
      null
    );
  });

  it('no longer reaches for the unordered membership lookup', async () => {
    // The regression guard for the original defect: `findByClassroomAndUser`
    // with no roles argument is exactly the arbitrary pick this replaced.
    mocks.resolveHighestMembership.mockResolvedValue({ role: 'OWNER' });

    await addAuditLog({
      request: request(),
      params: { class: 'cs52-26f' },
      action: 'VIEW',
      resourceType: 'PAGES',
    });

    expect(mocks.findByClassroomAndUser).not.toHaveBeenCalled();
  });

  it('writes nothing when there is no session', async () => {
    mocks.getAuthSession.mockResolvedValue(null);

    await addAuditLog({
      request: request(),
      params: { class: 'cs52-26f' },
      action: 'VIEW',
      resourceType: 'PAGES',
    });

    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('swallows a resolution failure instead of rejecting', async () => {
    // Existing callers invoke this without awaiting, so a rejection would
    // surface as an unhandled rejection rather than a failed request.
    mocks.findBySlug.mockRejectedValue(new Error('db down'));

    await expect(
      addAuditLog({
        request: request(),
        params: { class: 'cs52-26f' },
        action: 'VIEW',
        resourceType: 'PAGES',
      })
    ).resolves.toBeUndefined();
  });
});

describe('addClassroomAuditLog — the gate-result variant', () => {
  const entry = {
    classroomId: 'class-1',
    userId: 'user-1',
    role: 'TEACHER',
    action: 'DELETE',
    resourceType: 'PAGES',
    resourceId: 'page-9',
    metadata: { tool: 'web:pages.delete', title: 'Syllabus' },
  };

  it('writes the row exactly as the gate reported it', async () => {
    await addClassroomAuditLog(entry);

    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith({
      classroom_id: 'class-1',
      user_id: 'user-1',
      role: 'TEACHER',
      resource_type: 'PAGES',
      resource_id: 'page-9',
      action: 'DELETE',
      data: { tool: 'web:pages.delete', title: 'Syllabus' },
    });
  });

  it('re-resolves nothing — no session, slug or membership lookup', async () => {
    // The point of this variant: the caller already holds the authorized
    // classroom and the enforcing role, so re-deriving them would cost three
    // queries AND unbind the logged classroom from the authorized one.
    await addClassroomAuditLog(entry);

    expect(mocks.getAuthSession).not.toHaveBeenCalled();
    expect(mocks.findBySlug).not.toHaveBeenCalled();
    expect(mocks.resolveHighestMembership).not.toHaveBeenCalled();
  });

  it('omits data entirely when there is no metadata', async () => {
    await addClassroomAuditLog({ ...entry, metadata: null });

    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ data: expect.anything() })
    );
  });

  it('normalizes a null resourceId rather than dropping the row', async () => {
    await addClassroomAuditLog({ ...entry, resourceId: null });

    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ resource_id: null })
    );
  });

  it('does not reject when the audit write itself fails', async () => {
    // The mutation is already committed by the time this runs. Turning a failed
    // audit row into a 500 would report a successful delete as a failure.
    mocks.auditCreate.mockRejectedValue(new Error('audit table gone'));

    await expect(addClassroomAuditLog(entry)).resolves.toBeUndefined();
  });
});
