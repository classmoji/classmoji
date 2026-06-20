import _ from 'lodash';
import invariant from 'tiny-invariant';
import { auth } from '@trigger.dev/sdk';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';

import { ClassmojiService } from '@classmoji/services';
import Tasks from '@classmoji/tasks';

type Classroom = NonNullable<Awaited<ReturnType<typeof ClassmojiService.classroom.findBySlug>>>;
type Repository = NonNullable<Awaited<ReturnType<typeof ClassmojiService.repository.findById>>>;
type GitRepo = Awaited<ReturnType<typeof ClassmojiService.gitRepo.findByRepository>>[number];

export const publishAssignment = async (
  classroomSlug: string,
  repositoryId: string,
  _userId: string | null = null
) => {
  try {
    const sessionId = nanoid();
    const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
    const repository = await ClassmojiService.repository.findById(repositoryId);

    invariant(repository != null, 'Repository not found');

    // If repos already exist (re-publish after unpublish), just flip the flag
    const existingRepos = await ClassmojiService.gitRepo.findByRepository(classroomSlug, repositoryId);
    if (existingRepos.length > 0) {
      await ClassmojiService.repository.setPublished(repositoryId, true);
      return { success: 'Repository re-published. Use Sync to update repositories.' };
    }

    let numReposToCreate = 0;
    let numIssuesToCreate = 0;
    let _numStudents = 0;

    if (repository?.type == 'INDIVIDUAL') {
      const students = await ClassmojiService.classroomMembership.findUsersByRole(
        classroom!.id,
        'STUDENT'
      );

      if (students.length === 0)
        return {
          error: 'No students found.',
        };

      const studentList = students.map(user => user.login || '').filter(login => login !== '');

      numReposToCreate = studentList.length;
      numIssuesToCreate =
        repository.assignments.filter(assignment => dayjs(assignment.release_at).isBefore(dayjs()))
          .length * studentList.length;
      _numStudents = studentList.length;

      Tasks.createRepositoriesTask.trigger(
        {
          logins: studentList,
          assignmentTitle: repository.title,
          org: classroomSlug,
          sessionId,
        },
        { concurrencyKey: classroomSlug }
      );

      // Publish = "make available to students" — flip visibility immediately so
      // the repository shows up for students as soon as the instructor clicks
      // Publish. Per-student GitHub repos provision in the background above; if
      // that job is slow or partially fails, the repository is still visible
      // (instructors can re-run Sync to fill in missing repos). Mirrors the
      // SELF_FORMED branch below, which already publishes up front.
      await ClassmojiService.repository.setPublished(repositoryId, true);
    } else if (repository.team_formation_mode === 'SELF_FORMED') {
      // For self-formed teams, just mark repository as published
      // Teams and repos will be created when students form their teams
      await ClassmojiService.repository.setPublished(repositoryId, true);

      return {
        success: 'Repository published! Students can now form teams.',
      };
    } else {
      // Instructor-assigned teams
      const teams = await ClassmojiService.organizationTag.findTeamsByTag(repository.tag_id!);

      if (teams.length === 0) {
        return {
          info: 'No team(s) found.',
        };
      }

      numReposToCreate = teams.length;
      numIssuesToCreate =
        repository.assignments.filter(assignment => dayjs(assignment.release_at).isBefore(dayjs()))
          .length * teams.length;
      _numStudents = teams.length;

      Tasks.createRepositoriesTask.trigger(
        {
          logins: teams.map(team => team.slug),
          assignmentTitle: repository.title,
          org: classroomSlug,
          sessionId,
        },
        { concurrencyKey: classroomSlug }
      );

      // Publish = "make available to students" — flip visibility immediately
      // (see the INDIVIDUAL branch above). Team repos provision in the
      // background; the repository stays visible regardless.
      await ClassmojiService.repository.setPublished(repositoryId, true);
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
  } catch (error: unknown) {
    console.error(error);
    throw error;
  }
};

export const syncAssignment = async (
  classroomSlug: string,
  repositoryId: string,
  _userId: string | null = null
) => {
  const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
  const repository = await ClassmojiService.repository.findById(repositoryId);
  const sessionId = nanoid();

  const accessToken = await auth.createPublicToken({
    scopes: {
      read: {
        tags: [`session_${sessionId}`],
      },
    },
  });

  let syncResult;

  if (repository!.type === 'INDIVIDUAL') {
    syncResult = await syncIndividualAssignment(classroomSlug, classroom!, repository!, sessionId);
  } else if (repository!.team_formation_mode === 'SELF_FORMED') {
    syncResult = await syncSelfFormedTeamAssignment(classroomSlug, classroom!, repository!, sessionId);
  } else {
    syncResult = await syncTeamAssignment(classroomSlug, classroom!, repository!, sessionId);
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

const syncIndividualAssignment = async (
  classroomSlug: string,
  classroom: Classroom,
  repository: Repository,
  sessionId: string
) => {
  // 1. Find students in classroom
  const students = await ClassmojiService.classroomMembership.findUsersByRole(
    classroom.id,
    'STUDENT'
  );

  // 2. Find existing repos for repository given classroom
  const existingRepos = await ClassmojiService.gitRepo.findByRepository(classroomSlug, repository.id);

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
        assignmentTitle: repository.title,
        org: classroomSlug,
        sessionId,
      },
      { concurrencyKey: classroomSlug }
    );
  }
  // 4. Find and create missing assignments
  const missingAssignments = findMissingAssignments(repository, existingRepos);

  const numMissingAssignments = Object.values(missingAssignments).reduce(
    (acc: number, curr: { repos: unknown[] }) => {
      return acc + curr.repos.length;
    },
    0
  );

  const numReposToCreate = studentsWithMissingRepos.length * 2; // multiply by 2 to handle gh and cf creation
  const numIssuesToCreate = 2 * numMissingAssignments;

  await createMissingAssignments(classroom, missingAssignments, sessionId);

  return {
    numReposToCreate,
    numIssuesToCreate,
  };
};

