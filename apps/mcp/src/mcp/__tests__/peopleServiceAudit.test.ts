/**
 * The people tools, through the registry: the shared services write the audit
 * row of each change (staff add, update and removal; the roster add), so a
 * tool passes the caller as the actor (`serviceActor`: the enforcing role, its
 * tool name, `via: 'mcp'`, the client, the admin under View as) and writes no
 * row of its own. When the service reports a row it owed but could not write,
 * the call answers as it would have, plus `audit_incomplete: true`; a call
 * that owed no row carries no such field. roster_remove_student still records
 * the request itself and hands its actor to the removal run, which records the
 * completed removal.
 *
 * The real tools run on a real McpServer over the SDK's in-memory transport,
 * with `@classmoji/services` faked, as in serviceAudit.test.ts.
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../registry.ts';

const mocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  classroomFindAll: vi.fn(),
  classroomFindById: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  findByGitUsername: vi.fn(),
  addStaff: vi.fn(),
  updateStaff: vi.fn(),
  startStaffRemoval: vi.fn(),
  settleUngradedSlots: vi.fn(),
  recordStaffRemoval: vi.fn(),
  recordLeftoverSettled: vi.fn(),
  previewLeftoverSlots: vi.fn(),
  countStrandedSlots: vi.fn(),
  waitForRunOutcome: vi.fn(),
  addStudents: vi.fn(),
  taskTrigger: vi.fn(),
  emailTrigger: vi.fn(),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

const { buildRemoveUserPayload } = await import('@classmoji/services/remove-user-payload');

vi.mock('@classmoji/services', () => {
  class StaffServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    StaffServiceError,
    buildRemoveUserPayload,
    waitForRunOutcome: (...a: unknown[]) => mocks.waitForRunOutcome(...a),
    HelperService: {
      startStaffRemoval: (...a: unknown[]) => mocks.startStaffRemoval(...a),
      settleUngradedSlots: (...a: unknown[]) => mocks.settleUngradedSlots(...a),
    },
    ClassmojiService: {
      audit: {
        create: (...a: unknown[]) => mocks.auditCreate(...a),
        record: (row: unknown) =>
          import('../../__tests__/support/auditRecord.ts').then(m =>
            m.recordThrough(r => mocks.auditCreate(r))(row)
          ),
      },
      classroom: {
        findAll: (...a: unknown[]) => mocks.classroomFindAll(...a),
        findById: (...a: unknown[]) => mocks.classroomFindById(...a),
        getClassroomForUI: (c: unknown) => c,
        getTimeZone: async () => null,
      },
      classroomMembership: {
        findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
      },
      user: { findByGitUsername: (...a: unknown[]) => mocks.findByGitUsername(...a) },
      staff: {
        addStaff: (...a: unknown[]) => mocks.addStaff(...a),
        updateStaff: (...a: unknown[]) => mocks.updateStaff(...a),
        recordStaffRemoval: (...a: unknown[]) => mocks.recordStaffRemoval(...a),
        recordLeftoverSettled: (...a: unknown[]) => mocks.recordLeftoverSettled(...a),
        previewLeftoverSlots: (...a: unknown[]) => mocks.previewLeftoverSlots(...a),
        countStrandedSlots: (...a: unknown[]) => mocks.countStrandedSlots(...a),
      },
      roster: { addStudents: (...a: unknown[]) => mocks.addStudents(...a) },
    },
  };
});

vi.mock('@classmoji/tasks', () => ({
  default: { sendBatchEmailTask: { trigger: (...a: unknown[]) => mocks.emailTrigger(...a) } },
}));
vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.taskTrigger(...a) },
}));

const staff = await import('../../tools/staff.ts');
const roster = await import('../../tools/roster.ts');
const { buildMcpServer, registerToolDefinition } = await import('../registry.ts');
const { resetRateLimits } = await import('../rateLimit.ts');
const { setPrismaRows, resetPrismaStub } = await import('../../__tests__/prismaSchemaStub.ts');

const CLIENT = 'people-audit-test';
const STUDENT = '55555555-5555-4555-8555-555555555555';

const WRITTEN = { written: 1, missed: 0 };
const MISSED = { written: 0, missed: 1 };
const NONE = { written: 0, missed: 0 };

beforeAll(() => {
  for (const def of [
    staff.staffAddTool,
    staff.staffUpdateTool,
    staff.staffRemoveTool,
    roster.rosterAddStudentTool,
    roster.rosterRemoveStudentTool,
  ]) {
    registerToolDefinition(def as unknown as ToolDefinition<never>);
  }
});

let viewerSeq = 0;
let userId = '';

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  resetRateLimits();
  resetPrismaStub();
  mocks.auditCreate.mockResolvedValue({ id: 'row' });
  mocks.classroomFindAll.mockResolvedValue([{ id: 'class-1', status: 'ACTIVE', slug: 'c' }]);
  mocks.classroomFindById.mockResolvedValue({
    id: 'class-1',
    slug: 'c',
    git_organization: { id: 'org-1', login: 'org', provider: 'GITHUB' },
  });
  mocks.findByClassroomAndUser.mockImplementation(
    async (_c: string, user: string, roles: string | string[] | null) => {
      if (user === STUDENT) {
        return roles === 'STUDENT'
          ? { has_accepted_invite: true, user: { id: STUDENT, login: 'alice' } }
          : null;
      }
      const wanted = roles === null ? null : Array.isArray(roles) ? roles : [roles];
      return wanted && !wanted.includes('OWNER') ? null : { id: 'm-owner', role: 'OWNER' };
    }
  );
  mocks.taskTrigger.mockResolvedValue({ id: 'run-1' });
  setPrismaRows({
    user: {
      findUnique: { accounts: [{ provider_id: 'github', account_id: '1', username: 'alice' }] },
    },
  });
});

async function call(
  name: string,
  args: Record<string, unknown>,
  { impersonatedBy }: { impersonatedBy?: string } = {}
) {
  viewerSeq += 1;
  userId = `user-${viewerSeq}`;
  const server = buildMcpServer({
    userId,
    clientId: CLIENT,
    scopes: new Set(['read', 'write']),
    ...(impersonatedBy ? { impersonatedBy } : {}),
  } as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: CLIENT, version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

const actorFor = (tool: string) => ({
  userId,
  role: 'OWNER',
  tool,
  impersonatedBy: null,
  clientId: CLIENT,
  via: 'mcp',
});

/** A started removal with nothing at stake: no wait, no slots to settle. */
const STARTED = {
  userId: 'ta-1',
  login: 'ta-ann',
  role: 'ASSISTANT',
  runId: 'run-1',
  name: 'Ann',
  ungradedCount: 0,
  heldUngradedCount: 0,
  choice: null,
};

