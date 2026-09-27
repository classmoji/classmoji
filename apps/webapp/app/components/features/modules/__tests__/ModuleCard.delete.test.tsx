// @vitest-environment jsdom
/**
 * The module card's Delete entry and its error line, MOUNTED in jsdom.
 *
 * A module that owns any assignment cannot be deleted. When all of them are
 * listed, the entry stays, disabled, and says to move them first. When it owns
 * some the page does not list (`hasUnlistedAssignments`: hidden quiz
 * assignments), moving the listed ones could never unblock it, so the card
 * offers no entry at all. Choosing Delete asks first — content items are kept
 * — and posts only once confirmed. The error line shows under the header, so a
 * collapsed card shows it too, and it follows the latest write to come back:
 * the card's module writes, its assignment deletes, or the page's drag into it.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CourseworkRow } from '../useCourseworkDrag';

type Result = { success?: string; error?: string };

// The card calls useFetcher twice per render, module writes first, then
// assignment deletes; its modals, which have their own, are mocked out.
const fetchers = vi.hoisted(() => {
  const make = () => ({ submit: vi.fn(), state: 'idle', data: undefined as Result | undefined });
  return { module: make(), assignment: make(), calls: 0 };
});
const confirm = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ pathname: '/admin/cs52/modules', navigate: vi.fn() }));

vi.mock('react-router', () => ({
  useFetcher: () => (fetchers.calls++ % 2 === 0 ? fetchers.module : fetchers.assignment),
  useLocation: () => ({ pathname: router.pathname }),
  useNavigate: () => router.navigate,
}));

type MenuItem = { key?: string; type?: string; label?: ReactNode; disabled?: boolean };

// The dropdown's menu is rendered inline as buttons, so a test can see which
// entries it offers and choose one; the rest is reduced to what the card's
// header markup needs.
vi.mock('antd', async importOriginal => ({
  ...(await importOriginal<typeof import('antd')>()),
  App: { useApp: () => ({ modal: { confirm } }) },
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
        .filter(item => item.type !== 'divider' && item.type !== 'group')
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

let container: HTMLDivElement;
let root: Root;

type Row = { id: string; type: string; title: string; weight?: number; form?: { slug: string } };

const render = ({
  assignments = [] as Row[],
  hasUnlistedAssignments = false,
  expanded = false,
  moveResult = undefined as Result | undefined,
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
            hasUnlistedAssignments,
          } as never
        }
        index={0}
        classSlug="cs52"
        slidesUrl="http://slides"
        expanded={expanded}
        onToggle={() => {}}
        candidates={{ pages: [], slides: [], quizzes: [], forms: [] }}
        repositories={[]}
        boundQuizIds={new Set()}
        boundFormIds={new Set()}
        quizzesVisible={false}
        coursework={{
          content: list([]),
          assignments: list(assignments),
          cardProps: undefined,
          isDropTarget: false,
        }}
        moveResult={moveResult}
      />
    );
  });

const deleteEntry = () =>
  container.querySelector<HTMLButtonElement>('button[data-menu-key="delete"]');
const alertLine = () => container.querySelector('[role="alert"]')?.textContent ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  fetchers.calls = 0;
  for (const f of [fetchers.module, fetchers.assignment]) {
    f.state = 'idle';
    f.data = undefined;
  }
  router.pathname = '/admin/cs52/modules';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ModuleCard — Delete', () => {
  it('offers no Delete for a module that lists no assignments but owns some', () => {
    render({ hasUnlistedAssignments: true });

    expect(container.querySelector('button[data-menu-key="edit"]')).not.toBeNull();
    expect(deleteEntry()).toBeNull();
    expect(container.textContent).not.toMatch(/delete|quiz/i);
  });

  it('offers no Delete for a module that lists some assignments and owns others', () => {
    render({
      assignments: [{ id: 'asg-repo', type: 'REPO', title: 'Lab 1' }],
      hasUnlistedAssignments: true,
    });

    expect(container.querySelector('button[data-menu-key="edit"]')).not.toBeNull();
    expect(deleteEntry()).toBeNull();
    expect(container.textContent).not.toMatch(/delete|quiz/i);
  });

  it('keeps a disabled entry that says to move the assignments first when it lists them all', () => {
    render({ assignments: [{ id: 'asg-repo', type: 'REPO', title: 'Lab 1' }] });

    expect(deleteEntry()?.textContent).toBe('Delete (move its assignments first)');
    expect(deleteEntry()?.disabled).toBe(true);
  });

  it('asks before deleting, and posts only once confirmed', () => {
    render();
    expect(deleteEntry()?.textContent).toBe('Delete module');

    act(() => deleteEntry()!.click());

    expect(confirm).toHaveBeenCalledTimes(1);
    const options = confirm.mock.calls[0][0];
    expect(options).toMatchObject({ title: 'Delete module', okText: 'Delete' });
    expect(options.content).toBe(
      'This removes the module. Its content items (pages, slides, forms) are kept.'
    );
    expect(fetchers.module.submit).not.toHaveBeenCalled();

    act(() => options.onOk());

    expect(fetchers.module.submit).toHaveBeenCalledWith(JSON.stringify({ id: 'mod-1' }), {
      method: 'post',
      action: '/admin/cs52/modules?/delete',
      encType: 'application/json',
    });
  });
});

describe('ModuleCard — the error line', () => {
  it('shows a refused write on a collapsed card', () => {
    fetchers.module.data = { error: 'This module can’t be deleted.' };
    render({ expanded: false });

    expect(alertLine()).toBe('This module can’t be deleted.');
  });

  it('clears the error once the next write succeeds', () => {
    fetchers.module.data = { error: 'This module can’t be deleted.' };
    render();
    expect(alertLine()).not.toBeNull();

    fetchers.module.data = { success: 'Module published to students' };
    render();
    expect(alertLine()).toBeNull();
  });

  it('shows a failed assignment delete, and a later module write clears it', () => {
    fetchers.assignment.data = { error: 'Failed to delete assignment' };
    render();
    expect(alertLine()).toBe('Failed to delete assignment');

    fetchers.module.data = { success: 'Module published to students' };
    render();
    expect(alertLine()).toBeNull();
  });

  it('lets a later assignment delete clear a module error, and keeps it cleared', () => {
    fetchers.module.data = { error: 'Failed to reorder items. Please try again.' };
    render();
    expect(alertLine()).toBe('Failed to reorder items. Please try again.');

    fetchers.assignment.data = { success: 'Assignment deleted' };
    render();
    expect(alertLine()).toBeNull();

    // The module fetcher still holds its old error; it is not shown again.
    render();
    expect(alertLine()).toBeNull();
  });

  it('shows nothing while a write is still on its way back', () => {
    fetchers.assignment.state = 'submitting';
    fetchers.assignment.data = { error: 'Failed to delete assignment' };
    render();

    expect(alertLine()).toBeNull();
  });

  it('shows a failed drag into the card, and clears it once one succeeds', () => {
    render({ moveResult: { error: 'Failed to move the assignment. Please try again.' } });
    expect(alertLine()).toBe('Failed to move the assignment. Please try again.');

    render({ moveResult: { success: 'Assignment moved' } });
    expect(alertLine()).toBeNull();
  });

  it('lets a later card write clear a failed drag', () => {
    const failed = { error: 'Failed to move the item. Please try again.' };
    render({ moveResult: failed });
    expect(alertLine()).not.toBeNull();

    fetchers.module.data = { success: 'Item removed from module' };
    render({ moveResult: failed });
    expect(alertLine()).toBeNull();
  });
});

describe('ModuleCard — form links', () => {
  it('stays inside the section the viewer is in', () => {
    router.pathname = '/teacher/cs52/modules';
    render({
      expanded: true,
      assignments: [
        { id: 'asg-form', type: 'FORM', title: 'Survey', weight: 0, form: { slug: 'survey' } },
      ],
    });

    const row = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Survey')
    );
    act(() => row!.click());

    expect(router.navigate).toHaveBeenCalledWith('/teacher/cs52/forms/survey');
  });
});
