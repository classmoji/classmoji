/**
 * grader_assign / grader_unassign — the web's grader rule, end to end.
 *
 * The tools call HelperService.addGraderInClassroom / removeGraderInClassroom,
 * the helpers the web repository and assignment pages use. This file runs the
 * REAL helpers and services against the schema-validating Prisma stub (every
 * query is checked against the generated schema), with only the git layer
 * mocked, so the rule is proven through the tool rather than assumed from a
 * mocked helper:
 *   - the grader must be an ASSISTANT or TEACHER membership with is_grader and
 *     a login (gitRepoAssignmentGrader.findEligibleGrader). An OWNER — even
 *     one carrying is_grader — and staff without is_grader are refused;
 *   - the submission is looked up inside the classroom BEFORE the grader, so a
 *     foreign id is the uniform not_found with no membership lookup at all;
 *   - ISSUE-mode submissions carry the numeric GitHub issue id as their id;
 *   - a submission without an issue number (REPO mode) never reaches GitHub.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { ToolContext } from '../../mcp/registry.ts';

const git = vi.hoisted(() => ({
  addIssueAssignees: vi.fn(),
  removeIssueAssignees: vi.fn(),
}));

// The git layer INSIDE packages/services (the module HelperService imports as
// '../git/index.ts'), as graders.github.test.ts mocks it.
vi.mock('../../../../../packages/services/src/git/index.ts', () => ({
  getGitProvider: () => ({
    addIssueAssignees: git.addIssueAssignees,
    removeIssueAssignees: git.removeIssueAssignees,
  }),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

const { graderAssignTool, graderUnassignTool, GRADER_NOT_ELIGIBLE_MESSAGE } =
  await import('../graders.ts');
const { prismaCallsFor, resetPrismaStub, setPrismaRows } =
  await import('../../__tests__/prismaSchemaStub.ts');

const CLASSROOM_ID = 'class-1';
const GIT_ORG = { id: 'org-1', provider: 'GITHUB', login: 'cs-org' };

/** ISSUE mode: the row id is the GitHub issue id. */
const NUMERIC_SUB = '5482151816';
/** REPO mode: a generated uuid and no issue. */
const REPO_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN_SUB = '9999999999';

const U = {
  owner: '10000000-0000-4000-8000-000000000001',
  taGrader: '10000000-0000-4000-8000-000000000002',
  taPlain: '10000000-0000-4000-8000-000000000003',
  teacherGrader: '10000000-0000-4000-8000-000000000004',
  student: '10000000-0000-4000-8000-000000000005',
  taNoLogin: '10000000-0000-4000-8000-000000000006',
};

interface Membership {
  classroom_id: string;
  user_id: string;
  role: string;
  is_grader: boolean;
  login: string | null;
}

const MEMBERSHIPS: Membership[] = [
  // An OWNER carrying is_grader is still not in the pool: the role decides.
  { classroom_id: CLASSROOM_ID, user_id: U.owner, role: 'OWNER', is_grader: true, login: 'prof' },
  {
    classroom_id: CLASSROOM_ID,
    user_id: U.taGrader,
    role: 'ASSISTANT',
    is_grader: true,
    login: 'ta-g',
  },
  {
    classroom_id: CLASSROOM_ID,
    user_id: U.taPlain,
    role: 'ASSISTANT',
    is_grader: false,
    login: 'ta-p',
  },
  {
    classroom_id: CLASSROOM_ID,
    user_id: U.teacherGrader,
    role: 'TEACHER',
    is_grader: true,
    login: 'tch',
  },
  {
    classroom_id: CLASSROOM_ID,
    user_id: U.student,
    role: 'STUDENT',
    is_grader: true,
    login: 'stu',
  },
  {
    classroom_id: CLASSROOM_ID,
    user_id: U.taNoLogin,
    role: 'ASSISTANT',
    is_grader: true,
    login: null,
  },
];

interface Submission {
  id: string;
  classroom_id: string;
  provider_issue_number: number | null;
  repo_name: string;
  graders: string[];
}

let submissions: Submission[];

