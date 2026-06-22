import { task, schedules, logger } from '@trigger.dev/sdk';
import { ClassmojiService, HelperService, getGitProvider } from '@classmoji/services';
import { titleToIdentifier } from '@classmoji/utils';
import { createRepositoriesTask } from './gitRepo.ts';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';

type GitOrganizationLike = Parameters<typeof getGitProvider>[0] & { login: string | null };
type StrictGitOrganizationLike = Parameters<typeof getGitProvider>[0] & { login: string };
type RepositoryType = 'INDIVIDUAL' | 'GROUP';

interface GitRepoAssignmentTaskContext {
  ctx: {
    run: {
      tags?: string[];
    };
  };
}

interface IssueAssignmentRecord {
  id: string;
  title: string;
  body?: string | null;
  description?: string | null;
}

interface StudentRepositoryRecord {
  id: string;
  project_id?: string | null;
}

interface CreateGithubRepositoryAssignmentTaskPayload {
  repoName: string;
  assignment: IssueAssignmentRecord;
  studentRepo: StudentRepositoryRecord;
  organization?: GitOrganizationLike;
  classroom?: {
    git_organization: GitOrganizationLike;
  };
}

interface CreateDatabaseRepositoryAssignmentTaskPayload {
  assignment: IssueAssignmentRecord;
  studentRepo: StudentRepositoryRecord;
  issueNumber: number;
  id: string;
}

interface GitRepoAssignmentGraderTaskPayload {
  repoName: string;
  gitOrganization: StrictGitOrganizationLike;
  githubIssueNumber: number;
  graderLogin: string;
  graderId: string;
  gitRepoAssignmentId: string;
}

interface UpdateRepositoryAssignmentPayload {
  gitRepoAssignmentId: string;
  status?: string;
  closed_at?: string | Date | null;
}

interface UpdateRepositoryAssignmentTaskPayload {
  payload: UpdateRepositoryAssignmentPayload;
}

interface WebhookIssuePayload {
  id: number | string;
  closed_at?: string | Date | null;
}

interface GitRepoAssignmentWebhookTaskPayload {
  issue: WebhookIssuePayload;
}

interface ClassroomRecord {
  id: string;
  slug: string;
  git_organization: GitOrganizationLike;
}

interface ScheduleTaskPayload {
  type: 'DECLARATIVE' | 'IMPERATIVE';
  timestamp: Date;
  timezone: string;
  scheduleId: string;
  upcoming: Date[];
  externalId?: string;
  lastTimestamp?: Date;
}

interface ReleaseModuleRecord {
  id: string;
  title: string;
  slug: string | null;
  type: RepositoryType;
  tag_id: string | null;
  is_published: boolean;
  classroom: ClassroomRecord;
}

interface ReleaseAssignmentRecord extends IssueAssignmentRecord {
  repository_id: string;
  repository: ReleaseModuleRecord;
}

interface StudentRecord {
  login: string | null;
}

interface TeamRecord {
  slug: string;
}

