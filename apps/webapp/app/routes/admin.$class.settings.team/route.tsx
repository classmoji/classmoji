import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import TagSection from './TagSection';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
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

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'SETTINGS',
    action: 'update_team_settings',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  return namedAction(request, {
    async createTag() {
      // Trim and reject empty, matching the repository form's inline tag creation:
      // otherwise the two paths can mint 'Section A' and 'Section A ' as separate,
      // visually identical tags. Upsert so the trimmed name can't collide either.
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!name) return { error: 'Please enter a tag name.' };

      return ClassmojiService.organizationTag.upsert(classroom.id, name);
    },

    async deleteTag() {
      return ClassmojiService.organizationTag.delete(data.tagId);
    },
  });
};

export default SettingsTeams;
