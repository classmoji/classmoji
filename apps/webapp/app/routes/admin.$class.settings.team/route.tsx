import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import TagSection from './TagSection';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'SETTINGS',
    action: 'view_team_settings',
  });

  const tags = await ClassmojiService.organizationTag.findByClassroomId(classroom.id);
  return { tags };
};

const SettingsTeams = ({ loaderData }: Route.ComponentProps) => {
  const { tags } = loaderData;

  return (
    <div className="w-2/3">
      <TagSection tags={tags} />
    </div>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'SETTINGS',
    action: 'update_team_settings',
  });

  const data = await request.json();

  return namedAction(request, {
    async createTag() {
      return ClassmojiService.organizationTag.create(classroom.id, data.name);
    },

    async deleteTag() {
      return ClassmojiService.organizationTag.delete(data.tagId);
    },
  });
};

export default SettingsTeams;
