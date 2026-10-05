import { describe, it, expect } from 'vitest';
import {
  countingQuizScore,
  effectiveDeadline,
  lateHours,
  quizGradeItem,
  type QuizGradeAssignment,
} from '../quizGrade.ts';
import type { ScorableQuizAttempt } from '../quizScore.ts';

const DEADLINE = '2026-10-01T12:00:00Z';
const H = 60 * 60 * 1000;
const at = (hoursAfterDeadline: number, minutes = 0) =>
  new Date(new Date(DEADLINE).getTime() + hoursAfterDeadline * H + minutes * 60 * 1000);

const attempt = (
  id: string,
  startedAt: Date,
  completedAt: Date | null,
  pct: number | null
): ScorableQuizAttempt => ({
  id,
  started_at: startedAt,
  completed_at: completedAt,
  partial_credit_percentage: pct,
});

describe('effectiveDeadline', () => {
  it('is null without a deadline', () => {
    expect(effectiveDeadline(null, 5)).toBeNull();
    expect(effectiveDeadline(undefined)).toBeNull();
  });

  it('adds the net hours bought', () => {
    expect(effectiveDeadline(DEADLINE, 3)).toEqual(at(3));
  });

  it('never moves the deadline earlier on a negative net', () => {
    expect(effectiveDeadline(DEADLINE, -2)).toEqual(at(0));
  });
});

describe('lateHours', () => {
  it('is 0 on time and exactly at the deadline', () => {
    expect(lateHours(at(-1), DEADLINE)).toBe(0);
    expect(lateHours(at(0), DEADLINE)).toBe(0);
  });

  it('truncates: 59 minutes late is 0 hours, 60 minutes is 1', () => {
    expect(lateHours(at(0, 59), DEADLINE)).toBe(0);
    expect(lateHours(at(1), DEADLINE)).toBe(1);
    expect(lateHours(at(5, 59), DEADLINE)).toBe(5);
  });

  it('subtracts the hours bought', () => {
    expect(lateHours(at(5, 30), DEADLINE, 2)).toBe(3);
    expect(lateHours(at(5, 30), DEADLINE, 6)).toBe(0);
  });

  it('nets refunds: purchases and refunds are summed by the caller', () => {
    // Bought 3, refunded 3, bought 1: net 1.
    const net = [3, -3, 1].reduce((a, b) => a + b, 0);
    expect(lateHours(at(4), DEADLINE, net)).toBe(3);
  });

  it('floors a negative net at 0 hours bought', () => {
    expect(lateHours(at(4), DEADLINE, -3)).toBe(4);
  });

  it('is 0 with no deadline or no completion', () => {
    expect(lateHours(at(100), null)).toBe(0);
    expect(lateHours(null, DEADLINE)).toBe(0);
  });

  it('accepts ISO strings and epoch numbers', () => {
    expect(lateHours(at(2).toISOString(), DEADLINE)).toBe(2);
    expect(lateHours(at(2).getTime(), new Date(DEADLINE).getTime())).toBe(2);
  });
});

