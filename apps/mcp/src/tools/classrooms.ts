import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../auth/context.ts';
import getPrisma from '@classmoji/database';

/**
 * `classrooms_list` — return all classrooms the user is a member of.
 * Cross-classroom (no classroomSlug arg). Visible to any authenticated user.
 */
export function registerClassroomsList(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'classrooms_list',
    {
      title: 'List classrooms',
      description:
        "List all of the user's Classmoji classrooms with their role in each. " +
        'Use this to discover available classrooms before calling other tools.',
      inputSchema: z.object({}).shape,
    },
    async () => {
      const memberships = await getPrisma().classroomMembership.findMany({
        where: { user_id: ctx.userId, has_accepted_invite: true },
        include: {
          classroom: {
            select: {
              id: true,
              slug: true,
              name: true,
              term: true,
              year: true,
              is_active: true,
            },
          },
        },
      });
      const rows = memberships.map(m => ({
        slug: m.classroom.slug,
        name: m.classroom.name,
        term: m.classroom.term,
        year: m.classroom.year,
        is_active: m.classroom.is_active,
        role: m.role,
        is_grader: m.is_grader,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
        structuredContent: { classrooms: rows },
      };
    }
  );
}

/**
 * `set_active_classroom` — set the session-level fallback classroom.
 *
 * Mutates the captured-by-reference AuthContext object — every other tool
 * handler in the same session sees the new value via closure. Resets to null
 * when the session ends; not persisted.
 */
export function registerSetActiveClassroom(server: McpServer, ctx: AuthContext): void {
  const validSlugs = ctx.classroomSlugs;
  const slugSchema =
    validSlugs.length > 0
      ? z.enum(validSlugs as [string, ...string[]])
      : z.string().describe('No classrooms available — user is not a member of any classroom.');

  server.registerTool(
    'set_active_classroom',
    {
      title: 'Set active classroom for this session',
      description:
        'Set the active classroom for this MCP session. Subsequent tool calls ' +
        'that omit `classroomSlug` will use this value. Not persisted across ' +
        'reconnects. If you can\'t see expected tools after switching, reconnect ' +
        'your Claude client to refresh permissions.',
      inputSchema: z.object({
        classroomSlug: slugSchema.describe('The slug of the classroom to set as active'),
      }).shape,
    },
    async ({ classroomSlug }) => {
      ctx.activeSlug = classroomSlug;
      return {
        content: [
          {
            type: 'text',
            text: `Active classroom set to "${classroomSlug}" for this session.`,
          },
        ],
        structuredContent: { activeSlug: classroomSlug },
      };
    }
  );
}
