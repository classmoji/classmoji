/**
 * What the gradebook renders for quiz assignments once quiz grade items join
 * the totals. Rendered on the server.
 *
 *   - A counted zero reads "Missing" with the missing tint (a running attempt
 *     past the deadline is one too).
 *   - A late item shows the late-penalised value the totals count as the
 *     classroom's emoji (never the number, E1), the late hours, and the late
 *     tint (with its dark variant); an adjusted counting attempt gets the
 *     "adjusted" chip (D8).
 *   - A quiz with a column but no item keeps its attempt-state render (before
 *     the deadline), or reads "Opens <date>" while it has not opened yet.
 *   - "Has something to grade" matches a quiz whose score is still to come.
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
vi.mock('~/components/ui/display/Emoji', () => ({
  default: ({ emoji }: { emoji: string }) => <span data-emoji={emoji} />,
}));
vi.mock('../GradeSettings', () => ({ default: () => null }));

const { default: GradesTable, matchesRowFilter } = await import('../GradesTable');

type Props = Parameters<typeof GradesTable>[0];

const MODULE = { id: 'mod-1', title: 'Week 1', position: 0 };

const quizColumn = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  weight: 10,
  is_extra_credit: false,
  type: 'QUIZ',
  module_id: MODULE.id,
  module_title: MODULE.title,
  quiz_id: `quiz-${id}`,
  created_at: '2026-09-01T00:00:00Z',
  ...extra,
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
  counting_raw_percentage: 80,
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
    <MemoryRouter initialEntries={['/admin/intro-101/grades']}>
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

/** The numeric scale: score-0 … score-100 in tens. */
const NUMERIC_SCALE = Object.fromEntries(
  Array.from({ length: 11 }, (_, i) => [`score-${i * 10}`, i * 10])
);

/** The quiz cell: the link to the quiz results page. */
const cellOf = (html: string) => {
  const match = /<a[^>]*href="\/admin\/intro-101\/quizzes\/quiz-a-quiz"[^>]*>([\s\S]*?)<\/a>/.exec(
    html
  );
  return match?.[1] ?? '';
};

/** The red Missing chip of a cell (the legend under the table says "Missing" too). */
const MISSING_CHIP = 'text-red-700 dark:text-red-300">Missing<';

