import { namedAction } from 'remix-utils/named-action';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'RESOURCES',
    attemptedAction: 'manage_links',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  // `resourceId`, `targetId` and `linkId` all arrive in the request body, so each
  // has to be proven to live in the authorized classroom before it is joined or
  // deleted. Page, Slide and Repository carry `classroom_id` directly; Assignment
  // does not, and is reached through its Repository.
  const prisma = getPrisma();

  const assertFound = (what: string, found: { id: string } | null) => {
    if (!found) throw new Response(`${what} not found in classroom`, { status: 404 });
  };

  const assertTargetInClassroom = async (targetType: string, targetId: string) => {
    if (targetType === 'repository') {
      assertFound(
        'Repository',
        await prisma.repository.findFirst({
          where: { id: targetId, classroom_id: classroom.id },
          select: { id: true },
        })
      );
      return;
    }
    assertFound(
      'Assignment',
      await prisma.assignment.findFirst({
        where: { id: targetId, repository: { classroom_id: classroom.id } },
        select: { id: true },
      })
    );
  };

  return namedAction(request, {
    async addLink() {
      const { resourceId, resourceType, targetType, targetId } = await request.json();

      await assertTargetInClassroom(targetType, targetId);

      if (resourceType === 'page') {
        assertFound(
          'Page',
          await prisma.page.findFirst({
            where: { id: resourceId, classroom_id: classroom.id },
            select: { id: true },
          })
        );
        await prisma.pageLink.create({
          data: {
            page_id: resourceId,
            repository_id: targetType === 'repository' ? targetId : null,
            assignment_id: targetType === 'assignment' ? targetId : null,
          },
        });
      } else {
        assertFound(
          'Slide',
          await prisma.slide.findFirst({
            where: { id: resourceId, classroom_id: classroom.id },
            select: { id: true },
          })
        );
        await prisma.slideLink.create({
          data: {
            slide_id: resourceId,
            repository_id: targetType === 'repository' ? targetId : null,
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

      // deleteMany takes the compound that `delete` cannot; a count other than 1
      // means the link was not this classroom's, which fails rather than no-ops.
      const { count } =
        resourceType === 'page'
          ? await prisma.pageLink.deleteMany({
              where: { id: linkId, page: { classroom_id: classroom.id } },
            })
          : await prisma.slideLink.deleteMany({
              where: { id: linkId, slide: { classroom_id: classroom.id } },
            });

      if (count !== 1) {
        throw new Response('Link not found in classroom', { status: 404 });
      }

      // Update manifest after removing link
      await ClassmojiService.contentManifest.saveManifest(classroom.id);

      return { success: true };
    },
  });
};