interface ExistingGitRepoRecord extends StudentRepositoryRecord {
  name: string;
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const getErrorStatus = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'status' in error
    ? typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined
    : undefined;

const uniqueLogins = (logins: string[]): string[] => [
  ...new Set(logins.map(login => login.trim()).filter(Boolean)),
];

const repoNameForLogin = (repositorySlug: string, login: string): string =>
  `${repositorySlug}-${login}`;

const ensureReposForLogins = async (
  classroom: ClassroomRecord,
  repository: ReleaseModuleRecord,
  repositorySlug: string,
  logins: string[],
  sessionId: string
): Promise<ExistingGitRepoRecord[]> => {
  const recipients = uniqueLogins(logins);
  if (recipients.length === 0) return [];

  const existingRepos = (await ClassmojiService.gitRepo.findByRepository(
    classroom.slug,
    repository.id
  )) as ExistingGitRepoRecord[];

  const existingNames = new Set(existingRepos.map(repo => repo.name));
  const missingLogins = recipients.filter(
    login => !existingNames.has(repoNameForLogin(repositorySlug, login))
  );

  if (missingLogins.length > 0) {
    logger.info('Creating missing repos before assignment release', {
      classroomSlug: classroom.slug,
      repositoryId: repository.id,
      repositoryTitle: repository.title,
      missing: missingLogins.length,
      existing: existingRepos.length,
    });

    await createRepositoriesTask.triggerAndWait(
      {
        logins: missingLogins,
        assignmentTitle: repository.title,
        org: classroom.slug,
        sessionId,
      },
      { concurrencyKey: classroom.slug }
    );

    return (await ClassmojiService.gitRepo.findByRepository(
      classroom.slug,
      repository.id
    )) as ExistingGitRepoRecord[];
  }

  return existingRepos;
};

export const createGithubRepositoryAssignmentTask = task({
  id: 'gh-create_git_repo_assignment',
  queue: {
    concurrencyLimit: 4,
  },
  run: async (
    payload: CreateGithubRepositoryAssignmentTaskPayload,
    { ctx }: GitRepoAssignmentTaskContext
  ) => {
    const { repoName, assignment, studentRepo } = payload;
    const organization = payload.organization || payload.classroom?.git_organization;

    if (!organization?.login) {
      throw new Error(
        'Missing organization in payload - expected organization or classroom.git_organization'
      );
    }

    // Idempotency guard: skip if this repo already has this assignment. createIssue mints a
    // NEW GitHub issue every run, so a re-trigger (Sync, manual re-run, webhook redelivery)
    // would otherwise create duplicate issues + rows. Centralizing the guard here protects
    // every caller (gh-create_git_repo, daily_git_repo_assignments_release, and the
    // already-guarded release_git_repo_assignments_now).
    const existingAssignment = await ClassmojiService.gitRepoAssignment.findFirst({
      assignment_id: assignment.id,
      git_repo_id: studentRepo.id,
    });
    if (existingAssignment) {
      logger.info('Assignment issue already exists for this repo — skipping', {
        repoName,
        assignmentId: assignment.id,
        gitRepoId: studentRepo.id,
      });
      return;
    }

    const gitProvider = getGitProvider(organization);
    const existingAssignment = await ClassmojiService.gitRepoAssignment.findFirst({
      assignment_id: assignment.id,
      git_repo_id: studentRepo.id,
    });

    if (existingAssignment) {
      logger.info('GitHub assignment issue already exists; skipping creation', {
        organization: organization.login,
        repoName,
        assignmentId: assignment.id,
        assignmentTitle: assignment.title,
        studentRepoId: studentRepo.id,
        gitRepoAssignmentId: existingAssignment.id,
      });
      return existingAssignment;
    }

    let issue: { id: string; number: number };

    try {
      const existingIssue = await gitProvider.findIssueByTitle(
        organization.login,
        repoName,
        assignment.title
      );

      if (existingIssue) {
        logger.info('Found existing GitHub assignment issue; adopting it', {
          organization: organization.login,
          repoName,
          assignmentId: assignment.id,
          assignmentTitle: assignment.title,
          studentRepoId: studentRepo.id,
          issueNumber: existingIssue.number,
        });
        issue = existingIssue;
      } else {
        issue = await gitProvider.createIssue(organization.login, repoName, {
          title: assignment.title,
          body: assignment.body ?? undefined,
          description: assignment.description ?? undefined,
        });
      }
    } catch (error: unknown) {
      const status = getErrorStatus(error);
      const context = {
        status,
        organization: organization.login,
        repoName,
        assignmentId: assignment.id,
        assignmentTitle: assignment.title,
        studentRepoId: studentRepo.id,
      };

      logger.error('Failed to create GitHub assignment issue', {
        ...context,
        error: getErrorMessage(error),
      });

      if (status === 404) {
        throw new Error(
          `Could not create assignment issue in ${organization.login}/${repoName}: repository was not found or is not accessible to the GitHub App. assignmentId=${assignment.id}, studentRepoId=${studentRepo.id}`
        );
      }

      throw new Error(
        `Could not create assignment issue in ${organization.login}/${repoName}: ${getErrorMessage(error)}. assignmentId=${assignment.id}, studentRepoId=${studentRepo.id}`
      );
    }

    const { id, number: issueNumber } = issue;

    if (studentRepo.project_id) {
      try {
        const issueNodeId = await gitProvider.getIssueNodeId(
          organization.login,
          repoName,
          issueNumber
        );
        await gitProvider.addIssueToProject(studentRepo.project_id, issueNodeId);
        logger.info(`Linked issue #${issueNumber} to project`, {
          repoName,
          projectId: studentRepo.project_id,
        });
      } catch (error: unknown) {
        logger.warn(`Failed to link issue #${issueNumber} to project: ${getErrorMessage(error)}`);
      }
    }

    await createDatabaseRepositoryAssignmentTask.triggerAndWait(
      {
        ...payload,
        id,
        issueNumber,
      },
      {
        tags: ctx.run.tags,
        concurrencyKey: organization.login,
      }
    );
  },
});

export const createDatabaseRepositoryAssignmentTask = task({
  id: 'cf-create_git_repo_assignment',
  run: async (payload: CreateDatabaseRepositoryAssignmentTaskPayload) => {
    const { assignment, studentRepo, issueNumber, id } = payload;

    const data = {
      id,
      assignment_id: assignment.id,
      git_repo_id: studentRepo.id,
      provider: 'GITHUB',
      provider_id: String(id),
      provider_issue_number: issueNumber,
    };

    return ClassmojiService.gitRepoAssignment.create(data);
  },
});

export const addGraderToRepositoryAssignmentTask = task({
  id: 'add_grader_to_git_repo_assignment',
  run: async (payload: GitRepoAssignmentGraderTaskPayload) => {
    return HelperService.addGraderToGitRepoAssignment(payload);
  },
});

export const removeGraderFromRepositoryAssignmentTask = task({
  id: 'remove_grader_from_git_repo_assignment',
  run: async (payload: GitRepoAssignmentGraderTaskPayload) => {
    return HelperService.removeGraderFromGitRepoAssignment(payload);
  },
});

export const updateRepositoryAssignmentTask = task({
  id: 'update_git_repo_assignment',
  run: async ({ payload }: UpdateRepositoryAssignmentTaskPayload) => {
    const { gitRepoAssignmentId, ...updates } = payload;
    return ClassmojiService.gitRepoAssignment.update(gitRepoAssignmentId, updates);
  },
});

export const repositoryAssignmentClosedHandlerTask = task({
  id: 'webhook-git_repo_assignment_closed_handler',
  run: async (payload: GitRepoAssignmentWebhookTaskPayload) => {
    const { issue } = payload;
    const repoAssignment = await ClassmojiService.gitRepoAssignment.findByProviderId(
      'GITHUB',
      String(issue.id)
    );

    if (!repoAssignment?.assignment) {
      logger.info('GitRepo assignment not found in database', { issue });
      return;
    }

    return updateRepositoryAssignmentTask.trigger({
      payload: {
        gitRepoAssignmentId: repoAssignment.id,
        status: 'CLOSED',
        closed_at: issue.closed_at,
      },
    });
  },
});

export const repositoryAssignmentDeletedHandlerTask = task({
  id: 'webhook-git_repo_assignment_deleted_handler',
  run: async (payload: GitRepoAssignmentWebhookTaskPayload) => {
    const { issue } = payload;
    const repoAssignment = await ClassmojiService.gitRepoAssignment.findByProviderId(
      'GITHUB',
      String(issue.id)
    );

    if (repoAssignment?.assignment) {
      return ClassmojiService.gitRepoAssignment.deleteById(repoAssignment.id);
    }
  },
});

export const dailyRepositoryAssignmentsReleaseTask = schedules.task({
  id: 'daily_git_repo_assignments_release',
  run: async (_payload: ScheduleTaskPayload, { ctx }: GitRepoAssignmentTaskContext) => {
    try {
      const assignmentsToRelease = (await ClassmojiService.assignment.findReadyForRelease(
        dayjs().endOf('day').toDate()
      )) as ReleaseAssignmentRecord[];

      logger.debug('Assignments to release', { assignmentsToRelease });

      if (assignmentsToRelease.length === 0) {
        logger.info('No assignments to release');
        return;
      }

      logger.info('Found assignments to release', { count: assignmentsToRelease.length });

      const moduleGroups: Record<string, ReleaseAssignmentRecord[]> = {};
      for (const assignment of assignmentsToRelease) {
        if (!moduleGroups[assignment.repository_id]) {
          moduleGroups[assignment.repository_id] = [];
        }
        moduleGroups[assignment.repository_id].push(assignment);
      }

      for (const repositoryId in moduleGroups) {
        const moduleAssignments = moduleGroups[repositoryId];
        const repository = moduleAssignments[0].repository;
        const classroom = repository.classroom;
        const gitOrg = classroom.git_organization;

        let logins: string[] = [];

        if (repository.type === 'INDIVIDUAL') {
          const students: StudentRecord[] =
            await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'STUDENT');

          logins = students
            .map((user: StudentRecord) => user.login || '')
            .filter(login => login !== '');
        } else if (repository.tag_id) {
          const teams: TeamRecord[] = await ClassmojiService.organizationTag.findTeamsByTag(
            repository.tag_id
          );
          logins = teams.map((team: TeamRecord) => team.slug);
        }

        if (!repository.is_published) {
          logger.info('Publishing Repository', {
            title: repository.title,
            org: classroom.slug,
          });

          const recipients = uniqueLogins(logins);

          if (recipients.length > 0) {
            await createRepositoriesTask.triggerAndWait({
              logins: recipients,
              assignmentTitle: repository.title,
              org: classroom.slug,
              sessionId: nanoid(),
            });
          }
        } else {
          const repositorySlug = repository.slug || titleToIdentifier(repository.title);
          const recipients = uniqueLogins(logins);
          const repos = await ensureReposForLogins(
            classroom,
            repository,
            repositorySlug,
            recipients,
            nanoid()
          );
          const reposByName = new Map(repos.map(repo => [repo.name, repo]));

          for await (const assignment of moduleAssignments) {
            logger.info('Processing assignment', { title: assignment.title });

            const payloads = recipients.map(login => {
              const repoName = repoNameForLogin(repositorySlug, login);
              const studentRepo = reposByName.get(repoName);

              if (!studentRepo) {
                throw new Error(
                  `GitRepo not found after provisioning for ${repoName} in classroom ${classroom.slug}`
                );
              }

              return {
                payload: {
                  assignment,
                  organization: gitOrg,
                  repoName,
                  studentRepo,
                },
                options: { tags: ctx.run.tags },
              };
            });

            await createGithubRepositoryAssignmentTask.batchTriggerAndWait(payloads);
            await ClassmojiService.assignment.update(assignment.id, {
              is_published: true,
            });
          }
        }
      }
    } catch (error: unknown) {
      logger.error('Error in dailyRepositoryAssignmentsReleaseTask', { error });
    }
  },
});

