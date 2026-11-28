import { namedAction } from '~/utils/namedAction.server';

import { ClassmojiService } from '@classmoji/services';
import TagSection from './TagSection';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { auditActor } from '~/utils/auditActor.server';
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

  const gate = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'SETTINGS',
    action: 'update_team_settings',
  });
  const { classroom, membership } = gate;
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  return namedAction(request, {
    async createTag() {
      // Trim and reject empty, matching the repository form's inline tag creation:
      // otherwise the two paths can mint 'Section A' and 'Section A ' as separate,
      // visually identical tags. Upsert so the trimmed name can't collide either.
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!name) return { error: 'Please enter a tag name.' };

      // A new tag is recorded by the service; an existing one is returned as is.
      const { tag } = await ClassmojiService.organizationTag.findOrCreate(
        classroom.id,
        name,
        await auditActor(request, gate, 'web:settings.team.create_tag')
      );
      return tag;
    },

    async deleteTag() {
      // Only a tag of this classroom is deleted; any other id deletes nothing.
      // The service records the delete (a failed audit write is reported as
      // `audit_miss`, not as a failed delete).
      const { tag: deleted } = await ClassmojiService.organizationTag.deleteInClassroom(
        classroom.id,
        data.tagId,
        await auditActor(request, gate, 'web:settings.team.delete_tag')
      );
      if (!deleted) return { error: 'That tag was not found in this class.' };
      return { deleted: deleted.id };
    },
  });
};

export default SettingsTeams;
