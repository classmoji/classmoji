/**
 * Unit tests for extension_purchase: the exactly-one target rule, the quiz
 * path (assignment_id), the uniform not_found for every quiz a student may not
 * see, the REPO pointer, who may buy on which submission (own repo or a team
 * they are on; anything else is the not-found an unknown id gets), the
 * mapping of the service's refusals, the audit row,
 * and the description's byte budget. `@classmoji/services` is mocked
 * factory-style; the messages fed to the error mapping are the ones
 * token.purchaseQuizExtensionHours / updateExtension actually throw.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  assignmentFindById: vi.fn(),
  quizzesVisible: vi.fn(),
  graFindById: vi.fn(),
  isTeamMember: vi.fn(),
  purchaseExtensionHours: vi.fn(),
  purchaseQuizExtensionHours: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

vi.mock('@classmoji/services', () => ({
  HelperService: {},
  ClassmojiService: {
    assignment: { findById: (...a: unknown[]) => mocks.assignmentFindById(...a) },
    entitlement: { quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a) },
    gitRepoAssignment: { findById: (...a: unknown[]) => mocks.graFindById(...a) },
    teamMembership: { isTeamMember: (...a: unknown[]) => mocks.isTeamMember(...a) },
    token: {
      purchaseExtensionHours: (...a: unknown[]) => mocks.purchaseExtensionHours(...a),
      purchaseQuizExtensionHours: (...a: unknown[]) => mocks.purchaseQuizExtensionHours(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { extensionPurchaseTool, DOMAIN_ERROR_PREFIXES, QUIZ_NOT_FOUND_PREFIXES } =
  await import('../extensions.ts');

const QUIZ_ASSIGNMENT = '11111111-1111-4111-8111-111111111111';
const REPO_ASSIGNMENT = '22222222-2222-4222-8222-222222222222';
const SUBMISSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FUTURE = new Date(Date.now() + 24 * 3_600_000);

const CTX: ToolContext = {
  viewer: { userId: 'stu-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'STUDENT',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'STUDENT' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

/** A QUIZ assignment open to students in class-1, as assignment.findById returns it. */
function quizAssignment(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const buyQuiz = (extra: Record<string, unknown> = {}) =>
  extensionPurchaseTool.handler(
    { classroom: 'org/w26', assignment_id: QUIZ_ASSIGNMENT, hours: 2, ...extra },
    CTX
  );

/** The error a call rejects with, for comparing two refusals field by field. */
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as { kind?: string; message?: string };
    return { kind: e.kind, message: e.message };
  }
  throw new Error('expected a rejection');
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.quizzesVisible.mockResolvedValue(true);
  mocks.isTeamMember.mockResolvedValue(false);
  mocks.assignmentFindById.mockResolvedValue(quizAssignment());
  mocks.purchaseQuizExtensionHours.mockResolvedValue({
    id: 'tx-1',
    hours_purchased: 2,
    amount: -4,
    balance_after: 6,
  });
});

describe('extension_purchase: exactly one target', () => {
  it('refuses a call with neither id, before any lookup', async () => {
    await expect(
      extensionPurchaseTool.handler({ classroom: 'org/w26', hours: 1 }, CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('exactly one of git_repo_assignment_id'),
    });
    expect(mocks.assignmentFindById).not.toHaveBeenCalled();
    expect(mocks.graFindById).not.toHaveBeenCalled();
  });

  it('refuses a call with both ids, before any lookup', async () => {
    await expect(buyQuiz({ git_repo_assignment_id: SUBMISSION })).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.assignmentFindById).not.toHaveBeenCalled();
    expect(mocks.graFindById).not.toHaveBeenCalled();
    expect(mocks.purchaseQuizExtensionHours).not.toHaveBeenCalled();
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
  });

  it('declares both ids optional in the flat input shape, assignment_id as a uuid', () => {
    const shape = extensionPurchaseTool.inputSchema as Record<
      string,
      { safeParse: (v: unknown) => { success: boolean } }
    >;
    expect(shape.git_repo_assignment_id.safeParse(undefined).success).toBe(true);
    expect(shape.assignment_id.safeParse(undefined).success).toBe(true);
    expect(shape.assignment_id.safeParse(QUIZ_ASSIGNMENT).success).toBe(true);
    expect(shape.assignment_id.safeParse('5482151816').success).toBe(false);
  });
});

