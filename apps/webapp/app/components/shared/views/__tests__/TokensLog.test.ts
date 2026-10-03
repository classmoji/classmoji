/**
 * The tokens log's Assignment column: the quiz assignment a row names, else
 * its repo submission's assignment, else (a quiz assignment since deleted) the
 * title its description was written with. A grant or removal names none,
 * whatever its text says. The rule is `transactionAssignmentTitle` in
 * @classmoji/utils; this pins that the column reads it.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

interface Column {
  key: string;
  hidden?: boolean;
  render?: (value: unknown, record: Record<string, unknown>) => ReactNode;
}

vi.mock('antd', () => ({
  // Renders only the Assignment cell of each row.
  Table: ({
    dataSource,
    columns,
  }: {
    dataSource: Record<string, unknown>[];
    columns: Column[];
  }) => {
    const column = columns.find(c => c.key === 'assignment')!;
    return createElement(
      'ul',
      null,
      dataSource.map(row =>
        createElement('li', { key: row.id as string }, column.render!(undefined, row))
      )
    );
  },
  Tag: () => null,
  Avatar: () => null,
  Button: () => null,
}));
vi.mock('~/hooks', () => ({
  useRole: () => ({ role: 'STUDENT' }),
  useGlobalFetcher: () => ({ fetcher: null, notify: vi.fn() }),
}));

const { default: TokensLog } = await import('../TokensLog');

const row = (id: string, over: Record<string, unknown>) => ({
  id,
  type: 'PURCHASE',
  is_cancelled: false,
  student_id: 'stu-1',
  classroom_id: 'class-1',
  student: {},
  created_at: '2026-10-01T12:00:00.000Z',
  amount: -2,
  ...over,
});

const cells = (transactions: ReturnType<typeof row>[]) =>
  [
    ...renderToStaticMarkup(createElement(TokensLog, { transactions })).matchAll(
      /<li>(.*?)<\/li>/g
    ),
  ].map(m => m[1]);

describe('TokensLog Assignment column', () => {
  it("names a quiz extension's assignment, and a repo row's", () => {
    expect(
      cells([
        row('q', {
          hours_purchased: 2,
          assignment_id: 'asg-1',
          assignment: { title: 'Recursion quiz' },
          description: 'Old title · +2 h',
        }),
        row('r', {
          hours_purchased: 2,
          git_repo_assignment_id: 'gra-1',
          git_repo_assignment: { assignment: { title: 'Lab 1' } },
          description: 'Purchase of 2 hour(s).',
        }),
      ])
    ).toEqual(['Recursion quiz', 'Lab 1']);
  });

  it('reads the title back from a quiz row whose assignment is gone', () => {
    expect(
      cells([
        row('p', {
          hours_purchased: 3,
          assignment_id: null,
          description: 'Recursion · part 2 · +3 h',
        }),
        row('f', { type: 'REFUND', hours_purchased: -3, description: 'Recursion · −3 h' }),
      ])
    ).toEqual(['Recursion · part 2', 'Recursion']);
  });

  it('names nothing for a grant, even one whose text looks like an extension', () => {
    const [grant, bonus, plain] = cells([
      row('g', { type: 'GAIN', amount: 2, hours_purchased: null, description: 'Bonus · +2 h' }),
      row('b', { type: 'GAIN', amount: 2, description: 'Bonus · +2 h' }),
      row('w', { type: 'GAIN', amount: 2, hours_purchased: null, description: 'Weekly bonus' }),
    ]);
    for (const cell of [grant, bonus, plain]) {
      expect(cell).toContain('—');
      expect(cell).not.toContain('Bonus');
    }
  });
});
