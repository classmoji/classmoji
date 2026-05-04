import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import {
  assertAssignmentInClassroom,
  assertModuleInClassroom,
} from '../context/ownership.ts';
import { isStaffInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';

export function registerAssignmentsUpcoming(server: McpServer, ctx: AuthContext): void {
  const validSlugs = ctx.classroomSlugs;
  const slugSchema =
    validSlugs.length > 0
      ? z.enum(validSlugs as [string, ...string[]]).optional()
      : z.string().optional();

  server.registerTool(
    'assignments_upcoming',
    {
      title: 'Upcoming assignment deadlines',
      description:
        'List published assignments with future deadlines. Aggregates across ' +
        'all classrooms the user is a member of unless `classroomSlug` is given.',
      inputSchema: z.object({
        classroomSlug: slugSchema,
        limit: z.number().int().min(1).max(100).optional(),
      }).shape,
    },
    async ({ classroomSlug, limit = 25 }) => {
      const slugToScope = classroomSlug ?? ctx.activeSlug ?? null;
      const prisma = getPrisma();

      const classrooms: { id: string; slug: string; name: string }[] = [];
      if (slugToScope) {
        const resolved = await resolveClassroom(ctx, slugToScope);
        classrooms.push({
          id: resolved.classroom.id,
          slug: resolved.classroom.slug,
          name: resolved.classroom.name,
        });
      } else {
        const memberships = await prisma.classroomMembership.findMany({
          where: { user_id: ctx.userId, has_accepted_invite: true },
          include: { classroom: { select: { id: true, slug: true, name: true } } },
        });
        const seen = new Set<string>();
        for (const m of memberships) {
          if (!seen.has(m.classroom.id)) {
            classrooms.push(m.classroom);
            seen.add(m.classroom.id);
          }
        }
      }

      const all: Array<Record<string, unknown>> = [];
      for (const c of classrooms) {
        const upcoming = await ClassmojiService.assignment.findUpcoming(c.id);
        for (const a of upcoming.slice(0, limit)) {
          all.push({
            classroom_slug: c.slug,
            classroom_name: c.name,
            assignment_id: a.id,
            module: (a as { module?: { title?: string } }).module?.title ?? null,
            title: a.title,
            student_deadline: a.student_deadline?.toISOString() ?? '',
          });
        }
      }
      all.sort((a, b) => String(a.student_deadline).localeCompare(String(b.student_deadline)));

      return {
        content: [{ type: 'text', text: JSON.stringify(all, null, 2) }],
        structuredContent: { upcoming: all },
      };
    }
  );
}

export function registerAssignmentsWrite(server: McpServer, ctx: AuthContext): void {
  const validSlugs = ctx.classroomSlugs;
  const slugSchema =
    validSlugs.length > 0
      ? z.enum(validSlugs as [string, ...string[]]).optional()
      : z.string().optional();

  const baseInput = z.object({
    method: z.enum(['create', 'update', 'publish', 'delete']),
    classroomSlug: slugSchema,
    assignmentId: z.string().uuid().optional().describe('Required for update/publish/delete'),
    moduleId: z.string().uuid().optional().describe('Required for create'),
    title: z.string().optional(),
    description: z.string().optional(),
    student_deadline: z.string().datetime().optional(),
    is_published: z.boolean().optional(),
  });

  server.registerTool(
    'assignments_write',
    {
      title: 'Create / update / publish / delete assignments',
      description:
        'Manage assignments (admin-only). Methods: create (needs moduleId+title), ' +
        'update (needs assignmentId + fields to change), publish (needs assignmentId), ' +
        'delete (needs assignmentId).',
      inputSchema: baseInput.shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isStaffInAny(resolved.roles)) {
        throw mcpError('Admin role required for this classroom', ErrorCode.InvalidRequest);
      }

      switch (args.method) {
        case 'create': {
          if (!args.moduleId || !args.title)
            throw mcpError('create requires moduleId and title', ErrorCode.InvalidParams);
          await assertModuleInClassroom(args.moduleId, resolved.classroom.id);
          const result = await ClassmojiService.assignment.create({
            module_id: args.moduleId,
            title: args.title,
            description: args.description ?? '',
            student_deadline: args.student_deadline ? new Date(args.student_deadline) : null,
            is_published: args.is_published ?? false,
          });
          return ok({ created: { id: result.id, title: result.title } });
        }
        case 'update': {
          if (!args.assignmentId)
            throw mcpError('update requires assignmentId', ErrorCode.InvalidParams);
          await assertAssignmentInClassroom(args.assignmentId, resolved.classroom.id);
          const updates: Record<string, unknown> = {};
          if (args.title !== undefined) updates.title = args.title;
          if (args.description !== undefined) updates.description = args.description;
          if (args.student_deadline !== undefined)
            updates.student_deadline = new Date(args.student_deadline);
          if (args.is_published !== undefined) updates.is_published = args.is_published;
          const result = await ClassmojiService.assignment.update(args.assignmentId, updates);
          return ok({ updated: { id: result.id, title: result.title } });
        }
        case 'publish': {
          if (!args.assignmentId)
            throw mcpError('publish requires assignmentId', ErrorCode.InvalidParams);
          await assertAssignmentInClassroom(args.assignmentId, resolved.classroom.id);
          const result = await ClassmojiService.assignment.update(args.assignmentId, {
            is_published: true,
          });
          return ok({ published: { id: result.id, title: result.title } });
        }
        case 'delete': {
          if (!args.assignmentId)
            throw mcpError('delete requires assignmentId', ErrorCode.InvalidParams);
          await assertAssignmentInClassroom(args.assignmentId, resolved.classroom.id);
          await ClassmojiService.assignment.deleteById(args.assignmentId);
          return ok({ deleted: { id: args.assignmentId } });
        }
      }
    }
  );
}

function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}
