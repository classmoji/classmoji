import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import getPrisma from '@classmoji/database';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { isTeachingInAny } from '../auth/roles.ts';
import { wrapToolHandler } from '../middleware/rateLimiter.ts';

interface SearchHit {
  type: 'page' | 'slide' | 'assignment' | 'quiz' | 'event' | 'module';
  id: string;
  title: string;
  classroom_slug: string;
  snippet?: string;
  is_published?: boolean;
}

/**
 * `search_content` — cross-entity ILIKE search across the user's classrooms.
 *
 * Searches: pages.title, slides.title, assignments.title/description,
 * quizzes.name/subject, calendar_events.title/description, modules.title.
 * Students see published items only; teaching team sees all.
 */
export function registerSearchContent(server: McpServer, ctx: AuthContext): void {
  const validSlugs = ctx.classroomSlugs;
  const slugSchema =
    validSlugs.length > 0
      ? z.enum(validSlugs as [string, ...string[]]).optional()
      : z.string().optional();

  server.registerTool(
    'search_content',
    {
      title: 'Search classroom content',
      description:
        'Substring search across pages, slides, assignments, quizzes, ' +
        'calendar events, and modules. Scoped to the active classroom (or ' +
        'the one passed via classroomSlug). Students see published items only.',
      inputSchema: z.object({
        query: z.string().min(2).describe('Search term (case-insensitive substring match)'),
        classroomSlug: slugSchema,
        limit: z.number().int().min(1).max(50).optional().describe('Max results per type. Default 10.'),
      }).shape,
    },
    wrapToolHandler('search_content', ctx, async ({ query, classroomSlug, limit = 10 }) => {
      const resolved = await resolveClassroom(ctx, classroomSlug);
      const isTeachingTeam = isTeachingInAny(resolved.roles);
      const cid = resolved.classroom.id;
      const q = `%${query}%`;
      const prisma = getPrisma();

      const [pages, slides, assignments, quizzes, events, modules] = await Promise.all([
        prisma.page.findMany({
          where: {
            classroom_id: cid,
            title: { contains: query, mode: 'insensitive' },
            ...(isTeachingTeam ? {} : { is_draft: false }),
          },
          select: { id: true, title: true, is_draft: true },
          take: limit,
        }),
        prisma.slide.findMany({
          where: {
            classroom_id: cid,
            title: { contains: query, mode: 'insensitive' },
            ...(isTeachingTeam ? {} : { is_draft: false }),
          },
          select: { id: true, title: true, is_draft: true },
          take: limit,
        }),
        prisma.assignment.findMany({
          where: {
            module: { classroom_id: cid },
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
            ],
            ...(isTeachingTeam ? {} : { is_published: true }),
          },
          select: { id: true, title: true, description: true, is_published: true },
          take: limit,
        }),
        prisma.quiz.findMany({
          where: {
            classroom_id: cid,
            OR: [
              { name: { contains: query, mode: 'insensitive' } },
              { subject: { contains: query, mode: 'insensitive' } },
            ],
            ...(isTeachingTeam ? {} : { status: 'PUBLISHED' }),
          },
          select: { id: true, name: true, subject: true, status: true },
          take: limit,
        }),
        prisma.calendarEvent.findMany({
          where: {
            classroom_id: cid,
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
            ],
          },
          select: { id: true, title: true, description: true },
          take: limit,
        }),
        prisma.module.findMany({
          where: {
            classroom_id: cid,
            title: { contains: query, mode: 'insensitive' },
            ...(isTeachingTeam ? {} : { is_published: true }),
          },
          select: { id: true, title: true, is_published: true },
          take: limit,
        }),
      ]);

      const slug = resolved.classroom.slug;
      const hits: SearchHit[] = [
        ...pages.map(p => ({
          type: 'page' as const,
          id: p.id,
          title: p.title,
          classroom_slug: slug,
          is_published: !p.is_draft,
        })),
        ...slides.map(s => ({
          type: 'slide' as const,
          id: s.id,
          title: s.title,
          classroom_slug: slug,
          is_published: !s.is_draft,
        })),
        ...assignments.map(a => ({
          type: 'assignment' as const,
          id: a.id,
          title: a.title,
          classroom_slug: slug,
          snippet: a.description?.slice(0, 200) ?? undefined,
          is_published: a.is_published,
        })),
        ...quizzes.map(q => ({
          type: 'quiz' as const,
          id: q.id,
          title: q.name,
          classroom_slug: slug,
          snippet: q.subject ?? undefined,
          is_published: q.status === 'PUBLISHED',
        })),
        ...events.map(e => ({
          type: 'event' as const,
          id: e.id,
          title: e.title,
          classroom_slug: slug,
          snippet: e.description?.slice(0, 200) ?? undefined,
        })),
        ...modules.map(m => ({
          type: 'module' as const,
          id: m.id,
          title: m.title,
          classroom_slug: slug,
          is_published: m.is_published,
        })),
      ];

      return {
        content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }],
        structuredContent: { query, total: hits.length, hits },
      };
    })
  );
}
