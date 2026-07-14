/**
 * Page tools — page_create / page_update / page_delete.
 *
 * Tier confirmed against apps/webapp/app/routes/admin.$class.pages.$pageId/action.ts
 * and admin.$class.pages.new/route.tsx: every intent is gated
 * ['OWNER','TEACHER'] (ASSISTANT excluded).
 *
 * Backbone (plan §5.2 gap 2, extract-first — Phase 3): page.createPage is the
 * choreography extracted from admin.$class.pages.new + api.pages.batch
 * (content-repo ensure → index.html upload → DB row → manifest refresh); both
 * webapp paths and this tool now share it. page.quickUpdate (metadata-only DB
 * update; fires PAGE_PUBLISHED/PAGE_UNPUBLISHED notifications on an is_draft
 * flip) and page.deletePage (orchestrated: removes the page's folder from the
 * shared per-classroom content repo via ContentService.deleteFolder —
 * tolerating GitHub failure — then deletes the DB row and refreshes the
 * content manifest) were already orchestrated.
 *
 * S1: the web update/delete action trusts the URL pageId without re-verifying
 * the page's classroom; MCP does NOT mirror that hole — the page is loaded and
 * its classroom_id compared to the authorized classroom before mutating.
 * page_create writes only into the authorized classroom by construction
 * (classroomId comes from the resolved ClassroomContext).
 */

import { ClassmojiService } from '@classmoji/services';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  loadPageInClassroom,
  ok,
  OWNER_TEACHER,
  requireClassroomCtx,
  writeAudit,
} from './shared.ts';

/** Prisma unique-violation (P2002) — Page is @@unique([classroom_id, title]). */
function isUniqueTitleViolation(error: unknown): boolean {
  return hasErrorCode(error, 'P2002');
}

/** page.createPage's refuse-before-GitHub-write collision (U3): the new
 * title normalizes to a content path an existing page already occupies. */
function isContentPathConflict(error: unknown): boolean {
  return hasErrorCode(error, 'PAGE_CONTENT_PATH_CONFLICT');
}

function hasErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ('code' in current && (current as { code?: string }).code === code) return true;
    current = current.cause;
  }
  return false;
}

interface PageCreateArgs {
  classroom: string;
  title: string;
  html?: string;
}

export const pageCreateTool: ToolDefinition<PageCreateArgs> = {
  name: 'page_create',
  title: 'Create a page',
  description:
    "Creates a new course page: a folder with an index.html in the classroom's shared content " +
    'repo on GitHub, the database record (created as a draft), and a content-manifest refresh. ' +
    'Mirrors the web "Create Blank" flow; pass html to seed the initial content. Publish it ' +
    'later with page_update (is_draft: false).',
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    title: z.string().min(1).max(200).describe('Page title (unique per classroom)'),
    html: z
      .string()
      .max(500_000)
      .optional()
      .describe('Initial index.html content (defaults to a blank-page template)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    try {
      // Orchestrated create (shared with both webapp create-page paths):
      // ensure content repo → upload index.html → DB row → manifest refresh.
      const page = await ClassmojiService.page.createPage({
        classroomId: classroom.classroomId,
        title: args.title,
        html: args.html,
        createdBy: ctx.viewer.userId,
      });

      await writeAudit(ctx, {
        resource_type: 'PAGES',
        resource_id: page.id,
        action: 'CREATE',
        data: { tool: 'page_create', title: args.title },
      });

      return ok({
        success: true,
        page: {
          id: page.id,
          title: page.title,
          slug: page.slug,
          content_path: page.content_path,
          is_draft: page.is_draft,
          is_public: page.is_public,
        },
      });
    } catch (error) {
      if (isContentPathConflict(error)) {
        throw new ToolError('invalid_params', (error as Error).message);
      }
      if (isUniqueTitleViolation(error)) {
        throw new ToolError('invalid_params', 'A page with this title already exists');
      }
      throw error;
    }
  },
};

interface PageUpdateArgs {
  classroom: string;
  page_id: string;
  title?: string;
  width?: number;
  is_draft?: boolean;
  is_public?: boolean;
  show_in_student_menu?: boolean;
  menu_order?: number;
}

export const pageUpdateTool: ToolDefinition<PageUpdateArgs> = {
  name: 'page_update',
  title: 'Update a page',
  description:
    "Updates a course page's metadata: title, layout width, draft/published state (publishing " +
    'notifies students), public visibility, and student-menu placement. Page CONTENT is edited ' +
    'in the web editor, not here.',
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: z.string().uuid().describe('Page id'),
    title: z.string().min(1).max(200).optional().describe('New title (unique per classroom)'),
    width: z.number().int().min(1).max(4).optional().describe('Layout width (1–4, default 2)'),
    is_draft: z
      .boolean()
      .optional()
      .describe('true = draft (hidden from students), false = published'),
    is_public: z.boolean().optional().describe('Whether the page is publicly viewable'),
    show_in_student_menu: z.boolean().optional().describe('Show in the student nav menu'),
    menu_order: z.number().int().min(0).optional().describe('Position in the student menu'),
  },
  handler: async (args, ctx) => {
    const page = await loadPageInClassroom(args.page_id, ctx);

    const updates: Prisma.PageUncheckedUpdateInput = {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
      ...(args.is_draft !== undefined ? { is_draft: args.is_draft } : {}),
      ...(args.is_public !== undefined ? { is_public: args.is_public } : {}),
      ...(args.show_in_student_menu !== undefined
        ? { show_in_student_menu: args.show_in_student_menu }
        : {}),
      ...(args.menu_order !== undefined ? { menu_order: args.menu_order } : {}),
    };
    const fields = Object.keys(updates);
    if (fields.length === 0) {
      throw new ToolError('invalid_params', 'Provide at least one field to update');
    }

    try {
      const updated = await ClassmojiService.page.quickUpdate(page.id, updates);

      await writeAudit(ctx, {
        resource_type: 'PAGES',
        resource_id: page.id,
        action: 'UPDATE',
        data: { tool: 'page_update', fields },
      });

      return ok({
        success: true,
        page: {
          id: updated.id,
          title: updated.title,
          is_draft: updated.is_draft,
          is_public: updated.is_public,
          show_in_student_menu: updated.show_in_student_menu,
          width: updated.width,
          menu_order: updated.menu_order,
        },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
      ) {
        throw new ToolError('invalid_params', 'A page with this title already exists');
      }
      throw error;
    }
  },
};

interface PageDeleteArgs {
  classroom: string;
  page_id: string;
}

export const pageDeleteTool: ToolDefinition<PageDeleteArgs> = {
  name: 'page_delete',
  title: 'Delete a page',
  description:
    "Permanently deletes a course page: removes its folder from the classroom's content repo " +
    'on GitHub and deletes the database record. This cannot be undone.',
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: z.string().uuid().describe('Page id'),
  },
  handler: async (args, ctx) => {
    const page = await loadPageInClassroom(args.page_id, ctx);

    // Orchestrated delete: GitHub content-repo folder (failure tolerated —
    // logged and skipped inside the service) + DB row + manifest refresh.
    await ClassmojiService.page.deletePage(page.id);

    await writeAudit(ctx, {
      resource_type: 'PAGES',
      resource_id: page.id,
      action: 'DELETE',
      data: { tool: 'page_delete', title: page.title },
    });

    return ok({ success: true, deleted: { id: page.id, title: page.title } });
  },
};
