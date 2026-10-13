/**
 * Calendar tools — calendar_event_create / calendar_event_update /
 * calendar_event_delete / calendar_event_links_set.
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
 * Linked content: calendar_event_links_set attaches pages, decks and
 * assignments to ONE date of an event and picks its starred (`featured`) link —
 * the web modal's link pickers. Links are stored per (event, occurrence date):
 * a recurring event's occurrences each read their own dated bucket, a
 * non-recurring event reads the undated one. So the tool needs the occurrence
 * date for a recurring event, refuses one for a single event, and checks the
 * date really is an occurrence before writing (see the tool's own comments).
 *
 * S1: the target event is loaded and its classroom_id compared to the
 * authorized classroom before any mutation (same check the web action does).
 * Every resource id being linked is checked against the same classroom.
 */

import { ClassmojiService } from '@classmoji/services';
// Pure write policy, imported straight from its own module: the decisions both
// web calendar actions apply too.
import {
  ASSISTANT_EVENT_TYPE_MESSAGE,
  assistantMayChangeEventType,
  assistantMayCreateEventType,
  FEATURED_LINK_KINDS,
  type FeaturedLinkKind,
  type FeaturedLinkRef,
  isMeetingLinkUrl,
  MEETING_LINK_MESSAGE,
} from '@classmoji/services/calendar-policy';
import type { EventType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import {
  holdsRole,
  loadCalendarEventInClassroom,
  loadCourseworkAssignmentInClassroom,
  loadPageInClassroom,
  loadSlideInClassroom,
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
}

/**
 * A meeting link is one http(s) URL. `.url()` keeps `format: uri` in the
 * published schema; the refinement adds what it does not check — the scheme,
 * and whitespace, which the URL parser would otherwise encode into the path.
 */
const meetingLinkSchema = z
  .string()
  .url()
  .max(500)
  .refine(isMeetingLinkUrl, MEETING_LINK_MESSAGE)
  .describe('Meeting URL (http or https)');

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
    meeting_link: meetingLinkSchema.optional(),
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
    await assertEventTypeAllowed(ctx, assistantMayCreateEventType(args.event_type));

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
    meeting_link: meetingLinkSchema.optional(),
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

// ─── calendar_event_links_set ────────────────────────────────────────────────

/** Ids per kind in one call. The web pickers have no cap; this keeps one call's
 * validation work bounded. */
const MAX_LINKS_PER_KIND = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day of an instant: the key link rows are stored and read under. */
const utcDay = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);

type LinkLists = Record<FeaturedLinkKind, string[]>;

interface RawLink {
  occurrence_date: Date | string | null;
  featured: boolean;
}

/**
 * The parts of one getClassroomCalendar row this tool reads. Declared
 * structurally (as content.ts does for the calendar reads) because the service
 * does not export its row type.
 */
interface OccurrenceRow {
  id: string;
  occurrence_date?: Date | string | null;
  pages?: Array<{ page?: { id: string; title: string | null } | null }>;
  slides?: Array<{ slide?: { id: string; title: string | null } | null }>;
  assignments?: Array<{ assignment?: { id: string; title: string | null } | null }>;
  _rawPageLinks?: Array<RawLink & { page_id: string }>;
  _rawSlideLinks?: Array<RawLink & { slide_id: string }>;
  _rawAssignmentLinks?: Array<RawLink & { assignment_id: string }>;
}

/**
 * Whether the calendar expands this event into dated occurrences: flagged
 * recurring AND a rule object carrying a `days` array. The service's own test
 * (expandRecurringEvent / getRecurrenceRule, not exported), restated here. An
 * event flagged recurring whose rule names no days — calendar_event_create
 * accepts `{"until": "…"}` — is shown as ONE undated occurrence reading the
 * undated bucket, exactly like a single event, so it is treated as one. The
 * web decides the same thing from the expanded row (`isExpandedOccurrence`).
 */
