import { describe, it, expect, vi, beforeEach } from 'vitest';

const formFindMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    form: { findMany: formFindMany },
  }),
}));

const { getFormCloseEventsForRange } = await import('../calendar.service.ts');

const START = new Date('2026-09-01T00:00:00Z');
const END = new Date('2026-09-30T00:00:00Z');
const CLOSES_AT = new Date('2026-09-07T21:00:00Z');

const formRow = (over: Record<string, unknown> = {}) => ({
  id: 'form-1',
  title: 'CS98 Team Review',
  slug: 'cs98-team-review',
  description: 'Rate your teammates',
  status: 'OPEN',
  access: 'CLASSROOM',
  closes_at: CLOSES_AT,
  classroom: { slug: 'classmoji-dev-winter-2025' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAGES_URL = 'https://pages.example.test';
});

describe('getFormCloseEventsForRange', () => {
  it('synthesizes a deadline-shaped item for an OPEN form with a closes_at', async () => {
    formFindMany.mockResolvedValue([formRow()]);

    const [event] = await getFormCloseEventsForRange('class-1', START, END);

    expect(event).toMatchObject({
      id: 'form-close-form-1',
      // Reuses the synthetic DEADLINE literal so it lands in the existing
      // event-type filter and the ICS all-day branch.
      event_type: 'DEADLINE',
      title: 'CS98 Team Review closes',
      is_deadline: true,
      is_form_close: true,
      is_unpublished: false,
      form_id: 'form-1',
      form_slug: 'cs98-team-review',
      form_status: 'OPEN',
      form_access: 'CLASSROOM',
      github_issue_url: null,
    });
    expect(event.start_time).toEqual(CLOSES_AT);
    expect(event.end_time).toEqual(CLOSES_AT);
  });

  it('queries only OPEN and CLOSED forms with a closes_at inside the range', async () => {
    formFindMany.mockResolvedValue([]);

    await getFormCloseEventsForRange('class-1', START, END);

    expect(formFindMany).toHaveBeenCalledTimes(1);
    const where = formFindMany.mock.calls[0][0].where;
    expect(where.classroom_id).toBe('class-1');
    // DRAFT is excluded at the query, so a draft form never reaches any view.
    expect(where.status).toEqual({ in: ['OPEN', 'CLOSED'] });
    expect(where.closes_at).toEqual({ gte: START, lte: END });
  });

  it('keeps a CLOSED form on the calendar, reading its status honestly', async () => {
    formFindMany.mockResolvedValue([formRow({ status: 'CLOSED' })]);

    const [event] = await getFormCloseEventsForRange('class-1', START, END);

    expect(event.form_status).toBe('CLOSED');
    expect(event.title).toBe('CS98 Team Review closes');
  });

  it('points members at the fill page', async () => {
    formFindMany.mockResolvedValue([formRow()]);

    const [event] = await getFormCloseEventsForRange('class-1', START, END);

    expect(event.form_url).toBe(
      'https://pages.example.test/classmoji-dev-winter-2025/forms/cs98-team-review'
    );
  });

  it('points staff at the responses view instead', async () => {
    formFindMany.mockResolvedValue([formRow()]);

    const [event] = await getFormCloseEventsForRange('class-1', START, END, { forStaff: true });

    expect(event.form_url).toBe(
      'https://pages.example.test/classmoji-dev-winter-2025/forms/cs98-team-review/responses'
    );
  });

  it('falls back to a generic description when the form has none', async () => {
    formFindMany.mockResolvedValue([formRow({ description: null })]);

    const [event] = await getFormCloseEventsForRange('class-1', START, END);

    expect(event.description).toBe('Form');
  });

  it('returns nothing when no form closes in the range', async () => {
    formFindMany.mockResolvedValue([]);

    expect(await getFormCloseEventsForRange('class-1', START, END)).toEqual([]);
  });
});
