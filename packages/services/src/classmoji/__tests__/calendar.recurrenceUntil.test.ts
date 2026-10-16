/**
 * `recurrence_rule.until` is inclusive when it is a date ("until Nov 16" keeps
 * the Nov 16 meeting), and a this_and_future truncation stores a date too, so
 * the field has one shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calendarEventFindMany = vi.fn();

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({
    calendarEvent: { findMany: calendarEventFindMany },
    assignment: { findMany: vi.fn().mockResolvedValue([]) },
    form: { findMany: vi.fn().mockResolvedValue([]) },
  }),
}));

const { getClassroomCalendar } = await import('../calendar.service.ts');

/** Mon/Wed/Fri 14:10 EDT, starting Mon Nov 9 2026. */
const mwf = (until: string) => ({
  id: 'event-1',
  classroom_id: 'class-1',
  created_by: 'owner-1',
  event_type: 'LECTURE',
  title: 'Class',
  description: null,
  start_time: new Date('2026-11-09T19:10:00Z'),
  end_time: new Date('2026-11-09T20:15:00Z'),
  location: null,
  meeting_link: null,
  is_recurring: true,
  recurrence_rule: { days: ['monday', 'wednesday', 'friday'], until },
  created_at: new Date('2026-09-01T00:00:00Z'),
  updated_at: new Date('2026-09-01T00:00:00Z'),
  creator: { id: 'owner-1', name: 'Prof', accounts: [] },
  overrides: [],
  pageLinks: [],
  slideLinks: [],
  assignmentLinks: [],
});

const days = async (until: string) => {
  calendarEventFindMany.mockResolvedValue([mwf(until)]);
  const items = await getClassroomCalendar(
    'class-1',
    new Date('2026-11-01T00:00:00Z'),
    new Date('2026-11-30T00:00:00Z')
  );
  return items.map(item => new Date(item.start_time).toISOString().slice(0, 10));
};

beforeEach(() => vi.clearAllMocks());

describe('recurrence_rule.until', () => {
  it('includes an occurrence that falls on a date-only until', async () => {
    expect(await days('2026-11-16')).toEqual([
      '2026-11-09',
      '2026-11-11',
      '2026-11-13',
      '2026-11-16',
    ]);
  });

  it('still stops after a date-only until that is not a meeting day', async () => {
    expect(await days('2026-11-12')).toEqual(['2026-11-09', '2026-11-11']);
  });

  it('keeps honouring a full datetime until', async () => {
    expect(await days('2026-11-13T18:00:00.000Z')).toEqual(['2026-11-09', '2026-11-11']);
  });
});
