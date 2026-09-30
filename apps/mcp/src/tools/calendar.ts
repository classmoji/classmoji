/**
 * Calendar tools — calendar_event_create / calendar_event_update /
 * calendar_event_delete / calendar_event_link_add / calendar_event_link_remove.
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
 * Linked content (pages, slide decks, assignments — what the web event editor
 * attaches) has its own pair of tools rather than inputs on
 * calendar_event_update. The web saves a date's links as one replace-all write
 * (calendar.updateEventLinks), which is right for a form that always sends all
 * three lists and wrong for a caller that names only what it wants to add: the
 * rest would be deleted. The link tools go through calendar.addEventLinks /
 * removeEventLinks, which touch only the ids named. Their gate is the event
 * update gate above, as it is on the web.
 *
 * S1: the target event is loaded and its classroom_id compared to the
 * authorized classroom before any mutation (same check the web action does).
 * Linked resources are checked against the classroom inside the service, and an
 * id from another classroom comes back as the same not_found an unknown id gets.
 */

import { createHash } from 'node:crypto';

import { ClassmojiService } from '@classmoji/services';
// Pure write policy, imported straight from its own module: the decisions both
// web calendar actions apply too.
import {
  ASSISTANT_EVENT_TYPE_MESSAGE,
  assistantMayChangeEventType,
  assistantMayCreateEventType,
  FEATURED_LINK_KINDS,
  isCalendarLinkError,
  type CalendarLinkIds,
  type FeaturedLinkRef,
} from '@classmoji/services/calendar-policy';
import type { EventType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import {
  holdsRole,
  loadCalendarEventInClassroom,
  ok,
  requireClassroomCtx,
  scopedNotFound,
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
  page_ids?: string[];
  slide_ids?: string[];
  assignment_ids?: string[];
  featured?: FeaturedLinkRef;
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

/**
 * The office-hours limit on assistants, applied to a write through this server.
 *
 * The web calendar enforces the same policy in both of its actions; the
 * decision itself lives in @classmoji/services so the three cannot drift apart.
 * Same holdsRole reasoning as above — a multi-role OWNER/TEACHER whose gate
 * resolved as ASSISTANT is not an assistant for this purpose.
 */
async function assertEventTypeAllowed(ctx: ToolContext, allowed: boolean): Promise<void> {
  if (allowed) return;
  if (await holdsRole(ctx, ['OWNER', 'TEACHER'])) return;
  throw new ToolError('forbidden', ASSISTANT_EVENT_TYPE_MESSAGE, 'INSUFFICIENT_ROLE');
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

// ─── Linked content ─────────────────────────────────────────────────────────

/** One call links a session's worth of content, not a catalogue. */
const LINK_IDS_MAX = 20;

/**
 * An id-list argument. A function, not a shared constant, for the reason
 * `submissionIdSchema` gives: a zod instance met twice in one tool is published
 * as a `$ref`, which not every MCP client resolves.
 */
const linkIdsArg = (what: string) =>
  z.array(z.string().min(1).max(100)).max(LINK_IDS_MAX).optional().describe(what);

const featuredArg = (what: string) =>
  z
    .object({
      kind: z.enum(FEATURED_LINK_KINDS).describe('Which list the id is in'),
      id: z.string().min(1).max(100),
    })
    .optional()
    .describe(what);

interface LinkIdArgs {
  page_ids?: string[];
  slide_ids?: string[];
  assignment_ids?: string[];
}

const toLinkIds = (args: LinkIdArgs): CalendarLinkIds => ({
  pageIds: args.page_ids ?? [],
  slideIds: args.slide_ids ?? [],
  assignmentIds: args.assignment_ids ?? [],
});

const countIds = (ids: CalendarLinkIds): number =>
  ids.pageIds.length + ids.slideIds.length + ids.assignmentIds.length;

/**
 * Ids by kind, under the names the calendar reads use for linked content
 * (`pages` / `slides` / `assignments` on a list_calendar row).
 */
const shapeLinkIds = (ids: CalendarLinkIds) => ({
  pages: ids.pageIds,
  slides: ids.slideIds,
  assignments: ids.assignmentIds,
});

/**
 * The occurrence a link write landed on, as the service matched it — not the
 * `occurrence_date` argument echoed back. Any instant on the occurrence's UTC
 * day is accepted, so this is how a caller who guessed the time learns which
 * occurrence it was. Under `start_time` so the registry renders it in the
 * classroom's zone beside the ISO value, as it does for the calendar reads
 * (`occurrence_date` is never rendered: mcp/localTimes.ts). Both are null
 * where they do not apply — no date on a one-off event, no start on a date
 * the series no longer falls on.
 */
const shapeOccurrence = (occurrence: {
  occurrence_date: Date | null;
  start_time: Date | null;
}) => ({
  occurrence_date: occurrence.occurrence_date?.toISOString() ?? null,
  start_time: occurrence.start_time?.toISOString() ?? null,
});

/** The star as a plain JSON object, for the audit row. */
const starForAudit = (featured: FeaturedLinkRef | null | undefined) =>
  featured ? { kind: featured.kind, id: featured.id } : null;

/**
 * A short, stable fingerprint of one link call for the audit row's `value`:
 * the audit service coalesces rows of one tool on one event within five
 * seconds unless their values differ, and linking this week's deck and then
 * next week's — the same event, a moment apart — is two acts. The same call
 * made twice still coalesces, which is what the window is for.
 */
const linkWriteFingerprint = (...parts: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);

/**
 * Map the link service's refusals onto tool errors. Each is something the
 * caller can fix, so each says how.
 *
 * - `event_not_found` / `targets_not_found` → the uniform scopedNotFound. The
 *   ids reported back are the caller's own input, so naming which of them
 *   missed reveals nothing about another classroom.
 * - `quizzes_hidden` → forbidden, in module_item_add's words for the same rule.
 * - the occurrence and star rules → invalid_params.
 *
 * Anything else is returned unchanged for the registry's generic wrapper.
 */
function mapCalendarLinkError(error: unknown): unknown {
  if (!isCalendarLinkError(error)) return error;
  switch (error.reason) {
    case 'event_not_found':
      return scopedNotFound('Calendar event');
    case 'targets_not_found': {
      const missing = error.ids ?? { pageIds: [], slideIds: [], assignmentIds: [] };
      const kinds = [
        ...(missing.pageIds.length > 0 ? ['Page'] : []),
        ...(missing.slideIds.length > 0 ? ['Slide'] : []),
        ...(missing.assignmentIds.length > 0 ? ['Assignment'] : []),
      ];
      const notFound = scopedNotFound(kinds.length === 1 ? kinds[0] : 'Linked resources');
      notFound.data = { not_found: shapeLinkIds(missing) };
      return notFound;
    }
    case 'quizzes_hidden':
      return new ToolError(
        'forbidden',
        'Quizzes are not available in this classroom: they require a Pro subscription with quizzes_enabled on'
      );
    case 'occurrence_required':
      return new ToolError(
        'invalid_params',
        'This is a recurring event — links belong to one occurrence. Pass occurrence_date: the ' +
          'occurrence_date list_calendar / list_calendar_range returned for that occurrence'
      );
    case 'occurrence_not_allowed':
      return new ToolError(
        'invalid_params',
        'occurrence_date only applies to recurring events — omit it for this event'
      );
    case 'not_an_occurrence':
      return new ToolError(
        'invalid_params',
        'This event has no occurrence on that date. Pass occurrence_date exactly as list_calendar / ' +
          'list_calendar_range returned it for the occurrence: it is a UTC instant, so its date can ' +
          'differ from the local date'
      );
    case 'featured_not_linked':
      return new ToolError(
        'invalid_params',
        'featured must name an id this call passes in page_ids, slide_ids or assignment_ids ' +
          '(pass an already linked id again to move the star to it)'
      );
    default:
      return error;
  }
}

/**
 * The error for a create whose event was saved and whose links were not.
 *
 * A bare refusal here reads as "nothing happened", and the natural retry makes
 * a second event. So the caller is told the event exists, handed its id, and
 * pointed at the tool that attaches links to it. That has to hold for a fault
 * as much as for a refusal — an unrecognised error would otherwise reach the
 * caller as the registry's generic "Internal server error", with the event
 * already on the calendar — so a fault is logged here, where it would have
 * been logged there, and reported the same way.
 */
function eventCreatedWithoutLinks(eventId: string, failure: unknown): ToolError {
  const mapped = mapCalendarLinkError(failure);
  const refusal = mapped instanceof ToolError ? mapped : null;
  if (!refusal) {
    console.error(
      '[mcp] calendar_event_create: linking failed after the event was created:',
      failure
    );
  }
  return new ToolError(
    refusal?.kind ?? 'internal',
    `The event WAS created (event_id ${eventId}), but its links were not saved` +
      `${refusal ? `: ${refusal.message}` : ''}. Do not create it again — attach the links to ` +
      'this event with calendar_event_link_add.',
    'EVENT_CREATED_LINKS_NOT_SAVED',
    { ...(refusal?.data ?? {}), event_id: eventId }
  );
}

export const calendarEventCreateTool: ToolDefinition<CalendarEventCreateArgs> = {
  name: 'calendar_event_create',
  annotations: { destructive: false },
  title: 'Create a calendar event',
  description:
    'Creates a classroom calendar event (lecture, lab, office hours, or assessment). For a ' +
    'recurring event set is_recurring and a recurrence_rule (e.g. {"days": ["monday"], ' +
    '"until": "2026-08-31"}). Assignment deadlines are not events — move them with ' +
    'assignment_update. page_ids / slide_ids / assignment_ids attach existing pages, slide decks ' +
    'and assignments to a one-off event, and featured stars one of them for the month view. On a ' +
    'recurring event links belong to a single occurrence, so they are refused here: create the ' +
    'event, then attach them per occurrence with calendar_event_link_add.',
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
    page_ids: linkIdsArg('Pages to link (non-recurring events only)'),
    slide_ids: linkIdsArg('Slide decks to link (non-recurring events only)'),
    assignment_ids: linkIdsArg('Assignments to link (non-recurring events only)'),
    featured: featuredArg('The one linked resource the month view shows under the event'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    if (args.is_recurring && !args.recurrence_rule) {
      throw new ToolError('invalid_params', 'recurrence_rule is required when is_recurring');
    }
    const linkIds = toLinkIds(args);
    const featured = args.featured ?? null;
    const hasLinks = countIds(linkIds) > 0 || featured !== null;
    // A series has no date of its own to hang a link on: written here it would
    // land in the undated bucket, which a recurring event's occurrences never
    // read. Refused before anything is created.
    if (args.is_recurring && hasLinks) {
      throw new ToolError(
        'invalid_params',
        'Links on a recurring event belong to one occurrence — create the event without them, ' +
          'then attach them per occurrence with calendar_event_link_add'
      );
    }
    assertEndAfterStart(new Date(args.start_time), new Date(args.end_time));
    await assertEventTypeAllowed(ctx, assistantMayCreateEventType(args.event_type));

    // The same check addEventLinks makes below, asked BEFORE the event exists:
    // a bad id then refuses the request instead of leaving an event behind
    // without the content it was created for.
    if (hasLinks) {
      try {
        await ClassmojiService.calendar.assertLinkTargetsInClassroom(
          classroom.classroomId,
          linkIds,
          featured
        );
      } catch (error) {
        throw mapCalendarLinkError(error);
      }
    }

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

    // The ids were checked above, so this fails only if something changed in
    // between, or on a fault. The event is committed either way and is audited
    // either way: the failure is raised after the audit row, not instead of it.
    let linked = null;
    let linkFailure: unknown = null;
    if (hasLinks) {
      try {
        // Undated bucket: only a non-recurring event reaches here with links.
        linked = await ClassmojiService.calendar.addEventLinks(
          event.id,
          classroom.classroomId,
          linkIds,
          null,
          featured
        );
      } catch (error) {
        linkFailure = error;
      }
    }

    await writeAudit(ctx, {
      resource_type: 'CALENDAR',
      resource_id: event.id,
      action: 'CREATE',
      data: {
        tool: 'calendar_event_create',
        title: args.title,
        ...(linked
          ? { linked: shapeLinkIds(linked.added), featured: starForAudit(linked.featured) }
          : {}),
      },
    });

    if (linkFailure) throw eventCreatedWithoutLinks(event.id, linkFailure);

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
      links: shapeLinkIds(linked?.links ?? toLinkIds({})),
      featured_resource: linked?.featured ?? null,
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
    await assertEventTypeAllowed(
      ctx,
      assistantMayChangeEventType(args.event_type, event.event_type)
    );

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
    let writtenEventId = event.id;
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
      const result = await ClassmojiService.calendar.updateEventWithScope(
        event.id,
        scopedUpdates,
        scoped.scope,
        scoped.occurrence
      );
      // 'this_and_future' SPLITS the series: the occurrences from this date on
      // move to a NEW event, and that is the row the edit landed on. Reporting
      // the id the request came in with would file the audit against a series
      // that no longer covers the date, and hand the caller an id whose event
      // does not have their change.
      writtenEventId = result?.id ?? writtenEventId;
    } else {
      await ClassmojiService.calendar.updateEvent(event.id, updates);
    }

    await writeAudit(ctx, {
      resource_type: 'CALENDAR',
      resource_id: writtenEventId,
      action: 'UPDATE',
      data: {
        tool: 'calendar_event_update',
        fields: Object.keys(updates),
        ...(scoped ? { edit_scope: scoped.scope } : {}),
        // Which row the request named, when the edit moved to another one.
        ...(writtenEventId === event.id ? {} : { split_from_event_id: event.id }),
      },
    });

    return ok({ success: true, event_id: writtenEventId, updated_fields: Object.keys(updates) });
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

const occurrenceDateArg = () =>
  z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      'Recurring events only: the occurrence_date list_calendar returned for the occurrence'
    );

interface CalendarEventLinkAddArgs extends LinkIdArgs {
  classroom: string;
  event_id: string;
  occurrence_date?: string;
  featured?: FeaturedLinkRef;
}

export const calendarEventLinkAddTool: ToolDefinition<CalendarEventLinkAddArgs> = {
  name: 'calendar_event_link_add',
  // Inserts link rows and may move the star; nothing is removed. Naming an id
  // that is already linked reports it and changes nothing → idempotent.
  annotations: { destructive: false, idempotent: true },
  title: 'Link pages, slide decks or assignments to a calendar event',
  description:
    'Attaches pages, slide decks and assignments to a calendar event, as the web event editor ' +
    'does. Additive: links already on the event are kept, and an id that is already linked is ' +
    'reported in already_linked, not duplicated. Assistants can only change events they created. ' +
    'On a recurring event links belong to ONE occurrence: pass occurrence_date exactly as ' +
    'list_calendar / list_calendar_range returned it for that occurrence (a UTC instant — do not ' +
    'rebuild it from the local date); a date the series does not fall on is refused. Omit it for ' +
    'a non-recurring event. featured stars one of the ids in this call as the single resource ' +
    'the month view shows under the event on that date, taking the star from whatever had it; ' +
    'pass an already linked id to move the star without adding anything, omit it to leave the ' +
    'star alone. Ids: list_pages and list_slides; for assignments, list_repos (those that ' +
    'submit through a repository) or the assignment_id on a deadline row of list_calendar_range ' +
    '(any assignment with a deadline, quiz and form ones included). Returns what was added, the ' +
    'occurrence written (occurrence_date, start_time) and the links and featured_resource now ' +
    'on that date. Students see a linked draft or unpublished item only once it is published. ' +
    'Distinct from resource_link_add (content shown on a repo, assignment or quiz).',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    event_id: z.string().uuid().describe('CalendarEvent id'),
    page_ids: linkIdsArg('Pages to link'),
    slide_ids: linkIdsArg('Slide decks to link'),
    assignment_ids: linkIdsArg('Assignments to link'),
    occurrence_date: occurrenceDateArg(),
    featured: featuredArg('Which of the ids in this call the month view shows under the event'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const linkIds = toLinkIds(args);
    if (countIds(linkIds) === 0) {
      throw new ToolError(
        'invalid_params',
        'Provide at least one id in page_ids, slide_ids or assignment_ids'
      );
    }

    const event = await loadCalendarEventInClassroom(args.event_id, ctx);
    await assertCanModifyEvent(ctx, event.created_by);

    let result;
    try {
      // classroomId is ALWAYS the authorized classroom, never request input —
      // the service checks the event and every resource against it.
      result = await ClassmojiService.calendar.addEventLinks(
        event.id,
        classroom.classroomId,
        linkIds,
        args.occurrence_date ? new Date(args.occurrence_date) : null,
        args.featured ?? null
      );
    } catch (error) {
      throw mapCalendarLinkError(error);
    }

    // Every successful call is recorded, a repeat that added nothing included,
    // as calendar_event_update records every call. Ids, as the other link
    // tools record them: which resources, not only how many.
    const occurrence = shapeOccurrence(result.occurrence);
    const added = shapeLinkIds(result.added);
    const alreadyLinked = shapeLinkIds(result.alreadyLinked);
    const star = starForAudit(args.featured);
    await writeAudit(ctx, {
      resource_type: 'CALENDAR',
      resource_id: event.id,
      action: 'UPDATE',
      data: {
        tool: 'calendar_event_link_add',
        added,
        already_linked: alreadyLinked,
        occurrence_date: occurrence.occurrence_date,
        featured: star,
        value: linkWriteFingerprint(occurrence.occurrence_date, added, alreadyLinked, star),
      },
    });

    return ok({
      success: true,
      event_id: event.id,
      ...occurrence,
      added,
      already_linked: alreadyLinked,
      links: shapeLinkIds(result.links),
      featured_resource: result.featured,
    });
  },
};

interface CalendarEventLinkRemoveArgs extends LinkIdArgs {
  classroom: string;
  event_id: string;
  occurrence_date?: string;
}

export const calendarEventLinkRemoveTool: ToolDefinition<CalendarEventLinkRemoveArgs> = {
  name: 'calendar_event_link_remove',
  // Deletes link rows, and the content leaves the event on the calendar — the
  // registry's convention is that deletes are destructive, as the other unlink
  // tools are, even though the page/deck/assignment survives and the link can
  // be added back. An id that is not linked is reported, not refused → idempotent.
  annotations: { destructive: true, idempotent: true },
  title: 'Unlink pages, slide decks or assignments from a calendar event',
  description:
    'Removes links between a calendar event and pages, slide decks or assignments. Only the ' +
    'links are deleted — the content itself is untouched and can be linked again with ' +
    'calendar_event_link_add. Assistants can only change events they created. On a recurring ' +
    'event pass occurrence_date exactly as list_calendar / list_calendar_range returned it for ' +
    'the occurrence whose links to remove (it may be one that has since been cancelled); omit ' +
    'it for a non-recurring event. An id that is not linked on that date is reported in ' +
    'not_linked rather than refused. Removing the link the month view shows under the event ' +
    'leaves nothing starred; star another with calendar_event_link_add. Returns what was ' +
    'removed, the occurrence it was removed from (occurrence_date, and start_time unless that ' +
    'date no longer has an occurrence) and the links and featured_resource left on that date.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    event_id: z.string().uuid().describe('CalendarEvent id'),
    page_ids: linkIdsArg('Pages to unlink'),
    slide_ids: linkIdsArg('Slide decks to unlink'),
    assignment_ids: linkIdsArg('Assignments to unlink'),
    occurrence_date: occurrenceDateArg(),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const linkIds = toLinkIds(args);
    if (countIds(linkIds) === 0) {
      throw new ToolError(
        'invalid_params',
        'Provide at least one id in page_ids, slide_ids or assignment_ids'
      );
    }

    const event = await loadCalendarEventInClassroom(args.event_id, ctx);
    await assertCanModifyEvent(ctx, event.created_by);

    let result;
    try {
      result = await ClassmojiService.calendar.removeEventLinks(
        event.id,
        classroom.classroomId,
        linkIds,
        args.occurrence_date ? new Date(args.occurrence_date) : null
      );
    } catch (error) {
      throw mapCalendarLinkError(error);
    }

    // Every successful call, and the ids — as in calendar_event_link_add.
    const occurrence = shapeOccurrence(result.occurrence);
    const removed = shapeLinkIds(result.removed);
    const notLinked = shapeLinkIds(result.notLinked);
    await writeAudit(ctx, {
      resource_type: 'CALENDAR',
      resource_id: event.id,
      action: 'UPDATE',
      data: {
        tool: 'calendar_event_link_remove',
        removed,
        not_linked: notLinked,
        occurrence_date: occurrence.occurrence_date,
        value: linkWriteFingerprint(occurrence.occurrence_date, removed, notLinked),
      },
    });

    return ok({
      success: true,
      event_id: event.id,
      ...occurrence,
      removed,
      not_linked: notLinked,
      links: shapeLinkIds(result.links),
      featured_resource: result.featured,
    });
  },
};
