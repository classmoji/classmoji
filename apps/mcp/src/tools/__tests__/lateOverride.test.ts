/**
 * Unit tests for submission_late_override.
 *
 * Three layers:
 *   1. The handler, with `@classmoji/services` mocked factory-style (as in
 *      graders.test.ts): the three selector modes, the exactly-one rule,
 *      clearing, the response counts, not_found handling and the audit rows.
 *   2. The REGISTRY pipeline, with the real tool registered on a real McpServer
 *      over the SDK's in-memory transport (as registry.test.ts and
 *      contentSearch.test.ts do): who may call it and the locked-classroom
 *      refusal are enforced there, not in the handler, so a handler-only test
 *      could not show them.
 *   3. The REAL service method against the schema-validating Prisma stub: the
 *      classroom filter must sit in the WHERE of BOTH the read and the write,
 *      and every field the queries name must exist.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolDefinition } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  setLateOverride: vi.fn(),
  assignmentFindById: vi.fn(),
  auditCreate: vi.fn(),
  classroomFindAll: vi.fn(),
  findByClassroomAndUser: vi.fn(),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

vi.mock('@classmoji/services', () => ({
  HelperService: {},
  ClassmojiService: {
    gitRepoAssignment: {
      setLateOverrideInClassroom: (...a: unknown[]) => mocks.setLateOverride(...a),
    },
    assignment: { findById: (...a: unknown[]) => mocks.assignmentFindById(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    classroom: {
      findAll: (...a: unknown[]) => mocks.classroomFindAll(...a),
      getClassroomForUI: (c: unknown) => c,
      getTimeZone: async () => null,
    },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
  },
}));

const { submissionLateOverrideTool, LATE_OVERRIDE_ID_LIST_CAP } =
  await import('../lateOverride.ts');
const { buildMcpServer, registerToolDefinition, toolAnnotations } =
  await import('../../mcp/registry.ts');
const { resetRateLimits } = await import('../../mcp/rateLimit.ts');
const { prismaCallsFor, resetPrismaStub, setPrismaRows } =
  await import('../../__tests__/prismaSchemaStub.ts');
// The REAL service module (the package barrel is mocked above); it reaches the
// database through the mocked `@classmoji/database`, i.e. the schema stub.
const realService =
  await import('../../../../../packages/services/src/classmoji/gitRepoAssignment.service.ts');

const SUB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUB_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREIGN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ASSIGNMENT_ID = '11111111-1111-4111-8111-111111111111';

const CTX: ToolContext = {
  viewer: { userId: 'teacher-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'TEACHER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'TEACHER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function serviceResult(partial: Partial<Record<string, string[]>> = {}) {
  return {
    updatedIds: [],
    unchangedIds: [],
    notFoundIds: [],
    notLateIds: [],
    notSubmittedIds: [],
    lateIds: [],
    ...partial,
  };
}

const auditRows = () =>
  mocks.auditCreate.mock.calls.map(
    c =>
      c[0] as {
        resource_type: string;
        resource_id: string;
        action: string;
        role: string;
        classroom_id: string;
        data: Record<string, unknown>;
      }
  );

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.assignmentFindById.mockImplementation(async (id: string) => ({
    id,
    repository: { classroom_id: 'class-1' },
  }));
  mocks.setLateOverride.mockResolvedValue(serviceResult());
  resetRateLimits();
  resetPrismaStub();
});

// ─── 1. Handler ──────────────────────────────────────────────────────────────

describe('submission_late_override — selector validation', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['none', {}],
    ['id + ids', { git_repo_assignment_id: SUB_A, git_repo_assignment_ids: [SUB_B] }],
    ['id + assignment', { git_repo_assignment_id: SUB_A, assignment_id: ASSIGNMENT_ID }],
    ['ids + assignment', { git_repo_assignment_ids: [SUB_A], assignment_id: ASSIGNMENT_ID }],
    [
      'all three',
      {
        git_repo_assignment_id: SUB_A,
        git_repo_assignment_ids: [SUB_B],
        assignment_id: ASSIGNMENT_ID,
      },
    ],
  ];

  it.each(cases)('refuses %s before any lookup or write', async (_label, selectors) => {
    await expect(
      submissionLateOverrideTool.handler(
        { classroom: 'org/c', is_late_override: true, ...selectors },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.assignmentFindById).not.toHaveBeenCalled();
    expect(mocks.setLateOverride).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('submission_late_override — single submission', () => {
  const ARGS = { classroom: 'org/c', git_repo_assignment_id: SUB_A, is_late_override: true };

  it('sets the exemption through the classroom-scoped service and audits the row', async () => {
    mocks.setLateOverride.mockResolvedValue(
      serviceResult({ updatedIds: [SUB_A], lateIds: [SUB_A] })
    );

    const payload = parse(await submissionLateOverrideTool.handler(ARGS, CTX));

    // classroomId comes from ctx, never from the request.
    expect(mocks.setLateOverride).toHaveBeenCalledWith({
      classroomId: 'class-1',
      selector: { ids: [SUB_A] },
      isLateOverride: true,
    });
    expect(payload).toMatchObject({
      success: true,
      mode: 'single',
      is_late_override: true,
      matched_count: 1,
      updated_count: 1,
      unchanged_count: 0,
      not_found_count: 0,
      late_count: 1,
      late_updated_count: 1,
      updated_ids: [SUB_A],
      ids_truncated: false,
    });

    const [audit] = auditRows();
    expect(auditRows()).toHaveLength(1);
    expect(audit).toMatchObject({
      resource_type: 'GIT_REPO_ASSIGNMENT',
      resource_id: SUB_A,
      action: 'UPDATE',
      role: 'TEACHER',
      classroom_id: 'class-1',
      data: { tool: 'submission_late_override', value: true, mode: 'single' },
    });
  });

  it('refuses a missing or foreign id with the uniform not_found and audits nothing', async () => {
    mocks.setLateOverride.mockResolvedValue(serviceResult({ notFoundIds: [FOREIGN] }));

    await expect(
      submissionLateOverrideTool.handler({ ...ARGS, git_repo_assignment_id: FOREIGN }, CTX)
    ).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Submission not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('reports an already-exempt submission as unchanged and writes no audit row', async () => {
    mocks.setLateOverride.mockResolvedValue(serviceResult({ unchangedIds: [SUB_A] }));

    const payload = parse(await submissionLateOverrideTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({ updated_count: 0, unchanged_count: 1, unchanged_ids: [SUB_A] });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('clears the exemption with is_late_override=false and audits value:false', async () => {
    mocks.setLateOverride.mockResolvedValue(
      serviceResult({ updatedIds: [SUB_A], lateIds: [SUB_A] })
    );

    const payload = parse(
      await submissionLateOverrideTool.handler({ ...ARGS, is_late_override: false }, CTX)
    );
    expect(mocks.setLateOverride).toHaveBeenCalledWith(
      expect.objectContaining({ isLateOverride: false })
    );
    expect(payload).toMatchObject({ is_late_override: false, updated_count: 1, late_count: 1 });
    expect(auditRows()[0].data).toMatchObject({ value: false });
  });
});

describe('submission_late_override — list of ids', () => {
  it('writes only in-classroom ids; foreign ids land in not_found and are not audited', async () => {
    mocks.setLateOverride.mockResolvedValue(
      serviceResult({
        updatedIds: [SUB_A, SUB_B],
        unchangedIds: [SUB_C],
        notFoundIds: [FOREIGN],
        lateIds: [SUB_B, SUB_C],
      })
    );

    const payload = parse(
      await submissionLateOverrideTool.handler(
        {
          classroom: 'org/c',
          git_repo_assignment_ids: [SUB_A, SUB_B, SUB_C, FOREIGN],
          is_late_override: true,
        },
        CTX
      )
    );

    expect(mocks.setLateOverride).toHaveBeenCalledWith({
      classroomId: 'class-1',
      selector: { ids: [SUB_A, SUB_B, SUB_C, FOREIGN] },
      isLateOverride: true,
    });
    expect(payload).toMatchObject({
      mode: 'ids',
      matched_count: 3,
      updated_count: 2,
      unchanged_count: 1,
      not_found_count: 1,
      late_count: 2,
      late_updated_count: 1,
      updated_ids: [SUB_A, SUB_B],
      unchanged_ids: [SUB_C],
      not_found_ids: [FOREIGN],
    });
    expect(payload).not.toHaveProperty('assignment_id');

    // One audit row per CHANGED submission — never the unchanged or foreign ids.
    expect(auditRows().map(r => r.resource_id)).toEqual([SUB_A, SUB_B]);
    for (const row of auditRows()) {
      expect(row.data).toMatchObject({
        tool: 'submission_late_override',
        value: true,
        mode: 'ids',
      });
    }
  });

  it('caps each id list in the response but keeps the counts exact', async () => {
    const many = Array.from(
      { length: LATE_OVERRIDE_ID_LIST_CAP + 20 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    mocks.setLateOverride.mockResolvedValue(serviceResult({ updatedIds: many }));

    const payload = parse(
      await submissionLateOverrideTool.handler(
        { classroom: 'org/c', git_repo_assignment_ids: many, is_late_override: true },
        CTX
      )
    );
    expect(payload.updated_count).toBe(many.length);
    expect(payload.updated_ids).toHaveLength(LATE_OVERRIDE_ID_LIST_CAP);
    expect(payload.ids_truncated).toBe(true);
    // Every changed row is still audited, not just the ones the response lists.
    expect(mocks.auditCreate).toHaveBeenCalledTimes(many.length);
  });
});

describe('submission_late_override — assignment_id', () => {
  const ARGS = { classroom: 'org/c', assignment_id: ASSIGNMENT_ID, is_late_override: true };

  it('classroom-verifies the assignment, then exempts its submissions and counts the late ones', async () => {
    mocks.setLateOverride.mockResolvedValue(
      serviceResult({
        updatedIds: [SUB_A, SUB_B],
        unchangedIds: [SUB_C],
        lateIds: [SUB_A, SUB_B, SUB_C],
      })
    );

    const payload = parse(await submissionLateOverrideTool.handler(ARGS, CTX));

    expect(mocks.assignmentFindById).toHaveBeenCalledWith(ASSIGNMENT_ID);
    expect(mocks.setLateOverride).toHaveBeenCalledWith({
      classroomId: 'class-1',
      selector: { assignmentId: ASSIGNMENT_ID },
      isLateOverride: true,
    });
    expect(payload).toMatchObject({
      mode: 'assignment',
      assignment_id: ASSIGNMENT_ID,
      matched_count: 3,
      updated_count: 2,
      unchanged_count: 1,
      not_found_count: 0,
      late_count: 3,
      late_updated_count: 2,
    });
    expect(auditRows().map(r => r.resource_id)).toEqual([SUB_A, SUB_B]);
    expect(auditRows()[0].data).toMatchObject({
      mode: 'assignment',
      assignment_id: ASSIGNMENT_ID,
      value: true,
    });
  });

  it("refuses another classroom's assignment with the uniform not_found and writes nothing", async () => {
    mocks.assignmentFindById.mockResolvedValue({
      id: ASSIGNMENT_ID,
      repository: { classroom_id: 'class-2' },
    });

    await expect(submissionLateOverrideTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Assignment not found in this classroom',
    });
    expect(mocks.setLateOverride).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses an unknown assignment the same way', async () => {
    mocks.assignmentFindById.mockResolvedValue(null);
    await expect(submissionLateOverrideTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.setLateOverride).not.toHaveBeenCalled();
  });

  it('refuses an assignment without a repository (quiz/form coursework) as not_found', async () => {
    mocks.assignmentFindById.mockResolvedValue({ id: ASSIGNMENT_ID, repository: null });

    await expect(submissionLateOverrideTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.setLateOverride).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('reports not_submitted and not_late skips alongside what it waived', async () => {
    mocks.setLateOverride.mockResolvedValue(
      serviceResult({
        updatedIds: [SUB_A],
        notSubmittedIds: [SUB_B],
        notLateIds: [SUB_C],
        lateIds: [SUB_A, SUB_B],
      })
    );

    const payload = parse(await submissionLateOverrideTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      matched_count: 3,
      updated_count: 1,
      not_submitted_count: 1,
      not_submitted_ids: [SUB_B],
      not_late_count: 1,
      not_late_ids: [SUB_C],
      late_count: 2,
      late_updated_count: 1,
    });
    expect(payload).not.toHaveProperty('reason');
    expect(auditRows().map(r => r.resource_id)).toEqual([SUB_A]);
  });
});

describe('submission_late_override — skips and audit failures', () => {
  it('single id on time → success, updated_count 0, a not_late reason, no audit', async () => {
    mocks.setLateOverride.mockResolvedValue(serviceResult({ notLateIds: [SUB_A] }));

    const payload = parse(
      await submissionLateOverrideTool.handler(
        { classroom: 'org/c', git_repo_assignment_id: SUB_A, is_late_override: true },
        CTX
      )
    );
    expect(payload).toMatchObject({
      success: true,
      mode: 'single',
      updated_count: 0,
      not_late_count: 1,
      not_late_ids: [SUB_A],
    });
    expect(String(payload.reason)).toMatch(/^not_late/);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('keeps the committed result and flags audit_incomplete when an audit write fails', async () => {
    const ids = Array.from(
      { length: 45 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    mocks.setLateOverride.mockResolvedValue(serviceResult({ updatedIds: ids }));
    const secret = 'db password is hunter2';
    mocks.auditCreate.mockImplementation(async (row: { resource_id: string }) => {
      if (row.resource_id === ids[3] || row.resource_id === ids[30]) throw new Error(secret);
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await submissionLateOverrideTool.handler(
      { classroom: 'org/c', git_repo_assignment_ids: ids, is_late_override: true },
      CTX
    );
    const payload = parse(result);

    expect(payload).toMatchObject({
      success: true,
      updated_count: 45,
      audit_incomplete: true,
      audit_failed_ids: [ids[3], ids[30]],
    });
    // Every row was attempted, in parallel chunks — the loop did not stop at the failure.
    expect(mocks.auditCreate).toHaveBeenCalledTimes(45);
    // The error is logged server-side and never reaches the client.
    expect(logged).toHaveBeenCalled();
    expect(result.content[0].text).not.toContain(secret);
    logged.mockRestore();
  });

  it('omits audit_incomplete when every audit row lands', async () => {
    mocks.setLateOverride.mockResolvedValue(serviceResult({ updatedIds: [SUB_A] }));
    const payload = parse(
      await submissionLateOverrideTool.handler(
        { classroom: 'org/c', git_repo_assignment_id: SUB_A, is_late_override: true },
        CTX
      )
    );
    expect(payload).not.toHaveProperty('audit_incomplete');
    expect(payload).not.toHaveProperty('audit_failed_ids');
  });
});

describe('submission_late_override — definition', () => {
  it('is OWNER+TEACHER, write scope, reversible and idempotent', () => {
    expect(submissionLateOverrideTool.roles).toEqual(['OWNER', 'TEACHER']);
    expect(submissionLateOverrideTool.scope).toBe('write');
    const hints = toolAnnotations(submissionLateOverrideTool as unknown as ToolDefinition<never>);
    expect(hints).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('keeps its description under 1,500 bytes', () => {
    expect(Buffer.byteLength(submissionLateOverrideTool.description, 'utf8')).toBeLessThan(1500);
  });

  it('is registered in the tool manifest', () => {
    const manifest = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.ts'),
      'utf8'
    );
    expect(manifest).toContain('registerToolDefinition(submissionLateOverrideTool)');
  });
});

// ─── 2. Registry pipeline: roles + classroom status ──────────────────────────

describe('submission_late_override — through the registry', () => {
  let viewerSeq = 0;

  beforeAll(() => {
    registerToolDefinition(submissionLateOverrideTool as unknown as ToolDefinition<never>);
  });

  function mockClassroom(status: string, memberRole: string) {
    mocks.classroomFindAll.mockResolvedValue([{ id: 'class-1', status, slug: 'c' }]);
    mocks.findByClassroomAndUser.mockImplementation(
      async (_classroomId: string, _userId: string, roles: string[] | null) => {
        if (roles && !roles.includes(memberRole)) return null;
        return { id: 'membership-1', role: memberRole };
      }
    );
  }

  async function call(args: Record<string, unknown>) {
    viewerSeq += 1;
    const server = buildMcpServer({
      userId: `user-${viewerSeq}`,
      clientId: 'late-override-test',
      scopes: new Set(['read', 'write']),
    } as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'late-override-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.callTool({ name: 'submission_late_override', arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
  }

  const ARGS = { classroom: 'org/c', git_repo_assignment_id: SUB_A, is_late_override: true };

  it.each(['OWNER', 'TEACHER'])('lets %s set the exemption', async role => {
    mockClassroom('ACTIVE', role);
    mocks.setLateOverride.mockResolvedValue(serviceResult({ updatedIds: [SUB_A] }));

    const result = await call(ARGS);
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ updated_count: 1 });
    expect(auditRows()[0].role).toBe(role);
  });

  it.each(['ASSISTANT', 'STUDENT'])('refuses %s before the handler runs', async role => {
    mockClassroom('ACTIVE', role);

    const result = await call(ARGS);
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: 'forbidden' });
    expect(mocks.setLateOverride).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a TEACHER on a LOCKED classroom (the webapp mutation gate)', async () => {
    mockClassroom('LOCKED', 'TEACHER');

    const result = await call(ARGS);
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: 'forbidden', code: 'CLASSROOM_LOCKED' });
    expect(mocks.setLateOverride).not.toHaveBeenCalled();
  });

  it('lets the OWNER write on a LOCKED classroom, as the webapp does', async () => {
    mockClassroom('LOCKED', 'OWNER');
    mocks.setLateOverride.mockResolvedValue(serviceResult({ updatedIds: [SUB_A] }));

    const result = await call(ARGS);
    expect(result.isError).toBeFalsy();
  });

  it('publishes the selectors and returns the exactly-one refusal as a structured error', async () => {
    mockClassroom('ACTIVE', 'OWNER');

    const result = await call({ classroom: 'org/c', is_late_override: true });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: 'invalid_params' });
  });

  it('accepts a numeric (ISSUE-mode) submission id, alone or in a list', async () => {
    mockClassroom('ACTIVE', 'OWNER');
    const NUMERIC = '5482151816';
    mocks.setLateOverride.mockResolvedValue(serviceResult({ updatedIds: [NUMERIC] }));

    const single = await call({ ...ARGS, git_repo_assignment_id: NUMERIC });
    expect(single.isError).toBeFalsy();
    expect(mocks.setLateOverride).toHaveBeenLastCalledWith(
      expect.objectContaining({ classroomId: 'class-1', selector: { ids: [NUMERIC] } })
    );
    expect(auditRows()[0]).toMatchObject({ resource_id: NUMERIC });

    const list = await call({
      classroom: 'org/c',
      git_repo_assignment_ids: [NUMERIC, SUB_A],
      is_late_override: true,
    });
    expect(list.isError).toBeFalsy();
    expect(mocks.setLateOverride).toHaveBeenLastCalledWith(
      expect.objectContaining({ selector: { ids: [NUMERIC, SUB_A] } })
    );
  });

  it('accepts a numeric id sent as a JSON number and passes it on as a string', async () => {
    mockClassroom('ACTIVE', 'OWNER');
    mocks.setLateOverride.mockResolvedValue(serviceResult({ updatedIds: ['5482151816'] }));

    const single = await call({ ...ARGS, git_repo_assignment_id: 5482151816 });
    expect(single.isError).toBeFalsy();
    expect(mocks.setLateOverride).toHaveBeenLastCalledWith(
      expect.objectContaining({ selector: { ids: ['5482151816'] } })
    );

    const list = await call({
      classroom: 'org/c',
      git_repo_assignment_ids: [5482151816, SUB_A],
      is_late_override: true,
    });
    expect(list.isError).toBeFalsy();
    expect(mocks.setLateOverride).toHaveBeenLastCalledWith(
      expect.objectContaining({ selector: { ids: ['5482151816', SUB_A] } })
    );
  });

  it.each(['', 'abc', '12-34', '5482151816 ', '1'.repeat(65)])(
    'rejects %j as a submission id at the schema',
    async bad => {
      mockClassroom('ACTIVE', 'OWNER');
      const single = await call({ ...ARGS, git_repo_assignment_id: bad });
      expect(single.isError).toBe(true);
      const list = await call({
        classroom: 'org/c',
        git_repo_assignment_ids: [SUB_A, bad],
        is_late_override: true,
      });
      expect(list.isError).toBe(true);
      expect(mocks.setLateOverride).not.toHaveBeenCalled();
    }
  );

  it('keeps assignment_id a uuid: a numeric assignment id is refused at the schema', async () => {
    mockClassroom('ACTIVE', 'OWNER');
    const result = await call({
      classroom: 'org/c',
      assignment_id: '5482151816',
      is_late_override: true,
    });
    expect(result.isError).toBe(true);
    expect(mocks.assignmentFindById).not.toHaveBeenCalled();
  });

  it('rejects a list over 500 ids at the schema', async () => {
    mockClassroom('ACTIVE', 'OWNER');
    const tooMany = Array.from(
      { length: 501 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    const result = await call({
      classroom: 'org/c',
      git_repo_assignment_ids: tooMany,
      is_late_override: true,
    });
    expect(result.isError).toBe(true);
    expect(mocks.setLateOverride).not.toHaveBeenCalled();
  });
});

// ─── 3. The real service method, against the schema-validating stub ─────────

describe('gitRepoAssignment.setLateOverrideInClassroom (real service, schema stub)', () => {
  const NOW = new Date('2026-09-20T12:00:00Z');
  const DEADLINE = new Date('2026-09-16T23:59:00Z');

  /** The recorded args of the first `gitRepoAssignment.<method>` call. */
  const argsOf = (method: string) =>
    prismaCallsFor('gitRepoAssignment', method)[0]?.args as
      | { where?: unknown; data?: unknown }
      | undefined;

  function row(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      is_late_override: false,
      closed_at: null,
      assignment: { student_deadline: DEADLINE },
      token_transactions: [],
      ...overrides,
    };
  }

  const SUB_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const LATE_CLOSE = new Date('2026-09-18T10:00:00Z');
  const ON_TIME_CLOSE = new Date('2026-09-15T10:00:00Z');

  it('ids: scopes read + write by classroom, writes only late rows, skips on-time as not_late', async () => {
    setPrismaRows({
      gitRepoAssignment: {
        findMany: [
          row(SUB_A, { closed_at: LATE_CLOSE }), // late → written
          row(SUB_B, { is_late_override: true, closed_at: LATE_CLOSE }), // already exempt
          row(SUB_C, { closed_at: ON_TIME_CLOSE }), // on time → not_late
          row(SUB_D), // never submitted, past deadline, NAMED → still written
        ],
        updateManyAndReturn: [{ id: SUB_A }, { id: SUB_D }],
      },
    });

    const result = await realService.setLateOverrideInClassroom({
      classroomId: 'class-1',
      selector: { ids: [SUB_A, SUB_B, SUB_C, SUB_D, FOREIGN, SUB_A] },
      isLateOverride: true,
      now: NOW,
    });

    expect(argsOf('findMany')?.where).toEqual({
      git_repo: { classroom_id: 'class-1' },
      id: { in: [SUB_A, SUB_B, SUB_C, SUB_D, FOREIGN] },
    });
    // Only the vetted ids reach the write — the on-time row never does.
    expect(argsOf('updateManyAndReturn')?.where).toEqual({
      id: { in: [SUB_A, SUB_D] },
      git_repo: { classroom_id: 'class-1' },
      is_late_override: false,
    });
    expect(argsOf('updateManyAndReturn')?.data).toEqual({ is_late_override: true });

    expect(result).toEqual({
      updatedIds: [SUB_A, SUB_D],
      unchangedIds: [SUB_B],
      notFoundIds: [FOREIGN],
      notLateIds: [SUB_C],
      notSubmittedIds: [],
      // SUB_B counts as late even though it is exempt — the point of the count.
      lateIds: [SUB_A, SUB_B, SUB_D],
    });
  });

  it('single id on time: skipped as not_late, nothing written', async () => {
    setPrismaRows({
      gitRepoAssignment: { findMany: [row(SUB_C, { closed_at: ON_TIME_CLOSE })] },
    });

    const result = await realService.setLateOverrideInClassroom({
      classroomId: 'class-1',
      selector: { ids: [SUB_C] },
      isLateOverride: true,
      now: NOW,
    });
    expect(prismaCallsFor('gitRepoAssignment', 'updateManyAndReturn')).toHaveLength(0);
    expect(result).toMatchObject({ updatedIds: [], unchangedIds: [], notLateIds: [SUB_C] });
  });

  it('assignment: skips never-submitted rows as not_submitted and on-time rows as not_late', async () => {
    setPrismaRows({
      gitRepoAssignment: {
        findMany: [
          row(SUB_A, { closed_at: LATE_CLOSE }), // late → written
          row(SUB_B), // never submitted (past deadline) → not_submitted
          row(SUB_C, { closed_at: ON_TIME_CLOSE }), // on time → not_late
        ],
        updateManyAndReturn: [{ id: SUB_A }],
      },
    });

    const result = await realService.setLateOverrideInClassroom({
      classroomId: 'class-1',
      selector: { assignmentId: ASSIGNMENT_ID },
      isLateOverride: true,
      now: NOW,
    });

    expect(argsOf('findMany')?.where).toEqual({
      git_repo: { classroom_id: 'class-1' },
      assignment_id: ASSIGNMENT_ID,
    });
    expect(argsOf('updateManyAndReturn')?.where).toEqual({
      id: { in: [SUB_A] },
      git_repo: { classroom_id: 'class-1' },
      is_late_override: false,
    });
    expect(result).toEqual({
      updatedIds: [SUB_A],
      unchangedIds: [],
      notFoundIds: [],
      notLateIds: [SUB_C],
      notSubmittedIds: [SUB_B],
      lateIds: [SUB_A, SUB_B],
    });
  });

  it('clearing writes any exempt row — on time or unsubmitted — and skips nothing', async () => {
    setPrismaRows({
      gitRepoAssignment: {
        findMany: [
          row(SUB_A, { is_late_override: true, closed_at: ON_TIME_CLOSE }), // not late
          row(SUB_B, { is_late_override: true }), // never submitted
          row(SUB_C, { closed_at: LATE_CLOSE }), // not exempt → unchanged
        ],
        updateManyAndReturn: [{ id: SUB_A }, { id: SUB_B }],
      },
    });

    const result = await realService.setLateOverrideInClassroom({
      classroomId: 'class-1',
      selector: { assignmentId: ASSIGNMENT_ID },
      isLateOverride: false,
      now: NOW,
    });

    expect(argsOf('updateManyAndReturn')?.where).toEqual({
      id: { in: [SUB_A, SUB_B] },
      git_repo: { classroom_id: 'class-1' },
      is_late_override: true,
    });
    expect(argsOf('updateManyAndReturn')?.data).toEqual({ is_late_override: false });
    expect(result).toMatchObject({
      updatedIds: [SUB_A, SUB_B],
      unchangedIds: [SUB_C],
      notLateIds: [],
      notSubmittedIds: [],
    });
  });

  it('a row flipped concurrently (write returns fewer rows) is counted unchanged, not lost', async () => {
    setPrismaRows({
      gitRepoAssignment: {
        findMany: [row(SUB_A, { closed_at: LATE_CLOSE }), row(SUB_B, { closed_at: LATE_CLOSE })],
        // SUB_B was exempted by someone else between the read and the guarded write.
        updateManyAndReturn: [{ id: SUB_A }],
      },
    });

    const result = await realService.setLateOverrideInClassroom({
      classroomId: 'class-1',
      selector: { ids: [SUB_A, SUB_B] },
      isLateOverride: true,
      now: NOW,
    });

    expect(argsOf('updateManyAndReturn')?.where).toMatchObject({ id: { in: [SUB_A, SUB_B] } });
    expect(result).toMatchObject({
      updatedIds: [SUB_A],
      unchangedIds: [SUB_B],
      notLateIds: [],
      notSubmittedIds: [],
    });
    // Every matched row lands in exactly one bucket.
    expect(result.updatedIds.length + result.unchangedIds.length).toBe(2);
  });

  it('never writes when nothing changes', async () => {
    setPrismaRows({
      gitRepoAssignment: { findMany: [row(SUB_A, { is_late_override: false })] },
    });

    const result = await realService.setLateOverrideInClassroom({
      classroomId: 'class-1',
      selector: { assignmentId: ASSIGNMENT_ID },
      isLateOverride: false,
      now: NOW,
    });

    expect(prismaCallsFor('gitRepoAssignment', 'updateManyAndReturn')).toHaveLength(0);
    // Not yet submitted and past the deadline: late, like the `is_late` field.
    expect(result).toMatchObject({ updatedIds: [], unchangedIds: [SUB_A], lateIds: [SUB_A] });
  });

  it('refuses to run without a classroom id', async () => {
    await expect(
      realService.setLateOverrideInClassroom({
        classroomId: '',
        selector: { assignmentId: ASSIGNMENT_ID },
        isLateOverride: true,
      })
    ).rejects.toThrow();
    expect(prismaCallsFor('gitRepoAssignment')).toHaveLength(0);
  });
});

