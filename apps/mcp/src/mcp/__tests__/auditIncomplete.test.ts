/**
 * A write whose change is saved but whose audit row cannot be written answers
 * normally, with `audit_incomplete: true`, and is never an error result (so a
 * client does not retry a change that already took effect). The mark is set
 * on the call's context by `writeAudit`, or by `noteServiceAudit` when the
 * shared service wrote the row and reports it `missed` (token_grant,
 * extension_purchase), and added once, by the registry (mcp/audit.ts,
 * mcp/registry.ts). A read never gets the field, and a read recorded before
 * its data is handed over (`writeAuditOrFail`) still fails.
 *
 * The real tools run on a real McpServer over the SDK's in-memory transport,
 * with `@classmoji/services` faked; `audit.record` is the real rule over the
 * fake `create` (support/auditRecord.ts).
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../registry.ts';

const mocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  classroomFindAll: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  grantTokens: vi.fn(),
  purchaseQuizExtensionHours: vi.fn(),
  purchaseExtensionHours: vi.fn(),
  graFindById: vi.fn(),
  findOpenByAssignmentId: vi.fn(),
  findForRegradeRequest: vi.fn(),
  trigger: vi.fn(),
  retrieve: vi.fn(),
  assignmentFindById: vi.fn(),
  quizzesVisible: vi.fn(),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

vi.mock('@classmoji/services', () => ({
  HelperService: {},
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
      getClassroomForUI: (c: unknown) => c,
      getTimeZone: async () => null,
    },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
    token: {
      grantTokens: (...a: unknown[]) => mocks.grantTokens(...a),
      purchaseQuizExtensionHours: (...a: unknown[]) => mocks.purchaseQuizExtensionHours(...a),
      purchaseExtensionHours: (...a: unknown[]) => mocks.purchaseExtensionHours(...a),
    },
    regradeRequest: {
      findOpenByAssignmentId: (...a: unknown[]) => mocks.findOpenByAssignmentId(...a),
      findMany: vi.fn(async () => []),
    },
    assignment: { findById: (...a: unknown[]) => mocks.assignmentFindById(...a) },
    entitlement: { quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a) },
    gitRepoAssignment: {
      findById: (...a: unknown[]) => mocks.graFindById(...a),
      findForRegradeRequest: (...a: unknown[]) => mocks.findForRegradeRequest(...a),
      regradeTaskSubmission: (submission: { id: string }) => ({ id: submission.id }),
    },
    teamMembership: { isTeamMember: vi.fn() },
  },
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.trigger(...a) },
  runs: { retrieve: (...a: unknown[]) => mocks.retrieve(...a) },
}));

const { tokenGrantTool } = await import('../../tools/tokens.ts');
const { regradeCreateTool } = await import('../../tools/regrades.ts');
const { extensionPurchaseTool } = await import('../../tools/extensions.ts');
const { buildMcpServer, registerToolDefinition } = await import('../registry.ts');
const { writeAudit, writeAuditOrFail, withAuditIncomplete } = await import('../audit.ts');
const { ok } = await import('../../tools/shared.ts');
const { resetRateLimits } = await import('../rateLimit.ts');

const STUDENT = '33333333-3333-4333-8333-333333333333';
const SUBMISSION = '44444444-4444-4444-8444-444444444444';
const QUIZ_ASSIGNMENT = '11111111-1111-4111-8111-111111111111';
const FUTURE = new Date(Date.now() + 24 * 3_600_000);
/** What a token service answers about the row it owed. */
const WRITTEN = { written: 1, missed: 0 };
const MISSED = { written: 0, missed: 1 };

/** A read that records its VIEW row before handing its data over. */
const strictReadTool: ToolDefinition<{ classroom: string }> = {
  name: 't_strict_read',
  title: 'test',
  description: 'test',
  scope: 'read',
  roles: ['OWNER'],
  inputSchema: { classroom: z.string() },
  handler: async (_args, ctx) => {
    await writeAuditOrFail(ctx, {
      resource_type: 'PAGES',
      resource_id: 'x',
      action: 'VIEW',
      data: { tool: 't_strict_read' },
    });
    return ok({ secret: 'OTHER-PEOPLES-DATA' });
  },
};

