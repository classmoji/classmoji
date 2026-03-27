import { task, schedules, logger } from '@trigger.dev/sdk';
import { ClassmojiService, HelperService, getGitProvider } from '@classmoji/services';
import { titleToIdentifier } from '@classmoji/utils';
import { createRepositoriesTask } from './repository.ts';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';

type GitOrganizationLike = Parameters<typeof getGitProvider>[0] & { login: string | null };
type StrictGitOrganizationLike = Parameters<typeof getGitProvider>[0] & { login: string };
type ModuleType = 'INDIVIDUAL' | 'GROUP';

interface RepositoryAssignmentTaskContext {
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

interface RepositoryAssignmentGraderTaskPayload {
  repoName: string;
  gitOrganization: StrictGitOrganizationLike;
  githubIssueNumber: number;
  graderLogin: string;
  graderId: string;
  repositoryAssignmentId: string;
}

interface UpdateRepositoryAssignmentPayload {
  repositoryAssignmentId: string;
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

interface RepositoryAssignmentWebhookTaskPayload {
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
  type: ModuleType;
  tag_id: string | null;
  is_published: boolean;
  classroom: ClassroomRecord;
}

interface ReleaseAssignmentRecord extends IssueAssignmentRecord {
  module_id: string;
  module: ReleaseModuleRecord;
}

interface StudentRecord {
  login: string | null;
}

interface TeamRecord {
  slug: string;
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createGithubRepositoryAssignmentTask = task({
  id: 'gh-create_repository_assignment',
  queue: {
    concurrencyLimit: 4,
  },
  run: async (
    payload: CreateGithubRepositoryAssignmentTaskPayload,
    { ctx }: RepositoryAssignmentTaskContext
  ) => {
    const { repoName, assignment, studentRepo } = payload;
    const organization = payload.organization || payload.classroom?.git_organization;

    if (!organization?.login) {
      throw new Error('Missing organization in payload - expected organization or classroom.git_organization');
    }

    const gitProvider = getGitProvider(organization);
    const { id, number: issueNumber } = await gitProvider.createIssue(
      organization.login,
      repoName,
      {
        title: assignment.title,
        body: assignment.body ?? undefined,
        description: assignment.description ?? undefined,
      }
    );

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
  id: 'cf-create_repository_assignment',
  run: async (payload: CreateDatabaseRepositoryAssignmentTaskPayload) => {
    const { assignment, studentRepo, issueNumber, id } = payload;

    const data = {
      id,
      assignment_id: assignment.id,
      repository_id: studentRepo.id,
      provider: 'GITHUB',
      provider_id: String(id),
      provider_issue_number: issueNumber,
    };

    return ClassmojiService.repositoryAssignment.create(data);
  },
});

export const addGraderToRepositoryAssignmentTask = task({
  id: 'add_grader_to_repository_assignment',
  run: async (payload: RepositoryAssignmentGraderTaskPayload) => {
    return HelperService.addGraderToRepositoryAssignment(payload);
  },
});

export const removeGraderFromRepositoryAssignmentTask = task({
  id: 'remove_grader_from_repository_assignment',
  run: async (payload: RepositoryAssignmentGraderTaskPayload) => {
    return HelperService.removeGraderFromRepositoryAssignment(payload);
  },
});

export const updateRepositoryAssignmentTask = task({
  id: 'update_repository_assignment',
  run: async ({ payload }: UpdateRepositoryAssignmentTaskPayload) => {
    const { repositoryAssignmentId, ...updates } = payload;
    return ClassmojiService.repositoryAssignment.update(repositoryAssignmentId, updates);
  },
});

export const repositoryAssignmentClosedHandlerTask = task({
  id: 'webhook-repository_assignment_closed_handler',
  run: async (payload: RepositoryAssignmentWebhookTaskPayload) => {
    const { issue } = payload;
    const repoAssignment = await ClassmojiService.repositoryAssignment.findByProviderId(
      'GITHUB',
      String(issue.id)
    );

    if (!repoAssignment?.assignment) {
      logger.info('Repository assignment not found in database', { issue });
      return;
    }

    return updateRepositoryAssignmentTask.trigger({
      payload: {
        repositoryAssignmentId: repoAssignment.id,
        status: 'CLOSED',
        closed_at: issue.closed_at,
      },
    });
  },
});

export const repositoryAssignmentDeletedHandlerTask = task({
  id: 'webhook-repository_assignment_deleted_handler',
  run: async (payload: RepositoryAssignmentWebhookTaskPayload) => {
    const { issue } = payload;
    const repoAssignment = await ClassmojiService.repositoryAssignment.findByProviderId(
      'GITHUB',
      String(issue.id)
    );

    if (repoAssignment?.assignment) {
      return ClassmojiService.repositoryAssignment.deleteById(repoAssignment.id);
    }
  },
});

export const dailyRepositoryAssignmentsReleaseTask = schedules.task({
  id: 'daily_repository_assignments_release',
  run: async (_payload: ScheduleTaskPayload, { ctx }: RepositoryAssignmentTaskContext) => {
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
        if (!moduleGroups[assignment.module_id]) {
          moduleGroups[assignment.module_id] = [];
        }
        moduleGroups[assignment.module_id].push(assignment);
      }

      for (const moduleId in moduleGroups) {
        const moduleAssignments = moduleGroups[moduleId];
        const module = moduleAssignments[0].module;
        const classroom = module.classroom;
        const gitOrg = classroom.git_organization;

        let logins: string[] = [];

        if (module.type === 'INDIVIDUAL') {
          const students: StudentRecord[] = await ClassmojiService.classroomMembership.findUsersByRole(
            classroom.id,
            'STUDENT'
          );

          logins = students
            .map((user: StudentRecord) => user.login || '')
            .filter(login => login !== '');
        } else if (module.tag_id) {
          const teams: TeamRecord[] = await ClassmojiService.organizationTag.findTeamsByTag(
            module.tag_id
          );
          logins = teams.map((team: TeamRecord) => team.slug);
        }

        if (!module.is_published) {
          logger.info('Publishing Module', {
            title: module.title,
            org: classroom.slug,
          });

          if (logins.length > 0) {
            await createRepositoriesTask.triggerAndWait({
              logins,
              assignmentTitle: module.title,
              org: classroom.slug,
              sessionId: nanoid(),
            });
          }
        } else {
          const moduleSlug = module.slug || titleToIdentifier(module.title);

          for await (const assignment of moduleAssignments) {
            logger.info('Processing assignment', { title: assignment.title });

            const payloads = await Promise.all(
              logins.map(async login => {
                const studentRepo = await ClassmojiService.repository.find({
                  name: `${moduleSlug}-${login}`,
                  classroom_id: classroom.id,
                });

                if (!studentRepo) {
                  throw new Error(`Repository not found for ${moduleSlug}-${login}`);
                }

                return {
                  payload: {
                    assignment,
                    organization: gitOrg,
                    repoName: `${moduleSlug}-${login}`,
                    studentRepo,
                  },
                  options: { tags: ctx.run.tags },
                };
              })
            );

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
