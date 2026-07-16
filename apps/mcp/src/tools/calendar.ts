/**
 * Calendar tools — calendar_event_create / calendar_event_update /
 * calendar_event_delete.
 *
 * Mirrors apps/webapp/app/routes/admin.$class.calendar (and the assistant
 * variant): teaching-team (['OWNER','TEACHER','ASSISTANT']), with the same
 * in-action restrictions:
 *   - ASSISTANTs may only update/delete events THEY created (created_by);
 *     OWNER/TEACHER may edit any event.
 *   - Deadline moves are NOT calendar events — the web's `update_deadline`
 *     intent (OWNER/TEACHER only) maps to the assignment_update tool's
 *     student_deadline field, with the same tier.
 *
 * Recurring events: edits/deletes MUST go through the scoped service variants
 * (calendar.updateEventWithScope / deleteEventWithScope with
 * this_only | this_and_future | all) — the bare update/delete would corrupt a
 * series (plan §5.1). This tool REQUIRES edit_scope + occurrence_date for
 * recurring events and rejects them for non-recurring ones.
 *
 * S1: the target event is loaded and its classroom_id compared to the
 * authorized classroom before any mutation (same check the web action does).
 */

import { ClassmojiService } from '@classmoji/services';
import type { EventType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import {
  holdsRole,
  loadCalendarEventInClassroom,
  ok,
  requireClassroomCtx,
  TEACHING_TEAM,
  writeAudit,
} from './shared.ts';

const EVENT_TYPES = ['LECTURE', 'LAB', 'OFFICE_HOURS', 'ASSESSMENT'] as const;
const EDIT_SCOPES = ['this_only', 'this_and_future', 'all'] as const;

type EditScope = (typeof EDIT_SCOPES)[number];

interface CalendarEventCreateArgs {
  classroom: string;
  title: string;
  event_type: (typeof EVENT_TYPES)[number];
  start_time: string;
  end_time: string;
  description?: string;
  location?: string;
  meeting_link?: string;
  is_recurring?: boolean;
  recurrence_rule?: Record<string, unknown>;
}

/**
 * OWNER/TEACHER may modify any event; an ASSISTANT only their own. Checked
 * with holdsRole so a multi-role OWNER/TEACHER whose gate happened to resolve
 * as ASSISTANT is not wrongly denied.
 */
async function assertCanModifyEvent(ctx: ToolContext, createdBy: string): Promise<void> {
  if (String(createdBy) === String(ctx.viewer.userId)) return;
  if (await holdsRole(ctx, ['OWNER', 'TEACHER'])) return;
  throw new ToolError(
    'forbidden',
    'Assistants can only modify calendar events they created',
    'INSUFFICIENT_ROLE'
  );
}

/** Resolve the recurring-vs-scope rules shared by update and delete. */
function resolveScope(
  isRecurring: boolean,
  editScope: EditScope | undefined,
  occurrenceDate: string | undefined
): { scope: EditScope; occurrence: Date } | null {
  if (isRecurring) {
    if (!editScope || !occurrenceDate) {
      throw new ToolError(
        'invalid_params',
        "This is a recurring event — provide edit_scope ('this_only' | 'this_and_future' | 'all') " +
          'and occurrence_date (the date of the occurrence you are editing)'
      );
    }
    return { scope: editScope, occurrence: new Date(occurrenceDate) };
  }
  if (editScope || occurrenceDate) {
    throw new ToolError(
      'invalid_params',
      'edit_scope/occurrence_date only apply to recurring events'
    );
  }
  return null;
}

/**
 * An event must end strictly after it starts (mirrors the web calendar form).
 * A zero-length (end == start) or inverted range is rejected. The NaN guards
 * are defensive — Zod already enforces valid ISO-with-offset strings.
 */
function assertEndAfterStart(start: Date, end: Date): void {
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end.getTime() <= start.getTime()
  ) {
    throw new ToolError('invalid_params', 'end_time must be after start_time');
  }
}

