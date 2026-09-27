/**
 * Resource link tools — resource_link_add / resource_link_remove /
 * resource_links_list.
 *
 * A resource link attaches a page or slide deck to a repository (the assignment
 * container), to one specific assignment inside it, or to a quiz. It is how
 * content becomes VISIBLE to students: the student repo/assignment pages list
 * exactly what is linked here, so adding and removing links is load-bearing,
 * not decorative. A quiz link makes the document the quiz's SOURCE MATERIAL:
 * the quiz asks about it (students do not see a quiz's links as a list), and it
 * rebuilds no manifest.
 *
 * ROUTE-DERIVED TIER: the web surface is admin.$class.resources/action.ts, gated
 * by assertClassroomAccess with allowedRoles ['OWNER','TEACHER'] — so
 * OWNER_TEACHER here, NOT the OWNER_ONLY most admin tools use. ASSISTANT is
 * excluded, exactly as on the web route.
 *
 * Backbone: ClassmojiService.resourceLink.*, extracted in phase 1 so the
 * resources kanban and these tools share that path (same precedent as roster/
 * assistant/teamAdmin) — other writers of the link tables exist elsewhere and
 * are not routed through it. The service owns the scoping: it proves BOTH ends
 * of a link live in the classroom before writing, deletes through a classroom
 * compound `where` that makes a foreign link id a no-op rather than a leak, and
 * drops read rows whose target resolves into another classroom.
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
type TargetType = 'repository' | 'assignment' | 'quiz';

/** The name a not-found reports for each target type. */
const TARGET_NOUN: Record<TargetType, string> = {
  repository: 'Repository',
  assignment: 'Assignment',
  quiz: 'Quiz',
};

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
      return scopedNotFound(targetType ? TARGET_NOUN[targetType] : 'Assignment');
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
  .enum(['repository', 'assignment', 'quiz'])
  .describe(
    "What to link it to: 'repository' (shows on the whole assignment container), " +
      "'assignment' (shows on that one assignment only) or 'quiz' (the quiz's source material)"
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
  title: 'Link a page or slide deck to a repo, assignment or quiz',
  description:
    'Links a page or slide deck to a repository (the assignment container — the content then ' +
    'appears on that repo page), to one specific assignment inside it, or to a quiz. A repo or ' +
    'assignment link makes the content visible to students on that page. A quiz link makes it ' +
    "the quiz's source material: questions are generated from it, in link order (drafts are " +
    'used once published). Owner and teacher only. Use list_pages / list_slides for resource ' +
    'ids, list_repos for repository and assignment ids, list_quizzes for quiz ids, and ' +
    'resource_links_list to see what is already linked. A repo or assignment link also rebuilds ' +
    'the classroom content manifest and commits it to GitHub (best effort, reported as ' +
    'manifest_synced); calls are throttled, so link in small batches. Distinct from ' +
    'module_item_add (curriculum modules) and calendar event links (scheduled sessions).',
  scope: 'write',
  roles: OWNER_TEACHER,
  // Tighter than the default bucket: every call rebuilds the whole classroom
  // manifest and pushes a commit through the process-wide write queue, so cap
  // it at a burst of 5 and roughly 3 per minute sustained.
  rateLimit: { capacity: 5, refillPerSecond: 0.05 },
  inputSchema: {
    classroom: classroomArg,
    resource_type: resourceTypeArg,
    resource_id: z.string().min(1).max(100).describe('Id of the page or slide deck to link'),
    target_type: targetTypeArg,
    target_id: z
      .string()
      .min(1)
      .max(100)
      .describe('Id of the repository, assignment or quiz to link to'),
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
      // The link row is committed either way; this says whether the manifest
      // commit that follows it actually landed.
      manifest_synced: link.manifestSynced,
      message:
        link.targetType === 'quiz'
          ? `Linked ${link.resourceType} ${link.resourceId} to quiz ${link.targetId} as source material.`
          : `Linked ${link.resourceType} ${link.resourceId} to ${link.targetType} ${link.targetId} — students will now see it there.`,
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
  // Deletes a row, and student-facing visibility goes with it — the content
  // disappears from the repo/assignment page. The registry's convention is that
  // deletes are destructive, so this is one, even though the page/slide deck
  // and the repo/assignment survive and the link can be added back. openWorld
  // for the manifest commit, as with add.
  annotations: { destructive: true, openWorld: true },
  title: 'Unlink a page or slide deck',
  description:
    'Removes a link between a page or slide deck and a repository, assignment or quiz. Owner ' +
    'and teacher only. Only the link is deleted — the page/slide deck and the target are left ' +
    'untouched, and the link can be recreated with resource_link_add — but students stop seeing ' +
    'that content on the repo/assignment page, and a quiz stops using it as source material. ' +
    'Get link ids from resource_links_list. Removing a repo or assignment link also rebuilds the ' +
    'classroom content manifest and commits it to the content repository on GitHub: that commit ' +
    'is best effort and its outcome is reported as manifest_synced, and because every call can ' +
    'pay for a whole-classroom rebuild plus a git write, heavy looping is deliberately throttled ' +
    '— unlink in small batches rather than in a tight loop.',
  scope: 'write',
  roles: OWNER_TEACHER,
  // Same bucket as resource_link_add, and for the same reason: a manifest
  // rebuild plus a git commit per call.
  rateLimit: { capacity: 5, refillPerSecond: 0.05 },
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

    let removed;
    try {
      // The service deletes through a classroom compound `where` and treats a
      // count other than 1 as a miss, so another classroom's link id is a no-op
      // reported as the same not-found an unknown id gets.
      removed = await ClassmojiService.resourceLink.removeLink({
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
      // The delete is committed either way; this says whether the manifest
      // commit that follows it actually landed.
      manifest_synced: removed.manifestSynced,
      message: 'Link removed — the page/slide deck itself was not deleted.',
    });
  },
};

/** A classroom's whole link graph can be long; cap what one call returns. */
const LIST_LINKS_LIMIT_DEFAULT = 200;
const LIST_LINKS_LIMIT_MAX = 500;

interface ResourceLinksListArgs {
  classroom: string;
  resource_type?: ResourceType;
  resource_id?: string;
  target_type?: TargetType;
  target_id?: string;
  limit?: number;
}

export const resourceLinksListTool: ToolDefinition<ResourceLinksListArgs> = {
  name: 'resource_links_list',
  title: 'List page and slide deck links',
  description:
    'Lists every page and slide deck link in the classroom — which content is attached to which ' +
    'repository, assignment or quiz (a quiz link is source material; order is its position). ' +
    'Owner and teacher only. Filter by resource_type/resource_id to see where one page or deck ' +
    'appears, or by target_type/target_id to see everything attached to one repo, assignment or ' +
    'quiz. The link ids returned here are what resource_link_remove takes; use list_pages, ' +
    'list_slides, list_repos and list_quizzes for the ids that resource_link_add takes. ' +
    `Returns at most ${LIST_LINKS_LIMIT_DEFAULT} links by default; total_matched and truncated ` +
    'say whether a filter or a larger limit is needed to see the rest.',
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
      .enum(['repository', 'assignment', 'quiz'])
      .optional()
      .describe('Only links pointing at repositories, at assignments, or at quizzes'),
    target_id: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Only links pointing at this one repository, assignment or quiz'),
    limit: z
      .number()
      .int()
      .positive()
      .max(LIST_LINKS_LIMIT_MAX)
      .optional()
      .describe(`Max links to return (default ${LIST_LINKS_LIMIT_DEFAULT})`),
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

    // Paged after the read, as list_submissions does: the service has no limit
    // param, and `truncated` tells the caller when it is seeing a slice.
    const limit = Math.min(args.limit ?? LIST_LINKS_LIMIT_DEFAULT, LIST_LINKS_LIMIT_MAX);
    const page = links.slice(0, limit);

    // Allow-listed field by field — the service summaries are never spread.
    return ok({
      count: page.length,
      total_matched: links.length,
      truncated: links.length > page.length,
      links: page.map(link => ({
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
