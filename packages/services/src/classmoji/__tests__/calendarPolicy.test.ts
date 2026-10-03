/**
 * The calendar write policy, as a table.
 *
 * It is enforced in three places — the admin calendar action, the assistant
 * calendar action and the MCP calendar tools — so it lives in one
 * dependency-free module and is pinned once, here. Each of those three has its
 * own test that it ASKS this; what the answer should be is settled below.
 */

import { describe, it, expect } from 'vitest';
import {
  addToDescription,
  ASSISTANT_EVENT_TYPE,
  ASSISTANT_EVENT_TYPE_MESSAGE,
  assistantMayChangeEventType,
  assistantMayCreateEventType,
  CalendarMeetingLinkError,
  CalendarTimeRangeError,
  checkMeetingLink,
  findMeetingLink,
  isCalendarMeetingLinkError,
  isCalendarTimeRangeError,
  hasPlainHost,
  isFeaturedLinkRow,
  isKnownMeetingLink,
  isMeetingLinkUrl,
  MAX_MEETING_LINK_INPUT,
  MAX_MEETING_LINK_LENGTH,
  MEETING_LINK_MESSAGE,
  meetingLinkForCopy,
  resolveFeaturedLink,
  type FeaturedLinkRef,
} from '../calendarPolicy.ts';
import {
  MEET_BARE_HOST_INVITATION,
  MEET_JOIN,
  TEAMS_NEW_INVITATION,
  TEAMS_NEW_JOIN,
  TEAMS_OLD_INVITATION,
  TEAMS_OLD_JOIN,
  WEBEX_INVITATION,
  WEBEX_JOIN,
  ZOOM_INVITATION,
  ZOOM_JOIN,
} from './helpers/meetingInvitations.ts';

describe('what an assistant may create', () => {
  it('allows office hours and nothing else', () => {
    expect(assistantMayCreateEventType('OFFICE_HOURS')).toBe(true);
    for (const type of ['LECTURE', 'LAB', 'ASSESSMENT']) {
      expect(assistantMayCreateEventType(type)).toBe(false);
    }
  });

  it('refuses a create that names no type at all', () => {
    // Create requires one, so a missing type is a malformed request, not an
    // "unchanged" one — the update rule below is where absence means no change.
    expect(assistantMayCreateEventType(undefined)).toBe(false);
    expect(assistantMayCreateEventType(null)).toBe(false);
  });
});

describe('what an assistant may change an event to', () => {
  it('refuses moving an office-hours event to another type', () => {
    // The whole point: without this, the create limit is worth nothing — add
    // office hours, then retype it as a lecture.
    expect(assistantMayChangeEventType('LECTURE', 'OFFICE_HOURS')).toBe(false);
    expect(assistantMayChangeEventType('LAB', 'OFFICE_HOURS')).toBe(false);
    expect(assistantMayChangeEventType('ASSESSMENT', 'OFFICE_HOURS')).toBe(false);
  });

  it('allows an update that does not mention the type', () => {
    expect(assistantMayChangeEventType(undefined, 'OFFICE_HOURS')).toBe(true);
    expect(assistantMayChangeEventType(null, 'LECTURE')).toBe(true);
  });

  it('allows re-sending the type the event already has', () => {
    // An edit form posts every field. If somebody else retyped the event, the
    // assistant must still be able to change its time or place — refusing that
    // is a wall they can neither understand nor get around.
    expect(assistantMayChangeEventType('LECTURE', 'LECTURE')).toBe(true);
  });

  it('allows moving an event TOWARDS office hours', () => {
    expect(assistantMayChangeEventType('OFFICE_HOURS', 'LECTURE')).toBe(true);
  });

  it('names the one type in a constant both halves share', () => {
    expect(ASSISTANT_EVENT_TYPE).toBe('OFFICE_HOURS');
    expect(ASSISTANT_EVENT_TYPE_MESSAGE).toMatch(/office hours/i);
  });
});