describe('countingQuizScore', () => {
  const ctx = { studentDeadline: DEADLINE, latePenaltyPerHour: 5 };

  it('penalises each attempt by its own late hours', () => {
    const late = attempt('late', at(1), at(4, 30), 90); // 4 h late → 70
    const result = countingQuizScore([late], 'HIGHEST', ctx);
    expect(result).toMatchObject({
      grade: 70,
      raw_grade: 90,
      counting_attempt_id: 'late',
      raw_percentage: 90,
      late_hours: 4,
    });
    expect(result.counting).toBe(late);
  });

  it('HIGHEST picks over penalised scores, so a late retake never lowers the grade', () => {
    const onTime = attempt('on-time', at(-3), at(-2), 80);
    const lateRetake = attempt('retake', at(1), at(6), 95); // 6 h late → 65
    const result = countingQuizScore([onTime, lateRetake], 'HIGHEST', ctx);
    expect(result.grade).toBe(80);
    expect(result.counting_attempt_id).toBe('on-time');
    expect(result.late_hours).toBe(0);
    // The raw pick is made among raw scores: the retake.
    expect(result.raw_grade).toBe(95);
    expect(result.raw_percentage).toBe(80);
  });

  it('MOST_RECENT and FIRST pick the same attempt in both modes', () => {
    const first = attempt('first', at(-5), at(-4), 60);
    const last = attempt('last', at(1), at(3), 90); // 3 h late → 75
    const recent = countingQuizScore([first, last], 'MOST_RECENT', ctx);
    expect(recent).toMatchObject({ grade: 75, raw_grade: 90, counting_attempt_id: 'last' });
    const earliest = countingQuizScore([first, last], 'FIRST', ctx);
    expect(earliest).toMatchObject({ grade: 60, raw_grade: 60, counting_attempt_id: 'first' });
  });

  it('clamps the penalised score at 0', () => {
    const result = countingQuizScore([attempt('a', at(1), at(30), 40)], 'HIGHEST', ctx);
    expect(result.grade).toBe(0);
    expect(result.raw_grade).toBe(40);
  });

  it('an extension moves the deadline for every attempt', () => {
    const a = attempt('a', at(0), at(2, 30), 90);
    const b = attempt('b', at(3), at(5, 30), 100);
    const result = countingQuizScore([a, b], 'HIGHEST', { ...ctx, extensionHours: 3 });
    // a: 0 h late → 90; b: 2 h late → 90; tie goes to the earlier completion.
    expect(result).toMatchObject({ grade: 90, counting_attempt_id: 'a', late_hours: 0 });
    expect(countingQuizScore([b], 'HIGHEST', { ...ctx, extensionHours: 3 }).late_hours).toBe(2);
  });

  it('never counts an unscored or running attempt', () => {
    const unscored = attempt('unscored', at(-3), at(-2), null);
    const running = attempt('running', at(-1), null, null);
    const result = countingQuizScore([unscored, running], 'HIGHEST', ctx);
    expect(result).toMatchObject({
      grade: null,
      raw_grade: null,
      counting: null,
      counting_attempt_id: null,
      raw_percentage: null,
      late_hours: 0,
    });
  });

  it('with no deadline nothing is late', () => {
    const result = countingQuizScore([attempt('a', at(1), at(50), 80)], 'HIGHEST', {
      studentDeadline: null,
      latePenaltyPerHour: 5,
    });
    expect(result).toMatchObject({ grade: 80, raw_grade: 80, late_hours: 0 });
  });

  it('a 0 penalty leaves the grade raw but still reports late hours', () => {
    const result = countingQuizScore([attempt('a', at(1), at(3), 80)], 'HIGHEST', {
      studentDeadline: DEADLINE,
    });
    expect(result).toMatchObject({ grade: 80, raw_grade: 80, late_hours: 3 });
  });
});

