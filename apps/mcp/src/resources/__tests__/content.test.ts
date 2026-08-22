/**
 * Unit tests for the quizzes resource Pro gate (finding A3) and the calendar
 * resource's allowlist shaping (finding U5).
 *
 * A3 (SUPERSEDED — kept as the history of why this looks the way it does):
 * assertProTier used to resolve the subscription by BARE slug, guarded by a
 * re-resolution that refused when the slug landed on a different classroom than
 * the caller was authorized for. The premise was that slugs were unique only
 * per git org; they have been GLOBALLY unique since the
 * 20260818103726_classroom_slug_global_unique migration, so the guard could
 * never fire. The gate now takes the AUTHORIZED `classroomId` straight from the
 * tool context and asks `subscription.getProStateForClassroomId`, which is also
 * the single owner of the `ends_at` activity test. The tests below pin what
 * actually matters now: the gate keys on the authorized id and never on the
 * URI's slug, and a lapsed PRO row does not open it.
 *
 * U5: calendar.getClassroomCalendar rows spread `...event`, carrying the raw
 * pageLinks/slideLinks include (UNFILTERED — draft page/slide titles) plus
 * overrides. The resource must emit an explicit allowlist so students never
 * receive draft/unpublished linked-content titles.
 *
 * `@classmoji/services` is mocked (factory idiom) so the guard/shaping
 * decisions run for real against hand-built rows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../mcp/errors.ts';
import type { ToolContext } from '../../mcp/registry.ts';

const findBySlug = vi.fn();
const getProStateForClassroomId = vi.fn();
const findByClassroom = vi.fn();
const getQuizzesForStudent = vi.fn();
const getClassroomCalendar = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { findBySlug: (...a: unknown[]) => findBySlug(...a) },
    subscription: {
      getProStateForClassroomId: (...a: unknown[]) => getProStateForClassroomId(...a),
    },
    quiz: {
      findByClassroom: (...a: unknown[]) => findByClassroom(...a),
      getQuizzesForStudent: (...a: unknown[]) => getQuizzesForStudent(...a),
    },
    calendar: { getClassroomCalendar: (...a: unknown[]) => getClassroomCalendar(...a) },
  },
}));

const { calendarResource, quizzesResource } = await import('../content.ts');

const VARS = { org: 'twin-org', slug: 'winter-2025' };

/** ToolContext for an OWNER authorized in classroom `class-1`. */
function ownerCtx(settings: Record<string, unknown> = {}): ToolContext {
  return {
    viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: 'class-1',
      role: 'OWNER',
      status: 'ACTIVE',
      membership: { id: 'm-1', role: 'OWNER' },
      classroom: { settings },
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
  getProStateForClassroomId.mockReset();
  findByClassroom.mockReset();
  getQuizzesForStudent.mockReset();
  getClassroomCalendar.mockReset();
});

describe('quizzes resource Pro gate (A3)', () => {
  it('gates on the AUTHORIZED classroom id, never on the URI slug', async () => {
    // The URI names `winter-2025`; the authorized context names `class-1`. The
    // gate must ask about class-1 and must not re-resolve the slug at all —
    // that round trip was the twin guard, and it is gone.
    getProStateForClassroomId.mockResolvedValue({
      tier: 'PRO',
      isActive: true,
      isPro: true,
      subscription: { id: 'sub-pro' },
    });
    findByClassroom.mockResolvedValue([
      { id: 'q1', name: 'Quiz 1', status: 'PUBLISHED', weight: 1, question_count: 3 },
    ]);

    const result = (await quizzesResource.handler(
      VARS,
      ownerCtx({ quizzes_enabled: true }),
      new URL('classmoji://x')
    )) as { quizzes: Array<{ id: string }> };

    expect(getProStateForClassroomId).toHaveBeenCalledWith('class-1');
    expect(findBySlug).not.toHaveBeenCalled();
    expect(findByClassroom).toHaveBeenCalledWith('class-1', expect.anything());
    expect(result.quizzes.map(q => q.id)).toEqual(['q1']);
  });

  it('REFUSES a lapsed PRO row before touching any quiz data', async () => {
    // {tier:'PRO', ends_at: past} is a real shape: the Stripe handlers stamp
    // `ends_at` rather than rewriting `tier`. A tier-only check serves it
    // forever; `isPro` folds the activity test in.
    getProStateForClassroomId.mockResolvedValue({
      tier: 'PRO',
      isActive: false,
      isPro: false,
      subscription: { id: 'sub-lapsed' },
    });

    const err = await quizzesResource
      .handler(VARS, ownerCtx({ quizzes_enabled: true }), new URL('classmoji://x'))
      .catch(e => e);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('forbidden');
    expect(findByClassroom).not.toHaveBeenCalled();
  });

  it('REFUSES a FREE classroom', async () => {
    getProStateForClassroomId.mockResolvedValue({
      tier: 'FREE',
      isActive: false,
      isPro: false,
      subscription: null,
    });

    const err = await quizzesResource
      .handler(VARS, ownerCtx({ quizzes_enabled: true }), new URL('classmoji://x'))
      .catch(e => e);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('forbidden');
    expect(findByClassroom).not.toHaveBeenCalled();
  });
});

describe('calendar resource allowlist shaping (U5)', () => {
  /** A raw expanded-event row exactly as the service returns it: the `...event`
   * spread keeps the UNFILTERED pageLinks/slideLinks include (draft titles!)
   * next to the draft-filtered display arrays. */
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

  it('strips raw link includes and draft titles from the student payload', async () => {
    getClassroomCalendar.mockResolvedValue([RAW_EVENT]);

    const result = (await calendarResource.handler(
      { org: 'o', slug: 's' },
      studentCtx(),
      new URL('classmoji://x')
    )) as { events: Array<Record<string, unknown>> };

    // No draft/unpublished linked-content title anywhere in the payload.
    expect(JSON.stringify(result)).not.toContain('SECRET');
    const [event] = result.events;
    // Raw service internals must not ride along.
    for (const leaked of ['pageLinks', 'slideLinks', 'assignmentLinks', 'overrides']) {
      expect(event).not.toHaveProperty(leaked);
    }
    // …while the published display content survives.
    expect(event.pages).toEqual([{ id: 'p-pub', title: 'Published Page' }]);
    expect(event.title).toBe('Lecture 1');
    expect(event.creator).toEqual({ id: 'owner-1', name: 'Prof', login: 'prof' });
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
  });
});