describe('which linked resource gets the star', () => {
  const VALIDATED = {
    pageIds: ['page-a', 'page-b'],
    slideIds: ['deck-a'],
    assignmentIds: ['hw-a'],
  };

  const cases: Array<[string, FeaturedLinkRef | null | undefined, FeaturedLinkRef | null]> = [
    ['a page that is being linked', { kind: 'page', id: 'page-b' }, { kind: 'page', id: 'page-b' }],
    [
      'a deck that is being linked',
      { kind: 'slide', id: 'deck-a' },
      { kind: 'slide', id: 'deck-a' },
    ],
    [
      'an assignment that is being linked',
      { kind: 'assignment', id: 'hw-a' },
      { kind: 'assignment', id: 'hw-a' },
    ],
    // Not a refusal: the save keeps its links and simply shows nothing under
    // the event. An id can fail to be in the list because the user unlinked it
    // in the same save, or because the caller already dropped it as belonging
    // to another classroom.
    ['an id nobody is linking', { kind: 'page', id: 'page-elsewhere' }, null],
    // The kind is what the caller asserted; honouring an id found under
    // another kind would star a row the user did not point at.
    ['a page id offered as a deck', { kind: 'slide', id: 'page-a' }, null],
    ['no star at all', null, null],
    ['an absent star', undefined, null],
    ['an empty id', { kind: 'page', id: '' }, null],
    ['a kind the calendar does not have', { kind: 'quiz' as 'page', id: 'page-a' }, null],
  ];

  it.each(cases)('resolves %s', (_name, featured, expected) => {
    expect(resolveFeaturedLink(featured, VALIDATED)).toEqual(expected);
  });

  it('is asked per row, so exactly one row can come out true', () => {
    const resolved = resolveFeaturedLink({ kind: 'page', id: 'page-b' }, VALIDATED);

    expect(VALIDATED.pageIds.map(id => isFeaturedLinkRow(resolved, 'page', id))).toEqual([
      false,
      true,
    ]);
    // Same id, another kind's table: still not the starred row.
    expect(isFeaturedLinkRow(resolved, 'slide', 'page-b')).toBe(false);
    expect(isFeaturedLinkRow(resolved, 'assignment', 'hw-a')).toBe(false);
  });

  it('stars nothing when nothing resolved', () => {
    expect(isFeaturedLinkRow(null, 'page', 'page-a')).toBe(false);
  });
});

describe('recognising a refused time range', () => {
  it('accepts the error the service throws', () => {
    expect(isCalendarTimeRangeError(new CalendarTimeRangeError())).toBe(true);
  });

  it('accepts one that crossed a module boundary and lost its identity', () => {
    // A bundler that splits this package, or a mocked import, hands a caller a
    // structurally identical error that fails `instanceof`. The discriminant is
    // what survives.
    expect(isCalendarTimeRangeError({ reason: 'end_before_start', message: 'x' })).toBe(true);
  });

  it('rejects anything else, so a real fault is not shown as a form error', () => {
    expect(isCalendarTimeRangeError(new Error('connection reset'))).toBe(false);
    expect(isCalendarTimeRangeError({ reason: 'something_else' })).toBe(false);
    expect(isCalendarTimeRangeError(null)).toBe(false);
    expect(isCalendarTimeRangeError(undefined)).toBe(false);
    expect(isCalendarTimeRangeError('end_before_start')).toBe(false);
  });
});

// ─── Meeting links ──────────────────────────────────────────────────────────

const ZOOM = 'https://school.zoom.us/j/91234567890?pwd=abcDEF123';
/** A pasted Zoom invitation, as it arrives from a single-line input. */
const INVITATION =
  `Alex is inviting you to a scheduled Zoom meeting. Topic: Office hours ` +
  `Join Zoom Meeting ${ZOOM} Meeting ID: 912 3456 7890 Passcode: 123456`;

