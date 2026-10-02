/**
 * The meeting-link rule at the service, where every surface that writes an
 * event ends up: a link is kept; a pasted invitation gives up its meeting link
 * and moves to the description; a stored note with no link, sent back
 * unchanged, never blocks a save; anything else is refused before a write.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calendarEvent = {
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
};
const calendarEventOverride = { create: vi.fn(), update: vi.fn() };

vi.mock('@classmoji/database', () => ({
  GIT_IDENTITY: {},
  default: () => ({
    calendarEvent,
    calendarEventOverride,
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        calendarEvent,
        calendarEventOverride: { ...calendarEventOverride, updateMany: vi.fn() },
        calendarEventPageLink: { updateMany: vi.fn() },
        calendarEventSlideLink: { updateMany: vi.fn() },
        calendarEventAssignmentLink: { updateMany: vi.fn() },
      }),
  }),
}));

const {
  createEvent,
  createOverride,
  updateEvent,
  updateEventWithScope,
  updateOverride,
  CalendarMeetingLinkError,
} = await import('../calendar.service.ts');
const { MEETING_LINK_MESSAGE } = await import('../calendarPolicy.ts');

const ZOOM = 'https://school.zoom.us/j/91234567890?pwd=abc';
const INVITATION = `Join Zoom Meeting ${ZOOM} Meeting ID: 912 3456 7890 Passcode: 123456`;
const OCCURRENCE = new Date('2026-09-28T13:00:00Z');
const BASE = {
  event_type: 'OFFICE_HOURS' as const,
  title: 'Office hours',
  start_time: '2026-09-28T13:00:00Z',
  end_time: '2026-09-28T14:00:00Z',
};
const SERIES_SCOPES = ['all', 'this_and_future'] as const;

/** The stored event, as findUnique returns it. */
const stored = (over: Record<string, unknown> = {}) => ({
  id: 'event-1',
  classroom_id: 'class-1',
  created_by: 'owner-1',
  event_type: 'OFFICE_HOURS',
  title: 'Office hours',
  description: 'Stored notes',
  start_time: new Date('2026-09-07T13:00:00Z'),
  end_time: new Date('2026-09-07T14:00:00Z'),
  location: null,
  meeting_link: 'https://old.example.edu/room',
  is_recurring: true,
  recurrence_rule: { days: ['monday'] },
  overrides: [],
  ...over,
});

const createdData = () => calendarEvent.create.mock.calls[0][0].data;
const updatedData = () => calendarEvent.update.mock.calls[0][0].data;
/** The row a scoped edit wrote the series fields to: 'all' updates, 'this_and_future' creates. */
const seriesWrite = (scope: (typeof SERIES_SCOPES)[number]) =>
  scope === 'all' ? updatedData() : createdData();

beforeEach(() => {
  vi.clearAllMocks();
  calendarEvent.findUnique.mockResolvedValue(stored());
  calendarEvent.create.mockResolvedValue({ id: 'event-2' });
  calendarEvent.update.mockResolvedValue({ id: 'event-1' });
});

describe('creating an event', () => {
  it('keeps a link as typed', async () => {
    await createEvent('class-1', 'owner-1', { ...BASE, meeting_link: ` ${ZOOM} ` });

    expect(createdData()).toMatchObject({ meeting_link: ZOOM });
  });

  it('takes the link out of a pasted invitation and adds the paste to the description', async () => {
    await createEvent('class-1', 'owner-1', {
      ...BASE,
      description: 'Bring questions.',
      meeting_link: INVITATION,
    });

    expect(createdData()).toMatchObject({
      meeting_link: ZOOM,
      description: `Bring questions.\n\n${INVITATION}`,
    });
  });

  it('uses the paste as the description when there is none', async () => {
    await createEvent('class-1', 'owner-1', {
      ...BASE,
      description: null,
      meeting_link: INVITATION,
    });

    expect(createdData()).toMatchObject({ meeting_link: ZOOM, description: INVITATION });
  });

  it('refuses text with no link in it, and writes nothing', async () => {
    const error = await createEvent('class-1', 'owner-1', {
      ...BASE,
      meeting_link: 'Meeting ID: 912 3456 7890',
    }).then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(error).toBeInstanceOf(CalendarMeetingLinkError);
    expect(error?.message).toBe(MEETING_LINK_MESSAGE);
    expect(calendarEvent.create).not.toHaveBeenCalled();
  });

  it('refuses a link that is not http(s)', async () => {
    await expect(
      createEvent('class-1', 'owner-1', { ...BASE, meeting_link: 'javascript:alert(1)' })
    ).rejects.toBeInstanceOf(CalendarMeetingLinkError);
  });

  it('stores an empty field as no link', async () => {
    await createEvent('class-1', 'owner-1', { ...BASE, meeting_link: '  ' });

    expect(createdData().meeting_link).toBeNull();
  });
});

