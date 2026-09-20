/**
 * Calendar write policy: the decisions every surface that writes an event has
 * to make, kept apart from the service that does the writing.
 *
 * There are three such surfaces — the admin calendar action, the assistant
 * calendar action and the MCP calendar tools — and nothing but a shared
 * decision keeps them agreeing. This module is deliberately dependency-free
 * (no Prisma, no imports at all) and published as `@classmoji/services/
 * calendar-policy`, so a caller can import the real rule instead of mocking
 * the service graph and asserting against a copy of it.
 */

/**
 * An event was asked to end at or before it starts.
 *
 * Thrown by the create/update entry points so a caller can turn it into a
 * message the user actually sees. A caller that does not catch it gets a 500,
 * which is the safe direction: the write is refused either way.
 */
export class CalendarTimeRangeError extends Error {
  readonly reason = 'end_before_start';

  constructor(message: string = 'End time must be after the start time') {
    super(message);
    this.name = 'CalendarTimeRangeError';
  }
}

/**
 * Recognise that refusal without depending on the class identity.
 *
 * `instanceof` is the normal test, but it only holds while both sides share one
 * copy of this module — a bundler that splits the package, or a mocked import,
 * can hand a caller a structurally identical error that fails it. The `reason`
 * discriminant is carried for exactly that case, and a caller should ask this
 * rather than pick one of the two.
 */
export const isCalendarTimeRangeError = (error: unknown): boolean =>
  error instanceof CalendarTimeRangeError ||
  (typeof error === 'object' &&
    error !== null &&
    (error as { reason?: unknown }).reason === 'end_before_start');

/** The one event type an assistant may put on the calendar. */
export const ASSISTANT_EVENT_TYPE = 'OFFICE_HOURS';

/** What every surface tells an assistant who tried another type. */
export const ASSISTANT_EVENT_TYPE_MESSAGE = 'Assistants can only manage Office Hours events';

/**
 * May a caller who is not an owner or teacher CREATE an event of this type?
 *
 * Only office hours.
 */
export const assistantMayCreateEventType = (requested: string | null | undefined): boolean =>
  requested === ASSISTANT_EVENT_TYPE;

/**
 * May that caller's UPDATE set this event type?
 *
 * The create limit is worth little on its own: an assistant could add office
 * hours and then retype the event as a lecture. An update is refused when it
 * would move the type to anything other than office hours.
 *
 * Two things are deliberately allowed. An update that does not mention the type
 * changes nothing. And re-sending the type an event ALREADY has is not a change
 * either — without that, an assistant would be locked out of editing the time
 * or place of an event somebody else had retyped, a refusal they could neither
 * understand nor fix.
 */
export const assistantMayChangeEventType = (
  requested: string | null | undefined,
  current: string | null | undefined
): boolean =>
  requested === undefined ||
  requested === null ||
  requested === ASSISTANT_EVENT_TYPE ||
  requested === current;

/** The three things a calendar event can link to, and therefore can star. */
export const FEATURED_LINK_KINDS = ['page', 'slide', 'assignment'] as const;

export type FeaturedLinkKind = (typeof FEATURED_LINK_KINDS)[number];

/** Which linked resource the month view shows under this event, on this date. */
export interface FeaturedLinkRef {
  kind: FeaturedLinkKind;
  id: string;
}

/** The ids a write has already proved belong to this classroom. */
export interface ValidatedLinkIds {
  pageIds: string[];
  slideIds: string[];
  assignmentIds: string[];
}

/**
 * Which of the resources being linked — if any — gets the star.
 *
 * The answer is a FILTER, not a check: a star is a display preference, and a
 * star naming something that is not being linked is simply not a star. That
 * happens for ordinary reasons (a stale form field, an id the user unlinked in
 * the same save) and for hostile ones (an id from another classroom, which the
 * caller has already dropped from the validated lists below). Refusing the
 * whole write over it would lose the user's real edit to protect a decoration;
 * dropping the star silently keeps the links and shows nothing under the event,
 * which is the calendar's own default.
 *
 * The id must appear in the list for ITS OWN KIND. Ids are uuids, so a page id
 * will not be found among assignments by accident — but the kind is what the
 * caller asserted, and honouring it elsewhere would star a row the user did not
 * point at.
 */
export const resolveFeaturedLink = (
  featured: FeaturedLinkRef | null | undefined,
  validated: ValidatedLinkIds
): FeaturedLinkRef | null => {
  if (!featured || typeof featured.id !== 'string' || featured.id === '') return null;
  if (!FEATURED_LINK_KINDS.includes(featured.kind)) return null;

  const ids =
    featured.kind === 'page'
      ? validated.pageIds
      : featured.kind === 'slide'
        ? validated.slideIds
        : validated.assignmentIds;

  return ids.includes(featured.id) ? { kind: featured.kind, id: featured.id } : null;
};

/**
 * Read a star out of the two loose fields a form payload carries it in.
 *
 * The web actions receive `featuredKind`/`featuredId` as whatever JSON held —
 * a caller can send anything — so this is where they become a ref or nothing.
 * It answers null generously: no id, no kind, a kind the calendar does not
 * have. `resolveFeaturedLink` then decides whether that ref survives contact
 * with the ids actually being linked.
 */
export const toFeaturedLinkRef = (
  kind: unknown,
  id: unknown
): FeaturedLinkRef | null =>
  typeof id === 'string' &&
  id !== '' &&
  typeof kind === 'string' &&
  (FEATURED_LINK_KINDS as readonly string[]).includes(kind)
    ? { kind: kind as FeaturedLinkKind, id }
    : null;

/**
 * Does THIS row get `featured: true`?
 *
 * Asked once per row being created, against the already-resolved answer above,
 * so exactly one row across the three tables can come out true.
 */
export const isFeaturedLinkRow = (
  resolved: FeaturedLinkRef | null,
  kind: FeaturedLinkKind,
  id: string
): boolean => resolved !== null && resolved.kind === kind && resolved.id === id;
