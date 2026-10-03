/**
 * The tokens log's Assignment column: the quiz assignment a row names, else
 * its repo submission's assignment, else (a quiz assignment since deleted) the
 * title its description was written with. A row naming nothing shows none.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/hooks', () => ({
  useRole: () => ({ role: 'STUDENT' }),
  useGlobalFetcher: () => ({ fetcher: null, notify: vi.fn() }),
}));

const { transactionAssignmentTitle } = await import('../TokensLog');

describe('transactionAssignmentTitle', () => {
  it("names a quiz extension's assignment", () => {
    expect(
      transactionAssignmentTitle({
        assignment_id: 'asg-1',
        assignment: { title: 'Recursion quiz' },
        description: 'Old title · +2 h',
      })
    ).toBe('Recursion quiz');
  });

  it("names a repo row's assignment", () => {
    expect(
      transactionAssignmentTitle({
        git_repo_assignment_id: 'gra-1',
        git_repo_assignment: { assignment: { title: 'Lab 1' } },
        description: 'Purchase of 2 hour(s).',
      })
    ).toBe('Lab 1');
  });

  it('reads the title back from a quiz row whose assignment is gone', () => {
    expect(
      transactionAssignmentTitle({ assignment_id: null, description: 'Recursion · part 2 · +3 h' })
    ).toBe('Recursion · part 2');
    expect(transactionAssignmentTitle({ description: 'Recursion · −3 h' })).toBe('Recursion');
  });

  it('names nothing for a row with no assignment', () => {
    expect(transactionAssignmentTitle({ description: 'Weekly bonus' })).toBeNull();
    expect(transactionAssignmentTitle({ description: 'Purchase of 2 hour(s).' })).toBeNull();
  });
});
