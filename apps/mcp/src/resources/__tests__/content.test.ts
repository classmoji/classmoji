/**
 * Unit tests for the quizzes resource Pro-tier twin guard (finding A3).
 *
 * assertProTier resolves the subscription by BARE slug
 * (subscription.getByClassroom), and slugs are unique only per git org. Without
 * a guard, a caller authorized for a FREE twin classroom could pass the Pro
 * gate on the OTHER same-slug classroom's PRO subscription. The guard mirrors
 * the leaderboard/modules resources: it re-resolves the slug via
 * classroom.findBySlug and refuses unless the resolved id equals the
 * authorized ctx.classroom.classroomId.
 *
 * `@classmoji/services` is mocked (factory idiom) so the guard decision runs
 * for real against hand-built rows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../mcp/errors.ts';
import type { ToolContext } from '../../mcp/registry.ts';

const findBySlug = vi.fn();
const getByClassroom = vi.fn();
const findByClassroom = vi.fn();
const getQuizzesForStudent = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { findBySlug: (...a: unknown[]) => findBySlug(...a) },
    subscription: { getByClassroom: (...a: unknown[]) => getByClassroom(...a) },
    quiz: {
      findByClassroom: (...a: unknown[]) => findByClassroom(...a),
      getQuizzesForStudent: (...a: unknown[]) => getQuizzesForStudent(...a),
    },
  },
}));

const { quizzesResource } = await import('../content.ts');

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

beforeEach(() => {
  findBySlug.mockReset();
  getByClassroom.mockReset();
  findByClassroom.mockReset();
  getQuizzesForStudent.mockReset();
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
