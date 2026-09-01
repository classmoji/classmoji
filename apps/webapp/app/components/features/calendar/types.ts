export interface CalendarEventCreator {
  name?: string | null;
  login?: string | null;
}

export interface CalendarLinkedPage {
  page: {
    id: string;
    title: string;
  };
}

export interface CalendarLinkedSlide {
  slide: {
    id: string;
    title: string;
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

export interface CalendarEventWithLinks {
  id?: string;
  title?: string;
  start_time: string;
  end_time: string;
  event_type: string;
  occurrence_date?: string | null;
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
  [key: string]: unknown;
}
