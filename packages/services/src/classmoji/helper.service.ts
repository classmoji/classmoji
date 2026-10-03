import { findTeamsByUserId } from './teamMembership.service.ts';
import { findMany as findRepositories } from './gitRepo.service.ts';
import { findByClassroomId as findEmojiMappingsByClassroomId } from './emojiMapping.service.ts';
import { findRepositoriesPerStudent } from './user.service.ts';
import * as classroomService from './classroom.service.ts';
import * as assignmentService from './assignment.service.ts';
import * as gitRepoAssignmentService from './gitRepoAssignment.service.ts';
import * as gitRepoAssignmentGraderService from './gitRepoAssignmentGrader.service.ts';
import { quizzesVisibleOrThrow } from './entitlement.service.ts';
import { loadQuizGradeItems } from './quizGradeItems.service.ts';

import getPrisma from '@classmoji/database';
import { calculateStudentFinalGrade } from '@classmoji/utils';
import type { OrganizationSettings, GitRepo } from '@classmoji/utils';

// Re-export grader progress function for convenience
export const findAssignmentGradersProgress = gitRepoAssignmentGraderService.findGradersProgress;

export const findTeamRepositoriesForStudent = async (userId: string, classroomSlug: string) => {
  const teams = await findTeamsByUserId(userId);
  const gitRepos = [];

  for (const team of teams) {
    const teamRepos = await findRepositories({
      team_id: team.team_id,
      classroom: { slug: classroomSlug },
    });

    gitRepos.push(...teamRepos);
  }

  return gitRepos;
};

export const findTeamAssignmentsForStudent = async (userId: string, classroomSlug: string) => {
  const teams = await findTeamsByUserId(userId);
  const repoAssignments = [];

  for (const team of teams) {
    const teamAssignments = await gitRepoAssignmentService.findForUser({
      git_repo: {
        team_id: team.team_id,
        classroom: { slug: classroomSlug },
      },
    });
    repoAssignments.push(...teamAssignments);
  }

  return repoAssignments;
};

export const findAllAssignmentsForStudent = async (userId: string, classroomSlug: string) => {
  const studentAssignments = await gitRepoAssignmentService.findForUser({
    git_repo: {
      student_id: userId,
      classroom: { slug: classroomSlug },
    },
  });

  const teamAssignments = await findTeamAssignmentsForStudent(userId, classroomSlug);
  const allAssignments = [...studentAssignments, ...teamAssignments];

  return allAssignments;
};

export const findClassroomGradingProgressPerAssignment = async (classroomId: string) => {
  let numberOfAssignments = await getPrisma().gitRepoAssignment.groupBy({
    where: {
      assignment: {
        module: { classroom_id: classroomId },
        is_extra_credit: false,
      },
    },
    by: ['assignment_id'],
    _count: true,
  });

  const numExtraCreditAssignments = await getPrisma().gitRepoAssignment.groupBy({
    where: {
      status: 'CLOSED',
      assignment: {
        module: { classroom_id: classroomId },
        is_extra_credit: true,
      },
    },
    by: ['assignment_id'],
    _count: true,
  });

  numberOfAssignments = [...numberOfAssignments, ...numExtraCreditAssignments];

  let gradedAssignments = await getPrisma().gitRepoAssignment.groupBy({
    where: {
      assignment: {
        module: { classroom_id: classroomId },
        is_extra_credit: false,
      },
      grades: {
        some: {},
      },
    },
    by: ['assignment_id'],
    _count: true,
  });

  const extraCreditGradedAssignments = await getPrisma().gitRepoAssignment.groupBy({
    where: {
      status: 'CLOSED',
      assignment: {
        module: { classroom_id: classroomId },
        is_extra_credit: true,
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
  const progressPerAssignment = numberOfAssignments.reduce(
    (acc: Record<string, number>, assignment) => {
      const numGraded = gradedAssignments.find(
        i => i.assignment_id === assignment.assignment_id
      )?._count;
      acc[assignment.assignment_id] = ((numGraded ?? 0) / assignment._count) * 100 || 0;
      return acc;
    },
    {}
  );

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

/**
 * Every student's course grade, lowest first. Quiz assignments count through
 * their grade items, under the same quiz visibility the classroom's pages use
 * (`quizzesVisibleOrThrow`), resolved here so every caller (owner dashboard,
 * MCP leaderboard resource and tool) agrees with the gradebook. A failed
 * visibility lookup throws rather than dropping quizzes from the totals.
 */
export const calculateClassLeaderboard = async (classroomSlug: string) => {
  const classroom = await classroomService.findBySlug(classroomSlug);

  if (!classroom) {
    throw new Response('Classroom not found', { status: 404 });
  }

  const emojiMappings = await findEmojiMappingsByClassroomId(classroom.id);
  const students = await findRepositoriesPerStudent(classroom);

  const settings = await classroomService.getClassroomSettingsForServer(classroom.id);

  // One batched read for the whole roster.
  const quizzesVisible = await quizzesVisibleOrThrow(classroom.id);
  const quizItems = await loadQuizGradeItems({ classroomId: classroom.id, quizzesVisible });

  const grades: Array<{
    id: string;
    name: string | null;
    grade: number;
    avatar_url: string | null;
    login: string | null;
  }> = [];

  students.forEach(student => {
    const grade = calculateStudentFinalGrade(
      student.git_repos as GitRepo[],
      emojiMappings as Record<string, number>,
      settings as OrganizationSettings,
      true,
      true,
      quizItems.get(student.id) ?? []
    );

    grades.push({
      id: student.id,
      name: student.name ?? null,
      grade,
      // `image` is the User column; `avatar_url` is the name the view layer
      // uses. Reading `avatar_url` off the row left every leaderboard entry
      // without an avatar.
      avatar_url: student.image ?? null,
      login: student.login ?? null,
    });
  });

  grades.sort((a, b) => a.grade - b.grade);

  return grades;
};
