/**
 * The single client-side shape of a calendar item.
 *
 * Every calendar surface — both grids, both modals, the event card, the link
 * list, the routes — talks about events in terms of `CalendarEventWithLinks`.
 * There used to be three near-identical copies of this interface (one in
 * `utils.ts`, one private to `EditEventModal`, one in the admin route), which
 * is why the routes had to cast an event through `Record<string, unknown>`
 * before they could hand it to a modal.
 *
 * Deliberately NOT imported from `@classmoji/services`: these types are used by
 * client components, and pulling a server type in would drag the service graph
 * into the browser bundle. The service exports `ClassroomCalendarItem` instead,
 * and a type-level conformance test (`__tests__/serviceConformance.test.ts`)
 * checks that the two still agree where they are meant to.
 */

export interface CalendarEventCreator {
  name?: string | null;
  login?: string | null;
}

export interface CalendarLinkedPage {
  page: {
    id: string;
    title: string;
    /** Staff may be shown draft pages, tagged as such; students never receive them. */
    is_draft?: boolean;
  };
}

export interface CalendarLinkedSlide {
  slide: {
    id: string;
    title: string;
    is_draft?: boolean;
  };
}

export interface CalendarLinkedAssignment {
  assignment: {
    id: string;
    title: string;
  };
  repository?: {
    slug?: string | null;
  } | null;
}

/**
 * Raw link rows, echoed back only when the loader asked for them
 * (`includeRawLinks`), so the edit modal can rebuild its pickers for one
 * occurrence. `occurrence_date` arrives as a real `Date` over single fetch and
 * as a string from anything that has round-tripped through JSON.
 */
export interface CalendarRawPageLink {
  page_id: string;
  occurrence_date?: string | Date | null;
}

export interface CalendarRawSlideLink {
  slide_id: string;
  occurrence_date?: string | Date | null;
}

export interface CalendarRawAssignmentLink {
  assignment_id: string;
  occurrence_date?: string | Date | null;
}

export interface CalendarEventWithLinks {
  id?: string;
  title?: string;
  /**
   * React Router's single fetch delivers real `Date`s, while an optimistic
   * client-side update writes ISO strings back in. Both are live at runtime, so
   * both are in the type; everything downstream goes through `new Date(…)` or
   * `dayjs(…)`, which take either.
   */
  start_time: string | Date;
  end_time: string | Date;
  event_type: string;
  occurrence_date?: string | Date | null;
  recurrence_rule?: { days?: string[]; until?: string | null } | null;
  is_deadline?: boolean;
  /**
   * A synthesized form-close item. It is a deadline for rendering, filtering and
   * ICS export, but it has no assignment behind it — so it is never draggable,
   * and it links to the form rather than to a GitHub issue.
   */
  is_form_close?: boolean;
  form_url?: string | null;
  form_status?: string | null;
  form_access?: string | null;
  is_unpublished?: boolean;
  meeting_link?: string | null;
  location?: string | null;
  creator?: CalendarEventCreator | null;
  description?: string | null;
  is_recurring?: boolean;
  is_overridden?: boolean;
  pages?: CalendarLinkedPage[] | null;
  slides?: CalendarLinkedSlide[] | null;
  assignments?: CalendarLinkedAssignment[] | null;
  github_issue_url?: string | null;
  _rawPageLinks?: CalendarRawPageLink[];
  _rawSlideLinks?: CalendarRawSlideLink[];
  _rawAssignmentLinks?: CalendarRawAssignmentLink[];
  [key: string]: unknown;
}