const ownerCtx: ToolContext = {
  viewer: { userId: U.owner, clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: CLASSROOM_ID,
    role: 'OWNER',
    status: 'ACTIVE',
    membership: { id: 'm-owner', role: 'OWNER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

type Where = Record<string, unknown>;

function userRow(userId: string) {
  const m = MEMBERSHIPS.find(x => x.user_id === userId);
  return { id: userId, login: m?.login ?? null };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPrismaStub();
  git.addIssueAssignees.mockResolvedValue(undefined);
  git.removeIssueAssignees.mockResolvedValue(undefined);

  submissions = [
    {
      id: NUMERIC_SUB,
      classroom_id: CLASSROOM_ID,
      provider_issue_number: 42,
      repo_name: 'hw1-alice',
      graders: [],
    },
    {
      id: REPO_SUB,
      classroom_id: CLASSROOM_ID,
      provider_issue_number: null,
      repo_name: 'project-bob',
      graders: [],
    },
    {
      id: FOREIGN_SUB,
      classroom_id: 'class-2',
      provider_issue_number: 7,
      repo_name: 'elsewhere',
      graders: [U.taGrader],
    },
  ];

  setPrismaRows({
    classroom: {
      findUnique: ({ where }: { where: Where }) =>
        where.id === CLASSROOM_ID ? { id: CLASSROOM_ID, git_organization: GIT_ORG } : null,
    },
    // gitRepoAssignment.findByIdInClassroom: id + git_repo.classroom_id.
    gitRepoAssignment: {
      findFirst: ({ where }: { where: Where }) => {
        const repoWhere = where.git_repo as Where;
        const sub = submissions.find(
          s => s.id === where.id && s.classroom_id === repoWhere.classroom_id
        );
        if (!sub) return null;
        return {
          id: sub.id,
          provider_issue_number: sub.provider_issue_number,
          git_repo: { name: sub.repo_name, classroom_id: sub.classroom_id },
          graders: sub.graders.map(graderId => ({
            grader_id: graderId,
            grader: userRow(graderId),
          })),
        };
      },
    },
    // gitRepoAssignmentGrader.findEligibleGrader: role + is_grader in the WHERE.
    classroomMembership: {
      findFirst: ({ where }: { where: Where }) => {
        const roles = (where.role as { in: string[] }).in;
        const m = MEMBERSHIPS.find(
          x =>
            x.classroom_id === where.classroom_id &&
            x.user_id === where.user_id &&
            roles.includes(x.role) &&
            x.is_grader === where.is_grader
        );
        return m ? { ...m, user: userRow(m.user_id) } : null;
      },
    },
  });
});

const graderCreates = () => prismaCallsFor('gitRepoAssignmentGrader', 'create');
const graderDeletes = () => prismaCallsFor('gitRepoAssignmentGrader', 'delete');
const auditCreates = () =>
  prismaCallsFor('auditLog', 'create').map(c => (c.args as { data: Record<string, unknown> }).data);

function assignArgs(submissionId: string, graderId: string) {
  return { classroom: 'org/w26', git_repo_assignment_id: submissionId, grader_id: graderId };
}

describe('grader_assign — who can be a grader (the web rule)', () => {
  it.each([
    ['an OWNER (even one carrying is_grader)', U.owner],
    ['an ASSISTANT with is_grader=false', U.taPlain],
    ['a STUDENT', U.student],
    ['a grader with no stored login', U.taNoLogin],
    ['a user with no membership', '10000000-0000-4000-8000-00000000ffff'],
  ])('refuses %s with invalid_params, touching neither GitHub nor the DB', async (_, userId) => {
    await expect(
      graderAssignTool.handler(assignArgs(NUMERIC_SUB, userId), ownerCtx)
    ).rejects.toMatchObject({ kind: 'invalid_params', message: GRADER_NOT_ELIGIBLE_MESSAGE });

    expect(git.addIssueAssignees).not.toHaveBeenCalled();
    expect(graderCreates()).toHaveLength(0);
    expect(auditCreates()).toHaveLength(0);
  });

  it('names the rule and the fix in the refusal', () => {
    expect(GRADER_NOT_ELIGIBLE_MESSAGE).toMatch(/ASSISTANT or TEACHER/);
    expect(GRADER_NOT_ELIGIBLE_MESSAGE).toMatch(/is_grader/);
    expect(GRADER_NOT_ELIGIBLE_MESSAGE).toMatch(/staff_update/);
  });

  it('assigns an is_grader ASSISTANT on a numeric (ISSUE-mode) submission and mirrors to GitHub', async () => {
    const payload = parse(
      await graderAssignTool.handler(assignArgs(NUMERIC_SUB, U.taGrader), ownerCtx)
    );

    expect(payload).toEqual({ success: true, grader: 'ta-g', git_repo_assignment_id: NUMERIC_SUB });
    // Stored org login, repo name, issue number and grader login.
    expect(git.addIssueAssignees).toHaveBeenCalledWith('cs-org', 'hw1-alice', 42, ['ta-g']);
    expect(graderCreates().map(c => (c.args as { data: unknown }).data)).toEqual([
      { git_repo_assignment_id: NUMERIC_SUB, grader_id: U.taGrader },
    ]);
    expect(auditCreates()).toEqual([
      expect.objectContaining({
        resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
        resource_id: NUMERIC_SUB,
        action: 'CREATE',
        role: 'OWNER',
        data: {
          tool: 'grader_assign',
          value: U.taGrader,
          grader_id: U.taGrader,
          grader_login: 'ta-g',
        },
      }),
    ]);
  });

  it('assigns an is_grader TEACHER on a REPO-mode submission without calling GitHub', async () => {
    const payload = parse(
      await graderAssignTool.handler(assignArgs(REPO_SUB, U.teacherGrader), ownerCtx)
    );

    expect(payload).toMatchObject({ success: true, grader: 'tch' });
    expect(git.addIssueAssignees).not.toHaveBeenCalled();
    expect(graderCreates()).toHaveLength(1);
  });

  it('returns already_assigned for someone already on the submission, writing nothing', async () => {
    submissions[0].graders = [U.taGrader];

    const payload = parse(
      await graderAssignTool.handler(assignArgs(NUMERIC_SUB, U.taGrader), ownerCtx)
    );

    expect(payload).toEqual({
      success: true,
      already_assigned: true,
      grader: 'ta-g',
      git_repo_assignment_id: NUMERIC_SUB,
    });
    expect(git.addIssueAssignees).not.toHaveBeenCalled();
    expect(graderCreates()).toHaveLength(0);
    expect(auditCreates()).toHaveLength(0);
  });

  it('keys the audit dedup on the grader, so two graders on one submission leave two rows', async () => {
    await graderAssignTool.handler(assignArgs(NUMERIC_SUB, U.taGrader), ownerCtx);
    await graderAssignTool.handler(assignArgs(NUMERIC_SUB, U.teacherGrader), ownerCtx);

    // The dedup lookup filters on data.value, so the second call does not
    // match the first row.
    const dedupWheres = prismaCallsFor('auditLog', 'findFirst').map(
      c => (c.args as { where: { AND?: unknown[] } }).where.AND
    );
    expect(dedupWheres).toEqual([
      [{ data: { path: ['value'], equals: U.taGrader } }],
      [{ data: { path: ['value'], equals: U.teacherGrader } }],
    ]);
    expect(auditCreates().map(d => (d.data as { value: string }).value)).toEqual([
      U.taGrader,
      U.teacherGrader,
    ]);
  });
});

describe('grader_assign — callers and races', () => {
  const teacherCtx = {
    ...ownerCtx,
    viewer: { ...ownerCtx.viewer, userId: U.teacherGrader },
    classroom: {
      ...ownerCtx.classroom,
      role: 'TEACHER',
      membership: { id: 'm-teacher', role: 'TEACHER' },
    },
  } as unknown as ToolContext;

  it('a TEACHER caller adds and removes graders, scoped to the same classroom', async () => {
    const added = parse(
      await graderAssignTool.handler(assignArgs(NUMERIC_SUB, U.taGrader), teacherCtx)
    );
    expect(added).toMatchObject({ success: true, grader: 'ta-g' });
    expect(auditCreates()[0]).toMatchObject({ role: 'TEACHER', user_id: U.teacherGrader });

    submissions[0].graders = [U.taGrader];
    const removed = parse(
      await graderUnassignTool.handler(assignArgs(NUMERIC_SUB, U.taGrader), teacherCtx)
    );
    expect(removed).toEqual({ success: true, removed_grader: 'ta-g' });

    // Another classroom's submission is the same not_found for a teacher.
    await expect(
      graderAssignTool.handler(assignArgs(FOREIGN_SUB, U.taGrader), teacherCtx)
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reports already_assigned when a concurrent add wins the insert (P2002)', async () => {
    setPrismaRows({
      gitRepoAssignmentGrader: {
        create: () => {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        },
      },
    });

    const payload = parse(
      await graderAssignTool.handler(assignArgs(REPO_SUB, U.taGrader), ownerCtx)
    );
    expect(payload).toEqual({
      success: true,
      already_assigned: true,
      grader: 'ta-g',
      git_repo_assignment_id: REPO_SUB,
    });
    expect(auditCreates()).toHaveLength(0);
  });
});

describe('grader_assign / grader_unassign — the submission is scoped first', () => {
  it.each([
    ['another classroom', FOREIGN_SUB],
    ['nowhere', '1234567890'],
  ])(
    'a submission id from %s is the uniform not_found, before any grader lookup',
    async (_, id) => {
      for (const tool of [graderAssignTool, graderUnassignTool]) {
        await expect(tool.handler(assignArgs(id, U.taGrader), ownerCtx)).rejects.toMatchObject({
          kind: 'not_found',
          message: 'Submission not found in this classroom',
        });
      }
      expect(prismaCallsFor('classroomMembership')).toHaveLength(0);
      expect(git.addIssueAssignees).not.toHaveBeenCalled();
      expect(git.removeIssueAssignees).not.toHaveBeenCalled();
      expect(graderCreates()).toHaveLength(0);
      expect(graderDeletes()).toHaveLength(0);
      expect(auditCreates()).toHaveLength(0);
    }
  );
});

describe('grader_unassign', () => {
  it('removes an assigned grader from a numeric submission and from the GitHub issue', async () => {
    submissions[0].graders = [U.taGrader];

    const payload = parse(
      await graderUnassignTool.handler(assignArgs(NUMERIC_SUB, U.taGrader), ownerCtx)
    );

    expect(payload).toEqual({ success: true, removed_grader: 'ta-g' });
    expect(git.removeIssueAssignees).toHaveBeenCalledWith('cs-org', 'hw1-alice', 42, ['ta-g']);
    expect(graderDeletes().map(c => (c.args as { where: unknown }).where)).toEqual([
      {
        git_repo_assignment_id_grader_id: {
          git_repo_assignment_id: NUMERIC_SUB,
          grader_id: U.taGrader,
        },
      },
    ]);
    expect(auditCreates()).toEqual([
      expect.objectContaining({
        resource_id: NUMERIC_SUB,
        action: 'DELETE',
        data: {
          tool: 'grader_unassign',
          value: U.taGrader,
          grader_id: U.taGrader,
          grader_login: 'ta-g',
        },
      }),
    ]);
  });

  it('still removes someone assigned who is no longer in the grader pool', async () => {
    submissions[1].graders = [U.taPlain];

    const payload = parse(
      await graderUnassignTool.handler(assignArgs(REPO_SUB, U.taPlain), ownerCtx)
    );

    expect(payload).toEqual({ success: true, removed_grader: 'ta-p' });
    expect(git.removeIssueAssignees).not.toHaveBeenCalled();
    expect(graderDeletes()).toHaveLength(1);
  });

  it('refuses someone not assigned with invalid_params, writing nothing', async () => {
    await expect(
      graderUnassignTool.handler(assignArgs(NUMERIC_SUB, U.taGrader), ownerCtx)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(git.removeIssueAssignees).not.toHaveBeenCalled();
    expect(graderDeletes()).toHaveLength(0);
    expect(auditCreates()).toHaveLength(0);
  });
});

describe('grader tool definitions', () => {
  it('take a numeric or uuid submission id; grader_id stays a uuid', () => {
    for (const tool of [graderAssignTool, graderUnassignTool]) {
      const sub = tool.inputSchema.git_repo_assignment_id as z.ZodTypeAny;
      expect(sub.safeParse(NUMERIC_SUB).success, tool.name).toBe(true);
      expect(sub.safeParse(REPO_SUB).success, tool.name).toBe(true);
      expect(sub.safeParse('gra-1').success, tool.name).toBe(false);
      const grader = tool.inputSchema.grader_id as z.ZodTypeAny;
      expect(grader.safeParse(NUMERIC_SUB).success, tool.name).toBe(false);
    }
  });

  it('state the rule in descriptions under 1,500 bytes', () => {
    expect(graderAssignTool.description).toMatch(/ASSISTANT or\s+TEACHER/);
    expect(graderAssignTool.description).toMatch(/is_grader/);
    expect(graderAssignTool.description).toMatch(/already_assigned/);
    for (const tool of [graderAssignTool, graderUnassignTool]) {
      expect(Buffer.byteLength(tool.description, 'utf8'), tool.name).toBeLessThan(1500);
    }
  });
});
