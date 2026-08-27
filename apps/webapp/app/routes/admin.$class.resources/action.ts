import { namedAction } from 'remix-utils/named-action';
import { ClassmojiService, ResourceLinkServiceError } from '@classmoji/services';
import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
} from '~/utils/helpers';
import type { Route } from './+types/route';

/**
 * Link management for the resources kanban.
 *
 * The linking itself lives in ClassmojiService.resourceLink so this route and
 * the MCP resource-link tools share one path. What stays HERE is the part that
 * is genuinely route-shaped: the auth gate, and the untyped-JSON-body guards
 * below. The service is classroom-scoped and re-checks ids itself, but these
 * guards are what tell a browser client it sent nonsense rather than reporting
 * a record that "does not exist".
 *
 * EVERY failure is RETURNED as `{ error }`, never thrown, and never with a 4xx.
 * Two reasons, both load-bearing:
 *
 * 1. This action is only ever reached by a fetcher. A thrown Response does not
 *    land in `fetcher.data` — React Router routes it to the nearest error
 *    boundary, which for this route tree is the root one, so a rejected drag
 *    would replace the whole admin UI with an error page.
 * 2. React Router skips post-action revalidation when the action's status is
 *    4xx or higher. The most likely rejection here is a duplicate drag decided
 *    against STALE loader data — precisely the case that needs the board
 *    refreshed. A 409 would suppress the refresh and leave the stale card in
 *    place, so the board could never recover on its own.
 *
 * The kanban reads `error` off the fetcher and shows a callout, matching how
 * the other admin list routes surface fetcher failures.
 */

/** Map the service's typed failures onto the message the kanban shows. */
const linkErrorMessage = (
  error: unknown,
  { resourceType, targetType }: { resourceType?: unknown; targetType?: unknown }
): string => {
  if (!(error instanceof ResourceLinkServiceError)) throw error;
  switch (error.code) {
    case 'resource_not_found':
      return `${resourceType === 'page' ? 'Page' : 'Slide'} not found in classroom`;
    case 'target_not_found':
      return `${targetType === 'repository' ? 'Repository' : 'Assignment'} not found in classroom`;
    case 'already_linked':
      return 'Already linked';
    case 'link_not_found':
      return 'Link not found in classroom';
    // A code this route has never seen is not something it can phrase for a
    // user; let it reach the error boundary as the unexpected failure it is.
    default:
      throw error;
  }
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'RESOURCES',
    attemptedAction: 'manage_links',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  // Both link mutations record an audit row, matching the MCP resource-link
  // tools (apps/mcp/src/tools/resourceLinks.ts) field for field: resource_type
  // 'RESOURCES', the LINK id as resource_id, and a `tool` discriminator. The
  // web and MCP surfaces write the same rows for the same act, so a link's
  // history reads the same whichever surface performed it.
  const audit = (action: string, linkId: string, metadata: Record<string, unknown>) =>
    addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action,
      resourceType: 'RESOURCES',
      resourceId: linkId,
      metadata,
    });

  return namedAction(request, {
    async addLink() {
      const { resourceId, resourceType, targetType, targetId } = await request.json();

      // Same untyped-body hazard as removeLink: Prisma DROPS an `undefined` id
      // from a `where` rather than rejecting it, so an unusable id would widen
      // the service's scope checks instead of narrowing them.
      if (typeof resourceId !== 'string' || !resourceId) {
        return { error: 'Invalid resource id' };
      }
      if (typeof targetId !== 'string' || !targetId) {
        return { error: 'Invalid target id' };
      }

      let link;
      try {
        link = await ClassmojiService.resourceLink.addLink({
          classroomId: classroom.id,
          resourceType: resourceType === 'page' ? 'page' : 'slide',
          resourceId,
          targetType: targetType === 'repository' ? 'repository' : 'assignment',
          targetId,
        });
      } catch (error) {
        return { error: linkErrorMessage(error, { resourceType, targetType }) };
      }

      await audit('CREATE', link.id, {
        tool: 'web:resources.add_link',
        link_id: link.id,
        resource_type: link.resourceType,
        resource_id: link.resourceId,
        target_type: link.targetType,
        target_id: link.targetId,
      });

      // The link is committed; the manifest push that follows it is best effort,
      // so report which of the two actually happened rather than just "ok".
      return { success: true, manifest_synced: link.manifestSynced };
    },

    async removeLink() {
      const { linkId, resourceType } = await request.json();

      // `linkId` is untyped request-body data, and the service's compound
      // `where` only narrows the delete while it is a real string: an
      // `undefined` value or a `{ not: '' }` filter object would otherwise
      // leave `deleteMany` matching every link in the classroom.
      if (typeof linkId !== 'string' || !linkId) {
        return { error: 'Invalid link id' };
      }

      let removed;
      try {
        removed = await ClassmojiService.resourceLink.removeLink({
          classroomId: classroom.id,
          resourceType: resourceType === 'page' ? 'page' : 'slide',
          linkId,
        });
      } catch (error) {
        return { error: linkErrorMessage(error, { resourceType }) };
      }

      await audit('DELETE', linkId, {
        tool: 'web:resources.remove_link',
        link_id: linkId,
        resource_type: resourceType === 'page' ? 'page' : 'slide',
      });

      return { success: true, manifest_synced: removed.manifestSynced };
    },
  });
};
