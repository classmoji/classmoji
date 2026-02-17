import _ from 'lodash';
import invariant from 'tiny-invariant';
import { auth } from '@trigger.dev/sdk';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';

import { ClassmojiService } from '@classmoji/services';
import Tasks from '@classmoji/tasks';

export const publishAssignment = async (classroomSlug, moduleId, userId = null) => {
  try {
    const sessionId = nanoid();
    const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
    const module = await ClassmojiService.module.findById(moduleId);

    invariant(module != null, 'Module not found');

    let numReposToCreate = 0;
    let numIssuesToCreate = 0;
    let numStudents = 0;

    if (module?.type == 'INDIVIDUAL') {
      const students = await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'STUDENT');

      if (students.length === 0)
        return {
          error: 'No students found.',
        };

      const studentList = students.map(user => user.login || '').filter(login => login !== '');

      numReposToCreate = studentList.length;
      numIssuesToCreate =
        module.assignments.filter(assignment => dayjs(assignment.release_at).isBefore(dayjs())).length *
        studentList.length;
      numStudents = studentList.length;

      Tasks.createRepositoriesTask.trigger(
        {
          logins: studentList,
          assignmentTitle: module.title,
          org: classroomSlug,
          sessionId,
        },
        { concurrencyKey: classroomSlug }
      );
    } else if (module.team_formation_mode === 'SELF_FORMED') {
      // For self-formed teams, just mark module as published
      // Teams and repos will be created when students form their teams
      await ClassmojiService.module.update(moduleId, { is_published: true });

      return {
        success: 'Module published! Students can now form teams.',
      };
    } else {
      // Instructor-assigned teams
      const teams = await ClassmojiService.organizationTag.findTeamsByTag(module.tag_id);

      if (teams.length === 0) {
        return {
          info: 'No team(s) found.',
        };
      }

      numReposToCreate = teams.length;
      numIssuesToCreate =
        module.assignments.filter(assignment => dayjs(assignment.release_at).isBefore(dayjs())).length *
        teams.length;
      numStudents = teams.length;

      Tasks.createRepositoriesTask.trigger(
        {
          logins: teams.map(team => team.slug),
          assignmentTitle: module.title,
          org: classroomSlug,
          sessionId,
        },
        { concurrencyKey: classroomSlug }
      );
    }

    const accessToken = await auth.createPublicToken({
      scopes: {
        read: {
          tags: [`session_${sessionId}`],
        },
      },
    });

    return {
      triggerSession: {
        accessToken,
        id: sessionId,
        numReposToCreate: numReposToCreate * 2, // multiply by 2 to handle gh and cf creation
        numIssuesToCreate: numIssuesToCreate, // publish does not create issues
      },
    };
  } catch (error) {
    console.error(error);
    throw error;
  }
};

export const syncAssignment = async (classroomSlug, moduleId, userId = null) => {
  const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
  const module = await ClassmojiService.module.findById(moduleId);
  const sessionId = nanoid();

  const accessToken = await auth.createPublicToken({
    scopes: {
      read: {
        tags: [`session_${sessionId}`],
      },
    },
  });

  let syncResult;

  if (module.type === 'INDIVIDUAL') {
    syncResult = await syncIndividualAssignment(classroomSlug, classroom, module, sessionId);
  } else if (module.team_formation_mode === 'SELF_FORMED') {
    syncResult = await syncSelfFormedTeamAssignment(classroomSlug, classroom, module, sessionId);
  } else {
    syncResult = await syncTeamAssignment(classroomSlug, classroom, module, sessionId);
  }

  const { numReposToCreate, numIssuesToCreate } = syncResult;

  return {
    triggerSession: {
      accessToken,
      id: sessionId,
      numReposToCreate,
      numIssuesToCreate,
    },
  };
};

const syncIndividualAssignment = async (classroomSlug, classroom, module, sessionId) => {
  // 1. Find students in classroom
  const students = await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'STUDENT');

  // 2. Find existing repos for module given classroom
  const existingRepos = await ClassmojiService.repository.findByModule(classroomSlug, module.id);

  // 3. Find students with missing repos and create missing repos
  const studentsWithMissingRepos = students.filter(
    student =>
      !existingRepos.find(repo => repo.student_id === student.id) && student.has_accepted_invite
  );

  if (studentsWithMissingRepos.length) {
    await Tasks.createRepositoriesTask.trigger(
      {
        logins: studentsWithMissingRepos
          .map(user => user.login || '')
          .filter(login => login !== ''),
        assignmentTitle: module.title,
        org: classroomSlug,
        sessionId,
      },
      { concurrencyKey: classroomSlug }
    );
  }
  // 4. Find and create missing assignments
  const missingAssignments = findMissingAssignments(module, existingRepos);

  const numMissingAssignments = Object.values(missingAssignments).reduce((acc, curr) => {
    return acc + curr.repos.length;
  }, 0);

  const numReposToCreate = studentsWithMissingRepos.length * 2; // multiply by 2 to handle gh and cf creation
  const numIssuesToCreate = 2 * numMissingAssignments;

  await createMissingAssignments(classroom, missingAssignments, sessionId);

  return {
    numReposToCreate,
    numIssuesToCreate,
  };
};