/** One of each invisible character the rule removes. */
const INVISIBLE_MARKS = [
  '\u00AD',
  '\u200B',
  '\u200C',
  '\u200D',
  '\u200E',
  '\u200F',
  '\u202A',
  '\u202B',
  '\u202C',
  '\u202D',
  '\u202E',
  '\u2060',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
  '\uFEFF',
];
/** A mark as `U+XXXX`, for a readable failure. */
const escape = (mark: string) =>
  `U+${mark.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

const link = (meetingLink: string | null, text: string | null = null) => ({
  ok: true,
  meetingLink,
  text,
  unchangedNote: false,
});

describe('what counts as a meeting link on its own', () => {
  it.each([
    ZOOM,
    'http://example.edu/room',
    '  https://meet.google.com/abc-defg-hij  ',
    'HTTPS://Zoom.us/j/1',
    'http://localhost:3000/meet',
    // An unencoded link inside a query is still one link.
    'https://www.google.com/url?q=https://zoom.us/j/1',
    'https://school.zoom.us:8443/j/1',
    'https://zoom.us./j/1',
    'https://b\u00FCcher.example/room',
  ])('accepts %s', value => {
    expect(isMeetingLinkUrl(value)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'zoom.us/j/1',
    'javascript:alert(1)',
    'mailto:ta@example.edu',
    'ftp://files.example.edu/x',
    'https://',
    // Parses as a URL once the spaces are encoded, but it is an invitation.
    `${ZOOM} Meeting ID: 912 3456 7890`,
    INVITATION,
    // Two links joined by a comma or semicolon parse as one; they are not.
    'https://zoom.us/j/1,https://example.edu/notes',
    'https://zoom.us/j/1;https://example.edu/notes',
    // Hosts that are not plain DNS names, and one-digit ports.
    'https://my_host.zoom.us/j/1',
    'https://192.168.1.10/meet',
    'https://[::1]/meet',
    'https://zoom.us:1/j/1',
  ])('refuses %j', value => {
    expect(isMeetingLinkUrl(value)).toBe(false);
  });
});

describe('which hosts are plain', () => {
  it.each([
    'https://zoom.us/j/1',
    'https://a-b--c.school.zoom.us/j/1',
    'https://zoom.us./j/1',
    'https://zoom.us:8443/j/1',
    'https://zoom.us:65535/j/1',
    'http://localhost:3000/',
  ])('%s is', value => {
    expect(hasPlainHost(new URL(value))).toBe(true);
  });

  it.each([
    'https://my_host.zoom.us/j/1',
    'https://-a.zoom.us/j/1',
    'https://192.168.1.10/',
    'https://[::1]/',
    'https://zoom.us:1/j/1',
    'https://zoom.us..x/',
  ])('%s is not', value => {
    expect(hasPlainHost(new URL(value))).toBe(false);
  });
});

describe('which links are known join links', () => {
  it.each([
    'https://zoom.us/j/91234567890',
    'https://school.zoom.us/j/91234567890?pwd=x',
    'https://school.zoom.us/my/ta.office.hours',
    'https://meet.google.com/abc-defg-hij',
    TEAMS_OLD_JOIN,
    TEAMS_NEW_JOIN,
    'https://teams.live.com/meet/9876543210123?p=AbCdEfGh',
    WEBEX_JOIN,
    'https://school.webex.com/meet/ta.office.hours',
    'https://school.webex.com/join/ta.office.hours',
    'https://school.webex.com/wbxmjs/joinservice/sites/school/meeting/download/0123abcd',
    // The path match ignores case, as Zoom does.
    'https://school.zoom.us/J/91234567890',
  ])('knows %s', value => {
    expect(isKnownMeetingLink(value)).toBe(true);
  });

  it.each([
    'https://school.zoom.us/u/abCdEfGhIj',
    'https://school.zoom.us/meeting/tExampleMeeting0001/ics?icsToken=example-token-0001',
    'https://zoom.us.example.com/j/1',
    'https://meet.google.com/',
    'https://tel.meet/abc-defg-hij?pin=1',
    'https://aka.ms/JoinTeamsMeeting?omkt=en-US',
    'https://teams.microsoft.com/meetingOptions/?organizerId=x',
    'https://dialin.teams.microsoft.com/usp/pstnconferencing',
    'https://webex.com/',
    // A Webex host alone is not a join link: help pages and site roots are not.
    'https://help.webex.com/en-us/article/nk2vwjp',
    'https://school.webex.com/',
    'https://school.webex.com/school/meetings',
    'https://example.edu/room',
  ])('does not prefer %s', value => {
    expect(isKnownMeetingLink(value)).toBe(false);
  });
});

describe('finding the meeting link inside pasted text', () => {
  it.each([
    ['Zoom, with a calendar-file link first', ZOOM_INVITATION, ZOOM_JOIN],
    ['Teams, older layout, with "Need help?" first', TEAMS_OLD_INVITATION, TEAMS_OLD_JOIN],
    ['Teams, newer layout', TEAMS_NEW_INVITATION, TEAMS_NEW_JOIN],
    ['Meet, join link printed without https://', MEET_BARE_HOST_INVITATION, MEET_JOIN],
    ['Webex', WEBEX_INVITATION, WEBEX_JOIN],
  ])('%s', (_name, invitation, expected) => {
    expect(findMeetingLink(invitation)).toBe(expected);
  });

  it('prefers a Zoom join link over an earlier Webex help page', () => {
    expect(
      findMeetingLink('Need help? https://help.webex.com/en-us/article/nk2vwjp Join: ' + ZOOM)
    ).toBe(ZOOM);
  });

  it('keeps a closing parenthesis that the link itself opened', () => {
    const wiki = 'https://en.wikipedia.org/wiki/Office_(film)';
    expect(findMeetingLink(`Reading: ${wiki}.`)).toBe(wiki);
    expect(findMeetingLink(`Reading (${wiki}) for today`)).toBe(wiki);
  });

  it('falls back to the first link when no known service is in the text', () => {
    expect(
      findMeetingLink('Room booking: https://example.edu/rooms/12 or https://example.edu/b')
    ).toBe('https://example.edu/rooms/12');
  });

  it('leaves out punctuation and wrapping around the link', () => {
    expect(findMeetingLink(`Join here: ${ZOOM}.`)).toBe(ZOOM);
    expect(findMeetingLink(`(see ${ZOOM})`)).toBe(ZOOM);
    expect(findMeetingLink(`Join <${ZOOM}> now`)).toBe(ZOOM);
    expect(findMeetingLink(`Join **${ZOOM}** now`)).toBe(ZOOM);
  });

  it('splits two links joined by a comma', () => {
    expect(findMeetingLink('https://example.edu/notes,https://zoom.us/j/1')).toBe(
      'https://zoom.us/j/1'
    );
    expect(findMeetingLink('https://example.edu/a,https://example.edu/b')).toBe(
      'https://example.edu/a'
    );
  });

  it('ignores invisible characters', () => {
    for (const mark of INVISIBLE_MARKS) {
      expect(findMeetingLink(`Join: https://zoom.us/j/1${mark}23`), escape(mark)).toBe(
        'https://zoom.us/j/123'
      );
    }
  });

  it('returns null when there is no web link', () => {
    expect(findMeetingLink('Meeting ID: 912 3456 7890 Passcode: 123456')).toBeNull();
    expect(findMeetingLink('mailto:ta@example.edu')).toBeNull();
    expect(findMeetingLink('Dial 26301234567@school.webex.com')).toBeNull();
    expect(findMeetingLink('Dial 26301234567@school.webex.com/meet/ta')).toBeNull();
  });
});

