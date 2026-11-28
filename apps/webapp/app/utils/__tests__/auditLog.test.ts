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

import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AuditResourceType } from '@classmoji/services/audit-resource-types';

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  resolveHighestMembership: vi.fn(),
  findBySlug: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  auditCreate: vi.fn(),
  logAuditMiss: vi.fn(),
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
    audit: {
      create: (...a: unknown[]) => mocks.auditCreate(...a),
      logAuditMiss: (...a: unknown[]) => mocks.logAuditMiss(...a),
      record: (row: unknown) =>
        import('../../__tests__/support/auditRecord.ts').then(m =>
          m.recordThrough(r => mocks.auditCreate(r))(row)
        ),
    },
    subscription: { getProStateForClassroomId: vi.fn() },
  },
}));

vi.mock('@trigger.dev/sdk', () => ({ runs: { retrieve: vi.fn(), subscribeToRun: vi.fn() } }));

const { addAuditLog, addClassroomAuditLog } = await import('../helpers.ts');
const { getAuthSession } = await import('@classmoji/auth/server');
const { rememberSessionImpersonator } = await import('@classmoji/auth/request-impersonator');

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
      metadata: { tool: 'web:quiz.view' },
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

  it('names the admin viewing as the user on a loader VIEW row', async () => {
    mocks.resolveHighestMembership.mockResolvedValue({ role: 'OWNER' });
    mocks.getAuthSession.mockResolvedValue({
      userId: 'user-1',
      session: { session: { impersonatedBy: 'admin-1' } },
    });

    await addAuditLog({
      request: request(),
      params: { class: 'cs52-26f' },
      action: 'VIEW',
      resourceType: 'CLASS_GRADES_SCREEN',
      metadata: { tool: 'web:grades.view' },
    });

    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        user_id: 'user-1',
        action: 'VIEW',
        data: { tool: 'web:grades.view', impersonated_by: 'admin-1' },
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
      metadata: { tool: 'web:pages.view' },
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
      metadata: { tool: 'web:pages.view' },
    });

    expect(mocks.findByClassroomAndUser).not.toHaveBeenCalled();
  });

  it('writes nothing when there is no session, and leaves one audit_miss', async () => {
    mocks.getAuthSession.mockResolvedValue(null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAuditLog({
      request: request(),
      params: { class: 'cs52-26f' },
      action: 'VIEW',
      resourceType: 'PAGES',
      resourceId: 'page-1',
      metadata: { tool: 'web:pages.view' },
    });

    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.logAuditMiss).toHaveBeenCalledExactlyOnceWith('no auth session', {
      classroom_slug: 'cs52-26f',
      resource_id: 'page-1',
      resource_type: 'PAGES',
      action: 'VIEW',
      data: { tool: 'web:pages.view' },
    });
    error.mockRestore();
  });

  it('swallows a resolution failure instead of rejecting', async () => {
    // Existing callers invoke this without awaiting, so a rejection would
    // surface as an unhandled rejection rather than a failed request.
    mocks.findBySlug.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAuditLog({
        request: request(),
        params: { class: 'cs52-26f' },
        action: 'VIEW',
        resourceType: 'PAGES',
        metadata: { tool: 'web:pages.view' },
      })
    ).resolves.toBeUndefined();
  });
});

