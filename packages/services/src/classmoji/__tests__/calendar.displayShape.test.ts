/**
 * Pins the shape of what `getClassroomCalendar` hands a caller, and which
 * linked content each kind of caller gets.
 *
 * The calendar builds its payload key by key from the stored row. Two things
 * follow, and both are asserted here rather than left to review:
 *   - the payload carries the display arrays and nothing else — the stored link
 *     relations and the override rows are inputs to the build, not part of its
 *     result;
 *   - the display arrays are filtered twice: to the occurrence being shown, and
 *     to what the viewer may see. `canSeeDrafts` is that second filter, and it
 *     defaults to false, so a caller that says nothing gets the published-only
 *     view.
 *
 * Prisma is mocked (factory idiom) so the shaping runs for real against
 * hand-built rows. The occurrence maths and the filters are pure functions of
 * those rows, which is exactly what a real database would not make clearer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calendarEventFindMany = vi.fn();
const assignmentFindMany = vi.fn();
const formFindMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    calendarEvent: { findMany: calendarEventFindMany },
    assignment: { findMany: assignmentFindMany },
    form: { findMany: formFindMany },
  }),
}));

const { getClassroomCalendar } = await import('../calendar.service.ts');

/** A Monday. The range below covers this occurrence and no other. */
const START = new Date('2026-09-20T00:00:00Z');
const END = new Date('2026-09-24T23:59:59Z');
const OCCURRENCE = new Date('2026-09-21T00:00:00Z');
/** The next Monday — outside the range, so nothing attached to it is loaded. */
const LATER_OCCURRENCE = new Date('2026-09-28T00:00:00Z');

/**
 * Titles that must never reach a viewer who may not see unpublished content.
 * All share a marker so one `JSON.stringify` sweep covers the lot.
 */
const DRAFT_PAGE_TITLE = 'WITHHELD draft page';
const DRAFT_DECK_TITLE = 'WITHHELD draft deck';
const UNPUBLISHED_ASSIGNMENT_TITLE = 'WITHHELD unpublished assignment';
const UNPUBLISHED_REPO_TITLE = 'WITHHELD unpublished repository';
const OTHER_DATE_PAGE_TITLE = 'WITHHELD next week only';

const pageLink = (
  id: string,
  title: string,
  is_draft: boolean,
  occurrence_date: Date | null = null,
  featured: boolean = false
) => ({
  id: `pl-${id}`,
  event_id: 'event-1',
  page_id: id,
  order: 0,
  created_at: new Date('2026-09-01T00:00:00Z'),
  occurrence_date,
  featured,
  page: { id, title, is_draft },
});

const slideLink = (
  id: string,
  title: string,
  is_draft: boolean,
  occurrence_date: Date | null = null,
  featured: boolean = false
) => ({
  id: `sl-${id}`,
  event_id: 'event-1',
  slide_id: id,
  order: 0,
  created_at: new Date('2026-09-01T00:00:00Z'),
  occurrence_date,
  featured,
  slide: { id, title, is_draft },
});

const assignmentLink = (
  id: string,
  title: string,
  {
    is_published = true,
    repo_published = true,
    repo_title = 'Published repository',
    occurrence_date = null as Date | null,
    featured = false,
  } = {}
) => ({
  id: `al-${id}`,
  event_id: 'event-1',
  assignment_id: id,
  order: 0,
  created_at: new Date('2026-09-01T00:00:00Z'),
  occurrence_date,
  featured,
  assignment: {
    id,
    title,
    slug: `${id}-slug`,
    is_published,
    repository: {
      id: `repo-${id}`,
      title: repo_title,
      slug: `repo-${id}`,
      is_published: repo_published,
    },
  },
});

/**
 * A stored row as the calendar query loads it — Prisma columns and all, so the
 * assertions below can tell "not shipped" from "not selected".
 */
