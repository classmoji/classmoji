import { namedAction } from 'remix-utils/named-action';
import prisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'RESOURCES',
    attemptedAction: 'manage_links',
  });

  return namedAction(request, {
    async addLink() {
      const { resourceId, resourceType, targetType, targetId } = await request.json();

      if (resourceType === 'page') {
        await prisma.pageLink.create({
          data: {
            page_id: resourceId,
            module_id: targetType === 'module' ? targetId : null,
            assignment_id: targetType === 'assignment' ? targetId : null,
          },
        });
      } else {
        await prisma.slideLink.create({
          data: {
            slide_id: resourceId,
            module_id: targetType === 'module' ? targetId : null,
            assignment_id: targetType === 'assignment' ? targetId : null,
          },
        });
      }

      // Update manifest after adding link
      await ClassmojiService.contentManifest.saveManifest(classroom.id);

      return { success: true };
    },

    async removeLink() {
      const { linkId, resourceType } = await request.json();

      if (resourceType === 'page') {
        await prisma.pageLink.delete({ where: { id: linkId } });
      } else {
        await prisma.slideLink.delete({ where: { id: linkId } });
      }

      // Update manifest after removing link
      await ClassmojiService.contentManifest.saveManifest(classroom.id);

      return { success: true };
    },
  });
};
