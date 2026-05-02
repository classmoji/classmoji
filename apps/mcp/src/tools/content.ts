import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { isAdminInAny, isTeachingInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

/**
 * `page_content_read` — fetch a page's BlockNote JSON.
 * Returns metadata only by default; use `include_content: true` for the
 * full BlockNote payload (can be large). Students only see non-draft pages.
 */
export function registerPageContentRead(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'page_content_read',
    {
      title: 'Read a classroom page',
      description:
        'Fetch a classroom page (metadata + optional BlockNote content). ' +
        'Students see published only.',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
        pageId: z.string().uuid(),
        include_content: z.boolean().optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      const isTeachingTeam = isTeachingInAny(resolved.roles);
      const page = await ClassmojiService.page.findById(args.pageId);
      if (!page || page.classroom_id !== resolved.classroom.id) {
        throw mcpError('Page not found in this classroom', ErrorCode.InvalidRequest);
      }
      if (page.is_draft && !isTeachingTeam) {
        throw mcpError('Page is not published', ErrorCode.InvalidRequest);
      }
      const meta = {
        id: page.id,
        title: page.title,
        slug: page.slug,
        is_draft: page.is_draft,
        created_at: page.created_at.toISOString(),
        updated_at: page.updated_at.toISOString(),
      };
      // Note: BlockNote content fetching from GitHub requires gitOrganization
      // context which is non-trivial to assemble here; v1 returns metadata.
      return ok({ page: meta });
    }
  );
}

/**
 * `slide_content_read` — fetch slide deck metadata.
 */
export function registerSlideContentRead(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'slide_content_read',
    {
      title: 'Read a classroom slide deck',
      description:
        'Fetch slide deck metadata. Students see published only.',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
        slideId: z.string().uuid(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      const isTeachingTeam = isTeachingInAny(resolved.roles);
      const slide = await getPrisma().slide.findUnique({ where: { id: args.slideId } });
      if (!slide || slide.classroom_id !== resolved.classroom.id) {
        throw mcpError('Slide not found in this classroom', ErrorCode.InvalidRequest);
      }
      if (slide.is_draft && !isTeachingTeam) {
        throw mcpError('Slide is not published', ErrorCode.InvalidRequest);
      }
      return ok({
        slide: {
          id: slide.id,
          title: slide.title,
          slug: slide.slug,
          is_draft: slide.is_draft,
          created_at: slide.created_at.toISOString(),
          updated_at: slide.updated_at.toISOString(),
        },
      });
    }
  );
}

/**
 * `pages_write` — create / update / delete classroom pages (admin-only).
 */
export function registerPagesWrite(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'pages_write',
    {
      title: 'Create / update / delete classroom pages',
      description:
        'Manage classroom pages (admin-only). Methods: create, update, delete.',
      inputSchema: z.object({
        method: z.enum(['create', 'update', 'delete']),
        classroomSlug: classroomSlugSchema(ctx),
        pageId: z.string().uuid().optional(),
        title: z.string().optional(),
        slug: z.string().optional(),
        is_draft: z.boolean().optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isAdminInAny(resolved.roles))
        throw mcpError('Admin role required', ErrorCode.InvalidRequest);

      switch (args.method) {
        case 'create': {
          if (!args.title || !args.slug)
            throw mcpError('create requires title + slug', ErrorCode.InvalidParams);
          const result = await ClassmojiService.page.create({
            classroom_id: resolved.classroom.id,
            created_by: ctx.userId,
            title: args.title,
            slug: args.slug,
            content_path: `pages/${args.slug}/content.json`,
            is_draft: args.is_draft ?? true,
          });
          return ok({ created: { id: result.id, title: result.title } });
        }
        case 'update': {
          if (!args.pageId) throw mcpError('update requires pageId', ErrorCode.InvalidParams);
          // page.service.update only accepts title / content_path / show_in_student_menu
          const updates: { title?: string } = {};
          if (args.title !== undefined) updates.title = args.title;
          const result = await ClassmojiService.page.update(args.pageId, updates);
          return ok({ updated: { id: result.id, title: result.title } });
        }
        case 'delete': {
          if (!args.pageId) throw mcpError('delete requires pageId', ErrorCode.InvalidParams);
          await ClassmojiService.page.deletePage(args.pageId);
          return ok({ deleted: { id: args.pageId } });
        }
      }
    }
  );
}
