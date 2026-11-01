/**
 * The gradebook CSV: which rows and columns it has, that each value is the
 * number the gradebook computes with (ungraded blank, never 0), that every read
 * is scoped by the classroom it was handed, and that text cannot run as a
 * spreadsheet formula.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRepositoriesPerStudent: vi.fn(),
  findEmojiMappings: vi.fn(),
  findLetterGradeMappings: vi.fn(),
  findMemberships: vi.fn(),
  listForClassroom: vi.fn(),
  getSettings: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  loadQuizGradeItems: vi.fn(),
}));

vi.mock('../user.service.ts', () => ({
  findRepositoriesPerStudent: mocks.findRepositoriesPerStudent,
}));
vi.mock('../emojiMapping.service.ts', () => ({ findByClassroomId: mocks.findEmojiMappings }));
vi.mock('../letterGradeMapping.service.ts', () => ({
  findByClassroomId: mocks.findLetterGradeMappings,
}));
vi.mock('../classroomMembership.service.ts', () => ({ findByClassroomId: mocks.findMemberships }));
vi.mock('../assignment.service.ts', () => ({ listForClassroom: mocks.listForClassroom }));
vi.mock('../classroom.service.ts', () => ({ getClassroomSettingsForServer: mocks.getSettings }));
vi.mock('../entitlement.service.ts', () => ({
  quizzesVisibleOrThrow: mocks.quizzesVisibleOrThrow,
}));
vi.mock('../quizGradeItems.service.ts', () => ({ loadQuizGradeItems: mocks.loadQuizGradeItems }));

const { buildGradebookExport, csvCell, toCsv } = await import('../gradebookExport.service.ts');

const CLASSROOM = { id: 'class-x', slug: 'intro-x' };

const assignment = (
  id: string,
  title: string,
  type: 'REPO' | 'QUIZ' | 'FORM',
  position = 1,
  created = '2026-09-01'
) => ({ id, title, type, module: { position }, created_at: new Date(created) });

const submission = (assignmentId: string, emojis: string[], weight = 50) => ({
  assignment_id: assignmentId,
  assignment: { id: assignmentId, type: 'REPO', weight, is_extra_credit: false },
  grades: emojis.map(emoji => ({ emoji })),
  num_late_hours: 0,
  is_late_override: false,
});

const student = (id: string, name: string, subs: ReturnType<typeof submission>[] = []) => ({
  id,
  name,
  login: name.toLowerCase(),
  email: `${name.toLowerCase()}@school.edu`,
  school_id: `ID-${id}`,
  git_repos: [{ repository: { type: 'INDIVIDUAL' }, assignments: subs }],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.findEmojiMappings.mockResolvedValue({ '🔥': 100, '👍': 80 });
  mocks.findLetterGradeMappings.mockResolvedValue([
    { letter_grade: 'A', min_grade: 90 },
    { letter_grade: 'B', min_grade: 80 },
  ]);
  mocks.getSettings.mockResolvedValue({ late_penalty_points_per_hour: 0 });
  mocks.listForClassroom.mockResolvedValue([
    assignment('a2', 'Lab 2', 'REPO', 1, '2026-09-08'),
    assignment('a1', 'Lab 1', 'REPO', 1, '2026-09-01'),
    assignment('q1', 'Quiz 1', 'QUIZ', 2),
    assignment('f1', 'Survey', 'FORM', 2),
  ]);
  mocks.findRepositoriesPerStudent.mockResolvedValue([
    student('u1', 'Ada', [submission('a1', ['🔥']), submission('a2', ['👍'])]),
    student('u2', 'Bob', [submission('a1', [])]),
    // In a team repo but no longer a student here: not a row.
    student('u3', 'Gone', [submission('a1', ['🔥'])]),
  ]);
  mocks.findMemberships.mockResolvedValue([
    { user_id: 'u1', letter_grade: null },
    { user_id: 'u2', letter_grade: 'C' },
  ]);
  mocks.loadQuizGradeItems.mockResolvedValue(
    new Map([
      [
        'u1',
        [
          {
            assignment_id: 'q1',
            module_id: 'm2',
            weight: 0,
            is_extra_credit: false,
            grade: 75,
            raw_grade: 75,
            counts_as_zero: false,
          },
        ],
      ],
    ])
  );
});

describe('buildGradebookExport', () => {
  it('scopes every read by the classroom it was handed', async () => {
    await buildGradebookExport(CLASSROOM);

    expect(mocks.findRepositoriesPerStudent).toHaveBeenCalledWith(CLASSROOM);
    expect(mocks.findMemberships).toHaveBeenCalledWith('class-x', 'STUDENT');
    expect(mocks.listForClassroom).toHaveBeenCalledWith('class-x', { publishedOnly: true });
    expect(mocks.loadQuizGradeItems).toHaveBeenCalledWith({
      classroomId: 'class-x',
      quizzesVisible: true,
    });
    for (const fn of [mocks.findEmojiMappings, mocks.findLetterGradeMappings, mocks.getSettings]) {
      expect(fn).toHaveBeenCalledWith('class-x');
    }
  });

  it('has graded assignments in gradebook order, and no form columns', async () => {
    const { headers } = await buildGradebookExport(CLASSROOM);

    expect(headers).toEqual([
      'Name',
      'Git Username',
      'Email',
      'School ID',
      'Lab 1',
      'Lab 2',
      'Quiz 1',
      'Course Grade',
      'Letter Grade',
    ]);
  });

  it('lists current students only, with numbers, blanks for ungraded, and the override', async () => {
    const { rows, studentCount } = await buildGradebookExport(CLASSROOM);

    expect(studentCount).toBe(2);
    expect(rows).toEqual([
      ['Ada', 'ada', 'ada@school.edu', 'ID-u1', 100, 80, 75, 90, 'A'],
      // Ungraded is blank, never 0; the staff letter override wins.
      ['Bob', 'bob', 'bob@school.edu', 'ID-u2', null, null, null, null, 'C'],
    ]);
  });

  it('drops quiz columns where the classroom hides quizzes', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);
    const { headers } = await buildGradebookExport(CLASSROOM);

    expect(headers).not.toContain('Quiz 1');
  });

  it('tells repeated titles apart', async () => {
    mocks.listForClassroom.mockResolvedValue([
      assignment('a1', 'Lab', 'REPO', 1, '2026-09-01'),
      assignment('a2', 'Lab', 'REPO', 1, '2026-09-08'),
    ]);
    const { headers } = await buildGradebookExport(CLASSROOM);

    expect(headers.slice(4, 6)).toEqual(['Lab', 'Lab (2)']);
  });
});

describe('csv', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('Lovelace, Ada')).toBe('"Lovelace, Ada"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('defuses text a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });

  it('writes numbers as they are and null as an empty cell', () => {
    expect(csvCell(91.4)).toBe('91.4');
    expect(csvCell(null)).toBe('');
    expect(toCsv({ headers: ['A', 'B'], rows: [[1, null]] })).toBe('A,B\r\n1,\r\n');
  });
});
