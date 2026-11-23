/**
 * listCommits / commitsToCsv: rows are read by the caller's classroom id and
 * repository id together, an author is named only while a member of THAT
 * classroom, dates come out in UTC, and a commit message that looks like a
 * formula reaches the spreadsheet as text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stats = (commits: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  version: 1,
  head_sha: null,
  total_lines: 0,
  starter_lines: 0,
  total_commits: commits.length,
  files_counted: 0,
  files_skipped: 0,
  authors: [],
  commits,
  ...extra,
});

const commit = (over: Record<string, unknown>) => ({
  sha: 'a'.repeat(40),
  date: '2026-11-02T05:00:00-05:00',
  user_id: null,
  login: null,
  git_name: 'someone',
  git_email: 'someone@example.com',
  message: 'work',
  additions: 1,
  deletions: 0,
  ...over,
});

const GIT_REPOS = [
  {
    classroom_id: 'class-x',
    repository_id: 'repo-x',
    team_id: 't-1',
    name: 'project1-bestteam',
    team: { name: 'Best team' },
    contributions_calculated_at: new Date('2026-11-23T20:00:00Z'),
    contribution_stats: stats(
      [
        commit({
          sha: 'b'.repeat(40),
          user_id: 'user-a',
          login: 'ada',
          git_name: 'Ada',
          date: '2026-11-05T10:00:00Z',
        }),
        // user-b belongs to classroom Y only.
        commit({
          sha: 'c'.repeat(40),
          user_id: 'user-b',
          git_name: 'Bob',
          message: '=HYPERLINK("x")',
        }),
      ],
      { commits_truncated: true }
    ),
  },
  {
    classroom_id: 'class-x',
    repository_id: 'repo-x',
    team_id: 't-2',
    name: 'project1-newteam',
    team: { name: 'New team' },
    contributions_calculated_at: null,
    contribution_stats: null,
  },
  {
    classroom_id: 'class-y',
    repository_id: 'repo-y',
    team_id: 't-9',
    name: 'project1-other',
    team: { name: 'Other class' },
    contributions_calculated_at: new Date('2026-11-23T20:00:00Z'),
    contribution_stats: stats([commit({ user_id: 'user-b', git_name: 'Bob' })]),
  },
];

const MEMBERSHIPS = [
  { classroom_id: 'class-x', user_id: 'user-a', user: { id: 'user-a', name: 'Ada Lovelace' } },
  { classroom_id: 'class-y', user_id: 'user-b', user: { id: 'user-b', name: 'Bob Y' } },
];

const where = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepo: {
      findMany: async (q: { where: { classroom_id: string; repository_id: string } }) => {
        where(q.where);
        return GIT_REPOS.filter(
          r =>
            r.classroom_id === q.where.classroom_id &&
            r.repository_id === q.where.repository_id &&
            r.team_id !== null
        );
      },
    },
    classroomMembership: {
      findMany: async (q: { where: { classroom_id: string; user_id: { in: string[] } } }) =>
        MEMBERSHIPS.filter(
          m => m.classroom_id === q.where.classroom_id && q.where.user_id.in.includes(m.user_id)
        ),
    },
  }),
}));

const { listCommits, commitsToCsv } = await import('../repoContributions.service.ts');

beforeEach(() => where.mockClear());

describe('listCommits', () => {
  it('reads by classroom and repository, naming only this classroom members', async () => {
    const result = await listCommits({ classroomId: 'class-x', repositoryId: 'repo-x' });

    expect(where).toHaveBeenCalledWith(
      expect.objectContaining({ classroom_id: 'class-x', repository_id: 'repo-x' })
    );
    expect(result.repoCount).toBe(2);
    expect(result.notCalculated).toBe(1);
    expect(result.truncatedRepos).toEqual(['project1-bestteam']);
    expect(result.rows.map(r => [r.repo, r.student, r.user_id, r.git_name, r.date])).toEqual([
      // Oldest first; the -05:00 date comes out in UTC.
      ['project1-bestteam', null, null, 'Bob', '2026-11-02T10:00:00.000Z'],
      ['project1-bestteam', 'Ada Lovelace', 'user-a', 'Ada', '2026-11-05T10:00:00.000Z'],
    ]);
    expect(JSON.stringify(result)).not.toContain('Bob Y');
    expect(JSON.stringify(result)).not.toContain('project1-other');
  });

  it("gives classroom X nothing of classroom Y's repository", async () => {
    const result = await listCommits({ classroomId: 'class-x', repositoryId: 'repo-y' });
    expect(result).toMatchObject({ rows: [], repoCount: 0 });
  });
});

describe('commitsToCsv', () => {
  it('writes a header and formula-safe cells', async () => {
    const { rows } = await listCommits({ classroomId: 'class-x', repositoryId: 'repo-x' });
    const lines = commitsToCsv(rows).split('\r\n');

    expect(lines[0]).toBe(
      'Team,Repository,Date (UTC),Student,Github,Git author,Git email,Commit,Message,Lines added,Lines removed'
    );
    expect(lines[1]).toContain('2026-11-02 10:00:00');
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[2]).toContain('Ada Lovelace,ada,Ada');
  });
});
