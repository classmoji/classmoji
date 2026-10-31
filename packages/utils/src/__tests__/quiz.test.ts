import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getQuestionProgressFromMessage,
  checkForCompletion,
  parseQuestionComplete,
  completionMessageDisplay,
  redactQuizEvaluationBlocks,
} from '../quiz.ts';
import {
  QuizEvaluationRecordStudentSchema,
  studentEvaluationRecord,
  type QuizEvaluationRecordV2,
} from '../quizAgent/index.ts';

describe('getQuestionProgressFromMessage', () => {
  it('returns null for empty/non-string input', () => {
    expect(getQuestionProgressFromMessage('')).toBeNull();
    // @ts-expect-error testing wrong type at runtime
    expect(getQuestionProgressFromMessage(null)).toBeNull();
  });

  it('returns null when no marker present', () => {
    expect(getQuestionProgressFromMessage('hello world')).toBeNull();
  });

  it('parses "Question X of Y" header format', () => {
    expect(getQuestionProgressFromMessage('Question 3 of 10')).toEqual({
      questionNumber: 3,
      totalQuestions: 10,
    });
  });

  it('returns the LAST text-format match in the message', () => {
    const msg = 'Question 1 of 5\n... Question 4 of 5';
    expect(getQuestionProgressFromMessage(msg)).toEqual({
      questionNumber: 4,
      totalQuestions: 5,
    });
  });

  it('parses JSON format with question_number/total_questions', () => {
    const msg = '{"question_number": 2, "total_questions": 7}';
    expect(getQuestionProgressFromMessage(msg)).toEqual({
      questionNumber: 2,
      totalQuestions: 7,
    });
  });

  it('takes the higher questionNumber when both formats present', () => {
    const msg = 'Question 2 of 5\n{"question_number": 4, "total_questions": 5}';
    expect(getQuestionProgressFromMessage(msg)).toEqual({
      questionNumber: 4,
      totalQuestions: 5,
    });
  });

  it('skips questionNumber <= 0', () => {
    expect(getQuestionProgressFromMessage('Question 0 of 5')).toBeNull();
  });
});

describe('checkForCompletion', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns null without marker', () => {
    expect(checkForCompletion('no marker here')).toBeNull();
  });

  it('returns null for empty/non-string', () => {
    expect(checkForCompletion('')).toBeNull();
    // @ts-expect-error testing wrong type at runtime
    expect(checkForCompletion(undefined)).toBeNull();
  });

  it('parses fenced JSON after marker', () => {
    const msg = '[QUIZ_EVALUATION]\n```json\n{"quiz_complete": true, "score": 85}\n```';
    expect(checkForCompletion(msg)).toEqual({ quiz_complete: true, score: 85 });
  });

  it('parses raw JSON after marker', () => {
    const msg = '[QUIZ_EVALUATION] {"quiz_complete": true}\n\n';
    expect(checkForCompletion(msg)).toEqual({ quiz_complete: true });
  });

  it('returns null when quiz_complete is not true', () => {
    const msg = '[QUIZ_EVALUATION]\n```json\n{"quiz_complete": false}\n```';
    expect(checkForCompletion(msg)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    const msg = '[QUIZ_EVALUATION]\n```json\n{not valid}\n```';
    expect(checkForCompletion(msg)).toBeNull();
  });
});

describe('parseQuestionComplete', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('parses fenced JSON', () => {
    const msg =
      '[QUESTION_COMPLETE]\n```json\n{"question_num": 1, "emoji": "heart", "brief_feedback": "great"}\n```';
    expect(parseQuestionComplete(msg)).toEqual({
      question_num: 1,
      emoji: 'heart',
      brief_feedback: 'great',
    });
  });

  it('parses raw JSON', () => {
    const msg = '[QUESTION_COMPLETE] {"question_num": 2, "emoji": "+1"}\n\n';
    expect(parseQuestionComplete(msg)).toEqual({ question_num: 2, emoji: '+1' });
  });

  it('returns null without marker', () => {
    expect(parseQuestionComplete('hello')).toBeNull();
  });

  it('returns null when required fields missing', () => {
    expect(
      parseQuestionComplete('[QUESTION_COMPLETE]\n```json\n{"emoji": "heart"}\n```')
    ).toBeNull();
    expect(
      parseQuestionComplete('[QUESTION_COMPLETE]\n```json\n{"question_num": 1}\n```')
    ).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseQuestionComplete('[QUESTION_COMPLETE]\n```json\n{bad\n```')).toBeNull();
  });
});


