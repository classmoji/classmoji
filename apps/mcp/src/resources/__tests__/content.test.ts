/**
 * Unit tests for the quizzes resource Pro-tier twin guard (finding A3) and
 * the calendar resource's allowlist shaping (finding U5).
 *
 * A3: assertProTier resolves the subscription by BARE slug
 * (subscription.getByClassroom), and slugs are unique only per git org. Without
 * a guard, a caller authorized for a FREE twin classroom could pass the Pro
 * gate on the OTHER same-slug classroom's PRO subscription. The guard mirrors
 * the leaderboard/modules resources: it re-resolves the slug via
 * classroom.findBySlug and refuses unless the resolved id equals the
 * authorized ctx.classroom.classroomId.
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
const getByClassroom = vi.fn();
const findByClassroom = vi.fn();
const getQuizzesForStudent = vi.fn();
const getClassroomCalendar = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { findBySlug: (...a: unknown[]) => findBySlug(...a) },
    subscription: { getByClassroom: (...a: unknown[]) => getByClassroom(...a) },
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
  getByClassroom.mockReset();
  findByClassroom.mockReset();
  getQuizzesForStudent.mockReset();
  getClassroomCalendar.mockReset();
});

describe('quizzes resource Pro-tier twin guard (A3)', () => {
  it('REFUSES when the bare slug resolves to a different classroom than authorized', async () => {
    // The slug's findFirst resolves to the OTHER same-slug classroom...
    findBySlug.mockResolvedValue({ id: 'other-class' });
    // ...whose subscription is PRO — this must NOT be reachable as a bypass.
    getByClassroom.mockResolvedValue({ tier: 'PRO', id: 'sub-pro' });

    const err = await quizzesResource
      .handler(VARS, ownerCtx(), new URL('classmoji://x'))
      .catch(e => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('internal');
    // Guard runs BEFORE the tier lookup and before any quiz data is fetched.
    expect(getByClassroom).not.toHaveBeenCalled();
    expect(findByClassroom).not.toHaveBeenCalled();
  });

  it('keys the Pro gate on the resolved classroom id, then serves quizzes', async () => {
    // Slug resolves back to the authorized classroom id → guard passes.
    findBySlug.mockResolvedValue({ id: 'class-1' });
    getByClassroom.mockResolvedValue({ tier: 'PRO', id: 'sub-pro' });
    findByClassroom.mockResolvedValue([
      { id: 'q1', name: 'Quiz 1', status: 'PUBLISHED', weight: 1, question_count: 3 },
    ]);

    const result = (await quizzesResource.handler(
      VARS,
      ownerCtx({ quizzes_enabled: true }),
      new URL('classmoji://x')
    )) as { quizzes: Array<{ id: string }> };

    expect(findBySlug).toHaveBeenCalledWith('winter-2025');
    expect(findByClassroom).toHaveBeenCalledWith('class-1', expect.anything());
    expect(result.quizzes.map(q => q.id)).toEqual(['q1']);
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
