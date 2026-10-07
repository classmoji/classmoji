/**
 * The grade line a student is shown (`gradeSummaryForStudent`), the one entry
 * point the student dashboard and MCP `my_grades` share: the final grade once
 * the owner released final grades, else the released-only estimate where it is
 * on, else nothing. The grade math is the real `@classmoji/utils` code; only
 * the reads are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findEmojiMappings: vi.fn(),
  findLetterGradeMappings: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  loadQuizGradeItems: vi.fn(),
}));

vi.mock('../emojiMapping.service.ts', () => ({
  findByClassroomId: (...a: unknown[]) => mocks.findEmojiMappings(...a),
}));
vi.mock('../letterGradeMapping.service.ts', () => ({
  findByClassroomId: (...a: unknown[]) => mocks.findLetterGradeMappings(...a),
}));
vi.mock('../entitlement.service.ts', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
}));
vi.mock('../quizGradeItems.service.ts', () => ({
  loadQuizGradeItems: (...a: unknown[]) => mocks.loadQuizGradeItems(...a),
}));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

const { gradeSummaryForStudent, showsGradeSummary } = await import('../helper.service.ts');

const LETTERS = [
  { letter_grade: 'A', min_grade: 90 },
  { letter_grade: 'B', min_grade: 80 },
  { letter_grade: 'C', min_grade: 70 },
];

/** One submission: a graded REPO assignment, released or not. */
const submission = (id: string, emoji: string, released: boolean) => ({
  id,
  grades: [{ emoji }],
  num_late_hours: 0,
  is_late_override: false,
  assignment: { weight: 50, is_extra_credit: false, type: 'REPO', grades_released: released },
});

// Released: an 80. Unreleased: a 100. The estimate sees 80 (B); the final
// grade sees all graded work, 90 (A).
const SUBMISSIONS = [submission('ra-1', 'eyes', true), submission('ra-2', 'heart', false)];

const call = (
  settings: Record<string, unknown> | null,
  { role = 'STUDENT', letterOverride = null as string | null } = {}
) =>
  gradeSummaryForStudent({
    role,
    classroomId: 'class-1',
    userId: 'student-1',
    submissions: SUBMISSIONS,
    letterOverride,
    settings,
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findEmojiMappings.mockResolvedValue({ heart: 100, eyes: 80 });
  mocks.findLetterGradeMappings.mockResolvedValue(LETTERS);
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.loadQuizGradeItems.mockResolvedValue(new Map());
});

describe('gradeSummaryForStudent', () => {
  it('shows the released final grade: the letter over all graded work', async () => {
    expect(await call({ final_grades_released: true })).toEqual({ kind: 'final', letter: 'A' });
  });

  it('shows the override as the final grade once released', async () => {
    expect(await call({ final_grades_released: true }, { letterOverride: 'C+' })).toEqual({
      kind: 'final',
      letter: 'C+',
    });
  });

  it('shows the final grade in place of the estimate when both are on', async () => {
    expect(
      await call(
        { final_grades_released: true, show_grades_to_students: true },
        { letterOverride: 'B+' }
      )
    ).toEqual({ kind: 'final', letter: 'B+' });
  });

  it('before release, estimates from released work only and never reads the override', async () => {
    expect(
      await call(
        { show_grades_to_students: true, final_grades_released: false },
        { letterOverride: 'A+' }
      )
    ).toEqual({ kind: 'letter', letter: 'B', count: 1 });
  });

  it('falls back to the estimate when released but the student has no final grade', async () => {
    // No letter scale and no override: the Letter column shows none.
    mocks.findLetterGradeMappings.mockResolvedValue([]);

    expect(await call({ final_grades_released: true, show_grades_to_students: true })).toEqual({
      kind: 'emoji',
      emoji: 'eyes',
      count: 1,
    });
    expect(await call({ final_grades_released: true })).toBeNull();
  });

  it('applies the late penalty from the settings it is handed', async () => {
    const late = { ...submission('ra-3', 'heart', true), num_late_hours: 3 };
    const summary = await gradeSummaryForStudent({
      role: 'STUDENT',
      classroomId: 'class-1',
      userId: 'student-1',
      submissions: [late],
      letterOverride: null,
      settings: { final_grades_released: true, late_penalty_points_per_hour: 5 },
    });
    // 100 − 3 × 5 = 85.
    expect(summary).toEqual({ kind: 'final', letter: 'B' });
  });

  it("counts the student's quiz items under the classroom's quiz visibility", async () => {
    mocks.loadQuizGradeItems.mockResolvedValue(
      new Map([
        [
          'student-1',
          [
            {
              assignment_id: 'q1',
              module_id: 'm1',
              weight: 100,
              is_extra_credit: false,
              grade: 0,
              raw_grade: 0,
              counts_as_zero: true,
              late_hours: 0,
              counting_raw_percentage: null,
            },
          ],
        ],
      ])
    );

    // (80·50 + 100·50 + 0·100) / 200 = 45.
    expect(await call({ final_grades_released: true })).toEqual({ kind: 'final', letter: 'F' });
    expect(mocks.loadQuizGradeItems).toHaveBeenCalledWith({
      classroomId: 'class-1',
      quizzesVisible: true,
      userIds: ['student-1'],
    });
  });

  it('reads nothing and shows nothing when both settings are off', async () => {
    for (const settings of [
      null,
      {},
      { show_grades_to_students: false, final_grades_released: false },
    ]) {
      expect(await call(settings, { letterOverride: 'A' })).toBeNull();
    }
    expect(mocks.findEmojiMappings).not.toHaveBeenCalled();
    expect(mocks.findLetterGradeMappings).not.toHaveBeenCalled();
    expect(mocks.quizzesVisibleOrThrow).not.toHaveBeenCalled();
  });

  it('reads nothing and shows staff nothing', async () => {
    for (const role of ['OWNER', 'TEACHER', 'ASSISTANT', null]) {
      expect(
        await call(
          { final_grades_released: true, show_grades_to_students: true },
          { role: role as string }
        )
      ).toBeNull();
    }
    expect(mocks.findEmojiMappings).not.toHaveBeenCalled();
  });

  it('throws when a read fails rather than dropping the quizzes', async () => {
    mocks.quizzesVisibleOrThrow.mockRejectedValue(new Error('lookup failed'));

    await expect(call({ final_grades_released: true })).rejects.toThrow('lookup failed');
  });
});

describe('showsGradeSummary', () => {
  it('holds for a student where either setting is on', () => {
    expect(showsGradeSummary('STUDENT', { final_grades_released: true })).toBe(true);
    expect(showsGradeSummary('STUDENT', { show_grades_to_students: true })).toBe(true);
    expect(showsGradeSummary('STUDENT', {})).toBe(false);
    expect(showsGradeSummary('STUDENT', null)).toBe(false);
    expect(
      showsGradeSummary('TEACHER', { final_grades_released: true, show_grades_to_students: true })
    ).toBe(false);
  });
});
