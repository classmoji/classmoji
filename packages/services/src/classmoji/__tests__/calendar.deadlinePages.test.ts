/**
 * Pins the page/slide narrowing on the deadline leg of the calendar.
 *
 * `getDeadlinesForRange` attaches the pages and slides linked to an
 * assignment. Both are the same kind of resource here and both carry an
 * `is_draft` flag, so both relations key their filter off the same
 * `canSeeDrafts` option: the default (false) asks for published content only,
 * and the staff calendars, which pass true, keep the whole set.
 *
 * `canSeeDrafts` is deliberately NOT `includeUnpublished`. That one answers a
 * different question — whether an unpublished assignment gets a deadline of its
 * own — and the two are free to diverge even though every caller happens to
 * pass the same value for both today.
 *
 * The event-link leg goes through `mapLinksToDisplayFormat` instead; what it
 * shows whom is pinned in calendar.displayShape.test.ts.
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
      // `is_draft` is selected on both relations: a draft the viewer IS allowed
      // to see has to be shown as one, and that flag is what says so.
      include: { page: { select: { id: true, title: true, is_draft: true } } },
      orderBy: { order: 'asc' },
    });
    expect(include().slides.include).toEqual({
      slide: { select: { id: true, title: true, is_draft: true } },
    });
  });

  it('leaves both relations unfiltered for a viewer who may see drafts', async () => {
    // The admin and assistant calendars pass this; their view is unchanged.
    await getDeadlinesForRange('class-1', START, END, null, true, { canSeeDrafts: true });

    expect(include().pages.where).toBeUndefined();
    expect(include().slides.where).toBeUndefined();
  });

  it('still narrows both relations when only unpublished ASSIGNMENTS were asked for', async () => {
    // The two arguments answer different questions. Asking to see an
    // unpublished assignment's deadline says nothing about who may read the
    // draft material hanging off it, so that filter stays on.
    await getDeadlinesForRange('class-1', START, END, null, true);

    expect(include().pages.where).toEqual({ page: { is_draft: false } });
    expect(include().slides.where).toEqual({ slide: { is_draft: false } });
  });
});