/** A read that writes a row through writeAudit: a read result never gets the field. */
const readWithRowTool: ToolDefinition<{ classroom: string }> = {
  name: 't_read_with_row',
  title: 'test',
  description: 'test',
  scope: 'read',
  roles: ['OWNER'],
  inputSchema: { classroom: z.string() },
  handler: async (_args, ctx) => {
    await writeAudit(ctx, {
      resource_type: 'PAGES',
      resource_id: 'x',
      action: 'VIEW',
      data: { tool: 't_read_with_row' },
    });
    return ok({ items: [] });
  },
};

/** A write that records its own row through writeAudit. */
const writeWithRowTool: ToolDefinition<{ classroom: string }> = {
  name: 't_write_with_row',
  title: 'test',
  description: 'test',
  scope: 'write',
  roles: ['OWNER'],
  inputSchema: { classroom: z.string() },
  handler: async (_args, ctx) => {
    await writeAudit(ctx, {
      resource_type: 'PAGES',
      resource_id: 'x',
      action: 'UPDATE',
      data: { tool: 't_write_with_row' },
    });
    return ok({ done: true });
  },
};

beforeAll(() => {
  for (const def of [
    tokenGrantTool,
    extensionPurchaseTool,
    regradeCreateTool,
    strictReadTool,
    readWithRowTool,
    writeWithRowTool,
  ]) {
    registerToolDefinition(def as unknown as ToolDefinition<never>);
  }
});

let viewerSeq = 0;
let viewerRole = 'OWNER';

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  resetRateLimits();
  mocks.auditCreate.mockResolvedValue({ id: 'row-1' });
  mocks.classroomFindAll.mockResolvedValue([{ id: 'class-1', status: 'ACTIVE', slug: 'c' }]);
  mocks.findByClassroomAndUser.mockImplementation(
    async (_classroomId: string, userId: string, roles: string[] | null) => {
      // The token_grant target: an enrolled student.
      if (userId === STUDENT) return { id: 'm-student', role: 'STUDENT' };
      if (roles && !roles.includes(viewerRole)) return null;
      return { id: 'm-viewer', role: viewerRole };
    }
  );
  mocks.grantTokens.mockResolvedValue({
    transaction: { id: 'tx-grant', student_id: STUDENT, amount: 5, balance_after: 12 },
    audit: WRITTEN,
  });
  mocks.quizzesVisible.mockResolvedValue(true);
  mocks.graFindById.mockImplementation(async () => ({
    id: SUBMISSION,
    git_repo: { classroom_id: 'class-1', student_id: `user-${viewerSeq}`, team_id: null },
    grades: [{ emoji: '🎯' }],
  }));
  mocks.purchaseExtensionHours.mockResolvedValue({
    transaction: { id: 'tx-repo', hours_purchased: 1, amount: -3, balance_after: 9 },
    audit: WRITTEN,
  });
  mocks.findOpenByAssignmentId.mockResolvedValue(null);
  mocks.findForRegradeRequest.mockImplementation(async (id: string) => ({ id }));
  mocks.trigger.mockResolvedValue({ id: 'run-1' });
  mocks.retrieve.mockResolvedValue({
    status: 'COMPLETED',
    output: { id: 'rr-1', status: 'IN_REVIEW', previous_grade: ['🎯'], audit: WRITTEN },
  });
  mocks.assignmentFindById.mockResolvedValue({
    id: QUIZ_ASSIGNMENT,
    type: 'QUIZ',
    title: 'Quiz 1',
    is_published: true,
    release_at: null,
    student_deadline: FUTURE,
    module: { id: 'mod-1', classroom_id: 'class-1' },
    repository: null,
    quiz: { id: 'quiz-1' },
    form: null,
  });
  mocks.purchaseQuizExtensionHours.mockResolvedValue({
    transaction: { id: 'tx-buy', hours_purchased: 2, amount: -4, balance_after: 6 },
    audit: WRITTEN,
  });
});

