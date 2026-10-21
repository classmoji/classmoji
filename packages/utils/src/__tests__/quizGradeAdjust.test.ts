import { describe, it, expect } from 'vitest';
import {
  countingQuizAttempt,
  effectivePercentage,
  quizAttemptGrade,
  quizPercentageEmoji,
  quizStanding,
  type ScorableQuizAttempt,
} from '../quizScore.ts';
import {
  countingQuizScore,
  quizGradeItem,
  quizItemEmoji,
  type QuizGradeAssignment,
} from '../quizGrade.ts';
import { estimateStudentGrade } from '../grades.ts';
import { SCORE_EMOJI_MAPPINGS } from '../emojis.ts';

const EMOJI_SCALE = { rocket: 100, '+1': 90, eyes: 80, '-1': 60, sob: 0 };
const NUMERIC_SCALE = Object.fromEntries(SCORE_EMOJI_MAPPINGS.map(m => [m.emoji, m.grade]));

const DEADLINE = '2026-10-01T12:00:00Z';
const H = 60 * 60 * 1000;
const at = (hoursAfterDeadline: number) =>
  new Date(new Date(DEADLINE).getTime() + hoursAfterDeadline * H);

const attempt = (
  id: string,
  startedAt: Date,
  completedAt: Date | null,
  pct: number | null,
  adjusted: string | null = null
): ScorableQuizAttempt => ({
  id,
  started_at: startedAt,
  completed_at: completedAt,
  partial_credit_percentage: pct,
  adjusted_emoji: adjusted,
});

describe('effectivePercentage', () => {
  it('is the AI score without an adjustment', () => {
    expect(
      effectivePercentage({ partial_credit_percentage: 72, adjusted_emoji: null }, EMOJI_SCALE)
    ).toBe(72);
    expect(
      effectivePercentage({ partial_credit_percentage: null, adjusted_emoji: null }, EMOJI_SCALE)
    ).toBeNull();
  });

  it('reads an adjustment through the scale', () => {
    expect(
      effectivePercentage({ partial_credit_percentage: 72, adjusted_emoji: '+1' }, EMOJI_SCALE)
    ).toBe(90);
    // An unscored attempt with an adjustment is scored.
    expect(
      effectivePercentage({ partial_credit_percentage: null, adjusted_emoji: 'sob' }, EMOJI_SCALE)
    ).toBe(0);
  });

  it('works on the numeric scale (score-N badges are the mapping keys)', () => {
    expect(
      effectivePercentage(
        { partial_credit_percentage: 41, adjusted_emoji: 'score-70' },
        NUMERIC_SCALE
      )
    ).toBe(70);
  });

  it('falls back to the AI score when the emoji has left the scale', () => {
    expect(
      effectivePercentage({ partial_credit_percentage: 72, adjusted_emoji: 'heart' }, EMOJI_SCALE)
    ).toBe(72);
    expect(effectivePercentage({ partial_credit_percentage: 72, adjusted_emoji: '+1' }, {})).toBe(
      72
    );
  });
});

describe('quizAttemptGrade (display)', () => {
  it('shows the original as the nearest emoji and the adjustment as its own emoji', () => {
    const grade = quizAttemptGrade(
      { partial_credit_percentage: 72, adjusted_emoji: '+1' },
      EMOJI_SCALE
    );
    expect(grade.original).toMatchObject({ percentage: 72, emoji: 'eyes' });
    expect(grade.effective).toMatchObject({ percentage: 90, emoji: '+1' });
    expect(grade.adjusted).toBe(true);
  });

  it('the band follows the effective score (D9)', () => {
    const grade = quizAttemptGrade(
      { partial_credit_percentage: 40, adjusted_emoji: 'rocket' },
      EMOJI_SCALE
    );
    expect(grade.original.band?.evaluation).toBe('UNSATISFACTORY');
    expect(grade.effective.band?.evaluation).toBe('EXCELLENT');
  });

  it('keeps the adjusted emoji even when another emoji shares its grade', () => {
    const scale = { b_same: 90, a_same: 90, sob: 0 };
    // gradeToEmoji(90) would pick 'a_same' by name; the stored emoji wins.
    const grade = quizAttemptGrade(
      { partial_credit_percentage: 10, adjusted_emoji: 'b_same' },
      scale
    );
    expect(grade.effective.emoji).toBe('b_same');
  });

  it('keeps the tie rule for the original (E5): halfway goes up', () => {
    expect(quizPercentageEmoji(85, EMOJI_SCALE)).toBe('+1');
  });

  it('shows score-N badges on the numeric scale', () => {
    const grade = quizAttemptGrade(
      { partial_credit_percentage: 64, adjusted_emoji: 'score-80' },
      NUMERIC_SCALE
    );
    expect(grade.original.emoji).toBe('score-60');
    expect(grade.effective.emoji).toBe('score-80');
  });

  it('an orphaned adjustment is not in effect', () => {
    const grade = quizAttemptGrade(
      { partial_credit_percentage: 72, adjusted_emoji: 'heart' },
      EMOJI_SCALE
    );
    expect(grade.adjusted).toBe(false);
    expect(grade.adjusted_emoji).toBe('heart');
    expect(grade.effective).toEqual(grade.original);
  });

  it('an empty scale gives no emoji', () => {
    expect(
      quizAttemptGrade({ partial_credit_percentage: 72, adjusted_emoji: null }, {}).effective.emoji
    ).toBeNull();
  });
});

