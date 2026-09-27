/**
 * The classroom-scoped lookups and delete behind the repository page's actions:
 *   - gitRepo.findByIdInClassroom / deleteInClassroom
 *   - gitRepoAssignment.findByIdInClassroom
 *   - repository.findByIdInClassroom / assertInClassroom
 *   - gitRepoAssignmentGrader.findEligibleGrader
 *
 * Each pins that the classroom id is part of the query itself, and that an id
 * that is not a non-empty string never reaches Prisma (which would drop an
 * `undefined`, or read an object as a filter, and match other rows).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  gitRepoFindFirst: vi.fn(),
  gitRepoDeleteMany: vi.fn(),
  gitRepoAssignmentFindFirst: vi.fn(),
  repositoryFindFirst: vi.fn(),
  membershipFindFirst: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepo: {
      findFirst: (...a: unknown[]) => db.gitRepoFindFirst(...a),
      deleteMany: (...a: unknown[]) => db.gitRepoDeleteMany(...a),
    },
    gitRepoAssignment: { findFirst: (...a: unknown[]) => db.gitRepoAssignmentFindFirst(...a) },
    repository: { findFirst: (...a: unknown[]) => db.repositoryFindFirst(...a) },
    classroomMembership: { findFirst: (...a: unknown[]) => db.membershipFindFirst(...a) },
  }),
}));

vi.mock('@trigger.dev/sdk', () => ({ tasks: { batchTrigger: vi.fn(), trigger: vi.fn() } }));
vi.mock('../../git/index.ts', () => ({ getGitProvider: vi.fn() }));
vi.mock('../notification.service.ts', () => ({
  runSafely: vi.fn(),
  getStudentsInClassroom: vi.fn(async () => []),
  createNotifications: vi.fn(),
}));
vi.mock('../classroom.service.ts', () => ({ findById: vi.fn() }));

const gitRepo = await import('../gitRepo.service.ts');
const gitRepoAssignment = await import('../gitRepoAssignment.service.ts');
const repository = await import('../repository.service.ts');
const graders = await import('../gitRepoAssignmentGrader.service.ts');

const UNUSABLE_IDS: unknown[] = [undefined, null, '', 42, { not: '' }, ['id-1']];

beforeEach(() => {
  for (const m of Object.values(db)) m.mockReset();
});

describe('gitRepo.findByIdInClassroom', () => {
  it('queries by id and classroom', async () => {
    db.gitRepoFindFirst.mockResolvedValue({ id: 'gr-1', name: 'lab-1-alice' });

    const row = await gitRepo.findByIdInClassroom('gr-1', 'class-1');

    expect(row).toEqual({ id: 'gr-1', name: 'lab-1-alice' });
    expect(db.gitRepoFindFirst).toHaveBeenCalledWith({
      where: { id: 'gr-1', classroom_id: 'class-1' },
    });
  });

  it('narrows to one repository when asked', async () => {
    await gitRepo.findByIdInClassroom('gr-1', 'class-1', { repositoryId: 'repo-1' });

    expect(db.gitRepoFindFirst).toHaveBeenCalledWith({
      where: { id: 'gr-1', classroom_id: 'class-1', repository_id: 'repo-1' },
    });
  });

  it('returns null without querying for an id that is not a non-empty string', async () => {
    for (const id of UNUSABLE_IDS) {
      expect(await gitRepo.findByIdInClassroom(id, 'class-1')).toBeNull();
    }
    expect(await gitRepo.findByIdInClassroom('gr-1', '')).toBeNull();
    expect(await gitRepo.findByIdInClassroom('gr-1', 'class-1', { repositoryId: '' })).toBeNull();
    expect(db.gitRepoFindFirst).not.toHaveBeenCalled();
  });
});

describe('gitRepo.deleteInClassroom', () => {
  it('deletes by id and classroom together', async () => {
    db.gitRepoDeleteMany.mockResolvedValue({ count: 1 });

    await expect(gitRepo.deleteInClassroom('gr-1', 'class-1')).resolves.toEqual({ id: 'gr-1' });
    expect(db.gitRepoDeleteMany).toHaveBeenCalledWith({
      where: { id: 'gr-1', classroom_id: 'class-1' },
    });
  });

  it('throws when the row is not in the classroom', async () => {
    db.gitRepoDeleteMany.mockResolvedValue({ count: 0 });

    await expect(gitRepo.deleteInClassroom('gr-1', 'class-2')).rejects.toThrow(
      'Git repo not found in classroom'
    );
  });

  it('refuses unusable ids before writing', async () => {
    for (const id of UNUSABLE_IDS) {
      await expect(gitRepo.deleteInClassroom(id as string, 'class-1')).rejects.toThrow(
        'Invalid git repo id'
      );
    }
    await expect(gitRepo.deleteInClassroom('gr-1', undefined as unknown as string)).rejects.toThrow(
      'Invalid classroom id'
    );
    expect(db.gitRepoDeleteMany).not.toHaveBeenCalled();
  });
});

describe('gitRepoAssignment.findByIdInClassroom', () => {
  it('reaches the classroom through the git repo and includes repo and graders', async () => {
    await gitRepoAssignment.findByIdInClassroom('ra-1', 'class-1');

    expect(db.gitRepoAssignmentFindFirst).toHaveBeenCalledWith({
      where: { id: 'ra-1', git_repo: { classroom_id: 'class-1' } },
      include: { git_repo: true, graders: { include: { grader: true } } },
    });
  });

  it('narrows to a repository or an assignment when asked', async () => {
    await gitRepoAssignment.findByIdInClassroom('ra-1', 'class-1', { repositoryId: 'repo-1' });
    await gitRepoAssignment.findByIdInClassroom('ra-1', 'class-1', { assignmentId: 'asg-1' });

    expect(db.gitRepoAssignmentFindFirst.mock.calls[0][0].where).toEqual({
      id: 'ra-1',
      git_repo: { classroom_id: 'class-1', repository_id: 'repo-1' },
    });
    expect(db.gitRepoAssignmentFindFirst.mock.calls[1][0].where).toEqual({
      id: 'ra-1',
      assignment_id: 'asg-1',
      git_repo: { classroom_id: 'class-1' },
    });
  });

  it('returns null without querying for unusable ids', async () => {
    for (const id of UNUSABLE_IDS) {
      expect(await gitRepoAssignment.findByIdInClassroom(id, 'class-1')).toBeNull();
    }
    expect(
      await gitRepoAssignment.findByIdInClassroom('ra-1', 'class-1', { assignmentId: '' })
    ).toBeNull();
    expect(db.gitRepoAssignmentFindFirst).not.toHaveBeenCalled();
  });
});

describe('repository.findByIdInClassroom', () => {
  it('queries by id and classroom, without the classroom row', async () => {
    await repository.findByIdInClassroom('repo-1', 'class-1');

    expect(db.repositoryFindFirst).toHaveBeenCalledWith({
      where: { id: 'repo-1', classroom_id: 'class-1' },
      include: { assignments: true, tag: true },
    });
  });

  it('returns null without querying for unusable ids', async () => {
    for (const id of UNUSABLE_IDS) {
      expect(await repository.findByIdInClassroom(id, 'class-1')).toBeNull();
    }
    expect(db.repositoryFindFirst).not.toHaveBeenCalled();
  });
});

describe('repository.assertInClassroom', () => {
  it('refuses unusable ids before querying', async () => {
    await expect(
      repository.assertInClassroom(undefined as unknown as string, 'class-1')
    ).rejects.toThrow('Invalid repository id');
    expect(db.repositoryFindFirst).not.toHaveBeenCalled();
  });
});

describe('gitRepoAssignmentGrader.findEligibleGrader', () => {
  it('matches a grader-flagged ASSISTANT or TEACHER membership of this classroom', async () => {
    db.membershipFindFirst.mockResolvedValue({ user: { id: 'u-ta', login: 'ta-bob' } });

    const user = await graders.findEligibleGrader('class-1', 'u-ta');

    expect(user).toEqual({ id: 'u-ta', login: 'ta-bob' });
    expect(db.membershipFindFirst).toHaveBeenCalledWith({
      where: {
        classroom_id: 'class-1',
        user_id: 'u-ta',
        role: { in: ['ASSISTANT', 'TEACHER'] },
        is_grader: true,
      },
      include: { user: true },
    });
  });

  it('returns null when there is no such membership', async () => {
    db.membershipFindFirst.mockResolvedValue(null);
    expect(await graders.findEligibleGrader('class-1', 'u-student')).toBeNull();
  });

  it('returns null without querying for unusable ids', async () => {
    for (const id of UNUSABLE_IDS) {
      expect(await graders.findEligibleGrader('class-1', id)).toBeNull();
    }
    expect(await graders.findEligibleGrader('', 'u-ta')).toBeNull();
    expect(db.membershipFindFirst).not.toHaveBeenCalled();
  });
});
