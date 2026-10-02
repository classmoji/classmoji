/**
 * The confirm a module card's Publish asks, worded per row: a repository
 * assignment speaks of its repositories, a quiz or form only of itself and of
 * its Opens date when that is still ahead.
 */
import { describe, expect, it } from 'vitest';
import { publishAssignmentConfirm } from '../publishAssignmentConfirm';

const NOW = new Date('2026-10-02T12:00:00.000Z');

describe('publishAssignmentConfirm', () => {
  it('speaks of the repository on a REPO row only', () => {
    expect(
      publishAssignmentConfirm({ needsRepo: false, assignmentPublished: false, kind: 'REPO' }, NOW)
        .content
    ).toBe('This opens the assignment to students. Its repository is already published.');
    expect(
      publishAssignmentConfirm({ needsRepo: true, assignmentPublished: false }, NOW).content
    ).toBe('This creates the student repositories first, then opens the assignment to students.');
  });

  it('never says a quiz has a repository', () => {
    const confirm = publishAssignmentConfirm(
      { needsRepo: false, assignmentPublished: false, kind: 'QUIZ' },
      NOW
    );
    expect(confirm).toEqual({
      title: 'Publish quiz',
      content: 'This opens the quiz to students.',
      okText: 'Publish',
    });
    expect(confirm.content).not.toMatch(/repositor/i);
  });

  it('says when students get a quiz that opens later', () => {
    const { content } = publishAssignmentConfirm(
      {
        needsRepo: false,
        assignmentPublished: false,
        kind: 'QUIZ',
        opensAt: '2026-10-09T13:00:00.000Z',
      },
      NOW
    );
    expect(content).toMatch(/^Students get this quiz on Fri Oct 9 · /);
  });

  it('speaks of a form as a form', () => {
    expect(
      publishAssignmentConfirm({ needsRepo: false, assignmentPublished: false, kind: 'FORM' }, NOW)
        .content
    ).toBe('This opens the form to students.');
  });
});
