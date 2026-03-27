import { findTeamsByUserId } from './teamMembership.service.ts';
import { findMany as findRepositories } from './repository.service.ts';
import { findByClassroomId as findEmojiMappingsByClassroomId } from './emojiMapping.service.ts';
import { findRepositoriesPerStudent } from './user.service.ts';
import * as classroomService from './classroom.service.ts';
import * as assignmentService from './assignment.service.ts';
import * as repositoryAssignmentService from './repositoryAssignment.service.ts';
import * as repositoryAssignmentGraderService from './repositoryAssignmentGrader.service.ts';

import getPrisma from '@classmoji/database';
import { calculateStudentFinalGrade } from '@classmoji/utils';
import type { OrganizationSettings, Repository } from '@classmoji/utils';

// Re-export grader progress function for convenience
export const findAssignmentGradersProgress = repositoryAssignmentGraderService.findGradersProgress;

export const findTeamRepositoriesForStudent = async (userId: string, classroomSlug: string) => {
  const teams = await findTeamsByUserId(userId);
  const repositories = [];

  for (const team of teams) {
    const teamRepos = await findRepositories({
      team_id: team.team_id,
      classroom: { slug: classroomSlug },
    });

    repositories.push(...teamRepos);
  }

  return repositories;
};

export const findTeamAssignmentsForStudent = async (userId: string, classroomSlug: string) => {
  const teams = await findTeamsByUserId(userId);
  const repoAssignments = [];

  for (const team of teams) {
    const teamAssignments = await repositoryAssignmentService.findForUser({
      repository: {
        team_id: team.team_id,
        classroom: { slug: classroomSlug },
      },
    });
    repoAssignments.push(...teamAssignments);
  }

  return repoAssignments;
};

export const findAllAssignmentsForStudent = async (userId: string, classroomSlug: string) => {
  const studentAssignments = await repositoryAssignmentService.findForUser({
    repository: {
      student_id: userId,
      classroom: { slug: classroomSlug },
    },
  });

  const teamAssignments = await findTeamAssignmentsForStudent(userId, classroomSlug);
  const allAssignments = [...studentAssignments, ...teamAssignments];

  return allAssignments;
};

export const findClassroomGradingProgressPerAssignment = async (classroomId: string) => {
  let numberOfAssignments = await getPrisma().repositoryAssignment.groupBy({
    where: {
      assignment: {
        module: {
          classroom_id: classroomId,
          is_extra_credit: false,
        },
      },
    },
    by: ['assignment_id'],
    _count: true,
  });

  const numExtraCreditAssignments = await getPrisma().repositoryAssignment.groupBy({
    where: {
      status: 'CLOSED',
      assignment: {
        module: {
          classroom_id: classroomId,
          is_extra_credit: true,
        },
      },
    },
    by: ['assignment_id'],
    _count: true,
  });

  numberOfAssignments = [...numberOfAssignments, ...numExtraCreditAssignments];

  let gradedAssignments = await getPrisma().repositoryAssignment.groupBy({
    where: {
      assignment: {
        module: {
          classroom_id: classroomId,
          is_extra_credit: false,
        },
      },
      grades: {
        some: {},
      },
    },
    by: ['assignment_id'],
    _count: true,
  });

  const extraCreditGradedAssignments = await getPrisma().repositoryAssignment.groupBy({
    where: {
      status: 'CLOSED',
      assignment: {
        module: {
          classroom_id: classroomId,
          is_extra_credit: true,
        },
      },
      grades: {
        some: {},
      },
    },
    by: ['assignment_id'],
    _count: true,
  });

  gradedAssignments = [...gradedAssignments, ...extraCreditGradedAssignments];

  // find percentage of graded assignments for each assignment
  const progressPerAssignment = numberOfAssignments.reduce((acc: Record<string, number>, assignment) => {
    const numGraded = gradedAssignments.find(i => i.assignment_id === assignment.assignment_id)?._count;
    acc[assignment.assignment_id] = ((numGraded ?? 0) / assignment._count) * 100 || 0;
    return acc;
  }, {});

  const classroomAssignments = await assignmentService.findByClassroomId(classroomId);

  const progress = [];

  for (const assignment of classroomAssignments) {
    if (progressPerAssignment[assignment.id] !== undefined) {
      progress.push({
        ...assignment,
        progress: progressPerAssignment[assignment.id],
      });
    }
  }

  progress.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return progress;
};

export const calculateClassLeaderboard = async (classroomSlug: string) => {
  const classroom = await classroomService.findBySlug(classroomSlug);

  const emojiMappings = await findEmojiMappingsByClassroomId(classroom!.id);
  const students = await findRepositoriesPerStudent(classroom!);

  const settings = await classroomService.getClassroomSettingsForServer(classroom!.id);

  const grades: Array<{
    id: string;
    name: string | null;
    grade: number;
    avatar_url: string | null;
    login: string | null;
  }> = [];

  students.forEach(student => {
    const grade = calculateStudentFinalGrade(
      student.repositories as Repository[],
      emojiMappings as Record<string, number>,
      settings as OrganizationSettings
    );

    grades.push({
      id: student.id,
      name: student.name ?? null,
      grade,
      avatar_url: student.avatar_url ?? null,
      login: student.login ?? null,
    });
  });

  grades.sort((a, b) => a.grade - b.grade);

  return grades;
};
