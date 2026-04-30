import { task, logger } from '@trigger.dev/sdk';
import dayjs from 'dayjs';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
dayjs.extend(isSameOrBefore);

import {
  ClassmojiService,
  HelperService,
  getGitProvider,
  ensureClassroomTeam,
} from '@classmoji/services';
import { titleToIdentifier } from '@classmoji/utils';
import { createGithubRepositoryAssignmentTask } from './repositoryAssignment.ts';
import { updateRepository, type UpdateRepositoryPayload } from '../helpers/updateRepository.ts';
import { createRepository, type CreateRepositoryPayload } from '../helpers/createRepository.ts';

type GitOrganizationLike = Parameters<typeof getGitProvider>[0] & { login: string | null };
type StrictGitOrganizationLike = Parameters<typeof getGitProvider>[0] & { login: string };
type ModuleType = 'INDIVIDUAL' | 'GROUP';

interface ModuleAssignmentRecord {
  id: string;
  title: string;
  body?: string | null;
  description?: string | null;
  release_at: Date | string | null;
}

interface ModuleRecord {
  id: string;
  title: string;
  slug: string | null;
  type: ModuleType;
  template: string;
  project_template_id: string | null;
  assignments: ModuleAssignmentRecord[];
}

interface StudentRecord {
  id: string;
  login: string | null;
}

interface TeamRecord {
  id: string;
  slug: string;
}

interface ClassroomRecord {
  id: string;
  slug: string;
  git_organization: GitOrganizationLike;
}

interface RepositoryTaskContext {
  ctx: {
    run: {
      tags?: string[];
    };
  };
}

interface CreateRepositoriesTaskPayload {
  logins: string[];
  assignmentTitle: string;
  org: string;
  sessionId: string;
}

interface StandardCreateRepositoryTaskPayload extends Omit<CreateRepositoryPayload, 'classroom'> {
  classroom: ClassroomRecord;
  module: ModuleRecord;
  student?: StudentRecord;
  team?: TeamRecord;
}

interface LegacyCreateRepositoryTaskPayload {
  organization: ClassroomRecord;
  assignment: ModuleAssignmentRecord & {
    module: ModuleRecord;
  };
  repoName: string;
  templateOwner: string;
  templateRepo: string;
  student?: StudentRecord;
}

type CreateRepositoryTaskPayload =
  | StandardCreateRepositoryTaskPayload
  | LegacyCreateRepositoryTaskPayload;

interface AddCollaboratorsToRepoTaskPayload {
  module: ModuleRecord;
  classroom: ClassroomRecord;
  repoName: string;
  student?: StudentRecord;
  team?: TeamRecord;
}

interface CreateRepoInDatabaseTaskPayload extends StandardCreateRepositoryTaskPayload {
  repoId: string;
}

interface DeleteRepositoryTaskPayload {
  id?: string;
  name: string;
  gitOrganization: StrictGitOrganizationLike;
  deleteFromGithub?: boolean;
}

interface CreateProjectForRepoTaskPayload {
  classroom: ClassroomRecord;
  module: ModuleRecord;
  repoName: string;
  repoId: string;
  team?: TeamRecord | null;
}

interface CreateProjectsForModuleTaskPayload {
  moduleId: string;
  classroomSlug: string;
}

const isLegacyCreateRepositoryPayload = (
  payload: CreateRepositoryTaskPayload
): payload is LegacyCreateRepositoryTaskPayload => {
  return 'organization' in payload;
};