describe('what a save does with the meeting-link field', () => {
  it('keeps a link, trimmed', () => {
    expect(checkMeetingLink(`  ${ZOOM} `)).toEqual(link(ZOOM));
  });

  it('treats an empty field as no link', () => {
    for (const value of [null, undefined, '', '   ', '\u200B']) {
      expect(checkMeetingLink(value)).toEqual(link(null));
    }
  });

  it('takes the wrapping and closing punctuation off a link on its own', () => {
    for (const value of [
      `<${ZOOM}>`,
      `**${ZOOM}**`,
      `${ZOOM}.`,
      `${ZOOM},`,
      `${ZOOM};`,
      `${ZOOM}:`,
      `(${ZOOM})`,
      `[${ZOOM}]`,
    ]) {
      expect(checkMeetingLink(value), value).toEqual(link(ZOOM));
    }
  });

  it('removes zero-width characters before checking', () => {
    expect(checkMeetingLink(`\uFEFF${ZOOM}\u200B`)).toEqual(link(ZOOM));
    expect(checkMeetingLink(`https://zoom.us/j/1\u200C23\u200D`)).toEqual(
      link('https://zoom.us/j/123')
    );
  });

  it('keeps a closing parenthesis that the link itself opened', () => {
    const wiki = 'https://en.wikipedia.org/wiki/Office_(film)';
    expect(checkMeetingLink(wiki)).toEqual(link(wiki));
    expect(checkMeetingLink(`(${wiki})`)).toEqual(link(wiki));
    expect(checkMeetingLink(`${wiki}).`)).toEqual(link(wiki));
  });

  it('removes every kind of invisible character before checking', () => {
    for (const mark of INVISIBLE_MARKS) {
      expect(checkMeetingLink(`${mark}https://zoom.us/j/1${mark}23${mark}`), escape(mark)).toEqual(
        link('https://zoom.us/j/123')
      );
    }
  });

  it('does not turn an address with a user name into a link, as in running text', () => {
    // The same values inside text are not found either (see findMeetingLink).
    for (const value of ['26301234567@school.webex.com', '26301234567@school.webex.com/meet/ta']) {
      expect(checkMeetingLink(value).ok, value).toBe(false);
    }
    expect(checkMeetingLink('ta@zoom.us/j/1').ok).toBe(false);
  });

  it('adds https:// to a known meeting link written without it', () => {
    expect(checkMeetingLink('meet.google.com/abc-defg-hij')).toEqual(link(MEET_JOIN));
    expect(checkMeetingLink('zoom.us/j/1')).toEqual(link('https://zoom.us/j/1'));
  });

  it('takes the meeting link out of a pasted invitation and keeps the paste for the description', () => {
    expect(checkMeetingLink(` ${INVITATION} `)).toEqual(link(ZOOM, INVITATION));
    expect(checkMeetingLink(TEAMS_OLD_INVITATION)).toEqual(
      link(TEAMS_OLD_JOIN, TEAMS_OLD_INVITATION)
    );
  });

  it('keeps one of two links joined by a comma, and the pair for the description', () => {
    const joined = 'https://zoom.us/j/1,https://example.edu/notes';
    expect(checkMeetingLink(joined)).toEqual(link('https://zoom.us/j/1', joined));
  });

  it('refuses new text with no link in it, with the message the user sees', () => {
    for (const value of ['Meeting ID: 912 3456 7890', 'TBD', 'example.edu/room']) {
      expect(checkMeetingLink(value)).toEqual({ ok: false, message: MEETING_LINK_MESSAGE });
    }
    expect(MEETING_LINK_MESSAGE).toBe(
      "Enter the meeting's link, starting with https://. Put other notes in the description."
    );
  });

  it('refuses a link that is not http(s)', () => {
    expect(checkMeetingLink('javascript:alert(1)').ok).toBe(false);
  });

  it('keeps invisible characters in text for the description, while the link check ignores them', () => {
    const coder = '\uD83D\uDC69\u200D\uD83D\uDCBB';
    const note = `${coder} office hours in the lab`;
    expect(checkMeetingLink(note, note)).toEqual({
      ok: true,
      meetingLink: null,
      text: note,
      unchangedNote: true,
    });
    const paste = `${coder} Join: ${ZOOM}`;
    expect(checkMeetingLink(paste)).toEqual(link(ZOOM, paste));
    expect(meetingLinkForCopy(note, null)).toEqual({ meeting_link: null, description: note });
  });

  it('compares a note without invisible characters, so an added mark still counts as unchanged', () => {
    expect(checkMeetingLink('TBD\u200E', 'TBD').ok).toBe(true);
  });

  it('accepts the stored note sent back unchanged, as text for the description', () => {
    for (const note of ['TBD', 'See Canvas', 'example.edu/room']) {
      expect(checkMeetingLink(` ${note} `, note)).toEqual({
        ok: true,
        meetingLink: null,
        text: note,
        unchangedNote: true,
      });
    }
  });

  it('still refuses a note that differs from the stored one', () => {
    expect(checkMeetingLink('TBA', 'TBD').ok).toBe(false);
    expect(checkMeetingLink('TBD', null).ok).toBe(false);
  });

  it('refuses a field longer than the limit before reading it', () => {
    const long = `${ZOOM} ${'x'.repeat(MAX_MEETING_LINK_INPUT)}`;
    expect(checkMeetingLink(long)).toEqual({ ok: false, message: MEETING_LINK_MESSAGE });
  });

  it('keeps an over-long stored note sent back unchanged, as text for the description', () => {
    const note = 'n'.repeat(MAX_MEETING_LINK_INPUT + 1);
    expect(checkMeetingLink(note, note)).toEqual({
      ok: true,
      meetingLink: null,
      text: note,
      unchangedNote: true,
    });
  });

  it('does not take a value longer than the link limit as a link', () => {
    const longLink = `https://example.edu/${'a'.repeat(MAX_MEETING_LINK_LENGTH)}`;
    expect(isMeetingLinkUrl(longLink)).toBe(false);
    expect(checkMeetingLink(longLink).ok).toBe(false);
    expect(findMeetingLink(`Join: ${longLink}`)).toBeNull();
  });

  it('treats a stored invitation like a new paste: its link is kept', () => {
    expect(checkMeetingLink(INVITATION, INVITATION)).toEqual(link(ZOOM, INVITATION));
  });
});