const storedEvent = (over: Record<string, unknown> = {}) => ({
  id: 'event-1',
  classroom_id: 'class-1',
  created_by: 'owner-1',
  event_type: 'LECTURE',
  title: 'Lecture 1',
  description: 'Intro',
  start_time: new Date('2026-09-21T14:00:00Z'),
  end_time: new Date('2026-09-21T15:00:00Z'),
  location: 'ECSC 004',
  meeting_link: null,
  is_recurring: false,
  recurrence_rule: null,
  created_at: new Date('2026-09-01T00:00:00Z'),
  updated_at: new Date('2026-09-01T00:00:00Z'),
  creator: { id: 'owner-1', name: 'Prof', login: 'prof' },
  overrides: [],
  pageLinks: [
    pageLink('p-pub', 'Published page', false),
    pageLink('p-draft', DRAFT_PAGE_TITLE, true),
  ],
  slideLinks: [
    slideLink('s-pub', 'Published deck', false),
    slideLink('s-draft', DRAFT_DECK_TITLE, true),
  ],
  assignmentLinks: [
    assignmentLink('a-pub', 'Published assignment'),
    assignmentLink('a-unpub', UNPUBLISHED_ASSIGNMENT_TITLE, { is_published: false }),
    assignmentLink('a-unpub-repo', 'Assignment in an unpublished repository', {
      repo_published: false,
      repo_title: UNPUBLISHED_REPO_TITLE,
    }),
  ],
  ...over,
});

/** The first (and, in this range, only) expanded event item. */
const firstEvent = async (
  ...args: Parameters<typeof getClassroomCalendar> extends [
    infer _C,
    infer _S,
    infer _E,
    ...infer Rest,
  ]
    ? Rest
    : never
) => {
  const items = await getClassroomCalendar('class-1', START, END, ...args);
  // Read as a bag of keys on purpose: these assertions are about which keys
  // exist, which the declared shape would otherwise answer for us.
  return items[0] as unknown as Record<string, unknown>;
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAGES_URL = 'https://pages.example.test';
  calendarEventFindMany.mockResolvedValue([storedEvent()]);
  assignmentFindMany.mockResolvedValue([]);
  formFindMany.mockResolvedValue([]);
});

describe('getClassroomCalendar — the display payload', () => {
  it('carries only the display arrays, not the stored link rows behind them', async () => {
    const event = await firstEvent(null, false, false);

    for (const key of [
      'pageLinks',
      'slideLinks',
      'assignmentLinks',
      'overrides',
      '_rawPageLinks',
      '_rawSlideLinks',
      '_rawAssignmentLinks',
    ]) {
      expect(key in event).toBe(false);
    }
  });

  it('carries only the event columns the calendar renders', async () => {
    const event = await firstEvent(null, false, false);

    expect(Object.keys(event).sort()).toEqual(
      [
        'assignments',
        'created_by',
        'creator',
        'description',
        'end_time',
        'event_type',
        'featured_resource',
        'id',
        'is_overridden',
        'is_recurring',
        'location',
        'meeting_link',
        'pages',
        'recurrence_rule',
        'slides',
        'start_time',
        'title',
      ].sort()
    );
  });

  it('echoes the raw link rows back only when the caller asks for them', async () => {
    const event = await firstEvent(null, true, true, { canSeeDrafts: true });

    // Which resource, and which occurrence — what the edit modal reads, and
    // nothing else. The titles travel in the display arrays.
    // Which resource, which occurrence, and whether it is the starred one —
    // the three things the edit modal prefills from.
    expect(event._rawPageLinks).toEqual([
      { page_id: 'p-pub', occurrence_date: null, featured: false },
      { page_id: 'p-draft', occurrence_date: null, featured: false },
    ]);
    expect(event._rawSlideLinks).toEqual([
      { slide_id: 's-pub', occurrence_date: null, featured: false },
      { slide_id: 's-draft', occurrence_date: null, featured: false },
    ]);
    expect(event._rawAssignmentLinks).toEqual([
      { assignment_id: 'a-pub', occurrence_date: null, featured: false },
      { assignment_id: 'a-unpub', occurrence_date: null, featured: false },
      { assignment_id: 'a-unpub-repo', occurrence_date: null, featured: false },
    ]);
  });
});

