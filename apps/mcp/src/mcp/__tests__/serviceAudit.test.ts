/**
 * The grading tools, through the registry: the shared service writes each
 * change's audit row, so a tool passes the caller as the actor (`serviceActor`:
 * the enforcing role, its tool name, `via: 'mcp'`, the client, the admin under
 * View as) and writes no row of its own. When the service reports a row it owed
 * but could not write, the call answers as it would have, plus
 * `audit_incomplete: true` (`noteServiceAudit`); a call whose service wrote its
 * row, or owed none, carries no such field.
 *
 * The real tools run on a real McpServer over the SDK's in-memory transport,
 * with `@classmoji/services` faked, as in auditIncomplete.test.ts.
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../registry.ts';

const mocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  classroomFindAll: vi.fn(),
  classroomFindById: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  submissionFindById: vi.fn(),
  assignmentFindById: vi.fn(),
  emojiMappings: vi.fn(),
  gradesOf: vi.fn(),
  gradeFindById: vi.fn(),
  addGrade: vi.fn(),
  removeGrade: vi.fn(),
  addGrader: vi.fn(),
  removeGrader: vi.fn(),
  assignGraders: vi.fn(),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

vi.mock('@classmoji/services', () => ({
  AssignGradersError: class AssignGradersError extends Error {},
  HelperService: {
    addGradeToGitRepoAssignment: (...a: unknown[]) => mocks.addGrade(...a),
    removeGradeFromGitRepoAssignment: (...a: unknown[]) => mocks.removeGrade(...a),
    addGraderInClassroom: (...a: unknown[]) => mocks.addGrader(...a),
    removeGraderInClassroom: (...a: unknown[]) => mocks.removeGrader(...a),
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
    gitRepoAssignment: { findById: (...a: unknown[]) => mocks.submissionFindById(...a) },
    assignment: { findById: (...a: unknown[]) => mocks.assignmentFindById(...a) },
    emojiMapping: { findByClassroomId: (...a: unknown[]) => mocks.emojiMappings(...a) },
    assignmentGrade: {
      findByAssignmentId: (...a: unknown[]) => mocks.gradesOf(...a),
      findById: (...a: unknown[]) => mocks.gradeFindById(...a),
    },
    gitRepoAssignmentGrader: {
      assignGradersToAssignment: (...a: unknown[]) => mocks.assignGraders(...a),
    },
  },
}));

const grades = await import('../../tools/grades.ts');
const graders = await import('../../tools/graders.ts');
const { buildMcpServer, registerToolDefinition } = await import('../registry.ts');
const { resetRateLimits } = await import('../rateLimit.ts');

const SUBMISSION = '11111111-1111-4111-8111-111111111111';
const GRADE = '22222222-2222-4222-8222-222222222222';
const GRADER = '33333333-3333-4333-8333-333333333333';
const ASSIGNMENT = '44444444-4444-4444-8444-444444444444';
const CLIENT = 'service-audit-test';

const WRITTEN = { written: 1, missed: 0 };
const MISSED = { written: 0, missed: 1 };
const NONE = { written: 0, missed: 0 };

beforeAll(() => {
  for (const def of [
    grades.gradeAddTool,
    grades.gradeRemoveTool,
    grades.gradeRemoveAllTool,
    graders.graderAssignTool,
    graders.graderUnassignTool,
    graders.graderAssignBulkTool,
  ]) {
    registerToolDefinition(def as unknown as ToolDefinition<never>);
  }
});

let viewerSeq = 0;
let userId = '';

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  resetRateLimits();
  mocks.auditCreate.mockResolvedValue({ id: 'row' });
  mocks.classroomFindAll.mockResolvedValue([{ id: 'class-1', status: 'ACTIVE', slug: 'c' }]);
  mocks.classroomFindById.mockResolvedValue({
    id: 'class-1',
    git_organization: { login: 'org', provider: 'GITHUB' },
  });
  mocks.findByClassroomAndUser.mockImplementation(
    async (_c: string, _u: string, roles: string[] | null) =>
      roles && !roles.includes('OWNER') ? null : { id: 'm-owner', role: 'OWNER' }
  );
  mocks.submissionFindById.mockResolvedValue({
    id: SUBMISSION,
    git_repo: { classroom_id: 'class-1', student_id: 'student-1', team_id: null },
  });
  mocks.assignmentFindById.mockResolvedValue({
    id: ASSIGNMENT,
    repository: { classroom_id: 'class-1' },
  });
  mocks.emojiMappings.mockResolvedValue([{ emoji: '🟢' }]);
  mocks.gradesOf.mockResolvedValue([{ id: GRADE, emoji: '🟢', grader: null }]);
  mocks.gradeFindById.mockResolvedValue({
    id: GRADE,
    emoji: '🟢',
    git_repo_assignment_id: SUBMISSION,
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

interface Case {
  tool: string;
  args: Record<string, unknown>;
  /** The service mock the tool calls, answering with `audit`. */
  answer: (audit: typeof WRITTEN) => void;
  service: () => ReturnType<typeof vi.fn>;
  /** What the call answers either way. */
  payload: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    tool: 'grade_add',
    args: { classroom: 'o/c', git_repo_assignment_id: SUBMISSION, emoji: '🟢' },
    answer: audit =>
      mocks.addGrade.mockResolvedValue({
        removed: [],
        created: { id: GRADE, emoji: '🟢' },
        audit,
      }),
    service: () => mocks.addGrade,
    payload: {
      success: true,
      git_repo_assignment_id: SUBMISSION,
      deduplicated: false,
      grades: [{ id: GRADE, emoji: '🟢', grader: null }],
    },
  },
  {
    tool: 'grade_remove',
    args: { classroom: 'o/c', git_repo_assignment_id: SUBMISSION, grade_id: GRADE },
    answer: audit => mocks.removeGrade.mockResolvedValue({ removed: true, audit }),
    service: () => mocks.removeGrade,
    payload: { success: true, removed: { id: GRADE, emoji: '🟢' }, already_removed: false },
  },
  {
    tool: 'grade_remove_all',
    args: { classroom: 'o/c', git_repo_assignment_id: SUBMISSION },
    answer: audit => mocks.removeGrade.mockResolvedValue({ removed: true, audit }),
    service: () => mocks.removeGrade,
    payload: { success: true, removed_count: 1 },
  },
  {
    tool: 'grader_assign',
    args: { classroom: 'o/c', git_repo_assignment_id: SUBMISSION, grader_id: GRADER },
    answer: audit =>
      mocks.addGrader.mockResolvedValue({ status: 'added', graderLogin: 'ta', audit }),
    service: () => mocks.addGrader,
    payload: { success: true, grader: 'ta', git_repo_assignment_id: SUBMISSION },
  },
  {
    tool: 'grader_unassign',
    args: { classroom: 'o/c', git_repo_assignment_id: SUBMISSION, grader_id: GRADER },
    answer: audit =>
      mocks.removeGrader.mockResolvedValue({ status: 'removed', graderLogin: 'ta', audit }),
    service: () => mocks.removeGrader,
    payload: { success: true, removed_grader: 'ta' },
  },
  {
    tool: 'grader_assign_bulk',
    args: { classroom: 'o/c', assignment_id: ASSIGNMENT, method: 'RANDOM' },
    answer: audit =>
      mocks.assignGraders.mockResolvedValue({ numAssignmentsToAddGradersTo: 3, audit }),
    service: () => mocks.assignGraders,
    payload: { success: true, queued: true, submissions_assigned: 3, method: 'RANDOM' },
  },
];

describe.each(CASES)('$tool', ({ tool, args, answer, service, payload }) => {
  it('passes the caller as the actor and writes no row of its own', async () => {
    answer(WRITTEN);
    const result = await call(tool, args);

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual(payload);
    expect(service()).toHaveBeenCalled();
    for (const [arg] of service().mock.calls) {
      expect(arg).toMatchObject({ actor: actorFor(tool) });
    }
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('answers the same, with audit_incomplete, when the service missed its row', async () => {
    answer(MISSED);
    const result = await call(tool, args);

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual({ ...payload, audit_incomplete: true });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('adds nothing when the call owed no row', async () => {
    answer(NONE);
    const result = await call(tool, args);
    expect(parse(result)).not.toHaveProperty('audit_incomplete');
  });
});

describe('under View as', () => {
  it('the actor names the admin viewing as the caller', async () => {
    CASES[0].answer(WRITTEN);
    await call(CASES[0].tool, CASES[0].args, { impersonatedBy: 'admin-1' });
    expect(mocks.addGrade.mock.calls[0][0]).toMatchObject({
      actor: { ...actorFor('grade_add'), impersonatedBy: 'admin-1' },
    });
  });
});