describe('addClassroomAuditLog — the gate-result variant', () => {
  const entry = {
    request: request(),
    classroomId: 'class-1',
    userId: 'user-1',
    role: 'TEACHER',
    action: 'DELETE',
    resourceType: 'PAGES' as const,
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

  it('re-resolves no slug or membership', async () => {
    // The point of this variant: the caller already holds the authorized
    // classroom and the enforcing role, so re-deriving them would cost two
    // queries AND unbind the logged classroom from the authorized one.
    await addClassroomAuditLog({ ...entry, request: request() });

    expect(mocks.findBySlug).not.toHaveBeenCalled();
    expect(mocks.resolveHighestMembership).not.toHaveBeenCalled();
  });

  it("takes the admin from the gate's session read of the same request, without a second read", async () => {
    // What the real getAuthSession does for every request it reads: remember
    // who is viewing as the user, for that Request object.
    mocks.getAuthSession.mockImplementation(async (req: Request) => {
      const authData = { userId: 'user-1', session: { session: { impersonatedBy: 'admin-1' } } };
      rememberSessionImpersonator(req, authData);
      return authData;
    });
    const req = request();
    await getAuthSession(req); // the gate's read

    await addClassroomAuditLog({ ...entry, request: req });

    expect(mocks.getAuthSession).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith({
      classroom_id: 'class-1',
      user_id: 'user-1',
      role: 'TEACHER',
      resource_type: 'PAGES',
      resource_id: 'page-9',
      action: 'DELETE',
      data: { tool: 'web:pages.delete', title: 'Syllabus', impersonated_by: 'admin-1' },
    });
  });

  it('reads the session itself for a request no gate read', async () => {
    mocks.getAuthSession.mockResolvedValue({
      userId: 'user-1',
      session: { session: { impersonatedBy: 'admin-1' } },
    });
    const req = request();

    await addClassroomAuditLog({ ...entry, request: req });

    expect(mocks.getAuthSession).toHaveBeenCalledExactlyOnceWith(req);
    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        user_id: 'user-1',
        data: { tool: 'web:pages.delete', title: 'Syllabus', impersonated_by: 'admin-1' },
      })
    );
  });

  it("names no admin on the user's own session", async () => {
    await addClassroomAuditLog({ ...entry, request: request() });

    expect(mocks.auditCreate.mock.calls[0][0].data).toEqual({
      tool: 'web:pages.delete',
      title: 'Syllabus',
    });
  });

  it('still writes the row, without the admin, when that session read throws, and logs it', async () => {
    mocks.getAuthSession.mockRejectedValue(new Error('session store away'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(addClassroomAuditLog({ ...entry, request: request() })).resolves.toBeUndefined();
    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith({
      classroom_id: 'class-1',
      user_id: 'user-1',
      role: 'TEACHER',
      resource_type: 'PAGES',
      resource_id: 'page-9',
      action: 'DELETE',
      data: { tool: 'web:pages.delete', title: 'Syllabus' },
    });
    expect(mocks.logAuditMiss).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read the session'),
      expect.any(Error)
    );
    error.mockRestore();
  });

  it('normalizes a null resourceId rather than dropping the row', async () => {
    await addClassroomAuditLog({ ...entry, resourceId: null });

    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ resource_id: null })
    );
  });

  it('passes audit.create the row and nothing else', async () => {
    await addClassroomAuditLog(entry);

    expect(mocks.auditCreate.mock.calls[0]).toHaveLength(1);
  });

  it('does not reject when the audit write itself fails', async () => {
    // The mutation is already committed by the time this runs. Turning a failed
    // audit row into a 500 would report a successful delete as a failure.
    mocks.auditCreate.mockRejectedValue(new Error('audit table gone'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(addClassroomAuditLog(entry)).resolves.toBeUndefined();
    // Tried once more, then reported as one audit_miss line.
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    expect(error.mock.calls.filter(c => c[0] === 'audit_miss')).toHaveLength(1);
    error.mockRestore();
  });
});

describe('addAuditLog — nothing before the write rejects', () => {
  it('reports a session lookup that throws and resolves', async () => {
    mocks.getAuthSession.mockRejectedValue(new Error('session store away'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAuditLog({
        request: request(),
        params: { class: 'cs52-26f' },
        action: 'VIEW',
        resourceType: 'CLASS_GRADES_SCREEN',
        metadata: { tool: 'web:grades.view' },
      })
    ).resolves.toBeUndefined();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(mocks.logAuditMiss).toHaveBeenCalledExactlyOnceWith(
      'audit context lookup failed: session store away',
      {
        classroom_slug: 'cs52-26f',
        resource_id: null,
        resource_type: 'CLASS_GRADES_SCREEN',
        action: 'VIEW',
        data: { tool: 'web:grades.view' },
        user_id: null,
      }
    );
    error.mockRestore();
  });

  it('reports a classroom lookup that throws and resolves', async () => {
    mocks.findBySlug.mockRejectedValue(new Error('database away'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAuditLog({
        request: request(),
        params: { class: 'cs52-26f' },
        action: 'VIEW',
        resourceType: 'CLASS_GRADES_SCREEN',
        metadata: { tool: 'web:grades.view' },
      })
    ).resolves.toBeUndefined();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    // The session was resolved before the lookup failed: the line names the user.
    expect(mocks.logAuditMiss).toHaveBeenCalledExactlyOnceWith(
      'audit context lookup failed: database away',
      {
        classroom_slug: 'cs52-26f',
        resource_id: null,
        resource_type: 'CLASS_GRADES_SCREEN',
        action: 'VIEW',
        data: { tool: 'web:grades.view' },
        user_id: 'user-1',
      }
    );
    error.mockRestore();
  });

  it('leaves no audit_miss of its own when the caller resolves', async () => {
    mocks.resolveHighestMembership.mockResolvedValue({ role: 'OWNER' });

    await addAuditLog({
      request: request(),
      params: { class: 'cs52-26f' },
      action: 'VIEW',
      resourceType: 'CLASS_GRADES_SCREEN',
      metadata: { tool: 'web:grades.view' },
    });

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.logAuditMiss).not.toHaveBeenCalled();
  });
});

describe('the resource type a route names', () => {
  it('is the audit vocabulary, in both helpers', () => {
    expectTypeOf<
      Parameters<typeof addClassroomAuditLog>[0]['resourceType']
    >().toEqualTypeOf<AuditResourceType>();
    expectTypeOf<
      Parameters<typeof addAuditLog>[0]['resourceType']
    >().toEqualTypeOf<AuditResourceType>();
  });
});
