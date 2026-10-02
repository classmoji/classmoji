/**
 * The class calendar feed is served whole even when one event cannot be.
 *
 * The ics library validates every event and fails the entire batch on one bad
 * field, so a single event once took the whole classroom's feed down: its
 * meeting link held a pasted invitation, and the library refuses a non-URL
 * `url`. The library is NOT mocked here — its validation is what is under
 * test. Only the calendar read is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getClassroomCalendar = vi.fn();

vi.mock('../calendar.service.ts', () => ({
  getClassroomCalendar: (...a: unknown[]) => getClassroomCalendar(...a),
}));

// The real library, watched: these spies call straight through, so its
// validation still decides every case below.
const ics = vi.hoisted(() => ({ createEvent: vi.fn(), createEvents: vi.fn() }));
vi.mock('ics', async importOriginal => {
  const actual = await importOriginal<typeof import('ics')>();
  ics.createEvent.mockImplementation(actual.createEvent as (...a: unknown[]) => unknown);
  ics.createEvents.mockImplementation(actual.createEvents as (...a: unknown[]) => unknown);
  return { ...actual, createEvent: ics.createEvent, createEvents: ics.createEvents };
});

const { feedUrl, generateCalendarFeed } = await import('../icsGenerator.service.ts');
const {
  MEET_JOIN,
  SAFELINKS_TEAMS_JOIN,
  TEAMS_LAUNCHER_JOIN,
  TEAMS_NEW_JOIN,
  TEAMS_OLD_JOIN,
  WEBEX_JOIN,
} = await import('./helpers/meetingInvitations.ts');

const ZOOM = 'https://school.zoom.us/j/91234567890?pwd=abc';
const INVITATION = `Join Zoom Meeting ${ZOOM} Meeting ID: 912 3456 7890 Passcode: 123456`;

const event = (over: Record<string, unknown>) => ({
  id: 'event-x',
  title: 'Lecture',
  description: null,
  event_type: 'LECTURE',
  start_time: new Date('2026-10-05T14:00:00Z'),
  end_time: new Date('2026-10-05T15:00:00Z'),
  location: null,
  meeting_link: null,
  ...over,
});

/** Length of text as the library writes it: a backslash, `;`, `,` or line feed takes two. */
const writtenLength = (text: string) => text.length + (text.match(/[\\;,\n]/g)?.length ?? 0);

/** The feed with its folded lines joined back, so long values read whole. */
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '');

