// @vitest-environment jsdom
/**
 * The gradebook's view toggles, MOUNTED in jsdom: each viewer's choice is
 * read from this browser after mount, which static markup never runs.
 *
 *   - Emoji | Numbers: Numbers shows the numeric grade in the cell.
 *   - Students | Teams: Teams shows one row per team (members under the
 *     name) over the group repository columns only, with no totals and no
 *     letter.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/components/features/grading/EmojiGrader', () => ({ default: () => null }));
vi.mock('~/components', () => ({
  UserThumbnailView: ({ user }: { user: { name: string | null } }) => <span>{user.name}</span>,
}));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('~/components/ui/display/Emoji', () => ({
  default: ({ emoji }: { emoji: string }) => <span data-emoji={emoji} />,
}));
vi.mock('../GradeSettings', () => ({ default: () => null }));

const { default: GradesTable } = await import('../GradesTable');
type Props = Parameters<typeof GradesTable>[0];

const MODULE = { id: 'mod-1', title: 'Week 1', position: 0 };

const repoColumn = (id: string, title: string, type: 'INDIVIDUAL' | 'GROUP') => ({
  id,
  title,
  weight: 10,
  is_extra_credit: false,
  type: 'REPO',
  module_id: MODULE.id,
  module_title: MODULE.title,
  repository_id: `r-${id}`,
  repository_type: type,
  created_at: '2026-09-01T00:00:00Z',
});

const graded = (id: string, assignmentId: string, emoji: string) => ({
  id,
  assignment_id: assignmentId,
  status: 'CLOSED',
  closed_at: '2026-09-02T00:00:00Z',
  is_late: false,
  is_late_override: false,
  grades: [{ id: `g-${id}`, emoji }],
  token_transactions: [],
  assignment: { id: assignmentId, weight: 10, student_deadline: null },
});

const teamRepo = {
  id: 'repo-team',
  name: 'project-rockets',
  student_id: null,
  team_id: 'team-1',
  assignments: [graded('sub-team', 'a-group', 'star')],
};
const student = (id: string, name: string) => ({
  id,
  name,
  login: id,
  avatar_url: null,
  git_repos: [
    {
      id: `repo-${id}`,
      name: `lab-${id}`,
      student_id: id,
      team_id: null,
      assignments: [graded(`sub-${id}`, 'a-solo', 'ok')],
    },
    teamRepo,
  ],
  quiz_items: [],
});

const PROPS: Props = {
  emojiMappings: { star: 100, ok: 70 },
  modules: [MODULE],
  assignments: [
    repoColumn('a-solo', 'Solo lab', 'INDIVIDUAL'),
    repoColumn('a-group', 'Team project', 'GROUP'),
  ],
  students: [
    student('ada', 'Ada Lovelace'),
    student('bob', 'Bob Byte'),
  ] as unknown as Props['students'],
  settings: { late_penalty_points_per_hour: 0 },
  letterGradeMappings: [],
  memberships: [],
  activity: { quiz: {}, form: {} },
  teams: [{ id: 'team-1', name: 'Rockets', member_ids: ['ada', 'bob'] }],
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // antd reads these in jsdom.
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

const mount = async () => {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/admin/intro-101/grades']}>
        <Routes>
          <Route path="/admin/:class/grades" element={<GradesTable {...PROPS} />} />
        </Routes>
      </MemoryRouter>
    );
  });
};

const cellLinks = () =>
  [...container.querySelectorAll('[data-testid="gradebook-cell-open"]')].map(a => ({
    href: a.getAttribute('href'),
    text: a.textContent,
    emoji: [...a.querySelectorAll('[data-emoji]')].map(e => e.getAttribute('data-emoji')),
  }));

describe('Emoji | Numbers', () => {
  it('shows emoji until the viewer picks Numbers', async () => {
    await mount();
    expect(cellLinks().find(c => c.href?.endsWith('/sub-ada'))).toMatchObject({
      text: '',
      emoji: ['ok'],
    });
  });

  it('shows the numeric grade under Numbers, remembered in this browser', async () => {
    window.localStorage.setItem('classmoji.gradebook.display', 'numbers');
    await mount();
    expect(cellLinks().find(c => c.href?.endsWith('/sub-ada'))).toMatchObject({
      text: '70',
      emoji: [],
    });
  });
});

describe('Students | Teams', () => {
  it('lists students over every column by default, with totals', async () => {
    await mount();
    const head = container.querySelector('thead')!.textContent!;
    expect(head).toContain('Solo lab');
    expect(head).toContain('Team project');
    expect(head).toContain('Total');
    expect(head).toContain('Letter');
    expect(container.querySelectorAll('[data-testid="gradebook-team-row"]')).toHaveLength(0);
  });

  it('lists one row per team over the group columns only, with no totals or letter', async () => {
    window.localStorage.setItem('classmoji.gradebook.view', 'teams');
    await mount();

    const teamRows = [...container.querySelectorAll('[data-testid="gradebook-team-row"]')];
    expect(teamRows.map(r => r.textContent)).toEqual(['RocketsAda Lovelace, Bob Byte']);

    const head = container.querySelector('thead')!.textContent!;
    expect(head).toContain('Team project');
    expect(head).not.toContain('Solo lab');
    expect(head).not.toContain('Total');
    expect(head).not.toContain('Letter');

    // The team's one submission, once.
    expect(cellLinks().map(c => c.href)).toEqual(['/admin/intro-101/grades/submissions/sub-team']);
  });

  it('falls back to Students where the classroom has no teams', async () => {
    window.localStorage.setItem('classmoji.gradebook.view', 'teams');
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/admin/intro-101/grades']}>
          <Routes>
            <Route path="/admin/:class/grades" element={<GradesTable {...PROPS} teams={[]} />} />
          </Routes>
        </MemoryRouter>
      );
    });
    expect(container.querySelector('thead')!.textContent).toContain('Solo lab');
    expect(container.querySelector('[data-testid="gradebook-view-toggle"]')).toBeNull();
  });
});