describe('getClassroomCalendar — a caller who may not see unpublished content', () => {
  it('lists only published pages and decks', async () => {
    const event = await firstEvent(null, false, false);

    expect(event.pages).toEqual([
      { page: { id: 'p-pub', title: 'Published page', is_draft: false }, featured: false },
    ]);
    expect(event.slides).toEqual([
      { slide: { id: 's-pub', title: 'Published deck', is_draft: false }, featured: false },
    ]);
  });

  it('lists an assignment link only once the assignment AND its repository are published', async () => {
    const event = await firstEvent(null, false, false);

    expect(
      (event.assignments as Array<{ assignment: { id: string } }>).map(a => a.assignment.id)
    ).toEqual(['a-pub']);
  });

  it('names nothing unpublished anywhere in the payload', async () => {
    // A sweep of the WHOLE payload, not just the arrays checked above: a title
    // that reaches the caller through some other key is just as visible.
    const items = await getClassroomCalendar('class-1', START, END, null, false, false);

    const payload = JSON.stringify(items);
    expect(payload).not.toContain('WITHHELD');
    expect(payload).not.toContain(DRAFT_PAGE_TITLE);
    expect(payload).not.toContain(DRAFT_DECK_TITLE);
    expect(payload).not.toContain(UNPUBLISHED_ASSIGNMENT_TITLE);
    expect(payload).not.toContain(UNPUBLISHED_REPO_TITLE);
  });

  it('is what a caller that passes no options gets', async () => {
    // The default has to be the narrow one: a new caller that forgets the flag
    // must land on the published-only view, not the staff view.
    const items = await getClassroomCalendar('class-1', START, END);

    expect(JSON.stringify(items)).not.toContain('WITHHELD');
  });
});

describe('getClassroomCalendar — a caller who may see unpublished content', () => {
  const asStaff = () => firstEvent(null, false, true, { canSeeDrafts: true });

  it('lists a draft page and a draft deck, each flagged as one', async () => {
    const event = await asStaff();

    expect(event.pages).toEqual([
      { page: { id: 'p-pub', title: 'Published page', is_draft: false }, featured: false },
      { page: { id: 'p-draft', title: DRAFT_PAGE_TITLE, is_draft: true }, featured: false },
    ]);
    expect(event.slides).toEqual([
      { slide: { id: 's-pub', title: 'Published deck', is_draft: false }, featured: false },
      { slide: { id: 's-draft', title: DRAFT_DECK_TITLE, is_draft: true }, featured: false },
    ]);
  });

  it('lists the unpublished assignment links, with the flags that mark them', async () => {
    const event = await asStaff();
    const assignments = event.assignments as Array<{
      assignment: { id: string; title: string; is_published: boolean };
      repository: { is_published: boolean } | null;
    }>;

    expect(assignments.map(a => a.assignment.id)).toEqual(['a-pub', 'a-unpub', 'a-unpub-repo']);
    expect(assignments[1].assignment).toMatchObject({
      title: UNPUBLISHED_ASSIGNMENT_TITLE,
      is_published: false,
    });
    expect(assignments[2].assignment.is_published).toBe(true);
    expect(assignments[2].repository?.is_published).toBe(false);
  });
});

describe('getClassroomCalendar — links follow their occurrence', () => {
  const recurringEvent = () =>
    storedEvent({
      is_recurring: true,
      recurrence_rule: { days: ['monday'] },
      pageLinks: [
        pageLink('p-this', 'This week only', false, OCCURRENCE),
        pageLink('p-next', OTHER_DATE_PAGE_TITLE, false, LATER_OCCURRENCE),
        // Undated: written before the event became recurring. A recurring
        // occurrence has its own date, so this one is not its.
        pageLink('p-undated', 'WITHHELD undated link', false, null),
      ],
      slideLinks: [],
      assignmentLinks: [],
    });

  it('shows the resources linked to the occurrence being displayed', async () => {
    calendarEventFindMany.mockResolvedValue([recurringEvent()]);

    const event = await firstEvent(null, false, true, { canSeeDrafts: true });

    expect(event.pages).toEqual([
      { page: { id: 'p-this', title: 'This week only', is_draft: false }, featured: false },
    ]);
  });

  it('names no resource linked to another date, for a caller who may see drafts', async () => {
    // Nothing is being hidden for visibility here — the range simply does not
    // contain the date those links belong to.
    calendarEventFindMany.mockResolvedValue([recurringEvent()]);

    const items = await getClassroomCalendar('class-1', START, END, null, false, true, {
      canSeeDrafts: true,
    });

    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('WITHHELD');
    expect(JSON.stringify(items)).not.toContain(OTHER_DATE_PAGE_TITLE);
  });
});