interface ReleaseAssignmentsNowPayload {
  repositoryId: string;
  // When omitted, every not-yet-released assignment in the repository is released.
  assignmentIds?: string[];
}

/**
 * Release a repository's assignment(s) on demand — the same work the daily
 * release cron does, but immediately and scoped to one repository. Ensures the
 * student/team repos exist (creating them from the template if needed), then
 * creates the assignment issue on each repo and marks each assignment released.
 * The caller is expected to have already set release_at on the target
 * assignments so the student-facing release gate (is_published AND release_at)
 * is satisfied.
 */
export const releaseAssignmentsNowTask = task({
  id: 'release_git_repo_assignments_now',
  run: async (payload: ReleaseAssignmentsNowPayload, { ctx }: GitRepoAssignmentTaskContext) => {
    const assignments = (await ClassmojiService.assignment.findForReleaseByRepository(
      payload.repositoryId,
      payload.assignmentIds
    )) as ReleaseAssignmentRecord[];

    if (assignments.length === 0) {
      logger.info('No assignments to release now', { repositoryId: payload.repositoryId });
      return;
    }

    const repository = assignments[0].repository;
    const classroom = repository.classroom;
    const gitOrg = classroom.git_organization;

    let logins: string[] = [];
    if (repository.type === 'INDIVIDUAL') {
      const students: StudentRecord[] = await ClassmojiService.classroomMembership.findUsersByRole(
        classroom.id,
        'STUDENT'
      );
      logins = students.map(user => user.login || '').filter(login => login !== '');
    } else if (repository.tag_id) {
      const teams: TeamRecord[] = await ClassmojiService.organizationTag.findTeamsByTag(
        repository.tag_id
      );
      logins = teams.map(team => team.slug);
    }

    const recipients = uniqueLogins(logins);

    if (recipients.length === 0) {
      logger.info('No recipients to release to', { repositoryId: payload.repositoryId });
      return;
    }

    const repositorySlug = repository.slug || titleToIdentifier(repository.title);
    const repos = await ensureReposForLogins(
      classroom,
      repository,
      repositorySlug,
      recipients,
      nanoid()
    );
    const reposByName = new Map(repos.map(repo => [repo.name, repo]));

    for await (const assignment of assignments) {
      logger.info('Releasing assignment now', { title: assignment.title });

      const payloads = (
        await Promise.all(
          recipients.map(async login => {
            const repoName = repoNameForLogin(repositorySlug, login);
            const studentRepo = reposByName.get(repoName);

            if (!studentRepo) {
              throw new Error(
                `GitRepo not found after provisioning for ${repoName} in classroom ${classroom.slug}`
              );
            }

            // Skip repos that already have this assignment so a re-run (or a
            // retry after a partial failure) doesn't create duplicate issues.
            const existing = await ClassmojiService.gitRepoAssignment.findFirst({
              assignment_id: assignment.id,
              git_repo_id: studentRepo.id,
            });
            if (existing) return null;

            return {
              payload: {
                assignment,
                organization: gitOrg,
                repoName,
                studentRepo,
              },
              options: { tags: ctx.run.tags },
            };
          })
        )
      ).filter((p): p is NonNullable<typeof p> => p !== null);

      if (payloads.length > 0) {
        await createGithubRepositoryAssignmentTask.batchTriggerAndWait(payloads);
      }
      await ClassmojiService.assignment.update(assignment.id, { is_published: true });
    }
  },
});
