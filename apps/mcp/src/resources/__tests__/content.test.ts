/**
 * Unit tests for the quizzes resource Pro gate (finding A3) and the calendar
 * resource's allowlist shaping (finding U5).
 *
 * A3 (SUPERSEDED TWICE — kept as the history of why this looks the way it does):
 * assertProTier used to resolve the subscription by BARE slug, guarded by a
 * re-resolution that refused when the slug landed on a different classroom than
 * the caller was authorized for. The premise was that slugs were unique only
 * per git org; they have been GLOBALLY unique since the
 * 20260818103726_classroom_slug_global_unique migration, so the guard could
 * never fire, and the gate was rewritten to take the authorized `classroomId`.
 * That version was this app's OWN copy of a platform-wide rule; it is now
 * retired. `@classmoji/auth/server`'s lifted `assertProTier` is the single
 * implementation (webapp, apps/pages' forms subtree, this server), and
 * ../../authz/proTier.ts only translates its thrown 403 Response into a
 * ToolError. What "Pro" means — tier plus the `ends_at` activity test — is
 * pinned once, in packages/auth/src/__tests__/proTier.test.ts.
 *
 * So the tests below pin what is still THIS app's to get right: the gate is
 * asked about the AUTHORIZED classroom (its slug, off the resolved context) and
 * never about the URI's slug; a 403 becomes a `forbidden` ToolError before any
 * quiz data is read; and a NON-Response failure is not laundered into
 * "you need Pro".
 *
 * U5: the calendar resource emits an explicit allowlist rather than the service
 * row it was handed. Two things are pinned below: the allowlist names the keys
 * that may leave this server, and it re-applies the staff-only rule to the
 * linked content it emits — so a row arriving with a draft page, a draft deck
 * or an unpublished assignment still yields a student payload without them.
 * The service is told which viewer it is answering (`canSeeDrafts`), and that
 * wiring is asserted here too; what the service does with it is pinned in
 * packages/services/…/calendar.displayShape.test.ts.
 *
 * `@classmoji/services` is mocked (factory idiom) so the guard/shaping
 * decisions run for real against hand-built rows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../mcp/errors.ts';
import type { ToolContext } from '../../mcp/registry.ts';

const findBySlug = vi.fn();
const assertProTier = vi.fn();
const findByClassroom = vi.fn();
const getQuizzesForStudent = vi.fn();
const getClassroomCalendar = vi.fn();

/** The lifted platform gate the wrapper delegates to (see the module note). */
vi.mock('@classmoji/auth/server', () => ({
  assertProTier: (...a: unknown[]) => assertProTier(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { findBySlug: (...a: unknown[]) => findBySlug(...a) },
    quiz: {
      findByClassroom: (...a: unknown[]) => findByClassroom(...a),
      getQuizzesForStudent: (...a: unknown[]) => getQuizzesForStudent(...a),
    },
    calendar: { getClassroomCalendar: (...a: unknown[]) => getClassroomCalendar(...a) },
  },
}));

const { calendarResource, calendarRangeResource, quizzesResource } = await import('../content.ts');

const VARS = { org: 'twin-org', slug: 'winter-2025' };

/**
 * ToolContext for an OWNER authorized in classroom `class-1`, whose OWN slug is
 * `authorized-slug` — deliberately different from the URI's `winter-2025`, so
 * "gates on the authorized classroom, never on the URI" is a sharp assertion.
 */
function ownerCtx(settings: Record<string, unknown> = {}): ToolContext {
  return {
    viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: 'class-1',
      role: 'OWNER',
      status: 'ACTIVE',
      membership: { id: 'm-1', role: 'OWNER' },
      classroom: { slug: 'authorized-slug', settings },
    },
  } as unknown as ToolContext;
}

/** ToolContext for a STUDENT authorized in classroom `class-1`. */
function studentCtx(): ToolContext {
  return {
    viewer: { userId: 'student-1', clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: 'class-1',
      role: 'STUDENT',
      status: 'ACTIVE',
      membership: { id: 'm-2', role: 'STUDENT' },
      classroom: { settings: {} },
    },
  } as unknown as ToolContext;
}

beforeEach(() => {
  findBySlug.mockReset();
  assertProTier.mockReset();
  assertProTier.mockResolvedValue(undefined);
  findByClassroom.mockReset();
  getQuizzesForStudent.mockReset();
  getClassroomCalendar.mockReset();
});