describe('getClassroomCalendar — deadline items', () => {
  const deadlineAssignment = (over: Record<string, unknown> = {}) => ({
    id: 'assign-1',
    title: 'HW 1',
    is_published: true,
    student_deadline: new Date('2026-09-22T03:59:00Z'),
    repository: {
      id: 'repo-1',
      title: 'Homework',
      is_published: true,
      classroom: { git_organization: { login: 'cs52' } },
    },
    pages: [
      {
        id: 'ap-1',
        assignment_id: 'assign-1',
        page_id: 'p-guide',
        order: 0,
        page: { id: 'p-guide', title: 'HW 1 guide', is_draft: false },
      },
    ],
    slides: [],
    ...over,
  });

  it('builds its linked pages and decks entry by entry, carrying the draft flag', async () => {
    calendarEventFindMany.mockResolvedValue([]);
    assignmentFindMany.mockResolvedValue([deadlineAssignment()]);

    const [deadline] = (await getClassroomCalendar('class-1', START, END, null, false, true, {
      canSeeDrafts: true,
    })) as unknown as Array<Record<string, unknown>>;

    expect(deadline.pages).toEqual([
      { page: { id: 'p-guide', title: 'HW 1 guide', is_draft: false }, featured: false },
    ]);
    // The stored link row's own columns stay behind.
    expect(JSON.stringify(deadline.pages)).not.toContain('assignment_id');
  });

  it('has no starred resource, because nothing was linked to it to star', async () => {
    calendarEventFindMany.mockResolvedValue([]);
    assignmentFindMany.mockResolvedValue([deadlineAssignment()]);

    const [deadline] = (await getClassroomCalendar('class-1', START, END, null, false, true, {
      canSeeDrafts: true,
    })) as unknown as Array<Record<string, unknown>>;

    // Declared null rather than absent: a grid reading this key across the
    // union of item kinds has to find it on every one of them.
    expect('featured_resource' in deadline).toBe(true);
    expect(deadline.featured_resource).toBeNull();
  });

  it('says the same about a form close', async () => {
    calendarEventFindMany.mockResolvedValue([]);
    assignmentFindMany.mockResolvedValue([]);
    formFindMany.mockResolvedValue([
      {
        id: 'form-1',
        title: 'Week 1 survey',
        slug: 'week-1-survey',
        description: null,
        status: 'OPEN',
        access: 'CLASS',
        closes_at: new Date('2026-09-23T03:59:00Z'),
        classroom: { slug: 'cs52-26f' },
      },
    ]);

    const [formClose] = (await getClassroomCalendar('class-1', START, END)) as unknown as Array<
      Record<string, unknown>
    >;

    expect('featured_resource' in formClose).toBe(true);
    expect(formClose.featured_resource).toBeNull();
  });
});

