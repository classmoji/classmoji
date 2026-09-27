/**
 * Submission ids are not always uuids.
 *
 * GitRepoAssignment.id defaults to a uuid, but ISSUE-mode provisioning
 * (packages/tasks cf-create_git_repo_assignment) sets it to the GitHub issue
 * id, a string of digits (id == provider_id, e.g. "5482151816"); REPO-mode rows
 * keep the uuid. Tools used to validate these ids with `.uuid()`, which refused
 * every ISSUE-mode submission. Every submission-id input now uses the shared
 * `submissionIdSchema`. This file pins:
 *   1. the schema itself, including a numeric id sent as a JSON number;
 *   2. that ids of other records on the same tools (users, assignments,
 *      grades, regrade requests) stay uuids;
 *   3. get_submission and extension_purchase with a numeric id, end to end
 *      through their handlers (grade, grader, late-override and regrade tools
 *      have theirs in their own test files).
 * submissionIds.registry.test.ts walks EVERY registered tool for inputs that
 * name a submission and checks the schema the registry publishes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  graFindById: vi.fn(),
  purchaseExtensionHours: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

vi.mock('@classmoji/services', () => ({
  AssignGradersError: class extends Error {},
  HelperService: {},
  ClassmojiService: {
    gitRepoAssignment: { findById: (...a: unknown[]) => mocks.graFindById(...a) },
    token: { purchaseExtensionHours: (...a: unknown[]) => mocks.purchaseExtensionHours(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

vi.mock('@trigger.dev/sdk', () => ({ tasks: {}, runs: {} }));

const { SUBMISSION_ID_PATTERN, submissionIdSchema: makeSubmissionIdSchema } =
  await import('../shared.ts');
const submissionIdSchema = makeSubmissionIdSchema();
const { graderAssignTool, graderUnassignTool, graderAssignBulkTool } =
  await import('../graders.ts');
const { gradeRemoveTool } = await import('../grades.ts');
const { submissionLateOverrideTool } = await import('../lateOverride.ts');
const { getSubmissionTool, listSubmissionsTool } = await import('../reads.ts');
const { regradeResolveTool } = await import('../regrades.ts');
const { extensionPurchaseTool } = await import('../extensions.ts');
const { prismaCallsFor, resetPrismaStub, setPrismaRows } =
  await import('../../__tests__/prismaSchemaStub.ts');

const NUMERIC_ID = '5482151816';
const UUID_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  resetPrismaStub();
});

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

// ─── 1. The schema ──────────────────────────────────────────────────────────

describe('submissionIdSchema', () => {
  it.each([NUMERIC_ID, UUID_ID, UUID_ID.toUpperCase(), '1', '9'.repeat(19)])('accepts %s', id => {
    expect(submissionIdSchema.safeParse(id).success).toBe(true);
  });

  it.each([
    '',
    ' ',
    'abc',
    'gra-1',
    '12-34',
    '-5482151816',
    '5482151816 ',
    ' 5482151816',
    '5482151816\n',
    '54821518.16',
    '1e10',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa', // 35 chars
    '{"in":["x"]}',
    '1'.repeat(65),
  ])('rejects %j', id => {
    expect(submissionIdSchema.safeParse(id).success).toBe(false);
  });

  it('accepts a numeric id sent as a JSON number, as its digit string', () => {
    expect(submissionIdSchema.parse(5482151816)).toBe(NUMERIC_ID);
    expect(submissionIdSchema.parse(0)).toBe('0');
    expect(submissionIdSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
  });

  it('rejects numbers that are not a safe non-negative integer, and other non-strings', () => {
    for (const value of [
      -5482151816,
      54821518.16,
      Number.MAX_SAFE_INTEGER + 1, // its digits would already be wrong
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      undefined,
      true,
      { in: [NUMERIC_ID] },
      [NUMERIC_ID],
    ]) {
      expect(submissionIdSchema.safeParse(value).success, String(value)).toBe(false);
    }
  });

  it('caps the length at 64', () => {
    expect(submissionIdSchema.safeParse('1'.repeat(64)).success).toBe(true);
    expect(SUBMISSION_ID_PATTERN.test('1'.repeat(65))).toBe(true); // the max(64) does the capping
    expect(submissionIdSchema.safeParse('1'.repeat(65)).success).toBe(false);
  });
});

// ─── 2. Other ids stay uuids ────────────────────────────────────────────────

type AnyTool = ToolDefinition<never>;
const field = (tool: AnyTool, key: string) => tool.inputSchema[key] as z.ZodTypeAny;

/** Ids of other records on tools that also take submission ids: real uuids. */
const UUID_FIELDS: Array<[AnyTool, string]> = [
  [graderAssignTool, 'grader_id'],
  [graderUnassignTool, 'grader_id'],
  [graderAssignBulkTool, 'assignment_id'],
  [graderAssignBulkTool, 'template_assignment_id'],
  [gradeRemoveTool, 'grade_id'],
  [submissionLateOverrideTool, 'assignment_id'],
  [listSubmissionsTool, 'repository_id'],
  [listSubmissionsTool, 'assignment_id'],
  [listSubmissionsTool, 'grader_id'],
  [regradeResolveTool, 'regrade_request_id'],
].map(([tool, key]) => [tool as unknown as AnyTool, key as string]);