describe('updating an event', () => {
  it('leaves link and description alone when the update does not mention the link', async () => {
    await updateEvent('event-1', { title: 'Renamed' });

    expect(updatedData().meeting_link).toBeUndefined();
    expect(updatedData().description).toBeUndefined();
    expect(calendarEvent.findUnique).not.toHaveBeenCalled();
  });

  it('adds a pasted invitation to the description the update sends', async () => {
    await updateEvent('event-1', { description: 'New notes', meeting_link: INVITATION });

    expect(updatedData()).toMatchObject({
      meeting_link: ZOOM,
      description: `New notes\n\n${INVITATION}`,
    });
    expect(calendarEvent.findUnique).not.toHaveBeenCalled();
  });

  it('adds it to the stored description when the update sends none', async () => {
    await updateEvent('event-1', { meeting_link: INVITATION });

    expect(calendarEvent.findUnique).toHaveBeenCalledTimes(1);
    expect(updatedData()).toMatchObject({
      meeting_link: ZOOM,
      description: `Stored notes\n\n${INVITATION}`,
    });
  });

  it('does not add the paste a second time on a later save', async () => {
    const description = `Stored notes\n\n${INVITATION}`;

    await updateEvent('event-1', { description, meeting_link: INVITATION });

    expect(updatedData().description).toBe(description);
  });

  it('clears the link when the field is emptied', async () => {
    await updateEvent('event-1', { meeting_link: null });

    expect(updatedData().meeting_link).toBeNull();
  });

  it('refuses a new note with no link in it, and writes nothing', async () => {
    await expect(updateEvent('event-1', { meeting_link: 'See Canvas' })).rejects.toBeInstanceOf(
      CalendarMeetingLinkError
    );

    expect(calendarEvent.update).not.toHaveBeenCalled();
  });
});

describe('an older event whose stored link is a note with no link in it', () => {
  beforeEach(() => {
    calendarEvent.findUnique.mockResolvedValue(
      stored({ meeting_link: 'See Canvas', is_recurring: false, recurrence_rule: null })
    );
  });

  it('saves with the note unchanged, moving it to the description and clearing the link', async () => {
    await updateEvent('event-1', {
      title: 'Office hours (moved)',
      description: 'Stored notes',
      meeting_link: 'See Canvas',
    });

    expect(updatedData()).toMatchObject({
      title: 'Office hours (moved)',
      meeting_link: null,
      description: 'Stored notes\n\nSee Canvas',
    });
  });

  it('does not add the note twice when the description already has it as a paragraph', async () => {
    await updateEvent('event-1', {
      description: 'Stored notes\n\nSee Canvas\n\nBring questions.',
      meeting_link: 'See Canvas',
    });

    expect(updatedData().description).toBe('Stored notes\n\nSee Canvas\n\nBring questions.');
  });

  it('still adds the note when the description only has it inside a longer paragraph', async () => {
    await updateEvent('event-1', {
      description: 'Stored notes. See Canvas for the room.',
      meeting_link: 'See Canvas',
    });

    expect(updatedData().description).toBe('Stored notes. See Canvas for the room.\n\nSee Canvas');
  });

  it('still refuses a changed note, and writes nothing', async () => {
    const error = await updateEvent('event-1', { meeting_link: 'See Canvas p. 2' }).then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(error?.message).toBe(MEETING_LINK_MESSAGE);
    expect(calendarEvent.update).not.toHaveBeenCalled();
  });
});

