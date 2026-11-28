/**
 * A write whose change is saved but whose audit row cannot be written answers
 * normally, with `audit_incomplete: true`, and is never an error result (so a
 * client does not retry a change that already took effect). The mark is set
 * by `writeAudit` on the call's context and added once, by the registry
 * (mcp/audit.ts, mcp/registry.ts). A read never gets the field, and a read
 * recorded before its data is handed over (`writeAuditOrFail`) still fails.
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
  assignToStudent: vi.fn(),
  purchaseQuizExtensionHours: vi.fn(),
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
      assignToStudent: (...a: unknown[]) => mocks.assignToStudent(...a),
      purchaseQuizExtensionHours: (...a: unknown[]) => mocks.purchaseQuizExtensionHours(...a),
    },
    assignment: { findById: (...a: unknown[]) => mocks.assignmentFindById(...a) },
    entitlement: { quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a) },
    gitRepoAssignment: { findById: vi.fn() },
    teamMembership: { isTeamMember: vi.fn() },
  },
}));

const { tokenGrantTool } = await import('../../tools/tokens.ts');
const { extensionPurchaseTool } = await import('../../tools/extensions.ts');
const { buildMcpServer, registerToolDefinition } = await import('../registry.ts');
const { writeAudit, writeAuditOrFail, withAuditIncomplete } = await import('../audit.ts');
const { ok } = await import('../../tools/shared.ts');
const { resetRateLimits } = await import('../rateLimit.ts');

const STUDENT = '33333333-3333-4333-8333-333333333333';
const QUIZ_ASSIGNMENT = '11111111-1111-4111-8111-111111111111';
const FUTURE = new Date(Date.now() + 24 * 3_600_000);

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

beforeAll(() => {
  for (const def of [tokenGrantTool, extensionPurchaseTool, strictReadTool, readWithRowTool]) {
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
  mocks.assignToStudent.mockResolvedValue({
    id: 'tx-grant',
    student_id: STUDENT,
    amount: 5,
    balance_after: 12,
  });
  mocks.quizzesVisible.mockResolvedValue(true);
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
    id: 'tx-buy',
    hours_purchased: 2,
    amount: -4,
    balance_after: 6,
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
    const logged = failAudit();
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
    expect(mocks.assignToStudent).toHaveBeenCalledTimes(1);
    // Tried once more, then one audit_miss line with the row.
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    const misses = logged.mock.calls.filter(c => c[0] === 'audit_miss');
    expect(misses).toHaveLength(1);
    expect(String(misses[0][1])).toContain('TOKEN_GRANT');
    expect(result.content[0].text).not.toContain('database away');
    logged.mockRestore();
  });

  it('extension_purchase: the normal answer, audit_incomplete, not an error; bought once', async () => {
    const logged = failAudit();
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
    logged.mockRestore();
  });

  it('a row written on the second try is written: no field', async () => {
    mocks.auditCreate.mockRejectedValueOnce(new Error('connection reset'));
    const result = await call('OWNER', 'token_grant', {
      classroom: 'org/c',
      student_id: STUDENT,
      amount: 5,
    });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).not.toHaveProperty('audit_incomplete');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
  });

  it('a write whose row lands carries no field', async () => {
    const result = await call('OWNER', 'token_grant', {
      classroom: 'org/c',
      student_id: STUDENT,
      amount: 5,
    });
    expect(parse(result)).not.toHaveProperty('audit_incomplete');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
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