describe('ids of other records', () => {
  it.each(UUID_FIELDS.map(([t, k]) => [`${t.name}.${k}`, t, k] as const))(
    '%s stays a uuid',
    (_, tool, key) => {
      expect(field(tool, key).safeParse(UUID_ID).success).toBe(true);
      expect(field(tool, key).safeParse(NUMERIC_ID).success).toBe(false);
    }
  );
});

// ─── 3. Handlers with a numeric id ──────────────────────────────────────────

function ctxFor(role: 'OWNER' | 'ASSISTANT' | 'STUDENT', userId: string): ToolContext {
  return {
    viewer: { userId, clientId: 'c', scopes: new Set(['read', 'write']) },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { slug: 'w26', git_organization: { login: 'cs-org' }, settings: {} },
    },
  } as unknown as ToolContext;
}

describe('get_submission with a numeric id', () => {
  const row = {
    id: NUMERIC_ID,
    status: 'OPEN',
    assignment: { id: 'a-1', title: 'HW1', grades_released: false },
    git_repo: {
      id: 'r-1',
      name: 'hw1-alice',
      repository_id: 'repo-1',
      repository: { id: 'repo-1', title: 'HW' },
      student: { id: 'stu-1', login: 'alice', name: 'Alice', image: null },
      team: null,
    },
    grades: [],
    graders: [],
    analytics_snapshot: null,
  };

  it('reads the submission inside the classroom and returns its numeric id', async () => {
    setPrismaRows({
      gitRepoAssignment: {
        findFirst: ({ where }: { where: { id: string; git_repo: { classroom_id: string } } }) =>
          where.id === NUMERIC_ID && where.git_repo.classroom_id === 'class-1' ? row : null,
      },
    });

    const payload = parse(
      await getSubmissionTool.handler(
        { classroom: 'cs-org/w26', submission_id: NUMERIC_ID },
        ctxFor('ASSISTANT', 'ta-1')
      )
    );

    expect(payload).toMatchObject({ id: NUMERIC_ID, git_repo_name: 'hw1-alice' });
    const [call] = prismaCallsFor('gitRepoAssignment', 'findFirst');
    expect((call.args as { where: unknown }).where).toEqual({
      id: NUMERIC_ID,
      git_repo: { classroom_id: 'class-1' },
    });
  });

  it('a numeric id outside the classroom is not_found', async () => {
    await expect(
      getSubmissionTool.handler(
        { classroom: 'cs-org/w26', submission_id: '9999999999' },
        ctxFor('ASSISTANT', 'ta-1')
      )
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('extension_purchase with a numeric id', () => {
  it("buys hours on the student's own ISSUE-mode submission", async () => {
    mocks.graFindById.mockResolvedValue({
      id: NUMERIC_ID,
      git_repo: { classroom_id: 'class-1', student_id: 'stu-1' },
    });
    mocks.purchaseExtensionHours.mockResolvedValue({ id: 'tx-1', amount: -4 });

    await extensionPurchaseTool.handler(
      { classroom: 'cs-org/w26', git_repo_assignment_id: NUMERIC_ID, hours: 2 },
      ctxFor('STUDENT', 'stu-1')
    );

    expect(mocks.graFindById).toHaveBeenCalledWith(NUMERIC_ID);
    expect(mocks.purchaseExtensionHours).toHaveBeenCalledWith(
      expect.objectContaining({ gitRepoAssignmentId: NUMERIC_ID, studentId: 'stu-1' })
    );
  });

  it("refuses another student's numeric submission with the uniform not_found", async () => {
    mocks.graFindById.mockResolvedValue({
      id: NUMERIC_ID,
      git_repo: { classroom_id: 'class-1', student_id: 'someone-else' },
    });

    await expect(
      extensionPurchaseTool.handler(
        { classroom: 'cs-org/w26', git_repo_assignment_id: NUMERIC_ID, hours: 2 },
        ctxFor('STUDENT', 'stu-1')
      )
    ).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Submission not found in this classroom',
    });
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
  });
});
