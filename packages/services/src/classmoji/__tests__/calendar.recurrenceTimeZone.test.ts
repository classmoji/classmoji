/**
 * A recurring event keeps its wall-clock time in the classroom's zone across a
 * daylight-saving change (#389), and its days and its `until` are the
 * classroom's own days, not UTC's.
 *
 * Prisma is mocked; the expansion runs for real against hand-built rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calendarEventFindMany = vi.fn();
const settingsFindUnique = vi.fn();

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({
    calendarEvent: { findMany: calendarEventFindMany },
    assignment: { findMany: vi.fn().mockResolvedValue([]) },
    form: { findMany: vi.fn().mockResolvedValue([]) },
    classroomSettings: { findUnique: settingsFindUnique },
  }),
}));

const { getClassroomCalendar } = await import('../calendar.service.ts');

/** Mon/Wed/Fri 14:10-15:15 in New York, first held Mon Sep 14 2026 (EDT, UTC-4). */
const series = (over: Record<string, unknown> = {}) => ({
  id: 'event-1',
  classroom_id: 'class-1',
  created_by: 'owner-1',
  event_type: 'LECTURE',
  title: 'Class',
  description: null,
  start_time: new Date('2026-09-14T18:10:00Z'),
  end_time: new Date('2026-09-14T19:15:00Z'),
  location: null,
  meeting_link: null,
  is_recurring: true,
  recurrence_rule: { days: ['monday', 'wednesday', 'friday'], until: '2026-11-16' },
  created_at: new Date('2026-09-01T00:00:00Z'),
  updated_at: new Date('2026-09-01T00:00:00Z'),
  creator: { id: 'owner-1', name: 'Prof', accounts: [] },
  overrides: [],
  pageLinks: [],
  slideLinks: [],
  assignmentLinks: [],
  ...over,
});

const occurrences = async (
  row: Record<string, unknown>,
  range: [string, string] = ['2026-09-01T00:00:00Z', '2026-12-31T00:00:00Z']
) => {
  calendarEventFindMany.mockResolvedValue([row]);
  const items = await getClassroomCalendar('class-1', new Date(range[0]), new Date(range[1]));
  return items.map(item => ({
    start: new Date(item.start_time).toISOString(),
    end: new Date(item.end_time).toISOString(),
  }));
};

beforeEach(() => {
  vi.clearAllMocks();
  settingsFindUnique.mockResolvedValue({ timezone: 'America/New_York' });
});

describe('a recurring event in the classroom zone', () => {
  it('stays at 14:10 local after daylight saving ends on Nov 1', async () => {
    const starts = (await occurrences(series())).map(o => o.start);

    // Mon Oct 26 and Fri Oct 30 are EDT; Mon Nov 2 on is EST, an hour later in UTC.
    expect(starts).toContain('2026-10-30T18:10:00.000Z');
    expect(starts).toContain('2026-11-02T19:10:00.000Z');
    expect(starts).toContain('2026-11-16T19:10:00.000Z');
    expect(
      starts.filter(start => start.endsWith('T18:10:00.000Z')).every(s => s < '2026-11-01')
    ).toBe(true);
  });

  it('keeps the length of the meeting', async () => {
    const [first] = await occurrences(series());
    const [after] = (await occurrences(series())).filter(o => o.start.startsWith('2026-11-02'));

    expect(new Date(first.end).getTime() - new Date(first.start).getTime()).toBe(65 * 60_000);
    expect(new Date(after.end).getTime() - new Date(after.start).getTime()).toBe(65 * 60_000);
  });

  it('includes the meeting on a date-only until, in the classroom zone', async () => {
    const starts = (await occurrences(series())).map(o => o.start);

    // Mon Nov 16 is the until date and a meeting day; nothing after it.
    expect(starts.at(-1)).toBe('2026-11-16T19:10:00.000Z');
  });

  it('puts an evening meeting on its local weekday, not UTC’s', async () => {
    // 21:00 EDT on a Monday is Tuesday 01:00Z.
    const evening = series({
      start_time: new Date('2026-09-15T01:00:00Z'),
      end_time: new Date('2026-09-15T02:00:00Z'),
      recurrence_rule: { days: ['monday'], until: '2026-10-05' },
    });

    expect((await occurrences(evening)).map(o => o.start)).toEqual([
      '2026-09-15T01:00:00.000Z',
      '2026-09-22T01:00:00.000Z',
      '2026-09-29T01:00:00.000Z',
      '2026-10-06T01:00:00.000Z',
    ]);
  });

  it('shows the same occurrences however far into the series the window starts', async () => {
    const whole = await occurrences(series());
    const late = await occurrences(series(), ['2026-11-01T12:00:00Z', '2026-12-31T00:00:00Z']);

    expect(late).toEqual(whole.filter(o => o.start >= '2026-11-01T12:00:00.000Z'));
  });

  it('applies an override to its date and leaves the rest of the series alone', async () => {
    const overridden = series({
      overrides: [
        {
          date: new Date('2026-11-04T19:10:00Z'),
          is_cancelled: false,
          new_start_time: new Date('2026-11-04T21:00:00Z'),
          new_end_time: new Date('2026-11-04T22:00:00Z'),
          new_location: 'Room 2',
          new_meeting_link: null,
        },
        { date: new Date('2026-11-06T19:10:00Z'), is_cancelled: true },
      ],
    });
    calendarEventFindMany.mockResolvedValue([overridden]);

    const items = await getClassroomCalendar(
      'class-1',
      new Date('2026-11-01T00:00:00Z'),
      new Date('2026-11-10T00:00:00Z')
    );

    expect(items.map(item => new Date(item.start_time).toISOString())).toEqual([
      '2026-11-02T19:10:00.000Z',
      '2026-11-04T21:00:00.000Z',
      '2026-11-09T19:10:00.000Z',
    ]);
    expect(items[1]).toMatchObject({ location: 'Room 2', is_overridden: true });
  });
});

describe('a classroom with no time zone', () => {
  it('keeps the UTC time of day, as it always did', async () => {
    settingsFindUnique.mockResolvedValue(null);

    const starts = (await occurrences(series())).map(o => o.start);

    expect(starts).toContain('2026-11-02T18:10:00.000Z');
  });
});

describe('the zone lookup', () => {
  it('is skipped when nothing recurs', async () => {
    calendarEventFindMany.mockResolvedValue([series({ is_recurring: false })]);

    await getClassroomCalendar(
      'class-1',
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-30T00:00:00Z')
    );

    expect(settingsFindUnique).not.toHaveBeenCalled();
  });
});
