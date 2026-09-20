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
 *
 * There is no index signature: every key a calendar surface reads is named
 * here, and the service builds its payload from the same list. An index
 * signature would let a component read a field nobody decided to send — and
 * would keep the conformance test from noticing when one stops arriving.
 */

export interface CalendarEventCreator {
  name?: string | null;
  login?: string | null;
}

export interface CalendarLinkedPage {
  page: {
    id: string;
    title: string;
    /**
     * Staff may be shown draft pages, tagged as such; students never receive
     * them. REQUIRED on purpose: this field gates what a viewer is allowed to
     * see, and an optional one fails open — a producer that forgets it reads as
     * `undefined`, which is falsy, which means "published".
     *
     * Both legs of the calendar select it: the CalendarEvent link path and the
     * assignment-deadline path (whose linked pages once arrived without it).
     */
    is_draft: boolean;
  };
}

export interface CalendarLinkedSlide {
  slide: {
    id: string;
    title: string;
    /** Required for the same reason as the page's — see above. */
    is_draft: boolean;
  };
}

export interface CalendarLinkedAssignment {
  assignment: {
    id: string;
    title: string;
    /**
     * Required for the same reason `is_draft` is on a page: a link to an
     * unpublished assignment is staff-only, and an optional flag would read as
     * "published" wherever a producer forgot it.
     */
    is_published: boolean;
  };
  repository?: {
    slug?: string | null;
    /** An unpublished repository hides its assignments' links the same way. */
    is_published?: boolean;
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
  /**
   * Trusted, not checked. The service stores this as `Prisma.JsonValue` and
   * hands it over unvalidated, so this shape is what the modals WRITE, not a
   * guarantee about what a given row holds. Read defensively.
   */
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
  /** Who created the event — both staff routes gate "may I edit this?" on it. */
  created_by?: string | null;
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
}
