/**
 * Unit tests for the two extracted admin functions on
 * gitRepoAssignmentGrader.service: assignGradersToAssignment (shared by the web
 * assign-graders action and the MCP tool) and gradingReport. Prisma, the
 * sibling services and Trigger.dev are mocked; the tests pin RANDOM's
 * round-robin modulo, EXISTING's student/team matching and skips, that
 * `sessionId` is what puts tags on the runs, and that gradingReport reports a
 * grader's work on submissions they were never assigned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const graderFindMany = vi.fn();
const gradeFindMany = vi.fn();
vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepoAssignmentGrader: { findMany: (...a: unknown[]) => graderFindMany(...a) },
    assignmentGrade: { findMany: (...a: unknown[]) => gradeFindMany(...a) },
  }),
}));

const classroomFindById = vi.fn();
vi.mock('../classroom.service.ts', () => ({
  findById: (...a: unknown[]) => classroomFindById(...a),
}));

const findUsersByRole = vi.fn();
vi.mock('../classroomMembership.service.ts', () => ({
  findUsersByRole: (...a: unknown[]) => findUsersByRole(...a),
}));

const findByAssignmentId = vi.fn();
vi.mock('../gitRepoAssignment.service.ts', () => ({
  findByAssignmentId: (...a: unknown[]) => findByAssignmentId(...a),
}));

vi.mock('../notification.service.ts', () => ({
  runSafely: vi.fn(),
  createNotifications: vi.fn(),
}));

const batchTrigger = vi.fn();
vi.mock('@trigger.dev/sdk', () => ({
  tasks: { batchTrigger: (...a: unknown[]) => batchTrigger(...a) },
}));

// Keep the round-robin deterministic: shuffle is an ordering detail, not behavior.
vi.mock('lodash', async importOriginal => {
  const actual = (await importOriginal()) as { default: Record<string, unknown> };
  return { default: { ...actual.default, shuffle: (arr: unknown[]) => arr } };
});

const service = await import('../gitRepoAssignmentGrader.service.ts');

const CLASSROOM = { id: 'class-1', slug: 'cs1-25f', git_organization: { login: 'cs1-org' } };

const repoAssignment = (
  id: string,
  name: string,
  studentId: string | null,
  teamId: string | null
) => ({
  id,
  provider_issue_number: 7,
  git_repo: { name, student_id: studentId, team_id: teamId },
  graders: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  classroomFindById.mockResolvedValue(CLASSROOM);
  batchTrigger.mockResolvedValue({ id: 'batch-1' });
});

describe('assignGradersToAssignment — RANDOM', () => {
  it('walks the is_grader assistants round-robin, one grader per submission', async () => {
    findByAssignmentId.mockResolvedValue([
      repoAssignment('ra-1', 'repo-a', 'stu-1', null),
      repoAssignment('ra-2', 'repo-b', 'stu-2', null),
      repoAssignment('ra-3', 'repo-c', 'stu-3', null),
    ]);
    findUsersByRole.mockResolvedValue([
      { id: 'ta-1', login: 'ada' },
      { id: 'ta-2', login: 'grace' },
    ]);

    const result = await service.assignGradersToAssignment({
      classroomId: 'class-1',
      assignmentId: 'a-1',
      method: 'RANDOM',
      sessionId: 'sess',
    });

    expect(findUsersByRole).toHaveBeenCalledWith('class-1', 'ASSISTANT', { is_grader: true });
    expect(result).toEqual({ numAssignmentsToAddGradersTo: 3 });

    const [taskId, items] = batchTrigger.mock.calls[0];
    expect(taskId).toBe('add_grader_to_git_repo_assignment');
    expect(items.map((i: { payload: { graderLogin: string } }) => i.payload.graderLogin)).toEqual([
      'ada',
      'grace',
      'ada',
    ]);
    expect(items[0].options).toEqual({ tags: ['session_sess'] });
  });

  it('omits run tags when no sessionId is supplied (the MCP path)', async () => {
    findByAssignmentId.mockResolvedValue([repoAssignment('ra-1', 'repo-a', 'stu-1', null)]);
    findUsersByRole.mockResolvedValue([{ id: 'ta-1', login: 'ada' }]);

    await service.assignGradersToAssignment({
      classroomId: 'class-1',
      assignmentId: 'a-1',
      method: 'RANDOM',
    });

    expect(batchTrigger.mock.calls[0][1][0].options).toBeUndefined();
  });

  it('throws instead of dividing by zero when nobody has is_grader', async () => {
    findByAssignmentId.mockResolvedValue([repoAssignment('ra-1', 'repo-a', 'stu-1', null)]);
    findUsersByRole.mockResolvedValue([]);

    await expect(
      service.assignGradersToAssignment({
        classroomId: 'class-1',
        assignmentId: 'a-1',
        method: 'RANDOM',
      })
    ).rejects.toThrow(/no assistants with is_grader/);
    expect(batchTrigger).not.toHaveBeenCalled();
  });
});

describe('assignGradersToAssignment — EXISTING', () => {
  it('copies the template mapping by student/team and skips unmatched submissions', async () => {
    findByAssignmentId.mockImplementation((assignmentId: string) => {
      if (assignmentId === 'a-target') {
        return Promise.resolve([
          repoAssignment('ra-1', 'repo-a', 'stu-1', null),
          repoAssignment('ra-2', 'repo-b', null, 'team-1'),
          repoAssignment('ra-3', 'repo-c', 'stu-missing', null),
        ]);
      }
      return Promise.resolve([
        {
          ...repoAssignment('t-1', 'repo-a', 'stu-1', null),
          graders: [{ grader: { id: 'ta-1', login: 'ada' } }],
        },
        {
          ...repoAssignment('t-2', 'repo-b', null, 'team-1'),
          // Multiple graders on one template submission → multiple runs.
          graders: [
            { grader: { id: 'ta-1', login: 'ada' } },
            { grader: { id: 'ta-2', login: 'grace' } },
          ],
        },
      ]);
    });

    const result = await service.assignGradersToAssignment({
      classroomId: 'class-1',
      assignmentId: 'a-target',
      method: 'EXISTING',
      templateAssignmentId: 'a-template',
    });

    // 1 (student match) + 2 (team match, two graders) + 0 (no template row).
    expect(result).toEqual({ numAssignmentsToAddGradersTo: 3 });
    const items = batchTrigger.mock.calls[0][1];
    expect(
      items.map((i: { payload: { gitRepoAssignmentId: string; graderLogin: string } }) => [
        i.payload.gitRepoAssignmentId,
        i.payload.graderLogin,
      ])
    ).toEqual([
      ['ra-1', 'ada'],
      ['ra-2', 'ada'],
      ['ra-2', 'grace'],
    ]);
  });

  it('queues nothing when no submission matches the template', async () => {
    findByAssignmentId.mockImplementation((assignmentId: string) => {
      if (assignmentId === 'a-target') {
        return Promise.resolve([repoAssignment('ra-1', 'repo-a', 'stu-1', null)]);
      }
      // The template covers a different cohort entirely — nothing lines up.
      return Promise.resolve([
        {
          ...repoAssignment('t-1', 'repo-z', 'stu-other', null),
          graders: [{ grader: { id: 'ta-1', login: 'ada' } }],
        },
      ]);
    });

    const result = await service.assignGradersToAssignment({
      classroomId: 'class-1',
      assignmentId: 'a-target',
      method: 'EXISTING',
      templateAssignmentId: 'a-template',
    });

    expect(result).toEqual({ numAssignmentsToAddGradersTo: 0 });
    expect(batchTrigger).not.toHaveBeenCalled();
  });

  it('scopes both submission lookups to the classroom', async () => {
    findByAssignmentId.mockResolvedValue([]);

    await service.assignGradersToAssignment({
      classroomId: 'class-1',
      assignmentId: 'a-target',
      method: 'EXISTING',
      templateAssignmentId: 'a-template',
    });

    expect(findByAssignmentId).toHaveBeenCalledWith('a-target', 'cs1-25f', 'class-1');
    expect(findByAssignmentId).toHaveBeenCalledWith('a-template', 'cs1-25f', 'class-1');
  });

  it('requires a templateAssignmentId', async () => {
    await expect(
      service.assignGradersToAssignment({
        classroomId: 'class-1',
        assignmentId: 'a-1',
        method: 'EXISTING',
      })
    ).rejects.toThrow(/requires templateAssignmentId/);
  });
});

describe('gradingReport', () => {
  const assignment = {
    id: 'a-1',
    title: 'Lab 1',
    repository: { title: 'labs' },
  };

  it('pairs assigned counts with graded counts, distribution and last_graded_at', async () => {
    graderFindMany.mockResolvedValue([
      {
        grader: { id: 'ta-1', login: 'ada', name: 'Ada' },
        git_repo_assignment: { assignment_id: 'a-1', assignment },
      },
      {
        grader: { id: 'ta-1', login: 'ada', name: 'Ada' },
        git_repo_assignment: { assignment_id: 'a-1', assignment },
      },
    ]);
    gradeFindMany.mockResolvedValue([
      {
        grader_id: 'ta-1',
        emoji: '🌟',
        created_at: new Date('2026-01-01'),
        git_repo_assignment_id: 'ra-1',
        grader: { id: 'ta-1', login: 'ada', name: 'Ada' },
        git_repo_assignment: { assignment_id: 'a-1', assignment },
      },
      // Second grade on the SAME submission → distribution 2, graded_count 1.
      {
        grader_id: 'ta-1',
        emoji: '✅',
        created_at: new Date('2026-02-01'),
        git_repo_assignment_id: 'ra-1',
        grader: { id: 'ta-1', login: 'ada', name: 'Ada' },
        git_repo_assignment: { assignment_id: 'a-1', assignment },
      },
    ]);

    const rows = await service.gradingReport({ classroomId: 'class-1' });

    expect(rows).toEqual([
      {
        grader: { id: 'ta-1', login: 'ada', name: 'Ada' },
        assignment: { id: 'a-1', title: 'Lab 1', repository_title: 'labs' },
        assigned_count: 2,
        graded_count: 1,
        grade_distribution: { '🌟': 1, '✅': 1 },
        last_graded_at: new Date('2026-02-01'),
      },
    ]);
  });

  it('narrows both queries to the classroom and skips ungraded rows', async () => {
    graderFindMany.mockResolvedValue([]);
    gradeFindMany.mockResolvedValue([]);

    await service.gradingReport({ classroomId: 'class-1' });

    // Both halves of the report must be classroom-scoped through the repo.
    expect(graderFindMany.mock.calls[0][0].where).toMatchObject({
      git_repo_assignment: { git_repo: { classroom_id: 'class-1' } },
    });
    expect(gradeFindMany.mock.calls[0][0].where).toMatchObject({
      grader_id: { not: null },
      git_repo_assignment: { git_repo: { classroom_id: 'class-1' } },
    });
  });

  it('filters by grader and assignment when both are supplied', async () => {
    graderFindMany.mockResolvedValue([]);
    gradeFindMany.mockResolvedValue([]);

    await service.gradingReport({ classroomId: 'class-1', assignmentId: 'a-1', graderId: 'ta-1' });

    expect(graderFindMany.mock.calls[0][0].where).toMatchObject({
      grader_id: 'ta-1',
      git_repo_assignment: { assignment_id: 'a-1', git_repo: { classroom_id: 'class-1' } },
    });
    expect(gradeFindMany.mock.calls[0][0].where).toMatchObject({
      grader_id: 'ta-1',
      git_repo_assignment: { assignment_id: 'a-1', git_repo: { classroom_id: 'class-1' } },
    });
  });

  it('reports grading done on submissions the grader was never assigned', async () => {
    graderFindMany.mockResolvedValue([]);
    gradeFindMany.mockResolvedValue([
      {
        grader_id: 'ta-2',
        emoji: '🌟',
        created_at: new Date('2026-01-01'),
        git_repo_assignment_id: 'ra-9',
        grader: { id: 'ta-2', login: 'grace', name: 'Grace' },
        git_repo_assignment: { assignment_id: 'a-1', assignment },
      },
    ]);

    const rows = await service.gradingReport({ classroomId: 'class-1' });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assigned_count: 0, graded_count: 1 });
  });
});
