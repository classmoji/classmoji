/**
 * Resource link tools — resource_link_add / resource_link_remove /
 * resource_links_list.
 *
 * A resource link attaches a page or slide deck to a repository (the assignment
 * container) or to one specific assignment inside it. It is how content becomes
 * VISIBLE to students: the student repo/assignment pages list exactly what is
 * linked here, so adding and removing links is load-bearing, not decorative.
 *
 * ROUTE-DERIVED TIER: the web surface is admin.$class.resources/action.ts, gated
 * by assertClassroomAccess with allowedRoles ['OWNER','TEACHER'] — so
 * OWNER_TEACHER here, NOT the OWNER_ONLY most admin tools use. ASSISTANT is
 * excluded, exactly as on the web route.
 *
 * Backbone: ClassmojiService.resourceLink.*, extracted in phase 1 so the web
 * route and these tools take ONE code path (same precedent as roster/assistant/
 * teamAdmin). The service owns the scoping: it proves BOTH ends of a link live
 * in the classroom before writing, and deletes through a classroom compound
 * `where` that makes a foreign link id a no-op rather than a leak.
 *
 * S1: classroomId is ALWAYS ctx.classroom.classroomId, never request input. An
 * id that names nothing and an id belonging to another classroom come back as
 * the same typed error and map to the same scopedNotFound, so a cross-classroom
 * probe cannot enumerate foreign pages, decks, repos or assignments.
 */

import { ClassmojiService, ResourceLinkServiceError } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { ok, OWNER_TEACHER, requireClassroomCtx, scopedNotFound, writeAudit } from './shared.ts';

/** Audit vocabulary — the same resourceType the web route logs its denials under. */
const AUDIT_RESOURCE_TYPE = 'RESOURCES';

type ResourceType = 'page' | 'slide';
type TargetType = 'repository' | 'assignment';

/**
 * Map the service's caller-fixable failures onto tool errors.
 *
 * - `resource_not_found` / `target_not_found` / `link_not_found` → the uniform
 *   scopedNotFound, named for what the caller was pointing at so the message is
 *   useful without revealing whether the record exists somewhere else.
 * - `already_linked` → invalid_params: the link is already there, so the call
 *   is a no-op the caller should stop making rather than a missing record.
 *
 * Anything else is returned unchanged for the registry's generic wrapper.
 */
function mapResourceLinkError(
  error: unknown,
  resourceType: ResourceType,
  targetType?: TargetType
): unknown {
  if (!(error instanceof ResourceLinkServiceError)) return error;
  switch (error.code) {
    case 'resource_not_found':
      return scopedNotFound(resourceType === 'page' ? 'Page' : 'Slide');
    case 'target_not_found':
      return scopedNotFound(targetType === 'repository' ? 'Repository' : 'Assignment');
    case 'already_linked':
      return new ToolError(
        'invalid_params',
        `This ${resourceType} is already linked to that ${targetType ?? 'target'} — nothing to do`
      );
    case 'link_not_found':
      return scopedNotFound('Link');
    default:
      return error;
  }
}

const classroomArg = z.string().describe("Classroom reference as 'org/slug'");
const resourceTypeArg = z
  .enum(['page', 'slide'])
  .describe("Which kind of content to link: 'page' or 'slide' (a slide deck)");
const targetTypeArg = z
  .enum(['repository', 'assignment'])
  .describe(
    "What to link it to: 'repository' (shows on the whole assignment container) or " +
      "'assignment' (shows on that one assignment only)"
  );

interface ResourceLinkAddArgs {
  classroom: string;
  resource_type: ResourceType;
  resource_id: string;
  target_type: TargetType;
  target_id: string;
}

export const resourceLinkAddTool: ToolDefinition<ResourceLinkAddArgs> = {
  name: 'resource_link_add',
  // Creates one link row — nothing is removed, so not destructive. openWorld
  // because the successful write also commits an updated content manifest to
  // the classroom content repo on GitHub.
  annotations: { destructive: false, openWorld: true },
  title: 'Link a page or slide deck to a repo or assignment',
  description:
    'Links a page or slide deck to a repository (the assignment container — the content then ' +
    'appears on that repo page) or to one specific assignment inside it. This is what makes the ' +
    'content visible to students on that repo/assignment page, so it is how you publish existing ' +
    'content to a place students will find it. Owner and teacher only. Use list_pages / ' +
    'list_slides for resource ids and list_repos for repository and assignment ids, and ' +
    'resource_links_list to see what is already linked. A successful link also commits an updated ' +
    'content manifest to the classroom content repository on GitHub. Distinct from ' +
    'module_item_add, which places content in a curriculum module, and from calendar event links, ' +
    'which attach content to a scheduled session.',
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: classroomArg,
    resource_type: resourceTypeArg,
    resource_id: z.string().min(1).max(100).describe('Id of the page or slide deck to link'),
    target_type: targetTypeArg,
    target_id: z.string().min(1).max(100).describe('Id of the repository or assignment to link to'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    let link;
    try {
      // classroomId is ALWAYS the authorized classroom, never request input —
      // so the service's own scope checks on both ids are already classroom-bound.
      link = await ClassmojiService.resourceLink.addLink({
        classroomId: classroom.classroomId,
        resourceType: args.resource_type,
        resourceId: args.resource_id,
        targetType: args.target_type,
        targetId: args.target_id,
      });
    } catch (error) {
      throw mapResourceLinkError(error, args.resource_type, args.target_type);
    }

    // Audit right after the service call: the row is already committed, so
    // nothing downstream may leave the mutation un-audited (plan §5.1).
    // resource_id is the LINK id — it is also what keeps back-to-back links
    // from collapsing into one audit row inside the dedup window.
    await writeAudit(ctx, {
      resource_type: AUDIT_RESOURCE_TYPE,
      resource_id: link.id,
      action: 'CREATE',
      data: {
        tool: 'resource_link_add',
        link_id: link.id,
        resource_type: link.resourceType,
        resource_id: link.resourceId,
        target_type: link.targetType,
        target_id: link.targetId,
      },
    });

    // Allow-listed: the service row is never handed back as-is.
    return ok({
      success: true,
      link_id: link.id,
      resource_type: link.resourceType,
      resource_id: link.resourceId,
      target_type: link.targetType,
      target_id: link.targetId,
      order: link.order,
      created_at: link.createdAt.toISOString(),
      message: `Linked ${link.resourceType} ${link.resourceId} to ${link.targetType} ${link.targetId} — students will now see it there.`,
    });
  },
};

