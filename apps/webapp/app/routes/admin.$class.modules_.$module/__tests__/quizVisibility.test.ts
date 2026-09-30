/**
 * The module detail page in a classroom that does not show quizzes: its
 * loader sends no quiz item, quiz assignment, candidate or binding, and the
 * "Add item" picker it opens (AddContentItemModal, no preset kind) offers no
 * Quiz type. Adding an item posts to the Modules action, which refuses a quiz
 * item on its own (see admin.$class.modules/__tests__/quizVisibility.test.ts).
 * A module that owns hidden quiz assignments cannot be deleted, whatever else
 * it lists: the loader flags it and the page renders no Delete button for it.
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
  // does not depend on it. Nor on the page's params or navigation.
  useFetcher: () => ({ submit: vi.fn(), state: 'idle', data: undefined }),
  useParams: () => ({ class: 'cs52', module: 'week-1' }),
  useNavigate: () => vi.fn(),
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

const { loader, default: ModuleDetail } = await import('../route');
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

  it('flags a module whose only assignments are hidden, and sends nothing else about them', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    mocks.listModuleContents.mockResolvedValue({
      id: 'mod-1',
      title: 'Week 1',
      items: [],
      assignments: [{ id: 'asg-quiz', type: 'QUIZ', quiz: { id: 'q1', name: 'Recursion' } }],
    });
    const result = await load();

    expect(result.module.hasUnlistedAssignments).toBe(true);
    expect(result.module.assignments).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/Recursion|asg-quiz|"q1"/);
  });

  it('flags a module that lists some assignments and owns hidden ones', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    const result = await load(); // lists asg-repo, owns asg-quiz

    expect(result.module.hasUnlistedAssignments).toBe(true);
    expect(result.module.assignments.map(a => a.id)).toEqual(['asg-repo']);
    expect(JSON.stringify(result)).not.toMatch(/Recursion|asg-quiz|"q1"/);
  });

  it('does not flag a module that lists every assignment, or any module when quizzes show', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    mocks.listModuleContents.mockResolvedValue({
      id: 'mod-1',
      title: 'Week 1',
      items: [],
      assignments: [{ id: 'asg-repo', type: 'REPO' }],
    });
    expect((await load()).module.hasUnlistedAssignments).toBe(false);

    mocks.loadQuizzesVisible.mockResolvedValue(true);
    mocks.listModuleContents.mockResolvedValue({
      id: 'mod-1',
      title: 'Week 1',
      items: [],
      assignments: [{ id: 'asg-quiz', type: 'QUIZ', quiz: { id: 'q1', name: 'Recursion' } }],
    });
    expect((await load()).module.hasUnlistedAssignments).toBe(false);
  });
});

describe('the module detail page’s Delete button', () => {
  const renderPage = (module: {
    assignments: Array<{ id: string; type: string }>;
    hasUnlistedAssignments: boolean;
  }) =>
    renderToStaticMarkup(
      createElement(ModuleDetail, {
        loaderData: {
          module: {
            id: 'mod-1',
            title: 'Week 1',
            slug: 'week-1',
            description: null,
            position: 0,
            is_published: true,
            items: [],
            ...module,
          },
          candidates: { pages: [], slides: [], quizzes: [], forms: [] },
          repositories: [],
          boundQuizIds: [],
          boundFormIds: [],
          tags: [],
          quizzesVisible: false,
        },
      } as never)
    );
  // antd's Button wraps its label in a span.
  const hasDelete = (html: string) => />Delete<\/span>/.test(html);

  it('is not rendered for a module that lists no assignments but owns some', () => {
    const html = renderPage({ assignments: [], hasUnlistedAssignments: true });
    expect(hasDelete(html)).toBe(false);
    expect(html).toContain('Week 1');
    expect(html).not.toMatch(/quiz/i);
  });

  it('is not rendered for a module that lists some assignments and owns others', () => {
    const html = renderPage({
      assignments: [{ id: 'asg-repo', type: 'REPO' }],
      hasUnlistedAssignments: true,
    });
    expect(hasDelete(html)).toBe(false);
    expect(html).not.toMatch(/quiz/i);
  });

  it('is rendered for a module with no assignments at all', () => {
    expect(hasDelete(renderPage({ assignments: [], hasUnlistedAssignments: false }))).toBe(true);
  });

  it('is rendered for a module that lists assignments (its confirm says to move them first)', () => {
    const html = renderPage({
      assignments: [{ id: 'asg-repo', type: 'REPO' }],
      hasUnlistedAssignments: false,
    });
    expect(hasDelete(html)).toBe(true);
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
