import { describe, expect, it } from 'vitest';
import {
  ANSWER_COUNTER_COPY,
  ANSWER_PLACEHOLDER,
  answerRulesLine,
  attemptAnswerRules,
  checkHintCost,
  checkMaxAnswers,
  hintCostTooltip,
  quizAnswerRules,
} from '../answerRules.ts';
import { HINT_COST } from '../grading.ts';

describe('attemptAnswerRules', () => {
  const quiz = { hint_cost: 30, max_answers: 3 };

  it('reads an attempt pinned with the rules', () => {
    expect(
      attemptAnswerRules({ questionCount: 5, hintCost: 0, maxAnswers: 1 }, quiz)
    ).toEqual({ hintCost: 0, maxAnswers: 1 });
  });

  it('gives an attempt pinned before the rules existed the old cost and no limit', () => {
    expect(attemptAnswerRules({ questionCount: 5, codeSandbox: false }, quiz)).toEqual({
      hintCost: HINT_COST,
      maxAnswers: null,
    });
  });

  it("reads the quiz's own values before the first admission pins them", () => {
    expect(attemptAnswerRules(null, quiz)).toEqual({ hintCost: 30, maxAnswers: 3 });
    expect(attemptAnswerRules({ instructorRepoName: 'r' }, quiz)).toEqual({
      hintCost: 30,
      maxAnswers: 3,
    });
    expect(attemptAnswerRules(undefined, null)).toEqual({ hintCost: 15, maxAnswers: 5 });
  });

  it('ignores values out of range', () => {
    expect(quizAnswerRules({ hint_cost: 99, max_answers: 0 })).toEqual({
      hintCost: 15,
      maxAnswers: 5,
    });
  });
});

describe('checkHintCost / checkMaxAnswers', () => {
  it('accepts whole numbers in range, from numbers or numeric strings', () => {
    expect(checkHintCost(0)).toEqual({ ok: true, value: 0 });
    expect(checkHintCost('50')).toEqual({ ok: true, value: 50 });
    expect(checkMaxAnswers(1)).toEqual({ ok: true, value: 1 });
    expect(checkMaxAnswers(20)).toEqual({ ok: true, value: 20 });
  });

  it('refuses anything else with a message', () => {
    for (const bad of [-1, 51, 2.5, '', 'x', null, undefined, true]) {
      const r = checkHintCost(bad);
      expect(r.ok).toBe(false);
    }
    for (const bad of [0, 21, 1.5, '']) expect(checkMaxAnswers(bad).ok).toBe(false);
    expect(checkHintCost(60)).toEqual({
      ok: false,
      error: 'Hint cost must be a whole number from 0 to 50.',
    });
    expect(checkMaxAnswers(0)).toEqual({
      ok: false,
      error: 'Answers per question must be a whole number from 1 to 20.',
    });
  });
});

describe('copy', () => {
  it('states the rules in one line', () => {
    expect(answerRulesLine({ hintCost: 15, maxAnswers: 5 })).toBe(
      'Up to 5 answers per question. Each hint costs 15 points on that question.'
    );
    expect(answerRulesLine({ hintCost: 15, maxAnswers: 1 })).toBe(
      'One answer per question. Each hint costs 15 points on that question.'
    );
    expect(answerRulesLine({ hintCost: 0, maxAnswers: 3 })).toBe(
      'Up to 3 answers per question. Hints are free.'
    );
    expect(answerRulesLine({ hintCost: 0, maxAnswers: null })).toBe('Hints are free.');
  });

  it('words the hint tooltip from the cost', () => {
    expect(hintCostTooltip(15)).toBe('This hint costs 15 points on this question.');
    expect(hintCostTooltip(0)).toBe('Hints are free on this quiz.');
  });

  it('words the counter and the placeholder', () => {
    expect(ANSWER_COUNTER_COPY.answer(2, 5)).toBe('Answer 2 of 5');
    expect(ANSWER_COUNTER_COPY.last(5)).toBe('Answer 5 of 5 · last');
    expect(ANSWER_COUNTER_COPY.none).toBe('No answers left');
    expect(ANSWER_PLACEHOLDER).toEqual({
      open: 'Type your answer…',
      last: 'Your last answer for this question…',
    });
  });
});