describe('getClassroomCalendar — the starred resource', () => {
  /** The starred resource on the first item. */
  const featuredOf = async (
    ...args: Parameters<typeof firstEvent>
  ): Promise<Record<string, unknown> | null> =>
    (await firstEvent(...args)).featured_resource as Record<string, unknown> | null;

  it('is null when nothing is starred', async () => {
    expect(await featuredOf(null, false, true, { canSeeDrafts: true })).toBeNull();
  });

  it('names the starred page, with the flag the Draft treatment reads', async () => {
    calendarEventFindMany.mockResolvedValue([
      storedEvent({
        pageLinks: [
          pageLink('p-pub', 'Published page', false),
          pageLink('p-star', 'The one for today', false, null, true),
        ],
        slideLinks: [],
        assignmentLinks: [],
      }),
    ]);

    expect(await featuredOf(null, false, true, { canSeeDrafts: true })).toEqual({
      kind: 'page',
      id: 'p-star',
      title: 'The one for today',
      is_draft: false,
    });
  });

  it('names a starred deck as a deck', async () => {
    calendarEventFindMany.mockResolvedValue([
      storedEvent({
        pageLinks: [pageLink('p-pub', 'Published page', false)],
        slideLinks: [slideLink('s-star', 'Today’s deck', false, null, true)],
        assignmentLinks: [],
      }),
    ]);

    expect(await featuredOf(null, false, true, { canSeeDrafts: true })).toEqual({
      kind: 'slide',
      id: 's-star',
      title: 'Today’s deck',
      is_draft: false,
    });
  });

  it('calls a starred assignment a draft while its repository is unpublished', async () => {
    // The pair the link list marks together: the class cannot see this one
    // either way, and only staff are being shown it at all.
    calendarEventFindMany.mockResolvedValue([
      storedEvent({
        pageLinks: [],
        slideLinks: [],
        assignmentLinks: [
          assignmentLink('a-star', 'Lab 3', {
            repo_published: false,
            repo_title: UNPUBLISHED_REPO_TITLE,
            featured: true,
          }),
        ],
      }),
    ]);

    expect(await featuredOf(null, false, true, { canSeeDrafts: true })).toEqual({
      kind: 'assignment',
      id: 'a-star',
      title: 'Lab 3',
      is_draft: true,
    });
  });

  describe('when the starred resource is a draft', () => {
    const withStarredDraft = () =>
      calendarEventFindMany.mockResolvedValue([
        storedEvent({
          pageLinks: [
            pageLink('p-pub', 'Published page', false),
            pageLink('p-draft', DRAFT_PAGE_TITLE, true, null, true),
          ],
          slideLinks: [],
          assignmentLinks: [],
        }),
      ]);

    it('staff are shown it, flagged as a draft', async () => {
      withStarredDraft();

      expect(await featuredOf(null, false, true, { canSeeDrafts: true })).toEqual({
        kind: 'page',
        id: 'p-draft',
        title: DRAFT_PAGE_TITLE,
        is_draft: true,
      });
    });

    it('a student is shown nothing, and is not fallen back to another link', async () => {
      // Not "the next best link": the instructor starred one thing, the class
      // is not meant to see it yet, so the month cell says nothing — exactly
      // what an event nobody starred looks like.
      withStarredDraft();

      expect(await featuredOf(null, false, false)).toBeNull();
    });

    it('a student is not told a draft is starred, anywhere in the payload', async () => {
      withStarredDraft();

      const items = await getClassroomCalendar('class-1', START, END, null, false, false);
      const payload = JSON.stringify(items);

      expect(payload).not.toContain('WITHHELD');
      expect(payload).not.toContain(DRAFT_PAGE_TITLE);
      expect(payload).not.toContain('p-draft');
    });
  });

  it('prefers the dated star when an event surfaces both buckets', async () => {
    // A NON-recurring event reads its undated links AND any dated link on its
    // own date — a series flattened back to one event has both. The dated row
    // was written against the date being shown, so it wins; without a rule the
    // answer would follow row order.
    calendarEventFindMany.mockResolvedValue([
      storedEvent({
        pageLinks: [
          pageLink('p-undated', 'Undated star', false, null, true),
          pageLink('p-dated', 'Dated star', false, new Date('2026-09-21T00:00:00Z'), true),
        ],
        slideLinks: [],
        assignmentLinks: [],
      }),
    ]);

    expect(await featuredOf(null, false, true, { canSeeDrafts: true })).toMatchObject({
      id: 'p-dated',
    });
  });
});
