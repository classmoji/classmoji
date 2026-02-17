import { task, logger } from '@trigger.dev/sdk';
import dayjs from 'dayjs';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
dayjs.extend(isSameOrBefore);

import { ClassmojiService, HelperService, getGitProvider, ensureClassroomTeam } from '@classmoji/services';
import { titleToIdentifier } from '@classmoji/utils';
import { createGithubRepositoryAssignmentTask } from './repositoryAssignment.js';
import { updateRepository } from '../helpers/updateRepository.js';
import { createRepository } from '../helpers/createRepository.js';

export const createRepositoriesTask = task({
  id: 'create_repositories',
  queue: {
    concurrencyLimit: 1,
  },
  run: async payload => {
    const { logins, assignmentTitle, org, sessionId } = payload;

    const module = await ClassmojiService.module.findBySlugAndTitle(org, assignmentTitle);

    const classroom = await ClassmojiService.classroom.findBySlug(org);

    const [templateOwner, templateRepo] = module.template.split('/');
    const students = await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'STUDENT');
    const teams = await ClassmojiService.team.findByClassroomId(classroom.id);

    const gitProvider = getGitProvider(classroom.git_organization);
    const token = await gitProvider.getAccessToken();
    const githubOrganization = await gitProvider.getOrganization(classroom.git_organization.login);
    const organizationGithubPlan = githubOrganization.plan.name; // github plan name

    // Use slug if available, otherwise generate from title
    const moduleSlug = module.slug || titleToIdentifier(module.title);

    const reposData = logins.map(login => {
      const repoName = `${moduleSlug}-${login}`;
      const data = {
        repoName,
        classroom: classroom,
        module: module,
        templateOwner,
        templateRepo,
        token,
        organizationGithubPlan,
      };

      if (module.type === 'INDIVIDUAL') {
        data.student = students.find(student => student.login === login);
      } else {
        data.team = teams.find(team => team.slug === login);
      }

      const tags = [`session_${sessionId}`, `classroom_${org}`];

      return {
        payload: data,
        options: {
          tags,
        },
      };
    });

    await createRepositoryTask.batchTriggerAndWait(reposData, {
      concurrencyKey: org,
    });

    await ClassmojiService.module.update(module.id, {
      is_published: true,
    });
  },
});

export const createRepositoryTask = task({
  id: 'gh-create_repository',
  queue: {
    concurrencyLimit: 6,
  },
  run: async (payload, { ctx }) => {
    const { classroom } = payload;
    try {
      const repoId = await createRepository(payload);
      // Add collaborators to repo
      await addCollaboratorsToRepoTask.triggerAndWait(
        {
          ...payload,
        },
        { tags: ctx.run.tags, concurrencyKey: classroom.slug }
      );
      // Create repo in internal database
      const { output: studentRepo } = await createRepoInDatabaseTask.triggerAndWait(
        {
          ...payload,
          repoId,
        },
        { tags: ctx.run.tags, concurrencyKey: classroom.slug }
      );
      // Create GitHub Project for GROUP modules with project template
      if (payload.module.type === 'GROUP' && payload.module.project_template_id) {
        await createProjectForRepoTask.triggerAndWait(
          {
            classroom,
            module: payload.module,
            repoName: payload.repoName,
            repoId: studentRepo.id,
            team: payload.team,
          },
          { tags: ctx.run.tags, concurrencyKey: classroom.slug }
        );
      }

      // create assignments that should have been released.
      // this should only run when student joined after assignment had been released
      // or when assignment needs to be released but no repos yet
      const filteredAssignments = payload.module.assignments.filter(assignment =>
        dayjs(assignment.release_at).isSameOrBefore(dayjs())
      );
      const assignmentPayloads = filteredAssignments.map(assignment => {
        return {
          payload: {
            assignment,
            studentRepo,
            repoName: payload.repoName,
            organization: payload.classroom.git_organization,
          },
          options: { tags: ctx.run.tags },
        };
      });
      if (assignmentPayloads.length) {
        await createGithubRepositoryAssignmentTask.batchTriggerAndWait(assignmentPayloads, {
          concurrencyKey: classroom.slug,
        });
        for (const assignmentPayload of assignmentPayloads) {
          ClassmojiService.assignment.update(assignmentPayload.payload.assignment.id, {
            is_published: true,
          });
        }
      }
    } catch (error) {
      logger.error('Error creating repository', error);
      throw error;
    }
  },
});