async function call(role: string, name: string, args: Record<string, unknown>) {
  viewerRole = role;
  viewerSeq += 1;
  const server = buildMcpServer({
    userId: `user-${viewerSeq}`,
    clientId: 'audit-incomplete-test',
    scopes: new Set(['read', 'write']),
  } as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'audit-incomplete-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

function failAudit() {
  mocks.auditCreate.mockRejectedValue(new Error('database away'));
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('a write whose audit row is not written', () => {
  it('token_grant: the normal answer, audit_incomplete, not an error; granted once', async () => {
    // The token service saved the grant and could not write its row.
    mocks.grantTokens.mockResolvedValue({
      transaction: { id: 'tx-grant', student_id: STUDENT, amount: 5, balance_after: 12 },
      audit: MISSED,
    });
    const result = await call('OWNER', 'token_grant', {
      classroom: 'org/c',
      student_id: STUDENT,
      amount: 5,
    });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual({
      success: true,
      transaction: { id: 'tx-grant', student_id: STUDENT, amount: 5, balance_after: 12 },
      audit_incomplete: true,
    });
    expect(mocks.grantTokens).toHaveBeenCalledTimes(1);
    // The service writes the row; the tool writes none of its own.
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('extension_purchase: the normal answer, audit_incomplete, not an error; bought once', async () => {
    mocks.purchaseQuizExtensionHours.mockResolvedValue({
      transaction: { id: 'tx-buy', hours_purchased: 2, amount: -4, balance_after: 6 },
      audit: MISSED,
    });
    const result = await call('STUDENT', 'extension_purchase', {
      classroom: 'org/c',
      assignment_id: QUIZ_ASSIGNMENT,
      hours: 2,
    });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({
      success: true,
      assignment_id: QUIZ_ASSIGNMENT,
      transaction: { id: 'tx-buy' },
      audit_incomplete: true,
    });
    expect(mocks.purchaseQuizExtensionHours).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('a write whose service wrote its row carries no field', async () => {
    const result = await call('OWNER', 'token_grant', {
      classroom: 'org/c',
      student_id: STUDENT,
      amount: 5,
    });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).not.toHaveProperty('audit_incomplete');
  });

  it('a row written on the second try is written: no field', async () => {
    mocks.auditCreate.mockRejectedValueOnce(new Error('connection reset'));
    const result = await call('OWNER', 't_write_with_row', { classroom: 'org/c' });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).not.toHaveProperty('audit_incomplete');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
  });

  it('a write whose own row is not written: audit_incomplete, tried once more, one miss line', async () => {
    const logged = failAudit();
    const result = await call('OWNER', 't_write_with_row', { classroom: 'org/c' });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual({ done: true, audit_incomplete: true });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    const misses = logged.mock.calls.filter(c => c[0] === 'audit_miss');
    expect(misses).toHaveLength(1);
    expect(String(misses[0][1])).toContain('t_write_with_row');
    expect(result.content[0].text).not.toContain('database away');
    logged.mockRestore();
  });

  it('a write whose own row lands carries no field', async () => {
    const result = await call('OWNER', 't_write_with_row', { classroom: 'org/c' });
    expect(parse(result)).not.toHaveProperty('audit_incomplete');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });
});

/** The actor `serviceActor` builds for the call `call()` makes next. */
const actorFor = (role: string, tool: string) => ({
  userId: `user-${viewerSeq}`,
  role,
  tool,
  impersonatedBy: null,
  clientId: 'audit-incomplete-test',
  via: 'mcp',
});

describe('token and regrade writes pass their actor through the registry', () => {
  it('token_grant: the service once, with the caller as actor; the same answer', async () => {
    const result = await call('OWNER', 'token_grant', {
      classroom: 'org/c',
      student_id: STUDENT,
      amount: 5,
      description: 'Lab bonus',
    });

    expect(mocks.grantTokens).toHaveBeenCalledTimes(1);
    expect(mocks.grantTokens).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: STUDENT,
      amount: 5,
      description: 'Lab bonus',
      actor: actorFor('OWNER', 'token_grant'),
    });
    expect(parse(result)).toEqual({
      success: true,
      transaction: { id: 'tx-grant', student_id: STUDENT, amount: 5, balance_after: 12 },
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('extension_purchase on a quiz: the service once, with the student as actor', async () => {
    await call('STUDENT', 'extension_purchase', {
      classroom: 'org/c',
      assignment_id: QUIZ_ASSIGNMENT,
      hours: 2,
    });
    expect(mocks.purchaseQuizExtensionHours).toHaveBeenCalledTimes(1);
    expect(mocks.purchaseQuizExtensionHours).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: `user-${viewerSeq}`,
      assignmentId: QUIZ_ASSIGNMENT,
      hours: 2,
      actor: actorFor('STUDENT', 'extension_purchase'),
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('extension_purchase on a submission: the same answer, audit_incomplete on a missed row', async () => {
    mocks.purchaseExtensionHours.mockResolvedValue({
      transaction: { id: 'tx-repo', hours_purchased: 1, amount: -3, balance_after: 9 },
      audit: MISSED,
    });
    const result = await call('STUDENT', 'extension_purchase', {
      classroom: 'org/c',
      git_repo_assignment_id: SUBMISSION,
      hours: 1,
    });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual({
      success: true,
      git_repo_assignment_id: SUBMISSION,
      transaction: { id: 'tx-repo', hours_purchased: 1, amount: -3, balance_after: 9 },
      audit_incomplete: true,
    });
    expect(mocks.purchaseExtensionHours).toHaveBeenCalledTimes(1);
    expect(mocks.purchaseExtensionHours).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: `user-${viewerSeq}`,
      gitRepoAssignmentId: SUBMISSION,
      hours: 1,
      actor: actorFor('STUDENT', 'extension_purchase'),
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('regrade_create on a submission: one run carrying the actor, no row of its own', async () => {
    const result = await call('STUDENT', 'regrade_create', {
      classroom: 'org/c',
      git_repo_assignment_id: SUBMISSION,
      comment: 'please look again',
    });

    expect(mocks.trigger).toHaveBeenCalledTimes(1);
    expect(mocks.trigger.mock.calls[0][0]).toBe('request_regrade');
    expect(mocks.trigger.mock.calls[0][1]).toMatchObject({
      classroom_id: 'class-1',
      student_id: `user-${viewerSeq}`,
      previous_grade: ['🎯'],
      auditActor: actorFor('STUDENT', 'regrade_create'),
    });
    expect(parse(result)).toEqual({
      success: true,
      created: true,
      regrade_request: { id: 'rr-1', status: 'IN_REVIEW', previous_grade: ['🎯'] },
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('regrade_create on a submission: audit_incomplete when the run missed its row', async () => {
    mocks.retrieve.mockResolvedValue({
      status: 'COMPLETED',
      output: { id: 'rr-1', status: 'IN_REVIEW', previous_grade: ['🎯'], audit: MISSED },
    });
    const result = await call('STUDENT', 'regrade_create', {
      classroom: 'org/c',
      git_repo_assignment_id: SUBMISSION,
      comment: 'please look again',
    });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ success: true, created: true, audit_incomplete: true });
    expect(mocks.trigger).toHaveBeenCalledTimes(1);
  });
});

describe('reads', () => {
  it('a read whose row is not written answers without audit_incomplete', async () => {
    const logged = failAudit();
    const result = await call('OWNER', 't_read_with_row', { classroom: 'org/c' });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual({ items: [] });
    logged.mockRestore();
  });

  it('a read recorded before its data is handed over still fails closed', async () => {
    const logged = failAudit();
    const result = await call('OWNER', 't_strict_read', { classroom: 'org/c' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('OTHER-PEOPLES-DATA');
    expect(parse(result)).toMatchObject({ error: 'internal' });
    logged.mockRestore();
  });
});

describe('withAuditIncomplete', () => {
  it('adds the field to the JSON object the result carries', () => {
    const result = withAuditIncomplete(ok({ a: 1 }));
    expect(JSON.parse(result.content[0].text)).toEqual({ a: 1, audit_incomplete: true });
  });

  it('gives a result without a JSON object a block of its own', () => {
    const plain: ToolResult = { content: [{ type: 'text', text: 'done' }] };
    const result = withAuditIncomplete(plain);
    expect(result.content[0].text).toBe('done');
    expect(JSON.parse(result.content[1].text)).toEqual({ audit_incomplete: true });
  });
});
