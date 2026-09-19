/**
 * Pins the page/slide narrowing on the deadline leg of the calendar.
 *
 * `getDeadlinesForRange` attaches the pages and slides linked to an
 * assignment. Both are the same kind of resource here and both carry an
 * `is_draft` flag, so both relations key their filter off the same
 * `includeUnpublished` argument: the default (false) asks for published
 * content only, and the staff calendars, which pass true, keep the whole set.
 *
 * The event-link leg goes through `mapLinksToDisplayFormat` instead, which
 * does its own draft filtering, and is not covered here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const assignmentFindMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    assignment: { findMany: assignmentFindMany },
  }),
}));

const { getDeadlinesForRange } = await import('../calendar.service.ts');

const START = new Date('2026-09-01T00:00:00Z');
const END = new Date('2026-09-30T00:00:00Z');

/** The relation nodes the query asked for. */
const include = () => assignmentFindMany.mock.calls[0][0].include;

beforeEach(() => {
  vi.clearAllMocks();
  assignmentFindMany.mockResolvedValue([]);
});

describe('getDeadlinesForRange', () => {
  it('asks for published pages and slides alike by default', async () => {
    await getDeadlinesForRange('class-1', START, END);

    expect(include().pages.where).toEqual({ page: { is_draft: false } });
    expect(include().slides.where).toEqual({ slide: { is_draft: false } });
  });

  it('keeps the ordering and the linked row alongside the filter', async () => {
    await getDeadlinesForRange('class-1', START, END);

    expect(include().pages).toEqual({
      where: { page: { is_draft: false } },
      include: { page: { select: { id: true, title: true } } },
      orderBy: { order: 'asc' },
    });
  });

  it('leaves both relations unfiltered when unpublished content is requested', async () => {
    // The admin and assistant calendars pass this; their view is unchanged.
    await getDeadlinesForRange('class-1', START, END, null, true);

    expect(include().pages.where).toBeUndefined();
    expect(include().slides.where).toBeUndefined();
  });
});