describe('updating a recurring event', () => {
  it('refuses a new note with no link in it, and writes nothing', async () => {
    for (const scope of ['all', 'this_and_future', 'this_only'] as const) {
      await expect(
        updateEventWithScope('event-1', { meeting_link: 'See Canvas' }, scope, OCCURRENCE)
      ).rejects.toBeInstanceOf(CalendarMeetingLinkError);
    }

    expect(calendarEvent.update).not.toHaveBeenCalled();
    expect(calendarEvent.create).not.toHaveBeenCalled();
    expect(calendarEventOverride.create).not.toHaveBeenCalled();
  });

  it("'all': adds the paste to the stored description when the update sends none", async () => {
    await updateEventWithScope('event-1', { meeting_link: INVITATION }, 'all', OCCURRENCE);

    expect(updatedData()).toMatchObject({
      meeting_link: ZOOM,
      description: `Stored notes\n\n${INVITATION}`,
    });
  });

  it("'this_and_future': the new series carries the link and the paste", async () => {
    await updateEventWithScope(
      'event-1',
      { meeting_link: INVITATION },
      'this_and_future',
      OCCURRENCE
    );

    expect(createdData()).toMatchObject({
      meeting_link: ZOOM,
      description: `Stored notes\n\n${INVITATION}`,
    });
  });

  it("'this_only': the occurrence keeps the link (it has no description)", async () => {
    await updateEventWithScope('event-1', { meeting_link: INVITATION }, 'this_only', OCCURRENCE);

    const data = calendarEventOverride.create.mock.calls[0][0].data;
    expect(data.new_meeting_link).toBe(ZOOM);
    expect(data).not.toHaveProperty('description');
  });

  it.each(SERIES_SCOPES)("'%s': an emptied field clears the link", async scope => {
    await updateEventWithScope('event-1', { meeting_link: null }, scope, OCCURRENCE);

    expect(seriesWrite(scope).meeting_link).toBeNull();
  });

  it("'this_and_future': a write that leaves the link out carries the old one over", async () => {
    await updateEventWithScope('event-1', { title: 'Renamed' }, 'this_and_future', OCCURRENCE);

    expect(createdData().meeting_link).toBe('https://old.example.edu/room');
  });

  it("'this_only': an emptied field stores null on the occurrence, which shows the series link", async () => {
    // Null on an override means "as the series", not "no link": the calendar
    // expands an occurrence's link as `new_meeting_link || series link`.
    await updateEventWithScope('event-1', { meeting_link: null }, 'this_only', OCCURRENCE);

    expect(calendarEventOverride.create.mock.calls[0][0].data.new_meeting_link).toBeNull();
    expect(calendarEvent.update).not.toHaveBeenCalled();
  });
});

describe('a recurring event whose stored link is a note with no link in it', () => {
  beforeEach(() => {
    calendarEvent.findUnique.mockResolvedValue(stored({ meeting_link: 'TBD' }));
  });

  it.each(SERIES_SCOPES)(
    "'%s': saves with the note unchanged, moving it to the description",
    async scope => {
      await updateEventWithScope(
        'event-1',
        { title: 'Office hours', meeting_link: 'TBD' },
        scope,
        OCCURRENCE
      );

      expect(seriesWrite(scope)).toMatchObject({
        meeting_link: null,
        description: 'Stored notes\n\nTBD',
      });
    }
  );

  it("'this_only': saves, and leaves the series and the occurrence's link as they were", async () => {
    await updateEventWithScope(
      'event-1',
      { location: 'Room 101', meeting_link: 'TBD' },
      'this_only',
      OCCURRENCE
    );

    expect(calendarEvent.update).not.toHaveBeenCalled();
    expect(calendarEvent.create).not.toHaveBeenCalled();
    const data = calendarEventOverride.create.mock.calls[0][0].data;
    expect(data.new_location).toBe('Room 101');
    expect(data.new_meeting_link).toBeUndefined();
  });

  it("'this_only': an existing override's link is not touched either", async () => {
    calendarEvent.findUnique.mockResolvedValue(
      stored({
        meeting_link: 'TBD',
        overrides: [{ id: 'override-1', date: OCCURRENCE, new_meeting_link: null }],
      })
    );

    await updateEventWithScope('event-1', { meeting_link: 'TBD' }, 'this_only', OCCURRENCE);

    const data = calendarEventOverride.update.mock.calls[0][0].data;
    expect(data).toHaveProperty('new_meeting_link', undefined);
  });

  it('compares against the link the occurrence showed, which an override can set', async () => {
    calendarEvent.findUnique.mockResolvedValue(
      stored({
        meeting_link: ZOOM,
        overrides: [{ id: 'override-1', date: OCCURRENCE, new_meeting_link: 'Room TBD' }],
      })
    );

    await updateEventWithScope('event-1', { meeting_link: 'Room TBD' }, 'this_only', OCCURRENCE);

    expect(calendarEventOverride.update).toHaveBeenCalled();
  });

  it('still refuses a changed note', async () => {
    await expect(
      updateEventWithScope('event-1', { meeting_link: 'TBA' }, 'all', OCCURRENCE)
    ).rejects.toBeInstanceOf(CalendarMeetingLinkError);
  });
});

