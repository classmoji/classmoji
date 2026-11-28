/**
 * repo_contributions / repo_contributions_calculate. What must hold:
 *   - classroom X's caller never reads or queues classroom Y's repository, and
 *     the git repos are read by the authorized classroom id, never one sent;
 *   - an author is named only while a member of THIS classroom (a user from
 *     classroom Y, or one who left, shows by git name only);
 *   - individual repos are refused; the calculate call writes one audit row;
 *   - the tool hints: read is read-only, calculate is not destructive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const REPO_X = '11111111-1111-4111-8111-111111111111';
const REPO_Y = '22222222-2222-4222-8222-222222222222';
const REPO_X_SOLO = '33333333-3333-4333-8333-333333333333';

const REPOSITORIES = [
  { id: REPO_X, classroom_id: 'class-x', title: 'project1', type: 'GROUP' },
  { id: REPO_Y, classroom_id: 'class-y', title: 'project1', type: 'GROUP' },
  { id: REPO_X_SOLO, classroom_id: 'class-x', title: 'hw1', type: 'INDIVIDUAL' },
];

const stats = (authors: Array<{ user_id: string | null; git_name: string; lines: number }>) => ({
  version: 1,
  head_sha: 'a'.repeat(40),
  total_lines: authors.reduce((n, a) => n + a.lines, 0),
  starter_lines: 11,
  total_commits: authors.length,
  files_counted: 3,
  files_skipped: 0,
  authors: authors.map(a => ({
    ...a,
    git_email: `${a.git_name}@example.com`,
    commits: 1,
    additions: a.lines,
    deletions: 0,
    first_commit_at: '2026-11-02T10:00:00.000Z',
    last_commit_at: '2026-11-19T23:00:00.000Z',
  })),
});

const GIT_REPOS = [
  {
    id: 'gr-x1',
    classroom_id: 'class-x',
    repository_id: REPO_X,
    team_id: 't-1',
    name: 'project1-bestteam',
    team: { id: 't-1', name: 'Best team' },
    contribution_stats: stats([
      { user_id: 'user-a', git_name: 'ada', lines: 30 },
      // user-b is a member of classroom Y only: never named here.
      { user_id: 'user-b', git_name: 'bob', lines: 10 },
    ]),
    contributions_calculated_at: new Date('2026-11-23T20:00:00Z'),
    contributions_error: null,
  },
  {
    id: 'gr-y1',
    classroom_id: 'class-y',
    repository_id: REPO_Y,
    team_id: 't-9',
    name: 'project1-other',
    team: { id: 't-9', name: 'Other class team' },
    contribution_stats: stats([{ user_id: 'user-b', git_name: 'bob', lines: 5 }]),
    contributions_calculated_at: new Date('2026-11-23T20:00:00Z'),
    contributions_error: null,
  },
];

const MEMBERSHIPS = [
  { classroom_id: 'class-x', user_id: 'user-a', user: { id: 'user-a', name: 'Ada Lovelace' } },
  { classroom_id: 'class-y', user_id: 'user-b', user: { id: 'user-b', name: 'Bob Y' } },
];

const mocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  queueContributions: vi.fn(),
  gitRepoWhere: vi.fn(),
  listCommits: vi.fn(),
}));

vi.mock('@classmoji/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  default: () => ({
    gitRepo: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        mocks.gitRepoWhere(where);
        return GIT_REPOS.filter(
          r =>
            r.classroom_id === where.classroom_id &&
            r.repository_id === where.repository_id &&
            r.team_id !== null
        );
      },
    },
    classroomMembership: {
      findMany: async ({ where }: { where: { classroom_id: string; user_id: { in: string[] } } }) =>
        MEMBERSHIPS.filter(
          m => m.classroom_id === where.classroom_id && where.user_id.in.includes(m.user_id)
        ),
    },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      findById: async (id: string) => REPOSITORIES.find(r => r.id === id) ?? null,
    },
    audit: {
      create: (...a: unknown[]) => mocks.auditCreate(...a),
      record: (row: unknown) =>
        import('../../__tests__/support/auditRecord.ts').then(m =>
          m.recordThrough(r => mocks.auditCreate(r))(row)
        ),
    },
    repoContributions: { listCommits: (...a: unknown[]) => mocks.listCommits(...a) },
  },
}));

vi.mock('@classmoji/tasks/contributions', () => ({
  ContributionsNotTeamRepoError: class ContributionsNotTeamRepoError extends Error {},
  queueContributions: (...a: unknown[]) => mocks.queueContributions(...a),
}));

const { repoContributionsTool, repoContributionsCalculateTool, repoContributionsCommitsTool } =
  await import('../repoContributions.ts');
const { ContributionsNotTeamRepoError } = await import('@classmoji/tasks/contributions');

const ctxFor = (classroomId: string, role: string): ToolContext =>
  ({
    viewer: { userId: 'staff-1', clientId: 'c', scopes: new Set(['read', 'write']) },
    classroom: {
      classroomId,
      role,
      status: 'ACTIVE',
      slug: classroomId,
      membership: { id: 'm-1', role },
      classroom: { settings: {}, slug: classroomId, git_organization: { provider: 'GITHUB' } },
    },
  }) as unknown as ToolContext;

const X_ASSISTANT = ctxFor('class-x', 'ASSISTANT');
const X_OWNER = ctxFor('class-x', 'OWNER');

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe('repo_contributions', () => {
  it('is a teaching-team read the registry audits', () => {
    expect(repoContributionsTool.scope).toBe('read');
    expect(repoContributionsTool.roles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
    expect(repoContributionsTool.auditRead?.resourceType).toBe('REPOSITORIES');
  });

  it('returns this classroom team repos, naming only this classroom members', async () => {
    const out = parse(
      await repoContributionsTool.handler(
        { classroom: 'org/class-x', repository_id: REPO_X },
        X_ASSISTANT
      )
    );

    expect(mocks.gitRepoWhere).toHaveBeenCalledWith(
      expect.objectContaining({ classroom_id: 'class-x', repository_id: REPO_X })
    );
    expect(out.team_repos).toHaveLength(1);
    const [repo] = out.team_repos;
    expect(repo.repo).toBe('project1-bestteam');
    expect(repo.calculated_at).toBe('2026-11-23T20:00:00.000Z');
    expect(
      repo.contributors.map((c: Record<string, unknown>) => [
        c.user_id,
        c.name,
        c.git_name,
        c.line_share_percent,
      ])
    ).toEqual([
      ['user-a', 'Ada Lovelace', 'ada', 75],
      // A classroom Y member stored on this row: no id, no Classmoji name.
      [null, null, 'bob', 25],
    ]);
    expect(JSON.stringify(out)).not.toContain('Bob Y');
    expect(JSON.stringify(out)).not.toContain('project1-other');
  });

  it("refuses classroom Y's repository to a classroom X caller", async () => {
    await expect(
      repoContributionsTool.handler({ classroom: 'org/class-x', repository_id: REPO_Y }, X_OWNER)
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.gitRepoWhere).not.toHaveBeenCalled();
  });

  it('refuses an individual repository', async () => {
    await expect(
      repoContributionsTool.handler(
        { classroom: 'org/class-x', repository_id: REPO_X_SOLO },
        X_OWNER
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
  });
});

describe('repo_contributions_calculate', () => {
  it('is an owner-only write that is not destructive', () => {
    expect(repoContributionsCalculateTool.scope).toBe('write');
    expect(repoContributionsCalculateTool.roles).toEqual(['OWNER']);
    expect(repoContributionsCalculateTool.annotations).toEqual({
      destructive: false,
      idempotent: true,
      openWorld: true,
    });
  });

  it('queues the authorized classroom repository and audits it', async () => {
    mocks.queueContributions.mockResolvedValue({ numRepos: 4 });

    const out = parse(
      await repoContributionsCalculateTool.handler(
        { classroom: 'org/class-x', repository_id: REPO_X },
        X_OWNER
      )
    );

    expect(mocks.queueContributions).toHaveBeenCalledWith({
      classroomId: 'class-x',
      repositoryId: REPO_X,
    });
    expect(out).toMatchObject({ success: true, team_repos_queued: 4 });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.auditCreate.mock.calls[0])).toContain(
      'repo_contributions_calculate'
    );
  });

  it("never queues classroom Y's repository", async () => {
    await expect(
      repoContributionsCalculateTool.handler(
        { classroom: 'org/class-x', repository_id: REPO_Y },
        X_OWNER
      )
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.queueContributions).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('answers an individual repository with invalid_params', async () => {
    mocks.queueContributions.mockRejectedValue(new ContributionsNotTeamRepoError());
    await expect(
      repoContributionsCalculateTool.handler(
        { classroom: 'org/class-x', repository_id: REPO_X_SOLO },
        X_OWNER
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('repo_contributions_commits', () => {
  const row = (repo: string, sha: string) => ({
    team: 'Best team',
    repo,
    date: '2026-11-02T10:00:00.000Z',
    student: 'Ada Lovelace',
    user_id: 'user-a',
    github_login: 'ada',
    git_name: 'Ada',
    git_email: 'ada@example.com',
    sha,
    message: 'work',
    additions: 1,
    deletions: 0,
  });

  beforeEach(() => {
    mocks.listCommits.mockResolvedValue({
      rows: [
        row('project1-bestteam', 'a1'),
        row('project1-bestteam', 'a2'),
        row('project1-x', 'b1'),
      ],
      repoCount: 2,
      notCalculated: 0,
      truncatedRepos: [],
      oldestCalculatedAt: '2026-11-23T20:00:00.000Z',
    });
  });

  it('is an owner-only read the registry audits, like the CSV download', () => {
    expect(repoContributionsCommitsTool.scope).toBe('read');
    expect(repoContributionsCommitsTool.roles).toEqual(['OWNER']);
    expect(repoContributionsCommitsTool.auditRead?.resourceType).toBe('REPOSITORIES');
  });

  it('lists the authorized classroom rows, filtered and capped', async () => {
    const out = parse(
      await repoContributionsCommitsTool.handler(
        {
          classroom: 'org/class-x',
          repository_id: REPO_X,
          team_repo: 'project1-bestteam',
          limit: 1,
        },
        X_OWNER
      )
    );
    expect(mocks.listCommits).toHaveBeenCalledWith({
      classroomId: 'class-x',
      repositoryId: REPO_X,
    });
    expect(out).toMatchObject({ total_commits: 2, truncated: true, team_repos: 2 });
    expect(out.commits.map((c: { sha: string }) => c.sha)).toEqual(['a1']);
  });

  it("never reads classroom Y's repository", async () => {
    await expect(
      repoContributionsCommitsTool.handler(
        { classroom: 'org/class-x', repository_id: REPO_Y },
        X_OWNER
      )
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.listCommits).not.toHaveBeenCalled();
  });

  it('refuses an individual repository', async () => {
    await expect(
      repoContributionsCommitsTool.handler(
        { classroom: 'org/class-x', repository_id: REPO_X_SOLO },
        X_OWNER
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
  });
});