describe('quizzes resource Pro gate (A3)', () => {
  it('gates on the AUTHORIZED classroom, never on the URI slug', async () => {
    // The URI names `winter-2025`; the authorized context's own slug is
    // `authorized-slug`. The gate must be asked about the latter, and the
    // resource must not re-resolve the URI's slug at all.
    findByClassroom.mockResolvedValue([
      { id: 'q1', name: 'Quiz 1', status: 'PUBLISHED', weight: 1, question_count: 3 },
    ]);

    const result = (await quizzesResource.handler(
      VARS,
      ownerCtx({ quizzes_enabled: true }),
      new URL('classmoji://x')
    )) as { quizzes: Array<{ id: string }> };

    expect(assertProTier).toHaveBeenCalledWith('authorized-slug');
    expect(assertProTier).not.toHaveBeenCalledWith('winter-2025');
    expect(findBySlug).not.toHaveBeenCalled();
    expect(findByClassroom).toHaveBeenCalledWith('class-1', expect.anything());
    expect(result.quizzes.map(q => q.id)).toEqual(['q1']);
  });

  it('turns the gate’s 403 into a forbidden ToolError before touching quiz data', async () => {
    // The lifted helper's refusal shape. Whether the row was FREE or a lapsed
    // {tier:'PRO', ends_at: past} is decided there, not here.
    assertProTier.mockRejectedValue(
      new Response('This feature requires a Pro subscription', { status: 403 })
    );

    const err = await quizzesResource
      .handler(VARS, ownerCtx({ quizzes_enabled: true }), new URL('classmoji://x'))
      .catch(e => e);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('forbidden');
    expect((err as ToolError).message).toBe('This feature requires a Pro subscription');
    expect(findByClassroom).not.toHaveBeenCalled();
  });

  it('does NOT launder a non-Response failure into "you need Pro"', async () => {
    // A database outage inside the gate must surface as itself. Translating
    // every throw into `forbidden` would tell an owner their subscription had
    // lapsed when it had not.
    assertProTier.mockRejectedValue(new Error('connection reset'));

    const err = await quizzesResource
      .handler(VARS, ownerCtx({ quizzes_enabled: true }), new URL('classmoji://x'))
      .catch(e => e);

    expect(err).not.toBeInstanceOf(ToolError);
    expect((err as Error).message).toBe('connection reset');
    expect(findByClassroom).not.toHaveBeenCalled();
  });
});

