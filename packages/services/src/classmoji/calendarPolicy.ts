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

/** What every surface says when a meeting link cannot be saved. */
export const MEETING_LINK_MESSAGE =
  "Enter the meeting's link, starting with https://. Put other notes in the description.";

/**
 * A meeting link was neither a web link nor text containing one.
 *
 * Thrown by the service's write entry points; carries a `reason` for the same
 * structural check `isCalendarTimeRangeError` makes.
 */
export class CalendarMeetingLinkError extends Error {
  readonly reason = 'invalid_meeting_link';

  constructor(message: string = MEETING_LINK_MESSAGE) {
    super(message);
    this.name = 'CalendarMeetingLinkError';
  }
}

/** Recognise that refusal, by class or by its `reason`. */
export const isCalendarMeetingLinkError = (error: unknown): boolean =>
  error instanceof CalendarMeetingLinkError ||
  (typeof error === 'object' &&
    error !== null &&
    (error as { reason?: unknown }).reason === 'invalid_meeting_link');

/**
 * Characters pasted text can carry invisibly: zero-width spaces and joiners,
 * the word joiner, soft hyphens, byte-order marks and direction marks. They
 * are removed where a link is checked or picked out of text, never from text
 * kept for the description (a zero-width joiner is part of some emoji).
 */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/** Two links run together with a comma or semicolon. */
const JOINED_LINKS = /[,;]https?:\/\//i;

/**
 * Longest meeting-link field the rule reads. Anything longer is refused before
 * any pattern runs (or, sent back unchanged, kept as text for the description).
 */
export const MAX_MEETING_LINK_INPUT = 20_000;

/** Longest value taken as one link. */
export const MAX_MEETING_LINK_LENGTH = 2_048;

/** Wrapping (`<…>`, `**…**`, brackets, quotes) and closing punctuation around a link. */
const LEADING_WRAP = new Set(['<', '(', '[', '*', '"', "'"]);
const TRAILING_WRAP = new Set(['.', ',', ';', ':', '!', '?', ')', '>', ']', '}', '*', '"', "'"]);

/** A field value without invisible characters or surrounding whitespace, for link checks. */
const cleanLinkInput = (raw: string | null | undefined): string =>
  typeof raw === 'string' ? raw.replace(INVISIBLE, '').trim() : '';

/** A field value as text for the description: only surrounding whitespace removed. */
const noteText = (raw: string | null | undefined): string =>
  typeof raw === 'string' ? raw.trim() : '';

/** DNS labels of letters, digits and inner hyphens, dot-separated, with an optional final dot. */
const PLAIN_HOSTNAME = /^[a-z0-9]+(?:-+[a-z0-9]+)*(?:\.[a-z0-9]+(?:-+[a-z0-9]+)*)*\.?$/;
const IPV4_ADDRESS = /^\d+\.\d+\.\d+\.\d+\.?$/;

/**
 * Does this URL name its host the plain way: a DNS name of letters, digits
 * and inner hyphens (no underscores, no IP address), and either no port or one
 * of 2 to 5 digits? Meeting links take this form, and it is the form the
 * calendar feed's URL field is filled from.
 */
export const hasPlainHost = (url: URL): boolean =>
  PLAIN_HOSTNAME.test(url.hostname) &&
  !IPV4_ADDRESS.test(url.hostname) &&
  (url.port === '' || /^\d{2,5}$/.test(url.port));

/**
 * A link without the wrapping and punctuation around it, trimmed in one pass
 * from each end. A closing parenthesis stays when the link itself opens one
 * (`https://en.wikipedia.org/wiki/Office_(film)`).
 */
const unwrapLink = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && LEADING_WRAP.has(value[start])) start++;

  let opens = 0;
  let closes = 0;
  for (let i = start; i < end; i++) {
    if (value[i] === '(') opens++;
    else if (value[i] === ')') closes++;
  }
  while (end > start && TRAILING_WRAP.has(value[end - 1])) {
    if (value[end - 1] === ')') {
      if (opens >= closes) break;
      closes--;
    }
    end--;
  }
  return value.slice(start, end);
};

/**
 * Is this value, on its own, an http(s) link with a plain host (`hasPlainHost`)?
 *
 * Whitespace is refused before parsing: the URL parser percent-encodes spaces
 * inside a path or query, so an invitation that begins with its link would
 * otherwise parse as one long URL. Two links joined by a comma or semicolon
 * would parse as one too.
 */