describe('redactQuizEvaluationBlocks (a student\'s legacy messages, E1)', () => {
  const EVALUATION = {
    quiz_complete: true,
    evaluation: 'GOOD',
    numeric_score: 3,
    final_acknowledgment: 'Nice work.',
    feedback_summary: 'Solid.',
    feedback_strengths: ['Recursion'],
    partial_credit_percentage: 73.37,
    first_attempt_percentage: 41.5,
    percentage: 73.37,
    raw_percentage: 74.12,
    total_questions: 5,
    question_results: [{ question_num: 1, credit_earned: 66.6, attempts: 2, emoji: 'eyes' }],
  };
  const NUMBERS = ['73.37', '41.5', '74.12', '66.6', 'credit_earned', 'total_questions'];
  const expectNoNumbers = (text: string) => {
    for (const n of NUMBERS) expect(text).not.toContain(n);
  };

  it('narrows a fenced block, and the chat still reads the completion', () => {
    const content =
      'Great job!\n\n[QUIZ_EVALUATION]\n```json\n' + JSON.stringify(EVALUATION) + '\n```';
    const out = redactQuizEvaluationBlocks(content);
    expectNoNumbers(out);
    expect(out.startsWith('Great job!')).toBe(true);
    expect(checkForCompletion(out)).toEqual({
      quiz_complete: true,
      evaluation: 'GOOD',
      numeric_score: 3,
      final_acknowledgment: 'Nice work.',
      feedback_summary: 'Solid.',
      feedback_strengths: ['Recursion'],
    });
    expect(completionMessageDisplay(out, true)).toEqual({
      shouldHide: false,
      content: 'Great job!',
    });
  });

  it('narrows a raw JSON block (nested braces included) and keeps the text after it', () => {
    const content =
      '[QUIZ_EVALUATION]\n' + JSON.stringify(EVALUATION) + '\n\nSee you next week.';
    const out = redactQuizEvaluationBlocks(content);
    expectNoNumbers(out);
    expect(checkForCompletion(out)).toMatchObject({ quiz_complete: true, evaluation: 'GOOD' });
    expect(out).toContain('See you next week.');
  });

  it('removes a block that does not parse, and ends the message at an unclosed one', () => {
    expect(
      redactQuizEvaluationBlocks('Done.\n[QUIZ_EVALUATION]\n```json\n{"x": 73.37,\n```\nBye')
    ).toBe('Done.\n\nBye');
    const unclosed = redactQuizEvaluationBlocks('Done.\n[QUIZ_EVALUATION]\n{"partial_credit_percentage": 73.37');
    expect(unclosed).toBe('Done.');
  });

  it('leaves a message with no block as it is', () => {
    expect(redactQuizEvaluationBlocks('Question 1 of 5: 73.37?')).toBe('Question 1 of 5: 73.37?');
  });
});

describe('studentEvaluationRecord (E1)', () => {
  const record = {
    v: 2,
    source: 'model',
    evaluation: 'GOOD',
    numeric_score: 3,
    partial_credit_percentage: 73.37,
    first_attempt_percentage: 41.5,
    question_results: [
      {
        question_num: 1,
        attempts: 2,
        tries: 2,
        eventually_correct: true,
        first_attempt_correct: false,
        credit_earned: 66.6,
        emoji: 'eyes',
        brief_feedback: 'Close.',
      },
    ],
  } as QuizEvaluationRecordV2;

  it('keeps the band and per-question emoji, and no number', () => {
    const narrowed = studentEvaluationRecord(record);
    expect(narrowed).toEqual({
      v: 2,
      source: 'model',
      evaluation: 'GOOD',
      numeric_score: 3,
      question_results: [
        { question_num: 1, attempts: 2, tries: 2, emoji: 'eyes', brief_feedback: 'Close.' },
      ],
    });
    expect(QuizEvaluationRecordStudentSchema.safeParse(narrowed).success).toBe(true);
  });

  it('narrows a record stored under an older shape key by key rather than dropping it', () => {
    const old = {
      v: 2,
      partial_credit_percentage: 73.37,
      question_results: [{ question_num: 1, attempts: 1, credit_earned: 66.6, emoji: 'eyes' }],
    } as unknown as QuizEvaluationRecordV2;
    const narrowed = studentEvaluationRecord(old);
    expect(narrowed).toEqual({
      v: 2,
      question_results: [{ question_num: 1, attempts: 1, emoji: 'eyes' }],
    });
    expect(JSON.stringify(narrowed)).not.toContain('73.37');
  });

  it('reads anything else as no record', () => {
    expect(studentEvaluationRecord(null)).toBeNull();
    expect(studentEvaluationRecord({ v: 1 } as unknown as QuizEvaluationRecordV2)).toBeNull();
  });
});