export const calendarEventCreateTool: ToolDefinition<CalendarEventCreateArgs> = {
  name: 'calendar_event_create',
  annotations: { destructive: false },
  title: 'Create a calendar event',
  description:
    'Creates a classroom calendar event (lecture, lab, office hours, or assessment). For a ' +
    'recurring event set is_recurring and a recurrence_rule (e.g. {"days": ["monday"], ' +
    '"until": "2026-08-31"}). Assignment deadlines are not events — move them with assignment_update.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    title: z.string().min(1).max(200).describe('Event title'),
    event_type: z.enum(EVENT_TYPES).describe('Kind of event'),
    start_time: z.string().datetime({ offset: true }).describe('Start (ISO 8601)'),
    end_time: z.string().datetime({ offset: true }).describe('End (ISO 8601)'),
    description: z.string().max(2000).optional(),
    location: z.string().max(200).optional(),
    meeting_link: z.string().url().max(500).optional(),
    is_recurring: z.boolean().optional().describe('Whether the event repeats'),
    recurrence_rule: z
      .record(z.unknown())
      .optional()
      .describe('Recurrence rule JSON (required when is_recurring)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    if (args.is_recurring && !args.recurrence_rule) {
      throw new ToolError('invalid_params', 'recurrence_rule is required when is_recurring');
    }
    assertEndAfterStart(new Date(args.start_time), new Date(args.end_time));

    const event = await ClassmojiService.calendar.createEvent(
      classroom.classroomId,
      ctx.viewer.userId,
      {
        title: args.title,
        event_type: args.event_type as EventType,
        start_time: args.start_time,
        end_time: args.end_time,
        description: args.description ?? null,
        location: args.location ?? null,
        meeting_link: args.meeting_link ?? null,
        is_recurring: args.is_recurring ?? false,
        recurrence_rule: (args.recurrence_rule ?? null) as Prisma.InputJsonObject | null,
      }
    );

    await writeAudit(ctx, {
      resource_type: 'CALENDAR',
      resource_id: event.id,
      action: 'CREATE',
      data: { tool: 'calendar_event_create', title: args.title },
    });

    return ok({
      success: true,
      event: {
        id: event.id,
        title: event.title,
        event_type: event.event_type,
        start_time: event.start_time.toISOString(),
        end_time: event.end_time.toISOString(),
        is_recurring: event.is_recurring,
      },
    });
  },
};

interface CalendarEventUpdateArgs {
  classroom: string;
  event_id: string;
  title?: string;
  event_type?: (typeof EVENT_TYPES)[number];
  start_time?: string;
  end_time?: string;
  description?: string;
  location?: string;
  meeting_link?: string;
  edit_scope?: EditScope;
  occurrence_date?: string;
}