export const createRepositoriesTask = task({
  id: 'create_repositories',
  queue: {
    concurrencyLimit: 1,
  },
  run: async (payload: CreateRepositoriesTaskPayload) => {
    const { logins, assignmentTitle, org, sessionId } = payload;

    const module = await ClassmojiService.module.findBySlugAndTitle(org, assignmentTitle);
    const classroom = await ClassmojiService.classroom.findBySlug(org);

    if (!module || !classroom || !classroom.git_organization.login) {
      throw new Error(`Unable to load module or classroom for ${org}/${assignmentTitle}`);
    }

    const [templateOwner, templateRepo] = module.template.split('/');
    const students: StudentRecord[] = await ClassmojiService.classroomMembership.findUsersByRole(
      classroom.id,
      'STUDENT'
    );
    const teams: TeamRecord[] = await ClassmojiService.team.findByClassroomId(classroom.id);

    const gitProvider = getGitProvider(classroom.git_organization);
    const token = await gitProvider.getAccessToken();
    const githubOrganization = await gitProvider.getOrganization(classroom.git_organization.login);
    const organizationGithubPlan = githubOrganization.plan?.name ?? 'free';

    // Use slug if available, otherwise generate from title
    const moduleSlug = module.slug || titleToIdentifier(module.title);

    const reposData = logins.map(login => {
      const repoName = `${moduleSlug}-${login}`;
      const data: StandardCreateRepositoryTaskPayload = {
        repoName,
        classroom,
        module,
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
          concurrencyKey: org,
        },
      };
    });

    await createRepositoryTask.batchTriggerAndWait(reposData);

    await ClassmojiService.module.setPublished(module.id, true);
  },
});

export const createRepositoryTask = task({
  id: 'gh-create_repository',
  queue: {
    concurrencyLimit: 6,
  },
  run: async (payload: CreateRepositoryTaskPayload, { ctx }: RepositoryTaskContext) => {
    try {
      const normalizedPayload = isLegacyCreateRepositoryPayload(payload)
        ? await (async (): Promise<StandardCreateRepositoryTaskPayload> => {
            const classroom = payload.organization;
            const module = payload.assignment.module;
            const gitProvider = getGitProvider(classroom.git_organization);
            const orgLogin = classroom.git_organization.login;

            if (!orgLogin) {
              throw new Error('Missing Git organization login');
            }

            const token = await gitProvider.getAccessToken();
            const githubOrganization = await gitProvider.getOrganization(orgLogin);

            return {
              classroom,
              module,
              repoName: payload.repoName,
              templateOwner: payload.templateOwner,
              templateRepo: payload.templateRepo,
              token,
              organizationGithubPlan: githubOrganization.plan?.name ?? 'free',
              student: payload.student,
            };
          })()
        : payload;
      const { classroom } = normalizedPayload;
      const repoId = await createRepository(normalizedPayload);

      await addCollaboratorsToRepoTask.triggerAndWait(
        {
          ...normalizedPayload,
        },
        { tags: ctx.run.tags, concurrencyKey: classroom.slug }
      );

      const triggerResult = await createRepoInDatabaseTask.triggerAndWait(
        {
          ...normalizedPayload,
          repoId,
        },
        { tags: ctx.run.tags, concurrencyKey: classroom.slug }
      );

      if (!triggerResult.ok) {
        throw triggerResult.error;
      }

      const studentRepo = triggerResult.output;

      if (
        normalizedPayload.module.type === 'GROUP' &&
        normalizedPayload.module.project_template_id
      ) {
        await createProjectForRepoTask.triggerAndWait(
          {
            classroom,
            module: normalizedPayload.module,
            repoName: normalizedPayload.repoName,
            repoId: studentRepo.id,
            team: normalizedPayload.team,
          },
          { tags: ctx.run.tags, concurrencyKey: classroom.slug }
        );
      }

      const filteredAssignments = normalizedPayload.module.assignments.filter(assignment =>
        dayjs(assignment.release_at).isSameOrBefore(dayjs())
      );

      const assignmentPayloads = filteredAssignments.map(assignment => ({
        payload: {
          assignment,
          studentRepo,
          repoName: normalizedPayload.repoName,
          organization: normalizedPayload.classroom.git_organization,
        },
        options: { tags: ctx.run.tags, concurrencyKey: classroom.slug },
      }));

      if (assignmentPayloads.length) {
        await createGithubRepositoryAssignmentTask.batchTriggerAndWait(assignmentPayloads);

        for (const assignmentPayload of assignmentPayloads) {
          ClassmojiService.assignment.update(assignmentPayload.payload.assignment.id, {
            is_published: true,
          });
        }
      }
    } catch (error: unknown) {
      logger.error('Error creating repository', { error });
      throw error;
    }
  },
});