describe('extension_purchase on a quiz (assignment_id)', () => {
  it('buys hours for the caller, in the authorized classroom, and says what it bought', async () => {
    const result = parse(await buyQuiz());

    expect(mocks.purchaseQuizExtensionHours).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: 'stu-1',
      assignmentId: QUIZ_ASSIGNMENT,
      hours: 2,
    });
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      assignment_id: QUIZ_ASSIGNMENT,
      transaction: { id: 'tx-1', hours_purchased: 2, amount: -4, balance_after: 6 },
    });
  });

  it('writes one TOKEN_PURCHASE audit row naming the assignment', async () => {
    await buyQuiz();

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0]).toEqual({
      user_id: 'stu-1',
      classroom_id: 'class-1',
      role: 'STUDENT',
      resource_type: 'TOKEN_PURCHASE',
      resource_id: 'tx-1',
      action: 'CREATE',
      data: { tool: 'extension_purchase', assignment_id: QUIZ_ASSIGNMENT, hours: 2, amount: -4 },
    });
  });

  it('answers every quiz the student may not see with the same not_found as an unknown id', async () => {
    mocks.assignmentFindById.mockResolvedValueOnce(null);
    const unknown = await rejection(buyQuiz());

    const cases: Array<[string, () => void]> = [
      [
        'another classroom',
        () =>
          mocks.assignmentFindById.mockResolvedValueOnce(
            quizAssignment({ module: { id: 'mod-x', classroom_id: 'class-2' } })
          ),
      ],
      [
        'a draft',
        () =>
          mocks.assignmentFindById.mockResolvedValueOnce(quizAssignment({ is_published: false })),
      ],
      [
        'not open yet',
        () =>
          mocks.assignmentFindById.mockResolvedValueOnce(quizAssignment({ release_at: FUTURE })),
      ],
      ['quizzes hidden', () => mocks.quizzesVisible.mockResolvedValueOnce(false)],
    ];

    expect(unknown).toEqual({
      kind: 'not_found',
      message: 'Assignment not found in this classroom',
    });
    for (const [label, arrange] of cases) {
      arrange();
      expect(await rejection(buyQuiz()), label).toEqual(unknown);
    }
    expect(mocks.purchaseQuizExtensionHours).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('points a REPO assignment id at git_repo_assignment_id', async () => {
    mocks.assignmentFindById.mockResolvedValue(
      quizAssignment({
        id: REPO_ASSIGNMENT,
        type: 'REPO',
        quiz: null,
        repository: { classroom_id: 'class-1', is_published: true },
      })
    );

    await expect(buyQuiz({ assignment_id: REPO_ASSIGNMENT })).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('git_repo_assignment_id'),
    });
    expect(mocks.purchaseQuizExtensionHours).not.toHaveBeenCalled();
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
  });

  it('gives an unpublished REPO assignment the uniform not_found, not the pointer', async () => {
    mocks.assignmentFindById.mockResolvedValue(
      quizAssignment({
        id: REPO_ASSIGNMENT,
        type: 'REPO',
        quiz: null,
        repository: { classroom_id: 'class-1', is_published: false },
      })
    );

    await expect(buyQuiz({ assignment_id: REPO_ASSIGNMENT })).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Assignment not found in this classroom',
    });
  });

  it('refuses a FORM assignment the student can see', async () => {
    mocks.assignmentFindById.mockResolvedValue(
      quizAssignment({ type: 'FORM', quiz: null, form: { status: 'PUBLISHED' } })
    );

    await expect(buyQuiz()).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('Extensions are unavailable'),
    });
    expect(mocks.purchaseQuizExtensionHours).not.toHaveBeenCalled();
  });

  it("turns the service's not-found refusal into the uniform not_found", async () => {
    mocks.purchaseQuizExtensionHours.mockRejectedValue(new Error('Quiz assignment not found.'));

    expect(await rejection(buyQuiz())).toEqual({
      kind: 'not_found',
      message: 'Assignment not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    'Invalid hours: Must be a positive whole number.',
    'Extensions are unavailable: this assignment has no deadline.',
    'Extensions are unavailable: only students buy extension hours.',
    'Token cost not configured for this assignment.',
    'Insufficient token balance. Current balance: 1, attempting to spend: 4',
  ])('surfaces the refusal %j as invalid_params, verbatim', async message => {
    mocks.purchaseQuizExtensionHours.mockRejectedValue(new Error(message));

    expect(await rejection(buyQuiz())).toEqual({ kind: 'invalid_params', message });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('lets any other failure through untouched, so its text never reaches the client as a refusal', async () => {
    const boom = new Error('connection reset');
    mocks.purchaseQuizExtensionHours.mockRejectedValue(boom);

    await expect(buyQuiz()).rejects.toBe(boom);
  });

  it('keeps the not-found and refusal prefixes apart', () => {
    for (const prefix of QUIZ_NOT_FOUND_PREFIXES) {
      expect(DOMAIN_ERROR_PREFIXES.some(p => prefix.startsWith(p))).toBe(false);
    }
  });
});

describe('extension_purchase on a submission (git_repo_assignment_id)', () => {
  it('still buys on the caller’s own submission and audits the submission id', async () => {
    mocks.graFindById.mockResolvedValue({
      id: SUBMISSION,
      git_repo: { classroom_id: 'class-1', student_id: 'stu-1' },
    });
    mocks.purchaseExtensionHours.mockResolvedValue({
      id: 'tx-2',
      hours_purchased: 1,
      amount: -2,
      balance_after: 3,
    });

    const result = parse(
      await extensionPurchaseTool.handler(
        { classroom: 'org/w26', git_repo_assignment_id: SUBMISSION, hours: 1 },
        CTX
      )
    );

    expect(mocks.purchaseExtensionHours).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: 'stu-1',
      gitRepoAssignmentId: SUBMISSION,
      hours: 1,
    });
    expect(mocks.purchaseQuizExtensionHours).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, git_repo_assignment_id: SUBMISSION });
    expect(mocks.auditCreate.mock.calls[0][0].data).toEqual({
      tool: 'extension_purchase',
      git_repo_assignment_id: SUBMISSION,
      hours: 1,
      amount: -2,
    });
  });

  it('a quiz refusal message on the submission path is not laundered into not_found', async () => {
    mocks.graFindById.mockResolvedValue({
      id: SUBMISSION,
      git_repo: { classroom_id: 'class-1', student_id: 'stu-1' },
    });
    const boom = new Error('Quiz assignment not found.');
    mocks.purchaseExtensionHours.mockRejectedValue(boom);

    await expect(
      extensionPurchaseTool.handler(
        { classroom: 'org/w26', git_repo_assignment_id: SUBMISSION, hours: 1 },
        CTX
      )
    ).rejects.toBe(boom);
  });
});

