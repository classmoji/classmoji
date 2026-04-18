import type { CalendarEvent, CalendarEventKind } from './CalendarEvent';

interface RawCalendarEventLike {
  id?: string;
  title?: string;
  start_time: string | Date;
  event_type?: string;
  occurrence_date?: string | Date | null;
  is_deadline?: boolean;
  is_recurring?: boolean;
  assignments?: Array<{
    assignment?: { id?: string; title?: string; slug?: string | null } | null;
    module?: { slug?: string | null } | null;
  }> | null;
}

interface MapOptions {
  classSlug: string;
  rolePrefix: 'student' | 'admin' | 'assistant';
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function kindFromEvent(raw: RawCalendarEventLike): CalendarEventKind {
  if (raw.is_deadline) {
    const title = (raw.title ?? '').toLowerCase();
    if (title.includes('quiz')) return 'quiz';
    return 'asgn';
  }
  switch (raw.event_type) {
    case 'LECTURE':
    case 'LAB':
      return 'lecture';
    case 'ASSESSMENT':
      return 'quiz';
    case 'OFFICE_HOURS':
      return 'other';
    default:
      return 'other';
  }
}

function hrefForEvent(
  raw: RawCalendarEventLike,
  opts: MapOptions
): string | undefined {
  const base = `/${opts.rolePrefix}/${opts.classSlug}`;

  // Deadline events carry an assignment reference via id `deadline-<assignmentId>`.
  // Link to the module detail (assignment listing lives there in the redesign).
  if (raw.is_deadline) {
    const firstAsgn = raw.assignments?.[0];
    const moduleSlug = firstAsgn?.module?.slug;
    if (moduleSlug) return `${base}/modules/${moduleSlug}`;
    return undefined;
  }

  // Calendar events with linked assignments -> module page.
  const linkedModuleSlug = raw.assignments?.[0]?.module?.slug;
  if (linkedModuleSlug) return `${base}/modules/${linkedModuleSlug}`;

  return undefined;
}

export function mapClassroomCalendarToEvents(
  rawEvents: RawCalendarEventLike[],
  opts: MapOptions
): CalendarEvent[] {
  const result: CalendarEvent[] = [];
  for (const raw of rawEvents) {
    // Prefer occurrence_date for recurring events, otherwise start_time
    const sourceDate = raw.occurrence_date ?? raw.start_time;
    if (!sourceDate) continue;
    const d = sourceDate instanceof Date ? sourceDate : new Date(sourceDate);
    if (Number.isNaN(d.getTime())) continue;

    result.push({
      id: raw.id,
      date: formatLocalDate(d),
      kind: kindFromEvent(raw),
      title: raw.title ?? 'Untitled',
      href: hrefForEvent(raw, opts),
      isRecurring: Boolean(raw.is_recurring),
      isDeadline: Boolean(raw.is_deadline),
    });
  }
  return result;
}