interface ResourceLinkRemoveArgs {
  classroom: string;
  resource_type: ResourceType;
  link_id: string;
}

export const resourceLinkRemoveTool: ToolDefinition<ResourceLinkRemoveArgs> = {
  name: 'resource_link_remove',
  // Deletes the LINK row only: the page/slide and the repo/assignment both
  // survive untouched and the link can simply be added again, so this is not
  // destructive. Set explicitly — the registry defaults an unset `destructive`
  // on a write to true. openWorld for the manifest commit, as with add.
  annotations: { destructive: false, openWorld: true },
  title: 'Unlink a page or slide deck',
  description:
    'Removes a link between a page or slide deck and a repository or assignment. Owner and ' +
    'teacher only. Only the link is deleted — the page/slide deck and the repo/assignment are ' +
    'left untouched, and the link can be recreated with resource_link_add. Students stop seeing ' +
    'that content on the repo/assignment page. Get link ids from resource_links_list. A ' +
    'successful removal also commits an updated content manifest to the classroom content ' +
    'repository on GitHub.',
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: classroomArg,
    resource_type: resourceTypeArg,
    link_id: z
      .string()
      .min(1)
      .max(100)
      .describe('Id of the link to remove, as returned by resource_links_list'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    try {
      // The service deletes through a classroom compound `where` and treats a
      // count other than 1 as a miss, so another classroom's link id is a no-op
      // reported as the same not-found an unknown id gets.
      await ClassmojiService.resourceLink.removeLink({
        classroomId: classroom.classroomId,
        resourceType: args.resource_type,
        linkId: args.link_id,
      });
    } catch (error) {
      throw mapResourceLinkError(error, args.resource_type);
    }

    await writeAudit(ctx, {
      resource_type: AUDIT_RESOURCE_TYPE,
      resource_id: args.link_id,
      action: 'DELETE',
      data: {
        tool: 'resource_link_remove',
        link_id: args.link_id,
        resource_type: args.resource_type,
      },
    });

    return ok({
      success: true,
      link_id: args.link_id,
      resource_type: args.resource_type,
      message: 'Link removed — the page/slide deck itself was not deleted.',
    });
  },
};

interface ResourceLinksListArgs {
  classroom: string;
  resource_type?: ResourceType;
  resource_id?: string;
  target_type?: TargetType;
  target_id?: string;
}

export const resourceLinksListTool: ToolDefinition<ResourceLinksListArgs> = {
  name: 'resource_links_list',
  title: 'List page and slide deck links',
  description:
    'Lists every page and slide deck link in the classroom — which content is attached to which ' +
    'repository or assignment, and therefore what students see on those pages. Owner and teacher ' +
    'only. Filter by resource_type/resource_id to see where one page or deck appears, or by ' +
    'target_type/target_id to see everything attached to one repo or assignment. The link ids ' +
    'returned here are what resource_link_remove takes; use list_pages, list_slides and ' +
    'list_repos for the page, deck, repository and assignment ids that resource_link_add takes.',
  scope: 'read',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: classroomArg,
    resource_type: z
      .enum(['page', 'slide'])
      .optional()
      .describe('Only links for pages, or only links for slide decks'),
    resource_id: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Only links for this one page or slide deck'),
    target_type: z
      .enum(['repository', 'assignment'])
      .optional()
      .describe('Only links pointing at repositories, or only links pointing at assignments'),
    target_id: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Only links pointing at this one repository or assignment'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    const links = await ClassmojiService.resourceLink.listLinks({
      classroomId: classroom.classroomId,
      resourceType: args.resource_type,
      resourceId: args.resource_id,
      targetType: args.target_type,
      targetId: args.target_id,
    });

    // Allow-listed field by field — the service summaries are never spread.
    return ok({
      count: links.length,
      links: links.map(link => ({
        id: link.id,
        resource_type: link.resourceType,
        resource: {
          id: link.resource.id,
          title: link.resource.title,
          slug: link.resource.slug,
        },
        target_type: link.targetType,
        target: {
          id: link.target.id,
          title: link.target.title,
          slug: link.target.slug,
          // Assignment targets only — names the repo the assignment sits in.
          ...(link.target.repositoryId
            ? {
                repository_id: link.target.repositoryId,
                repository_title: link.target.repositoryTitle ?? null,
              }
            : {}),
        },
        order: link.order,
        created_at: link.createdAt.toISOString(),
      })),
    });
  },
};