describe('extension_purchase: whose submission (own repo or a team the caller is on)', () => {
  const submission = (gitRepo: {
    classroom_id?: string;
    student_id: string | null;
    team_id: string | null;
  }) => ({
    id: SUBMISSION,
    git_repo: { classroom_id: 'class-1', ...gitRepo },
  });

  const buySubmission = () =>
    extensionPurchaseTool.handler(
      { classroom: 'org/w26', git_repo_assignment_id: SUBMISSION, hours: 2 },
      CTX
    );

  const SUBMISSION_NOT_FOUND = {
    kind: 'not_found',
    message: 'Submission not found in this classroom',
  };

  beforeEach(() => {
    mocks.purchaseExtensionHours.mockResolvedValue({
      id: 'tx-3',
      hours_purchased: 2,
      amount: -6,
      balance_after: 94,
    });
  });

  it("sells hours on the caller's own repo without a team lookup", async () => {
    mocks.graFindById.mockResolvedValue(submission({ student_id: 'stu-1', team_id: null }));

    expect(parse(await buySubmission()).success).toBe(true);
    expect(mocks.isTeamMember).not.toHaveBeenCalled();
    expect(mocks.purchaseExtensionHours).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: 'stu-1',
      gitRepoAssignmentId: SUBMISSION,
      hours: 2,
    });
  });

  it("sells hours on a team's repo to a member, paid from the member's own balance", async () => {
    mocks.graFindById.mockResolvedValue(submission({ student_id: null, team_id: 'team-1' }));
    mocks.isTeamMember.mockResolvedValue(true);

    expect(parse(await buySubmission()).success).toBe(true);
    expect(mocks.isTeamMember).toHaveBeenCalledWith('team-1', 'stu-1');
    expect(mocks.purchaseExtensionHours).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: 'stu-1', gitRepoAssignmentId: SUBMISSION })
    );
  });

  it("refuses a team's repo to a non-member with the not-found error", async () => {
    mocks.graFindById.mockResolvedValue(submission({ student_id: null, team_id: 'team-1' }));

    expect(await rejection(buySubmission())).toEqual(SUBMISSION_NOT_FOUND);
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses a member of another team, asking about the repo's own team", async () => {
    // The caller is on team-2; the submission belongs to team-1.
    mocks.isTeamMember.mockImplementation(
      async (teamId: string, userId: string) => teamId === 'team-2' && userId === 'stu-1'
    );
    mocks.graFindById.mockResolvedValue(submission({ student_id: null, team_id: 'team-1' }));

    expect(await rejection(buySubmission())).toEqual(SUBMISSION_NOT_FOUND);
    expect(mocks.isTeamMember).toHaveBeenCalledWith('team-1', 'stu-1');
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses a classmate's individual repo the same way", async () => {
    mocks.graFindById.mockResolvedValue(submission({ student_id: 'stu-2', team_id: null }));

    expect(await rejection(buySubmission())).toEqual(SUBMISSION_NOT_FOUND);
    expect(mocks.isTeamMember).not.toHaveBeenCalled();
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
  });

  it('refuses a submission from another classroom the same way', async () => {
    mocks.graFindById.mockResolvedValue(
      submission({ classroom_id: 'class-2', student_id: 'stu-1', team_id: null })
    );

    expect(await rejection(buySubmission())).toEqual(SUBMISSION_NOT_FOUND);
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
  });
});

describe('extension_purchase definition', () => {
  it('keeps its description under the 1,500-byte client cut and names both ids', () => {
    const description = extensionPurchaseTool.description;
    expect(Buffer.byteLength(description, 'utf8')).toBeLessThan(1500);
    expect(description).toContain('exactly one of');
    expect(description).toContain('git_repo_assignment_id');
    expect(description).toContain('assignment_id for a quiz');
    expect(description).toContain('team');
    expect(description).toContain('net of refunds');
  });

  it('stays a STUDENT write with its annotations', () => {
    expect(extensionPurchaseTool.roles).toEqual(['STUDENT']);
    expect(extensionPurchaseTool.scope).toBe('write');
    expect(extensionPurchaseTool.annotations).toEqual({ destructive: false });
  });
});
