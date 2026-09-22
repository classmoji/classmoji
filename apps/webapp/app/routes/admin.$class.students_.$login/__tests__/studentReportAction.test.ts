/**
 * The student report's action owns three writes: the staff note and the
 * letter override (owner and teacher), and the school id (owner only). Every
 * write is bound to the student's membership in THIS classroom, resolved from
 * the URL, never from an id in the body; an outsider's login 404s.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomStaff: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  findStudentByLoginInClassroom: vi.fn(),
  updateInClassroom: vi.fn(),
  userUpdate: vi.fn(),
  addAuditLog: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomStaff: (...a: unknown[]) => mocks.requireClassroomStaff(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));
vi.mock('~/utils/helpers', () => ({
  addAuditLog: (...a: unknown[]) => mocks.addAuditLog(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));
vi.mock('~/components', () => ({ LateOverrideButton: () => null }));
vi.mock('~/components/features/grading/GradeBadges', () => ({ default: () => null }));
vi.mock('~/components/features/assignments/AssignmentsTable', () => ({
  ASSIGNMENT_TYPE_META: {},
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: {
      findStudentByLoginInClassroom: (...a: unknown[]) => mocks.findStudentByLoginInClassroom(...a),
      updateInClassroom: (...a: unknown[]) => mocks.updateInClassroom(...a),
    },
    user: { update: (...a: unknown[]) => mocks.userUpdate(...a) },
  },
}));

const { action } = await import('../route');

const call = (body: Record<string, unknown>) =>
  action({
    request: new Request('http://x/admin/cs101/students/alice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: { class: 'cs101', login: 'alice' },
    context: {},
  } as never);

const enrollment = { id: 'm-1', user: { id: 'u-1' } };

describe('student report action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireClassroomStaff.mockResolvedValue({
      userId: 'staff-1',
      classroom: { id: 'c-1', status: 'ACTIVE' },
      membership: { role: 'TEACHER' },
    });
    mocks.findStudentByLoginInClassroom.mockResolvedValue(enrollment);
    mocks.updateInClassroom.mockResolvedValue({ id: 'm-1' });
  });

  it('saves the staff note on the membership resolved from the URL', async () => {
    const result = await call({ intent: 'update-comment', comment: 'Extension agreed' });
    expect(mocks.updateInClassroom).toHaveBeenCalledWith('m-1', 'c-1', {
      comment: 'Extension agreed',
    });
    expect(result).toEqual({ ok: true, intent: 'update-comment' });
  });

  it('an empty note clears it rather than being rejected', async () => {
    await call({ intent: 'update-comment', comment: '' });
    expect(mocks.updateInClassroom).toHaveBeenCalledWith('m-1', 'c-1', { comment: '' });
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ cleared: true }) })
    );
  });

  it('never records the note text in the audit trail', async () => {
    await call({ intent: 'update-comment', comment: 'private' });
    const entry = mocks.addClassroomAuditLog.mock.calls[0][0] as {
      metadata: Record<string, unknown>;
    };
    expect(JSON.stringify(entry.metadata)).not.toContain('private');
  });

  it('sets and clears the letter override', async () => {
    await call({ intent: 'update-letter-grade', letter_grade: 'A' });
    expect(mocks.updateInClassroom).toHaveBeenCalledWith('m-1', 'c-1', { letter_grade: 'A' });
    await call({ intent: 'update-letter-grade', letter_grade: null });
    expect(mocks.updateInClassroom).toHaveBeenLastCalledWith('m-1', 'c-1', { letter_grade: null });
  });

  it('lets the owner change the school id, on the user row', async () => {
    mocks.requireClassroomStaff.mockResolvedValue({
      userId: 'owner-1',
      classroom: { id: 'c-1', status: 'ACTIVE' },
      membership: { role: 'OWNER' },
    });
    await call({ intent: 'update-school-id', school_id: ' 12345 ' });
    expect(mocks.userUpdate).toHaveBeenCalledWith('u-1', { school_id: '12345' });
  });

  it('refuses a school id change from a teacher', async () => {
    await expect(call({ intent: 'update-school-id', school_id: '1' })).rejects.toMatchObject({
      status: 403,
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('404s for a login that is not a student of this classroom', async () => {
    mocks.findStudentByLoginInClassroom.mockResolvedValue(null);
    await expect(call({ intent: 'update-comment', comment: 'x' })).rejects.toMatchObject({
      status: 404,
    });
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });

  it('rejects an unknown intent', async () => {
    expect(await call({ intent: 'nope' })).toEqual({ error: 'Unknown action.' });
  });
});
