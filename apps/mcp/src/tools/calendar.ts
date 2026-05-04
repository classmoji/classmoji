import crypto from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { assertCalendarEventInClassroom } from '../context/ownership.ts';
import { isStaffInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

const CALENDAR_SECRET = process.env.CALENDAR_SECRET;

function signSlug(slug: string): string | null {
  if (!CALENDAR_SECRET) return null;
  return crypto.createHmac('sha256', CALENDAR_SECRET).update(slug).digest('hex').slice(0, 16);
}

/**
 * `calendar_ics_url` — return the signed ICS subscription URL for a classroom.
 * User pastes this into Google Calendar / Apple Calendar / Outlook to receive
 * live deadline updates.
 */
export function registerCalendarIcsUrl(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'calendar_ics_url',
    {
      title: 'ICS calendar subscription URL',
      description:
        "Returns the signed ICS subscription URL for a classroom's calendar. " +
        'Paste it into Google Calendar / Apple Calendar / Outlook for live ' +
        'deadline updates.',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      const sig = signSlug(resolved.classroom.slug);
      if (!sig) {
        throw mcpError(
          'CALENDAR_SECRET not configured on the server',
          ErrorCode.InternalError
        );
      }
      const webappUrl = process.env.WEBAPP_URL ?? 'http://localhost:3000';
      const url = `${webappUrl}/api/calendar/${resolved.classroom.slug}/${sig}.ics`;
      return ok({
        url,
        classroom_slug: resolved.classroom.slug,
        instructions:
          'In Google Calendar: Other calendars → + → From URL → paste this URL. ' +
          'In Apple Calendar: File → New Calendar Subscription → paste. ' +
          'Updates flow in automatically as deadlines change.',
      });
    }
  );
}

/**
 * `calendar_write` — manage classroom calendar events (admin-only).
 */
export function registerCalendarWrite(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'calendar_write',
    {
      title: 'Create / update / delete calendar events',
      description:
        'Manage classroom calendar events (admin-only). Methods: event_create, ' +
        'event_update, event_delete.',
      inputSchema: z.object({
        method: z.enum(['event_create', 'event_update', 'event_delete']),
        classroomSlug: classroomSlugSchema(ctx),
        eventId: z.string().uuid().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        starts_at: z.string().datetime().optional(),
        ends_at: z.string().datetime().optional(),
        event_type: z.string().optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isStaffInAny(resolved.roles))
        throw mcpError('Admin role required', ErrorCode.InvalidRequest);

      switch (args.method) {
        case 'event_create': {
          if (!args.title || !args.starts_at || !args.ends_at)
            throw mcpError(
              'event_create requires title, starts_at, ends_at',
              ErrorCode.InvalidParams
            );
          const event = await ClassmojiService.calendar.createEvent(
            resolved.classroom.id,
            ctx.userId,
            {
              title: args.title,
              description: args.description ?? null,
              start_time: new Date(args.starts_at),
              end_time: new Date(args.ends_at),
              event_type: (args.event_type ?? 'OTHER') as never,
            }
          );
          return ok({ created: { id: event.id, title: event.title } });
        }
        case 'event_update': {
          if (!args.eventId)
            throw mcpError('event_update requires eventId', ErrorCode.InvalidParams);
          await assertCalendarEventInClassroom(args.eventId, resolved.classroom.id);
          const updates: Record<string, unknown> = {};
          if (args.title !== undefined) updates.title = args.title;
          if (args.description !== undefined) updates.description = args.description;
          if (args.starts_at !== undefined) updates.start_time = new Date(args.starts_at);
          if (args.ends_at !== undefined) updates.end_time = new Date(args.ends_at);
          if (args.event_type !== undefined) updates.event_type = args.event_type;
          const event = await ClassmojiService.calendar.updateEvent(args.eventId, updates);
          return ok({ updated: { id: event.id, title: event.title } });
        }
        case 'event_delete': {
          if (!args.eventId)
            throw mcpError('event_delete requires eventId', ErrorCode.InvalidParams);
          await assertCalendarEventInClassroom(args.eventId, resolved.classroom.id);
          await ClassmojiService.calendar.deleteEvent(args.eventId);
          return ok({ deleted: { id: args.eventId } });
        }
      }
    }
  );
}