interface Case {
  tool: string;
  args: Record<string, unknown>;
  /** Make the service the tool calls answer with `audit`. */
  answer: (audit: typeof WRITTEN) => void;
  service: () => ReturnType<typeof vi.fn>;
  /** Where the actor sits in the service's arguments. */
  actorOf: (call: unknown[]) => unknown;
  /** What the call answers either way. */
  payload: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    tool: 'staff_add',
    args: { classroom: 'o/c', login: 'ta-ann', role: 'ASSISTANT' },
    answer: audit =>
      mocks.addStaff.mockResolvedValue({
        created: true,
        alreadyExists: false,
        userId: 'ta-1',
        login: 'ta-ann',
        name: 'Ann',
        role: 'ASSISTANT',
        alreadyOrgMember: false,
        audit,
      }),
    service: () => mocks.addStaff,
    actorOf: ([arg]) => (arg as { actor: unknown }).actor,
    payload: {
      success: true,
      created: true,
      already_exists: false,
      login: 'ta-ann',
      user_id: 'ta-1',
      name: 'Ann',
      role: 'ASSISTANT',
      github: 'invited',
      invite_pending: true,
      message: expect.any(String),
    },
  },
  {
    tool: 'staff_update',
    args: { classroom: 'o/c', login: 'ta-ann', role: 'ASSISTANT', is_grader: true },
    answer: audit =>
      mocks.updateStaff.mockResolvedValue({
        membership: { id: 'm-2', user_id: 'ta-1', is_grader: true },
        changed: audit.written + audit.missed > 0,
        audit,
      }),
    service: () => mocks.updateStaff,
    actorOf: ([arg]) => (arg as { actor: unknown }).actor,
    payload: { success: true, login: 'ta-ann', role: 'ASSISTANT', is_grader: true },
  },
  {
    tool: 'staff_remove',
    args: { classroom: 'o/c', login: 'ta-ann', role: 'ASSISTANT', confirm: true },
    answer: audit => {
      mocks.startStaffRemoval.mockResolvedValue(STARTED);
      mocks.recordStaffRemoval.mockResolvedValue(audit);
    },
    service: () => mocks.recordStaffRemoval,
    actorOf: ([actor]) => actor,
    payload: {
      success: true,
      queued: true,
      login: 'ta-ann',
      user_id: 'ta-1',
      role: 'ASSISTANT',
      message: expect.any(String),
    },
  },
  {
    tool: 'roster_add_student',
    args: { classroom: 'o/c', students: [{ email: 'a@x.edu' }] },
    answer: audit =>
      mocks.addStudents.mockResolvedValue({
        addedExistingUsers: 1,
        invitedNewUsers: 0,
        alreadyEnrolled: [],
        invalid: [],
        emails: [],
        activations: [],
        audit,
      }),
    service: () => mocks.addStudents,
    actorOf: ([arg]) => (arg as { actor: unknown }).actor,
    payload: {
      success: true,
      added: 1,
      invited: 0,
      already_enrolled: [],
      invalid: [],
      total: 1,
    },
  },
];

