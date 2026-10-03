/**
 * What the gradebook renders for quiz assignments once quiz grade items join
 * the totals. Rendered on the server.
 *
 *   - A counted zero reads "0 (not attempted)" with the missing tint.
 *   - A late item shows the late-penalised value the totals count, the late
 *     hours, and the late tint (with its dark variant).
 *   - A quiz with a column but no item (not open yet, before the deadline)
 *     keeps its attempt-state render, never "0 (not attempted)".
 *   - Total, module total and the column mean read the item value, so the
 *     header row and the cells agree.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { GradedItem } from '@classmoji/utils';

vi.mock('~/components/features/grading/EmojiGrader', () => ({ default: () => null }));
vi.mock('~/components', () => ({
  UserThumbnailView: ({ user }: { user: { name: string | null } }) => <span>{user.name}</span>,
}));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('../GradeSettings', () => ({ default: () => null }));

const { default: GradesTable } = await import('../GradesTable');

type Props = Parameters<typeof GradesTable>[0];

const MODULE = { id: 'mod-1', title: 'Week 1', position: 0 };

const quizColumn = (id: string, title: string) => ({
  id,
  title,
  weight: 10,
  is_extra_credit: false,
  type: 'QUIZ',
  module_id: MODULE.id,
  module_title: MODULE.title,
  quiz_id: `quiz-${id}`,
  created_at: '2026-09-01T00:00:00Z',
});

const item = (assignmentId: string, extra: Partial<GradedItem> = {}): GradedItem => ({
  assignment_id: assignmentId,
  module_id: MODULE.id,
  weight: 10,
  is_extra_credit: false,
  grade: 72,
  raw_grade: 80,
  counts_as_zero: false,
  late_hours: 4,
  ...extra,
});

const student = (id: string, name: string, quizItems: GradedItem[]) => ({
  id,
  name,
  login: id,
  avatar_url: null,
  git_repos: [],
  quiz_items: quizItems,
});

const render = (props: Partial<Props>) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={['/admin/cs52/grades']}>
      <Routes>
        <Route
          path="/admin/:class/grades"
          element={
            <GradesTable
              emojiMappings={{}}
              modules={[MODULE]}
              assignments={[]}
              students={[]}
              settings={{ late_penalty_points_per_hour: 2 }}
              letterGradeMappings={[]}
              memberships={[]}
              activity={{ quiz: {}, form: {} }}
              {...props}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );

/** The cell text between tags, whitespace-normalised. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('gradebook quiz cells', () => {
  it('renders a counted zero as "0 (not attempted)" with the missing tint', () => {
    const html = render({
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [
        student('s-1', 'Ada', [
          item('a-quiz', { grade: 0, raw_grade: 0, counts_as_zero: true, late_hours: 0 }),
        ]),
      ],
    });

    expect(text(html)).toContain('0 (not attempted)');
    expect(html).toContain('bg-red-50 dark:bg-red-950/30');
  });

  it('renders a late item with the penalised value, its late hours and the late tint', () => {
    const html = render({
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [student('s-1', 'Ada', [item('a-quiz')])],
      // The attempt state says 80 (raw); the cell shows what the totals count.
      activity: { quiz: { 'a-quiz': { 's-1': { completed: true, score: 80 } } }, form: {} },
    });

    expect(text(html)).toContain('72 4h late');
    expect(html).toContain('bg-amber-50 dark:bg-amber-950/30');
  });

  it('keeps the attempt-state render for a quiz column with no item', () => {
    const html = render({
      assignments: [quizColumn('a-quiz', 'Not open yet')],
      students: [student('s-1', 'Ada', [])],
    });

    expect(text(html)).toContain('Not attempted');
    expect(text(html)).not.toContain('0 (not attempted)');
  });
});

describe('gradebook totals with quiz items', () => {
  it('counts the quiz item in the Total, the module total and the column mean', () => {
    const html = render({
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [student('s-1', 'Ada', [item('a-quiz')])],
      activity: { quiz: { 'a-quiz': { 's-1': { completed: true, score: 80 } } }, form: {} },
    });
    const flat = text(html);

    // Column mean and module total in the class row read the item value (72),
    // not the raw attempt score (80).
    expect(flat).toContain('Class 72.0 72.0 mean 72.0');
    expect(flat).not.toContain('80.0');
  });

  it('counts a counted zero in the Total', () => {
    const html = render({
      assignments: [quizColumn('a-quiz', 'Recursion'), quizColumn('a-quiz-2', 'Lists')],
      students: [
        student('s-1', 'Ada', [
          item('a-quiz', { grade: 90, raw_grade: 90, late_hours: 0 }),
          item('a-quiz-2', { grade: 0, raw_grade: 0, counts_as_zero: true, late_hours: 0 }),
        ]),
      ],
    });

    // (90·10 + 0·10) / 20 = 45.
    expect(text(html)).toContain('mean 45.0');
  });
});
