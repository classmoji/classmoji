/**
 * The "Add Students" action: the roster service records each add (CLAUDE.md
 * rule 2) for the owner the gate resolved (with the admin viewing as them),
 * bound to the classroom the caller was authorized for, before the route sends
 * the emails; the route writes no row of its own. And a message that counts
 * students already in the class apart from the ones just added (#372). The
 * roster service is mocked: its own tests pin the transaction, the
 * already-enrolled lookup and the row.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addStudents: vi.fn(),
  batchTrigger: vi.fn(),
  taskTrigger: vi.fn(),
  requestImpersonator: vi.fn(),
}));

vi.mock('@classmoji/auth/request-impersonator', () => ({
  requestImpersonator: (...a: unknown[]) => mocks.requestImpersonator(...a),
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
  invalid: [],
  emails: [],
  activations: [],
  audit: { written: 1, missed: 0 },
  ...over,
});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'class-1', slug: 'cs-1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.requestImpersonator.mockResolvedValue(null);
});

describe('add students action', () => {
  it('hands the service the owner for the row of the authorized classroom, before the emails', async () => {
    const order: string[] = [];
    mocks.addStudents.mockImplementation(async () => {
      order.push('add (and its row)');
      return result({
        addedExistingUsers: 1,
        invitedNewUsers: 1,
        alreadyEnrolled: ['in@x.edu'],
        emails: [{ payload: { to: 'a@x.edu' } }, { payload: { to: 'b@x.edu' } }],
      });
    });
    mocks.batchTrigger.mockImplementation(async () => order.push('emails'));

    await run([{ email: 'a@x.edu' }, { email: 'b@x.edu' }, { email: 'in@x.edu' }]);

    expect(mocks.addStudents).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomId: 'class-1',
        actor: { userId: 'owner-1', role: 'OWNER', tool: 'web:students.add', impersonatedBy: null },
      })
    );
    expect(order).toEqual(['add (and its row)', 'emails']);
  });

  it('under View as, the actor names the admin', async () => {
    mocks.requestImpersonator.mockResolvedValue('admin-1');
    mocks.addStudents.mockResolvedValue(result({ addedExistingUsers: 1 }));
    await run([{ email: 'a@x.edu' }]);
    expect(mocks.addStudents.mock.calls[0][0].actor).toEqual({
      userId: 'owner-1',
      role: 'OWNER',
      tool: 'web:students.add',
      impersonatedBy: 'admin-1',
    });
  });

  it('a row the service could not write changes nothing the owner is told', async () => {
    mocks.addStudents.mockResolvedValue(
      result({ addedExistingUsers: 1, audit: { written: 0, missed: 1 } })
    );
    expect(await run([{ email: 'a@x.edu' }])).toEqual({
      action: 'ADD_STUDENTS',
      success: '1 student invited to the class.',
    });
  });

  it('sends nothing when the roster write fails', async () => {
    mocks.addStudents.mockRejectedValue(new Error('invite write failed'));
    await expect(run([{ email: 'a@x.edu' }])).rejects.toThrow('invite write failed');
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

  it('names the addresses the server refused as undeliverable', async () => {
    mocks.addStudents.mockResolvedValue(
      result({ invitedNewUsers: 1, invalid: ['krishna@gmail.co.'] })
    );
    expect(await run([{ email: 'a@x.edu' }, { email: 'krishna@gmail.co.' }])).toMatchObject({
      success: '1 student invited to the class. Skipped 1 invalid email: krishna@gmail.co.',
    });
  });
});