describe('isPastDeadlineIgnoringOverride (parity with the is_late computed field)', () => {
  const DEADLINE = new Date('2026-09-16T12:00:00Z');
  const NOW = new Date('2026-09-20T12:00:00Z');
  const late = (closed_at: Date | null, hours: number[] = [], deadline: Date | null = DEADLINE) =>
    realService.isPastDeadlineIgnoringOverride(
      {
        closed_at,
        assignment: { student_deadline: deadline },
        token_transactions: hours.map(h => ({ hours_purchased: h })),
      },
      NOW
    );

  it('no deadline → never late', () => {
    expect(late(new Date('2026-09-30T00:00:00Z'), [], null)).toBe(false);
  });

  it('open submission → late once the deadline has passed, extensions ignored', () => {
    expect(late(null)).toBe(true);
    expect(late(null, [500])).toBe(true);
    expect(
      realService.isPastDeadlineIgnoringOverride(
        { closed_at: null, assignment: { student_deadline: DEADLINE }, token_transactions: [] },
        new Date('2026-09-16T11:00:00Z')
      )
    ).toBe(false);
  });

  it('closed submission → whole hours late minus purchased hours, late when positive', () => {
    expect(late(new Date('2026-09-16T12:59:00Z'))).toBe(false); // 59 min → 0 whole hours
    expect(late(new Date('2026-09-16T13:00:00Z'))).toBe(true); // exactly 1 hour
    expect(late(new Date('2026-09-16T14:00:00Z'), [2])).toBe(false); // 2h late, 2h bought
    expect(late(new Date('2026-09-16T15:00:00Z'), [2])).toBe(true); // 3h late, 2h bought
    expect(late(new Date('2026-09-15T12:00:00Z'))).toBe(false); // early
  });
});
