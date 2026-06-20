import { describe, it, expect, vi, afterEach } from 'vitest';

// listAdminClassrooms checks the DB for already-imported classrooms; stub it out
// (no existing orgs → nothing marked imported).
vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitOrganization: { findMany: async () => [] },
    classroom: { findMany: async () => [] },
  }),
}));

import { GitHubProvider } from '../../git/index.ts';
import {
  listAdminClassrooms,
  buildClassroomImportInput,
} from '../githubClassroomApi.service.ts';

/**
 * Fake Octokit that answers the Classroom endpoints from fixtures, switching on
 * the route string. `paginate` returns the whole array; `request` returns {data}.
 */
function fakeOctokit(fixtures: {
  classrooms?: unknown[];
  classroomDetail?: Record<number, unknown>;
  assignments?: Record<number, unknown[]>;
  assignmentDetail?: Record<number, unknown>;
  accepted?: Record<number, unknown[]>;
  grades?: Record<number, unknown[]>;
}) {
  return {
    async paginate(route: string, opts: Record<string, number>) {
      if (route === 'GET /classrooms') return fixtures.classrooms ?? [];
      if (route === 'GET /classrooms/{classroom_id}/assignments')
        return fixtures.assignments?.[opts.classroom_id] ?? [];
      if (route === 'GET /assignments/{assignment_id}/accepted_assignments')
        return fixtures.accepted?.[opts.assignment_id] ?? [];
      throw new Error(`unexpected paginate route ${route}`);
    },
    async request(route: string, opts: Record<string, number>) {
      if (route === 'GET /classrooms/{classroom_id}')
        return { data: fixtures.classroomDetail?.[opts.classroom_id] };
      if (route === 'GET /assignments/{assignment_id}')
        return { data: fixtures.assignmentDetail?.[opts.assignment_id] };
      if (route === 'GET /assignments/{assignment_id}/grades')
        return { data: fixtures.grades?.[opts.assignment_id] ?? [] };
      throw new Error(`unexpected request route ${route}`);
    },
  } as unknown as ReturnType<typeof GitHubProvider.getUserOctokit>;
}

afterEach(() => vi.restoreAllMocks());

describe('listAdminClassrooms', () => {
  it('enriches each classroom with its organization', async () => {
    vi.spyOn(GitHubProvider, 'getUserOctokit').mockReturnValue(
      fakeOctokit({
        classrooms: [
          { id: 1, name: 'CS1', archived: false },
          { id: 2, name: 'CS2', archived: true },
        ],
        classroomDetail: {
          1: { id: 1, name: 'CS1', archived: false, organization: { id: 100, login: 'org-one' } },
          2: { id: 2, name: 'CS2', archived: true, organization: null },
        },
      })
    );

    const result = await listAdminClassrooms('tok');
    expect(result).toEqual([
      {
        githubId: 1,
        name: 'CS1',
        archived: false,
        organization: { id: 100, login: 'org-one' },
        alreadyImported: false,
      },
      { githubId: 2, name: 'CS2', archived: true, organization: null, alreadyImported: false },
    ]);
  });
});

describe('buildClassroomImportInput', () => {
  it('normalizes assignments, submissions, and grades into the importer shape', async () => {
    vi.spyOn(GitHubProvider, 'getUserOctokit').mockReturnValue(
      fakeOctokit({
        classroomDetail: {
          1: { id: 1, name: 'CS1', archived: false, organization: { id: 100, login: 'org-one' } },
        },
        assignments: { 1: [{ id: 11, title: 'HW1', slug: 'hw1', type: 'individual' }] },
        assignmentDetail: {
          11: {
            id: 11,
            title: 'HW1',
            slug: 'hw1',
            type: 'individual',
            deadline: '2025-01-01T00:00:00Z',
            starter_code_repository: { full_name: 'org-one/hw1-template' },
          },
        },
        accepted: {
          11: [
            {
              submitted: true,
              passing: true,
              commit_count: 3,
              grade: 'A',
              students: [{ id: 1001, login: 'alice', name: 'Alice', avatar_url: 'http://x' }],
              repository: { id: 5001, full_name: 'org-one/hw1-alice', html_url: 'http://r' },
            },
          ],
        },
        grades: {
          11: [
            {
              assignment_name: 'HW1',
              github_username: 'alice',
              points_awarded: 80,
              points_available: 100,
              submission_timestamp: '2025-01-02T00:00:00Z',
            },
            { assignment_name: 'HW1', github_username: '', points_awarded: 0, points_available: 0 },
          ],
        },
      })
    );

    const { classroom, slug } = await buildClassroomImportInput('tok', 1, 'cs1');

    expect(slug).toBe('cs1');
    expect(classroom).toMatchObject({
      githubId: 1,
      name: 'CS1',
      organization: { id: 100, login: 'org-one' },
    });

    const a = classroom.assignments[0];
    expect(a).toMatchObject({
      githubId: 11,
      title: 'HW1',
      slug: 'hw1',
      type: 'individual',
      deadline: '2025-01-01T00:00:00Z',
      starterRepoFullName: 'org-one/hw1-template',
    });
    expect(a.acceptances[0]).toMatchObject({
      type: 'individual',
      students: [{ providerId: '1001', login: 'alice', name: 'Alice', avatarUrl: 'http://x' }],
      repo: { providerId: '5001', name: 'hw1-alice', htmlUrl: 'http://r' },
      commitCount: 3,
      submitted: true,
      passing: true,
      grade: 'A',
    });

    // Grade rows: blank-username row is dropped, points coerced to strings.
    expect(classroom.grades).toEqual([
      {
        assignmentTitle: 'HW1',
        githubUsername: 'alice',
        pointsAwarded: '80',
        pointsAvailable: '100',
        submissionTimestamp: '2025-01-02T00:00:00Z',
      },
    ]);
  });

  it('throws when the classroom has no organization', async () => {
    vi.spyOn(GitHubProvider, 'getUserOctokit').mockReturnValue(
      fakeOctokit({
        classroomDetail: { 9: { id: 9, name: 'Orphan', archived: false, organization: null } },
      })
    );
    await expect(buildClassroomImportInput('tok', 9, 'orphan')).rejects.toThrow(/organization/);
  });
});
