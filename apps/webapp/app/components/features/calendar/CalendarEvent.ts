export type CalendarEventKind = 'lecture' | 'asgn' | 'quiz' | 'other';

export interface CalendarEvent {
  /** ISO date string YYYY-MM-DD (local date the event falls on). */
  date: string;
  kind: CalendarEventKind;
  title: string;
  /** Optional link to the detail route for this event. */
  href?: string;
}
