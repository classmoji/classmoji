import { describe, expect, it } from 'vitest';
import {
  QUIZ_AUTHOR_ROLES,
  QUIZ_AUTHOR_SETTING_KEYS,
  QUIZ_EDITOR_ROLES,
  canAuthorQuiz,
  mirroredQuizStatus,
  mirroredQuizWeight,
  ownerOnlyAssignmentFields,
  quizAssignmentKeysIn,
  quizAuthorSettingKeysIn,
} from '../quizAssignment.ts';

const NOW = new Date('2026-10-02T12:00:00Z');
const PAST = new Date('2026-10-01T12:00:00Z');
const FUTURE = new Date('2026-10-09T12:00:00Z');

describe('who authors a quiz', () => {
  it('is the owner and teachers; an assistant edits content only', () => {
    expect(QUIZ_AUTHOR_ROLES).toEqual(['OWNER', 'TEACHER']);
    expect(QUIZ_EDITOR_ROLES).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
    expect(['OWNER', 'TEACHER'].map(canAuthorQuiz)).toEqual([true, true]);
    expect(['ASSISTANT', 'STUDENT', '', null, undefined].map(canAuthorQuiz)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('quizAssignmentKeysIn', () => {
  it('names every assignment field a save carries, new shape and old', () => {
    expect(
      quizAssignmentKeysIn({
        name: 'Renamed',
        rubricPrompt: 'r',
        assignment: { moduleId: 'm' },
        dueDate: null,
        weight: 0,
        status: 'DRAFT',
      })
    ).toEqual(['assignment', 'dueDate', 'weight', 'status']);
  });

  it('finds none in a content-only save, and ignores undefined', () => {
    expect(
      quizAssignmentKeysIn({
        name: 'N',
        rubricPrompt: 'r',
        sourceMaterial: [],
        excludedPaths: [],
        weight: undefined,
      })
    ).toEqual([]);
  });

  it('covers each panel field on its own', () => {
    for (const key of [
      'moduleId',
      'releaseAt',
      'dueDate',
      'closesAt',
      'weight',
      'tokensPerHour',
      'isPublished',
      'status',
    ]) {
      expect(quizAssignmentKeysIn({ [key]: 1 })).toEqual([key]);
    }
  });
});

describe('quizAuthorSettingKeysIn', () => {
  it('names the question count, max attempts and grading strategy a save carries', () => {
    expect(
      quizAuthorSettingKeysIn({
        name: 'N',
        questionCount: 5,
        maxAttempts: 0,
        gradingStrategy: 'HIGHEST',
      })
    ).toEqual(['questionCount', 'maxAttempts', 'gradingStrategy']);
    expect(QUIZ_AUTHOR_SETTING_KEYS).toEqual(['questionCount', 'maxAttempts', 'gradingStrategy']);
  });

  it('leaves the content an assistant edits alone, and ignores undefined', () => {
    expect(
      quizAuthorSettingKeysIn({
        name: 'N',
        rubricPrompt: 'r',
        systemPrompt: 's',
        sourceMaterial: [],
        includeCodeContext: true,
        repositoryId: 'repo',
        excludedPaths: [],
        courseSearchEnabled: true,
        subject: 'JS',
        difficultyLevel: 'Beginner',
        maxAttempts: undefined,
      })
    ).toEqual([]);
  });
});

describe('the mirror onto the quiz', () => {
  it('is DRAFT while unpublished, whatever the close date', () => {
    expect(mirroredQuizStatus({ is_published: false, closes_at: PAST }, NOW)).toBe('DRAFT');
  });

  it('is CLOSED from the close date on, PUBLISHED before it or without one', () => {
    expect(mirroredQuizStatus({ is_published: true, closes_at: PAST }, NOW)).toBe('CLOSED');
    expect(mirroredQuizStatus({ is_published: true, closes_at: NOW }, NOW)).toBe('CLOSED');
    expect(mirroredQuizStatus({ is_published: true, closes_at: FUTURE }, NOW)).toBe('PUBLISHED');
    expect(mirroredQuizStatus({ is_published: true, closes_at: null }, NOW)).toBe('PUBLISHED');
  });

  it('rounds the weight to the quiz column’s whole number', () => {
    expect([0, 2, 2.4, 2.5, 99.9].map(mirroredQuizWeight)).toEqual([0, 2, 2, 3, 100]);
  });
});

describe('ownerOnlyAssignmentFields', () => {
  it('lets a teacher schedule, weight and publish a quiz, but not move it', () => {
    expect(
      ownerOnlyAssignmentFields('QUIZ', [
        'student_deadline',
        'weight',
        'release_at',
        'closes_at',
        'tokens_per_hour',
        'is_published',
        'module_id',
        'grader_deadline',
      ])
    ).toEqual(['module_id', 'grader_deadline']);
  });

  it('keeps the repo and form teacher set as it was', () => {
    for (const type of ['REPO', 'FORM']) {
      expect(
        ownerOnlyAssignmentFields(type, ['grades_released', 'student_deadline', 'weight'])
      ).toEqual(['weight']);
    }
  });

  it('gives a teacher nothing on an unknown type', () => {
    expect(ownerOnlyAssignmentFields('OTHER', ['student_deadline'])).toEqual([
      'student_deadline',
    ]);
  });
});
