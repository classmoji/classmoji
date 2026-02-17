import { task, schedules, logger } from '@trigger.dev/sdk';
import { ClassmojiService, HelperService, getGitProvider } from '@classmoji/services';
import { titleToIdentifier } from '@classmoji/utils';
import { createRepositoriesTask } from './repository.js';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';

export const createGithubRepositoryAssignmentTask = task({
  id: 'gh-create_repository_assignment',
  queue: {
    concurrencyLimit: 4,
  },
  run: async (payload, { ctx }) => {
    const { repoName, assignment, studentRepo } = payload;
    // Support both payload formats: direct 'organization' or nested in 'classroom.git_organization'
    const organization = payload.organization || payload.classroom?.git_organization;
    if (!organization) {
      throw new Error('Missing organization in payload - expected organization or classroom.git_organization');
    }
    const gitProvider = getGitProvider(organization);
    // Creates a GitHub issue for the repository assignment
    const { id, number: issueNumber } = await gitProvider.createIssue(organization.login, repoName, assignment);

    // Link issue to project if repo has one
    if (studentRepo?.project_id) {
      try {
        // Get issue node_id for GraphQL API
        const issueNodeId = await gitProvider.getIssueNodeId(organization.login, repoName, issueNumber);
        await gitProvider.addIssueToProject(studentRepo.project_id, issueNodeId);
        logger.info(`Linked issue #${issueNumber} to project`, {
          repoName,
          projectId: studentRepo.project_id,
        });
      } catch (error) {
        // Log but don't fail - issue linking is optional
        logger.warn(`Failed to link issue #${issueNumber} to project:`, error.message);
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
  run: async payload => {
    const { assignment, studentRepo, issueNumber, id } = payload;

    const data = {
      id: id,
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
  run: async payload => {
    return HelperService.addGraderToRepositoryAssignment(payload);
  },
});

export const removeGraderFromRepositoryAssignmentTask = task({
  id: 'remove_grader_from_repository_assignment',
  run: async payload => {
    return HelperService.removeGraderFromRepositoryAssignment(payload);
  },
});

export const updateRepositoryAssignmentTask = task({
  id: 'update_repository_assignment',
  run: async ({ payload }) => {
    const { repositoryAssignmentId, ...updates } = payload;
    return ClassmojiService.repositoryAssignment.update(repositoryAssignmentId, updates);
  },
});

export const repositoryAssignmentClosedHandlerTask = task({
  id: 'webhook-repository_assignment_closed_handler',
  run: async payload => {
    // Note: payload.issue refers to the GitHub issue data from the webhook
    const { issue } = payload;
    // Use findByProviderId since issue.id is GitHub's numeric ID, not our UUID
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
  run: async payload => {
    // Note: payload.issue refers to the GitHub issue data from the webhook
    const { issue } = payload;
    // Use findByProviderId since issue.id is GitHub's numeric ID, not our UUID
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
  run: async (_, { ctx }) => {
    try {
      // Find assignments ready to be released (release_at <= now and not published)
      const assignmentsToRelease = await ClassmojiService.assignment.findReadyForRelease(
        dayjs().endOf('day').toDate()
      );

      logger.debug('Assignments to release', { assignmentsToRelease });

      if (assignmentsToRelease.length === 0) {
        logger.info('No assignments to release');
        return;
      } else {
        logger.info('Found assignments to release', { count: assignmentsToRelease.length });
      }

      // Group assignments by module
      const moduleGroups = {};
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

        let logins = [];

        // handle individual and team assignments differently
        if (module.type === 'INDIVIDUAL') {
          const students = await ClassmojiService.classroomMembership.findUsersByRole(
            classroom.id,
            'STUDENT'
          );

          logins = students.map(user => user.login || '').filter(login => login !== '');
        } else {
          const teams = await ClassmojiService.organizationTag.findTeamsByTag(module.tag_id);
          logins = teams.map(team => team.slug);
        }

        // if module is not published, publish it (this should also create repos)
        if (!module.is_published) {
          logger.info('Publishing Module', {
            title: module.title,
            org: classroom.slug,
          });
          if (logins.length > 0) {
            // this will create repos and repository assignments (GitHub issues)
            await createRepositoriesTask.triggerAndWait({
              logins: logins,
              assignmentTitle: module.title,
              org: classroom.slug,
              sessionId: nanoid(),
            });
          }
        } else {
          // if module is published, release individual assignments
          // Use slug if available, otherwise generate from title
          const moduleSlug = module.slug || titleToIdentifier(module.title);

          for await (const assignment of moduleAssignments) {
            logger.info('Processing assignment', { title: assignment.title });

            const payloads = await Promise.all(
              logins.map(async login => {
                const studentRepo = await ClassmojiService.repository.find({
                  name: `${moduleSlug}-${login}`,
                  classroom_id: classroom.id,
                });

                return {
                  payload: {
                    assignment: assignment,
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
    } catch (error) {
      logger.error('Error in dailyRepositoryAssignmentsReleaseTask', error);
    }
  },
});