const syncTeamAssignment = async (
  classroomSlug: string,
  classroom: Classroom,
  repository: Repository,
  sessionId: string
) => {
  // 1. Find teams using tag
  const teams = await ClassmojiService.organizationTag.findTeamsByTag(repository.tag_id!);

  // 2. Find existing repos for repository given classroom
  const existingRepos = await ClassmojiService.gitRepo.findByRepository(classroomSlug, repository.id);

  // 3. Find teams with missing repos and create missing repos
  const teamsWithMissingRepos = teams.filter(
    team => !existingRepos.find(repo => repo.team_id === team.id)
  );

  if (teamsWithMissingRepos.length)
    await Tasks.createRepositoriesTask.trigger(
      {
        logins: teamsWithMissingRepos.map(team => team.slug),
        assignmentTitle: repository.title,
        org: classroomSlug,
        sessionId,
      },
      { concurrencyKey: classroomSlug }
    );

  // 4. Find and create missing assignments
  const missingAssignments = findMissingAssignments(repository, existingRepos);
  const numMissingAssignments = Object.values(missingAssignments).reduce(
    (acc: number, curr: { repos: unknown[] }) => {
      return acc + curr.repos.length;
    },
    0
  );

  const numReposToCreate = teamsWithMissingRepos.length * 2; // multiply by 2 to handle gh and cf creation
  const numIssuesToCreate = 2 * numMissingAssignments;

  await createMissingAssignments(classroom, missingAssignments, sessionId);

  return {
    numReposToCreate,
    numIssuesToCreate,
  };
};