export const addCollaboratorsToRepoTask = task({
  id: 'gh-add_collaborator_to_repo',
  queue: {
    concurrencyLimit: 6,
  },
  run: async payload => {
    try {
      const { module, classroom, repoName } = payload;
      const gitOrgLogin = classroom.git_organization.login;
      const gitProvider = getGitProvider(classroom.git_organization);

      // Add student to repo
      if (module.type === 'INDIVIDUAL') {
        await gitProvider.addCollaborator(
          gitOrgLogin,
          repoName,
          payload.student.login,
          'maintain'
        );
      } else {
        await gitProvider.addTeamToRepo(
          gitOrgLogin,
          repoName,
          payload.team.slug,
          'maintain'
        );
      }

      // Ensure assistants team exists and add to repo (e.g., "cs101-25w-assistants")
      const team = await ensureClassroomTeam(gitProvider, gitOrgLogin, classroom, 'ASSISTANT');
      await gitProvider.addTeamToRepo(
        gitOrgLogin,
        repoName,
        team.slug,
        'maintain'
      );
    } catch (error) {
      console.error('Error adding collaborator to repo', error);
      throw error;
    }
  },
});

export const createRepoInDatabaseTask = task({
  id: 'cf-create_repository',
  run: async payload => {
    try {
      const { module, classroom, repoName } = payload;
      const isIndividualModule = module.type === 'INDIVIDUAL';

      return ClassmojiService.repository.create({
        moduleId: module.id,
        classroom,
        repoName,
        student: isIndividualModule ? payload.student : null,
        team: isIndividualModule ? null : payload.team,
        providerId: payload.repoId,
      });
    } catch (error) {
      console.error('Error creating repository in database', error);
      throw error;
    }
  },
});

export const deleteRepoTask = task({
  id: 'delete_repository',
  queue: {
    concurrencyLimit: 6,
  },
  run: async payload => {
    return HelperService.deleteRepository(payload);
  },
});

export const updateRepositoryTask = task({
  id: 'update_repository',
  queue: {
    concurrencyLimit: 6,
  },
  run: async payload => {
    return updateRepository(payload);
  },
});

/**
 * Create a GitHub Project for a repository by copying from a template
 */
export const createProjectForRepoTask = task({
  id: 'gh-create_project_for_repo',
  queue: {
    concurrencyLimit: 4,
  },
  run: async payload => {
    const { classroom, module, repoName, repoId, team } = payload;

    try {
      const gitProvider = getGitProvider(classroom.git_organization);
      const org = classroom.git_organization.login;

      // Get organization node_id for project creation
      const orgNodeId = await gitProvider.getOrganizationNodeId(org);

      // Use repo name as project title
      const projectTitle = repoName;

      // Copy project from template
      const project = await gitProvider.copyProjectFromTemplate(
        module.project_template_id,
        orgNodeId,
        projectTitle
      );

      logger.info(`Created project "${projectTitle}" for repo ${repoName}`, {
        projectNumber: project.number,
        projectUrl: project.url,
      });

      // Update repository with project info
      await ClassmojiService.repository.update(repoId, {
        project_id: project.id,
        project_number: project.number,
      });

      // Link repository to project
      const repo = await gitProvider.getRepository(org, repoName);
      await gitProvider.linkRepoToProject(project.id, repo.node_id);

      // Add student team to project
      if (team?.slug) {
        await gitProvider.addTeamToProject(project.id, org, team.slug, 'WRITER');
      }

      // Add assistants team to project
      const assistantsTeam = await ensureClassroomTeam(gitProvider, org, classroom, 'ASSISTANT');
      await gitProvider.addTeamToProject(project.id, org, assistantsTeam.slug, 'WRITER');

      return project;
    } catch (error) {
      logger.error(`Error creating project for repo ${repoName}:`, error);
      // Don't throw - project creation is optional, don't fail the whole workflow
      return null;
    }
  },
});

/**
 * Create projects for all repos in a module that don't have one (backfill)
 */
export const createProjectsForModuleTask = task({
  id: 'gh-create_projects_for_module',
  queue: {
    concurrencyLimit: 1,
  },
  run: async (payload, { ctx }) => {
    const { moduleId, classroomSlug } = payload;

    const module = await ClassmojiService.module.findById(moduleId);
    const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
    const repos = await ClassmojiService.repository.findByModule(classroomSlug, moduleId);

    // Filter repos that don't have projects
    const reposWithoutProjects = repos.filter(repo => !repo.project_id);

    if (reposWithoutProjects.length === 0) {
      logger.info('All repos already have projects');
      return { created: 0, total: repos.length };
    }

    logger.info(`Creating projects for ${reposWithoutProjects.length} repos`);

    const payloads = reposWithoutProjects.map(repo => ({
      payload: {
        classroom,
        module,
        repoName: repo.name,
        repoId: repo.id,
        team: repo.team,
      },
      options: { tags: ctx.run.tags },
    }));

    await createProjectForRepoTask.batchTriggerAndWait(payloads, {
      concurrencyKey: classroomSlug,
    });

    return {
      created: reposWithoutProjects.length,
      total: repos.length,
    };
  },
});

