/**
 * Unit tests for roster_add_student / roster_remove_student.
 *
 * Security focus: add never trusts a request classroom_id (uses ctx); remove
 * resolves the target from the DB and builds the removal-task payload ENTIRELY
 * server-side (closing the web route's client-supplied `data.user` hole), and
 * refuses unknown / cross-classroom / non-student targets with scopedNotFound.
 * @classmoji/tasks and @trigger.dev/sdk are mocked — no real emails or GitHub.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  addStudents: vi.fn(),
  findByLogin: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  classroomFindById: vi.fn(),
  auditCreate: vi.fn(),
  batchTrigger: vi.fn(),
  taskTrigger: vi.fn(),
}));

// The payload builder is pure and has no dependencies, so the REAL one is used
// here (via its own subpath) rather than a stub — what this file pins is that
// the task payload is the narrowed one.
const { buildRemoveUserPayload } = await import('@classmoji/services/remove-user-payload');

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    roster: { addStudents: (...a: unknown[]) => mocks.addStudents(...a) },
    user: { findByLogin: (...a: unknown[]) => mocks.findByLogin(...a) },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
    classroom: { findById: (...a: unknown[]) => mocks.classroomFindById(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
  buildRemoveUserPayload,
}));

vi.mock('@classmoji/tasks', () => ({
  default: { sendBatchEmailTask: { trigger: (...a: unknown[]) => mocks.batchTrigger(...a) } },
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.taskTrigger(...a) },
}));

const { rosterAddStudentTool, rosterRemoveStudentTool } = await import('../roster.ts');

const CTX: ToolContext = {
  viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'OWNER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'OWNER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.taskTrigger.mockResolvedValue({ id: 'run-1' });
  mocks.batchTrigger.mockResolvedValue(undefined);
});

describe('roster_add_student', () => {
  const ARGS = {
    classroom: 'org/w26',
    students: [{ email: 'a@x.edu', name: 'A' }, { email: 'b@x.edu' }],
  };

  it('adds via the service using ctx classroomId and triggers the returned emails', async () => {
    mocks.addStudents.mockResolvedValue({
      addedExistingUsers: 1,
      invitedNewUsers: 1,
      emails: [{ payload: { to: 'a@x.edu', template: { id: 'roster-added', variables: {} } } }],
    });

    const payload = parse(await rosterAddStudentTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({ added: 1, invited: 1, total: 2 });

    // classroomId comes from ctx, never from args.
    expect(mocks.addStudents).toHaveBeenCalledWith({
      classroomId: 'class-1',
      students: ARGS.students,
    });
    // One batched request for the whole roster, not one per recipient.
    expect(mocks.batchTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.batchTrigger).toHaveBeenCalledWith({
      emails: [{ to: 'a@x.edu', template: { id: 'roster-added', variables: {} } }],
    });
    expect((mocks.auditCreate.mock.calls[0][0] as { action: string }).action).toBe('CREATE');
  });

  it('does not batch-trigger when the service returns no emails', async () => {
    mocks.addStudents.mockResolvedValue({ addedExistingUsers: 0, invitedNewUsers: 0, emails: [] });
    await rosterAddStudentTool.handler(ARGS, CTX);
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });

  it('audits the mutation even if the email trigger fails afterwards', async () => {
    mocks.addStudents.mockResolvedValue({
      addedExistingUsers: 1,
      invitedNewUsers: 0,
      emails: [{ payload: { to: 'a@x.edu', template: { id: 'roster-added', variables: {} } } }],
    });
    mocks.batchTrigger.mockRejectedValue(new Error('trigger down'));

    await expect(rosterAddStudentTool.handler(ARGS, CTX)).rejects.toThrow('trigger down');
    // The audit was written BEFORE the failing email send — mutation not stranded.
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });
});

describe('roster_remove_student', () => {
  const ARGS = { classroom: 'org/w26', student_login: 'alice', confirm: true as const };

  beforeEach(() => {
    mocks.classroomFindById.mockResolvedValue({
      id: 'class-1',
      slug: 'w26',
      git_organization: { id: 'gorg-1', login: 'myorg', provider: 'GITHUB' },
    });
  });

  it('builds the removal payload from DB records (not client input) and fires the task', async () => {
    mocks.findByLogin.mockResolvedValue({ id: 'stu-1', login: 'alice' });
    mocks.findByClassroomAndUser.mockResolvedValue({
      has_accepted_invite: true,
      user: { id: 'stu-1', login: 'alice', name: 'Alice' },
    });

    const payload = parse(await rosterRemoveStudentTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({ success: true, queued: true, login: 'alice' });

    // S1 membership lookup scoped to the ctx classroom + STUDENT role.
    expect(mocks.findByClassroomAndUser).toHaveBeenCalledWith('class-1', 'stu-1', 'STUDENT');

    // The task payload is built entirely server-side.
    const arg = mocks.taskTrigger.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(arg[0]).toBe('remove_user_from_organization');
    expect(arg[1].payload).toMatchObject({
      user: { id: 'stu-1', login: 'alice', has_accepted_invite: true },
      role: 'STUDENT',
    });
    // The classroom id/slug and the git-org fields the provider factory needs.
    expect(arg[1].payload.classroom).toEqual({ id: 'class-1', slug: 'w26' });

    const audit = mocks.auditCreate.mock.calls[0][0] as { action: string; data: { login: string } };
    expect(audit.action).toBe('DELETE');
    expect(audit.data.login).toBe('alice');
  });

  it('sends the task only the fields it reads', async () => {
    // classroom.findById returns the classroom WITH its settings row and its
    // git organization. The task reads the classroom id/slug and the git-org
    // fields the provider factory resolves; run payloads are stored and
    // rendered by the task runner, so nothing else travels with them.
    mocks.classroomFindById.mockResolvedValue({
      id: 'class-1',
      slug: 'w26',
      git_organization: {
        id: 'gorg-1',
        login: 'myorg',
        provider: 'GITHUB',
        access_token: 'glpat-secret',
      },
      settings: { openai_api_key: 'sk-secret', anthropic_api_key: 'sk-ant-secret' },
    });
    mocks.findByLogin.mockResolvedValue({ id: 'stu-1', login: 'alice' });
    mocks.findByClassroomAndUser.mockResolvedValue({
      has_accepted_invite: true,
      user: { id: 'stu-1', login: 'alice', name: 'Alice' },
    });

    await rosterRemoveStudentTool.handler(ARGS, CTX);

    const [, { payload }] = mocks.taskTrigger.mock.calls[0] as [
      string,
      { payload: Record<string, unknown> },
    ];
    expect(Object.keys(payload).sort()).toEqual(['classroom', 'gitOrganization', 'role', 'user']);
    expect(Object.keys(payload.gitOrganization as object).sort()).toEqual([
      'base_url',
      'github_installation_id',
      'id',
      'login',
      'provider',
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/secret/);
  });

  it('refuses an unknown login (scopedNotFound) and never fires the task', async () => {
    mocks.findByLogin.mockResolvedValue(null);
    await expect(rosterRemoveStudentTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.taskTrigger).not.toHaveBeenCalled();
  });

  it('refuses a user who is not a STUDENT in this classroom (S1) and never fires', async () => {
    mocks.findByLogin.mockResolvedValue({ id: 'stu-1', login: 'alice' });
    mocks.findByClassroomAndUser.mockResolvedValue(null); // not a member here
    await expect(rosterRemoveStudentTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.taskTrigger).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('requires student_login or user_id', async () => {
    await expect(
      rosterRemoveStudentTool.handler({ classroom: 'org/w26', confirm: true }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
  });
});
