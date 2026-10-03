/**
 * The module detail page and quizzes.
 *
 * A quiz sits in a module through its QUIZ assignment, made in the quiz form:
 * legacy QUIZ content items never leave the loader, the loader sends no quiz
 * bindings, the "Add item" picker it opens (AddContentItemModal, no preset
 * kind) offers no Quiz type with or without quizzes, and editing a quiz's
 * assignment opens the quiz form. Adding an item posts to the Modules action,
 * which refuses a quiz item on its own (see
 * admin.$class.modules/__tests__/quizVisibility.test.ts).
 *
 * In a classroom that does not show quizzes the loader also sends no quiz
 * assignment or candidate. A module that lists some assignments and owns
 * hidden quiz ones cannot be deleted: the loader flags it and the page renders
 * no Delete button for it. One whose only assignments are hidden quiz ones is
 * deleted with them, so it is not flagged.
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
  navigate: vi.fn(),
  // The tabs the page hands FolderTabs, so a test can reach the assignments
  // table's handlers without rendering the tabs.
  tabs: { items: [] as Array<{ key: string; children: unknown }> },
}));

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  // The modal posts through a fetcher, which needs a data router; the markup
  // does not depend on it. Nor on the page's params.
  useFetcher: () => ({ submit: vi.fn(), state: 'idle', data: undefined }),
  useParams: () => ({ class: 'cs52', module: 'week-1' }),
  useNavigate: () => mocks.navigate,
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
vi.mock('~/components/ui/FolderTabs', () => ({
  default: ({ items }: { items: Array<{ key: string; children: unknown }> }) => {
    mocks.tabs.items = items;
    return null;
  },
}));
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
  mocks.tabs.items = [];
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
  it('sends no quiz rows or candidates without quizzes', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    const result = await load();

    expect(mocks.loadQuizzesVisible).toHaveBeenCalledWith(CLASSROOM_ID);
    expect(result.quizzesVisible).toBe(false);
    expect(result.module.items.map(i => i.id)).toEqual(['item-page']);
    expect(result.module.assignments.map(a => a.id)).toEqual(['asg-repo']);
    expect(result.candidates.quizzes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Recursion');
  });

  it('keeps quiz assignments and candidates when the classroom shows quizzes, and no quiz items', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(true);
    const result = await load();

    expect(result.quizzesVisible).toBe(true);
    // A quiz is in a module through its assignment; the legacy item is not listed.
    expect(result.module.items.map(i => i.id)).toEqual(['item-page']);
    expect(result.module.assignments.map(a => a.id)).toEqual(['asg-repo', 'asg-quiz']);
    expect(result.candidates.quizzes).toHaveLength(1);
  });

  it.each([true, false])('sends no quiz bindings (quizzes visible: %s)', async visible => {
    mocks.loadQuizzesVisible.mockResolvedValue(visible);
    const result = await load();

    expect(result).not.toHaveProperty('boundQuizIds');
    expect(result.boundFormIds).toEqual([]);
  });

  it('does not flag a module whose only assignments are hidden quiz ones, and sends nothing about them', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    mocks.listModuleContents.mockResolvedValue({
      id: 'mod-1',
      title: 'Week 1',
      items: [],
      assignments: [{ id: 'asg-quiz', type: 'QUIZ', quiz: { id: 'q1', name: 'Recursion' } }],
    });
    const result = await load();

    // Deleting it takes the quiz assignments with it, so it can be offered.
    expect(result.module.hasUnlistedAssignments).toBe(false);
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

const renderPage = (
  module: {
    assignments: Array<{ id: string; type: string; quiz?: { id: string } }>;
    hasUnlistedAssignments: boolean;
  },
  quizzesVisible = false
) =>
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
        boundFormIds: [],
        tags: [],
        quizzesVisible,
      },
    } as never)
  );

describe('the module detail page’s Delete button', () => {
  // antd's Button wraps its label in a span.
  const hasDelete = (html: string) => />Delete<\/span>/.test(html);

  it('is not rendered for a module that lists some assignments and owns others', () => {
    const html = renderPage({
      assignments: [{ id: 'asg-repo', type: 'REPO' }],
      hasUnlistedAssignments: true,
    });
    expect(hasDelete(html)).toBe(false);
    expect(html).toContain('Week 1');
    expect(html).not.toMatch(/quiz/i);
  });

  it('is rendered for a module with no listed assignments and nothing else blocking it', () => {
    const html = renderPage({ assignments: [], hasUnlistedAssignments: false });
    expect(hasDelete(html)).toBe(true);
    expect(html).not.toMatch(/quiz/i);
  });

  it('is rendered for a module that lists assignments (its confirm says to move them first)', () => {
    const html = renderPage({
      assignments: [{ id: 'asg-repo', type: 'REPO' }],
      hasUnlistedAssignments: false,
    });
    expect(hasDelete(html)).toBe(true);
  });
});

describe('editing a quiz’s assignment from the module page', () => {
  /** The assignments table's onEdit, as the page wires it. */
  const onEdit = () => {
    const tab = mocks.tabs.items.find(item => item.key === 'assignments');
    return (tab!.children as { props: { onEdit: (row: unknown) => void } }).props.onEdit;
  };

  it('opens the quiz form for that quiz', () => {
    renderPage(
      {
        assignments: [{ id: 'asg-quiz', type: 'QUIZ', quiz: { id: 'q1' } }],
        hasUnlistedAssignments: false,
      },
      true
    );

    onEdit()({ id: 'asg-quiz', type: 'QUIZ', quiz: { id: 'q1' } });

    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/admin/cs52/quizzes/form?quizId=q1');
  });

  it('does nothing for a quiz assignment whose quiz is not sent', () => {
    renderPage({ assignments: [], hasUnlistedAssignments: false }, true);

    onEdit()({ id: 'asg-quiz', type: 'QUIZ', quiz: null });

    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('does not navigate for another kind of assignment', () => {
    renderPage({ assignments: [], hasUnlistedAssignments: false }, true);

    // It opens the assignment modal in place instead.
    onEdit()({ id: 'asg-repo', type: 'REPO' });

    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

describe('New quiz on the module page', () => {
  type Element = { props: { children?: unknown; onClick?: () => void } };
  /** The assignments tab's header buttons, as the page hands them to FolderTabs. */
  const headerButtons = () => {
    const tab = mocks.tabs.items.find(item => item.key === 'assignments') as unknown as {
      extra: Element;
    };
    return ([] as unknown[])
      .concat(tab.extra.props.children)
      .filter((child): child is Element => Boolean(child));
  };

  it('opens the quiz form with this module chosen', () => {
    renderPage({ assignments: [], hasUnlistedAssignments: false }, true);

    const buttons = headerButtons();
    expect(buttons).toHaveLength(2);
    buttons[0].props.onClick!();

    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(
      '/admin/cs52/quizzes/form?moduleId=mod-1'
    );
  });

  it('is not offered where the classroom shows no quizzes', () => {
    const html = renderPage({ assignments: [], hasUnlistedAssignments: false }, false);

    expect(headerButtons()).toHaveLength(1);
    expect(html).not.toMatch(/quiz/i);
  });
});

describe('the Add item picker’s types', () => {
  it('never offers Quiz, with or without quizzes', () => {
    expect(contentTypesFor(false)).toEqual(['PAGE', 'SLIDE', 'FORM']);
    expect(contentTypesFor(true)).toEqual(['PAGE', 'SLIDE', 'FORM']);
    expect(CONTENT_TYPES).toEqual(['PAGE', 'SLIDE', 'FORM']);
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

  it('renders no Quiz segment, whether quizzes show or not', () => {
    for (const html of [render(false), render(), render(true)]) {
      expect(html).toContain('data-segment="PAGE"');
      expect(html).toContain('data-segment="SLIDE"');
      expect(html).toContain('data-segment="FORM"');
      expect(html).not.toContain('data-segment="QUIZ"');
      expect(html).not.toContain('Quiz');
    }
  });
});
