import { ClassmojiService } from '@classmoji/services';
import { releasedToRepos } from '@classmoji/utils';
import { createRepositoriesTask } from '../workflows/gitRepo.ts';
import { createGithubRepositoryAssignmentTask } from '../workflows/gitRepoAssignment.ts';

type Classroom = NonNullable<Awaited<ReturnType<typeof ClassmojiService.classroom.findById>>>;
type Repository = NonNullable<Awaited<ReturnType<typeof ClassmojiService.repository.findById>>>;
type GitRepo = Awaited<ReturnType<typeof ClassmojiService.gitRepo.findByRepository>>[number];

export interface MissingAssignmentEntry {
  id: string;
  repos: GitRepo[];
  [key: string]: unknown;
}

/**
 * AI-assisted with OpenAI Codex; extracted from the web Sync flow in
 * apps/webapp/app/routes/admin.$class.repos/helpers.ts so web and MCP share it.
 */
export const syncRepositoryAssignments = async (
  classroomSlug: string,
  classroom: Classroom,
  repository: Repository,
  sessionId: string
) => {
  if (repository.classroom_id !== classroom.id) {
    throw new Error('Repository not found in classroom');
  }

  let syncResult: { numReposToCreate: number; numIssuesToCreate: number };

  if (repository.type === 'INDIVIDUAL') {
    syncResult = await syncIndividualAssignment(classroomSlug, classroom, repository, sessionId);
  } else if (repository.team_formation_mode === 'SELF_FORMED') {
    syncResult = await syncSelfFormedTeamAssignment(
      classroomSlug,
      classroom,
      repository,
      sessionId
    );
  } else {
    syncResult = await syncTeamAssignment(classroomSlug, classroom, repository, sessionId);
  }

  return syncResult;
};

const syncIndividualAssignment = async (
  classroomSlug: string,
  classroom: Classroom,
  repository: Repository,
  sessionId: string
) => {
  const students = await ClassmojiService.classroomMembership.findUsersByRole(
    classroom.id,
    'STUDENT'
  );
  const existingRepos = await ClassmojiService.gitRepo.findByRepository(
    classroomSlug,
    repository.id
  );
  const studentsWithMissingRepos = students.filter(
    student =>
      !existingRepos.find(repo => repo.student_id === student.id) && student.has_accepted_invite
  );

  if (studentsWithMissingRepos.length) {
    await createRepositoriesTask.trigger(
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

  const missingAssignments = findMissingAssignments(repository, existingRepos);
  const numMissingAssignments = countMissingAssignments(missingAssignments);
  const numReposToCreate = studentsWithMissingRepos.length * 2;
  const numIssuesToCreate = 2 * numMissingAssignments;

  await createMissingAssignments(classroom, missingAssignments, sessionId);

  return { numReposToCreate, numIssuesToCreate };
};

const syncTeamAssignment = async (
  classroomSlug: string,
  classroom: Classroom,
  repository: Repository,
  sessionId: string
) => {
  const teams = await ClassmojiService.organizationTag.findTeamsByTag(repository.tag_id!);
  const existingRepos = await ClassmojiService.gitRepo.findByRepository(
    classroomSlug,
    repository.id
  );
  const teamsWithMissingRepos = teams.filter(
    team => !existingRepos.find(repo => repo.team_id === team.id)
  );

  if (teamsWithMissingRepos.length) {
    await createRepositoriesTask.trigger(
      {
        logins: teamsWithMissingRepos.map(team => team.slug),
        assignmentTitle: repository.title,
        org: classroomSlug,
        sessionId,
      },
      { concurrencyKey: classroomSlug }
    );
  }

  const missingAssignments = findMissingAssignments(repository, existingRepos);
  const numMissingAssignments = countMissingAssignments(missingAssignments);
  const numReposToCreate = teamsWithMissingRepos.length * 2;
  const numIssuesToCreate = 2 * numMissingAssignments;

  await createMissingAssignments(classroom, missingAssignments, sessionId);

  return { numReposToCreate, numIssuesToCreate };
};

const syncSelfFormedTeamAssignment = async (
  classroomSlug: string,
  classroom: Classroom,
  repository: Repository,
  sessionId: string
) => {
  const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
    classroom.id,
    repository.slug!
  );

  if (!tag) return { numReposToCreate: 0, numIssuesToCreate: 0 };

  const teams = await ClassmojiService.team.findByTagId(classroom.id, tag.id);
  const existingRepos = await ClassmojiService.gitRepo.findByRepository(
    classroomSlug,
    repository.id
  );
  const teamsWithMissingRepos = teams.filter(
    team => !existingRepos.find(repo => repo.team_id === team.id)
  );

  if (teamsWithMissingRepos.length) {
    await createRepositoriesTask.trigger(
      {
        logins: teamsWithMissingRepos.map(team => team.slug),
        assignmentTitle: repository.title,
        org: classroomSlug,
        sessionId,
      },
      { concurrencyKey: classroomSlug }
    );
  }

  const missingAssignments = findMissingAssignments(repository, existingRepos);
  const numMissingAssignments = countMissingAssignments(missingAssignments);
  const numReposToCreate = teamsWithMissingRepos.length * 2;
  const numIssuesToCreate = 2 * numMissingAssignments;

  await createMissingAssignments(classroom, missingAssignments, sessionId);

  return { numReposToCreate, numIssuesToCreate };
};

export const findMissingAssignments = (
  repository: Repository,
  repos: GitRepo[]
): Record<string, MissingAssignmentEntry> => {
  const moduleAssignments: Record<string, MissingAssignmentEntry> = {};
  const now = new Date();

  for (const assignment of repository.assignments) {
    if (releasedToRepos(assignment, now)) {
      moduleAssignments[assignment.id] = { ...assignment, repos: [] };
    }
  }

  for (const repo of repos) {
    const repoAssignmentIds = new Set(
      repo.assignments?.map((assignment: { assignment_id: string }) => assignment.assignment_id) ||
        []
    );
    for (const assignmentId of Object.keys(moduleAssignments)) {
      if (!repoAssignmentIds.has(assignmentId)) moduleAssignments[assignmentId].repos.push(repo);
    }
  }

  return moduleAssignments;
};

export const createMissingAssignments = async (
  classroom: Classroom,
  missingAssignments: Record<string, MissingAssignmentEntry>,
  sessionId: string
) => {
  const assignmentsData: { payload: Record<string, unknown>; options: { tags: string[] } }[] = [];

  Object.values(missingAssignments).forEach(assignment => {
    const { repos, ...assignmentData } = assignment;
    repos.forEach(repo => {
      assignmentsData.push({
        payload: {
          repoName: repo.name,
          assignment: assignmentData,
          organization: classroom.git_organization,
          studentRepo: repo,
        },
        options: { tags: [`session_${sessionId}`, 'standalone'] },
      });
    });
  });

  if (assignmentsData.length) {
    await createGithubRepositoryAssignmentTask.batchTrigger(
      assignmentsData as unknown as Parameters<
        typeof createGithubRepositoryAssignmentTask.batchTrigger
      >[0],
      { concurrencyKey: classroom.slug } as Parameters<
        typeof createGithubRepositoryAssignmentTask.batchTrigger
      >[1]
    );

    await Promise.all(
      Object.values(missingAssignments).map(assignment =>
        ClassmojiService.assignment.update(assignment.id, { is_published: true })
      )
    );
  }

  return null;
};

const countMissingAssignments = (missingAssignments: Record<string, MissingAssignmentEntry>) =>
  Object.values(missingAssignments).reduce(
    (count, assignment) => count + assignment.repos.length,
    0
  );
