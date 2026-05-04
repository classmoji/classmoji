import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock the database module before importing ownership.ts so the helpers see
 * our test prisma instance instead of the real one. We re-import per test so
 * mocks are clean between cases.
 */
const prismaMock = {
  module: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn() },
  repositoryAssignment: { findUnique: vi.fn() },
  assignmentGrade: { findUnique: vi.fn() },
  regradeRequest: { findUnique: vi.fn() },
  quiz: { findUnique: vi.fn() },
  page: { findUnique: vi.fn() },
  slide: { findUnique: vi.fn() },
  calendarEvent: { findUnique: vi.fn() },
  classroomMembership: { findFirst: vi.fn() },
};

vi.mock('@classmoji/database', () => ({
  default: () => prismaMock,
}));

let ownership: typeof import('../../src/context/ownership.ts');

beforeEach(async () => {
  vi.resetAllMocks();
  ownership = await import('../../src/context/ownership.ts');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('cross-classroom ownership guards', () => {
  describe('assertModuleInClassroom', () => {
    it('passes when module is in classroom', async () => {
      prismaMock.module.findUnique.mockResolvedValue({ classroom_id: 'c-1' });
      await expect(ownership.assertModuleInClassroom('m-1', 'c-1')).resolves.toBeUndefined();
    });

    it('rejects when module is missing', async () => {
      prismaMock.module.findUnique.mockResolvedValue(null);
      await expect(ownership.assertModuleInClassroom('m-1', 'c-1')).rejects.toThrow(
        /not found in this classroom/
      );
    });

    it('rejects when module belongs to a different classroom', async () => {
      prismaMock.module.findUnique.mockResolvedValue({ classroom_id: 'c-OTHER' });
      await expect(ownership.assertModuleInClassroom('m-1', 'c-1')).rejects.toThrow(
        /not found in this classroom/
      );
    });
  });

  describe('assertAssignmentInClassroom (traverses Module)', () => {
    it('passes when assignment.module.classroom_id matches', async () => {
      prismaMock.assignment.findUnique.mockResolvedValue({
        module: { classroom_id: 'c-1' },
      });
      await expect(
        ownership.assertAssignmentInClassroom('a-1', 'c-1')
      ).resolves.toBeUndefined();
    });

    it('rejects on cross-classroom UUID', async () => {
      prismaMock.assignment.findUnique.mockResolvedValue({
        module: { classroom_id: 'c-EVIL' },
      });
      await expect(ownership.assertAssignmentInClassroom('a-1', 'c-1')).rejects.toThrow(
        /not found in this classroom/
      );
    });
  });

  describe('assertRepositoryAssignmentInClassroom (traverses Repository)', () => {
    it('passes when ra.repository.classroom_id matches', async () => {
      prismaMock.repositoryAssignment.findUnique.mockResolvedValue({
        repository: { classroom_id: 'c-1' },
      });
      await expect(
        ownership.assertRepositoryAssignmentInClassroom('ra-1', 'c-1')
      ).resolves.toBeUndefined();
    });

    it('rejects on cross-classroom UUID', async () => {
      prismaMock.repositoryAssignment.findUnique.mockResolvedValue({
        repository: { classroom_id: 'c-OTHER' },
      });
      await expect(
        ownership.assertRepositoryAssignmentInClassroom('ra-1', 'c-1')
      ).rejects.toThrow(/not found in this classroom/);
    });
  });

  describe('assertStudentOwnsRepositoryAssignment', () => {
    it('passes for individual repo owned by the student in the classroom', async () => {
      prismaMock.repositoryAssignment.findUnique.mockResolvedValue({
        repository: {
          classroom_id: 'c-1',
          student_id: 'stu-1',
          team: null,
        },
      });
      await expect(
        ownership.assertStudentOwnsRepositoryAssignment('ra-1', 'stu-1', 'c-1')
      ).resolves.toBeUndefined();
    });

    it('passes for team repo when student is on the team', async () => {
      prismaMock.repositoryAssignment.findUnique.mockResolvedValue({
        repository: {
          classroom_id: 'c-1',
          student_id: null,
          team: { memberships: [{ id: 'tm-1' }] },
        },
      });
      await expect(
        ownership.assertStudentOwnsRepositoryAssignment('ra-1', 'stu-1', 'c-1')
      ).resolves.toBeUndefined();
    });

    it('rejects when student does not own the individual repo', async () => {
      prismaMock.repositoryAssignment.findUnique.mockResolvedValue({
        repository: {
          classroom_id: 'c-1',
          student_id: 'someone-else',
          team: null,
        },
      });
      await expect(
        ownership.assertStudentOwnsRepositoryAssignment('ra-1', 'stu-1', 'c-1')
      ).rejects.toThrow(/do not own this repository assignment/);
    });

    it('rejects when repo is in another classroom', async () => {
      prismaMock.repositoryAssignment.findUnique.mockResolvedValue({
        repository: {
          classroom_id: 'c-OTHER',
          student_id: 'stu-1',
          team: null,
        },
      });
      await expect(
        ownership.assertStudentOwnsRepositoryAssignment('ra-1', 'stu-1', 'c-1')
      ).rejects.toThrow(/not found in this classroom/);
    });
  });

  describe('assertUserMemberOfClassroom', () => {
    it('passes when membership row exists', async () => {
      prismaMock.classroomMembership.findFirst.mockResolvedValue({ id: 'cm-1' });
      await expect(
        ownership.assertUserMemberOfClassroom('u-1', 'c-1')
      ).resolves.toBeUndefined();
    });

    it('rejects when no accepted membership', async () => {
      prismaMock.classroomMembership.findFirst.mockResolvedValue(null);
      await expect(
        ownership.assertUserMemberOfClassroom('u-1', 'c-1')
      ).rejects.toThrow(/not a member/i);
    });
  });
});