describe('adding pasted text to a description', () => {
  it('uses the text alone when the description is empty', () => {
    expect(addToDescription(null, INVITATION)).toBe(INVITATION);
    expect(addToDescription(undefined, INVITATION)).toBe(INVITATION);
    expect(addToDescription('  ', INVITATION)).toBe(INVITATION);
  });

  it('appends after a blank line', () => {
    expect(addToDescription('Bring questions.', INVITATION)).toBe(
      `Bring questions.\n\n${INVITATION}`
    );
  });

  it('does not add it twice', () => {
    const description = `Bring questions.\n\n${INVITATION}`;
    expect(addToDescription(description, INVITATION)).toBe(description);
  });

  it('compares whole paragraphs, not substrings', () => {
    expect(addToDescription('Location TBD', 'TBD')).toBe('Location TBD\n\nTBD');
    expect(addToDescription('Notes\n\nTBD\n\nMore', 'TBD')).toBe('Notes\n\nTBD\n\nMore');
    expect(addToDescription('Notes\n\n  TBD  \n\n', ' TBD')).toBe('Notes\n\n  TBD  \n\n');
    expect(addToDescription('Notes\r\n\r\nTBD', 'TBD')).toBe('Notes\r\n\r\nTBD');
  });

  it('reads line breaks the same with or without carriage returns', () => {
    const description = 'Intro\r\n\r\nJoin Zoom\r\nhttps://zoom.us/j/1';
    expect(addToDescription(description, 'Join Zoom\nhttps://zoom.us/j/1')).toBe(description);
  });

  it('treats a line of only spaces, tabs or no-break spaces as a paragraph break', () => {
    for (const blank of [' ', '\t', '\u00A0', ' \u00A0\t']) {
      const description = `Intro\n${blank}\nTBD`;
      expect(addToDescription(description, 'TBD'), JSON.stringify(blank)).toBe(description);
    }
  });

  it('finds text of several paragraphs that is already there', () => {
    const description = `Bring questions.\n\n${ZOOM_INVITATION}`;
    expect(addToDescription(description, ZOOM_INVITATION)).toBe(description);
  });
});