describe('quizGradeItem', () => {
  const assignment = (over: Partial<QuizGradeAssignment> = {}): QuizGradeAssignment => ({
    id: 'asg-1',
    module_id: 'mod-1',
    type: 'QUIZ',
    is_published: true,
    release_at: null,
    weight: 10,
    is_extra_credit: false,
    student_deadline: DEADLINE,
    ...over,
  });

  const base = {
    assignment: assignment(),
    gradingStrategy: 'HIGHEST',
    latePenaltyPerHour: 2,
    quizzesVisible: true,
    now: at(48),
  };

  it('builds the item from the counting attempt', () => {
    const item = quizGradeItem({
      ...base,
      attempts: [attempt('a', at(1), at(5, 10), 82)],
    });
    expect(item).toEqual({
      assignment_id: 'asg-1',
      module_id: 'mod-1',
      weight: 10,
      is_extra_credit: false,
      grade: 72,
      raw_grade: 82,
      counts_as_zero: false,
      late_hours: 5,
      counting_raw_percentage: 82,
    });
  });

  it('carries the extra-credit flag and weight', () => {
    const item = quizGradeItem({
      ...base,
      assignment: assignment({ is_extra_credit: true, weight: 3 }),
      attempts: [attempt('a', at(-2), at(-1), 50)],
    });
    expect(item).toMatchObject({ is_extra_credit: true, weight: 3, grade: 50 });
  });

  it('counts 0 once the deadline has passed with no completed attempt', () => {
    const item = quizGradeItem({ ...base, attempts: [attempt('run', at(1), null, null)] });
    expect(item).toMatchObject({
      counts_as_zero: true,
      grade: 0,
      raw_grade: 0,
      late_hours: 0,
      counting_raw_percentage: null,
    });
  });

  it('no item before the deadline with no attempt', () => {
    expect(quizGradeItem({ ...base, attempts: [], now: at(-1) })).toBeNull();
    expect(quizGradeItem({ ...base, attempts: [], now: at(0) })).toBeNull();
  });

  it('the zero waits for the hours bought', () => {
    expect(quizGradeItem({ ...base, attempts: [], extensionHours: 3, now: at(2) })).toBeNull();
    expect(quizGradeItem({ ...base, attempts: [], extensionHours: 3, now: at(3) })).toBeNull();
    expect(
      quizGradeItem({ ...base, attempts: [], extensionHours: 3, now: at(3, 1) })
    ).toMatchObject({ counts_as_zero: true });
  });

  it('a refunded extension no longer delays the zero', () => {
    expect(
      quizGradeItem({ ...base, attempts: [], extensionHours: 3 - 3, now: at(1) })
    ).toMatchObject({ counts_as_zero: true });
  });

  it('only unscored completed attempts: pending, not a zero', () => {
    expect(quizGradeItem({ ...base, attempts: [attempt('u', at(-2), at(-1), null)] })).toBeNull();
  });

  it('a scored attempt beside an unscored one counts', () => {
    const item = quizGradeItem({
      ...base,
      attempts: [attempt('u', at(-3), at(-2), null), attempt('s', at(-2), at(-1), 64)],
    });
    expect(item).toMatchObject({ grade: 64, counts_as_zero: false });
  });

  it('null deadline: never late and never a zero', () => {
    const noDeadline = { ...base, assignment: assignment({ student_deadline: null }) };
    expect(quizGradeItem({ ...noDeadline, attempts: [], now: at(10_000) })).toBeNull();
    expect(
      quizGradeItem({ ...noDeadline, attempts: [attempt('a', at(1), at(99), 70)] })
    ).toMatchObject({ grade: 70, raw_grade: 70, late_hours: 0 });
  });

  it('strategy runs over penalised scores', () => {
    const item = quizGradeItem({
      ...base,
      attempts: [attempt('on-time', at(-3), at(-2), 80), attempt('late', at(1), at(10), 95)],
    });
    // late: 10 h × 2 = 75 < 80.
    expect(item).toMatchObject({ grade: 80, raw_grade: 95, late_hours: 0 });
    // The on-time 80 counts: its own raw score, not the raw pick (95).
    expect(item?.counting_raw_percentage).toBe(80);
  });

  it('counting_raw_percentage is the counting attempt before its penalty', () => {
    // 90 completed 6 h late at 2 points an hour counts 78.
    const item = quizGradeItem({ ...base, attempts: [attempt('a', at(-1), at(6, 20), 90)] });
    expect(item).toMatchObject({ grade: 78, counting_raw_percentage: 90, late_hours: 6 });
    expect(item!.counting_raw_percentage! - item!.grade!).toBe(12);
    // At 20 points an hour the penalty floors at 0: 90 points lost, not 120.
    const floored = quizGradeItem({
      ...base,
      latePenaltyPerHour: 20,
      attempts: [attempt('a', at(-1), at(6, 20), 90)],
    });
    expect(floored).toMatchObject({ grade: 0, counting_raw_percentage: 90 });
  });

  it('no item when the assignment is not open to students', () => {
    const attempts = [attempt('a', at(-2), at(-1), 90)];
    expect(quizGradeItem({ ...base, attempts, quizzesVisible: false })).toBeNull();
    expect(
      quizGradeItem({ ...base, attempts, assignment: assignment({ is_published: false }) })
    ).toBeNull();
    expect(
      quizGradeItem({ ...base, attempts, assignment: assignment({ release_at: at(49) }) })
    ).toBeNull();
    expect(
      quizGradeItem({ ...base, attempts: [], assignment: assignment({ release_at: at(49) }) })
    ).toBeNull();
  });

  it('only QUIZ assignments make quiz items', () => {
    expect(
      quizGradeItem({
        ...base,
        attempts: [attempt('a', at(-2), at(-1), 90)],
        assignment: assignment({ type: 'FORM', form: { status: 'OPEN' } }),
      })
    ).toBeNull();
  });

  it('an attempt finished after a late start is late by completed_at, and buying it out clears the penalty', () => {
    const attempts = [attempt('a', at(-1), at(6, 20), 90)];
    expect(quizGradeItem({ ...base, attempts })).toMatchObject({ grade: 78, late_hours: 6 });
    expect(quizGradeItem({ ...base, attempts, extensionHours: 6 })).toMatchObject({
      grade: 90,
      late_hours: 0,
    });
  });
});
