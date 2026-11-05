/**
 * The "Add Students" action: one audit row per add (CLAUDE.md rule 2), bound
 * to the classroom the caller was authorized for, written before the emails
 * go out; and a message that counts students already in the class apart from
 * the ones just added (#372). The roster service is mocked: its own tests pin
 * the transaction and the already-enrolled lookup.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addStudents: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  batchTrigger: vi.fn(),
  taskTrigger: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    roster: { addStudents: (...a: unknown[]) => mocks.addStudents(...a) },
  },
}));

vi.mock('@classmoji/auth/invite-token', () => ({ signInviteToken: () => 'tok' }));

vi.mock('@classmoji/tasks', () => ({
  default: { sendBatchEmailTask: { trigger: (...a: unknown[]) => mocks.batchTrigger(...a) } },
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.taskTrigger(...a) },
}));

vi.mock('~/utils/helpers', () => ({
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

const { action } = await import('../action.ts');

const run = (students: Array<{ email: string; name?: string }>) =>
  (action as unknown as (args: { params: object; request: Request }) => Promise<unknown>)({
    params: { class: 'cs-1' },
    request: new Request('http://localhost/admin/cs-1/students/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ students }),
    }),
  });

const result = (over: Record<string, unknown> = {}) => ({
  addedExistingUsers: 0,
  invitedNewUsers: 0,
  alreadyEnrolled: [],
  emails: [],
  activations: [],
  ...over,
});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'class-1', slug: 'cs-1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
});

describe('add students action', () => {
  it('writes one audit row for the authorized classroom, before the emails', async () => {
    const order: string[] = [];
    mocks.addClassroomAuditLog.mockImplementation(async () => order.push('audit'));
    mocks.batchTrigger.mockImplementation(async () => order.push('emails'));
    mocks.addStudents.mockResolvedValue(
      result({
        addedExistingUsers: 1,
        invitedNewUsers: 1,
        alreadyEnrolled: ['in@x.edu'],
        emails: [{ payload: { to: 'a@x.edu' } }, { payload: { to: 'b@x.edu' } }],
      })
    );

    await run([{ email: 'a@x.edu' }, { email: 'b@x.edu' }, { email: 'in@x.edu' }]);

    expect(mocks.addStudents).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: 'class-1' })
    );
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.addClassroomAuditLog.mock.calls[0][0]).toEqual({
      classroomId: 'class-1',
      userId: 'owner-1',
      role: 'OWNER',
      action: 'CREATE',
      resourceType: 'STUDENT_ROSTER',
      metadata: { tool: 'web:students.add', added: 1, invited: 1, already_enrolled: 1 },
    });
    expect(order).toEqual(['audit', 'emails']);
  });

  it('writes no audit row and sends nothing when the roster write fails', async () => {
    mocks.addStudents.mockRejectedValue(new Error('invite write failed'));
    await expect(run([{ email: 'a@x.edu' }])).rejects.toThrow('invite write failed');
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });

  it('counts only the students it added', async () => {
    mocks.addStudents.mockResolvedValue(result({ addedExistingUsers: 1, invitedNewUsers: 2 }));
    expect(await run([{ email: 'a@x.edu' }, { email: 'b@x.edu' }, { email: 'c@x.edu' }])).toEqual({
      action: 'ADD_STUDENTS',
      success: '3 students invited to the class.',
    });
  });

  it('says how many were already in the class', async () => {
    mocks.addStudents.mockResolvedValue(
      result({ invitedNewUsers: 1, alreadyEnrolled: ['in@x.edu', 'in2@x.edu'] })
    );
    expect(
      await run([{ email: 'a@x.edu' }, { email: 'in@x.edu' }, { email: 'in2@x.edu' }])
    ).toMatchObject({ success: '1 student invited to the class. 2 already in the class.' });
  });

  it('says only that when everyone was already in the class', async () => {
    mocks.addStudents.mockResolvedValue(result({ alreadyEnrolled: ['in@x.edu'] }));
    expect(await run([{ email: 'in@x.edu' }])).toMatchObject({
      success: '1 already in the class.',
    });
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });
});
