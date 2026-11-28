import { namedAction } from '~/utils/namedAction.server';

import { ClassmojiService } from '@classmoji/services';
import TagSection from './TagSection';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { addClassroomAuditLog } from '~/utils/helpers';
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

  const { userId, classroom, membership } = await requireClassroomAdmin(request, classSlug, {
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
      // Only a tag of this classroom is deleted; any other id deletes nothing.
      const deleted = await ClassmojiService.organizationTag.deleteInClassroom(
        classroom.id,
        data.tagId
      );
      if (!deleted) return { error: 'That tag was not found in this class.' };

      // The tag is gone either way: a failed audit write is reported
      // (`audit_miss`), not as a failed delete.
      await addClassroomAuditLog({
        request,
        classroomId: classroom.id,
        userId,
        role: membership!.role,
        action: 'DELETE',
        resourceType: 'TAGS',
        resourceId: deleted.id,
        metadata: { tool: 'web:settings.team.delete_tag', name: deleted.name },
      });
      return { deleted: deleted.id };
    },
  });
};

export default SettingsTeams;
