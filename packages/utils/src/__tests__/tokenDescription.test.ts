import { describe, expect, it } from 'vitest';
import {
  quizExtensionDescription,
  titleFromQuizExtensionDescription,
  transactionAssignmentTitle,
} from '../tokenDescription.ts';

describe('quiz extension descriptions', () => {
  it('writes the title and the hours', () => {
    expect(quizExtensionDescription('Recursion', 3)).toBe('Recursion · +3 h');
    expect(quizExtensionDescription('Recursion', -3)).toBe('Recursion · −3 h');
  });

  it('reads back the title it wrote, for a purchase and a refund', () => {
    for (const title of ['Recursion', 'Quiz · part 2', 'A · +1 h']) {
      for (const hours of [1, 24, -2]) {
        expect(titleFromQuizExtensionDescription(quizExtensionDescription(title, hours))).toBe(
          title
        );
      }
    }
  });

  it('reads no title from any other description', () => {
    expect(titleFromQuizExtensionDescription('Purchase of 3 hour(s).')).toBeNull();
    expect(titleFromQuizExtensionDescription('Refund of 3 hours.')).toBeNull();
    expect(titleFromQuizExtensionDescription('Bonus · +2')).toBeNull();
    expect(titleFromQuizExtensionDescription('')).toBeNull();
    expect(titleFromQuizExtensionDescription(null)).toBeNull();
    expect(titleFromQuizExtensionDescription(undefined)).toBeNull();
  });
});

describe('transactionAssignmentTitle', () => {
  it("names a quiz extension by its assignment's live title", () => {
    expect(
      transactionAssignmentTitle({
        hours_purchased: 2,
        assignment_id: 'asg-1',
        assignment: { title: 'Recursion (renamed)' },
        description: quizExtensionDescription('Recursion', 2),
      })
    ).toBe('Recursion (renamed)');
  });

  it("names a repo extension or grade token by its submission's assignment", () => {
    expect(
      transactionAssignmentTitle({
        hours_purchased: 3,
        git_repo_assignment_id: 'gra-1',
        git_repo_assignment: { assignment: { title: 'Lab 1' } },
        description: 'Purchase of 3 hour(s).',
      })
    ).toBe('Lab 1');
  });

  it('reads the title of a quiz extension whose assignment was deleted from its description', () => {
    expect(
      transactionAssignmentTitle({
        hours_purchased: -2,
        assignment_id: null,
        assignment: null,
        description: quizExtensionDescription('Deleted quiz', -2),
      })
    ).toBe('Deleted quiz');
  });

  it('never reads a title from a grant or removal, whatever its text says', () => {
    expect(
      transactionAssignmentTitle({ hours_purchased: null, description: 'Bonus · +2 h' })
    ).toBeNull();
    expect(transactionAssignmentTitle({ description: 'Bonus · +2 h' })).toBeNull();
  });

  it('reads no title from a row still linked to something that has no title', () => {
    expect(
      transactionAssignmentTitle({
        hours_purchased: 2,
        git_repo_assignment_id: 'gra-1',
        git_repo_assignment: { assignment: null },
        description: 'Lab · +2 h',
      })
    ).toBeNull();
  });
});
