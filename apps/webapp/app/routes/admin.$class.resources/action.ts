import { namedAction } from 'remix-utils/named-action';
import { ClassmojiService, ResourceLinkServiceError } from '@classmoji/services';
import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';
import type { Route } from './+types/route';

/**
 * Link management for the resources kanban.
 *
 * The linking itself lives in ClassmojiService.resourceLink so this route and
 * the MCP resource-link tools take one code path. What stays HERE is the part
 * that is genuinely route-shaped: the auth gate, and the untyped-JSON-body
 * guards below. The service is classroom-scoped and re-checks ids itself, but
 * these 400s are what tell a browser client it sent nonsense rather than
 * reporting a record that "does not exist".
 */

/** Map the service's typed failures back onto the responses this route has always sent. */
const linkErrorResponse = (
  error: unknown,
  { resourceType, targetType }: { resourceType?: unknown; targetType?: unknown }
): Response => {
  if (!(error instanceof ResourceLinkServiceError)) throw error;
  switch (error.code) {
    case 'resource_not_found':
      return new Response(`${resourceType === 'page' ? 'Page' : 'Slide'} not found in classroom`, {
        status: 404,
      });
    case 'target_not_found':
      return new Response(
        `${targetType === 'repository' ? 'Repository' : 'Assignment'} not found in classroom`,
        { status: 404 }
      );
    case 'already_linked':
      return new Response('Already linked', { status: 409 });
    case 'link_not_found':
      return new Response('Link not found in classroom', { status: 404 });
  }
};

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

  return namedAction(request, {
    async addLink() {
      const { resourceId, resourceType, targetType, targetId } = await request.json();

      // Same untyped-body hazard as removeLink: Prisma DROPS an `undefined` id
      // from a `where` rather than rejecting it, so an unusable id would widen
      // the service's scope checks instead of narrowing them.
      if (typeof resourceId !== 'string' || !resourceId) {
        throw new Response('Invalid resource id', { status: 400 });
      }
      if (typeof targetId !== 'string' || !targetId) {
        throw new Response('Invalid target id', { status: 400 });
      }

      try {
        await ClassmojiService.resourceLink.addLink({
          classroomId: classroom.id,
          resourceType: resourceType === 'page' ? 'page' : 'slide',
          resourceId,
          targetType: targetType === 'repository' ? 'repository' : 'assignment',
          targetId,
        });
      } catch (error) {
        throw linkErrorResponse(error, { resourceType, targetType });
      }

      // The service refreshes the content manifest on success (best effort).
      return { success: true };
    },

    async removeLink() {
      const { linkId, resourceType } = await request.json();

      // `linkId` is untyped request-body data, and the service's compound
      // `where` only narrows the delete while it is a real string: an
      // `undefined` value or a `{ not: '' }` filter object would otherwise
      // leave `deleteMany` matching every link in the classroom.
      if (typeof linkId !== 'string' || !linkId) {
        throw new Response('Invalid link id', { status: 400 });
      }

      try {
        await ClassmojiService.resourceLink.removeLink({
          classroomId: classroom.id,
          resourceType: resourceType === 'page' ? 'page' : 'slide',
          linkId,
        });
      } catch (error) {
        throw linkErrorResponse(error, { resourceType });
      }

      return { success: true };
    },
  });
};