describe("a note on one date's override, saved from that date at a series scope", () => {
  // The series has a real link; only the edited date shows a note, from its
  // override. The form sends that note back untouched.
  beforeEach(() => {
    calendarEvent.findUnique.mockResolvedValue(
      stored({
        meeting_link: ZOOM,
        overrides: [{ id: 'override-1', date: OCCURRENCE, new_meeting_link: 'Room TBD' }],
      })
    );
  });

  it("'all': leaves the series link and description alone", async () => {
    await updateEventWithScope(
      'event-1',
      { title: 'Office hours', meeting_link: 'Room TBD' },
      'all',
      OCCURRENCE
    );

    expect(updatedData()).toMatchObject({ title: 'Office hours' });
    expect(updatedData().meeting_link).toBeUndefined();
    expect(updatedData().description).toBeUndefined();
  });

  it("'this_and_future': the new series keeps the series link and description", async () => {
    await updateEventWithScope(
      'event-1',
      { title: 'Office hours', meeting_link: 'Room TBD' },
      'this_and_future',
      OCCURRENCE
    );

    expect(createdData()).toMatchObject({ meeting_link: ZOOM, description: 'Stored notes' });
  });

  it('still refuses a note that is neither the series link nor the override note', async () => {
    await expect(
      updateEventWithScope('event-1', { meeting_link: 'Room TBA' }, 'all', OCCURRENCE)
    ).rejects.toBeInstanceOf(CalendarMeetingLinkError);
  });
});

describe("'this_and_future' and the dates before the split", () => {
  it('ends the old series without touching its link or description', async () => {
    calendarEvent.findUnique.mockResolvedValue(stored({ meeting_link: 'TBD' }));

    await updateEventWithScope(
      'event-1',
      { meeting_link: INVITATION },
      'this_and_future',
      OCCURRENCE
    );

    // The old row only gets its end date; its link column stays as stored.
    expect(Object.keys(updatedData())).toEqual(['recurrence_rule']);
    expect(createdData()).toMatchObject({ meeting_link: ZOOM });
  });
});

describe('occurrence overrides', () => {
  it('keep the link of a pasted invitation', async () => {
    await createOverride('event-1', OCCURRENCE, { new_meeting_link: INVITATION });
    await updateOverride('override-1', { new_meeting_link: ` ${ZOOM} ` });

    expect(calendarEventOverride.create.mock.calls[0][0].data.new_meeting_link).toBe(ZOOM);
    expect(calendarEventOverride.update.mock.calls[0][0].data.new_meeting_link).toBe(ZOOM);
  });

  it('refuse text with no link in it', async () => {
    await expect(
      createOverride('event-1', OCCURRENCE, { new_meeting_link: 'See Canvas' })
    ).rejects.toBeInstanceOf(CalendarMeetingLinkError);
    await expect(
      updateOverride('override-1', { new_meeting_link: 'See Canvas' })
    ).rejects.toBeInstanceOf(CalendarMeetingLinkError);

    expect(calendarEventOverride.create).not.toHaveBeenCalled();
    expect(calendarEventOverride.update).not.toHaveBeenCalled();
  });
});