describe('gradebook quiz cells', () => {
  const zero = (assignmentId: string) =>
    item(assignmentId, {
      grade: 0,
      raw_grade: 0,
      counts_as_zero: true,
      late_hours: 0,
      counting_raw_percentage: null,
    });

  it('renders a counted zero as "Missing" with the missing tint', () => {
    const html = render({
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [student('s-1', 'Ada', [zero('a-quiz')])],
    });

    expect(html).toContain(MISSING_CHIP);
    expect(text(html)).not.toContain('not attempted');
    expect(html).toContain('bg-red-50 dark:bg-red-950/30');
  });

  it('reads "Missing", not "In progress", for a counted zero with a running attempt', () => {
    const html = render({
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [student('s-1', 'Ada', [zero('a-quiz')])],
      activity: { quiz: { 'a-quiz': { 's-1': { completed: false, emoji: null } } }, form: {} },
    });

    expect(html).toContain(MISSING_CHIP);
    expect(text(html)).not.toContain('In progress');
  });

  it('reads "Opens <date>" for a quiz that has not opened yet', () => {
    const html = render({
      assignments: [quizColumn('a-quiz', 'Later', { release_at: '2099-05-04T12:00:00Z' })],
      students: [student('s-1', 'Ada', [])],
    });

    expect(text(html)).toContain('Opens May 4');
    expect(text(html)).not.toContain('Not attempted');
  });

  it('a past release date is no "Opens" cell', () => {
    const html = render({
      assignments: [quizColumn('a-quiz', 'Open', { release_at: '2020-01-01T00:00:00Z' })],
      students: [student('s-1', 'Ada', [])],
    });

    expect(text(html)).not.toContain('Opens');
    expect(text(html)).toContain('Not attempted');
  });

  it('renders a late item as the emoji of the penalised value, its late hours and the late tint', () => {
    const html = render({
      emojiMappings: NUMERIC_SCALE,
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [student('s-1', 'Ada', [item('a-quiz')])],
      // The attempt state says 80 (raw); the cell shows what the totals count.
      activity: { quiz: { 'a-quiz': { 's-1': { completed: true, emoji: 'score-80' } } }, form: {} },
    });

    // 72 counts: the nearest badge is score-70. No number in the cell.
    expect(cellOf(html)).toContain('data-emoji="score-70"');
    expect(cellOf(html)).not.toMatch(/>\s*72(\.0)?\s*</);
    expect(text(cellOf(html))).toContain('4h late');
    expect(html).not.toContain('quiz-grade-adjusted');
    expect(html).toContain('bg-amber-50 dark:bg-amber-950/30');
  });

  it('marks an adjusted counting attempt with the "adjusted" chip', () => {
    const html = render({
      emojiMappings: NUMERIC_SCALE,
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [
        student('s-1', 'Ada', [
          item('a-quiz', {
            grade: 90,
            raw_grade: 90,
            late_hours: 0,
            counting_raw_percentage: 90,
            counting_adjusted: true,
          }),
        ]),
      ],
    });

    expect(cellOf(html)).toContain('data-emoji="score-90"');
    expect(cellOf(html)).toContain('quiz-grade-adjusted');
    expect(text(cellOf(html))).not.toContain('late');
  });

  it('shows the emoji staff picked on an adjusted, on-time attempt, not the nearest to its value', () => {
    // Two scale entries share 90; the pick is the one staff chose.
    const scale = { rocket: 100, '+1': 90, tada: 90, eyes: 80 };
    const html = render({
      emojiMappings: scale,
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [
        student('s-1', 'Ada', [
          item('a-quiz', {
            grade: 90,
            raw_grade: 90,
            late_hours: 0,
            counting_raw_percentage: 90,
            counting_adjusted: true,
            counting_adjusted_emoji: 'tada',
          }),
        ]),
      ],
    });
    expect(cellOf(html)).toContain('data-emoji="tada"');
    expect(cellOf(html)).not.toContain('data-emoji="+1"');

    // Late: the penalised value's nearest emoji, as before.
    const late = render({
      emojiMappings: scale,
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [
        student('s-1', 'Ada', [
          item('a-quiz', {
            grade: 80,
            raw_grade: 90,
            late_hours: 5,
            counting_raw_percentage: 90,
            counting_adjusted: true,
            counting_adjusted_emoji: 'tada',
          }),
        ]),
      ],
    });
    expect(cellOf(late)).toContain('data-emoji="eyes"');
  });

  it('reads a scored grade with no grading scale as a dash that says so', () => {
    const withItem = render({
      emojiMappings: {},
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [student('s-1', 'Ada', [item('a-quiz', { late_hours: 0 })])],
    });
    expect(cellOf(withItem)).toContain('quiz-grade-no-scale');

    const noItem = render({
      emojiMappings: {},
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [student('s-1', 'Ada', [])],
      activity: {
        quiz: { 'a-quiz': { 's-1': { completed: true, scored: true, emoji: null } } },
        form: {},
      },
    });
    expect(cellOf(noItem)).toContain('quiz-grade-no-scale');
    expect(text(cellOf(noItem))).not.toContain('Completed');

    // Unscored (the AI has not graded it yet) still reads Completed.
    const unscored = render({
      emojiMappings: {},
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [student('s-1', 'Ada', [])],
      activity: {
        quiz: { 'a-quiz': { 's-1': { completed: true, scored: false, emoji: null } } },
        form: {},
      },
    });
    expect(text(cellOf(unscored))).toContain('Completed');
  });

  it('shows the emoji of the counting attempt for a scored quiz with no item yet', () => {
    const html = render({
      emojiMappings: NUMERIC_SCALE,
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [student('s-1', 'Ada', [])],
      activity: { quiz: { 'a-quiz': { 's-1': { completed: true, emoji: 'score-80' } } }, form: {} },
    });

    expect(html).toContain('data-emoji="score-80"');
  });

  it('keeps the attempt-state render for a quiz column with no item', () => {
    const html = render({
      assignments: [quizColumn('a-quiz', 'Not open yet')],
      students: [student('s-1', 'Ada', [])],
    });

    expect(text(html)).toContain('Not attempted');
    expect(html).not.toContain(MISSING_CHIP);
  });
});