describe.each(CASES)('$tool', ({ tool, args, answer, service, actorOf, payload }) => {
  it('passes the caller as the actor and writes no row of its own', async () => {
    answer(WRITTEN);
    const result = await call(tool, args);

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual(payload);
    expect(service()).toHaveBeenCalledTimes(1);
    expect(actorOf(service().mock.calls[0])).toEqual(actorFor(tool));
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('answers the same, with audit_incomplete, when the service missed its row', async () => {
    answer(MISSED);
    const result = await call(tool, args);

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual({ ...payload, audit_incomplete: true });
  });

  it('adds nothing when the call owed no row', async () => {
    answer(NONE);
    const result = await call(tool, args);
    expect(parse(result)).not.toHaveProperty('audit_incomplete');
  });
});

describe('staff_remove', () => {
  it('hands the removal and the grader moves the same actor, and reports a missed grader row', async () => {
    mocks.startStaffRemoval.mockResolvedValue({
      ...STARTED,
      ungradedCount: 2,
      heldUngradedCount: 2,
      choice: 'unassign',
    });
    mocks.waitForRunOutcome.mockResolvedValue({ outcome: 'completed' });
    mocks.settleUngradedSlots.mockResolvedValue({
      choice: 'unassign',
      total: 2,
      reassigned: [],
      unassigned: 2,
      unassignedIneligible: 0,
      alreadyCovered: 0,
      kept: 0,
      failed: 0,
      queued: false,
      fallback: null,
      audit: { written: 1, missed: 1 },
    });
    mocks.recordStaffRemoval.mockResolvedValue(WRITTEN);

    const result = await call('staff_remove', {
      classroom: 'o/c',
      login: 'ta-ann',
      role: 'ASSISTANT',
      confirm: true,
      ungraded_submissions: 'unassign',
    });

    const actor = actorFor('staff_remove');
    expect(mocks.startStaffRemoval.mock.calls[0][0]).toMatchObject({ actor });
    expect(mocks.settleUngradedSlots.mock.calls[0][0]).toMatchObject({ actor });
    expect(mocks.recordStaffRemoval.mock.calls[0][0]).toEqual(actor);
    expect(parse(result)).toMatchObject({
      success: true,
      removal_completed: true,
      audit_incomplete: true,
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('a slot whose removal failed after its add, with the add row missed: audit_incomplete', async () => {
    mocks.startStaffRemoval.mockResolvedValue({
      ...STARTED,
      ungradedCount: 1,
      heldUngradedCount: 1,
      choice: 'reassign',
    });
    mocks.waitForRunOutcome.mockResolvedValue({ outcome: 'completed' });
    // What settleUngradedSlots reports for it: the slot failed, its add row missed.
    mocks.settleUngradedSlots.mockResolvedValue({
      choice: 'reassign',
      total: 1,
      reassigned: [],
      unassigned: 0,
      unassignedIneligible: 0,
      alreadyCovered: 0,
      kept: 0,
      failed: 1,
      queued: false,
      fallback: null,
      audit: { written: 0, missed: 1 },
    });
    mocks.recordStaffRemoval.mockResolvedValue(WRITTEN);

    const result = await call('staff_remove', {
      classroom: 'o/c',
      login: 'ta-ann',
      role: 'ASSISTANT',
      confirm: true,
      ungraded_submissions: 'reassign',
    });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({
      success: true,
      removal_completed: true,
      ungraded_submissions: { failed: 1 },
      audit_incomplete: true,
    });
  });
});

describe('roster_remove_student', () => {
  const ARGS = { classroom: 'o/c', user_id: STUDENT, confirm: true };

  it('writes the request row itself and hands the run its actor for the completion row', async () => {
    const result = await call('roster_remove_student', ARGS);

    expect(parse(result)).toMatchObject({ success: true, queued: true, user_id: STUDENT });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      resource_type: 'STUDENT_ROSTER',
      action: 'DELETE',
      data: { tool: 'roster_remove_student', removal: 'requested' },
    });
    const [, { payload }] = mocks.taskTrigger.mock.calls[0] as [
      string,
      { payload: Record<string, unknown> },
    ];
    const { impersonatedBy: _none, ...stored } = actorFor('roster_remove_student');
    expect(payload.auditActor).toEqual(stored);
  });

  it('under View as, the run’s actor names the admin', async () => {
    await call('roster_remove_student', ARGS, { impersonatedBy: 'admin-1' });
    const [, { payload }] = mocks.taskTrigger.mock.calls[0] as [
      string,
      { payload: Record<string, unknown> },
    ];
    expect(payload.auditActor).toEqual({
      ...actorFor('roster_remove_student'),
      impersonatedBy: 'admin-1',
    });
  });
});

describe('under View as', () => {
  it('the actor names the admin viewing as the caller', async () => {
    CASES[0].answer(WRITTEN);
    await call(CASES[0].tool, CASES[0].args, { impersonatedBy: 'admin-1' });
    expect(mocks.addStaff.mock.calls[0][0]).toMatchObject({
      actor: { ...actorFor('staff_add'), impersonatedBy: 'admin-1' },
    });
  });
});
