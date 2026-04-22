export type CalendarEventKind = 'lecture' | 'asgn' | 'quiz' | 'other';

export interface CalendarEvent {
  /** Stable identifier for the underlying event (may include `deadline-` prefix). */
  id?: string;
  /** ISO date string YYYY-MM-DD (local date the event falls on). */
  date: string;
  kind: CalendarEventKind;
  title: string;
  /** Optional link to the detail route for this event. */
  href?: string;
  /** True when the event is a recurring occurrence — edit modal shows scope options. */
  isRecurring?: boolean;
  /** True when backed by an assignment deadline (read-only). */
  isDeadline?: boolean;
  /** Minutes since local midnight when the event starts (omitted for date-only entries). */
  startMinutes?: number;
  /** Duration in minutes; defaults to 60 when omitted. */
  durationMinutes?: number;
  /** Optional secondary line shown under the title (e.g., room or "Due"). */
  subtitle?: string;
}