describe('a copied event (class-to-class import)', () => {
  it('keeps a link', () => {
    expect(meetingLinkForCopy(ZOOM, 'Notes')).toEqual({ meeting_link: ZOOM, description: 'Notes' });
  });

  it('takes the link out of an invitation and moves the text to the description', () => {
    expect(meetingLinkForCopy(INVITATION, 'Notes')).toEqual({
      meeting_link: ZOOM,
      description: `Notes\n\n${INVITATION}`,
    });
  });

  it('moves text with no link to the description instead of refusing the copy', () => {
    expect(meetingLinkForCopy('Room TBD', null)).toEqual({
      meeting_link: null,
      description: 'Room TBD',
    });
  });

  it('adds the note even when a longer paragraph of the description mentions it', () => {
    expect(meetingLinkForCopy('TBD', 'Location TBD')).toEqual({
      meeting_link: null,
      description: 'Location TBD\n\nTBD',
    });
  });

  it('copies no link as no link', () => {
    expect(meetingLinkForCopy(null, null)).toEqual({ meeting_link: null, description: null });
    expect(meetingLinkForCopy('', 'Notes')).toEqual({ meeting_link: null, description: 'Notes' });
  });
});

describe('recognising a refused meeting link', () => {
  it('knows its own class, and carries the message', () => {
    const error = new CalendarMeetingLinkError();
    expect(isCalendarMeetingLinkError(error)).toBe(true);
    expect(error.message).toBe(MEETING_LINK_MESSAGE);
  });

  it('knows a structurally identical error from another copy of the module', () => {
    expect(isCalendarMeetingLinkError({ reason: 'invalid_meeting_link' })).toBe(true);
  });

  it('does not mistake other refusals for it', () => {
    expect(isCalendarMeetingLinkError(new CalendarTimeRangeError())).toBe(false);
    expect(isCalendarMeetingLinkError(new Error(MEETING_LINK_MESSAGE))).toBe(false);
    expect(isCalendarMeetingLinkError(null)).toBe(false);
  });
});