describe('gradebook row filters', () => {
  const columns = [quizColumn('a-quiz', 'Recursion')] as Parameters<typeof matchesRowFilter>[2];
  const ada = student('s-1', 'Ada', []);
  const activityWith = (state: { completed: boolean; emoji: string | null }) => ({
    quiz: { 'a-quiz': { 's-1': state } },
    form: {},
  });

  it('"Has something to grade" matches a quiz with only unscored completed attempts', () => {
    expect(
      matchesRowFilter(ada, 'ungraded', columns, activityWith({ completed: true, emoji: null }))
    ).toBe(true);
  });

  it('but not a running attempt, a scored one, or a counted zero', () => {
    expect(
      matchesRowFilter(ada, 'ungraded', columns, activityWith({ completed: false, emoji: null }))
    ).toBe(false);
    expect(
      matchesRowFilter(
        student('s-1', 'Ada', [item('a-quiz')]),
        'ungraded',
        columns,
        activityWith({ completed: true, emoji: 'score-80' })
      )
    ).toBe(false);
    expect(
      matchesRowFilter(
        student('s-1', 'Ada', [
          item('a-quiz', { grade: 0, raw_grade: 0, counts_as_zero: true, late_hours: 0 }),
        ]),
        'ungraded',
        columns,
        { quiz: {}, form: {} }
      )
    ).toBe(false);
  });

  it('"missing" and "late" read the quiz items', () => {
    const zeroed = student('s-1', 'Ada', [
      item('a-quiz', { grade: 0, raw_grade: 0, counts_as_zero: true, late_hours: 0 }),
    ]);
    expect(matchesRowFilter(zeroed, 'missing', columns, { quiz: {}, form: {} })).toBe(true);
    expect(
      matchesRowFilter(student('s-1', 'Ada', [item('a-quiz')]), 'late', columns, {
        quiz: {},
        form: {},
      })
    ).toBe(true);
  });
});

describe('gradebook totals with quiz items', () => {
  it('counts the quiz item in the Total, the module total and the column mean', () => {
    const html = render({
      assignments: [quizColumn('a-quiz', 'Recursion')],
      students: [student('s-1', 'Ada', [item('a-quiz')])],
      activity: { quiz: { 'a-quiz': { 's-1': { completed: true, emoji: 'score-80' } } }, form: {} },
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

describe('gradebook Letter column', () => {
  const LETTERS = [
    { letter_grade: 'A', min_grade: 90 },
    { letter_grade: 'B', min_grade: 80 },
    { letter_grade: 'C', min_grade: 70 },
  ];
  const graded = [item('a-quiz', { grade: 85, raw_grade: 85, late_hours: 0 })];
  const props = {
    assignments: [quizColumn('a-quiz', 'Recursion')],
    students: [student('s-1', 'Ada', graded)],
    letterGradeMappings: LETTERS,
  };
  /** The Letter cell's chip: its colour classes, then the letter. */
  const chip = (colour: string, letter: string) =>
    new RegExp(`bg-${colour}-50 text-${colour}-700 [^"]*"[^>]*>${letter}<`);
  const GREEN_B = chip('green', 'B');

  it('shows the letter for the final grade, green', () => {
    expect(render(props)).toMatch(GREEN_B);
  });

  it('shows the override instead, amber', () => {
    const html = render({
      ...props,
      memberships: [{ id: 'm-1', user_id: 's-1', letter_grade: 'A-' }],
    });

    expect(html).toMatch(chip('amber', 'A-'));
    expect(html).not.toMatch(GREEN_B);
  });

  it('reads bands in descending order whatever order they arrive in', () => {
    expect(render({ ...props, letterGradeMappings: [...LETTERS].reverse() })).toMatch(GREEN_B);
  });
});
