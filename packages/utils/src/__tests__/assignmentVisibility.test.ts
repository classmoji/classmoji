import { describe, it, expect } from 'vitest';
import { openToStudents, type AssignmentVisibilityInput } from '../assignmentVisibility.ts';

const NOW = new Date('2026-10-01T12:00:00Z');
const PAST = new Date('2026-09-30T12:00:00Z');
const FUTURE = new Date('2026-10-08T12:00:00Z');

const quiz = (
  isPublished: boolean,
  status: string,
  releaseAt: Date | null
): AssignmentVisibilityInput => ({
  type: 'QUIZ',
  is_published: isPublished,
  release_at: releaseAt,
  repository: null,
  quiz: { status },
  form: null,
});

describe('openToStudents — QUIZ', () => {
  const releases: Array<[string, Date | null, boolean]> = [
    ['no release date', null, true],
    ['a release date in the past', PAST, true],
    ['a release date in the future', FUTURE, false],
  ];
  const statuses: Array<[string, boolean]> = [
    ['DRAFT', false],
    ['PUBLISHED', true],
    // Visible, so a student who finished it still sees it with its score.
    ['CLOSED', true],
  ];

  for (const assignmentPublished of [true, false]) {
    for (const [status, statusOpen] of statuses) {
      for (const [label, releaseAt, released] of releases) {
        for (const quizzesVisible of [true, false]) {
          const expected = assignmentPublished && statusOpen && released && quizzesVisible;
          it(`${expected ? 'shows' : 'hides'} a ${status} quiz, assignment ${
            assignmentPublished ? 'published' : 'unpublished'
          }, ${label}, quizzes ${quizzesVisible ? 'on' : 'off'}`, () => {
            expect(
              openToStudents(quiz(assignmentPublished, status, releaseAt), NOW, { quizzesVisible })
            ).toBe(expected);
          });
        }
      }
    }
  }

  it('hides a quiz assignment whose quiz did not load', () => {
    expect(
      openToStudents({ type: 'QUIZ', is_published: true, quiz: null }, NOW, {
        quizzesVisible: true,
      })
    ).toBe(false);
  });

  it('opens exactly at the release time', () => {
    expect(openToStudents(quiz(true, 'PUBLISHED', NOW), NOW, { quizzesVisible: true })).toBe(true);
  });

  it('accepts dates as ISO strings', () => {
    expect(
      openToStudents(
        { ...quiz(true, 'PUBLISHED', null), release_at: FUTURE.toISOString() },
        NOW.toISOString() as unknown as Date,
        { quizzesVisible: true }
      )
    ).toBe(false);
  });
});

describe('openToStudents — FORM', () => {
  const form = (status: string, releaseAt: Date | null = null, isPublished = true) => ({
    type: 'FORM',
    is_published: isPublished,
    release_at: releaseAt,
    form: { status },
  });

  it('hides a DRAFT form', () => {
    expect(openToStudents(form('DRAFT'), NOW, { quizzesVisible: true })).toBe(false);
  });

  it('shows an OPEN form and keeps a CLOSED one visible', () => {
    expect(openToStudents(form('OPEN'), NOW, { quizzesVisible: true })).toBe(true);
    expect(openToStudents(form('CLOSED'), NOW, { quizzesVisible: true })).toBe(true);
  });

  it('is not gated on quizzes', () => {
    expect(openToStudents(form('OPEN'), NOW, { quizzesVisible: false })).toBe(true);
  });

  it('waits for its release date', () => {
    expect(openToStudents(form('OPEN', FUTURE), NOW, { quizzesVisible: true })).toBe(false);
    expect(openToStudents(form('OPEN', PAST), NOW, { quizzesVisible: true })).toBe(true);
  });

  it('hides an unpublished form assignment', () => {
    expect(openToStudents(form('OPEN', null, false), NOW, { quizzesVisible: true })).toBe(false);
  });
});

describe('openToStudents — REPO', () => {
  const repo = (repositoryPublished: boolean, releaseAt: Date | null = null) => ({
    type: 'REPO',
    is_published: true,
    release_at: releaseAt,
    repository: { is_published: repositoryPublished },
  });

  it('shows a published assignment in a published repository', () => {
    expect(openToStudents(repo(true), NOW, { quizzesVisible: false })).toBe(true);
  });

  it('hides it once the repository is unpublished after provisioning', () => {
    expect(openToStudents(repo(false), NOW, { quizzesVisible: true })).toBe(false);
  });

  it('does not read release_at: the release job publishes repo assignments', () => {
    expect(openToStudents(repo(true, FUTURE), NOW, { quizzesVisible: true })).toBe(true);
  });

  it('hides an unpublished repo assignment', () => {
    expect(
      openToStudents({ ...repo(true), is_published: false }, NOW, { quizzesVisible: true })
    ).toBe(false);
  });
});
