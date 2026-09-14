/**
 * Unit tests for the owner-side School ID edit on the student drawer (#343).
 * Pins that the write is gated on owning THIS classroom, that the student
 * must be enrolled in it (an outsider's login 404s rather than being edited),
 * and that only the resolved user's school_id is written.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  findStudentByLoginInClassroom: vi.fn(),
  userUpdate: vi.fn(),
  addAuditLog: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
}));
vi.mock('~/utils/helpers', () => ({
  addAuditLog: (...a: unknown[]) => mocks.addAuditLog(...a),
}));
vi.mock('~/utils/helpers.client', () => ({ groupByModule: () => ({}) }));
vi.mock('~/hooks', () => ({ useRouteDrawer: () => ({}), useDarkMode: () => ({}) }));
vi.mock('../SingleStudentView', () => ({ default: () => null }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: {
      findStudentByLoginInClassroom: (...a: unknown[]) => mocks.findStudentByLoginInClassroom(...a),
    },
    user: { update: (...a: unknown[]) => mocks.userUpdate(...a) },
  },
}));

const { action } = await import('../route');

const post = (body: Record<string, unknown>, login = 'stu') =>
  action({
    request: new Request(`http://localhost/admin/cs1/students/${login}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: { class: 'cs1', login },
    context: {},
  } as never) as Promise<Record<string, unknown>>;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.requireClassroomAdmin.mockResolvedValue({ classroom: { id: 'class-1' } });
  mocks.findStudentByLoginInClassroom.mockResolvedValue({ user: { id: 'u-stu' } });
});

describe('admin student drawer action: update-school-id', () => {
  it('is gated on owning the classroom in the URL', async () => {
    mocks.requireClassroomAdmin.mockRejectedValue(new Response(null, { status: 403 }));
    await expect(post({ intent: 'update-school-id', school_id: '1' })).rejects.toBeInstanceOf(
      Response
    );
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('404s for a login not enrolled in this classroom', async () => {
    mocks.findStudentByLoginInClassroom.mockResolvedValue(null);
    await expect(
      post({ intent: 'update-school-id', school_id: '1' }, 'outsider')
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.findStudentByLoginInClassroom).toHaveBeenCalledWith('class-1', 'outsider');
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('writes the trimmed id to the enrolled student and audits it', async () => {
    expect(await post({ intent: 'update-school-id', school_id: ' A123 ' })).toEqual({ ok: true });
    expect(mocks.userUpdate).toHaveBeenCalledWith('u-stu', { school_id: 'A123' });
    expect(mocks.addAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UPDATE', resourceId: 'u-stu' })
    );
  });

  it('refuses an unknown intent and an over-long id', async () => {
    expect(await post({ intent: 'nope' })).toEqual({ error: 'Unknown action.' });
    const result = await post({ intent: 'update-school-id', school_id: 'x'.repeat(65) });
    expect(result.error).toMatch(/64 characters/);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});