export const isMeetingLinkUrl = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_MEETING_LINK_LENGTH) return false;
  if (/\s/.test(trimmed) || JOINED_LINKS.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return (url.protocol === 'http:' || url.protocol === 'https:') && hasPlainHost(url);
  } catch {
    return false;
  }
};

/** Webex join paths: personal rooms, join pages and scheduled meetings, with or without a site segment. */
const WEBEX_JOIN_PATH = /^\/(?:[^/]+\/)?(?:meet\/.|join\/.|j\.php$)|^\/wbxmjs\/joinservice\//i;

/**
 * Is this the join link of a known meeting service?
 *
 * Invitations carry other links too — help pages, dial-in lists, calendar
 * files, meeting options — and often before the join link, so these win over
 * whichever link comes first.
 */
export const isKnownMeetingLink = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return /^\/(?:j|my)\/./i.test(path);
  if (host === 'meet.google.com') return path.length > 1;
  if (host === 'teams.microsoft.com') {
    return path.startsWith('/l/meetup-join/') || path.startsWith('/meet/');
  }
  if (host === 'teams.live.com') return path.startsWith('/meet/');
  if (host.endsWith('.webex.com')) return WEBEX_JOIN_PATH.test(path);
  return false;
};

/**
 * A known meeting link written without its scheme, given `https://`; null for
 * anything else. A value with a user name or password before the host (a
 * video-system address such as `123@site.webex.com`) is not a link.
 */
const schemelessMeetingLink = (value: string): string | null => {
  const link = `https://${value}`;
  if (!isMeetingLinkUrl(link) || !isKnownMeetingLink(link)) return null;
  const url = new URL(link);
  return url.username === '' && url.password === '' ? link : null;
};

