/**
 * The gradebook's repo cells and the submission panel they open. Rendered on
 * the server.
 *
 *   - A graded cell shows its grade as emoji by default (one per grader).
 *   - Every repo cell with a submission links to the panel route, the
 *     gradebook's search params kept; the open one is marked.
 *   - An open regrade request reads "Regrade" in the cell and counts as to
 *     grade in the column header ("N to grade · Start"), a team submission
 *     once; a quiz request links to its resolve modal.
 *   - The panel (child route) gets the walk through the outlet context.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useOutletContext } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { SubmissionPanelOutletContext } from '../gradingWalk';

vi.mock('~/components/features/grading/EmojiGrader', () => ({ default: () => null }));
vi.mock('~/components', () => ({
  UserThumbnailView: ({ user }: { user: { name: string | null } }) => <span>{user.name}</span>,
}));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('~/components/ui/display/Emoji', () => ({
  default: ({ emoji }: { emoji: string }) => <span data-emoji={emoji} />,
}));
vi.mock('../GradeSettings', () => ({ default: () => null }));

const { default: GradesTable, buildTeamRows } = await import('../GradesTable');
type Props = Parameters<typeof GradesTable>[0];
type Student = Props['students'][number];

const MODULE = { id: 'mod-1', title: 'Week 1', position: 0 };
const SCALE = { star: 100, ok: 70 };

const repoColumn = (id: string, type: 'INDIVIDUAL' | 'GROUP' = 'INDIVIDUAL') => ({
  id,
  title: `Lab ${id}`,
  weight: 10,
  is_extra_credit: false,
  type: 'REPO',
  module_id: MODULE.id,
  module_title: MODULE.title,
  repository_id: `r-${id}`,
  repository_type: type,
  created_at: '2026-09-01T00:00:00Z',
});

const submission = (
  id: string,
  assignmentId: string,
  extra: { status?: string; grades?: { id: string; emoji: string }[] } = {}
) => ({
  id,
  assignment_id: assignmentId,
  status: extra.status ?? 'CLOSED',
  closed_at: '2026-09-02T00:00:00Z',
  is_late: false,
  is_late_override: false,
  grades: extra.grades ?? [],
  token_transactions: [],
  assignment: { id: assignmentId, weight: 10, student_deadline: null },
});

const student = (
  id: string,
  name: string,
  repos: { id: string; team_id?: string; assignments: ReturnType<typeof submission>[] }[]
): Student =>
  ({
    id,
    name,
    login: id,
    avatar_url: null,
    git_repos: repos.map(r => ({
      id: r.id,
      name: r.id,
      student_id: r.team_id ? null : id,
      team_id: r.team_id ?? null,
      assignments: r.assignments,
    })),
    quiz_items: [],
  }) as unknown as Student;

const OutletProbe = () => {
  const ctx = useOutletContext<SubmissionPanelOutletContext>();
  return (
    <pre data-testid="probe">
      {JSON.stringify({
        walk: ctx.walk.map(c => c.submissionId),
        gradesHref: ctx.gradesHref,
        next: ctx.panelHref('x'),
      })}
    </pre>
  );
};

const render = (props: Partial<Props>, url = '/admin/intro-101/grades') =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/admin/:class/grades"
          element={
            <GradesTable
              emojiMappings={SCALE}
              modules={[MODULE]}
              assignments={[]}
              students={[]}
              settings={{ late_penalty_points_per_hour: 0 }}
              letterGradeMappings={[]}
              memberships={[]}
              activity={{ quiz: {}, form: {} }}
              {...props}
            />
          }
        >
          <Route path="submissions/:submissionId" element={<OutletProbe />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const probeOf = (html: string) => {
  const match = /data-testid="probe">([\s\S]*?)<\/pre>/.exec(html);
  return match ? JSON.parse(decode(match[1])) : null;
};

describe('gradebook repo cells', () => {
  const ada = student('ada', 'Ada', [
    {
      id: 'repo-ada',
      assignments: [
        submission('sub-ada', 'a1', {
          grades: [
            { id: 'g1', emoji: 'star' },
            { id: 'g2', emoji: 'ok' },
          ],
        }),
      ],
    },
  ]);

  it('shows a graded cell as emoji by default, one per grader, not as a number', () => {
    const html = render({ assignments: [repoColumn('a1')], students: [ada] });

    const cell = /data-testid="gradebook-cell-open"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1];
    expect(cell).toContain('data-testid="gradebook-cell-emoji"');
    expect(cell).toContain('data-emoji="star"');
    expect(cell).toContain('data-emoji="ok"');
    // The number stays in the totals; the cell has none.
    expect(cell!.replace(/<[^>]+>/g, '')).toBe('');
  });

  it('links the cell to the submission panel, keeping the gradebook search params', () => {
    const html = render(
      { assignments: [repoColumn('a1')], students: [ada] },
      '/admin/intro-101/grades?tab=x'
    );

    expect(html).toContain('href="/admin/intro-101/grades/submissions/sub-ada?tab=x"');
  });

  it('marks the open submission and hands the panel the walk', () => {
    const bob = student('bob', 'Bob', [
      { id: 'repo-bob', assignments: [submission('sub-bob', 'a1')] },
    ]);
    const html = render(
      { assignments: [repoColumn('a1')], students: [ada, bob] },
      '/admin/intro-101/grades/submissions/sub-ada'
    );

    // One style rule marks the open cell, keyed on the cell's attribute.
    expect(html).toContain('data-gradebook-cell="sub-ada"');
    expect(html).toMatch(
      /<style>\[data-gradebook-cell="sub-ada"\]\{box-shadow:[^}]*var\(--accent\)\}<\/style>/
    );
    expect(probeOf(html)).toEqual({
      walk: ['sub-ada', 'sub-bob'],
      gradesHref: '/admin/intro-101/grades',
      next: '/admin/intro-101/grades/submissions/x',
    });
  });

  it('reads "Regrade" on a cell with an open request, and counts it in the header', () => {
    const html = render({
      assignments: [repoColumn('a1')],
      students: [ada],
      openRegrades: { submissions: { 'sub-ada': 'req-1' }, quizzes: {} },
    });

    expect(html).toContain('text-violet-700 dark:text-violet-300">Regrade ·<');
    expect(html).toContain('1 to grade · Start');
  });

  it('counts a team submission once in the header', () => {
    const team = {
      id: 'repo-team',
      team_id: 'team-1',
      assignments: [submission('sub-team', 'a1')],
    };
    const html = render({
      assignments: [repoColumn('a1', 'GROUP')],
      students: [student('ada', 'Ada', [team]), student('bob', 'Bob', [team])],
    });

    expect(html).toContain('1 to grade · Start');
  });

  it("links a quiz cell's open request to its resolve modal, beside the cell's own link", () => {
    const html = render({
      assignments: [
        {
          id: 'a-quiz',
          title: 'Quiz',
          weight: 10,
          is_extra_credit: false,
          type: 'QUIZ',
          module_id: MODULE.id,
          quiz_id: 'quiz-1',
        },
      ],
      students: [student('ada', 'Ada', [])],
      openRegrades: { submissions: {}, quizzes: { 'a-quiz': { ada: 'req-q' } } },
    });

    expect(html).toContain('href="/admin/intro-101/regrade-requests?resolve=req-q"');
    // No link inside a link.
    expect(html).not.toMatch(/<a[^>]*>(?:(?!<\/a>)[\s\S])*<a /);
  });
});

describe('buildTeamRows', () => {
  it('makes one row per team with roster members, over the repos they share', () => {
    const team = {
      id: 'repo-team',
      team_id: 'team-1',
      assignments: [submission('sub-team', 'a1')],
    };
    const own = { id: 'repo-ada', assignments: [submission('sub-ada', 'a2')] };
    const rows = buildTeamRows(
      [
        { id: 'team-1', name: 'Rockets', member_ids: ['ada', 'bob', 'not-on-roster'] },
        { id: 'team-2', name: 'Ghosts', member_ids: ['not-on-roster'] },
      ],
      [student('ada', 'Ada', [team, own]), student('bob', 'Bob', [team])]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'team-1',
      name: 'Rockets',
      members: [
        { id: 'ada', name: 'Ada', login: 'ada' },
        { id: 'bob', name: 'Bob', login: 'bob' },
      ],
    });
    // The team's repo once; a member's own repo is not the team's.
    expect(rows[0].git_repos.map(r => (r as { id?: string }).id)).toEqual(['repo-team']);
  });
});