const syncSelfFormedTeamAssignment = async (
  classroomSlug: string,
  classroom: Classroom,
  repository: Repository,
  sessionId: string
) => {
  // For self-formed teams, find teams by the repository slug tag
  const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
    classroom.id,
    repository.slug!
  );

  if (!tag) {
    // No teams have been formed yet
    return {
      numReposToCreate: 0,
      numIssuesToCreate: 0,
    };
  }

  // Find teams using the tag
  const teams = await ClassmojiService.team.findByTagId(classroom.id, tag.id);

  // Find existing repos for repository given classroom
  const existingRepos = await ClassmojiService.gitRepo.findByRepository(classroomSlug, repository.id);

  // Find teams with missing repos and create missing repos
  const teamsWithMissingRepos = teams.filter(
    team => !existingRepos.find(repo => repo.team_id === team.id)
  );

  if (teamsWithMissingRepos.length)
    await Tasks.createRepositoriesTask.trigger(
      {
        logins: teamsWithMissingRepos.map(team => team.slug),
        assignmentTitle: repository.title,
        org: classroomSlug,
        sessionId,
      },
      { concurrencyKey: classroomSlug }
    );

  // Find and create missing assignments
  const missingAssignments = findMissingAssignments(repository, existingRepos);
  const numMissingAssignments = Object.values(missingAssignments).reduce(
    (acc: number, curr: { repos: unknown[] }) => {
      return acc + curr.repos.length;
    },
    0
  );

  const numReposToCreate = teamsWithMissingRepos.length * 2;
  const numIssuesToCreate = 2 * numMissingAssignments;

  await createMissingAssignments(classroom, missingAssignments, sessionId);

  return {
    numReposToCreate,
    numIssuesToCreate,
  };
};

// Internal helper functions
const findMissingAssignments = (
  repository: Repository,
  repos: GitRepo[]
): Record<string, MissingAssignmentEntry> => {
  const keyed = _.keyBy(repository.assignments, 'id');
  // Add `repos` array to each assignment entry for tracking missing assignments per repo
  const moduleAssignments = keyed as unknown as Record<string, MissingAssignmentEntry>;
  _.forEach(moduleAssignments, assignment => (assignment.repos = []));

  // remove assignments where release_at is in the future
  for (const assignment of Object.values(moduleAssignments)) {
    const releaseAt = (assignment as unknown as { release_at: Date | null }).release_at;
    if (!releaseAt || dayjs(releaseAt).isAfter(dayjs())) {
      delete moduleAssignments[assignment.id];
    }
  }

  repos.forEach((repo: GitRepo) => {
    const moduleAssignmentIds = Object.keys(moduleAssignments);

    const repoAssignmentIds =
      repo.assignments?.map((ra: { assignment_id: string }) => ra.assignment_id) || [];
    const missingAssignmentIds = _.difference(moduleAssignmentIds, repoAssignmentIds);

    missingAssignmentIds.forEach(assignmentId => {
      const assignment = moduleAssignments[assignmentId];
      assignment.repos.push(repo);
    });
  });

  return moduleAssignments;
};

interface MissingAssignmentEntry {
  id: string;
  repos: GitRepo[];
  [key: string]: unknown;
}

const createMissingAssignments = async (
  classroom: Classroom,
  missingAssignments: Record<string, MissingAssignmentEntry>,
  sessionId: string
) => {
  const assignmentsData: { payload: Record<string, unknown>; options: { tags: string[] } }[] = [];

  Object.values(missingAssignments).forEach((assignment: MissingAssignmentEntry) => {
    const { repos, ...assignmentData } = assignment;
    repos.forEach((repo: GitRepo) => {
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
    Tasks.createGithubRepositoryAssignmentTask.batchTrigger(
      assignmentsData as unknown as Parameters<
        typeof Tasks.createGithubRepositoryAssignmentTask.batchTrigger
      >[0],
      { concurrencyKey: classroom.slug } as Parameters<
        typeof Tasks.createGithubRepositoryAssignmentTask.batchTrigger
      >[1]
    );

    for (const assignment of Object.values(missingAssignments)) {
      ClassmojiService.assignment.update((assignment as { id: string }).id, {
        is_published: true,
      });
    }
  }

  return null;
};
