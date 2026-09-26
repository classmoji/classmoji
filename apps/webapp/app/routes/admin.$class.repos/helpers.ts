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

/**
 * `classroomId` is the classroom the CALLER was authorized for. The classroom is
 * resolved from it rather than from the slug, and the repository — addressed by
 * a body-supplied id — is checked against it before anything is published.
 */
const skippedNote = (count: number) =>
  `${count} student${count === 1 ? '' : 's'} skipped: no Gitlab account connected yet. ` +
  'Their projects are created when they connect Gitlab and open Classmoji.';

export const publishAssignment = async (
  classroomSlug: string,
  classroomId: string,
  repositoryId: string,
  _userId: string | null = null
) => {
  try {
    const sessionId = nanoid();
    const classroom = await ClassmojiService.classroom.findById(classroomId);
    const repository = await ClassmojiService.repository.findById(repositoryId);

    invariant(repository != null, 'Repository not found');
    invariant(repository.classroom_id === classroomId, 'Repository not found in classroom');

    // If repos already exist (re-publish after unpublish), just flip the flag
    const existingRepos = await ClassmojiService.gitRepo.findByRepository(
      classroomSlug,
      repositoryId
    );
    if (existingRepos.length > 0) {
      await ClassmojiService.repository.setPublished(repositoryId, true, classroomId);
      return { success: 'Repository re-published. Use Sync to update repositories.' };
    }

    let skippedNoGitLab = 0;
    let numReposToCreate = 0;
    let numIssuesToCreate = 0;
    let _numStudents = 0;

    if (repository?.type == 'INDIVIDUAL') {
      const students = await ClassmojiService.classroomMembership.findUsersByRole(
        classroom!.id,
        'STUDENT'
      );

      let studentList = students.map(user => user.login || '').filter(login => login !== '');

      // GitLab: a project is named after, and shared with, the student's GitLab
      // username, so students without GitLab connected can't get one yet. Say
      // so instead of letting the task skip them silently.
      if (classroom?.git_organization?.provider === 'GITLAB') {
        const gitlabUsernames = await ClassmojiService.user.findProviderUsernames(
          students.map(user => user.id),
          'GITLAB'
        );
        const withGitLab = new Set(
          students.filter(user => gitlabUsernames.has(user.id)).map(user => user.login)
        );
        skippedNoGitLab = studentList.filter(login => !withGitLab.has(login)).length;
        studentList = studentList.filter(login => withGitLab.has(login));
      }

      // Nobody to provision for yet — an empty roster (pre-term staging) or a
      // roster whose invites are all still pending, so no GitHub login to create
      // a repo under. Publish is "make available to students", so it must still
      // succeed: students who join later are provisioned on join, and Sync
      // backfills anyone the join path missed. Returning early also avoids
      // handing the UI a progress session with nothing to report.
      if (studentList.length === 0) {
        await ClassmojiService.repository.setPublished(repositoryId, true, classroomId);

        return {
          success: 'Repository published! Student repositories are created as students join.',
          ...(skippedNoGitLab > 0 ? { info: skippedNote(skippedNoGitLab) } : {}),
        };
      }

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
      await ClassmojiService.repository.setPublished(repositoryId, true, classroomId);
    } else if (repository.team_formation_mode === 'SELF_FORMED') {
      // For self-formed teams, just mark repository as published
      // Teams and repos will be created when students form their teams
      await ClassmojiService.repository.setPublished(repositoryId, true, classroomId);
      // Nothing provisions per-team repos until a team forms, so the
      // assignments whose release date has passed would otherwise stay
      // drafts. Publish them now; each team's rows are created as it forms.
      await ClassmojiService.assignment.publishReleased(repositoryId);

      return {
        success: 'Repository published! Students can now form teams.',
      };
    } else {
      // Instructor-assigned teams
      const teams = await ClassmojiService.organizationTag.findTeamsByTag(repository.tag_id!);

      // No teams tagged yet — same pre-term staging case as the INDIVIDUAL
      // branch above. Publish the container; team repos are created by Sync once
      // the teams exist.
      if (teams.length === 0) {
        await ClassmojiService.repository.setPublished(repositoryId, true, classroomId);

        return {
          success: 'Repository published! Team repositories are created once teams exist.',
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
      await ClassmojiService.repository.setPublished(repositoryId, true, classroomId);
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
      ...(skippedNoGitLab > 0 ? { info: skippedNote(skippedNoGitLab) } : {}),
    };
  } catch (error: unknown) {
    console.error(error);
    throw error;
  }
};

/**
 * Publish one assignment, and whatever it needs to be reachable.
 *
 * A REPO assignment is not open to students until its repositories exist, so
 * an unpublished repository is published first (which provisions them). A
 * repository that is already published is left alone: its repos are on GitHub
 * and other assignments may be submitting through them, so re-publishing would
 * be a no-op at best. Quiz and form assignments have nothing to provision.
 *
 * `release_at` still gates visibility independently, so publishing an
 * assignment dated in the future marks it released without exposing it early.
 */
export const publishAssignmentAndRepository = async (
  classroomSlug: string,
  classroomId: string,
  assignmentId: string,
  userId: string | null = null
) => {
  const assignment = await ClassmojiService.assignment.findByIdInClassroom(
    assignmentId,
    classroomId
  );
  invariant(assignment != null, 'Assignment not found');

  let repoResult: Awaited<ReturnType<typeof publishAssignment>> | null = null;

  if (assignment.type === 'REPO' && assignment.repository_id) {
    const repository = await ClassmojiService.repository.findById(assignment.repository_id);
    if (repository && !repository.is_published) {
      repoResult = await publishAssignment(
        classroomSlug,
        classroomId,
        assignment.repository_id,
        userId
      );
    }
  }

  await ClassmojiService.assignment.publish(assignmentId);

  // Provisioning started: hand back the trigger session alone, exactly as the
  // repository publish does. Adding a `success` here would pop a "published"
  // toast (useNotifiedFetcher watches that key) while the repos are still being
  // created, and the progress modal is the honest feedback for that.
  if (repoResult && 'triggerSession' in repoResult) {
    return repoResult;
  }

  // The repository was already published, so publishing this assignment cut no
  // repos and nothing chained into opening its issues. Open them here: only
  // the first assignment on a repository gets them for free, when its repos are
  // created. Scoped to this assignment so its siblings are left alone.
  if (assignment.type === 'REPO' && assignment.repository_id) {
    const sessionId = nanoid();
    const classroom = await ClassmojiService.classroom.findById(classroomId);
    const repository = await ClassmojiService.repository.findById(assignment.repository_id);
    const existingRepos = await ClassmojiService.gitRepo.findByRepository(
      classroomSlug,
      assignment.repository_id
    );

    if (repository && classroom) {
      const missing = findMissingAssignments(repository as Repository, existingRepos as GitRepo[]);
      const mine = missing[assignmentId] ? { [assignmentId]: missing[assignmentId] } : {};
      const numMissing = Object.values(mine).reduce((n, a) => n + a.repos.length, 0);

      if (numMissing > 0) {
        await createMissingAssignments(classroom as Classroom, mine, sessionId);

        const accessToken = await auth.createPublicToken({
          scopes: { read: { tags: [`session_${sessionId}`] } },
        });

        return {
          triggerSession: {
            accessToken,
            id: sessionId,
            numReposToCreate: 0,
            numIssuesToCreate: 2 * numMissing, // gh + cf per issue
          },
        };
      }
    }
  }

  return { success: `Assignment "${assignment.title}" published` };
};

/** `classroomId` scopes the body-supplied repository — see `publishAssignment`. */
export const syncAssignment = async (
  classroomSlug: string,
  classroomId: string,
  repositoryId: string,
  _userId: string | null = null
) => {
  const classroom = await ClassmojiService.classroom.findById(classroomId);
  const repository = await ClassmojiService.repository.findById(repositoryId);
  const sessionId = nanoid();

  invariant(repository != null, 'Repository not found');
  invariant(repository.classroom_id === classroomId, 'Repository not found in classroom');

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
    syncResult = await syncSelfFormedTeamAssignment(
      classroomSlug,
      classroom!,
      repository!,
      sessionId
    );
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
  const existingRepos = await ClassmojiService.gitRepo.findByRepository(
    classroomSlug,
    repository.id
  );

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
  const existingRepos = await ClassmojiService.gitRepo.findByRepository(
    classroomSlug,
    repository.id
  );

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
  const existingRepos = await ClassmojiService.gitRepo.findByRepository(
    classroomSlug,
    repository.id
  );

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
