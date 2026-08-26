/**
 * Unit tests for staff_add / staff_update / staff_remove.
 *
 * Security focus: the classroomId handed to every service call comes from the
 * ToolContext, never from args; granting OWNER — full control of the classroom,
 * including deleting it — cannot happen without an explicit confirm; the
 * service's caller-fixable failures map onto the right ToolError kinds (an
 * unknown/foreign staff member is the uniform scopedNotFound, so a probe cannot
 * enumerate another classroom's staff); and no mutation is left un-audited —
 * while the no-op "already holds that role" path, which mutates nothing, writes
 * no audit row. Every audit row carries the ROLE, which is the point of the
 * record.
 *
 * `@classmoji/services` is mocked (factory idiom) INCLUDING StaffServiceError,
 * so the handlers' `instanceof` mapping runs against the same class the test
 * throws — no real GitHub invites and no Trigger.dev runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  addStaff: vi.fn(),
  updateStaff: vi.fn(),
  removeStaff: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => {
  // Same shape as the real service error; the tools branch on `instanceof`, so
  // the class the handler imports must be the class the test constructs.
  class StaffServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'StaffServiceError';
      this.code = code;
    }
  }
  return {
    StaffServiceError,
    ClassmojiService: {
      staff: {
        addStaff: (...a: unknown[]) => mocks.addStaff(...a),
        updateStaff: (...a: unknown[]) => mocks.updateStaff(...a),
        removeStaff: (...a: unknown[]) => mocks.removeStaff(...a),
      },
      audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    },
  };
});

const { StaffServiceError } = await import('@classmoji/services');
const {
  staffAddTool,
  staffUpdateTool,
  staffRemoveTool,
  staffAddArgsSchema,
  staffRemoveArgsSchema,
} = await import('../staff.ts');

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

/** The audit row the handler wrote (first call). */
function auditRow() {
  return mocks.auditCreate.mock.calls[0][0] as {
    action: string;
    classroom_id: string;
    resource_type: string;
    resource_id?: string | null;
    data: Record<string, unknown>;
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe('staff_add', () => {
  const ARGS = {
    classroom: 'org/w26',
    login: 'ta-ann',
    role: 'ASSISTANT' as const,
    name: 'Ann',
    email: 'ann@x.edu',
  };

  it('adds via the service using ctx classroomId and reports the pending org invite', async () => {
    mocks.addStaff.mockResolvedValue({
      created: true,
      alreadyExists: false,
      userId: 'ta-1',
      login: 'ta-ann',
      name: 'Ann',
      role: 'ASSISTANT',
      alreadyOrgMember: false,
    });

    const payload = parse(await staffAddTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      created: true,
      already_exists: false,
      login: 'ta-ann',
      user_id: 'ta-1',
      role: 'ASSISTANT',
      github: 'invited',
      invite_pending: true,
    });
    // Allow-list the response shape: the service result carries more than this
    // (alreadyExists, alreadyOrgMember...), so pin the exact keys rather than
    // letting an internal field ride along into the tool surface unnoticed.
    expect(Object.keys(payload).sort()).toEqual([
      'already_exists',
      'created',
      'github',
      'invite_pending',
      'login',
      'message',
      'name',
      'role',
      'success',
      'user_id',
    ]);

    // classroomId comes from ctx, never from args.
    expect(mocks.addStaff).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ta-ann',
      role: 'ASSISTANT',
      name: 'Ann',
      email: 'ann@x.edu',
    });

    const audit = auditRow();
    expect(audit.action).toBe('CREATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_type).toBe('STAFF');
    expect(audit.resource_id).toBe('ta-1');
    expect(audit.data).toMatchObject({
      tool: 'staff_add',
      login: 'ta-ann',
      role: 'ASSISTANT',
    });
  });

  it.each(['TEACHER', 'OWNER'] as const)(
    'passes role %s through to the service and records it in the audit row',
    async role => {
      mocks.addStaff.mockResolvedValue({
        created: true,
        alreadyExists: false,
        userId: 'u-9',
        login: 'pat',
        name: 'Pat',
        role,
        alreadyOrgMember: false,
      });

      const payload = parse(
        await staffAddTool.handler(
          { classroom: 'org/w26', login: 'pat', role, confirm: true as const },
          CTX
        )
      );

      expect(mocks.addStaff).toHaveBeenCalledWith(
        expect.objectContaining({ classroomId: 'class-1', login: 'pat', role })
      );
      expect(payload).toMatchObject({ success: true, created: true, role });
      // The role is the whole point of the record.
      expect(auditRow().data).toMatchObject({ tool: 'staff_add', role });
    }
  );

  it('reports a team add (no pending invite) when they were already in the org', async () => {
    mocks.addStaff.mockResolvedValue({
      created: true,
      alreadyExists: false,
      userId: 'ta-1',
      login: 'ta-ann',
      name: 'Ann',
      role: 'ASSISTANT',
      alreadyOrgMember: true,
    });

    const payload = parse(await staffAddTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({ github: 'team_added', invite_pending: false });
  });

  it('is idempotent per role: an existing membership is a no-op and writes NO audit row', async () => {
    mocks.addStaff.mockResolvedValue({
      created: false,
      alreadyExists: true,
      userId: 'ta-1',
      login: 'ta-ann',
      name: 'Ann',
      role: 'ASSISTANT',
      alreadyOrgMember: true,
    });

    const payload = parse(await staffAddTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      created: false,
      already_exists: true,
      role: 'ASSISTANT',
    });
    // The no-op path reports no GitHub outcome — there was none.
    expect(Object.keys(payload).sort()).toEqual([
      'already_exists',
      'created',
      'login',
      'message',
      'role',
      'success',
      'user_id',
    ]);
    // Nothing was mutated (the service short-circuits before any write), so
    // there is no mutation to audit.
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps git_user_not_found to a not_found error and audits nothing', async () => {
    mocks.addStaff.mockRejectedValue(
      new StaffServiceError('git_user_not_found', '[staff] git user nope not found')
    );

    await expect(staffAddTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'GitHub user not found',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps no_org_configured to invalid_params', async () => {
    mocks.addStaff.mockRejectedValue(
      new StaffServiceError('no_org_configured', '[staff] no git organization')
    );

    await expect(staffAddTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
  });

  it('maps login_conflict to invalid_params with a neutral message', async () => {
    mocks.addStaff.mockRejectedValue(
      new StaffServiceError('login_conflict', '[staff] login resolves elsewhere')
    );

    await expect(staffAddTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: 'This login is associated with a different account — contact support',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('carries a tighter rate-limit bucket than the default (each call can invite)', () => {
    expect(staffAddTool.rateLimit).toEqual({ capacity: 5, refillPerSecond: 0.05 });
  });

  it('lets an unexpected service failure through for the generic wrapper', async () => {
    mocks.addStaff.mockRejectedValue(new Error('boom'));
    await expect(staffAddTool.handler(ARGS, CTX)).rejects.toThrow('boom');
  });

  describe('the OWNER confirm gate', () => {
    const base = { classroom: 'org/w26', login: 'pat' };

    it('requires confirm:true in the schema when — and only when — role is OWNER', () => {
      // Granting OWNER hands over full control of the classroom, including
      // deleting it, so it must be an explicit act. Every other role is
      // unaffected: the field is optional for them.
      expect(staffAddArgsSchema.safeParse({ ...base, role: 'OWNER' }).success).toBe(false);
      expect(staffAddArgsSchema.safeParse({ ...base, role: 'OWNER', confirm: true }).success).toBe(
        true
      );
      expect(staffAddArgsSchema.safeParse({ ...base, role: 'ASSISTANT' }).success).toBe(true);
      expect(staffAddArgsSchema.safeParse({ ...base, role: 'TEACHER' }).success).toBe(true);
      // confirm on a non-OWNER role is harmless, never required.
      expect(
        staffAddArgsSchema.safeParse({ ...base, role: 'ASSISTANT', confirm: true }).success
      ).toBe(true);
    });

    it('refuses an OWNER grant with no confirm before calling the service', async () => {
      await expect(
        staffAddTool.handler({ ...base, role: 'OWNER' } as never, CTX)
      ).rejects.toMatchObject({ kind: 'invalid_params' });
      expect(mocks.addStaff).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    });
  });
});

describe('staff_update', () => {
  const ARGS = {
    classroom: 'org/w26',
    login: 'ta-ann',
    role: 'ASSISTANT' as const,
    is_grader: true,
  };

  it('flips is_grader via the service using ctx classroomId and audits the update', async () => {
    mocks.updateStaff.mockResolvedValue({ id: 'm-2', user_id: 'ta-1', is_grader: true });

    const payload = parse(await staffUpdateTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      login: 'ta-ann',
      role: 'ASSISTANT',
      is_grader: true,
    });
    // Allow-list: the membership row the service returns must not leak out.
    expect(Object.keys(payload).sort()).toEqual(['is_grader', 'login', 'role', 'success']);

    expect(mocks.updateStaff).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ta-ann',
      role: 'ASSISTANT',
      isGrader: true,
    });

    const audit = auditRow();
    expect(audit.action).toBe('UPDATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_type).toBe('STAFF');
    // resource_id names the updated staff member; it is also part of the audit
    // dedup key, so two updates to DIFFERENT people stay two rows.
    expect(audit.resource_id).toBe('ta-1');
    expect(audit.data).toMatchObject({
      tool: 'staff_update',
      user_id: 'ta-1',
      role: 'ASSISTANT',
      is_grader: true,
    });
  });

  it('updates a TEACHER membership the same way', async () => {
    mocks.updateStaff.mockResolvedValue({ id: 'm-3', user_id: 'u-9', is_grader: true });

    const payload = parse(
      await staffUpdateTool.handler({ ...ARGS, login: 'pat', role: 'TEACHER' }, CTX)
    );

    expect(mocks.updateStaff).toHaveBeenCalledWith(
      expect.objectContaining({ login: 'pat', role: 'TEACHER', isGrader: true })
    );
    expect(payload).toMatchObject({ success: true, role: 'TEACHER', is_grader: true });
  });

  it('maps the OWNER grader-flag rejection to invalid_params with the reason', async () => {
    mocks.updateStaff.mockRejectedValue(
      new StaffServiceError('grader_flag_invalid', '[staff] is_grader applies to ASSISTANT/TEACHER')
    );

    await expect(staffUpdateTool.handler({ ...ARGS, role: 'OWNER' }, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message:
        'is_grader applies to ASSISTANT and TEACHER only — owners do not join the grading pool',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses someone who does not hold that role here (uniform scopedNotFound)', async () => {
    mocks.updateStaff.mockRejectedValue(
      new StaffServiceError('staff_not_found', '[staff] not an assistant')
    );

    await expect(staffUpdateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Staff member not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('staff_remove', () => {
  const ARGS = {
    classroom: 'org/w26',
    login: 'ta-ann',
    role: 'ASSISTANT' as const,
    confirm: true as const,
  };

  it('queues the removal without waiting for the run and audits the DELETE', async () => {
    mocks.removeStaff.mockResolvedValue({
      userId: 'ta-1',
      login: 'ta-ann',
      role: 'ASSISTANT',
      runId: 'run-1',
    });

    const payload = parse(await staffRemoveTool.handler(ARGS, CTX));
    // queued:true — the service awaited the ENQUEUE only; unlike the web route
    // we never waitForRunCompletion, and the run id is not surfaced.
    expect(payload).toMatchObject({
      success: true,
      queued: true,
      login: 'ta-ann',
      user_id: 'ta-1',
      role: 'ASSISTANT',
    });
    // Allow-list: run_id in particular must NOT be here — the run is an
    // internal handle the caller has no way to poll.
    expect(Object.keys(payload).sort()).toEqual([
      'login',
      'message',
      'queued',
      'role',
      'success',
      'user_id',
    ]);

    expect(mocks.removeStaff).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ta-ann',
      role: 'ASSISTANT',
    });

    const audit = auditRow();
    expect(audit.action).toBe('DELETE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_type).toBe('STAFF');
    expect(audit.resource_id).toBe('ta-1');
    expect(audit.data).toMatchObject({
      tool: 'staff_remove',
      login: 'ta-ann',
      role: 'ASSISTANT',
    });
  });

  it.each(['ASSISTANT', 'TEACHER', 'OWNER'] as const)(
    'passes role %s through to the service and records it in the audit row',
    async role => {
      mocks.removeStaff.mockResolvedValue({
        userId: 'u-9',
        login: 'pat',
        role,
        runId: 'run-2',
      });

      const payload = parse(await staffRemoveTool.handler({ ...ARGS, login: 'pat', role }, CTX));

      // The requested role reaches the service — it is what decides WHICH
      // membership row of a multi-role user is removed.
      expect(mocks.removeStaff).toHaveBeenCalledWith({
        classroomId: 'class-1',
        login: 'pat',
        role,
      });
      expect(payload).toMatchObject({ success: true, queued: true, role });
      // The role is the whole point of the record.
      expect(auditRow().data).toMatchObject({ tool: 'staff_remove', login: 'pat', role });
    }
  );

  it('refuses an unknown / cross-classroom staff member and audits nothing', async () => {
    mocks.removeStaff.mockRejectedValue(
      new StaffServiceError('staff_not_found', '[staff] user nope not found')
    );

    await expect(staffRemoveTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Staff member not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps last_owner to invalid_params naming the reason', async () => {
    // The service refuses BEFORE queueing anything, so this is a real refusal
    // and not a failure that would have surfaced inside the background task.
    mocks.removeStaff.mockRejectedValue(
      new StaffServiceError('last_owner', '[staff] ada is the only owner')
    );

    await expect(staffRemoveTool.handler({ ...ARGS, role: 'OWNER' }, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message:
        'This is the only owner of the classroom — add another owner before removing this one',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('requires confirm:true in the schema (destructive gate)', () => {
    // The registry validates inputSchema before the handler runs, so the gate
    // lives in the schema: only the literal `true` is accepted.
    const confirm = staffRemoveTool.inputSchema.confirm;
    expect(confirm.safeParse(true).success).toBe(true);
    expect(confirm.safeParse(false).success).toBe(false);
    expect(confirm.safeParse(undefined).success).toBe(false);
  });

  it.each([false, undefined, 'yes'])(
    're-checks confirm in the handler as well (%s never reaches the service)',
    async confirm => {
      // Same belt-and-braces as staff_add: the gate is enforced by the handler
      // itself, not only by the validation the SDK runs ahead of it.
      await expect(
        staffRemoveTool.handler({ ...ARGS, confirm } as never, CTX)
      ).rejects.toMatchObject({ kind: 'invalid_params' });
      expect(mocks.removeStaff).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it('carries the same tight rate-limit bucket as staff_add (each call can revoke org access)', () => {
    expect(staffRemoveTool.rateLimit).toEqual({ capacity: 5, refillPerSecond: 0.05 });
  });

  it('accepts only the three staff roles in the exported schema', () => {
    const base = { classroom: 'org/w26', login: 'pat', confirm: true };
    for (const role of ['ASSISTANT', 'TEACHER', 'OWNER']) {
      expect(staffRemoveArgsSchema.safeParse({ ...base, role }).success).toBe(true);
    }
    expect(staffRemoveArgsSchema.safeParse({ ...base, role: 'STUDENT' }).success).toBe(false);
  });

  it('accepts only the three staff roles (never STUDENT)', () => {
    const role = staffRemoveTool.inputSchema.role;
    for (const value of ['ASSISTANT', 'TEACHER', 'OWNER']) {
      expect(role.safeParse(value).success).toBe(true);
    }
    expect(role.safeParse('STUDENT').success).toBe(false);
  });
});
