import { describe, it, expect } from 'vitest';
import {
  isClosed,
  openToStudents,
  releasedToRepos,
  type AssignmentVisibilityInput,
} from '../assignmentVisibility.ts';

const NOW = new Date('2026-10-01T12:00:00Z');
const PAST = new Date('2026-09-30T12:00:00Z');
const FUTURE = new Date('2026-10-08T12:00:00Z');

const quiz = (isPublished: boolean, releaseAt: Date | null): AssignmentVisibilityInput => ({
  type: 'QUIZ',
  is_published: isPublished,
  release_at: releaseAt,
  repository: null,
  form: null,
});

describe('openToStudents — QUIZ', () => {
  const releases: Array<[string, Date | null, boolean]> = [
    ['no release date', null, true],
    ['a release date in the past', PAST, true],
    ['a release date in the future', FUTURE, false],
  ];

  // The assignment owns the quiz's publish state: nothing on the quiz row is
  // read, so a quiz past its close date stays visible (with its scores).
  for (const assignmentPublished of [true, false]) {
    for (const [label, releaseAt, released] of releases) {
      for (const quizzesVisible of [true, false]) {
        const expected = assignmentPublished && released && quizzesVisible;
        it(`${expected ? 'shows' : 'hides'} a quiz, assignment ${
          assignmentPublished ? 'published' : 'unpublished'
        }, ${label}, quizzes ${quizzesVisible ? 'on' : 'off'}`, () => {
          expect(
            openToStudents(quiz(assignmentPublished, releaseAt), NOW, { quizzesVisible })
          ).toBe(expected);
        });
      }
    }
  }

  it('opens exactly at the release time', () => {
    expect(openToStudents(quiz(true, NOW), NOW, { quizzesVisible: true })).toBe(true);
  });

  it('accepts dates as ISO strings', () => {
    expect(
      openToStudents(
        { ...quiz(true, null), release_at: FUTURE.toISOString() },
        NOW.toISOString() as unknown as Date,
        { quizzesVisible: true }
      )
    ).toBe(false);
  });
});

describe('isClosed', () => {
  it('never closes without a date', () => {
    expect(isClosed(null, NOW)).toBe(false);
    expect(isClosed(undefined, NOW)).toBe(false);
  });

  it('is closed from the close time on, not before', () => {
    expect(isClosed(FUTURE, NOW)).toBe(false);
    expect(isClosed(NOW, NOW)).toBe(true);
    expect(isClosed(PAST.toISOString(), NOW)).toBe(true);
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

describe('releasedToRepos', () => {
  it('releases a published assignment with no release date (issue: no submission rows)', () => {
    expect(releasedToRepos({ release_at: null, is_published: true }, NOW)).toBe(true);
  });

  it('keeps an undated draft off student repos', () => {
    expect(releasedToRepos({ release_at: null, is_published: false }, NOW)).toBe(false);
  });

  it('releases a scheduled assignment once its date has passed', () => {
    expect(releasedToRepos({ release_at: PAST, is_published: false }, NOW)).toBe(true);
    expect(releasedToRepos({ release_at: NOW.toISOString() }, NOW)).toBe(true);
  });

  it('holds a scheduled assignment until its date', () => {
    expect(releasedToRepos({ release_at: FUTURE, is_published: true }, NOW)).toBe(false);
  });
});
