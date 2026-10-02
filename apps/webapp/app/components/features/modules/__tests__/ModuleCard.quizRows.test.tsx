// @vitest-environment jsdom
/**
 * A module card and quizzes, MOUNTED in jsdom.
 *
 * A quiz and its assignment are one thing, made and edited in the quiz form:
 *   - "Add item" offers "Quiz" where the classroom shows quizzes; choosing it
 *     opens the quiz form with this module chosen.
 *   - A quiz assignment row's Edit opens the quiz form for that quiz.
 *   - A quiz assignment row offers no "Delete assignment": it goes with the
 *     quiz (deleted, or moved to another module in the quiz form). Other
 *     assignment rows keep theirs.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CourseworkRow } from '../useCourseworkDrag';

const router = vi.hoisted(() => ({ pathname: '/admin/cs52/modules', navigate: vi.fn() }));

vi.mock('react-router', () => ({
  useFetcher: () => ({ submit: vi.fn(), state: 'idle', data: undefined }),
  useLocation: () => ({ pathname: router.pathname }),
  useNavigate: () => router.navigate,
}));

type MenuItem = {
  key?: string;
  type?: string;
  label?: ReactNode;
  disabled?: boolean;
  children?: MenuItem[];
};

// Each dropdown's menu is rendered inline as buttons (groups flattened), so a
// test can see which entries it offers and choose one.
vi.mock('antd', async importOriginal => ({
  ...(await importOriginal<typeof import('antd')>()),
  App: { useApp: () => ({ modal: { confirm: vi.fn() } }) },
  Dropdown: ({
    menu,
    children,
  }: {
    menu: {
      items: MenuItem[];
      onClick: (info: { key: string; domEvent: { stopPropagation: () => void } }) => void;
    };
    children: ReactNode;
  }) => (
    <div>
      {children}
      {menu.items
        .flatMap(item => (item.type === 'group' ? (item.children ?? []) : [item]))
        .filter(item => item.type !== 'divider')
        .map(item => (
          <button
            key={item.key}
            type="button"
            data-menu-key={item.key}
            disabled={item.disabled}
            onClick={e => menu.onClick({ key: item.key!, domEvent: e })}
          >
            {item.label}
          </button>
        ))}
    </div>
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Switch: () => null,
}));

vi.mock('~/routes/admin.$class.modules/ModuleFormModal', () => ({ default: () => null }));
vi.mock('~/components/features/assignments/AssignmentFormModal', () => ({ default: () => null }));
vi.mock('~/components/features/assignments/AssignmentsTable', () => ({
  ASSIGNMENT_TYPE_META: {},
  assignmentTarget: () => null,
}));
vi.mock('../AddContentItemModal', () => ({ default: () => null }));
vi.mock('~/components/features/repositories/useRepositoryActions', () => ({
  useRepositoryActions: () => ({
    confirmPublishAssignment: vi.fn(),
    confirmSync: vi.fn(),
    pending: null,
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: ModuleCard } = await import('../ModuleCard');

const list = (items: CourseworkRow[]) => ({
  items,
  rowProps: () => undefined,
  handleProps: () => undefined,
  rowClassName: () => '',
});

type Row = {
  id: string;
  type: string;
  title: string;
  weight?: number;
  is_published?: boolean;
  quiz?: { id: string; name: string } | null;
  repository?: { id: string; title: string } | null;
};

const QUIZ_ROW: Row = {
  id: 'asg-quiz',
  type: 'QUIZ',
  title: 'Recursion check',
  weight: 10,
  is_published: true,
  quiz: { id: 'q1', name: 'Recursion check' },
};
const REPO_ROW: Row = {
  id: 'asg-repo',
  type: 'REPO',
  title: 'Lab 1',
  weight: 20,
  is_published: true,
  repository: { id: 'repo-1', title: 'lab-1' },
};

let container: HTMLDivElement;
let root: Root;

const render = ({
  assignments = [QUIZ_ROW, REPO_ROW] as Row[],
  quizzesVisible = true,
} = {}) =>
  act(() => {
    root.render(
      <ModuleCard
        module={
          {
            id: 'mod-1',
            title: 'Week 1',
            slug: 'week-1',
            description: null,
            position: 0,
            is_published: true,
            is_public: false,
            items: [],
            assignments,
            hasUnlistedAssignments: false,
          } as never
        }
        index={0}
        classSlug="cs52"
        slidesUrl="http://slides"
        expanded
        onToggle={() => {}}
        candidates={{ pages: [], slides: [], quizzes: [], forms: [] }}
        repositories={[{ id: 'repo-1', title: 'lab-1', is_published: true }]}
        boundFormIds={new Set()}
        quizzesVisible={quizzesVisible}
        coursework={{
          content: list([]),
          assignments: list(assignments as unknown as CourseworkRow[]),
          cardProps: undefined,
          isDropTarget: false,
        }}
      />
    );
  });

/** The `<li>` of the row titled `title`. */
const rowOf = (title: string) =>
  [...container.querySelectorAll('li')].find(li => li.textContent?.includes(title))!;
const menuKeys = (scope: ParentNode) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button[data-menu-key]')].map(
    b => b.dataset.menuKey
  );
const editButton = (row: HTMLElement) =>
  [...row.querySelectorAll('button')].find(b => b.textContent === 'Edit')!;

beforeEach(() => {
  vi.clearAllMocks();
  router.pathname = '/admin/cs52/modules';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ModuleCard — Add item → Quiz', () => {
  it('opens the quiz form with this module chosen', () => {
    render();

    const quiz = container.querySelector<HTMLButtonElement>('button[data-menu-key="QUIZ"]')!;
    expect(quiz.textContent).toBe('Quiz');
    act(() => quiz.click());

    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(
      '/admin/cs52/quizzes/form?moduleId=mod-1'
    );
  });

  it('is offered alongside the other kinds, and the old quiz-assignment entry is gone', () => {
    render();

    const keys = menuKeys(container);
    for (const key of ['ASSIGNMENT_REPO', 'QUIZ', 'ASSIGNMENT_FORM', 'PAGE', 'SLIDE']) {
      expect(keys).toContain(key);
    }
    expect(keys).not.toContain('ASSIGNMENT_QUIZ');
  });

  it('is not offered where the classroom does not show quizzes', () => {
    render({ assignments: [REPO_ROW], quizzesVisible: false });

    const keys = menuKeys(container);
    expect(keys).not.toContain('QUIZ');
    expect(keys).toContain('ASSIGNMENT_REPO');
  });
});

describe('ModuleCard — a quiz assignment row', () => {
  it('Edit opens the quiz form for that quiz', () => {
    render();

    act(() => editButton(rowOf('Recursion check')).click());

    expect(router.navigate).toHaveBeenCalledExactlyOnceWith('/admin/cs52/quizzes/form?quizId=q1');
  });

  it('offers editing the quiz, and no Delete assignment', () => {
    render();

    expect(menuKeys(rowOf('Recursion check'))).toEqual(['edit-target']);
  });

  it('the quiz entry in its menu opens the quiz form too', () => {
    render();

    const entry = rowOf('Recursion check').querySelector<HTMLButtonElement>(
      'button[data-menu-key="edit-target"]'
    )!;
    act(() => entry.click());

    expect(router.navigate).toHaveBeenCalledExactlyOnceWith('/admin/cs52/quizzes/form?quizId=q1');
  });

  it('leaves a repository assignment its Delete assignment entry', () => {
    render();

    expect(menuKeys(rowOf('Lab 1'))).toEqual(['edit-target', 'remove']);
  });
});