const syncTeamAssignment = async (classroomSlug, classroom, module, sessionId) => {
  // 1. Find teams using tag
  const teams = await ClassmojiService.organizationTag.findTeamsByTag(module.tag_id);

  // 2. Find existing repos for module given classroom
  const existingRepos = await ClassmojiService.repository.findByModule(classroomSlug, module.id);

  // 3. Find teams with missing repos and create missing repos
  const teamsWithMissingRepos = teams.filter(
    team => !existingRepos.find(repo => repo.team_id === team.id)
  );

  if (teamsWithMissingRepos.length)
    await Tasks.createRepositoriesTask.trigger(
      {
        logins: teamsWithMissingRepos.map(team => team.slug),
        assignmentTitle: module.title,
        org: classroomSlug,
        sessionId,
      },
      { concurrencyKey: classroomSlug }
    );

  // 4. Find and create missing assignments
  const missingAssignments = findMissingAssignments(module, existingRepos);
  const numMissingAssignments = Object.values(missingAssignments).reduce((acc, curr) => {
    return acc + curr.repos.length;
  }, 0);

  const numReposToCreate = teamsWithMissingRepos.length * 2; // multiply by 2 to handle gh and cf creation
  const numIssuesToCreate = 2 * numMissingAssignments;

  await createMissingAssignments(classroom, missingAssignments, sessionId);

  return {
    numReposToCreate,
    numIssuesToCreate,
  };
};

const syncSelfFormedTeamAssignment = async (classroomSlug, classroom, module, sessionId) => {
  // For self-formed teams, find teams by the module slug tag
  const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(classroom.id, module.slug);

  if (!tag) {
    // No teams have been formed yet
    return {
      numReposToCreate: 0,
      numIssuesToCreate: 0,
    };
  }

  // Find teams using the tag
  const teams = await ClassmojiService.team.findByTagId(classroom.id, tag.id);

  // Find existing repos for module given classroom
  const existingRepos = await ClassmojiService.repository.findByModule(classroomSlug, module.id);

  // Find teams with missing repos and create missing repos
  const teamsWithMissingRepos = teams.filter(
    team => !existingRepos.find(repo => repo.team_id === team.id)
  );

  if (teamsWithMissingRepos.length)
    await Tasks.createRepositoriesTask.trigger(
      {
        logins: teamsWithMissingRepos.map(team => team.slug),
        assignmentTitle: module.title,
        org: classroomSlug,
        sessionId,
      },
      { concurrencyKey: classroomSlug }
    );

  // Find and create missing assignments
  const missingAssignments = findMissingAssignments(module, existingRepos);
  const numMissingAssignments = Object.values(missingAssignments).reduce((acc, curr) => {
    return acc + curr.repos.length;
  }, 0);

  const numReposToCreate = teamsWithMissingRepos.length * 2;
  const numIssuesToCreate = 2 * numMissingAssignments;

  await createMissingAssignments(classroom, missingAssignments, sessionId);

  return {
    numReposToCreate,
    numIssuesToCreate,
  };
};

// Internal helper functions
const findMissingAssignments = (module, repos) => {
  let moduleAssignments = _.forEach(_.keyBy(module.assignments, 'id'), assignment => (assignment.repos = []));

  // remove assignments where release_at is in the future
  for (const assignment of Object.values(moduleAssignments)) {
    if (!assignment.release_at || dayjs(assignment.release_at).isAfter(dayjs())) {
      delete moduleAssignments[assignment.id];
    }
  }

  repos.forEach(repo => {
    const moduleAssignmentIds = Object.keys(moduleAssignments);

    const repoAssignmentIds = repo.assignments?.map(ra => ra.assignment_id) || [];
    const missingAssignmentIds = _.difference(moduleAssignmentIds, repoAssignmentIds);

    missingAssignmentIds.forEach(assignmentId => {
      const assignment = moduleAssignments[assignmentId];
      assignment.repos.push(repo);
    });
  });

  return moduleAssignments;
};

const createMissingAssignments = async (classroom, missingAssignments, sessionId) => {
  const assignmentsData = [];

  Object.values(missingAssignments).forEach(assignment => {
    const { repos, ...assignmentData } = assignment;
    repos.forEach(repo => {
      const payload = {
        repoName: repo.name,
        assignment: assignmentData,
        organization: classroom.git_organization,
        studentRepo: repo,
      };
      assignmentsData.push({
        payload,
        options: { tags: [`session_${sessionId}`] },
      });
    });
  });

  if (assignmentsData.length) {
    Tasks.createGithubRepositoryAssignmentTask.batchTrigger(assignmentsData, {
      concurrencyKey: classroom.slug,
    });

    for (const assignment of Object.values(missingAssignments)) {
      ClassmojiService.assignment.update(assignment.id, {
        is_published: true,
      });
    }
  }

  return null;
};
