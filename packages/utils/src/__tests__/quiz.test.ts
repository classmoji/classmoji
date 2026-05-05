import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getQuestionProgressFromMessage,
  checkForCompletion,
  parseQuestionComplete,
} from '../quiz.ts';

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
    const msg =
      'Question 2 of 5\n{"question_number": 4, "total_questions": 5}';
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
    expect(parseQuestionComplete('[QUESTION_COMPLETE]\n```json\n{"emoji": "heart"}\n```')).toBeNull();
    expect(parseQuestionComplete('[QUESTION_COMPLETE]\n```json\n{"question_num": 1}\n```')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseQuestionComplete('[QUESTION_COMPLETE]\n```json\n{bad\n```')).toBeNull();
  });
});
