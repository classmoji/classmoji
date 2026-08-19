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

      // Same untyped-body hazard as removeLink: an `undefined` id is dropped from
      // the `where` rather than rejected, so the scope checks below would match an
      // arbitrary row in the classroom, pass, and then create a link pointing at
      // nothing.
      if (typeof resourceId !== 'string' || !resourceId) {
        throw new Response('Invalid resource id', { status: 400 });
      }
      if (typeof targetId !== 'string' || !targetId) {
        throw new Response('Invalid target id', { status: 400 });
      }

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

      // `linkId` is untyped request-body data, and the compound below only
      // narrows the delete while it is a real string: Prisma drops an
      // `undefined` value from a `where` rather than rejecting it, and the id
      // field also accepts a filter object, so `undefined` or `{ not: '' }`
      // would leave `deleteMany` matching every link in the classroom.
      if (typeof linkId !== 'string' || !linkId) {
        throw new Response('Invalid link id', { status: 400 });
      }

      // deleteMany takes the compound that `delete` cannot. Past the guard `id`
      // is the primary key, so the compound matches at most one row: a count
      // other than 1 means zero rows matched, the link was not this classroom's,
      // and nothing was deleted — so the throw below cannot leave the manifest
      // describing links that are gone.
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