describe('calendar resource allowlist shaping (U5)', () => {
  /**
   * An expanded-event row, deliberately built with MORE on it than the service
   * sends today — the stored link relations and the override rows alongside the
   * display arrays. The allowlist has to name what it emits, so nothing here
   * reaches the payload merely by being present on the row.
   */
  const RAW_EVENT = {
    id: 'event-1',
    classroom_id: 'class-1',
    created_by: 'owner-1',
    event_type: 'LECTURE',
    title: 'Lecture 1',
    description: 'intro',
    start_time: '2026-07-20T10:00:00.000Z',
    end_time: '2026-07-20T11:00:00.000Z',
    location: null,
    meeting_link: null,
    is_recurring: false,
    recurrence_rule: null,
    creator: { id: 'owner-1', name: 'Prof', login: 'prof' },
    overrides: [],
    pageLinks: [
      { page: { id: 'p-draft', title: 'SECRET Draft Page', is_draft: true } },
      { page: { id: 'p-pub', title: 'Published Page', is_draft: false } },
    ],
    slideLinks: [{ slide: { id: 's-draft', title: 'SECRET Draft Deck', is_draft: true } }],
    assignmentLinks: [],
    // Display-mapped arrays (already draft-filtered by the service).
    pages: [{ page: { id: 'p-pub', title: 'Published Page', is_draft: false } }],
    slides: [],
    assignments: [],
  };

  it('emits only the allowlisted keys, and no draft titles, for a student', async () => {
    getClassroomCalendar.mockResolvedValue([RAW_EVENT]);

    const result = (await calendarResource.handler(
      { org: 'o', slug: 's' },
      studentCtx(),
      new URL('classmoji://x')
    )) as { events: Array<Record<string, unknown>> };

    // No unpublished linked-content title anywhere in the payload.
    expect(JSON.stringify(result)).not.toContain('SECRET');
    const [event] = result.events;
    // Service-side internals are not part of the allowlist.
    for (const internal of ['pageLinks', 'slideLinks', 'assignmentLinks', 'overrides']) {
      expect(event).not.toHaveProperty(internal);
    }
    // …while the published display content survives, with no publication
    // flags on it: nothing a student receives here is unpublished, so the flag
    // would be a constant.
    expect(event.pages).toEqual([{ id: 'p-pub', title: 'Published Page' }]);
    expect(event.title).toBe('Lecture 1');
    expect(event.creator).toEqual({ id: 'owner-1', name: 'Prof', login: 'prof' });
  });

  it('tells the service which viewer it is answering', async () => {
    // The service builds its display arrays for that viewer; this resource then
    // narrows again. Both passes have to agree about who is asking.
    getClassroomCalendar.mockResolvedValue([]);

    await calendarResource.handler({ org: 'o', slug: 's' }, studentCtx(), new URL('classmoji://x'));
    expect(getClassroomCalendar).toHaveBeenLastCalledWith(
      'class-1',
      expect.any(Date),
      expect.any(Date),
      'student-1',
      false,
      false,
      { canSeeDrafts: false }
    );

    await calendarResource.handler({ org: 'o', slug: 's' }, ownerCtx(), new URL('classmoji://x'));
    expect(getClassroomCalendar).toHaveBeenLastCalledWith(
      'class-1',
      expect.any(Date),
      expect.any(Date),
      null,
      false,
      true,
      { canSeeDrafts: true }
    );
  });

  it('drops an unpublished assignment link for a student and keeps it for staff', async () => {
    const rows = [
      {
        ...RAW_EVENT,
        assignments: [
          {
            assignment: { id: 'a-pub', title: 'Published HW', slug: 'hw', is_published: true },
            repository: { id: 'r1', title: 'Homework', slug: 'hw', is_published: true },
          },
          {
            assignment: {
              id: 'a-draft',
              title: 'SECRET Unpublished HW',
              slug: 'hw2',
              is_published: false,
            },
            repository: { id: 'r1', title: 'Homework', slug: 'hw', is_published: true },
          },
        ],
      },
    ];

    getClassroomCalendar.mockResolvedValue(rows);
    const studentResult = (await calendarResource.handler(
      { org: 'o', slug: 's' },
      studentCtx(),
      new URL('classmoji://x')
    )) as { events: Array<{ assignments: Array<{ assignment: { id: string } }> }> };

    expect(studentResult.events[0].assignments.map(a => a.assignment.id)).toEqual(['a-pub']);
    expect(JSON.stringify(studentResult)).not.toContain('SECRET');

    getClassroomCalendar.mockResolvedValue(rows);
    const staffResult = (await calendarResource.handler(
      { org: 'o', slug: 's' },
      ownerCtx(),
      new URL('classmoji://x')
    )) as { events: Array<{ assignments: Array<{ assignment: { id: string } }> }> };

    expect(staffResult.events[0].assignments.map(a => a.assignment.id)).toEqual([
      'a-pub',
      'a-draft',
    ]);
  });

  it('defensively drops draft-flagged display entries for students', async () => {
    // Should the service ever hand a draft through the display arrays, the
    // resource-side allowlist still filters it for non-staff.
    getClassroomCalendar.mockResolvedValue([
      {
        ...RAW_EVENT,
        pages: [
          { page: { id: 'p-draft', title: 'SECRET Draft Page', is_draft: true } },
          { page: { id: 'p-pub', title: 'Published Page', is_draft: false } },
        ],
      },
    ]);

    const result = (await calendarResource.handler(
      { org: 'o', slug: 's' },
      studentCtx(),
      new URL('classmoji://x')
    )) as { events: Array<{ pages: Array<{ id: string }> }> };

    expect(result.events[0].pages.map(p => p.id)).toEqual(['p-pub']);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('gives staff the flags that say what the class cannot see yet', async () => {
    // A title on its own does not tell a teacher the page is still a draft.
    // The web calendar marks those with a Draft pill; a read through here has
    // to carry the same fact, or the tool shows staff content they cannot tell
    // apart from published material.
    getClassroomCalendar.mockResolvedValue([
      {
        ...RAW_EVENT,
        pages: [
          { page: { id: 'p-draft', title: 'Draft Page', is_draft: true } },
          { page: { id: 'p-pub', title: 'Published Page', is_draft: false } },
        ],
        slides: [{ slide: { id: 's-draft', title: 'Draft Deck', is_draft: true } }],
        assignments: [
          {
            assignment: { id: 'a-1', title: 'HW 1', slug: 'hw-1', is_published: false },
            repository: { id: 'r-1', title: 'Homework', slug: 'hw', is_published: true },
          },
        ],
      },
    ]);

    const result = (await calendarResource.handler(
      { org: 'o', slug: 's' },
      ownerCtx(),
      new URL('classmoji://x')
    )) as {
      events: Array<{
        pages: Array<Record<string, unknown>>;
        slides: Array<Record<string, unknown>>;
        assignments: Array<{
          assignment: Record<string, unknown>;
          repository: Record<string, unknown> | null;
        }>;
      }>;
    };

    const [event] = result.events;
    expect(event.pages).toEqual([
      { id: 'p-draft', title: 'Draft Page', is_draft: true },
      { id: 'p-pub', title: 'Published Page', is_draft: false },
    ]);
    expect(event.slides).toEqual([{ id: 's-draft', title: 'Draft Deck', is_draft: true }]);
    expect(event.assignments[0].assignment).toMatchObject({ id: 'a-1', is_published: false });
    expect(event.assignments[0].repository).toMatchObject({ id: 'r-1', is_published: true });
  });

  it('leaves those flags off a student payload', async () => {
    getClassroomCalendar.mockResolvedValue([RAW_EVENT]);

    const result = (await calendarResource.handler(
      { org: 'o', slug: 's' },
      studentCtx(),
      new URL('classmoji://x')
    )) as { events: Array<{ pages: Array<Record<string, unknown>> }> };

    expect('is_draft' in result.events[0].pages[0]).toBe(false);
  });

  it('keeps deadline fields on the allowlist and shapes deadline rows too', async () => {
    getClassroomCalendar.mockResolvedValue([
      {
        id: 'deadline-a1',
        event_type: 'DEADLINE',
        title: 'Due: HW 1',
        description: 'hello-world',
        start_time: '2026-07-22T04:59:00.000Z',
        end_time: '2026-07-22T04:59:00.000Z',
        is_deadline: true,
        is_unpublished: false,
        assignment_id: 'a1',
        repository_id: 'r1',
        github_issue_url: 'https://github.com/org/repo/issues/1',
        pages: [{ page: { id: 'p1', title: 'HW 1 Guide' } }],
        slides: [],
      },
    ]);

    const result = (await calendarResource.handler(
      { org: 'o', slug: 's' },
      studentCtx(),
      new URL('classmoji://x')
    )) as { events: Array<Record<string, unknown>> };

    const [deadline] = result.events;
    expect(deadline.is_deadline).toBe(true);
    expect(deadline.assignment_id).toBe('a1');
    expect(deadline.github_issue_url).toBe('https://github.com/org/repo/issues/1');
    expect(deadline.pages).toEqual([{ id: 'p1', title: 'HW 1 Guide' }]);
    // Admin-styling flag is staff-only.
    expect(deadline).not.toHaveProperty('is_unpublished');
    // A deadline links nothing, so there is nothing to star.
    expect(deadline.featured_resource).toBeNull();
  });

  describe('the starred resource', () => {
    const starring = (featured: Record<string, unknown> | null) => [
      { ...RAW_EVENT, featured_resource: featured },
    ];

    const shape = async (ctx: ReturnType<typeof studentCtx>) =>
      (
        (await calendarResource.handler(
          { org: 'o', slug: 's' },
          ctx,
          new URL('classmoji://x')
        )) as {
          events: Array<Record<string, unknown>>;
        }
      ).events[0];

    it('is null when the event has none', async () => {
      getClassroomCalendar.mockResolvedValue(starring(null));

      expect((await shape(studentCtx())).featured_resource).toBeNull();
    });

    it('names it for a student, without a publication flag', async () => {
      getClassroomCalendar.mockResolvedValue(
        starring({ kind: 'page', id: 'p-pub', title: 'Published Page', is_draft: false })
      );

      expect((await shape(studentCtx())).featured_resource).toEqual({
        kind: 'page',
        id: 'p-pub',
        title: 'Published Page',
      });
    });

    it('names it for staff, with the flag that says the class cannot see it', async () => {
      getClassroomCalendar.mockResolvedValue(
        starring({ kind: 'slide', id: 's-draft', title: 'Draft Deck', is_draft: true })
      );

      expect((await shape(ownerCtx())).featured_resource).toEqual({
        kind: 'slide',
        id: 's-draft',
        title: 'Draft Deck',
        is_draft: true,
      });
    });

    it('withholds a draft one from a student even if the service sends it', async () => {
      // The service already answers null there. This is the second,
      // independent pass — the same belt this file applies to the display
      // arrays above.
      getClassroomCalendar.mockResolvedValue(
        starring({ kind: 'page', id: 'p-draft', title: 'SECRET Draft Page', is_draft: true })
      );

      const event = await shape(studentCtx());
      expect(event.featured_resource).toBeNull();
      expect(JSON.stringify(event)).not.toContain('SECRET');
    });
  });
});

describe('calendar windows are whole days in the classroom zone', () => {
  function nyStudentCtx(): ToolContext {
    const ctx = studentCtx();
    Object.assign(ctx.classroom as object, {
      timezone: 'America/New_York',
      effectiveTimezone: { timeZone: 'America/New_York', source: 'classroom' },
    });
    return ctx;
  }

  function lastWindow(): { start: string; end: string } {
    const [, start, end] = getClassroomCalendar.mock.lastCall as [string, Date, Date];
    return { start: start.toISOString(), end: end.toISOString() };
  }

  it('reads a Mon-Sun range as New York days, so Sun 11:59 PM EDT is inside', async () => {
    getClassroomCalendar.mockResolvedValue([]);
    const result = (await calendarRangeResource.handler(
      { org: 'o', slug: 's', start: '2026-09-21', end: '2026-09-27' },
      nyStudentCtx(),
      new URL('classmoji://x')
    )) as { range: { start: string; end: string } };

    // Lab2 is due 2026-09-28T03:59Z; a UTC-day window ending Sep 27 missed it.
    expect(lastWindow()).toEqual({
      start: '2026-09-21T04:00:00.000Z',
      end: '2026-09-28T03:59:59.999Z',
    });
    expect(result.range).toEqual(lastWindow());
  });

  it('keeps plain UTC days when the classroom has no zone', async () => {
    getClassroomCalendar.mockResolvedValue([]);
    await calendarRangeResource.handler(
      { org: 'o', slug: 's', start: '2026-09-21', end: '2026-09-27' },
      studentCtx(),
      new URL('classmoji://x')
    );
    expect(lastWindow()).toEqual({
      start: '2026-09-21T00:00:00.000Z',
      end: '2026-09-27T23:59:59.999Z',
    });
  });

  it('still refuses a reversed range', async () => {
    await expect(
      calendarRangeResource.handler(
        { org: 'o', slug: 's', start: '2026-09-27', end: '2026-09-21' },
        nyStudentCtx(),
        new URL('classmoji://x')
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
  });

  it('anchors the default month on the class calendar, not UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Sep 30, 10 PM EDT: already October in UTC, still September in class.
      vi.setSystemTime(new Date('2026-10-01T02:00:00Z'));
      getClassroomCalendar.mockResolvedValue([]);
      await calendarResource.handler(
        { org: 'o', slug: 's' },
        nyStudentCtx(),
        new URL('classmoji://x')
      );
      expect(lastWindow()).toEqual({
        start: '2026-08-29T04:00:00.000Z',
        end: '2026-10-05T03:59:59.999Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('calendar windows follow the caller zone when the classroom has none', () => {
  it('uses a caller-supplied zone (Ask Moji) for the day boundaries', async () => {
    const ctx = studentCtx();
    Object.assign(ctx.classroom as object, {
      timezone: null,
      effectiveTimezone: { timeZone: 'America/New_York', source: 'caller' },
    });
    getClassroomCalendar.mockResolvedValue([]);
    await calendarRangeResource.handler(
      { org: 'o', slug: 's', start: '2026-09-21', end: '2026-09-27' },
      ctx,
      new URL('classmoji://x')
    );
    const [, start, end] = getClassroomCalendar.mock.lastCall as [string, Date, Date];
    expect(start.toISOString()).toBe('2026-09-21T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-28T03:59:59.999Z');
  });
});
