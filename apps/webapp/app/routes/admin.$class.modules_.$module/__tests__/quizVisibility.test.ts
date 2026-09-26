/**
 * The module detail page in a classroom that does not show quizzes: its
 * loader sends no quiz item, quiz assignment, candidate or binding, and the
 * "Add item" picker it opens (AddContentItemModal, no preset kind) offers no
 * Quiz type. Adding an item posts to the Modules action, which refuses a quiz
 * item on its own (see admin.$class.modules/__tests__/quizVisibility.test.ts).
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_TYPES, contentTypesFor } from '~/components/features/modules/moduleItemMeta';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  loadQuizzesVisible: vi.fn(),
  findByClassroomSlugAndModuleSlug: vi.fn(),
  listModuleContents: vi.fn(),
  getCandidateContent: vi.fn(),
  assignmentListForClassroom: vi.fn(),
}));

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  // The modal posts through a fetcher, which needs a data router; the markup
  // does not depend on it.
  useFetcher: () => ({ submit: vi.fn(), state: 'idle', data: undefined }),
}));

// antd's Modal portals its body, which renders nothing on the server. Reduced
// to the parts the picker's markup depends on: the body, and each segment's
// label.
vi.mock('antd', async importOriginal => ({
  ...(await importOriginal<typeof import('antd')>()),
  Modal: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
    open ? createElement('div', null, children) : null,
  Segmented: ({ options }: { options: Array<{ value: string; label: string }> }) =>
    createElement(
      'div',
      null,
      options.map(o => createElement('span', { key: o.value, 'data-segment': o.value }, o.label))
    ),
  Select: () => null,
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
}));
vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => mocks.loadQuizzesVisible(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    module: {
      findByClassroomSlugAndModuleSlug: (...a: unknown[]) =>
        mocks.findByClassroomSlugAndModuleSlug(...a),
      listModuleContents: (...a: unknown[]) => mocks.listModuleContents(...a),
      getCandidateContent: (...a: unknown[]) => mocks.getCandidateContent(...a),
    },
    assignment: {
      listForClassroom: (...a: unknown[]) => mocks.assignmentListForClassroom(...a),
    },
    repository: { findByClassroomId: async () => [] },
    organizationTag: { findByClassroomId: async () => [] },
  },
}));

// The page's own component tree is not under test.
vi.mock('~/components/ui/FolderTabs', () => ({ default: () => null }));
vi.mock('~/components/features/assignments/AssignmentsTable', () => ({ default: () => null }));
vi.mock('~/components/features/assignments/AssignmentFormModal', () => ({ default: () => null }));
vi.mock('../../admin.$class.modules/ModuleFormModal', () => ({ default: () => null }));

const { loader } = await import('../route');
const AddContentItemModal = (await import('~/components/features/modules/AddContentItemModal'))
  .default;

const CLASSROOM_ID = 'class-1';

const load = () =>
  loader({
    params: { class: 'cs52', module: 'week-1' },
    request: new Request('http://x/admin/cs52/modules/week-1'),
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireClassroomAdmin.mockResolvedValue({ classroom: { id: CLASSROOM_ID } });
  mocks.findByClassroomSlugAndModuleSlug.mockResolvedValue({ id: 'mod-1' });
  mocks.listModuleContents.mockResolvedValue({
    id: 'mod-1',
    title: 'Week 1',
    items: [
      { id: 'item-page', item_type: 'PAGE' },
      { id: 'item-quiz', item_type: 'QUIZ', quiz: { id: 'q1', name: 'Recursion' } },
    ],
    assignments: [
      { id: 'asg-repo', type: 'REPO' },
      { id: 'asg-quiz', type: 'QUIZ', quiz: { id: 'q1', name: 'Recursion' } },
    ],
  });
  mocks.getCandidateContent.mockResolvedValue({
    pages: [],
    slides: [],
    quizzes: [{ id: 'q1', name: 'Recursion', status: 'PUBLISHED' }],
    forms: [],
  });
  mocks.assignmentListForClassroom.mockResolvedValue([
    { id: 'asg-quiz', quiz_id: 'q1', form_id: null },
  ]);
});

describe('module detail loader', () => {
  it('sends no quiz rows, candidates or bindings without quizzes', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    const result = await load();

    expect(mocks.loadQuizzesVisible).toHaveBeenCalledWith(CLASSROOM_ID);
    expect(result.quizzesVisible).toBe(false);
    expect(result.module.items.map(i => i.id)).toEqual(['item-page']);
    expect(result.module.assignments.map(a => a.id)).toEqual(['asg-repo']);
    expect(result.candidates.quizzes).toEqual([]);
    expect(result.boundQuizIds).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Recursion');
  });

  it('keeps them when the classroom shows quizzes', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(true);
    const result = await load();

    expect(result.quizzesVisible).toBe(true);
    expect(result.module.items.map(i => i.id)).toEqual(['item-page', 'item-quiz']);
    expect(result.module.assignments.map(a => a.id)).toEqual(['asg-repo', 'asg-quiz']);
    expect(result.candidates.quizzes).toHaveLength(1);
    expect(result.boundQuizIds).toEqual(['q1']);
  });
});

describe('the Add item picker’s types', () => {
  it('leaves Quiz out without quizzes', () => {
    expect(contentTypesFor(false)).toEqual(['PAGE', 'SLIDE', 'FORM']);
  });

  it('offers every type when the classroom shows quizzes', () => {
    expect(contentTypesFor(true)).toEqual(CONTENT_TYPES);
    expect(contentTypesFor(true)).toContain('QUIZ');
  });

  const render = (quizzesVisible?: boolean) =>
    renderToStaticMarkup(
      createElement(AddContentItemModal, {
        open: true,
        onClose: () => {},
        classSlug: 'cs52',
        moduleId: 'mod-1',
        items: [],
        candidates: { pages: [], slides: [], quizzes: [], forms: [] },
        ...(quizzesVisible === undefined ? {} : { quizzesVisible }),
      })
    );

  it('renders no Quiz segment without quizzes, or when the flag is absent', () => {
    for (const html of [render(false), render()]) {
      expect(html).toContain('data-segment="PAGE"');
      expect(html).toContain('data-segment="FORM"');
      expect(html).not.toContain('data-segment="QUIZ"');
      expect(html).not.toContain('Quiz');
    }
  });

  it('renders the Quiz segment when the classroom shows quizzes', () => {
    expect(render(true)).toContain('data-segment="QUIZ"');
  });
});