export const calendarEventUpdateTool: ToolDefinition<CalendarEventUpdateArgs> = {
  name: 'calendar_event_update',
  annotations: { destructive: false },
  title: 'Update a calendar event',
  description:
    'Updates a calendar event. Assistants can only update events they created. For recurring ' +
    "events you must pass edit_scope ('this_only' | 'this_and_future' | 'all') and " +
    'occurrence_date.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    event_id: z.string().uuid().describe('CalendarEvent id'),
    title: z.string().min(1).max(200).optional(),
    event_type: z.enum(EVENT_TYPES).optional(),
    start_time: z.string().datetime({ offset: true }).optional(),
    end_time: z.string().datetime({ offset: true }).optional(),
    description: z.string().max(2000).optional(),
    location: z.string().max(200).optional(),
    meeting_link: z.string().url().max(500).optional(),
    edit_scope: z.enum(EDIT_SCOPES).optional().describe('Required for recurring events'),
    occurrence_date: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('The occurrence being edited (required for recurring events)'),
  },
  handler: async (args, ctx) => {
    const event = await loadCalendarEventInClassroom(args.event_id, ctx);
    await assertCanModifyEvent(ctx, event.created_by);

    const updates = {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.event_type !== undefined ? { event_type: args.event_type as EventType } : {}),
      ...(args.start_time !== undefined ? { start_time: args.start_time } : {}),
      ...(args.end_time !== undefined ? { end_time: args.end_time } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.location !== undefined ? { location: args.location } : {}),
      ...(args.meeting_link !== undefined ? { meeting_link: args.meeting_link } : {}),
    };
    if (Object.keys(updates).length === 0) {
      throw new ToolError('invalid_params', 'Provide at least one field to update');
    }

    // end_time must be after start_time. When BOTH edges are supplied we can
    // compare them directly (recurrence-independent). When only one edge moves,
    // we can only validate against the stored bound for a NON-recurring event —
    // for a recurring occurrence override (this_only / this_and_future) the
    // stored event.start_time/end_time are the SERIES TEMPLATE's absolute
    // datetimes (dated at the series start), not this occurrence's, so comparing
    // a single new edge against them is meaningless (it would reject valid
    // edits). A start-only recurring override is always valid anyway (the
    // service derives end = start + template duration); a both-edges override is
    // still fully validated by the first branch.
    if (args.start_time !== undefined && args.end_time !== undefined) {
      assertEndAfterStart(new Date(args.start_time), new Date(args.end_time));
    } else if (
      !event.is_recurring &&
      (args.start_time !== undefined || args.end_time !== undefined)
    ) {
      const effectiveStart =
        args.start_time !== undefined ? new Date(args.start_time) : event.start_time;
      const effectiveEnd = args.end_time !== undefined ? new Date(args.end_time) : event.end_time;
      assertEndAfterStart(effectiveStart, effectiveEnd);
    }

    const scoped = resolveScope(event.is_recurring, args.edit_scope, args.occurrence_date);
    if (scoped) {
      // 'all' rewrites the event template, and the service derives
      // recurrence_rule from is_recurring (undefined → falsy → SQL NULL). This
      // tool has no recurrence inputs, so a partial update (e.g. title-only)
      // would silently wipe the rule while is_recurring stayed true, collapsing
      // the whole series to a single occurrence. Carry the loaded event's
      // recurrence fields through unchanged.
      const scopedUpdates =
        scoped.scope === 'all'
          ? {
              ...updates,
              is_recurring: event.is_recurring,
              recurrence_rule: event.recurrence_rule as Prisma.InputJsonObject | null,
            }
          : updates;
      await ClassmojiService.calendar.updateEventWithScope(
        event.id,
        scopedUpdates,
        scoped.scope,
        scoped.occurrence
      );
    } else {
      await ClassmojiService.calendar.updateEvent(event.id, updates);
    }

    await writeAudit(ctx, {
      resource_type: 'CALENDAR',
      resource_id: event.id,
      action: 'UPDATE',
      data: {
        tool: 'calendar_event_update',
        fields: Object.keys(updates),
        ...(scoped ? { edit_scope: scoped.scope } : {}),
      },
    });

    return ok({ success: true, event_id: event.id, updated_fields: Object.keys(updates) });
  },
};

interface CalendarEventDeleteArgs {
  classroom: string;
  event_id: string;
  edit_scope?: EditScope;
  occurrence_date?: string;
}

export const calendarEventDeleteTool: ToolDefinition<CalendarEventDeleteArgs> = {
  name: 'calendar_event_delete',
  annotations: { destructive: true },
  title: 'Delete a calendar event',
  description:
    'Deletes a calendar event. Assistants can only delete events they created. For recurring ' +
    "events pass edit_scope ('this_only' cancels one occurrence, 'this_and_future' truncates " +
    "the series, 'all' deletes it) and occurrence_date.",
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    event_id: z.string().uuid().describe('CalendarEvent id'),
    edit_scope: z.enum(EDIT_SCOPES).optional().describe('Required for recurring events'),
    occurrence_date: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('The occurrence being deleted (required for recurring events)'),
  },
  handler: async (args, ctx) => {
    const event = await loadCalendarEventInClassroom(args.event_id, ctx);
    await assertCanModifyEvent(ctx, event.created_by);

    const scoped = resolveScope(event.is_recurring, args.edit_scope, args.occurrence_date);
    if (scoped) {
      await ClassmojiService.calendar.deleteEventWithScope(
        event.id,
        scoped.scope,
        scoped.occurrence
      );
    } else {
      await ClassmojiService.calendar.deleteEvent(event.id);
    }

    await writeAudit(ctx, {
      resource_type: 'CALENDAR',
      resource_id: event.id,
      action: 'DELETE',
      data: {
        tool: 'calendar_event_delete',
        title: event.title,
        ...(scoped ? { edit_scope: scoped.scope } : {}),
      },
    });

    return ok({ success: true, event_id: event.id, ...(scoped ? { scope: scoped.scope } : {}) });
  },
};
