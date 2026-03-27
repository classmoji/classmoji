import { namedAction } from 'remix-utils/named-action';
import { tasks } from '@trigger.dev/sdk';

import { ClassmojiService, getGitProvider, ensureClassroomTeam } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import { ActionTypes } from '~/constants';
import { waitForRunCompletion } from '~/utils/helpers';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

interface AssistantPayload {
  id: string | number;
  login: string;
  name: string;
  email?: string | null;
  provider_email?: string | null;
}

interface AssistantClassroom {
  id: string;
  slug: string;
  git_organization: {
    login: string;
    provider: string;
    github_installation_id?: string | null;
    access_token?: string | null;
    base_url?: string | null;
  };
}

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'ASSISTANTS',
    action: 'manage_assistants',
  });

  const data = await request.json();

  return namedAction(request, {
    async createAssistant() {
      try {
        const classroom = await ClassmojiService.classroom.findBySlug(classSlug) as AssistantClassroom | null;
        await addAssistantHandler({ assistant: data, classroom: classroom! });

        return {
          success: 'Assistant created',
          action: ActionTypes.SAVE_USER,
        };
      } catch (error: unknown) {
        console.error('createAssistant failed:', error);
        return {
          action: ActionTypes.SAVE_USER,
          error: 'Failed to create assistant. Please try again.',
        };
      }
    },

    async updateAssistant() {
      await updateAssistantHandler(classSlug, data.login, data.isGrader);
      return {
        success: 'Assistant updated',
        action: ActionTypes.SAVE_USER,
      };
    },

    async removeAssistant() {
      try {
        const run = await tasks.trigger('remove_user_from_organization', {
          payload: {
            user: data.user,
            gitOrganization: classroom.git_organization,
            classroom: classroom,
          },
        });

        await waitForRunCompletion(run.id);

        return {
          success: 'Assistant removed',
          action: ActionTypes.REMOVE_USER,
        };
      } catch (error: unknown) {
        console.error('removeAssistant failed:', error);
        return {
          action: ActionTypes.REMOVE_USER,
          error: 'Failed to remove assistant. Please try again.',
        };
      }
    },
  });
};

export const updateAssistantHandler = async (
  classSlug: string,
  assistantLogin: string,
  isGrader: boolean
) => {
  const classroom = await ClassmojiService.classroom.findBySlug(classSlug);
  const assistant = await ClassmojiService.user.findByLogin(assistantLogin);

  return ClassmojiService.classroomMembership.update(classroom!.id, assistant!.id, {
    is_grader: isGrader,
  });
};

export const addAssistantHandler = async ({
  assistant,
  classroom,
}: {
  assistant: AssistantPayload;
  classroom: AssistantClassroom;
}) => {
  console.log('assistant', assistant);

  const gitProvider = getGitProvider(classroom.git_organization);
  const team = await ensureClassroomTeam(
    gitProvider,
    classroom.git_organization.login,
    classroom,
    'ASSISTANT'
  );

  try {
    await gitProvider.inviteToOrganization(classroom.git_organization.login, String(assistant.id), [
      team.id,
    ]);
  } catch (error: unknown) {
    console.error('Error inviting assistant to organization:', error);
  }

  // Upsert user and membership using connectOrCreate
  const user = await getPrisma().user.upsert({
    where: { login: assistant.login },
    create: {
      login: assistant.login,
      name: assistant.name,
      provider: classroom.git_organization.provider as 'GITHUB' | 'GITLAB' | 'BITBUCKET',
      provider_id: String(assistant.id),
      role: 'user',
      email: assistant.email,
      provider_email: assistant.provider_email,
    },
    update: {
      role: 'user',
    },
  });

  await getPrisma().account.upsert({
    where: {
      provider_id_account_id: {
        provider_id: classroom.git_organization.provider.toLowerCase(),
        account_id: String(assistant.id),
      },
    },
    create: {
      provider_id: classroom.git_organization.provider.toLowerCase(),
      account_id: String(assistant.id),
      user_id: String(user.id),
    },
    update: {},
  });

  await getPrisma().classroomMembership.create({
    data: {
      classroom_id: classroom.id,
      user_id: user.id,
      role: 'ASSISTANT',
    },
  });
};