describe('long and repetitive input', () => {
  // Long runs of the characters each step trims, repeats or splits on. Every
  // case has to be handled in linear time, so even 100,000 characters take a
  // few milliseconds.
  const N = 100_000;
  const UNDER_CAP = MAX_MEETING_LINK_INPUT - 10;
  const CASES: Array<[string, string]> = [
    ['a run of dots between letters', 'x' + '.'.repeat(N) + 'x'],
    ['a run of closing parentheses', 'https://example.edu/' + ')'.repeat(N) + 'x'],
    ['balanced parentheses', 'https://example.edu/' + '('.repeat(N / 2) + ')'.repeat(N / 2)],
    ['a run of opening brackets', '<'.repeat(N) + 'x'],
    ['one long word', 'x'.repeat(N)],
    ['many short words', 'ab '.repeat(N / 3)],
    ['links joined by commas', 'https://zoom.us/j/1' + ',https://zoom.us/j/1'.repeat(N / 20)],
    ['a known host then a run of dots', 'meet.google.com/' + '.'.repeat(N) + 'x'],
    ['blank lines with spaces', '\n' + ' '.repeat(N) + 'x'],
    ['dots just under the field limit', 'x' + '.'.repeat(UNDER_CAP) + 'x'],
    ['parentheses just under the field limit', 'https://e.edu/' + ')'.repeat(UNDER_CAP)],
  ];

  it.each(CASES)('%s', (_name, value) => {
    const started = performance.now();
    checkMeetingLink(value);
    checkMeetingLink(value, value);
    checkMeetingLink(value.slice(0, UNDER_CAP));
    checkMeetingLink(value.slice(0, UNDER_CAP), value.slice(0, UNDER_CAP));
    findMeetingLink(value);
    isMeetingLinkUrl(value);
    addToDescription(value, value.slice(0, 1_000));
    meetingLinkForCopy(value, value);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(100);
  });
});
