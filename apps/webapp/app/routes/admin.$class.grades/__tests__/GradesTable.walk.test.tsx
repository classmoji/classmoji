// @vitest-environment jsdom
/**
 * The grading walk while the submission panel is open, MOUNTED in jsdom (the
 * walk is frozen across re-renders, which static markup cannot show).
 *
 *   - Grading a cell moves its row under the default Total sort; Next still
 *     goes to the next cell of the same column, as the table stood when the
 *     panel opened.
 *   - The header's "N to grade" counts the rows the walk uses (search and
 *     filter applied).
 *   - Opening a cell whose row is on another page turns the table to it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes, useOutletContext } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionPanelOutletContext } from '../gradingWalk';

const graderRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('~/components/features/grading/EmojiGrader', () => ({
  default: () => {
    graderRenders.count += 1;
    return null;
  },
}));
vi.mock('~/components', () => ({
  UserThumbnailView: ({ user }: { user: { name: string | null } }) => <span>{user.name}</span>,
}));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('~/components/ui/display/Emoji', () => ({
  default: ({ emoji }: { emoji: string }) => <span data-emoji={emoji} />,
}));
vi.mock('../GradeSettings', () => ({ default: () => null }));

const { default: GradesTable } = await import('../GradesTable');
const { walkPosition } = await import('../gradingWalk');
type Props = Parameters<typeof GradesTable>[0];

const MODULE = { id: 'mod-1', title: 'Week 1', position: 0 };
const SCALE = { star: 100, ok: 70, meh: 60, bad: 0 };
const column = (id: string) => ({
  id,
  title: `Lab ${id}`,
  weight: 10,
  is_extra_credit: false,
  type: 'REPO',
  module_id: MODULE.id,
  module_title: MODULE.title,
  repository_id: `r-${id}`,
  repository_type: 'INDIVIDUAL',
  created_at: `2026-09-0${id === 'a1' ? 1 : 2}T00:00:00Z`,
});

const sub = (id: string, assignmentId: string, emoji?: string) => ({
  id,
  assignment_id: assignmentId,
  status: 'CLOSED',
  closed_at: '2026-09-02T00:00:00Z',
  is_late: false,
  is_late_override: false,
  grades: emoji ? [{ id: `g-${id}`, emoji }] : [],
  token_transactions: [],
  assignment: { id: assignmentId, weight: 10, student_deadline: null },
});

/** A student with an ungraded (or `a1`-graded) lab 1 and a graded lab 2. */
const student = (id: string, a2: string, a1?: string) => ({
  id,
  name: id,
  login: id,
  avatar_url: null,
  git_repos: [
    {
      id: `repo-${id}`,
      name: `lab-${id}`,
      student_id: id,
      team_id: null,
      assignments: [sub(`${id}-a1`, 'a1', a1), sub(`${id}-a2`, 'a2', a2)],
    },
  ],
  quiz_items: [],
});

const Probe = () => {
  const ctx = useOutletContext<SubmissionPanelOutletContext>();
  const at = walkPosition(ctx.walk, 'yan-a1');
  return (
    <>
      <output data-testid="probe" data-next={at.next?.submissionId ?? ''} data-left={at.left} />
      <Link to={ctx.panelHref('zed-a1')} data-testid="walk-to-zed">
        next
      </Link>
    </>
  );
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // rc-table measures the scrollbar with a pseudo-element jsdom does not implement.
  const getComputedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (elt: Element) => getComputedStyle(elt);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tree = (students: unknown[], url: string) => (
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route
        path="/admin/:class/grades"
        element={
          <GradesTable
            emojiMappings={SCALE}
            modules={[MODULE]}
            assignments={[column('a1'), column('a2')] as Props['assignments']}
            students={students as Props['students']}
            settings={{ late_penalty_points_per_hour: 0 }}
            letterGradeMappings={[]}
            memberships={[]}
          />
        }
      >
        <Route path="submissions/:submissionId" element={<Probe />} />
      </Route>
    </Routes>
  </MemoryRouter>
);

const render = async (students: unknown[], url = '/admin/c/grades/submissions/yan-a1') => {
  await act(async () => {
    root.render(tree(students, url));
  });
};

const probe = () => container.querySelector('[data-testid="probe"]') as HTMLElement;

describe('the walk while the panel is open', () => {
  it('stays in the column after grading moves the row under the Total sort', async () => {
    // Total, highest first: xia (100), yan (70), zed (60).
    await render([student('xia', 'star'), student('yan', 'ok'), student('zed', 'meh')]);
    expect(probe().dataset.next).toBe('zed-a1');

    // Grading yan's lab 1 low drops yan below zed in the table.
    await render([student('xia', 'star'), student('yan', 'ok', 'bad'), student('zed', 'meh')]);

    const rows = [...container.querySelectorAll('tbody tr[data-row-key]')].map(r =>
      r.getAttribute('data-row-key')
    );
    expect(rows).toEqual(['xia', 'zed', 'yan']);
    // A walk rebuilt from that table would go on to xia-a1 and skip zed-a1.
    expect(probe().dataset.next).toBe('zed-a1');
    expect(probe().dataset.left).toBe('2');
  });
});

describe('header counts', () => {
  it('count the rows the walk uses, search applied', async () => {
    await render(
      [student('xia', 'star'), student('yan', 'ok'), student('zed', 'meh')],
      '/admin/c/grades'
    );
    const startText = () =>
      container.querySelector('[data-testid="gradebook-column-start"]')?.textContent;
    expect(startText()).toBe('3 to grade · Start');

    const input = container.querySelector(
      'input[placeholder="Search students"]'
    ) as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'zed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(startText()).toBe('1 to grade · Start');
  });
});

describe('pagination', () => {
  it("turns the table to the open cell's page", async () => {
    // 60 students, xx00 … xx59, all with lab 1 to grade; Total ties keep
    // their order, so xx55 is on page 2.
    const many = Array.from({ length: 60 }, (_, i) =>
      student(`xx${String(i).padStart(2, '0')}`, 'ok')
    );
    await render(many, '/admin/c/grades/submissions/xx55-a1');

    const active = container.querySelector('.ant-pagination-item-active');
    expect(active?.getAttribute('title')).toBe('2');
    expect(container.querySelector('[data-gradebook-cell="xx55-a1"]')).not.toBeNull();
  });
});

describe('walking the panel', () => {
  it('re-renders no cell: only the open-cell style rule changes', async () => {
    await render([student('xia', 'star'), student('yan', 'ok'), student('zed', 'meh')]);
    const style = () => container.querySelector('style')?.textContent ?? '';
    expect(style()).toContain('[data-gradebook-cell="yan-a1"]');
    const before = graderRenders.count;
    expect(before).toBeGreaterThan(0);

    await act(async () => {
      (container.querySelector('[data-testid="walk-to-zed"]') as HTMLElement).click();
    });

    expect(style()).toContain('[data-gradebook-cell="zed-a1"]');
    expect(graderRenders.count).toBe(before);
  });
});