describe('counting attempt over effective scores (D3)', () => {
  it('HIGHEST: an adjusted attempt can become the one that counts', () => {
    const a = attempt('a', at(-5), at(-4), 70);
    const b = attempt('b', at(-3), at(-2), 60, 'rocket');
    expect(countingQuizAttempt([a, b], 'HIGHEST', EMOJI_SCALE)?.id).toBe('b');
    expect(quizStanding([a, b], 'HIGHEST', EMOJI_SCALE).score).toBe(100);
  });

  it('HIGHEST: an adjustment down can hand the count to another attempt', () => {
    const a = attempt('a', at(-5), at(-4), 95, '-1');
    const b = attempt('b', at(-3), at(-2), 80);
    expect(countingQuizAttempt([a, b], 'HIGHEST', EMOJI_SCALE)?.id).toBe('b');
  });

  it('MOST_RECENT / FIRST still pick by time', () => {
    const a = attempt('a', at(-5), at(-4), 70, 'rocket');
    const b = attempt('b', at(-3), at(-2), 60);
    expect(countingQuizAttempt([a, b], 'MOST_RECENT', EMOJI_SCALE)?.id).toBe('b');
    expect(countingQuizAttempt([a, b], 'FIRST', EMOJI_SCALE)?.id).toBe('a');
  });

  it('an unscored completed attempt with an adjustment is scored', () => {
    const a = attempt('a', at(-5), at(-4), null, 'eyes');
    expect(countingQuizAttempt([a], 'HIGHEST', EMOJI_SCALE)?.id).toBe('a');
  });
});

describe('late penalty after the adjustment (D2)', () => {
  it('penalises the adjusted value', () => {
    // 2 h late at 5/h, adjusted to 90 → 80.
    const a = attempt('a', at(0), at(2), 50, '+1');
    const score = countingQuizScore([a], 'HIGHEST', {
      studentDeadline: DEADLINE,
      latePenaltyPerHour: 5,
      emojiScale: EMOJI_SCALE,
    });
    expect(score).toMatchObject({
      grade: 80,
      raw_grade: 90,
      raw_percentage: 90,
      original_percentage: 50,
      adjusted: true,
      adjusted_emoji: '+1',
      late_hours: 2,
    });
    expect(score.counting).toBe(a);
  });

  it('the grade item carries the effective, penalised value and the adjusted flag', () => {
    const assignment: QuizGradeAssignment = {
      id: 'asg',
      module_id: 'mod',
      type: 'QUIZ',
      is_published: true,
      release_at: null,
      weight: 10,
      is_extra_credit: false,
      student_deadline: DEADLINE,
    };
    const item = quizGradeItem({
      assignment,
      gradingStrategy: 'HIGHEST',
      attempts: [attempt('a', at(0), at(2), 50, 'score-90')],
      latePenaltyPerHour: 5,
      emojiScale: NUMERIC_SCALE,
      quizzesVisible: true,
      now: at(48),
    });
    expect(item).toMatchObject({
      grade: 80,
      raw_grade: 90,
      counting_raw_percentage: 90,
      counting_attempt_id: 'a',
      counting_adjusted: true,
      counting_adjusted_emoji: 'score-90',
    });

    // The estimate reads the effective value.
    const estimate = estimateStudentGrade({
      submissions: [],
      items: item ? [item] : [],
      emojiMappings: NUMERIC_SCALE,
      settings: { late_penalty_points_per_hour: 5 },
      letterGradeMappings: [],
    });
    expect(estimate).toMatchObject({ kind: 'emoji', emoji: 'score-80' });
  });
});

describe('quizItemEmoji (the gradebook cell)', () => {
  // Two entries share 90: the staff pick is shown as picked.
  const SCALE = { rocket: 100, '+1': 90, tada: 90, eyes: 80 };
  const base = {
    counts_as_zero: false,
    counting_adjusted: true,
    counting_adjusted_emoji: 'tada',
    counting_raw_percentage: 90,
  };

  it('is the emoji staff picked on an adjusted attempt the penalty did not lower', () => {
    expect(quizItemEmoji(base, 90, SCALE)).toBe('tada');
  });

  it('keeps the pick on a late attempt when the penalty took nothing off (no late penalty)', () => {
    // Three hours late, but nothing came off: 90 still counts. The nearest
    // emoji to 90 is '+1' by the tie rule; the pick was 'tada'.
    const lateNoPenalty = { ...base, late_hours: 3 };
    expect(quizItemEmoji(lateNoPenalty, 90, SCALE)).toBe('tada');
    expect(quizItemEmoji({ ...lateNoPenalty, counting_adjusted: false }, 90, SCALE)).toBe('+1');
  });

  it('is the penalised value as the nearest emoji when the penalty lowered it', () => {
    expect(quizItemEmoji(base, 80, SCALE)).toBe('eyes');
  });

  it('is the nearest emoji without an adjustment, or when its emoji left the scale', () => {
    expect(
      quizItemEmoji({ ...base, counting_adjusted: false, counting_raw_percentage: 100 }, 100, SCALE)
    ).toBe('rocket');
    expect(
      quizItemEmoji(
        { ...base, counting_adjusted_emoji: 'gone', counting_raw_percentage: 80 },
        80,
        SCALE
      )
    ).toBe('eyes');
  });

  it('is null on an empty scale', () => {
    expect(quizItemEmoji(base, 90, {})).toBeNull();
  });
});