/** The VEVENT blocks of a feed, keyed by the event id in their UID. */
const eventsById = (ics: string): Record<string, string> => {
  const blocks = unfold(ics).split('BEGIN:VEVENT').slice(1);
  return Object.fromEntries(
    blocks.map(block => [/UID:([^@\r\n]+)@/.exec(block)?.[1] ?? '?', block])
  );
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getClassroomCalendar.mockReset();
  ics.createEvent.mockClear();
  ics.createEvents.mockClear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the calendar feed', () => {
  it('serves an event whose meeting link is invitation text, with the text and no URL', async () => {
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'office-hours', title: 'Office hours', meeting_link: INVITATION }),
      event({ id: 'lecture', meeting_link: ZOOM }),
    ]);

    const feed = await generateCalendarFeed('class-1', 'demo-class');
    const events = eventsById(feed);

    expect(Object.keys(events).sort()).toEqual(['lecture', 'office-hours']);
    expect(events['office-hours']).not.toMatch(/^URL/m);
    expect(events['office-hours']).toContain('Meeting ID: 912 3456 7890');
    expect(events['office-hours']).toContain('Meeting Link: Join Zoom Meeting');
    expect(events['lecture']).toMatch(/^URL:https:\/\/school\.zoom\.us\/j\/91234567890/m);
  });

  it('gives the URL in the form the library accepts', async () => {
    // The library's URL check is lowercase-only for scheme and host.
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'lab', meeting_link: 'HTTPS://Zoom.US/j/123' }),
    ]);

    const events = eventsById(await generateCalendarFeed('class-1', 'demo-class'));

    expect(events['lab']).toMatch(/^URL:https:\/\/zoom\.us\/j\/123/m);
  });

  it('leaves out an event that fails validation and serves the rest', async () => {
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'broken', title: 'Private title', start_time: new Date('not a date') }),
      event({ id: 'lecture' }),
      event({ id: 'lab', title: 'Lab' }),
    ]);

    const feed = await generateCalendarFeed('class-1', 'demo-class');

    expect(feed).toMatch(/^BEGIN:VCALENDAR/);
    expect(feed).toContain('X-WR-CALNAME:demo-class Calendar');
    expect(Object.keys(eventsById(feed)).sort()).toEqual(['lab', 'lecture']);

    // The id is logged, and nothing of the event's content.
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0].map(String).join(' ');
    expect(logged).toContain('broken');
    expect(logged).not.toContain('Private title');
  });

  it('keeps an event the library refuses only for its URL, without the URL', async () => {
    // A backstop: the feed only sets URLs the library takes, so the refusal is
    // made up here, for one link, on top of the real library.
    const actual = await vi.importActual<typeof import('ics')>('ics');
    const refuse = (e: { url?: string }) => e.url === TEAMS_NEW_JOIN;
    ics.createEvent.mockImplementation((e: { url?: string }) =>
      refuse(e) ? { error: new Error('refused') } : actual.createEvent(e as never)
    );
    ics.createEvents.mockImplementation((list: Array<{ url?: string }>) =>
      list.some(refuse) ? { error: new Error('refused') } : actual.createEvents(list as never)
    );
    try {
      getClassroomCalendar.mockResolvedValue([
        event({ id: 'office-hours', meeting_link: TEAMS_NEW_JOIN }),
        event({ id: 'lecture', meeting_link: ZOOM }),
      ]);

      const events = eventsById(await generateCalendarFeed('class-1', 'demo-class'));

      expect(Object.keys(events).sort()).toEqual(['lecture', 'office-hours']);
      expect(events['office-hours']).not.toMatch(/^URL/m);
      expect(events['office-hours']).toContain(`Meeting Link: ${TEAMS_NEW_JOIN}`);
      expect(events['lecture']).toMatch(/^URL:/m);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      ics.createEvent.mockImplementation(actual.createEvent as (...a: unknown[]) => unknown);
      ics.createEvents.mockImplementation(actual.createEvents as (...a: unknown[]) => unknown);
    }
  });

  it('serves an event whose stored link is over the link length limit, without a URL field', async () => {
    const longLink = `https://school.zoom.us/j/1?pwd=${'a'.repeat(100_000)}`;
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'office-hours', meeting_link: longLink }),
      event({ id: 'lecture' }),
    ]);

    const events = eventsById(await generateCalendarFeed('class-1', 'demo-class'));

    expect(Object.keys(events).sort()).toEqual(['lecture', 'office-hours']);
    expect(events['office-hours']).not.toMatch(/^URL/m);
  });

  it('hands the library long text fields shortened, and stays quick', async () => {
    getClassroomCalendar.mockResolvedValue([
      event({
        id: 'lecture',
        title: 'T'.repeat(100_000),
        description: 'd'.repeat(100_000),
        location: 'l'.repeat(100_000),
      }),
    ]);

    const started = performance.now();
    await generateCalendarFeed('class-1', 'demo-class');

    expect(performance.now() - started).toBeLessThan(100);
    const sent = ics.createEvents.mock.calls[0][0] as Array<Record<string, string>>;
    expect(sent[0].title).toHaveLength(150);
    expect(sent[0].location).toHaveLength(150);
    expect(sent[0].description).toHaveLength(560);
    expect(sent[0].description.endsWith('…')).toBe(true);
  });

  it('counts the limits as the library writes the text, escapes included', async () => {
    getClassroomCalendar.mockResolvedValue([
      event({
        id: 'lecture',
        title: ','.repeat(1_000),
        description: ';\n'.repeat(1_000),
        location: '\\'.repeat(1_000),
      }),
    ]);

    await generateCalendarFeed('class-1', 'demo-class');

    const sent = ics.createEvents.mock.calls[0][0] as Array<Record<string, string>>;
    expect(writtenLength(sent[0].title)).toBeLessThanOrEqual(150);
    expect(writtenLength(sent[0].location)).toBeLessThanOrEqual(150);
    expect(writtenLength(sent[0].description)).toBeLessThanOrEqual(560);
    expect(writtenLength(sent[0].description)).toBeGreaterThan(550);
  });

  it('keeps the meeting link line whole within the description limit, shortening the text before it', async () => {
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'lecture', description: 'd'.repeat(10_000), meeting_link: TEAMS_OLD_JOIN }),
    ]);

    await generateCalendarFeed('class-1', 'demo-class');

    const sent = ics.createEvents.mock.calls[0][0] as Array<Record<string, string>>;
    expect(sent[0].description.endsWith(`…\n\nMeeting Link: ${TEAMS_OLD_JOIN}`)).toBe(true);
    expect(writtenLength(sent[0].description)).toBeLessThanOrEqual(560);
  });

  it('leaves a link line out of the description rather than cut it, when the URL field has it', async () => {
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'lecture', description: 'Bring questions.', meeting_link: SAFELINKS_TEAMS_JOIN }),
    ]);

    const events = eventsById(await generateCalendarFeed('class-1', 'demo-class'));

    const sent = ics.createEvents.mock.calls[0][0] as Array<Record<string, string>>;
    expect(sent[0].description).toBe('Bring questions.');
    expect(events['lecture']).toMatch(
      /^URL:https:\/\/nam12\.safelinks\.protection\.outlook\.com\//m
    );
  });

  it('keeps a short note in the meeting-link field whole, shortening the description before it', async () => {
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'lecture', description: 'd'.repeat(600), meeting_link: 'See Canvas' }),
    ]);

    await generateCalendarFeed('class-1', 'demo-class');

    const sent = ics.createEvents.mock.calls[0][0] as Array<Record<string, string>>;
    expect(sent[0].description.endsWith('…\n\nMeeting Link: See Canvas')).toBe(true);
    expect(writtenLength(sent[0].description)).toBeLessThanOrEqual(560);
  });

  it('shortens a note in the meeting-link field that is too long on its own', async () => {
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'lecture', description: 'Bring questions.', meeting_link: 'n'.repeat(1_000) }),
    ]);

    await generateCalendarFeed('class-1', 'demo-class');

    const sent = ics.createEvents.mock.calls[0][0] as Array<Record<string, string>>;
    // The description gives way first, so the note fills the description.
    expect(sent[0].description.startsWith('Meeting Link: nnn')).toBe(true);
    expect(sent[0].description.endsWith('…')).toBe(true);
    expect(writtenLength(sent[0].description)).toBe(560);
  });

  it('writes line breaks as line feeds, so a cut never leaves a carriage return alone', async () => {
    const CR = String.fromCharCode(13);
    for (let pad = 0; pad < 4; pad++) {
      getClassroomCalendar.mockResolvedValue([
        event({
          id: 'lecture',
          title: `Lecture${CR}Two`,
          description: 'y'.repeat(pad) + `xxxxxxx${CR}\n`.repeat(200),
          location: `Room${CR}\n101`,
        }),
      ]);

      const feed = await generateCalendarFeed('class-1', 'demo-class');

      // Every carriage return left is the one ending a feed line.
      expect(new RegExp(`${CR}(?!\n)`).test(feed), `pad ${pad}`).toBe(false);
    }
  });

  it('counts tag characters for more, so text made of them is cut shorter', async () => {
    const pair = String.fromCodePoint(0x1f3f4, 0xe0067);
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'lecture', description: pair.repeat(1_000) }),
    ]);

    await generateCalendarFeed('class-1', 'demo-class');

    const sent = ics.createEvents.mock.calls[0][0] as Array<Record<string, string>>;
    // Each pair is four UTF-16 units and counts as six.
    expect(sent[0].description.length).toBeLessThanOrEqual(Math.ceil((560 / 6) * 4) + 1);
    expect(sent[0].description.endsWith('…')).toBe(true);
  });

  it('serves a long daily series with every field at its limit in reasonable time', async () => {
    // 395 occurrences, every text field at its limit and the longest link the
    // URL field takes. About 0.5 s on a development laptop; the bound here
    // leaves room for a loaded test machine.
    const link = `https://zoom.us/j/${'a'.repeat(1_000 - 18)}`;
    getClassroomCalendar.mockResolvedValue(
      Array.from({ length: 395 }, (_, i) =>
        event({
          id: `occurrence-${i}`,
          title: ','.repeat(10_000),
          description: ','.repeat(10_000),
          location: ','.repeat(10_000),
          meeting_link: link,
          start_time: new Date(Date.UTC(2026, 8, 1 + i, 14)),
          end_time: new Date(Date.UTC(2026, 8, 1 + i, 15)),
        })
      )
    );

    const started = performance.now();
    const events = eventsById(await generateCalendarFeed('class-1', 'demo-class'));

    expect(performance.now() - started).toBeLessThan(3_000);
    expect(Object.keys(events)).toHaveLength(395);
    expect(events['occurrence-0']).toMatch(/^URL:https:\/\/zoom\.us\/j\//m);
  });

  describe('the URL field', () => {
    const ordinary = [
      ZOOM,
      MEET_JOIN,
      TEAMS_OLD_JOIN,
      TEAMS_NEW_JOIN,
      TEAMS_LAUNCHER_JOIN,
      SAFELINKS_TEAMS_JOIN,
      WEBEX_JOIN,
      'https://school.zoom.us:8443/j/1',
      'http://localhost:3000/meet',
    ];

    it.each(ordinary)('takes %s', link => {
      expect(feedUrl(link)).toBe(new URL(link).href);
    });

    it('is set in the feed for ordinary meeting links', async () => {
      getClassroomCalendar.mockResolvedValue(
        ordinary.map((link, i) => event({ id: `link-${i}`, meeting_link: link }))
      );

      const events = eventsById(await generateCalendarFeed('class-1', 'demo-class'));

      ordinary.forEach((link, i) => {
        expect(events[`link-${i}`], link).toMatch(/^URL:http/m);
      });
    });

    it.each([
      ['an underscore in the host', 'https://my_host.zoom.us/j/1'],
      ['an IPv4 address', 'https://192.0.2.10/meet'],
      ['an IPv6 address', 'https://[2001:db8::1]/meet'],
      ['a one-digit port', 'https://zoom.us:1/j/1'],
      ['a user name', 'https://ta@zoom.us/j/1'],
      ['a user name and password', 'https://ta:pw@zoom.us/j/1'],
      ['an @ in the path', 'https://zoom.us/j/1@x'],
      ['an @ in the fragment', 'https://zoom.us/j/1#a@b'],
      ['nine colons after the scheme', 'https://zoom.us/j/a:b:c:d:e:f:g:h:i:j'],
      ['more than the length limit', `https://school.zoom.us/j/1?pwd=${'a'.repeat(1_000)}`],
    ])('refuses a link with %s', (_name, link) => {
      expect(feedUrl(link)).toBeNull();
    });

    it('takes eight colons after the scheme, a port included, and refuses nine', () => {
      expect(feedUrl('https://zoom.us:8443/j/a:b:c:d:e:f:g:h')).not.toBeNull();
      expect(feedUrl('https://zoom.us:8443/j/a:b:c:d:e:f:g:h:i')).toBeNull();
    });

    it('takes an @ in the query, written as %40', () => {
      expect(feedUrl(`${MEET_JOIN}?authuser=ta@school.example`)).toBe(
        `${MEET_JOIN}?authuser=ta%40school.example`
      );
    });

    it('takes a link up to the length limit', () => {
      const link = `https://school.zoom.us/j/1?pwd=${'a'.repeat(1_000 - 31)}`;
      expect(link).toHaveLength(1_000);
      expect(feedUrl(link)).toBe(link);
    });

    it('is left out for a link longer than the limit, which the description keeps when it fits', async () => {
      const link = `https://school.zoom.us/j/1?pwd=${'a'.repeat(400)}`;
      const longer = `https://school.zoom.us/j/1?pwd=${'a'.repeat(1_000)}`;
      getClassroomCalendar.mockResolvedValue([
        event({ id: 'lecture', meeting_link: link }),
        event({ id: 'lab', meeting_link: longer }),
      ]);

      const events = eventsById(await generateCalendarFeed('class-1', 'demo-class'));

      expect(events['lecture']).toMatch(/^URL:/m);
      expect(events['lecture']).toContain(`Meeting Link: ${link}`);
      expect(events['lab']).not.toMatch(/^URL/m);
      expect(events['lab']).not.toContain('Meeting Link:');
    });
  });

  it('validates the whole list once when every event is fine', async () => {
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'lecture' }),
      event({ id: 'lab', meeting_link: ZOOM }),
      event({ id: 'office-hours', meeting_link: INVITATION }),
    ]);

    await generateCalendarFeed('class-1', 'demo-class');

    expect(ics.createEvents).toHaveBeenCalledTimes(1);
    expect(ics.createEvent).not.toHaveBeenCalled();
  });

  it('checks events one by one only after the whole list is refused', async () => {
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'lecture' }),
      event({ id: 'broken', start_time: new Date('not a date') }),
      event({ id: 'lab' }),
    ]);

    await generateCalendarFeed('class-1', 'demo-class');

    // The whole list, then the servable rest; each event checked once between.
    expect(ics.createEvents).toHaveBeenCalledTimes(2);
    expect(ics.createEvent).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('serves an empty calendar when no event can be served', async () => {
    getClassroomCalendar.mockResolvedValue([
      event({ id: 'broken', start_time: new Date('not a date') }),
    ]);

    const feed = await generateCalendarFeed('class-1', 'demo-class');

    expect(feed).toContain('BEGIN:VCALENDAR');
    expect(feed).toContain('X-WR-CALNAME:demo-class Calendar');
    expect(feed).toContain('END:VCALENDAR');
    expect(feed).not.toContain('BEGIN:VEVENT');
  });

  it("reads the calendar's student view, so a draft quiz or a not-yet-released deadline stays out", async () => {
    // The feed is shared by URL with the whole class. Passing no viewer and
    // no options is what selects the published-only view, where
    // getDeadlinesForRange applies the student-visibility rule
    // (calendar.quizDeadlines.test.ts pins that rule itself).
    getClassroomCalendar.mockResolvedValue([]);

    await generateCalendarFeed('class-1', 'demo-class');

    expect(getClassroomCalendar).toHaveBeenCalledTimes(1);
    const args = getClassroomCalendar.mock.calls[0];
    expect(args).toHaveLength(3);
    expect(args[0]).toBe('class-1');
  });
});
