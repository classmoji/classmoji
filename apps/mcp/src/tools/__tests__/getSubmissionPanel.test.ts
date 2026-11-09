/**
 * get_submission carries what the gradebook's submission panel shows (MCP
 * parity): a team's members, the submitted commit in push mode, the
 * autograding run on it (else the latest), and the open regrade request. The
 * read stays scoped to the caller's classroom, and the queries are checked
 * against the real schema by the Prisma stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);
vi.mock('@classmoji/services', () => ({
  AssignGradersError: class extends Error {},
  HelperService: {},
  ClassmojiService: {},
}));
vi.mock('@trigger.dev/sdk', () => ({ tasks: {}, runs: {} }));

const { getSubmissionTool } = await import('../reads.ts');
const { prismaCallsFor, resetPrismaStub, setPrismaRows } =
  await import('../../__tests__/prismaSchemaStub.ts');

const DEADLINE = new Date('2026-10-01T23:59:00Z');
const HOUR = 3_600_000;

const ROW = {
  id: 'sub-1',
  status: 'CLOSED',
  closed_at: new Date(DEADLINE.getTime() - HOUR),
  is_late_override: false,
  assignment: {
    id: 'a-1',
    title: 'Project',
    submission_mode: 'REPO',
    student_deadline: DEADLINE,
    grades_released: false,
    weight: 15,
    is_extra_credit: false,
    module: { title: 'Week 3' },
  },
  token_transactions: [],
  git_repo: {
    id: 'repo-1',
    name: 'project-rockets',
    repository: { id: 'r-1', title: 'Project' },
    student: null,
    team: {
      id: 'team-1',
      name: 'Rockets',
      memberships: [
        {
          user: {
            id: 'ada',
            name: 'Ada',
            image: null,
            accounts: [
              { provider_id: 'github', username: 'ada-gh', account_id: '1' },
              { provider_id: 'gitlab', username: 'ada-gl', account_id: '2' },
            ],
          },
        },
      ],
    },
  },
  grades: [],
  graders: [],
  analytics_snapshot: {
    commits: [
      {
        sha: 'aaa1111',
        ts: new Date(DEADLINE.getTime() - 2 * HOUR).toISOString(),
        message: 'done',
      },
      { sha: 'bbb2222', ts: new Date(DEADLINE.getTime() + HOUR).toISOString(), message: 'late' },
    ],
  },
  regrade_requests: [
    {
      id: 'req-1',
      student_comment: 'Please look again',
      previous_grade: ['star'],
      created_at: new Date('2026-10-03T00:00:00Z'),
    },
  ],
};

const ctx = {
  viewer: { userId: 'teacher-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'TEACHER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'TEACHER' },
    classroom: {
      slug: 'w26',
      git_organization: { login: 'cs-org', provider: 'GITHUB' },
      settings: {},
    },
  },
} as unknown as ToolContext;

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

beforeEach(() => {
  resetPrismaStub();
  setPrismaRows({
    gitRepoAssignment: {
      findFirst: ({ where }: { where: { id: string; git_repo: { classroom_id: string } } }) =>
        where.id === 'sub-1' && where.git_repo.classroom_id === 'class-1' ? ROW : null,
    },
    autogradingResult: {
      findFirst: ({ where }: { where: { commit_sha?: string } }) =>
        where.commit_sha === 'aaa1111'
          ? {
              id: 'ag-1',
              commit_sha: 'aaa1111',
              run_id: '42',
              conclusion: 'success',
              total_tests: 4,
              passed_tests: 4,
              reported_at: new Date('2026-10-01T22:00:00Z'),
              details: { output: 'per-test logs' },
            }
          : null,
    },
  });
});

describe('get_submission — what the submission panel shows', () => {
  it('adds the team members, submitted commit, autograding run and open request', async () => {
    const payload = parse(
      await getSubmissionTool.handler({ classroom: 'cs-org/w26', submission_id: 'sub-1' }, ctx)
    );

    expect(payload.team_members).toEqual([
      { id: 'ada', name: 'Ada', login: 'ada-gh', avatar: null },
    ]);
    expect(payload.assignment).toMatchObject({
      weight: 15,
      is_extra_credit: false,
      module_title: 'Week 3',
    });
    // Submitted an hour before the deadline: not late.
    expect(payload.num_late_hours).toBe(0);
    expect(payload.submitted_commit).toMatchObject({ sha: 'aaa1111', message: 'done' });
    expect(payload.autograding).toEqual({
      conclusion: 'success',
      passed_tests: 4,
      total_tests: 4,
      commit_sha: 'aaa1111',
      reported_at: '2026-10-01T22:00:00.000Z',
      run_url: 'https://github.com/cs-org/project-rockets/actions/runs/42',
    });
    expect(payload.open_regrade_request).toEqual({
      id: 'req-1',
      student_comment: 'Please look again',
      previous_grade: ['star'],
      created_at: '2026-10-03T00:00:00.000Z',
    });

    // Only the open request, newest first; the run on the submitted commit first.
    const [read] = prismaCallsFor('gitRepoAssignment', 'findFirst');
    expect(
      (read.args as { include: { regrade_requests: { where: unknown } } }).include.regrade_requests
        .where
    ).toEqual({ status: 'IN_REVIEW' });
    const runs = prismaCallsFor('autogradingResult', 'findFirst');
    expect((runs[0].args as { where: unknown }).where).toEqual({
      git_repo_id: 'repo-1',
      commit_sha: 'aaa1111',
    });
  });

  it('falls back to the latest run, and reads null fields when there is nothing to show', async () => {
    setPrismaRows({
      gitRepoAssignment: {
        findFirst: () => ({
          ...ROW,
          git_repo: { ...ROW.git_repo, team: null },
          analytics_snapshot: null,
          regrade_requests: [],
        }),
      },
      autogradingResult: { findFirst: () => null },
    });

    const payload = parse(
      await getSubmissionTool.handler({ classroom: 'cs-org/w26', submission_id: 'sub-1' }, ctx)
    );

    expect(payload).toMatchObject({
      team_members: null,
      submitted_commit: null,
      autograding: null,
      open_regrade_request: null,
    });
    const runs = prismaCallsFor('autogradingResult', 'findFirst');
    // No commit to match: the latest run reported by the submission time.
    expect(runs.map(r => (r.args as { where: unknown }).where)).toEqual([
      { git_repo_id: 'repo-1', reported_at: { lte: new Date(DEADLINE.getTime() - HOUR) } },
    ]);
  });

  it("is not_found for another classroom's submission", async () => {
    await expect(
      getSubmissionTool.handler({ classroom: 'cs-org/w26', submission_id: 'sub-other' }, ctx)
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it("names team members by the classroom's provider: Gitlab usernames on a Gitlab class", async () => {
    const gitlabCtx = {
      ...ctx,
      classroom: {
        ...(ctx as unknown as { classroom: Record<string, unknown> }).classroom,
        classroom: {
          slug: 'w26',
          git_organization: { login: 'cs-group', provider: 'GITLAB' },
          settings: {},
        },
      },
    } as unknown as ToolContext;

    const payload = parse(
      await getSubmissionTool.handler(
        { classroom: 'cs-group/w26', submission_id: 'sub-1' },
        gitlabCtx
      )
    );

    expect(payload.team_members).toEqual([
      { id: 'ada', name: 'Ada', login: 'ada-gl', avatar: null },
    ]);
  });

  it('counts late hours from the submission time, net of extension hours', async () => {
    setPrismaRows({
      gitRepoAssignment: {
        findFirst: () => ({
          ...ROW,
          closed_at: new Date(DEADLINE.getTime() + 5.5 * HOUR),
          token_transactions: [{ hours_purchased: 2 }],
        }),
      },
      autogradingResult: { findFirst: () => null },
    });

    const payload = parse(
      await getSubmissionTool.handler({ classroom: 'cs-org/w26', submission_id: 'sub-1' }, ctx)
    );

    expect(payload.num_late_hours).toBe(3);
  });
});