export const addCollaboratorsToRepoTask = task({
  id: 'gh-add_collaborator_to_repo',
  queue: {
    concurrencyLimit: 6,
  },
  run: async (payload: AddCollaboratorsToRepoTaskPayload) => {
    try {
      const { module, classroom, repoName } = payload;
      const gitOrgLogin = classroom.git_organization.login;

      if (!gitOrgLogin) {
        throw new Error('Missing Git organization login');
      }

      const gitProvider = getGitProvider(classroom.git_organization);

      if (module.type === 'INDIVIDUAL') {
        if (!payload.student?.login) {
          throw new Error(`Missing student login for repo ${repoName}`);
        }

        await gitProvider.addCollaborator(gitOrgLogin, repoName, payload.student.login, 'maintain');
      } else {
        if (!payload.team?.slug) {
          throw new Error(`Missing team slug for repo ${repoName}`);
        }

        await gitProvider.addTeamToRepo(gitOrgLogin, repoName, payload.team.slug, 'maintain');
      }

      const team = await ensureClassroomTeam(gitProvider, gitOrgLogin, classroom, 'ASSISTANT');
      await gitProvider.addTeamToRepo(gitOrgLogin, repoName, team.slug, 'maintain');
    } catch (error: unknown) {
      console.error('Error adding collaborator to repo', error);
      throw error;
    }
  },
});

export const createRepoInDatabaseTask = task({
  id: 'cf-create_repository',
  run: async (payload: CreateRepoInDatabaseTaskPayload) => {
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
    } catch (error: unknown) {
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
  run: async (payload: DeleteRepositoryTaskPayload) => {
    return HelperService.deleteRepository(payload);
  },
});

export const updateRepositoryTask = task({
  id: 'update_repository',
  queue: {
    concurrencyLimit: 6,
  },
  run: async (payload: UpdateRepositoryPayload) => {
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
  run: async (payload: CreateProjectForRepoTaskPayload) => {
    const { classroom, module, repoName, repoId, team } = payload;

    try {
      const gitProvider = getGitProvider(classroom.git_organization);
      const org = classroom.git_organization.login;

      if (!org || !module.project_template_id) {
        throw new Error(`Missing project configuration for ${repoName}`);
      }

      const orgNodeId = await gitProvider.getOrganizationNodeId(org);
      const projectTitle = repoName;
      const project = await gitProvider.copyProjectFromTemplate(
        module.project_template_id,
        orgNodeId,
        projectTitle
      );

      logger.info(`Created project "${projectTitle}" for repo ${repoName}`, {
        projectNumber: project.number,
        projectUrl: project.url,
      });

      await ClassmojiService.repository.update(repoId, {
        project_id: project.id,
        project_number: project.number,
      });

      const repo = await gitProvider.getRepository(org, repoName);
      if (!repo.node_id) {
        throw new Error(`Repository ${repoName} is missing a node_id`);
      }

      await gitProvider.linkRepoToProject(project.id, repo.node_id);

      if (team?.slug) {
        await gitProvider.addTeamToProject(project.id, org, team.slug, 'WRITER');
      }

      const assistantsTeam = await ensureClassroomTeam(gitProvider, org, classroom, 'ASSISTANT');
      await gitProvider.addTeamToProject(project.id, org, assistantsTeam.slug, 'WRITER');

      return project;
    } catch (error: unknown) {
      logger.error(`Error creating project for repo ${repoName}:`, { error });
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
  run: async (payload: CreateProjectsForModuleTaskPayload, { ctx }: RepositoryTaskContext) => {
    const { moduleId, classroomSlug } = payload;

    const module = await ClassmojiService.module.findById(moduleId);
    const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
    const repos: Array<{
      id: string;
      name: string;
      project_id?: string | null;
      team?: TeamRecord | null;
    }> = await ClassmojiService.repository.findByModule(classroomSlug, moduleId);

    if (!module || !classroom) {
      throw new Error(`Unable to load module or classroom for ${classroomSlug}/${moduleId}`);
    }

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
      options: { tags: ctx.run.tags, concurrencyKey: classroomSlug },
    }));

    await createProjectForRepoTask.batchTriggerAndWait(payloads);

    return {
      created: reposWithoutProjects.length,
      total: repos.length,
    };
  },
});
