/**
 * Pins the quiz filter on the modules read (the `modules` resource and its
 * `list_modules` mirror, which share one handler).
 *
 * Quiz items appear only where `entitlement.quizzesVisible` holds (Pro, and
 * quizzes switched on) — the predicate the web app's module screens filter on,
 * so an agent and a browser see the same curriculum. When it does not hold,
 * quiz items are dropped for every role and every other item is untouched. The
 * lookup is asked once, and only when a quiz item is present.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  listForClassroom: vi.fn(),
  quizzesVisible: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({ assertProTier: vi.fn() }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    module: { listForClassroom: (...a: unknown[]) => mocks.listForClassroom(...a) },
    entitlement: { quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a) },
  },
}));

const { modulesResource } = await import('../content.ts');

const ctxAs = (role: 'OWNER' | 'STUDENT'): ToolContext =>
  ({
    viewer: { userId: 'user-1', clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { slug: 'w26', settings: {} },
    },
  }) as unknown as ToolContext;

const MODULES = [
  {
    id: 'mod-1',
    classroom_id: 'class-1',
    title: 'Week 1',
    slug: 'week-1',
    description: null,
    position: 0,
    is_published: true,
    items: [
      { id: 'i-page', item_type: 'PAGE', position: 0, page: { id: 'p1', title: 'Intro' } },
      { id: 'i-quiz', item_type: 'QUIZ', position: 1, quiz: { id: 'q1', name: 'Recursion quiz' } },
      { id: 'i-slide', item_type: 'SLIDE', position: 2, slide: { id: 's1', title: 'Deck' } },
    ],
  },
  {
    id: 'mod-2',
    classroom_id: 'class-1',
    title: 'Week 2',
    slug: 'week-2',
    description: null,
    position: 1,
    is_published: true,
    items: [{ id: 'i-quiz-2', item_type: 'QUIZ', position: 0, quiz: { id: 'q2', name: 'Q2' } }],
  },
];

type Payload = { enabled: boolean; modules: Array<{ id: string; items: Array<{ id: string }> }> };

const URI = new URL('classmoji://org/w26/modules');

const read = async (role: 'OWNER' | 'STUDENT') =>
  (await modulesResource.handler({ org: 'org', slug: 'w26' }, ctxAs(role), URI)) as Payload;

const itemIds = (payload: Payload) => payload.modules.map(m => m.items.map(i => i.id));

beforeEach(() => {
  mocks.listForClassroom.mockReset().mockResolvedValue(MODULES);
  mocks.quizzesVisible.mockReset().mockResolvedValue(true);
});

describe('modules read — quiz items', () => {
  it('lists quiz items where quizzes are visible', async () => {
    expect(itemIds(await read('STUDENT'))).toEqual([['i-page', 'i-quiz', 'i-slide'], ['i-quiz-2']]);
  });

  it('drops quiz items, and only those, for staff and students alike when not visible', async () => {
    mocks.quizzesVisible.mockResolvedValue(false);

    for (const role of ['OWNER', 'STUDENT'] as const) {
      const payload = await read(role);
      expect(itemIds(payload), role).toEqual([['i-page', 'i-slide'], []]);
      expect(JSON.stringify(payload), role).not.toContain('quiz');
    }
  });

  it('numbers the items it lists 0..n-1, so a dropped quiz item leaves no gap', async () => {
    // Stored positions run over every row of the module. Shown as stored, the
    // slide at 2 with nothing at 1 would say a row sits between them.
    mocks.quizzesVisible.mockResolvedValue(false);

    const payload = (await read('OWNER')) as unknown as {
      modules: Array<{ items: Array<{ id: string; position: number }> }>;
    };

    expect(payload.modules[0].items.map(i => [i.id, i.position])).toEqual([
      ['i-page', 0],
      ['i-slide', 1],
    ]);
  });

  it('asks about the authorized classroom once per read', async () => {
    await read('OWNER');

    expect(mocks.quizzesVisible).toHaveBeenCalledTimes(1);
    expect(mocks.quizzesVisible).toHaveBeenCalledWith('class-1');
  });

  it('does not ask when no module holds a quiz', async () => {
    mocks.listForClassroom.mockResolvedValue([{ ...MODULES[0], items: [MODULES[0].items[0]] }]);

    expect(itemIds(await read('OWNER'))).toEqual([['i-page']]);
    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
  });
});