function expandsIntoOccurrences(event: {
  is_recurring: boolean;
  recurrence_rule: unknown;
}): boolean {
  const rule = event.recurrence_rule;
  return (
    event.is_recurring &&
    typeof rule === 'object' &&
    rule !== null &&
    !Array.isArray(rule) &&
    Array.isArray((rule as { days?: unknown }).days)
  );
}

/** Order-preserving dedupe; undefined stays undefined (= "keep this kind"). */
const dedupeIds = (ids: string[] | undefined): string[] | undefined =>
  ids === undefined ? undefined : [...new Set(ids)];

const linkIdsSchema = (noun: string) =>
  z
    .array(z.string().uuid())
    .max(MAX_LINKS_PER_KIND)
    .optional()
    .describe(
      `${noun} ids for this date, in display order. Replaces this date's ${noun} links; ` +
        'omit to keep them, [] to clear them.'
    );

interface CalendarEventLinksSetArgs {
  classroom: string;
  event_id: string;
  occurrence_date?: string;
  page_ids?: string[];
  slide_ids?: string[];
  assignment_ids?: string[];
  featured?: { kind: FeaturedLinkKind; id: string } | null;
}

export const calendarEventLinksSetTool: ToolDefinition<CalendarEventLinksSetArgs> = {
  name: 'calendar_event_links_set',
  // Replaces one date's links, which the next call can put back: reversible,
  // and repeating the same call leaves the same state.
  annotations: { destructive: false, idempotent: true },
  title: 'Set the pages, decks and assignments linked to a calendar event',
  description:
    'Sets the pages, slide decks and assignments linked to one date of a calendar event, and ' +
    'which one is starred (`featured`, the link the month view shows under the event). Each of ' +
    "page_ids / slide_ids / assignment_ids you pass replaces that date's links of that kind, in " +
    'the order given; [] clears the kind; an omitted kind keeps its current links. featured: ' +
    'omitted keeps the current star while its resource stays linked; null removes it; ' +
    '{kind, id} stars a resource that must be in the resulting list of its kind. When ' +
    'list_calendar gives the event an occurrence_date (a recurring event), occurrence_date is ' +
    'required, pass it unchanged, and the links belong to that date only; otherwise omit it. ' +
    'Each call reads then replaces the date, so make calls for the same date one at a time. ' +
    'Ids come from list_pages, list_slides and list_modules. Assistants can only change events ' +
    'they created.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    event_id: z.string().uuid().describe('CalendarEvent id'),
    occurrence_date: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        'Required when list_calendar gives the event an occurrence_date (a recurring event): that value, unchanged'
      ),
    page_ids: linkIdsSchema('Page'),
    slide_ids: linkIdsSchema('Slide deck'),
    assignment_ids: linkIdsSchema('Assignment'),
    featured: z
      .object({
        kind: z.enum(FEATURED_LINK_KINDS),
        id: z.string().uuid(),
      })
      .nullable()
      .optional()
      .describe('The starred link: omit to keep, null for none'),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    const event = await loadCalendarEventInClassroom(args.event_id, ctx);
    await assertCanModifyEvent(ctx, event.created_by);

    const requested: Record<FeaturedLinkKind, string[] | undefined> = {
      page: dedupeIds(args.page_ids),
      slide: dedupeIds(args.slide_ids),
      assignment: dedupeIds(args.assignment_ids),
    };
    if (
      requested.page === undefined &&
      requested.slide === undefined &&
      requested.assignment === undefined &&
      args.featured === undefined
    ) {
      throw new ToolError(
        'invalid_params',
        'Provide at least one of page_ids, slide_ids, assignment_ids or featured'
      );
    }

    // Which bucket the links live in. A recurring event's occurrences each read
    // their own dated bucket and never the undated one, so a link write without
    // a date would land where no occurrence looks. A single event (and a
    // "recurring" one whose rule names no days, which shows as a single event)
    // reads the undated bucket, which is where the web writes its links too.
    const recurring = expandsIntoOccurrences(event);
    if (recurring && !args.occurrence_date) {
      throw new ToolError(
        'invalid_params',
        'This is a recurring event — provide occurrence_date (the occurrence whose links you ' +
          'are setting, exactly as list_calendar returns it)'
      );
    }
    if (!recurring && args.occurrence_date) {
      throw new ToolError(
        'invalid_params',
        'This event has no dated occurrences (list_calendar shows its occurrence_date as null) ' +
          '— omit occurrence_date'
      );
    }

    // Find the occurrence through the same expansion the calendar reads use,
    // matching its occurrence_date to the INSTANT. list_calendar's value comes
    // from this same loop, so a copied value always matches (in any offset
    // spelling). Matching by day would not be safe: Tuesday local midnight in
    // Berlin is Monday 22:00Z and would land on Monday's links. Anything else
    // — a wrong weekday, a cancelled or out-of-series date, a hand-built
    // midnight — is refused rather than written to a bucket no occurrence
    // shows, which would look like saving and behave like discarding. The
    // ±2 day window comfortably holds the one row asked about.
    const anchor = recurring ? new Date(args.occurrence_date as string) : event.start_time;
    const rows = (await ClassmojiService.calendar.getClassroomCalendar(
      classroomId,
      new Date(anchor.getTime() - 2 * DAY_MS),
      new Date(anchor.getTime() + 2 * DAY_MS),
      null,
      true, // raw link rows: which bucket each link sits in, and its star
      true,
      { canSeeDrafts: true }
    )) as OccurrenceRow[];
    const row = rows.find(
      r =>
        r.id === event.id &&
        (!recurring ||
          (r.occurrence_date != null && new Date(r.occurrence_date).getTime() === anchor.getTime()))
    );
    if (!row) {
      throw new ToolError(
        'invalid_params',
        'That date is not an occurrence of this event — use the occurrence_date list_calendar ' +
          'returns for that date, unchanged'
      );
    }
    const occurrence = recurring && row.occurrence_date ? new Date(row.occurrence_date) : null;

    // This date's current links, read from the raw rows of the bucket being
    // written. The display arrays are not used for this: for a single event
    // they also show dated links that fall on its day (a series flattened back
    // to one event), which live in another bucket, and carrying them over
    // would copy them into this one. Links to quizzes where the classroom shows
    // none are absent here; the service keeps those itself.
    const inBucket = (d: Date | string | null) =>
      occurrence ? d != null && utcDay(d) === utcDay(occurrence) : d == null;
    const rawPages = (row._rawPageLinks ?? []).filter(l => inBucket(l.occurrence_date));
    const rawSlides = (row._rawSlideLinks ?? []).filter(l => inBucket(l.occurrence_date));
    const rawAssignments = (row._rawAssignmentLinks ?? []).filter(l => inBucket(l.occurrence_date));
    const current: LinkLists = {
      page: rawPages.map(l => l.page_id),
      slide: rawSlides.map(l => l.slide_id),
      assignment: rawAssignments.map(l => l.assignment_id),
    };
    const currentStar: FeaturedLinkRef | null =
      [
        ...rawPages.filter(l => l.featured).map(l => ({ kind: 'page' as const, id: l.page_id })),
        ...rawSlides.filter(l => l.featured).map(l => ({ kind: 'slide' as const, id: l.slide_id })),
        ...rawAssignments
          .filter(l => l.featured)
          .map(l => ({ kind: 'assignment' as const, id: l.assignment_id })),
      ][0] ?? null;

    const final: LinkLists = {
      page: requested.page ?? current.page,
      slide: requested.slide ?? current.slide,
      assignment: requested.assignment ?? current.assignment,
    };

    // The star. The service drops a star naming something not being linked
    // without a word, which suits a stale form field; a caller here named it
    // on purpose, so it is told instead. Omitted means "leave it": kept while
    // the starred resource is still linked, gone with it otherwise.
    let featured: FeaturedLinkRef | null;
    if (args.featured === undefined) {
      featured =
        currentStar && final[currentStar.kind].includes(currentStar.id) ? currentStar : null;
    } else if (args.featured === null) {
      featured = null;
    } else {
      const { kind, id } = args.featured;
      if (!final[kind].includes(id)) {
        throw new ToolError(
          'invalid_params',
          `featured names a ${kind} that is not linked to this date after this call — include ` +
            `it in ${kind}_ids`
        );
      }
      featured = { kind, id };
    }

    // Titles for the response: the current ones from the display rows, new
    // ones from their records.
    const titles: Record<FeaturedLinkKind, Map<string, string | null>> = {
      page: new Map((row.pages ?? []).flatMap(l => (l.page ? [[l.page.id, l.page.title]] : []))),
      slide: new Map(
        (row.slides ?? []).flatMap(l => (l.slide ? [[l.slide.id, l.slide.title]] : []))
      ),
      assignment: new Map(
        (row.assignments ?? []).flatMap(l =>
          l.assignment ? [[l.assignment.id, l.assignment.title]] : []
        )
      ),
    };

    // Every id NEW to this date must be in this classroom. The service would
    // drop a foreign one silently; here it is the uniform not_found, the same
    // for an id that names nothing, before anything is written. The assignment
    // rule is the service's (classroom through the module, so quiz and form
    // assignments count), and a quiz where quizzes are hidden is not_found, as
    // on every other tool. Ids already linked here were checked when linked.
    const added = (kind: FeaturedLinkKind) =>
      (requested[kind] ?? []).filter(id => !current[kind].includes(id));
    await Promise.all([
      ...added('page').map(async id => {
        const page = await loadPageInClassroom(id, ctx);
        titles.page.set(id, page.title);
      }),
      ...added('slide').map(async id => {
        const slide = await loadSlideInClassroom(id, ctx);
        titles.slide.set(id, slide.title);
      }),
      ...added('assignment').map(async id => {
        const assignment = await loadCourseworkAssignmentInClassroom(id, ctx);
        titles.assignment.set(id, assignment.title);
      }),
    ]);

    let saved: Awaited<ReturnType<typeof ClassmojiService.calendar.updateEventLinks>>;
    try {
      saved = await ClassmojiService.calendar.updateEventLinks(
        event.id,
        classroomId,
        { pageIds: final.page, slideIds: final.slide, assignmentIds: final.assignment },
        occurrence,
        featured
      );
    } catch (error) {
      // Deleted (or moved) since it was loaded above.
      if (
        error instanceof Error &&
        error.message === 'Calendar event not found in this classroom'
      ) {
        throw scopedNotFound('Calendar event');
      }
      throw error;
    }

    const occurrenceIso = occurrence ? occurrence.toISOString() : null;
    await writeAudit(ctx, {
      resource_type: 'CALENDAR',
      resource_id: event.id,
      action: 'UPDATE',
      data: {
        tool: 'calendar_event_links_set',
        occurrence_date: occurrenceIso,
        // What the service saved, per kind.
        linked: saved.linked,
        featured: featured ? { kind: featured.kind, id: featured.id } : null,
      },
      // The dedup window keys on the event and the tool, not the date or the
      // lists, and filling in a term's lectures is many calls on one event a
      // second or two apart: deduped, only the first date would be on record.
      dedupe: false,
    });

    const listed = (kind: FeaturedLinkKind) =>
      final[kind].map(id => ({ id, title: titles[kind].get(id) ?? null }));
    return ok({
      success: true,
      event_id: event.id,
      occurrence_date: occurrenceIso,
      pages: listed('page'),
      slides: listed('slide'),
      assignments: listed('assignment'),
      featured,
    });
  },
};