/** http(s) links in running text. A comma or semicolon right before another link ends this one. */
const HTTP_URL_IN_TEXT = /https?:\/\/(?:(?![,;]https?:\/\/)[^\s<>"'])+/gi;

/**
 * Join links printed without their scheme (`meet.google.com/abc-defg-hij`).
 * Only the known meeting hosts: other text with a dot and a slash is too often
 * not a link. The first group keeps a match from starting right after a
 * letter, digit, `.`, `/`, `@`, `:` or `-`, so not in the middle of a word,
 * host, path or address; it can still start after other characters, such as
 * `=`, `?` or `&` inside a query.
 */
const SCHEMELESS_MEETING_LINK =
  /(^|[^\w./@:-])((?:[a-z0-9-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)\/[^\s<>"']*)/gi;

/**
 * The meeting link inside a block of text, such as a pasted invitation: the
 * first join link of a known meeting service, otherwise the first http(s)
 * link, or null when it holds none.
 */
export const findMeetingLink = (text: string): string | null => {
  const cleaned = text.replace(INVISIBLE, '');
  const found: Array<{ index: number; link: string }> = [];

  for (const match of cleaned.matchAll(HTTP_URL_IN_TEXT)) {
    const link = unwrapLink(match[0]);
    if (isMeetingLinkUrl(link)) found.push({ index: match.index ?? 0, link });
  }
  for (const match of cleaned.matchAll(SCHEMELESS_MEETING_LINK)) {
    const link = schemelessMeetingLink(unwrapLink(match[2]));
    if (link) found.push({ index: (match.index ?? 0) + match[1].length, link });
  }

  found.sort((a, b) => a.index - b.index);
  return (found.find(f => isKnownMeetingLink(f.link)) ?? found[0])?.link ?? null;
};

/**
 * What a save does with the meeting-link field. `stored` is the value the
 * event already has, which is what an edit form was filled in with.
 *
 * - empty: no meeting link;
 * - one link: kept, without wrapping or closing punctuation; a known meeting
 *   link written without `https://` gets it;
 * - text containing a link (a pasted invitation): `findMeetingLink` picks the
 *   meeting link, and `text` is the whole paste, for the description;
 * - text with no link that is the stored value, sent back unchanged: no link,
 *   and `text` for the description (`unchangedNote`). Older events can hold a
 *   note here, and a save must not be refused over a value nobody touched;
 * - anything else, including a value over `MAX_MEETING_LINK_INPUT` that is not
 *   the stored one: refused, with the message the user sees.
 */
export type MeetingLinkCheck =
  | { ok: true; meetingLink: string | null; text: string | null; unchangedNote: boolean }
  | { ok: false; message: string };

export const checkMeetingLink = (
  raw: string | null | undefined,
  stored?: string | null
): MeetingLinkCheck => {
  // Compared without invisible characters; kept with them, as typed.
  const unchangedNote = (): MeetingLinkCheck | null =>
    cleanLinkInput(raw) === cleanLinkInput(stored)
      ? { ok: true, meetingLink: null, text: noteText(raw), unchangedNote: true }
      : null;

  if (typeof raw === 'string' && raw.length > MAX_MEETING_LINK_INPUT) {
    return unchangedNote() ?? { ok: false, message: MEETING_LINK_MESSAGE };
  }

  const cleaned = cleanLinkInput(raw);
  if (cleaned === '') return { ok: true, meetingLink: null, text: null, unchangedNote: false };

  const bare = unwrapLink(cleaned);
  if (isMeetingLinkUrl(bare)) {
    return { ok: true, meetingLink: bare, text: null, unchangedNote: false };
  }
  const withScheme = schemelessMeetingLink(bare);
  if (withScheme) return { ok: true, meetingLink: withScheme, text: null, unchangedNote: false };

  const found = findMeetingLink(cleaned);
  if (found) return { ok: true, meetingLink: found, text: noteText(raw), unchangedNote: false };

  return unchangedNote() ?? { ok: false, message: MEETING_LINK_MESSAGE };
};

/**
 * Paragraphs: line breaks as `\n`, blocks split at lines holding nothing but
 * whitespace (a no-break space included), each trimmed, empty ones dropped,
 * joined back with one blank line. Within the result a blank line only ever
 * separates two paragraphs.
 */
const normalizeParagraphs = (value: string): string => {
  const paragraphs: string[] = [];
  let lines: string[] = [];
  const close = () => {
    const paragraph = lines.join('\n').trim();
    if (paragraph !== '') paragraphs.push(paragraph);
    lines = [];
  };
  for (const line of value.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') close();
    else lines.push(line);
  }
  close();
  return paragraphs.join('\n\n');
};

/**
 * A description with pasted text added: the text alone when the description
 * is empty, unchanged when it already holds the text as whole paragraphs,
 * otherwise appended after a blank line. A note that only appears inside a
 * longer paragraph ("Location TBD" for "TBD") is still added.
 */
export const addToDescription = (description: string | null | undefined, text: string): string => {
  if (!description || description.trim() === '') return text;
  const block = normalizeParagraphs(text);
  if (block === '' || `\n\n${normalizeParagraphs(description)}\n\n`.includes(`\n\n${block}\n\n`)) {
    return description;
  }
  return `${description}\n\n${text}`;
};

/**
 * The meeting link and description a copy of a stored event carries, as in a
 * class-to-class import. The copy sends the stored value back unchanged, so it
 * is never refused: a note with no link moves to the description. The refused
 * branch cannot be reached through that rule; it moves the value to the
 * description too, so a copy never loses it.
 */
export const meetingLinkForCopy = (
  meetingLink: string | null,
  description: string | null
): { meeting_link: string | null; description: string | null } => {
  const check = checkMeetingLink(meetingLink, meetingLink);
  if (!check.ok) {
    const note = noteText(meetingLink);
    return {
      meeting_link: null,
      description: note ? addToDescription(description, note) : description,
    };
  }
  return {
    meeting_link: check.meetingLink,
    description: check.text ? addToDescription(description, check.text) : description,
  };
};

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

/** The edit scope that owns ONE occurrence, and therefore its links. */
export const EDIT_SCOPE_THIS_ONLY = 'this_only';

/**
 * Does an edit at this scope have an occurrence to save links — and the star —
 * against?
 *
 * Only 'this_only' does, and so does a save that names no scope at all: a
 * non-recurring event has a single occurrence, which is the one being edited.
 * 'all' and 'this and future' address the SERIES, and a link saved from one of
 * those lands in the undated bucket that a recurring event's occurrences never
 * read — it would look like saving the links and behave like discarding them.
 *
 * Both web actions and the edit modal ask this. They used to carry three
 * hand-written copies of the same expression, which is exactly the kind of rule
 * that drifts in one place and is noticed in production.
 */
export const scopeCarriesLinks = (editScope?: string | null): boolean =>
  !editScope || editScope === EDIT_SCOPE_THIS_ONLY;

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
export const toFeaturedLinkRef = (kind: unknown, id: unknown): FeaturedLinkRef | null =>
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
